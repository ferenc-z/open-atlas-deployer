// S37 step 5 (pages-rethink §4.2.0 layer 2, T1/T2/T7): the business process model, data not code. Each service
// defines only its own segment (T1): its businesses, each with match rules, ordered steps bound to a position, entry
// and exit endpoints that name only their own side's channel (T2), and on an entry the cue mapping (T7: which field a
// business clue such as a file name is searched by). Segments are joined by equal channels (channels.ts), never by
// referring to each other; the end-to-end view is put together by the engine and is read-only.

import { POSITION_KINDS, type ChannelType, type Position } from "./events.ts";

/** A match rule on an event's attributes; a business's rules all have to hold (none: everything matches). */
export interface Condition { attr: string; op: "equals" | "prefix" | "regex" | "exists"; value?: string }
export const CONDITION_OPS = ["equals", "prefix", "regex", "exists"] as const;

/** The channel an endpoint names (T2): S2S by the receiving service and its input port's name; MQ by exchange and
 *  routing key; external by a system name (a mailbox, an SFTP directory, a downstream system). An S2S entry is the
 *  model's own service, so it names only the port. */
export interface Channel { type: ChannelType; service?: string; port?: string; exchange?: string; routingKey?: string; system?: string }
export const CHANNEL_TYPES: readonly ChannelType[] = ["s2s", "mq", "external"];

/** The business clues the trace takes (§4.2: fileName, emailFrom, emailSubject). */
export type Cue = "fileName" | "emailFrom" | "emailSubject";
export const CUES: readonly Cue[] = ["fileName", "emailFrom", "emailSubject"];
/** T7: on an entry, which correlation key name a clue is searched by (fileName → "filename", emailSubject → "email_subject"). */
export interface CueMapping { cue: Cue; key: string }

export interface Endpoint {
  id: string;
  /** The step it is attached to: an entry's data appears there, an exit's leaves from there. */
  step: string;
  channel: Channel;
  /** Which attribute carries the correlation key over this channel (MQ default "correlation_id"); overrides the rule's default. */
  keyAttribute?: string;
  /** Entry only (T7). */
  cues?: CueMapping[];
  /** Exit only: a split condition (one exit to several entries, T2). */
  when?: Condition[];
}

export interface Step {
  id: string;
  name: string;
  position: Position;
  /** How long data may stay in this step (or wait before the next) before it counts as stuck; default 900 s. */
  maxSeconds?: number;
}

export interface Business { id: string; name: string; match: Condition[]; steps: Step[]; entries: Endpoint[]; exits: Endpoint[] }

export interface TraceModel {
  service: string;
  /** Evidence sources this service is traced with, in order of preference (adapter ids, e.g. "e2e_trace", "provenance"). */
  sources: string[];
  businesses: Business[];
}
export interface StoredTraceModel { model: TraceModel; revision: number; savedAt: string; savedBy: string }

export const DEFAULT_MAX_SECONDS = 900;
const ID = /^[A-Za-z0-9_.-]{1,64}$/;
const NAME_MAX = 200;
const LIMITS = { businesses: 50, steps: 50, endpoints: 20, conditions: 20 };

type Any = Record<string, any>;
const text = (v: unknown, max = NAME_MAX) => typeof v === "string" && v.trim() !== "" && v.length <= max;

/** Checks a model from the page or an API key; every problem is listed (paths like businesses[0].steps[1].position). */
export function parseModel(service: string, body: unknown): { model: TraceModel } | { errors: string[] } {
  const errors: string[] = [];
  const b = (body && typeof body === "object" ? body : {}) as Any;
  const sources = Array.isArray(b.sources) ? b.sources : [];
  if (b.sources !== undefined && !Array.isArray(b.sources)) errors.push("sources is a list of evidence source ids.");
  for (const [i, s] of sources.entries()) if (typeof s !== "string" || !ID.test(s)) errors.push(`sources[${i}] is an evidence source id.`);
  if (new Set(sources).size !== sources.length) errors.push("sources has an id twice.");
  const list = Array.isArray(b.businesses) ? b.businesses : [];
  if (!Array.isArray(b.businesses)) errors.push("businesses is a list.");
  if (list.length > LIMITS.businesses) errors.push(`At most ${LIMITS.businesses} businesses.`);
  const ids = new Set<string>();
  const businesses = list.map((x: unknown, i: number) => business(x, `businesses[${i}]`, errors));
  for (const [i, x] of businesses.entries()) {
    if (ids.has(x.id)) errors.push(`businesses[${i}].id ${x.id} is used twice.`);
    ids.add(x.id);
  }
  return errors.length ? { errors } : { model: { service, sources, businesses } };
}

function conditions(v: unknown, at: string, errors: string[]): Condition[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > LIMITS.conditions) { errors.push(`${at} is a list of at most ${LIMITS.conditions} conditions.`); return []; }
  return v.map((c: Any, i) => {
    const p = `${at}[${i}]`;
    if (!text(c?.attr, 128)) errors.push(`${p}.attr is an attribute name.`);
    if (!CONDITION_OPS.includes(c?.op)) errors.push(`${p}.op is one of ${CONDITION_OPS.join(", ")}.`);
    if (c?.op !== "exists" && typeof c?.value !== "string") errors.push(`${p}.value is required for ${c?.op}.`);
    if (c?.op === "regex" && typeof c?.value === "string") { try { new RegExp(c.value); } catch { errors.push(`${p}.value is not a valid regular expression.`); } }
    return { attr: String(c?.attr ?? "").trim(), op: c?.op, ...(c?.op !== "exists" ? { value: String(c?.value ?? "") } : {}) };
  });
}

function position(v: unknown, at: string, errors: string[]): Position {
  const p = (v ?? {}) as Any;
  if (!POSITION_KINDS.includes(p.kind)) errors.push(`${at}.kind is one of ${POSITION_KINDS.join(", ")}.`);
  if (!text(p.id, 128)) errors.push(`${at}.id is the component's id (or the worker's name).`);
  return { kind: p.kind, id: String(p.id ?? "").trim(), ...(text(p.name) ? { name: p.name.trim() } : {}) };
}

function channel(v: unknown, at: string, side: "entry" | "exit", errors: string[]): Channel {
  const c = (v ?? {}) as Any;
  if (!CHANNEL_TYPES.includes(c.type)) { errors.push(`${at}.type is one of ${CHANNEL_TYPES.join(", ")}.`); return { type: c.type }; }
  const need = (k: string, what: string) => { if (!text(c[k])) errors.push(`${at}.${k} is required: ${what}.`); return String(c[k] ?? "").trim(); };
  if (c.type === "s2s") return side === "exit" ? { type: "s2s", service: need("service", "the receiving service"), port: need("port", "its input port's name") } : { type: "s2s", port: need("port", "this service's input port name") };
  if (c.type === "mq") return { type: "mq", exchange: need("exchange", "the exchange"), routingKey: need("routingKey", "the routing key") };
  return { type: "external", system: need("system", "the outside system (a mailbox, a directory, a downstream system)") };
}

function endpoints(v: unknown, at: string, side: "entry" | "exit", steps: Set<string>, errors: string[]): Endpoint[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > LIMITS.endpoints) { errors.push(`${at} is a list of at most ${LIMITS.endpoints}.`); return []; }
  const seen = new Set<string>();
  return v.map((e: Any, i) => {
    const p = `${at}[${i}]`;
    if (typeof e?.id !== "string" || !ID.test(e.id)) errors.push(`${p}.id is letters, digits, . _ - (at most 64).`);
    else if (seen.has(e.id)) errors.push(`${p}.id ${e.id} is used twice.`);
    seen.add(e?.id);
    if (!steps.has(e?.step)) errors.push(`${p}.step names one of this business's steps.`);
    const out: Endpoint = { id: e?.id, step: e?.step, channel: channel(e?.channel, `${p}.channel`, side, errors) };
    if (e?.keyAttribute !== undefined && e.keyAttribute !== "") { if (!text(e.keyAttribute, 128)) errors.push(`${p}.keyAttribute is an attribute name.`); else out.keyAttribute = e.keyAttribute.trim(); }
    if (side === "entry" && e?.cues !== undefined) {
      if (!Array.isArray(e.cues)) errors.push(`${p}.cues is a list.`);
      else out.cues = e.cues.map((m: Any, j: number) => {
        if (!CUES.includes(m?.cue)) errors.push(`${p}.cues[${j}].cue is one of ${CUES.join(", ")}.`);
        if (!text(m?.key, 128)) errors.push(`${p}.cues[${j}].key is the field the clue is searched by.`);
        return { cue: m?.cue, key: String(m?.key ?? "").trim() };
      });
    }
    if (side === "exit" && e?.when !== undefined) out.when = conditions(e.when, `${p}.when`, errors);
    return out;
  });
}

function business(v: unknown, at: string, errors: string[]): Business {
  const b = (v ?? {}) as Any;
  if (typeof b.id !== "string" || !ID.test(b.id)) errors.push(`${at}.id is letters, digits, . _ - (at most 64).`);
  if (!text(b.name)) errors.push(`${at}.name is required.`);
  const raw = Array.isArray(b.steps) ? b.steps : [];
  if (!raw.length || raw.length > LIMITS.steps) errors.push(`${at}.steps is a list of 1 to ${LIMITS.steps} steps.`);
  const stepIds = new Set<string>();
  const steps: Step[] = raw.map((s: Any, i: number) => {
    const p = `${at}.steps[${i}]`;
    if (typeof s?.id !== "string" || !ID.test(s.id)) errors.push(`${p}.id is letters, digits, . _ - (at most 64).`);
    else if (stepIds.has(s.id)) errors.push(`${p}.id ${s.id} is used twice.`);
    stepIds.add(s?.id);
    if (!text(s?.name)) errors.push(`${p}.name is required.`);
    const out: Step = { id: s?.id, name: String(s?.name ?? "").trim(), position: position(s?.position, `${p}.position`, errors) };
    if (s?.maxSeconds !== undefined && s.maxSeconds !== null) {
      if (!(Number.isInteger(s.maxSeconds) && s.maxSeconds >= 1 && s.maxSeconds <= 30 * 86400)) errors.push(`${p}.maxSeconds is 1 s to 30 days.`);
      else out.maxSeconds = s.maxSeconds;
    }
    return out;
  });
  const entries = endpoints(b.entries, `${at}.entries`, "entry", stepIds, errors);
  const exits = endpoints(b.exits, `${at}.exits`, "exit", stepIds, errors);
  if (!entries.length) errors.push(`${at}.entries: a business needs at least one entry (where its data comes in).`);
  return { id: b.id, name: String(b.name ?? "").trim(), match: conditions(b.match, `${at}.match`, errors), steps, entries, exits };
}

/** Whether attributes pass a list of conditions (all of them). */
export function matches(conds: Condition[] | undefined, attrs: Record<string, string>): boolean {
  for (const c of conds ?? []) {
    const v = attrs[c.attr];
    if (c.op === "exists") { if (v === undefined) return false; continue; }
    if (v === undefined) return false;
    if (c.op === "equals" && v !== c.value) return false;
    if (c.op === "prefix" && !v.startsWith(c.value ?? "")) return false;
    if (c.op === "regex" && !new RegExp(c.value ?? "").test(v)) return false;
  }
  return true;
}

export const emptyModel = (service: string): TraceModel => ({ service, sources: [], businesses: [] });
