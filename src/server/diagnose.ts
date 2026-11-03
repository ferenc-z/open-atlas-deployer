// Failure diagnosis (§10.4, D24, phase 6): after every deploy that failed or rolled back, the Deployer opens an OMA
// session itself (interface B, its own OMA Application and API key) with the Deploy Assistant, gives it what the job
// knows (state, steps, the end of the executor's log, the Deployer's step log), and keeps the answer on the job —
// the deployment record shows it. The Agent may read more through the Deployer's read-only MCP tools (its service
// key is in OMA's Vault). Without OMA configured there is no diagnosis; deploys work the same.

import { readToken, type TokenSource } from "./versions.ts";
import type { Job, Store } from "./store.ts";

export interface Diagnosis {
  state: "running" | "done" | "failed";
  session?: string;
  startedAt: string;
  finishedAt?: string;
  cause?: string;
  evidence?: string[];
  suggestion?: string;
  confidence?: string;
  /** The answer as the Agent wrote it, when it is not the JSON asked for, or why there is none. */
  text?: string;
}

export interface OmaSessionConfig {
  url: string;
  keyFile: TokenSource;
  agent: string;
  environment?: string;
  vaults?: string[];
  application?: string;
}

const LOG_LINES = 150;
const TIMEOUT_MS = 10 * 60_000;

/** What the Agent is asked; the facts follow as JSON. */
export function diagnosisPrompt(job: Job, log: string): string {
  const facts = {
    job: job.id, app: job.app, version: job.version, from: job.fromVersion, environment: job.environment, state: job.state, message: job.message,
    executor_steps: job.status?.steps ?? [], deployer_steps: job.rollout?.steps.map((s) => ({ component: s.component, type: s.type, state: s.state, message: s.message })) ?? [],
    deployer_log: job.rollout?.log.slice(-60) ?? [],
    executor_log_tail: log.split("\n").slice(-LOG_LINES).join("\n"),
  };
  return [
    "This deploy failed or was rolled back. Work out why; read only, change nothing.",
    "If you need more information, use the Deployer's read-only tools (get_job, get_status, get_app, plan_deploy, get_env); do not guess causes without evidence.",
    "Your last reply is a single JSON code block in this format:",
    "```json",
    '{"cause": "the cause in one sentence", "evidence": ["evidence from the logs or steps, quoted verbatim"], "suggestion": "suggestion: go back to the previous version / what to change / whom to ask", "confidence": "high | medium | low"}',
    "```",
    "This is the job:",
    "```json",
    JSON.stringify(facts, null, 1),
    "```",
  ].join("\n");
}

/** The JSON block of the Agent's last message, or the text when it is not one. */
export function readAnswer(text: string): Partial<Diagnosis> {
  const block = /```json\s*([\s\S]*?)```/.exec(text)?.[1] ?? text;
  try {
    const o = JSON.parse(block.trim()) as Record<string, unknown>;
    if (typeof o.cause !== "string") throw new Error("no cause");
    return {
      cause: o.cause,
      evidence: Array.isArray(o.evidence) ? o.evidence.map(String).slice(0, 10) : [],
      ...(typeof o.suggestion === "string" ? { suggestion: o.suggestion } : {}),
      ...(typeof o.confidence === "string" ? { confidence: o.confidence } : {}),
    };
  } catch {
    return { text: text.slice(0, 2000) };
  }
}

export class Diagnoser {
  private store: Store;
  private config: OmaSessionConfig;
  private log: (jobId: string) => string;
  private fetcher: typeof fetch;
  private now: () => number;
  private polling = false;

  constructor(store: Store, config: OmaSessionConfig, log: (jobId: string) => string, fetcher: typeof fetch = fetch, now: () => number = Date.now) {
    this.store = store;
    this.config = config;
    this.log = log;
    this.fetcher = fetcher;
    this.now = now;
  }

  private async oma(method: string, path: string, body?: unknown): Promise<any> {
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

  private stamp() { return new Date(this.now()).toISOString(); }

  /** Opens the session for one failed deploy; a failure to open is kept on the job, not thrown. */
  async start(job: Job): Promise<void> {
    const startedAt = this.stamp();
    try {
      const session = await this.oma("POST", "/v1/sessions", {
        agent: this.config.agent, title: `Deployer diagnosis · ${job.app} ${job.version} (${job.environment})`,
        ...(this.config.environment ? { environment_id: this.config.environment } : {}),
        ...(this.config.vaults?.length ? { vault_ids: this.config.vaults } : {}),
        ...(this.config.application ? { app_id: this.config.application, correlation_id: job.id } : {}),
      });
      const id = String(session.id);
      await this.oma("POST", `/v1/sessions/${encodeURIComponent(id)}/events`, { events: [{ type: "user.message", content: [{ type: "text", text: diagnosisPrompt(job, this.log(job.id)) }] }] });
      this.store.setDiagnosis(job.id, { state: "running", session: id, startedAt });
    } catch (error) {
      this.store.setDiagnosis(job.id, { state: "failed", startedAt, finishedAt: this.stamp(), text: `Could not start the diagnosis: ${(error as Error).message}` });
    }
  }

  /** Reads the running diagnoses' sessions; a turn ends with agent.message (or agent.message_stream_end). */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const { job, diagnosis } of this.store.runningDiagnoses()) {
        try {
          const page = await this.oma("GET", `/v1/sessions/${encodeURIComponent(diagnosis.session!)}/events?limit=200`);
          const events = (page.data ?? []) as { type: string; status?: string; error?: unknown; content?: { type: string; text?: string }[] }[];
          const error = events.find((e) => e.type === "session.error" || (e.type === "agent.message_stream_end" && e.status && e.status !== "completed"));
          const last = [...events].reverse().find((e) => e.type === "agent.message");
          const ended = events.some((e) => e.type === "session.status_idle" || e.type === "agent.message_stream_end") || Boolean(last);
          if (error) {
            this.store.setDiagnosis(job, { ...diagnosis, state: "failed", finishedAt: this.stamp(), text: `OMA session error: ${JSON.stringify(error.error ?? error.status)}` });
          } else if (last && ended) {
            const text = (last.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
            this.store.setDiagnosis(job, { ...diagnosis, state: "done", finishedAt: this.stamp(), ...readAnswer(text) });
          } else if (this.now() - Date.parse(diagnosis.startedAt) > TIMEOUT_MS) {
            this.store.setDiagnosis(job, { ...diagnosis, state: "failed", finishedAt: this.stamp(), text: "The diagnosis had no result after 10 minutes" });
          }
        } catch (error) {
          if (this.now() - Date.parse(diagnosis.startedAt) > TIMEOUT_MS) this.store.setDiagnosis(job, { ...diagnosis, state: "failed", finishedAt: this.stamp(), text: (error as Error).message });
        }
      }
    } finally { this.polling = false; }
  }
}
