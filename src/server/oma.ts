// OMA sessions the Deployer opens itself (interface B, §10.2): its own Application and API key, an Agent, an
// Environment and Vaults. Used for failure diagnosis (D24) and assessments (§10.5, D27).

import { readToken } from "./versions.ts";

export interface OmaSessionConfig {
  url: string;
  keyFile: string | undefined;
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
    if (!key) throw new Error("没有 OMA API key");
    const response = await this.fetcher(`${this.config.url.replace(/\/+$/, "")}${path}`, {
      method,
      headers: { "x-api-key": key, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`OMA ${method} ${path.split("?")[0]} 返回 HTTP ${response.status}`);
    return response.json();
  }

  /** Opens a session and sends its first message; returns the session id. */
  async open(title: string, correlation: string, text: string): Promise<string> {
    const c = this.config;
    const session = await this.call("POST", "/v1/sessions", {
      agent: c.agent, title,
      ...(c.environment ? { environment_id: c.environment } : {}),
      ...(c.vaults?.length ? { vault_ids: c.vaults } : {}),
      ...(c.application ? { app_id: c.application, correlation_id: correlation } : {}),
    });
    const id = String(session.id);
    await this.send(id, text);
    return id;
  }

  async send(session: string, text: string) {
    await this.call("POST", `/v1/sessions/${encodeURIComponent(session)}/events`, { events: [{ type: "user.message", content: [{ type: "text", text }] }] });
  }

  async events(session: string): Promise<OmaEvent[]> {
    return ((await this.call("GET", `/v1/sessions/${encodeURIComponent(session)}/events?limit=200`)).data ?? []) as OmaEvent[];
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
