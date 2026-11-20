// S37 step 6 (§4.2.0 layer 1, T3/T4, S33): NiFi provenance as an evidence source, one adapter for every NiFi
// version. It asks the service's NiFi through ServiceProvenance (a nifi-provenance job on a member's service
// executor; the executor handles the <1.14 search-term form, the zone names and the cluster as a whole) and turns
// provenance events into observed events:
//   by key       a FlowFile uuid ("flowfile"), the file name ("filename") or any indexed attribute, narrowed to the
//                step's position (componentId; a process group by groupId) and the time range;
//   by position  the component's events (ProcessorID), or the file name at it (the S2S "same name" fall-back);
//   hand-over    S2S: the receiver's RECEIVE whose sourceSystemFlowFileId is "urn:nifi:<the sender's uuid>"
//                (checked on the lab, 1.12.1 → 2.5.0), in the engine's window.
// Lineage is followed through the events themselves: FORK/CLONE name their children, JOIN is found under its
// parents' uuid and names the child as its FlowFile. A step that finds nothing asks how far back each node's
// provenance goes (T4: max.storage.size can age events out before the configured time): a range that starts before
// the newest of the nodes' oldest events is "expired", not "nothing there".

import { LogsError } from "../logs.ts";
import type { ProvenanceSearch, ServiceProvenance } from "../provenance.ts";
import type { AdapterAnswer, Capabilities, CorrelationKey, EventState, EvidenceAdapter, HandoverQuery, KeyQuery, ObservedEvent, Position, PositionQuery } from "./events.ts";

export const PROVENANCE_SOURCE = "provenance";
type Any = Record<string, any>;
/** A search answer is reused within a trace for this long (every step asks for the same FlowFile). */
const CACHE_MS = 20_000;
const OLDEST_MS = 5 * 60_000;
const CACHE_MAX = 200;
const NONE: Capabilities = { byKey: [], byPosition: false, handover: [] };

interface Raw { events: Any[]; limitReached: boolean; errors: string[]; oldest: string | null }
type Got = { raw: Raw } | { missing: NonNullable<AdapterAnswer["missing"]> };

/** What a provenance event says happened (the observed event's state). */
export function stateOf(e: Any): EventState {
  switch (e.eventType) {
    case "RECEIVE": case "FETCH": return "received";
    case "SEND": case "UPLOAD": return "sent";
    case "DROP": return /failure/i.test(String(e.details ?? "")) ? "failure" : "dropped";
    case "EXPIRE": return "failure";
    default: return e.relationship === "failure" ? "failure" : "end";
  }
}

const kindOf = (t: unknown): Position["kind"] => (/input port/i.test(String(t)) ? "input-port" : /output port/i.test(String(t)) ? "output-port" : "processor");
// S37 step 7: an e2e_trace worker (a step imported from schedule_detail) has no component id; its events are the
// components named after the worker (id = worker name, name = its message name).
const at = (p: Position) => (e: Any) => (p.kind === "process-group" ? e.groupId === p.id
  : p.kind === "worker" ? e.componentName === p.id || (p.name !== undefined && e.componentName === p.name)
  : e.componentId === p.id);
/** The FlowFile id a RECEIVE names as its source ("urn:nifi:<uuid>" over S2S). */
export const sourceId = (e: Any) => String(e.sourceSystemFlowFileId ?? "").replace(/^urn:nifi:/, "") || null;

export function toEvent(service: string, e: Any, searched?: string): ObservedEvent {
  const attrs: Record<string, string> = { ...(e.attributes && typeof e.attributes === "object" ? e.attributes : {}) };
  const state = stateOf(e);
  if (state === "failure" && e.details && attrs.error === undefined) attrs.error = String(e.details);
  const own = searched ?? e.flowFileUuid;
  const children = [...new Set([...(Array.isArray(e.childUuids) ? e.childUuids : []), ...(e.flowFileUuid !== own ? [e.flowFileUuid] : [])])]
    .filter((u) => typeof u === "string" && u !== own).map((value): CorrelationKey => ({ name: "flowfile", value }));
  return {
    source: PROVENANCE_SOURCE, service, key: { name: "flowfile", value: own },
    position: { kind: kindOf(e.componentType), id: String(e.componentId ?? ""), ...(e.componentName ? { name: String(e.componentName) } : {}) },
    at: e.at, state, attrs, ...(children.length ? { children } : {}),
    ref: { ...(e.clusterNodeId ? { node: String(e.clusterNodeId) } : {}), ...(e.eventId !== undefined ? { eventId: e.eventId } : {}) },
  };
}

export class ProvenanceAdapter implements EvidenceAdapter {
  readonly id = PROVENANCE_SOURCE;
  private prov: ServiceProvenance;
  private now: () => number;
  private cache = new Map<string, { at: number; from: string; to: string; got: Promise<Got> }>();
  private oldestSeen = new Map<string, { at: number; got: Promise<{ node: string | null; address?: string; oldest: string | null }[] | null> }>();

  constructor(prov: ServiceProvenance, now: () => number = Date.now) { this.prov = prov; this.now = now; }

  /** Every NiFi service has provenance (T9); whether it can be read now is the answer's business (missing). */
  capabilities(service: string): Capabilities {
    try { this.prov.info(service); } catch { return NONE; }
    return { byKey: "*", byPosition: true, handover: ["s2s"] };
  }

  /** One search, shared by the steps of a trace for a little while. */
  private search(service: string, field: string, value: string, from: string, to: string): Promise<Got> {
    const k = `${service}|${field}|${value}`;
    const hit = this.cache.get(k);
    // The engine's ranges end "now", a little later each step: an answer covers them while it is fresh.
    if (hit && this.now() - hit.at < CACHE_MS && hit.from <= from && Date.parse(hit.to) >= Date.parse(to) - CACHE_MS) return hit.got;
    const q: ProvenanceSearch = { from, to, maxResults: 100, attributes: true, ...(field === "FlowFileUUID" ? { uuid: value } : { field, value }) };
    const got = this.prov.search(service, q).then((b): Got => ({
      raw: { events: (b.events ?? []) as Any[], limitReached: Boolean(b.limitReached), errors: (b.errors ?? []) as string[], oldest: typeof b.oldest === "string" ? b.oldest : null },
    }), (error: unknown): Got => ({ missing: failure(service, error) }));
    if (this.cache.size >= CACHE_MAX) for (const [key, v] of this.cache) if (this.now() - v.at >= CACHE_MS) this.cache.delete(key);
    this.cache.set(k, { at: this.now(), from, to, got });
    return got;
  }

  /** The events of a search that fall in the range and the position, as observed events; an empty answer says why. */
  private async answer(service: string, got: Got, from: string, to: string, keep: (e: Any) => boolean, searched?: string): Promise<AdapterAnswer> {
    if ("missing" in got) return { events: [], missing: got.missing };
    const { raw } = got;
    const events = raw.events.filter((e) => typeof e.at === "string" && e.at >= from && e.at <= to && keep(e)).map((e) => toEvent(service, e, searched));
    if (events.length) return { events };
    if (raw.errors.length) return { events: [], missing: { reason: "error", message: `NiFi's provenance query of ${service} reported: ${raw.errors.slice(0, 3).join("; ")}` } };
    if (raw.limitReached) return { events: [], missing: { reason: "error", message: `The provenance search of ${service} hit its limit of 100 events before reaching this step's: narrow the time range.` } };
    return this.expired(service, from, raw.oldest);
  }

  /** T4: nothing found — expired when the range starts before what some node still holds. */
  private async expired(service: string, from: string, merged: string | null): Promise<AdapterAnswer> {
    let hit = this.oldestSeen.get(service);
    if (!hit || this.now() - hit.at > OLDEST_MS) {
      hit = { at: this.now(), got: this.prov.oldest(service).catch(() => null) };
      this.oldestSeen.set(service, hit);
    }
    const nodes = (await hit.got) ?? (merged ? [{ node: null, oldest: merged }] : []);
    const late = nodes.filter((n) => n.oldest).sort((a, b) => (a.oldest! < b.oldest! ? 1 : -1))[0];
    if (late && from < late.oldest!)
      return { events: [], missing: { reason: "expired", earliest: late.oldest!, message: `Provenance of ${service}${late.address ? ` on ${late.address}` : ""} holds events from ${late.oldest} on; the time range starts at ${from}, so the evidence may be gone.` } };
    return { events: [] };
  }

  private fieldOf(key: CorrelationKey): { field: string; value: string } {
    if (key.name === "flowfile") return { field: "FlowFileUUID", value: key.value.toLowerCase() };
    if (key.name.toLowerCase() === "filename") return { field: "Filename", value: key.value };
    return { field: key.name, value: key.value };
  }

  async byKey(q: KeyQuery): Promise<AdapterAnswer> {
    const { field, value } = this.fieldOf(q.key);
    const got = await this.search(q.service, field, value, q.from, q.to);
    const here = q.position ? at(q.position) : () => true;
    // The search matches loosely (Lucene); keep the events whose value is the one asked, where attributes are shown.
    const same = (e: Any) => field === "FlowFileUUID" || !e.attributes || e.attributes[field === "Filename" ? "filename" : field] === value;
    return this.answer(q.service, got, q.from, q.to, (e) => here(e) && same(e), field === "FlowFileUUID" ? value : undefined);
  }

  async byPosition(q: PositionQuery): Promise<AdapterAnswer> {
    if (q.where) return this.byKey({ service: q.service, key: q.where, from: q.from, to: q.to, position: q.position });
    if (q.position.kind === "process-group") return { events: [], missing: { reason: "error", message: "Provenance cannot list a process group's events; bind the step to a processor or port." } };
    const got = await this.search(q.service, "ProcessorID", q.position.id, q.from, q.to);
    return this.answer(q.service, got, q.from, q.to, at(q.position));
  }

  /** T3: the S2S receiver's RECEIVE at its input port whose source FlowFile id is the sender's uuid. */
  async handover(q: HandoverQuery): Promise<AdapterAnswer> {
    if (q.channel !== "s2s") return { events: [] };
    const sent = q.sent.key.value.toLowerCase();
    const got = await this.search(q.service, "ProcessorID", q.position.id, q.from, q.to);
    return this.answer(q.service, got, q.from, q.to, (e) => at(q.position)(e) && e.eventType === "RECEIVE" && sourceId(e)?.toLowerCase() === sent);
  }
}

/** Why provenance could not be read, as an answer's missing part. */
function failure(service: string, error: unknown): NonNullable<AdapterAnswer["missing"]> {
  const message = (error as Error)?.message ?? String(error);
  // S37 step 9: a key this NiFi does not index (e.g. e2e_trace's file_name) is not a gap in the evidence: the engine skips
  // this source quietly and says so only when no source could be asked.
  if (/is not searchable on this NiFi/.test(message)) return { reason: "incapable", message: `Provenance of ${service}: ${message}` };
  if (error instanceof LogsError && (error.status === 409 || error.code === "provenance/timeout" || error.code === "provenance/busy"))
    return { reason: "unavailable", message: `Provenance of ${service} cannot be read now: ${message}` };
  return { reason: "error", message: `Provenance of ${service}: ${message}` };
}
