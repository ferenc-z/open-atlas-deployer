// pages-rethink A1 step 5: the 4-hourly check-up is an OMA agent schedule (`/v1/agent-schedules`, cron + time zone).
// The Deployer keeps one schedule of its own (named after its environment) for the check-up agent: made when missing,
// put back when its agent, version, Environment, Vaults, cron, time zone or message differ, left alone otherwise. OMA
// opens the session itself with a fixed first message, so there are no analysis ids: the agent records each service
// with analysis.trigger "schedule" and the Deployer groups them into one round (todos.ts scheduleRun).

import { readToken, type TokenSource } from "../versions.ts";

export const CHECKUP_CRON = "0 */4 * * *";
export const CHECKUP_TIMEZONE = "Asia/Shanghai";
/** OMA's default Environment for a schedule without one. */
const OMA_DEFAULT_ENVIRONMENT = "env-local-runtime";

export const CHECKUP_MESSAGE = [
  "Deployer analysis (trigger: schedule). The scheduled check-up of every managed service.",
  "There are no analysis ids: call describe without a service for the list, look at every service as your instructions say,",
  'and record each one once, without analysis_id, with analysis.trigger "schedule".',
].join("\n");

export interface CheckupScheduleConfig {
  url: string;
  keyFile: TokenSource;
  agent: string;
  environment?: string;
  /** The Vault holding the check-up's dpc_ key for the Deployer's MCP. */
  vaults: string[];
  cron: string;
  timezone: string;
  /** The schedule's name in OMA (one per Deployer environment). */
  name: string;
}

/** The fields of an OMA schedule this compares and sends. */
interface OmaSchedule { id: string; name: string; agent_id: string; agent_version: number; environment_id: string; initial_message: string; cron_expression: string; timezone: string; vault_ids?: string[] | null; status: string; next_run_at?: string | null }

export interface EnsureResult { action: "created" | "updated" | "unchanged"; id: string; nextRunAt: string | null }

export class CheckupSchedule {
  readonly config: CheckupScheduleConfig;
  private fetcher: typeof fetch;
  /** The schedule's next run, as OMA said last (the overview's nextCheckAt). */
  nextRunAt: string | null = null;

  constructor(config: CheckupScheduleConfig, fetcher: typeof fetch = fetch) { this.config = config; this.fetcher = fetcher; }

  private async call(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<any> {
    const key = readToken(this.config.keyFile);
    if (!key) throw new Error("No OMA API key");
    const response = await this.fetcher(`${this.config.url.replace(/\/+$/, "")}${path}`, {
      method, headers: { "x-api-key": key, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok) {
      let why = "";
      try { why = String(JSON.parse(text).error ?? ""); } catch { /* not JSON */ }
      throw new Error(`OMA ${method} ${path} returned HTTP ${response.status}${why ? `: ${why.slice(0, 300)}` : ""}`);
    }
    return text ? JSON.parse(text) : {};
  }

  /** Makes the schedule match the configuration (the agent's current version), creating it when it is missing. */
  async ensure(): Promise<EnsureResult> {
    const c = this.config;
    const agent = await this.call("GET", `/v1/agents/${encodeURIComponent(c.agent)}`);
    if (!Number.isInteger(agent.version)) throw new Error(`OMA agent ${c.agent} has no version`);
    const body = {
      name: c.name, agent_id: c.agent, agent_version: agent.version as number,
      ...(c.environment ? { environment_id: c.environment } : {}),
      initial_message: CHECKUP_MESSAGE, cron: { expression: c.cron, timezone: c.timezone }, vault_ids: c.vaults,
    };
    const list = ((await this.call("GET", "/v1/agent-schedules")).data ?? []) as OmaSchedule[];
    const found = list.find((s) => s.name === c.name && s.status !== "archived");
    if (!found) {
      const made = await this.call("POST", "/v1/agent-schedules", body) as OmaSchedule;
      this.nextRunAt = made.next_run_at ?? null;
      return { action: "created", id: made.id, nextRunAt: this.nextRunAt };
    }
    const same = found.agent_id === body.agent_id && found.agent_version === body.agent_version
      && found.environment_id === (c.environment ?? OMA_DEFAULT_ENVIRONMENT) && found.initial_message === body.initial_message
      && found.cron_expression === c.cron && found.timezone === c.timezone
      && [...(found.vault_ids ?? [])].sort().join(",") === [...c.vaults].sort().join(",");
    if (same) {
      this.nextRunAt = found.next_run_at ?? null;
      return { action: "unchanged", id: found.id, nextRunAt: this.nextRunAt };
    }
    const put = await this.call("PUT", `/v1/agent-schedules/${encodeURIComponent(found.id)}`, body) as OmaSchedule;
    this.nextRunAt = put.next_run_at ?? null;
    return { action: "updated", id: found.id, nextRunAt: this.nextRunAt };
  }
}
