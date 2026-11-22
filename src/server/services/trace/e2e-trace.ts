// S37 step 7 (pages-rethink §7 Q2, T6, T8, T9, T10): the e2e_trace evidence source. NiFi 2.x writes a run record per
// worker start and end to ClickHouse e2e_trace.rt_dwd_l1_trace_log, keyed by correlation_id, which every RabbitMQ hop
// carries. The Deployer reads it through Studio's data plane with a graph token (T8): a service has this source only
// when it is configured with a Graph and a token (T9, capabilities), and the Deployer runs the graph's saved queries
// (e2e-graph.ts), never EQL of its own. Every run-record query has a time range (the table's sort key starts with the
// hour). The same graph gives the schedule definitions the model is imported from (T6) and each worker's historical
// P95 duration, the step's allowed time (T10).
//
// Run records can miss rows while a NiFi node is down. When a step has no row but a later step of the same data does,
// the answer says the records are incomplete, so the engine asks the next source (provenance) instead of judging.

import type { Actor, Store } from "../../store.ts";
import type { SecretBox } from "../../secretbox.ts";
import { McpClient } from "../../mcp-client.ts";
import type { AdapterAnswer, Capabilities, EvidenceAdapter, KeyQuery, ObservedEvent, Position } from "./events.ts";
import { emptyModel, type Business, type Endpoint, type Step, type TraceModel } from "./model.ts";

export const E2E_ID = "e2e_trace";
/** The key names the adapter answers, and the saved query each is run with. */
const QUERY_BY_KEY: Record<string, { query: string; param: string }> = {
  correlation_id: { query: "e2e_records_by_correlation", param: "correlation_id" },
  file_name: { query: "e2e_records_by_file", param: "file_name" },
  filename: { query: "e2e_records_by_file", param: "file_name" },
  email_subject: { query: "e2e_records_by_subject", param: "email_subject" },
  email_from: { query: "e2e_records_by_sender", param: "email_from" },
};
/** T10: the history a P95 is taken over, the runs it needs to count, and its floor (a P95 of seconds would flap). */
export const P95_DAYS = 7;
export const P95_MIN_SAMPLES = 20;
export const P95_FLOOR_SECONDS = 60;
const RECORDS_TTL_MS = 20_000;
const DURATIONS_TTL_MS = 10 * 60_000;
const DAY = 86400_000;

export interface E2eConfig { graph: string; token: string; savedAt: string; savedBy: string }
export interface E2eDeps {
  store: Store;
  /** Seals the graph token (DEPLOYER_CREDENTIAL_ENCRYPTION_KEY); without it nothing can be configured. */
  box?: SecretBox;
  /** Studio's data plane MCP (DEPLOYER_STUDIO_DATA_URL); the graph token decides which graph it reads. */
  dataUrl?: string;
  /** Studio's Builder MCP with the workspace token, to issue a graph token instead of pasting one (issue_graph_token). */
  builder?: { call(name: string, args: Record<string, unknown>): Promise<any> };
  /** Tests pass a fake data plane. */
  client?: (url: string, token: string) => { call(name: string, args: Record<string, unknown>): Promise<any> };
  now?: () => Date;
}
type Row = Record<string, string | number | null>;

/** A saved query's rows: the first collection in the result, with the attribute namespaces taken off. */
export function rowsOf(answer: any): { rows: Row[]; truncated: boolean } {
  const result = answer?.result;
  const list = result && typeof result === "object" ? Object.values(result).find(Array.isArray) as unknown[] | undefined : undefined;
  if (!list) return { rows: [], truncated: Boolean(answer?.result_handle) };
  const rows = list.map((r) => Object.fromEntries(Object.entries(r as Record<string, unknown>).map(([k, v]) => [k.replace(/^[^/]*\//, ""), v as string | number | null])));
  return { rows, truncated: Boolean(answer?.result_handle) };
}

const str = (v: unknown) => (v === null || v === undefined ? undefined : String(v));

/** One run record as an observed event: start, end, failure (process_status wins), processing as other. */
export function recordEvent(service: string, r: Row): ObservedEvent {
  const state = r.process_status === "failure" ? "failure" : r.process_stage === "start" ? "start" : r.process_stage === "end" ? "end" : "other";
  const attrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(r)) if (v !== null && v !== undefined && v !== "" && k !== "row_key") attrs[k] = String(v);
  if (attrs.file_name) attrs.filename = attrs.file_name;
  if (state === "failure") attrs.error = `${attrs.worker_name ?? "the worker"} ended in failure${attrs.node_name ? ` on ${attrs.node_name}` : ""}`;
  return {
    source: E2E_ID, service, key: { name: "correlation_id", value: String(r.correlation_id) },
    position: { kind: "worker", id: String(r.worker_name ?? ""), name: String(r.worker_name ?? "") },
    at: String(r.received_at), state, attrs, ref: { ...(str(r.node_name) ? { node: str(r.node_name)! } : {}), ...(str(r.row_key) ? { eventId: str(r.row_key)! } : {}) },
  };
}

const atWorker = (p: Position, worker: unknown) => p.kind === "worker" && (p.id === worker || (p.name !== undefined && p.name === worker));

export class E2eTraceSource {
  private d: E2eDeps;
  private now: () => Date;
  private clients = new Map<string, { at: string; client: { call(name: string, args: Record<string, unknown>): Promise<any> } }>();
  private records = new Map<string, { until: number; answer: Promise<{ rows: Row[]; truncated: boolean }> }>();
  private durations = new Map<string, { until: number; rows: Promise<Row[]> }>();
  readonly adapter: EvidenceAdapter;

  constructor(d: E2eDeps) {
    this.d = d;
    this.now = d.now ?? (() => new Date());
    const self = this;
    this.adapter = {
      id: E2E_ID,
      capabilities: (service) => self.capabilities(service),
      byKey: (q) => self.byKey(q),
      allowance: (q) => self.allowance(q.service, q.position),
    };
  }

  /** What is missing before a service can be configured here (empty: nothing). */
  prerequisites(): string[] {
    return [
      ...(this.d.dataUrl ? [] : ["DEPLOYER_STUDIO_DATA_URL (Studio's data plane MCP) is not set."]),
      ...(this.d.box ? [] : ["DEPLOYER_CREDENTIAL_ENCRYPTION_KEY is not set: the graph token cannot be kept."]),
    ];
  }
  canIssue() { return Boolean(this.d.builder); }

  config(service: string): Omit<E2eConfig, "token"> | null {
    const r = this.d.store.traceSource(service, E2E_ID);
    if (!r) return null;
    const b = r.body as { graph?: string };
    return { graph: String(b.graph ?? ""), savedAt: r.savedAt, savedBy: r.savedBy };
  }

  /** T9: only a configured service has this source; then it answers by these keys, not by position or hand-over. */
  capabilities(service: string): Capabilities {
    const on = !this.prerequisites().length && Boolean(this.d.store.traceSource(service, E2E_ID));
    return { byKey: on ? Object.keys(QUERY_BY_KEY) : [], byPosition: false, handover: [] };
  }

  /** Saves the Graph and a token: pasted, or issued through the Builder MCP (issue_graph_token) when `token` is absent. */
  async configure(service: string, graph: string, token: string | undefined, actor: Actor): Promise<{ issued: boolean }> {
    const missing = this.prerequisites();
    if (missing.length) throw new E2eError(503, "e2e/not-ready", missing.join(" "));
    let issued = false;
    if (!token) {
      if (!this.d.builder) throw new E2eError(503, "e2e/no-builder", "Studio's Builder MCP is not configured (DEPLOYER_STUDIO_BUILDER_URL, DEPLOYER_STUDIO_TOKEN_FILE): paste a graph token instead.");
      const answer = await this.d.builder.call("issue_graph_token", { graph, label: `open-atlas-deployer ${service} e2e_trace` });
      token = JSON.stringify(answer).match(/oat_v1\.[A-Za-z0-9._~+/=-]+/)?.[0];
      if (!token) throw new E2eError(502, "e2e/issue", "Studio issued no graph token (check the graph name and that the workspace token may edit it).");
      issued = true;
    }
    this.d.store.setTraceSource(service, E2E_ID, { graph, token: this.d.box!.seal(token) }, actor);
    this.clients.delete(service);
    return { issued };
  }

  remove(service: string, actor: Actor) { this.d.store.removeTraceSource(service, E2E_ID, actor); this.clients.delete(service); }

  private client(service: string) {
    const r = this.d.store.traceSource(service, E2E_ID);
    if (!r || this.prerequisites().length) return undefined;
    const kept = this.clients.get(service);
    if (kept && kept.at === r.savedAt) return kept.client;
    const token = this.d.box!.open(String((r.body as { token: string }).token));
    const client = this.d.client ? this.d.client(this.d.dataUrl!, token) : new McpClient(this.d.dataUrl!, () => ({ authorization: `Bearer ${token}` }));
    this.clients.set(service, { at: r.savedAt, client });
    return client;
  }

  /** Runs one of the graph's saved queries for a service. */
  async run(service: string, name: string, params: Record<string, string>): Promise<{ rows: Row[]; truncated: boolean }> {
    const c = this.client(service);
    if (!c) throw new E2eError(409, "e2e/not-configured", `${service} has no e2e_trace source: configure a Graph and a graph token first.`);
    return rowsOf(await c.call("run_saved_query", { name, params }));
  }

  /** A check of the configuration: the schedules the graph reads. */
  async check(service: string): Promise<{ ok: boolean; schedules?: number; message: string }> {
    try {
      const { rows } = await this.run(service, "e2e_schedules", {});
      return { ok: true, schedules: rows.length, message: `Studio answered: ${rows.length} schedule(s) in the definitions.` };
    } catch (error) { return { ok: false, message: (error as Error).message }; }
  }

  async byKey(q: KeyQuery): Promise<AdapterAnswer> {
    const spec = QUERY_BY_KEY[q.key.name];
    if (!spec || !this.client(q.service)) return { events: [], missing: { reason: "unavailable", message: `${q.service} has no e2e_trace source configured.` } };
    if (q.position && q.position.kind !== "worker") return { events: [], missing: { reason: "unavailable", message: "e2e_trace records workers, not NiFi components." } };
    const cacheKey = JSON.stringify([q.service, spec.query, q.key.value, q.from, q.to]);
    let hit = this.records.get(cacheKey);
    if (!hit || hit.until < Date.now()) {
      hit = { until: Date.now() + RECORDS_TTL_MS, answer: this.run(q.service, spec.query, { [spec.param]: q.key.value, from: q.from, to: q.to }) };
      hit.answer.catch(() => this.records.delete(cacheKey));
      this.records.set(cacheKey, hit);
      for (const [k, v] of this.records) if (v.until < Date.now()) this.records.delete(k);
    }
    let got: { rows: Row[]; truncated: boolean };
    try { got = await hit.answer; } catch (error) { return { events: [], missing: { reason: "error", message: `Studio: ${(error as Error).message}` } }; }
    const all = got.rows.map((r) => recordEvent(q.service, r)).sort((a, b) => a.at.localeCompare(b.at));
    const events = q.position ? all.filter((e) => atWorker(q.position!, e.attrs.worker_name)) : all;
    if (events.length || !q.position || q.key.name !== "correlation_id") {
      return { events, ...(got.truncated && !events.length ? { missing: { reason: "error" as const, message: "Studio returned the result only as a handle (too many rows): narrow the time range." } } : {}) };
    }
    // A gap: an earlier step named this worker as its next one, and the data went on to another worker afterwards.
    const worker = q.position.id;
    const handedAt = all.find((e) => (e.attrs.next_worker_names ?? "").split(",").includes(worker) || (q.position!.name && (e.attrs.next_worker_names ?? "").split(",").includes(q.position!.name)))?.at;
    const later = handedAt ? all.filter((e) => e.at > handedAt && !atWorker(q.position!, e.attrs.worker_name) && !(e.attrs.next_worker_names ?? "").split(",").includes(worker)) : [];
    if (later.length) {
      const names = [...new Set(later.map((e) => e.attrs.worker_name))].join(", ");
      return { events: [], missing: { reason: "unavailable", message: `The run records skip ${worker}: ${names} recorded this data afterwards, so the records are incomplete here (a NiFi node down?).` } };
    }
    return { events: [] };
  }

  /** T10: the worker's historical P95 duration (seconds) as the step's allowed time; undefined when it cannot be had. */
  async allowance(service: string, position: Position): Promise<number | undefined> {
    if (position.kind !== "worker" || !this.client(service)) return undefined;
    let hit = this.durations.get(service);
    if (!hit || hit.until < Date.now()) {
      const to = this.now(), from = new Date(to.getTime() - P95_DAYS * DAY);
      hit = { until: Date.now() + DURATIONS_TTL_MS, rows: this.run(service, "e2e_worker_durations", { from: from.toISOString(), to: to.toISOString() }).then((r) => r.rows) };
      this.durations.set(service, hit);
    }
    try {
      const row = (await hit.rows).find((r) => atWorker(position, r.worker_name));
      const p95 = Number(row?.p95_seconds), n = Number(row?.samples);
      if (!row || !Number.isFinite(p95) || !(n >= P95_MIN_SAMPLES)) return undefined;
      return Math.max(P95_FLOOR_SECONDS, Math.ceil(p95));
    } catch { this.durations.delete(service); return undefined; }
  }

  /** P3 (BusinessScanner's E2eFailures): the failure records in a time range. The worker is the position; the scan
   *  places it on the segment whose step is that worker (an imported schedule), so other services' schedules in the
   *  same graph are nobody's here. */
  async failures(service: string, from: string, to: string): Promise<{ at: string; worker: string; text: string }[]> {
    if (!this.client(service)) return [];
    const { rows } = await this.run(service, "e2e_failures", { from, to });
    return rows.map((r) => {
      const e = recordEvent(service, r);
      const clue = e.attrs.file_name ? `, file ${e.attrs.file_name}` : e.attrs.email_subject ? `, mail "${e.attrs.email_subject}"` : "";
      return { at: e.at, worker: String(r.worker_name ?? ""), text: `${e.attrs.schedule_name ?? "schedule"}: ${e.attrs.error} (correlation_id ${r.correlation_id}${clue})` };
    }).filter((f) => f.worker);
  }

  /** T6: the schedules as businesses (schedule_header + schedule_detail, latest revisions), merged into the stored model. */
  async importModel(service: string, current: TraceModel): Promise<{ model: TraceModel; imported: string[]; replaced: string[]; notes: string[] }> {
    const [headers, details] = await Promise.all([this.run(service, "e2e_schedules", {}), this.run(service, "e2e_schedule_steps", {})]);
    const { businesses, notes } = businessesFrom(headers.rows, details.rows);
    if (headers.truncated || details.truncated) notes.push("Studio returned part of the definitions only (too many rows).");
    const model: TraceModel = { ...emptyModel(service), ...current, businesses: [...current.businesses] };
    const imported: string[] = [], replaced: string[] = [];
    for (const b of businesses) {
      const i = model.businesses.findIndex((x) => x.id === b.id);
      if (i >= 0) { model.businesses[i] = b; replaced.push(b.id); } else { model.businesses.push(b); imported.push(b.id); }
    }
    if (!model.sources.length) model.sources = [E2E_ID, "provenance"];
    else if (!model.sources.includes(E2E_ID)) model.sources = [E2E_ID, ...model.sources];
    return { model, imported, replaced, notes };
  }
}

export class E2eError extends Error {
  readonly status: 409 | 502 | 503;
  readonly code: string;
  constructor(status: 409 | 502 | 503, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

const ID_SAFE = (s: string) => s.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "x";
const CUES: Endpoint["cues"] = [{ cue: "fileName", key: "file_name" }, { cue: "emailSubject", key: "email_subject" }, { cue: "emailFrom", key: "email_from" }];

/** schedule_header rows + schedule_detail rows → one business per schedule (parseModel's shape). */
export function businessesFrom(headers: Row[], details: Row[]): { businesses: Business[]; notes: string[] } {
  const notes: string[] = [];
  const businesses: Business[] = [];
  for (const h of [...headers].sort((a, b) => Number(a.schedule_id) - Number(b.schedule_id))) {
    const name = String(h.schedule_name ?? `schedule ${h.schedule_id}`);
    const rows = details.filter((d) => Number(d.schedule_id) === Number(h.schedule_id)).sort((a, b) => Number(a.schedule_seq) - Number(b.schedule_seq));
    if (!rows.length) { notes.push(`${name}: no steps in schedule_detail; not imported.`); continue; }
    if (rows.length > 50) notes.push(`${name}: ${rows.length} steps, the first 50 imported.`);
    const ids = new Set<string>();
    const steps: Step[] = rows.slice(0, 50).map((d) => {
      const worker = String(d.worker_name ?? `worker ${d.worker_id}`);
      let id = ID_SAFE(worker);
      if (ids.has(id)) id = ID_SAFE(`${d.schedule_seq}-${worker}`);
      ids.add(id);
      return { id, name: worker, position: { kind: "worker", id: worker, ...(d.worker_message_name ? { name: String(d.worker_message_name) } : {}) } };
    });
    // The manager is triggered over MQ (trigger_exchange_name / trigger_routing_key); without them the trigger is outside.
    const ex = str(h.trigger_exchange_name), rk = str(h.trigger_routing_key);
    const entry: Endpoint = { id: "trigger", step: steps[0]!.id, channel: ex && rk ? { type: "mq", exchange: ex, routingKey: rk } : { type: "external", system: `trigger of ${name}` }, keyAttribute: "correlation_id", cues: CUES };
    if (h.final_worker_id !== null && h.final_worker_id !== undefined && !rows.some((d) => Number(d.worker_id) === Number(h.final_worker_id)))
      notes.push(`${name}: the final worker ${h.final_worker_id} is not among its steps.`);
    businesses.push({
      id: ID_SAFE(`schedule-${h.schedule_id}`), name: name.slice(0, 200), match: [{ attr: "schedule_name", op: "equals", value: name }], steps, entries: [entry], exits: [],
    });
  }
  if (businesses.length) notes.push("The final worker hands over to the next schedule's trigger, which the definitions do not name: add an MQ exit by hand where another service's model has that entry.");
  if (businesses.length > 50) { notes.push(`${businesses.length} schedules, the first 50 imported.`); businesses.length = 50; }
  return { businesses, notes };
}
