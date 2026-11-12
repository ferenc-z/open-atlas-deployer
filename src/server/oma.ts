// OMA sessions the Deployer opens itself (interface B, §10.2): its own Application and API key, an Agent, an
// Environment and Vaults. Used for failure diagnosis (D24) and assessments (§10.5, D27).

import { readToken, type TokenSource } from "./versions.ts";

export interface OmaSessionConfig {
  url: string;
  keyFile: TokenSource;
  agent: string;
  environment?: string;
  vaults?: string[];
  application?: string;
}

export interface OmaEvent { id?: string; type: string; name?: string; status?: string; error?: unknown; content?: { type: string; text?: string }[]; input?: unknown }

export class OmaSessions {
  readonly config: OmaSessionConfig;
  private fetcher: typeof fetch;

  constructor(config: OmaSessionConfig, fetcher: typeof fetch = fetch) {
    this.config = config;
    this.fetcher = fetcher;
  }

  private async call(method: string, path: string, body?: unknown): Promise<any> {
    const key = readToken(this.config.keyFile);
    if (!key) throw new Error("No OMA API key");
    const response = await this.fetcher(`${this.config.url.replace(/\/+$/, "")}${path}`, {
      method,
      headers: { "x-api-key": key, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`OMA ${method} ${path.split("?")[0]} returned HTTP ${response.status}`);
    // Sending events answers 202 with no body.
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  /** Uploads a file (D46: the source archive of an assessment); returns its id. */
  async upload(filename: string, bytes: Uint8Array, mediaType = "application/gzip"): Promise<string> {
    const key = readToken(this.config.keyFile);
    if (!key) throw new Error("No OMA API key");
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)], { type: mediaType }), filename);
    const response = await this.fetcher(`${this.config.url.replace(/\/+$/, "")}/v1/files`, {
      method: "POST", headers: { "x-api-key": key, accept: "application/json" }, body: form, signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`OMA POST /v1/files returned HTTP ${response.status}`);
    return String(((await response.json()) as { id: string }).id);
  }

  /** Opens a session, with files mounted in its sandbox, and sends its first message; returns the session id. */
  async open(title: string, correlation: string, text: string, files: { id: string; mountPath: string }[] = []): Promise<string> {
    const c = this.config;
    const session = await this.call("POST", "/v1/sessions", {
      agent: c.agent, title,
      ...(c.environment ? { environment_id: c.environment } : {}),
      ...(c.vaults?.length ? { vault_ids: c.vaults } : {}),
      ...(c.application ? { app_id: c.application, correlation_id: correlation } : {}),
      ...(files.length ? { resources: files.map((f) => ({ type: "file", file_id: f.id, mount_path: f.mountPath, access: "read_only" })) } : {}),
    });
    const id = String(session.id);
    await this.send(id, text);
    return id;
  }

  async send(session: string, text: string) {
    await this.call("POST", `/v1/sessions/${encodeURIComponent(session)}/events`, { events: [{ type: "user.message", content: [{ type: "text", text }] }] });
  }

  /** Every event of the session: OMA pages them (next_page "seq_N", continued with after_seq=N), and a long turn, such as
   * an assessment reading the source in the sandbox, has more than one page; the turn's end is on the last one. */
  async events(session: string): Promise<OmaEvent[]> {
    const all: OmaEvent[] = [];
    let after: string | null = null;
    for (let page = 0; page < 50; page++) {
      const res = await this.call("GET", `/v1/sessions/${encodeURIComponent(session)}/events?limit=200${after ? `&after_seq=${after}` : ""}`) as { data?: OmaEvent[]; has_more?: boolean; next_page?: string | null };
      all.push(...(res.data ?? []));
      const next = /^seq_(\d+)$/.exec(res.next_page ?? "")?.[1];
      if (!res.has_more || !next) break;
      after = next;
    }
    return all;
  }
}

/** Where a session stands: an error, the Agent's last words once a turn ended, or still working. */
export function sessionOutcome(events: OmaEvent[]): { error?: string; text?: string; ended: boolean } {
  const error = events.find((e) => e.type === "session.error" || (e.type === "agent.message_stream_end" && e.status && e.status !== "completed"));
  if (error) return { error: JSON.stringify(error.error ?? error.status), ended: true };
  const last = [...events].reverse().find((e) => e.type === "agent.message");
  const ended = Boolean(last) && (events.at(-1)?.type === "session.status_idle" || events.at(-1)?.type === "agent.message_stream_end" || events.at(-1) === last);
  return { ...(last ? { text: (last.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n") } : {}), ended };
}
