// pages-rethink B2, B3, B4, P3 (ops step 3b): the business light. Only whether the data goes right, never how much
// (B2). Six anomalies (B3) plus e2e_trace's failures (P3), each found per business on its segments (group, slice,
// exits), kept in flow_anomalies and opened and closed like the machine's alerts:
//   processing-failed  data routed to failure (a provenance event with relationship failure, a queue named failure that
//                      holds data, or an unregistered shared error-handling group that received data;
//                      a registered shared module's failures are the module's own, §7.8 ⑦)          attention
//   invalid-data       the same with relationship invalid (validation processors)                    attention
//   stuck              a queue that has not been empty for the business's two stuck times (B4)        attention / failing
//   handover-lost      S2S: sent by one service and not received by the other (the hour's counts)     failing
//   processor-error    an ERROR bulletin of one of the business's components                          attention
//   data-dropped       a DROP outside the marked exits (component, relationship; DROP probe §10.1), or an EXPIRE  failing
//   e2e-failed         e2e_trace's failure records (P3)                                               attention
// Events (everything but stuck and handover-lost) close after QUIET_MINUTES without a new one; conditions close when
// they no longer hold. A business whose last model draft failed the gate is unknown (A8), whatever its anomalies.

import type { FlowAnomaly, FlowRecord, ServiceBulletin, Store } from "../store.ts";
import { DEFAULT_STUCK, dropRelationship, exitOf, gateRejected } from "./flowmodel.ts";
import type { Topology } from "./flowcounts.ts";
import { LIGHT_ORDER, type Anomaly, type FlowNote, type BusinessLightView, type FlowRow, type FlowStatus, type Light, type UnknownReason } from "./ops-types.ts";
import { canvasChangeTodos, watchedFlows } from "./registered.ts";
import { lightOfAlert } from "./rules.ts";
import { registeredGroupsOn } from "./watch.ts";
import { WHOLE, type ModelV2, type Segment } from "./trace/model.ts";

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
/** An event anomaly closes when nothing new was seen for this long. */
export const QUIET_MINUTES = 60;
/** The provenance scan's period, and how far back it reads at most (after a pause). */
export const SCAN_MINUTES = 5;
export const SCAN_BACK_MINUTES = 60;
/** handover-lost: the window compared (newest bucket left out: the receiver counts it a little later). */
export const HANDOVER_HOURS = 2;
const EVENT_KINDS: readonly (Anomaly | FlowNote)[] = ["processing-failed", "invalid-data", "processor-error", "data-dropped", "e2e-failed", "other-drop"];
export const ANOMALY_LIGHT: Record<Exclude<Anomaly, "stuck">, Exclude<Light, "healthy" | "unknown">> = {
  "processing-failed": "attention", "invalid-data": "attention", "processor-error": "attention", "e2e-failed": "attention",
  "handover-lost": "failing", "data-dropped": "failing",
};
export const ANOMALY_LABEL: Record<Anomaly | FlowNote, string> = {
  "processing-failed": "Processing failed", "invalid-data": "Invalid data", stuck: "Stuck", "handover-lost": "Hand-over lost",
  "processor-error": "Processor error", "data-dropped": "Data dropped", "e2e-failed": "e2e_trace failure", "other-drop": "Other drops",
};
/** Owner 2026-11-20: what is kept in flow_anomalies but lights nothing (only the flow detail's last 7 days list it). */
export const isAnomaly = <T extends { anomaly: Anomaly | FlowNote }>(a: T): a is T & { anomaly: Anomaly } => a.anomaly !== "other-drop";
const FAILURE_GROUP = /error|fail|exception|错误|异常|失败/i;
const worse = (a: Light, b: Light): Light => (LIGHT_ORDER[a] <= LIGHT_ORDER[b] ? a : b);
type Any = Record<string, any>;

// ---- where a component is ---------------------------------------------------------------------------------------

export interface Place { flow: string; service: string; segment: string; group: string; groupName: string }

/** Finds the business segment a component (or a group) of a service belongs to: a step or exit naming the component;
 *  else its group's unit under root (topology.nested for deeper groups, by name for an old executor's queue) and, in a
 *  unit of several slices, the component's slice (topology.split). Shared steps and ignored businesses are nobody's. */
export function locator(store: Store, service: string): (o: { component?: string | null; group?: string | null; groupName?: string | null }) => Place | null {
  const model = store.flowModel(service)?.model ?? null;
  const topo = (store.latestTopology(service)?.body as Topology | undefined) ?? null;
  const watched = new Map(watchedFlows(store, service).filter((f) => f.status !== "ignored").map((f) => [f.id, f]));
  const segs = (model?.segments ?? []).filter((s) => s.role === "segment" && s.flow && watched.has(s.flow));
  const place = (s: Segment): Place => ({ flow: s.flow!, service, segment: s.id, group: s.group.id, groupName: s.group.name });
  const units = new Set([...(topo?.groups ?? []).map((g) => g.id), ...(topo ? [topo.root.id] : [])]);
  return (o) => {
    if (o.component) {
      const s = segs.find((x) => x.steps.some((st) => st.position.id === o.component) || x.exits.some((e) => e.component === o.component));
      if (s) return place(s);
    }
    let unit: string | null = null;
    if (o.group) unit = units.has(o.group) ? o.group : topo?.nested?.[o.group] ?? (segs.some((s) => s.group.id === o.group) ? o.group : null);
    if (!unit && o.groupName) {
      const named = (topo?.groups ?? []).filter((g) => g.name === o.groupName);
      if (named.length === 1) unit = named[0]!.id;
    }
    if (!unit) return null;
    const here = segs.filter((s) => s.group.id === unit);
    const fragment = o.component ? topo?.split?.[o.component] : undefined;
    const s = (fragment ? here.find((x) => x.slice === fragment) : undefined) ?? here.find((x) => x.slice === WHOLE) ?? (here.length === 1 ? here[0] : undefined);
    // A unit whose only modelled segment is shared, or not modelled at all: nobody's.
    return s ? place(s) : null;
  };
}

// ---- observations -----------------------------------------------------------------------------------------------

export interface Observation { place: Place; ref: string; anomaly: Anomaly | FlowNote; light: Light; at: string; count: number; detail: Record<string, unknown> }

/** Provenance events (the scan's DROP, EXPIRE and relationship failure / invalid searches) as observations, one per
 *  (business segment, component, anomaly). A DROP at a marked exit is a normal end; a DROP not auto-terminated (a queue
 *  emptied by a person) is "other": kept as other-drop with NiFi's details when it can be placed, lighting nothing
 *  (owner 2026-11-20: the flow detail's last 7 days list it). */
export function classifyEvents(model: ModelV2 | null, locate: ReturnType<typeof locator>, events: Any[], atLeast = false): { observations: Observation[]; other: number; exits: number; unplaced: number } {
  const out = new Map<string, Observation>();
  let other = 0, exits = 0, unplaced = 0;
  for (const e of events) {
    const type = String(e.eventType ?? "");
    const component = typeof e.componentId === "string" ? e.componentId : null;
    let anomaly: Anomaly | FlowNote | null = null, relationship: string | null = null;
    if (type === "DROP") {
      relationship = dropRelationship(e.details);
      if (relationship === null) { other++; anomaly = "other-drop"; }
      else if (component && exitOf(model, component, relationship)) { exits++; continue; }
      else anomaly = "data-dropped";
    } else if (type === "EXPIRE") anomaly = "data-dropped";
    else if (e.relationship === "failure") { anomaly = "processing-failed"; relationship = "failure"; }
    else if (e.relationship === "invalid") { anomaly = "invalid-data"; relationship = "invalid"; }
    if (!anomaly || !component) continue;
    const place = locate({ component, group: typeof e.groupId === "string" ? e.groupId : null });
    if (!place) { if (anomaly !== "other-drop") unplaced++; continue; }
    const at = typeof e.at === "string" ? e.at : typeof e.eventTime === "string" ? e.eventTime : new Date().toISOString();
    const key = `${place.flow}\0${component}\0${anomaly}`;
    const was = out.get(key);
    if (was) { was.count++; if (at > was.at) was.at = at; continue; }
    out.set(key, {
      place, ref: component, anomaly, light: anomaly === "other-drop" ? "healthy" : ANOMALY_LIGHT[anomaly as Exclude<Anomaly, "stuck">], at, count: 1,
      detail: { segment: place.segment, component, componentName: e.componentName ?? null, componentType: e.componentType ?? null, relationship, expired: type === "EXPIRE", details: typeof e.details === "string" ? e.details.slice(0, 300) : null, ...(atLeast ? { atLeast: true } : {}) },
    });
  }
  return { observations: [...out.values()], other, exits, unplaced };
}

/** ERROR bulletins as processor-error observations. */
export function classifyBulletins(locate: ReturnType<typeof locator>, rows: ServiceBulletin[]): Observation[] {
  const out = new Map<string, Observation>();
  for (const b of rows) {
    if ((b.level ?? "").toUpperCase() !== "ERROR") continue;
    const place = locate({ component: b.sourceId ?? null, group: b.groupId ?? null });
    if (!place) continue;
    const ref = b.sourceId ?? place.group;
    const key = `${place.flow}\0${ref}`;
    const was = out.get(key);
    if (was) { was.count++; if (b.at > was.at) { was.at = b.at; was.detail.message = (b.message ?? "").slice(0, 300); } continue; }
    out.set(key, { place, ref, anomaly: "processor-error", light: "attention", at: b.at, count: 1, detail: { segment: place.segment, component: b.sourceId ?? null, componentName: b.source ?? null, message: (b.message ?? "").slice(0, 300) } });
  }
  return [...out.values()];
}

const stuckSeconds = (f: FlowRecord | null) => f?.stuck ? { attention: f.stuck.attentionS, failing: f.stuck.failingS } : { attention: DEFAULT_STUCK.attentionMinutes * 60, failing: DEFAULT_STUCK.failingMinutes * 60 };

/** Queues as conditions: one that held data in every back pressure reading for the business's stuck times (B4) is
 *  stuck; one named failure / invalid (a connection's name is its relationships when nobody named it) that holds data
 *  is processing-failed / invalid-data. readings: oldest first. A queue that is never empty between readings is taken
 *  as waiting since the first such reading (a reading is every 5 minutes, so this is a lower bound). */
export function queueConditions(store: Store, locate: ReturnType<typeof locator>, readings: { at: string; backpressure: Any }[], now: Date): Observation[] {
  if (!readings.length) return [];
  const last = readings[readings.length - 1]!;
  if (now.getTime() - Date.parse(last.at) > 20 * MIN) return [];
  const flows = new Map<string, FlowRecord | null>();
  const flowOf = (id: string) => { if (!flows.has(id)) flows.set(id, store.flow(id)); return flows.get(id)!; };
  const out: Observation[] = [];
  const held = (r: { backpressure: Any }, id: unknown) => ((r.backpressure?.top ?? []) as Any[]).find((c) => c.id === id && Number(c.flowFilesQueued) > 0);
  for (const c of (last.backpressure?.top ?? []) as Any[]) {
    if (!(Number(c.flowFilesQueued) > 0)) continue;
    const place = locate({ component: typeof c.destinationId === "string" ? c.destinationId : null, group: typeof c.groupId === "string" ? c.groupId : null, groupName: typeof c.group === "string" ? c.group : null })
      ?? locate({ component: typeof c.sourceId === "string" ? c.sourceId : null });
    if (!place) continue;
    const rels = String(c.name ?? "").split(",").map((x) => x.trim().toLowerCase());
    const base = { segment: place.segment, connection: c.id ?? null, name: c.name ?? null, source: c.sourceName ?? null, destination: c.destinationName ?? null, queued: Number(c.flowFilesQueued) };
    for (const [rel, anomaly] of [["failure", "processing-failed"], ["invalid", "invalid-data"]] as const) {
      if (rels.includes(rel)) out.push({ place, ref: String(c.id ?? rel), anomaly, light: "attention", at: last.at, count: Number(c.flowFilesQueued), detail: { ...base, relationship: rel } });
    }
    let i = readings.length - 1;
    while (i > 0 && held(readings[i - 1]!, c.id)) i--;
    const since = readings[i]!.at;
    const waited = (now.getTime() - Date.parse(since)) / 1000;
    const t = stuckSeconds(flowOf(place.flow));
    const light: Light | null = waited >= t.failing ? "failing" : waited >= t.attention ? "attention" : null;
    if (light) out.push({ place, ref: String(c.id), anomaly: "stuck", light, at: last.at, count: Number(c.flowFilesQueued), detail: { ...base, since, minutes: Math.floor(waited / 60) } });
  }
  return out;
}

/** handover-lost: each S2S exit of the service's businesses to a managed service, the sender's s2s-out counts against
 *  the receiver's s2s-in counts over HANDOVER_HOURS (the newest bucket left out). Too few received beyond
 *  max(5, 2 %) is lost; the receiver without counts in the window is not judged. */
export function handoverConditions(store: Store, service: string, locate: ReturnType<typeof locator>, now: Date): Observation[] {
  const model = store.flowModel(service)?.model;
  const topo = store.latestTopology(service)?.body as Topology | undefined;
  if (!model || !topo) return [];
  const to = new Date(Math.floor(now.getTime() / (5 * MIN)) * 5 * MIN - 5 * MIN).toISOString();
  const from = new Date(Date.parse(to) - HANDOVER_HOURS * HOUR).toISOString();
  const mine = store.flowCounts(service, from, to);
  const watched = new Set(watchedFlows(store, service).map((x) => x.id));
  const out: Observation[] = [];
  for (const s of model.segments) for (const e of s.exits) {
    if (e.channel.type !== "s2s" || !e.channel.service || !e.channel.port) continue;
    const target = e.channel.service;
    const f = s.role === "segment" && s.flow && watched.has(s.flow) ? store.flow(s.flow) : null;
    const place: Place | null = f && f.status !== "ignored" ?{ flow: f.id, service, segment: s.id, group: s.group.id, groupName: s.group.name } : null;
    const ttopo = store.latestTopology(target)?.body as Topology | undefined;
    if (!place || !ttopo) continue;
    const refs = new Set(topo.s2sOut.filter((o) => o.name === e.channel.port && o.group === s.group.id).map((o) => o.ref));
    const ids = new Set(ttopo.s2sIn.filter((p) => p.name === e.channel.port).map((p) => p.id));
    if (!refs.size || !ids.size) continue;
    const theirs = store.flowCounts(target, from, to).filter((r) => r.kind === "s2s-in" && ids.has(r.ref));
    const ours = mine.filter((r) => r.kind === "s2s-out" && refs.has(r.ref));
    if (!theirs.length || !ours.length) continue;
    // The registration gate's rule (register-gate.ts s2s-balance): only the 5-minute buckets both sides counted, and not
    // the first bucket of either side (its history may start in the middle of one: a node restarted, a port added).
    const bucketsOf = (rows: typeof ours, pick: (r: (typeof ours)[number]) => number) => {
      const m = new Map<number, number>();
      for (const r of rows) { const t = Date.parse(r.bucket); m.set(t, (m.get(t) ?? 0) + pick(r)); }
      return m;
    };
    const sentBy = bucketsOf(ours, (r) => r.flowfilesOut), gotBy = bucketsOf(theirs, (r) => Math.max(r.flowfilesIn, r.flowfilesOut)); // a remote input port's status counts what it received as out
    const first = Math.max(Math.min(...sentBy.keys()), Math.min(...gotBy.keys()));
    const common = [...gotBy.keys()].filter((t) => t > first && sentBy.has(t));
    if (!common.length) continue;
    const sent = common.reduce((n, t) => n + sentBy.get(t)!, 0), got = common.reduce((n, t) => n + gotBy.get(t)!, 0);
    const bound = Math.max(5, Math.ceil(0.02 * Math.max(sent, got)));
    if (sent - got > bound) out.push({ place, ref: `s2s:${target}:${e.channel.port}`, anomaly: "handover-lost", light: "failing", at: to, count: sent - got, detail: { segment: s.id, component: e.component, target, port: e.channel.port, sent, received: got, from, to } });
  }
  return out;
}

/** processing-failed through a shared error-handling group (A7 ③, a name like error / failure): data it received in the
 *  last QUIET_MINUTES counts for each business that links into it (several feeders: each of them, it cannot tell which).
 *  S39 §7.8 ⑦ (owner 2026-11-25): a registered shared module (a shared segment with a module id) is left out. What it
 *  receives is only the module's own health (moduleHealth); a business fails only in its own segments. */
export function errorGroupConditions(store: Store, service: string, locate: ReturnType<typeof locator>, now: Date): Observation[] {
  const model = store.flowModel(service)?.model;
  const topo = store.latestTopology(service)?.body as Topology | undefined;
  if (!model || !topo) return [];
  const errorGroups = model.segments.filter((s) => s.role === "shared" && !s.module && FAILURE_GROUP.test(s.group.name));
  if (!errorGroups.length) return [];
  const counts = store.flowCounts(service, new Date(now.getTime() - QUIET_MINUTES * MIN).toISOString(), now.toISOString());
  const out: Observation[] = [];
  for (const g of errorGroups) {
    const rows = counts.filter((r) => r.kind === "group" && r.ref === g.group.id && r.flowfilesIn > 0);
    if (!rows.length) continue;
    const n = rows.reduce((x, r) => x + r.flowfilesIn, 0), at = rows.map((r) => r.bucket).sort().at(-1)!;
    const feeders = new Map<string, Place>();
    for (const l of topo.links.filter((x) => x.to.group === g.group.id)) {
      const p = locate({ group: l.from.group });
      if (p) feeders.set(p.flow, p);
    }
    for (const p of feeders.values()) out.push({ place: p, ref: g.group.id, anomaly: "processing-failed", light: "attention", at, count: n, detail: { segment: p.segment, errorGroup: g.group.name, received: n, shared: feeders.size > 1 } });
  }
  return out;
}

/** Writes observations; for conditions (`replace`) the count is the current one and those of the same kinds not seen
 *  now close. Event anomalies quiet for QUIET_MINUTES close. */
export function record(store: Store, service: string, observations: Observation[], now: Date, conditions: { kinds: Anomaly[]; seen: Observation[] } | null = null) {
  for (const o of observations) store.noteFlowAnomaly({ flow: o.place.flow, service, ref: o.ref, anomaly: o.anomaly, light: o.light, at: o.at, count: o.count, detail: o.detail });
  const at = now.toISOString();
  if (conditions) {
    for (const o of conditions.seen) store.noteFlowAnomaly({ flow: o.place.flow, service, ref: o.ref, anomaly: o.anomaly, light: o.light, at: o.at, count: o.count, detail: o.detail, replace: true });
    const seen = new Set(conditions.seen.map((o) => `${o.place.flow}\0${o.ref}\0${o.anomaly}`));
    for (const a of store.flowAnomalies({ service, state: "open" })) {
      if ((conditions.kinds as readonly string[]).includes(a.anomaly) && !EVENT_KINDS.includes(a.anomaly) && !seen.has(`${a.flow}\0${a.ref}\0${a.anomaly}`)) store.closeFlowAnomaly(a.id, at);
    }
  }
  const quiet = new Date(now.getTime() - QUIET_MINUTES * MIN).toISOString();
  for (const a of store.flowAnomalies({ service, state: "open" })) if (EVENT_KINDS.includes(a.anomaly) && a.lastAt < quiet) store.closeFlowAnomaly(a.id, at);
  // A business that is gone, ignored or no longer has a segment here keeps nothing open here.
  const here = new Set(watchedFlows(store, service).filter((f) => f.status !== "ignored").map((f) => f.id));
  for (const a of store.flowAnomalies({ service, state: "open" })) if (!here.has(a.flow)) store.closeFlowAnomaly(a.id, at);
}

const BULLETINS_AT = "businessBulletinsAt";

/** Once a minute (with the machine checks): bulletins since the last round, the queues, the S2S hand-overs and the
 *  error groups. The provenance scan (BusinessScanner) runs on its own, every SCAN_MINUTES. */
export function businessCheck(store: Store, service: string, now: Date = new Date()) {
  if (!store.flowModel(service)) return;
  // S39 step 7: a registered group that changed on the canvas is a to-do for its owner (only with the registration switch on).
  if (registeredGroupsOn()) canvasChangeTodos(store, service);
  const locate = locator(store, service);
  const facts = store.serviceFacts(service);
  const from = facts.get(`*\0${BULLETINS_AT}`) ?? new Date(now.getTime() - SCAN_MINUTES * MIN).toISOString();
  const bulletins = store.serviceBulletins(service, { from, to: now.toISOString(), level: "ERROR", limit: 1000 });
  const readings = store.serviceBackpressures(service, new Date(now.getTime() - 2 * DAY).toISOString());
  const queues = queueConditions(store, locate, readings, now);
  const seen = [...queues.filter((o) => o.anomaly === "stuck"), ...handoverConditions(store, service, locate, now)];
  const events = [...classifyBulletins(locate, bulletins), ...queues.filter((o) => o.anomaly !== "stuck"), ...errorGroupConditions(store, service, locate, now)];
  store.flowTransaction(() => {
    // Queue- and count-based events are a current amount: replace, do not add up every minute.
    for (const o of events.filter((x) => x.anomaly !== "processor-error")) store.noteFlowAnomaly({ flow: o.place.flow, service, ref: o.ref, anomaly: o.anomaly, light: o.light, at: o.at, count: o.count, detail: o.detail, replace: true });
    record(store, service, events.filter((x) => x.anomaly === "processor-error"), now, { kinds: ["stuck", "handover-lost"], seen });
    // §7.8 ⑦: what a business had open for a registered module's group (counted before the rule) closes now, not after
    // QUIET_MINUTES: it is the module's, not the business's.
    const moduleGroups = new Set((store.flowModel(service)?.model.segments ?? []).filter((s) => s.role === "shared" && s.module).map((s) => s.group.id));
    if (moduleGroups.size) for (const a of store.flowAnomalies({ service, state: "open" })) if (a.detail.errorGroup !== undefined && moduleGroups.has(a.ref)) store.closeFlowAnomaly(a.id, now.toISOString());
    store.setServiceFact(service, "*", BULLETINS_AT, now.toISOString());
  });
}

export function businessCheckAll(store: Store, now: Date = new Date()) {
  for (const s of [...store.standalones(), ...store.clusters()]) {
    try { businessCheck(store, s.id, now); } catch (error) { console.error(`business check ${s.id}:`, error); }
  }
}

// ---- the provenance scan (data dropped, processing failed, invalid data) and e2e_trace's failures ---------------------

export interface ProvenanceReader { search(id: string, q: { field: string; value: string; from: string; to: string; maxResults: number }): Promise<Any> }
/** P3: e2e_trace's failure records in a time range (saved query e2e_failures), placed by the component when there is
 *  one, else by the worker: an imported schedule's step is that worker. */
export interface E2eFailures { failures(service: string, from: string, to: string): Promise<{ at: string; worker: string; component?: string; group?: string; text: string }[]> }
const SCAN_AT = "businessScanAt";
const SEARCHES = [["EventType", "DROP"], ["EventType", "EXPIRE"], ["Relationship", "failure"], ["Relationship", "invalid"]] as const;

export class BusinessScanner {
  private busy = new Set<string>();
  private store: Store;
  private provenance: ProvenanceReader;
  private e2e: E2eFailures | undefined;
  constructor(store: Store, provenance: ProvenanceReader, e2e?: E2eFailures) { this.store = store; this.provenance = provenance; this.e2e = e2e; }
  /** The e2e_trace source is made inside createApp, after the scanner. */
  useE2e(e2e: E2eFailures) { this.e2e = e2e; }

  /** One service: the window since its last scan (at most SCAN_BACK_MINUTES back). */
  async scan(service: string, now: Date = new Date()): Promise<{ observations: number; notes: string[] }> {
    const model = this.store.flowModel(service)?.model ?? null;
    if (!model || !watchedFlows(this.store, service).some((f) => f.status !== "ignored")) return { observations: 0, notes: ["no businesses"] };
    const last = this.store.serviceFacts(service).get(`*\0${SCAN_AT}`);
    const from = new Date(Math.max(now.getTime() - SCAN_BACK_MINUTES * MIN, last ? Date.parse(last) : now.getTime() - SCAN_MINUTES * MIN)).toISOString();
    const to = now.toISOString();
    if (from >= to) return { observations: 0, notes: [] };
    const locate = locator(this.store, service);
    const observations: Observation[] = [], notes: string[] = [];
    let ok = false;
    for (const [field, value] of SEARCHES) {
      try {
        const body = await this.provenance.search(service, { field, value, from, to, maxResults: 100 });
        ok = true;
        const got = classifyEvents(model, locate, (body.events ?? []) as Any[], body.limitReached === true);
        observations.push(...got.observations);
        if (body.limitReached) notes.push(`${field}=${value}: the first 100 of ${body.total ?? "more"} events only`);
      } catch (error) { notes.push(`${field}=${value}: ${(error as Error).message}`); }
    }
    if (this.e2e && this.store.traceSource(service, "e2e_trace")) {
      try {
        for (const f of await this.e2e.failures(service, from, to)) {
          const place = locate({ component: f.component ?? f.worker, group: f.group ?? null });
          if (place) observations.push({ place, ref: f.component ?? `worker:${f.worker}`, anomaly: "e2e-failed", light: "attention", at: f.at, count: 1, detail: { segment: place.segment, worker: f.worker, text: f.text.slice(0, 300) } });
        }
      } catch (error) { notes.push(`e2e_trace: ${(error as Error).message}`); }
    }
    this.store.flowTransaction(() => {
      record(this.store, service, observations, now);
      // Only a scan that read something moves the window (an offline executor's gap is read later, up to an hour).
      if (ok) this.store.setServiceFact(service, "*", SCAN_AT, to);
      this.store.setServiceFact(service, "*", "businessScan", JSON.stringify({ at: to, ok, notes: notes.slice(0, 10) }));
    });
    return { observations: observations.length, notes };
  }

  /** Every service with businesses, one at a time per service. */
  async tick(now: Date = new Date()) {
    for (const s of [...this.store.standalones(), ...this.store.clusters()]) {
      if (this.busy.has(s.id)) continue;
      this.busy.add(s.id);
      try { await this.scan(s.id, now); } catch (error) { console.error(`business scan ${s.id}:`, error); } finally { this.busy.delete(s.id); }
    }
  }
}

// ---- the lights -------------------------------------------------------------------------------------------------

export interface FlowLight { flow: FlowRecord; services: string[]; light: Light; reason?: UnknownReason; sentence: string; anomalies: (FlowAnomaly & { anomaly: Anomaly })[] }

const where = (a: FlowAnomaly) => String(a.detail.componentName ?? a.detail.destination ?? a.detail.errorGroup ?? a.detail.port ?? a.ref);
/** One anomaly in a sentence (fixed text is English, C2). */
export function anomalyText(a: FlowAnomaly): string {
  const d = a.detail;
  switch (a.anomaly) {
    case "data-dropped": return d.expired ? `Data expired in the queue before ${where(a)} (${a.count}${d.atLeast ? "+" : ""})` : `Data dropped at ${where(a)}${d.relationship ? ` (${d.relationship})` : ""} (${a.count}${d.atLeast ? "+" : ""})`;
    case "processing-failed": return d.errorGroup ? `${d.received} flowfiles went to the error group ${d.errorGroup}` : d.connection ? `${a.count} flowfiles wait in the failure queue of ${String(d.source ?? where(a))}` : `Routed to failure at ${where(a)} (${a.count})`;
    case "invalid-data": return d.connection ? `${a.count} flowfiles wait in the invalid queue of ${String(d.source ?? where(a))}` : `Invalid data at ${where(a)} (${a.count})`;
    case "stuck": return `${a.count} flowfiles have been waiting before ${String(d.destination ?? where(a))} for ${d.minutes} min`;
    case "handover-lost": return `S2S to ${d.target} port ${d.port}: ${d.sent} sent, ${d.received} received`;
    case "processor-error": return `Error bulletins from ${where(a)} (${a.count})`;
    case "e2e-failed": return `e2e_trace failure at ${String(d.worker ?? where(a))} (${a.count})`;
    case "other-drop": return `${where(a)}: ${String(d.details ?? "dropped")} × ${a.count}${d.atLeast ? "+" : ""}`;
  }
}

const REASON_TEXT: Record<UnknownReason, string> = {
  unconfirmed: "Not known: nobody has confirmed this business yet.",
  "gate-rejected": "Not known: the last model change failed the replay check.",
  "no-evidence": "Not known: no flow data has been collected yet.",
  collection: "Not known: collection from the service has stopped.",
};

/** Whether a service's collection is down (the machine's collection check open: unknown, nothing collected; or attention,
 *  NiFi's REST API not readable, so provenance and queues are not either). */
export const collectionDown = (store: Store, service: string) => store.serviceAlerts({ service, state: "open", limit: 50 }).some((a) => a.rule === "collection");

/** A business's light: gate rejected → unknown; else the worst open anomaly; else unknown when collection is down, no
 *  flow data exists or nobody confirmed it; else healthy. */
export function flowLight(store: Store, f: FlowRecord, ctx: { collection?: (s: string) => boolean; open?: FlowAnomaly[] } = {}): FlowLight {
  const services = [...new Set(store.flowSegments(f.id).map((s) => s.service))];
  const anomalies = (ctx.open?.filter((a) => a.flow === f.id) ?? store.flowAnomalies({ flow: f.id, state: "open" })).filter(isAnomaly);
  anomalies.sort((a, b) => LIGHT_ORDER[a.light] - LIGHT_ORDER[b.light] || (a.firstAt < b.firstAt ? -1 : 1));
  const unknown = (reason: UnknownReason): FlowLight => ({ flow: f, services, light: "unknown", reason, sentence: REASON_TEXT[reason], anomalies });
  if (gateRejected(store, f.id)) return unknown("gate-rejected");
  if (anomalies.length) {
    const light = anomalies.reduce<Light>((l, a) => worse(l, a.light), "healthy");
    const top = anomalies[0]!;
    return { flow: f, services, light, sentence: `${anomalyText(top)}${anomalies.length > 1 ? ` (+${anomalies.length - 1} more)` : ""}`, anomalies };
  }
  const down = ctx.collection ?? ((s: string) => collectionDown(store, s));
  if (services.some(down)) return unknown("collection");
  if (!services.some((s) => store.hasFlowCounts(s))) return unknown("no-evidence");
  if (f.status === "proposed") return unknown("unconfirmed");
  return { flow: f, services, light: "healthy", sentence: "No problems found.", anomalies };
}


const REASON_ORDER: UnknownReason[] = ["collection", "gate-rejected", "no-evidence", "unconfirmed"];

/** The business light of a service: the worst failing / attention of its businesses; else unknown when one it watches
 *  cannot be told (collection, gate, no data; by that order) or none is confirmed; else healthy. */
export function businessLight(store: Store, service: string): BusinessLightView {
  const rows = watchedFlows(store, service).filter((f) => f.status !== "ignored");
  const open =store.flowAnomalies({ state: "open", limit: 5000 });
  const down = new Map<string, boolean>();
  const collection = (s: string) => { if (!down.has(s)) down.set(s, collectionDown(store, s)); return down.get(s)!; };
  const lights = rows.map((f) => flowLight(store, f, { collection, open }));
  lights.sort((a, b) => LIGHT_ORDER[a.light] - LIGHT_ORDER[b.light] || (a.flow.name < b.flow.name ? -1 : 1));
  const flows: FlowRow[] = lights.map((l) => ({ id: l.flow.id, name: l.flow.name, status: l.flow.status, light: l.light, sentence: l.sentence, services: l.services, anomalies: [...new Set(l.anomalies.map((a) => a.anomaly))] }));
  const toConfirm = rows.filter((f) => f.status === "proposed" || f.status === "gone" || f.pendings.length).length;
  const confirmed = rows.map((f) => f.confirmedAt).filter((x): x is string => !!x).sort().at(-1);
  const base = { flows, toConfirm, ...(confirmed ? { confirmedAt: confirmed } : {}) };
  // What waits for a person does not light the lamp; the sentence says so, so the lamp and the list do not seem to disagree.
  const also = (s: string) => (toConfirm > 0 ? `${s.replace(/\.?$/, ".")} ${toConfirm} more ${toConfirm === 1 ? "flow waits" : "flows wait"} for you to confirm (not counted in the light).` : s);
  const bad = lights.filter((l) => l.light === "failing" || l.light === "attention");
  if (bad.length) {
    const light = bad[0]!.light;
    const n = bad.filter((l) => l.light === light).length;
    return { light, sentence: also(`${light === "failing" ? "Failing" : "Needs attention"}: ${bad[0]!.flow.name}: ${bad[0]!.sentence}${n > 1 ? ` (+${n - 1} more)` : ""}`), ...base };
  }
  if (!rows.length) return { light: "unknown", reason: "no-evidence", sentence: "Not known: no business has been found yet.", ...base };
  const watched = lights.filter((l) => l.flow.status !== "proposed");
  for (const reason of REASON_ORDER.slice(0, 3)) {
    const l = watched.find((x) => x.reason === reason);
    if (l) return { light: "unknown", reason, sentence: also(`${REASON_TEXT[reason]} (${l.flow.name})`), ...base };
  }
  if (!watched.length) return { light: "unknown", reason: "unconfirmed", sentence: `Not known: ${rows.length} business${rows.length > 1 ? "es" : ""} found, none confirmed yet.`, ...base };
  return { light: "healthy", sentence: also(watched.length === 1 ? "The confirmed business runs without problems." : `All ${watched.length} confirmed businesses run without problems.`), ...base };
}
