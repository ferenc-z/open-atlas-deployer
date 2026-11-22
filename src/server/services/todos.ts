// pages-rethink §10.2 step 4: the to-dos (service_todos) and the AI's analyses (service_analyses), and record, the
// MCP verb that writes both. A to-do is one thing a person should do, with at most one suggested action (A2: the AI only
// proposes; a person presses the button and the Deployer's own flow runs it). The same key again updates the open
// to-do instead of adding one. P5: the Deploy Assistant's key writes to-dos only ("Save as a to-do"); the check-up's
// key and an administrator write analyses too, and close to-dos the AI found recovered.

import type { Actor, AnalysisRecord, Store, TodoRecord } from "../store.ts";
import type { TodoSink } from "./flowmodel.ts";
import { THRESHOLD_KEYS, type Anomaly, type AnalysisState, type AnalysisTrigger, type AnalysisView, type Lights, type TodoAction, type TodoSource, type TodoView } from "./ops-types.ts";
import { redactStrings } from "./redact.ts";
import type { ConfigFileRecord, ConfigMember, ServiceConfigBody } from "./config.ts";
import { parseProperties } from "./configview.ts";
import { installKey } from "./draft.ts";

export const ANALYSIS_TRIGGERS: readonly AnalysisTrigger[] = ["schedule", "machine-red", "user-visit", "check-now", "flows-feedback"];
export const ANOMALIES: readonly Anomaly[] = ["processing-failed", "invalid-data", "stuck", "handover-lost", "processor-error", "data-dropped", "e2e-failed"];
/** A1: an analysis is out of date an hour after it ended, or once a light changed after it started. */
export const STALE_MS = 3_600_000;
const MAX_TODOS = 20;
/** analysis.machineSentence / businessSentence: one sentence. */
const SENTENCE_MAX = 200;


export const todoView = (t: TodoRecord): TodoView => ({
  id: t.id, service: t.service, flow: t.flow, source: t.source, severity: t.severity, title: t.title, detail: t.detail,
  action: t.action, createdAt: t.createdAt, createdBy: t.createdBy, draft: t.draft,
});

/** A service's open to-dos: failing first, then oldest first. A config-change's Now column is read from the current revision. */
export function openTodos(store: Store, service: string): TodoView[] {
  let body: ServiceConfigBody | undefined | null = null;
  const current = () => (body === null ? (body = store.serviceConfig(service)?.body) : body);
  return store.todos(service).sort((a, b) => (a.severity === b.severity ? (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) : a.severity === "failing" ? -1 : 1))
    .map((t) => { const v = todoView(t); return v.action?.kind === "config-change" ? { ...v, action: withCurrent(v.action, current()) } : v; });
}

/** Owner 2026-11-20: a config-change's `current` (the dialog's Now column) is what the Deployer reads at {file, key} (and
 *  member) in the service's current revision; the AI's own is not kept. Not readable (no revision, not a properties file,
 *  the key not in it, a cluster's nodes differing): left out. */
export function withCurrent(action: TodoAction, body: ServiceConfigBody | undefined): TodoAction {
  if (action.kind !== "config-change") return action;
  return {
    ...action,
    changes: action.changes.map((c) => {
      const { current: _ai, ...rest } = c;
      if (!body || typeof c.file !== "string" || typeof c.key !== "string") return rest;
      const v = valueAt(body, c.file, c.key, typeof c.member === "string" && c.member ? c.member : null);
      return v === null ? rest : { ...rest, current: v };
    }),
  };
}
function valueAt(body: ServiceConfigBody, file: string, key: string, member: string | null): string | null {
  const read = (f: Pick<ConfigFileRecord, "format" | "redacted"> | undefined): string | null => {
    if (!f || f.format !== "properties") return null;
    const lines = parseProperties(f.redacted).filter((l) => l.key === key);
    return lines.length ? lines[lines.length - 1]!.value : null;
  };
  const fileOf = (m: ConfigMember) => m.files.find((f) => f.name === file);
  if (member) { const m = body.members.find((x) => installKey(x) === member); return m ? read(fileOf(m)) : null; }
  const common = body.layers?.common[file];
  if (common) return read(common);
  const values = body.members.map((m) => read(fileOf(m)));
  return values.length && values.every((v) => v !== null && v === values[0]) ? values[0]! : null;
}

export function analysisView(a: AnalysisRecord, now: Date, lights?: Lights): AnalysisView {
  const body = (a.body && typeof a.body === "object" ? a.body : {}) as Record<string, unknown>;
  const ended = a.finishedAt ?? a.startedAt;
  const stale = a.state !== "running" && (now.getTime() - Date.parse(ended) > STALE_MS || Boolean(lights && (lights.machine !== a.machineLight || lights.business !== a.businessLight)));
  return {
    id: a.id, service: a.service, trigger: a.trigger, state: a.state, startedAt: a.startedAt, finishedAt: a.finishedAt, stale,
    summary: typeof body.summary === "string" ? body.summary : null,
    lookedAt: Array.isArray(body.lookedAt) ? body.lookedAt.map(String) : [], error: a.error,
  };
}

/** The AI's sentences shown beside the lights stay this long after the analysis, while the lights stay as they were then. */
export const SENTENCE_MS = 6 * 3_600_000;
/** The AI's one sentence per light (record analysis.machineSentence, businessSentence) and per business (flows[].sentence)
 *  from the newest finished analysis, each only while its light is still the one recorded with it (record keeps the lights
 *  at write time) and the analysis is under SENTENCE_MS old; otherwise left out and the page shows the rules' sentence. */
export interface AiSentences { machine?: string; business?: string; flows: Record<string, string> }
export function aiSentences(a: AnalysisRecord | null | undefined, now: Date, lights: Lights, flowLights: Record<string, string> = {}): AiSentences {
  const out: AiSentences = { flows: {} };
  if (!a || a.state !== "done" || now.getTime() - Date.parse(a.finishedAt ?? a.startedAt) > SENTENCE_MS) return out;
  const body = (a.body && typeof a.body === "object" ? a.body : {}) as Record<string, any>;
  const said = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const m = said(body.machineSentence);
  if (m && lights.machine === a.machineLight) out.machine = m;
  const b = said(body.businessSentence);
  if (b && lights.business === a.businessLight) out.business = b;
  const was = (body.flowLights && typeof body.flowLights === "object" ? body.flowLights : {}) as Record<string, string>;
  for (const f of Array.isArray(body.flows) ? body.flows : []) {
    const s = said(f?.sentence);
    if (s && typeof f.flow === "string" && was[f.flow] && was[f.flow] === flowLights[f.flow]) out.flows[f.flow] = s;
  }
  return out;
}

/** What step 3b's page and overview builders read (and describe): the open to-dos and the newest analysis of a service. */
export interface OpsReads {
  todos(service: string): TodoView[];
  todoCount(service: string): number;
  /** The newest analysis (running included); lights: the lights now, for `stale`. */
  analysis(service: string, lights?: Lights): AnalysisView | null;
  /** The newest analysis's own record (body: what record wrote), for the AI sentences on the pages. */
  analysisRecord(service: string): AnalysisRecord | null;
  /** The AI's sentences beside the lights, while they still hold (aiSentences). */
  sentences(service: string, lights: Lights, flowLights?: Record<string, string>): AiSentences;
  /** The flows page's intro the AI wrote (record analysis.intro), newest first; null: none yet. */
  intro(service: string): string | null;
  /** §10.2.2 #1: the newest check-up round over all services (analyses sharing a run): running while any is, failed when any failed. */
  lastCheckup(): { at: string; trigger: AnalysisTrigger; state: AnalysisState } | null;
  /** A round is running (the overview's Check now is greyed). */
  running(): boolean;
}
export function opsReads(store: Store, now: () => Date = () => new Date()): OpsReads {
  return {
    todos: (service) => openTodos(store, service),
    todoCount: (service) => store.todos(service).length,
    analysis: (service, lights) => { const a = store.analyses(service, 1)[0]; return a ? analysisView(a, now(), lights) : null; },
    analysisRecord: (service) => store.analyses(service, 1)[0] ?? null,
    // A running or failed analysis does not hide the sentences of the one before it.
    sentences: (service, lights, flowLights) => aiSentences(store.analyses(service, 5).find((a) => a.state === "done"), now(), lights, flowLights),
    intro: (service) => {
      for (const a of store.analyses(service, 20)) {
        const intro = (a.body as { intro?: unknown } | null)?.intro;
        if (a.state === "done" && typeof intro === "string" && intro) return intro;
      }
      return null;
    },
    lastCheckup: () => {
      const run = store.analysisRun();
      if (!run.length) return null;
      const state: AnalysisState = run.some((a) => a.state === "running") ? "running" : run.some((a) => a.state === "failed") ? "failed" : "done";
      const first = run.reduce((x, y) => (x.startedAt <= y.startedAt ? x : y));
      return { at: first.startedAt, trigger: first.trigger, state };
    },
    running: () => store.analysisRun().some((a) => a.state === "running"),
  };
}

/** Step 2's gate opens its to-dos here (rejected: source gate; held for a person: source flows). */
export const todoSink = (store: Store): TodoSink => ({
  open: (t) => store.upsertTodo({ service: t.service, flow: t.flow ?? null, source: t.source, key: t.key, severity: t.severity, title: t.title, detail: t.detail, action: t.action ?? null, analysis: null }, "deployer").id,
  close: (service, key) => { for (const t of store.todos(service)) if (t.key === key) store.closeTodo(t.id, "done", { id: "deployer", via: "service" }); },
});

// ---- record --------------------------------------------------------------------------------------------------------

export class RecordError extends Error {
  readonly status: 400 | 403 | 404 | 409;
  readonly code: string;
  readonly details: string[];
  constructor(status: 400 | 403 | 404 | 409, code: string, message: string, details: string[] = []) { super(message); this.status = status; this.code = code; this.details = details; }
}

const text = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const isObj = (v: unknown): v is Record<string, any> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** A to-do's suggested action (§10.2.1 TodoAction), or the reason it is not one. */
export function parseTodoAction(v: unknown): TodoAction | string {
  if (!isObj(v)) return "action is an object with kind";
  if (!text(v.label, 80)) return "action.label is 1 to 80 characters";
  const label = v.label.trim();
  switch (v.kind) {
    case "config-change":
      if (!Array.isArray(v.changes) || !v.changes.length || v.changes.length > 50 || !v.changes.every(isObj)) return "config-change: changes is 1 to 50 objects, as draft_change takes them";
      if (!text(v.note, 2000)) return "config-change: note says why (as draft_change's note)";
      return { kind: "config-change", label, changes: v.changes, note: v.note.trim() };
    case "member-control":
      if (!text(v.member, 200)) return "member-control: member is a member key (look kind members)";
      if (!["start", "stop", "restart"].includes(v.action)) return "member-control: action is start, stop or restart";
      return { kind: "member-control", label, member: v.member, action: v.action };
    case "set-threshold": {
      if (!isObj(v.overrides) || !Object.keys(v.overrides).length || !Object.values(v.overrides).every((x) => typeof x === "number" && Number.isFinite(x))) return "set-threshold: overrides maps threshold names to numbers";
      const unknown = Object.keys(v.overrides).filter((k) => !(THRESHOLD_KEYS as readonly string[]).includes(k));
      if (unknown.length) return `set-threshold: no such threshold ${unknown.join(", ")}; the names are ${THRESHOLD_KEYS.join(", ")}`;
      return { kind: "set-threshold", label, overrides: v.overrides as Record<string, number> };
    }
    case "confirm-flows": return { kind: "confirm-flows", label };
    case "open-nifi":
      if (typeof v.url !== "string" || !/^https?:\/\/\S{1,500}$/.test(v.url)) return "open-nifi: url is the NiFi address (http or https)";
      return { kind: "open-nifi", label, url: v.url, ...(text(v.component, 200) ? { component: v.component } : {}) };
    default: return "action.kind is config-change, member-control, set-threshold, confirm-flows or open-nifi";
  }
}

export interface TodoInput { key: string; flow: string | null; severity: "failing" | "attention"; title: string; detail: string; action: TodoAction | null }
export interface AnalysisInput {
  trigger: AnalysisTrigger; machine: string; business: string; summary: string; lookedAt: string[];
  /** The one plain sentence beside each light on the pages (Chinese). */
  machineSentence?: string; businessSentence?: string;
  flows?: { flow: string; sentence: string; problems?: { anomaly: Anomaly; cause: string; advice: string[] }[]; risks?: { text: string; component?: string }[] }[];
  stuckSuggestions?: { flow: string; attentionMinutes: number; failingMinutes: number; basis: string }[];
  intro?: string;
}
export interface RecordInput { service: string; analysisId: number | null; analysis: AnalysisInput | null; todos: TodoInput[]; resolve: string[] }

/** record's body (service from the path), checked; every problem named. */
export function parseRecord(service: string, body: unknown): RecordInput {
  const b = isObj(body) ? body : {};
  const errors: string[] = [];
  let analysis: AnalysisInput | null = null;
  if (b.analysis !== undefined && b.analysis !== null) {
    const a = isObj(b.analysis) ? b.analysis : {};
    if (!ANALYSIS_TRIGGERS.includes(a.trigger)) errors.push(`analysis.trigger is one of ${ANALYSIS_TRIGGERS.join(", ")}`);
    for (const k of ["machine", "business", "summary"] as const) if (!text(a[k], 4000)) errors.push(`analysis.${k} is 1 to 4000 characters`);
    if (!Array.isArray(a.lookedAt) || a.lookedAt.length > 40 || !a.lookedAt.every((x: unknown) => text(x, 300))) errors.push("analysis.lookedAt is at most 40 short texts (what you looked at)");
    if (a.flows !== undefined && (!Array.isArray(a.flows) || a.flows.length > 100 || !a.flows.every((f: any) => isObj(f) && text(f.flow, 80) && text(f.sentence, 1000)
      && (f.problems === undefined || (Array.isArray(f.problems) && f.problems.every((p: any) => isObj(p) && ANOMALIES.includes(p.anomaly) && text(p.cause, 2000) && Array.isArray(p.advice) && p.advice.every((x: unknown) => text(x, 1000)))))
      && (f.risks === undefined || (Array.isArray(f.risks) && f.risks.every((r: any) => isObj(r) && text(r.text, 1000))))))) errors.push("analysis.flows: each {flow, sentence, problems?: [{anomaly, cause, advice[]}], risks?: [{text, component?}]}");
    if (a.stuckSuggestions !== undefined && (!Array.isArray(a.stuckSuggestions) || !a.stuckSuggestions.every((s: any) => isObj(s) && text(s.flow, 80) && Number.isInteger(s.attentionMinutes) && Number.isInteger(s.failingMinutes) && s.attentionMinutes >= 1 && s.attentionMinutes < s.failingMinutes && s.failingMinutes <= 43_200 && text(s.basis, 1000)))) errors.push("analysis.stuckSuggestions: each {flow, attentionMinutes < failingMinutes (whole minutes, at most 30 days), basis}");
    if (a.intro !== undefined && !text(a.intro, 2000)) errors.push("analysis.intro is 1 to 2000 characters");
    for (const k of ["machineSentence", "businessSentence"] as const) if (a[k] !== undefined && !text(a[k], SENTENCE_MAX)) errors.push(`analysis.${k} is one plain sentence, 1 to ${SENTENCE_MAX} characters`);
    if (!errors.length) analysis = { trigger: a.trigger, machine: a.machine, business: a.business, summary: a.summary, lookedAt: a.lookedAt, ...(a.machineSentence ? { machineSentence: a.machineSentence.trim() } : {}), ...(a.businessSentence ? { businessSentence: a.businessSentence.trim() } : {}), ...(a.flows ? { flows: a.flows } : {}), ...(a.stuckSuggestions ? { stuckSuggestions: a.stuckSuggestions } : {}), ...(a.intro ? { intro: a.intro } : {}) };
  }
  const todos: TodoInput[] = [];
  if (b.todos !== undefined) {
    if (!Array.isArray(b.todos) || b.todos.length > MAX_TODOS) errors.push(`todos is a list of at most ${MAX_TODOS}`);
    else b.todos.forEach((t: unknown, i: number) => {
      const x = isObj(t) ? t : {};
      const bad = (m: string) => errors.push(`todos[${i}]: ${m}`);
      if (typeof x.key !== "string" || !/^[\w.:@/-]{1,120}$/.test(x.key)) return bad("key is 1 to 120 of letters, digits and _ . : @ / - (the same key updates the open to-do)");
      if (x.severity !== "failing" && x.severity !== "attention") return bad("severity is failing or attention");
      if (!text(x.title, 200)) return bad("title is 1 to 200 characters");
      if (!text(x.detail, 4000)) return bad("detail is 1 to 4000 characters");
      if (x.flow !== undefined && x.flow !== null && !(typeof x.flow === "string" && /^flw_[a-z0-9]{6,32}$/.test(x.flow))) return bad("flow is a business id (flw_…)");
      let action: TodoAction | null = null;
      if (x.action !== undefined && x.action !== null) { const a = parseTodoAction(x.action); if (typeof a === "string") return bad(a); action = a; }
      todos.push({ key: x.key, flow: x.flow ?? null, severity: x.severity, title: x.title.trim(), detail: x.detail.trim(), action });
    });
  }
  const resolve: string[] = [];
  if (b.resolve !== undefined) {
    if (!Array.isArray(b.resolve) || b.resolve.length > 100 || !b.resolve.every((x: unknown) => typeof x === "string" && /^td_[a-f0-9]{6,32}$/.test(x))) errors.push("resolve is a list of to-do ids (td_…)");
    else resolve.push(...b.resolve);
  }
  let analysisId: number | null = null;
  if (b.analysisId !== undefined && b.analysisId !== null) {
    if (!Number.isInteger(b.analysisId)) errors.push("analysisId is the analysis id the first message gave");
    else analysisId = b.analysisId;
  }
  if (analysisId !== null && !analysis && !errors.length) errors.push("analysisId goes with analysis");
  if (errors.length) throw new RecordError(400, "record/invalid", "The record is not valid.", errors);
  if (!analysis && !todos.length && !resolve.length) throw new RecordError(400, "record/empty", "Give analysis, todos or resolve.");
  return { service, analysisId, analysis, todos, resolve };
}

/** A scheduled check-up's services make one round: the newest round when it is a schedule's, under 2 hours old and
 *  without this service yet; otherwise a new one. */
export function scheduleRun(store: Store, service: string, now: number): string {
  const last = store.analysisRun();
  const first = last.length ? last.reduce((x, y) => (x.startedAt <= y.startedAt ? x : y)) : null;
  if (first && first.run && first.trigger === "schedule" && now - Date.parse(first.startedAt) < 2 * 3_600_000 && !last.some((a) => a.service === service)) return first.run;
  return `sch-${new Date(now).toISOString().replace(/[-:.]/g, "")}`;
}

export interface RecordContext {
  store: Store; actor: Actor;
  /** P5: "todos" for the Deploy Assistant's key (to-dos only, source chat); "full" for the check-up's key and an administrator. */
  scope: "full" | "todos";
  /** The lights now: kept with a new analysis to tell later whether it is out of date. */
  lights: () => Lights;
  /** Each business's light now, kept with the analysis (its per-business sentence shows while that light stays). */
  flowLights?: () => Record<string, string>;
  now?: () => Date;
}
export interface RecordResult { analysis: number | null; todos: string[]; resolved: string[] }

/** Writes an analysis (into the running one the session was opened for, or a new one), to-dos and resolutions. */
export function record(ctx: RecordContext, input: RecordInput): RecordResult {
  const { store, actor } = ctx;
  if (ctx.scope === "todos" && (input.analysis || input.resolve.length)) throw new RecordError(403, "record/todos-only", "This key only saves to-dos (todos): an analysis and resolving to-dos are the check-up's.");
  const service = input.service;
  const flowsHere = new Set(store.flows(service).map((f) => f.id));
  const unknownFlows = [...new Set([...input.todos.map((t) => t.flow), ...(input.analysis?.flows ?? []).map((f) => f.flow), ...(input.analysis?.stuckSuggestions ?? []).map((s) => s.flow)].filter((f): f is string => Boolean(f) && !flowsHere.has(f!)))];
  if (unknownFlows.length) throw new RecordError(400, "record/unknown-flow", `No business ${unknownFlows.join(", ")} in ${service}: use the ids describe gives.`);
  for (const id of input.resolve) { const t = store.todo(id); if (!t || t.service !== service) throw new RecordError(404, "record/unknown-todo", `No to-do ${id} of ${service}.`); }
  let target: AnalysisRecord | null = null;
  if (input.analysisId !== null) {
    target = store.analysis(input.analysisId);
    if (!target || target.service !== service) throw new RecordError(404, "record/unknown-analysis", `No analysis ${input.analysisId} of ${service}.`);
    if (target.state !== "running") throw new RecordError(409, "record/analysis-done", `Analysis ${input.analysisId} is ${target.state} already.`);
  }
  const now = (ctx.now ?? (() => new Date()))().toISOString();
  return store.flowTransaction(() => {
    let analysis: number | null = null;
    if (input.analysis) {
      // The lights as they are when the AI writes (it may have published a model meanwhile): "out of date" and the AI's
      // sentences on the pages compare with these, not with the lights when the analysis started.
      const l = ctx.lights();
      const body = { ...redactStrings(input.analysis), ...(ctx.flowLights ? { flowLights: ctx.flowLights() } : {}) };
      // Step 5: the scheduled check-up has no ids (OMA opened its session); it never fills another start's running row.
      const running = target ?? (input.analysis.trigger === "schedule" ? null : store.analyses(service, 5).find((a) => a.state === "running") ?? null);
      if (running) {
        store.setAnalysis({ id: running.id, state: "done", session: running.session, finishedAt: now, body, error: null, machineLight: l.machine, businessLight: l.business });
        analysis = running.id;
      } else {
        const run = input.analysis.trigger === "schedule" ? scheduleRun(store, service, Date.parse(now)) : null;
        analysis = store.addAnalysis({ service, run, trigger: input.analysis.trigger, state: "done", session: null, requestedBy: actor.id, startedAt: now, finishedAt: now, machineLight: l.machine, businessLight: l.business, body, error: null });
      }
      // B4: the AI's stuck times, unless a person set them.
      for (const s of input.analysis.stuckSuggestions ?? []) {
        const f = store.flow(s.flow);
        if (f && f.stuck?.by !== "person") store.putFlow({ ...f, stuck: { attentionS: s.attentionMinutes * 60, failingS: s.failingMinutes * 60, by: "ai", basis: s.basis } });
      }
    }
    const source: TodoSource = ctx.scope === "todos" ? "chat" : "analysis";
    const todos = input.todos.map((t) => store.upsertTodo({ service, flow: t.flow, source, key: t.key, severity: t.severity, title: redactStrings(t.title), detail: redactStrings(t.detail), action: t.action, analysis }, actor.id).id);
    const resolved = input.resolve.filter((id) => store.closeTodo(id, "done", actor));
    return { analysis, todos, resolved };
  });
}
