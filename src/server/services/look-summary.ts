// pages-rethink §10.1 ⑰ (saving tokens): what describe and look give the AI by default is a summary — counts, groups,
// the top rows, a truncation mark and which argument gives the rest — and the whole answer only with detail "full" (or
// one part of it: topology's group, provenance / bulletins / logs' offset). A summary never leaves out what the gate or
// the identification needs without saying how to get it: the skeleton's questions stay whole, every unit and link is
// listed (by name, without the fragment bodies), every provenance event keeps its uuid and event id. Pure functions over
// the routes' bodies; mcp.ts calls them in look's and describe's shapes, and the check-up brief reuses the topology one.

import { topologyFingerprint, type Topology, type TopologyGroup } from "./flowcounts.ts";
import { draftLines } from "./model-changes.ts";

type Any = Record<string, any>;

/** OMA (agent harness, INLINE_RESULT_BYTES) keeps a tool result in the conversation only up to 16 KiB of its model
 *  text — the MCP content list as JSON, our JSON text escaped once more inside it; a bigger one becomes a reference the
 *  agent reads back 2 KB a turn. Every default answer stays under INLINE_BUDGET of that measure. */
export const OMA_INLINE_BYTES = 16 * 1024;
export const INLINE_BUDGET = 15 * 1024;
export const inlineBytes = (value: unknown) => Buffer.byteLength(JSON.stringify([{ type: "text", text: JSON.stringify(value) }]));

/** A default answer still over the budget: strings and lists cut harder until it fits, with a mark saying so. */
export function fitInline(value: unknown, budget = INLINE_BUDGET): unknown {
  if (inlineBytes(value) <= budget) return value;
  for (const [str, arr] of [[200, 15], [120, 10], [80, 6], [60, 4], [40, 2]] as const) {
    const cut = compactDeep(value, str, arr);
    const marked = cut && typeof cut === "object" && !Array.isArray(cut)
      ? { ...(cut as Any), cut: `Cut to stay inline (texts at ${str} characters, lists at ${arr} items): ask a narrower part (service, group, offset, a shorter from–to) rather than detail "full".` }
      : cut;
    if (inlineBytes(marked) <= budget) return marked;
  }
  return { cut: "Too big to give inline even cut down: ask a narrower part (service, group, offset, a shorter from–to)." };
}

/** At most n characters, with a mark of how much was cut. */
export function clip(v: unknown, n: number): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.length <= n ? s : `${s.slice(0, n)}…(+${s.length - n} chars)`;
}

/** Every string at most `str` characters, every array at most `arr` items (the rest counted), recursively. */
export function compactDeep(v: unknown, str = 240, arr = 12): unknown {
  if (typeof v === "string") return clip(v, str);
  if (Array.isArray(v)) {
    const head = v.slice(0, arr).map((x) => compactDeep(x, str, arr));
    return v.length > arr ? [...head, `…(+${v.length - arr} more)`] : head;
  }
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, compactDeep(x, str, arr)]));
  return v;
}

export const FULL_HINT = 'detail: "full" gives the whole answer';
const full = (a: Record<string, unknown>) => a.detail === "full";
const offsetOf = (a: Record<string, unknown>) => (Number.isInteger(a.offset) && (a.offset as number) > 0 ? (a.offset as number) : 0);
/** One page of rows: offset, at most `size`, and what is left. */
function page<T>(rows: T[], a: Record<string, unknown>, size: number) {
  const from = offsetOf(a);
  const shown = rows.slice(from, from + size);
  const rest = rows.length - from - shown.length;
  return { shown, from, rest: Math.max(0, rest) };
}
/** Top n of a count map, biggest first. */
function top<K extends string>(m: Map<K, number>, n: number): { key: K; count: number }[] {
  return [...m.entries()].sort((x, y) => y[1] - x[1] || String(x[0]).localeCompare(String(y[0]))).slice(0, n).map(([key, count]) => ({ key, count }));
}
const bump = <K>(m: Map<K, number>, k: K, by = 1) => m.set(k, (m.get(k) ?? 0) + by);
/** A message with its variable parts (numbers, ids, quoted values) taken out, to group repeats. */
export function pattern(text: unknown): string {
  return String(text ?? "")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\b\d[\d.:,_-]*\b/g, "#")
    .replace(/\[[^\]]{0,200}\]/g, "[…]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

// ---- topology ------------------------------------------------------------------------------------------------------

/** One unit (group under root, or root's own components) in a line: its pieces' processor counts and ports, no names. */
function unitLine(g: TopologyGroup, t: Topology) {
  const frags = g.fragments ?? [];
  const ends = (t.ends ?? []).filter((e) => e.group === g.id).length;
  return {
    id: g.id, name: g.name, ...(g.root ? { root: true } : {}),
    pieces: frags.length, processors: frags.reduce((x, f) => x + (f.processors ?? 0), 0),
    ...(frags.some((f) => f.inputs?.length) ? { inputs: [...new Set(frags.flatMap((f) => f.inputs ?? []))] } : {}),
    ...(frags.some((f) => f.outputs?.length) ? { outputs: [...new Set(frags.flatMap((f) => f.outputs ?? []))] } : {}),
    ...(frags.some((f) => f.remoteIn?.length) ? { s2sIn: frags.reduce((x, f) => x + (f.remoteIn?.length ?? 0), 0) } : {}),
    ...(frags.some((f) => f.s2sOut?.length) ? { s2sOut: frags.reduce((x, f) => x + (f.s2sOut?.length ?? 0), 0) } : {}),
    ...(ends ? { ends } : {}),
  };
}

/** The canvas in counts and one line per unit and link; the skeleton's questions whole (identification needs them). */
export function topologySummary(t: Topology | null, skeleton: Any | null, takenAt: string | null) {
  if (!t) return { takenAt, topology: null, skeleton: skeleton ?? null };
  const name = new Map(t.groups.map((g) => [g.id, g.name]));
  const end = (e: { group: string; port: string | null }) => `${name.get(e.group) ?? e.group}${e.port ? `:${e.port}` : ""}`;
  return {
    takenAt, fingerprint: topologyFingerprint(t),
    counts: { units: t.groups.length, links: t.links.length, s2sIn: t.s2sIn.length, s2sOut: t.s2sOut.length, ends: (t.ends ?? []).length, nested: Object.keys(t.nested ?? {}).length },
    units: t.groups.map((g) => unitLine(g, t)),
    links: t.links.map((l) => `${end(l.from)} → ${end(l.to)}`),
    s2sIn: t.s2sIn.map((p) => `${p.name} @ ${name.get(p.group) ?? p.group}`),
    s2sOut: t.s2sOut.map((o) => ({ port: o.name, from: name.get(o.group) ?? o.group, targets: o.targets, feeders: (o.sources ?? []).map((x) => x.name) })),
    ...(skeleton ? { skeleton: skeletonSummary(skeleton) } : {}),
    more: `${FULL_HINT}; group: <id> gives one unit whole (its pieces' processor names, ports, links, S2S, ends with component ids).`,
  };
}

/** The skeleton in lines: each proposed business by its units, the shared and empty units, the questions whole. */
export function skeletonSummary(sk: Any) {
  const unit = (u: Any) => `${u.group?.name ?? u.group?.id}${u.fragment ? `#${String(u.fragment).slice(0, 8)}` : ""}${u.traffic && u.traffic !== "yes" ? ` (${u.traffic})` : ""}`;
  return {
    flows: (sk.flows ?? []).map((f: Any) => ({ key: f.key, units: (f.segments ?? []).map(unit), ...(f.exceptions?.length ? { exceptions: f.exceptions } : {}), ...(f.reason ? { reason: f.reason } : {}) })),
    shared: (sk.shared ?? []).map((s: Any) => ({ unit: unit(s), feeders: (s.feeders ?? []).length })),
    empty: (sk.empty ?? []).map((e: Any) => e.group?.name ?? e.group?.id),
    questions: sk.questions ?? [],
  };
}

/** One unit whole: the group, the links touching it, its S2S, ends, nested groups and pieces, its skeleton parts. */
export function topologyGroup(t: Topology | null, skeleton: Any | null, group: string) {
  if (!t) return { group, found: false };
  const g = t.groups.find((x) => x.id === group || x.name === group);
  if (!g) return { group, found: false, units: t.groups.map((x) => ({ id: x.id, name: x.name })) };
  const mine = (x: { group: string }) => x.group === g.id;
  const ids = new Set(g.fragments.map((f) => f.key));
  return {
    found: true, unit: g,
    links: t.links.filter((l) => l.from.group === g.id || l.to.group === g.id),
    s2sIn: t.s2sIn.filter(mine), s2sOut: t.s2sOut.filter(mine), ends: (t.ends ?? []).filter(mine),
    nested: Object.fromEntries(Object.entries(t.nested ?? {}).filter(([, u]) => u === g.id)),
    split: Object.fromEntries(Object.entries(t.split ?? {}).filter(([, f]) => ids.has(f))),
    ...(skeleton ? {
      skeleton: {
        flows: (skeleton.flows ?? []).filter((f: Any) => (f.segments ?? []).some((s: Any) => s.group?.id === g.id)),
        shared: (skeleton.shared ?? []).filter((s: Any) => s.group?.id === g.id),
        questions: (skeleton.questions ?? []).filter((q: Any) => q.group === g.id),
      },
    } : {}),
  };
}

/** look kind topology: the summary, one unit, or the whole body. */
export function topologyShape(body: Any, a: Record<string, unknown>) {
  if (full(a)) return body;
  const t = (body?.topology ?? null) as Topology | null;
  if (typeof a.group === "string" && a.group) return { takenAt: body?.takenAt ?? null, ...topologyGroup(t, body?.skeleton ?? null, a.group) };
  return topologySummary(t, body?.skeleton ?? null, body?.takenAt ?? null);
}

// ---- model ---------------------------------------------------------------------------------------------------------

const segLine = (s: Any) => ({ id: s.id, flow: s.flow ?? null, group: s.group?.name ?? s.group?.id, slice: s.slice, role: s.role });

/** look kind model: the skeleton's draft and the current model in a line per segment (ids, business keys, entries and
 *  exits with their components: what changes name). run_model / publish_model take {from, changes}, so the whole draft
 *  is needed only to write a model whole (detail "full"). */
export function modelShape(body: Any, a: Record<string, unknown>) {
  if (full(a)) return body;
  const cur = body?.current;
  const curIds = new Set(((cur?.model?.segments ?? []) as Any[]).map((s) => s.id));
  const draft = body?.draft ? draftLines(body.draft) : null;
  return {
    base: body?.base ?? 0,
    current: cur ? { revision: cur.revision, publishedAt: cur.publishedAt, publishedBy: cur.publishedBy, source: cur.source, sources: cur.model?.sources ?? [], segments: ((cur.model?.segments ?? []) as Any[]).map(segLine) } : null,
    draft: draft ? { ...draft, lines: draft.lines.map((l) => (curIds.has(l.id) ? l : { ...l, new: true })) } : null,
    flows: body?.flows ?? [], e2e: body?.e2e ?? null,
    more: `run_model / publish_model take {from: "current", changes}: name segments, entries and exits by these ids. ${FULL_HINT} (the whole draft and current model).`,
  };
}

// ---- provenance ----------------------------------------------------------------------------------------------------

const EVENTS_SHOWN = 20;
const lastPart = (v: unknown) => (typeof v === "string" ? v.split(".").pop() : v);

/** look kind provenance: counts by type and component, the first events in a line each (uuid, event id, member kept). */
export function provenanceShape(body: Any, a: Record<string, unknown>) {
  const events = (Array.isArray(body?.events) ? body.events : []) as Any[];
  if (full(a)) { const p = page(events, a, events.length); return p.from ? { ...body, events: p.shown, offset: p.from } : body; }
  const byType = new Map<string, number>(), byComp = new Map<string, number>(), names = new Map<string, string>();
  const uuids = new Set<string>();
  for (const e of events) {
    bump(byType, String(e.eventType ?? "?"));
    const c = String(e.componentId ?? "?");
    bump(byComp, c); names.set(c, String(e.componentName ?? c));
    if (e.flowFileUuid) uuids.add(String(e.flowFileUuid));
  }
  const p = page(events, a, EVENTS_SHOWN);
  const { events: _all, ...rest } = body ?? {};
  return {
    ...rest,
    count: events.length, flowFiles: uuids.size,
    byType: Object.fromEntries(top(byType, 20).map((x) => [x.key, x.count])),
    byComponent: top(byComp, 15).map((x) => ({ component: x.key, name: names.get(x.key), events: x.count })),
    // A line each: the component by name (byComponent has its id), the node by its clusterNodeId (what event and
    // lineage take as member), else the member.
    events: p.shown.map((e) => ({
      eventId: e.eventId, at: e.at, type: e.eventType, uuid: e.flowFileUuid, component: e.componentName,
      ...(e.relationship ? { relationship: e.relationship } : {}), ...(e.details ? { details: clip(e.details, 100) } : {}),
      ...(e.clusterNodeId ? { node: e.clusterNodeId } : e.member ? { member: e.member } : {}),
      ...(e.transitUri ? { transitUri: clip(e.transitUri, 120) } : {}),
      ...(e.parentUuids?.length ? { parents: e.parentUuids.length } : {}), ...(e.childUuids?.length ? { children: e.childUuids.length } : {}),
    })),
    shown: { from: p.from, count: p.shown.length, rest: p.rest },
    more: `${p.rest ? `offset: ${p.from + p.shown.length} for the next events; ` : ""}${FULL_HINT}; look kind event (eventId, member) gives one event's attributes.`,
  };
}

// ---- bulletins -----------------------------------------------------------------------------------------------------

/** look kind bulletins: grouped by source, level and message pattern (count, first, last, nodes, one message). */
export function bulletinsShape(body: Any, a: Record<string, unknown>) {
  const rows = (Array.isArray(body?.bulletins) ? body.bulletins : []) as Any[];
  if (full(a)) { const p = page(rows, a, rows.length); return p.from ? { bulletins: p.shown, offset: p.from } : body; }
  const groups = new Map<string, Any>();
  for (const b of rows) {
    const k = `${b.level}\0${b.sourceId ?? b.source}\0${pattern(b.message)}`;
    const g = groups.get(k) ?? { level: b.level, source: b.source, sourceId: b.sourceId ?? null, sourceType: lastPart(b.sourceType), groupId: b.groupId ?? null, count: 0, first: b.at, last: b.at, members: new Set<string>(), message: clip(b.message, 300) };
    g.count++;
    if (b.at < g.first) g.first = b.at;
    if (b.at > g.last) { g.last = b.at; g.message = clip(b.message, 300); }
    if (b.member) g.members.add(b.member);
    groups.set(k, g);
  }
  const all = [...groups.values()].sort((x, y) => y.count - x.count || String(y.last).localeCompare(String(x.last)));
  const p = page(all, a, 20);
  const levels = new Map<string, number>();
  for (const b of rows) bump(levels, String(b.level ?? "?"));
  return {
    count: rows.length, levels: Object.fromEntries(levels), groups: all.length,
    top: p.shown.map((g) => ({ ...g, members: [...g.members] })),
    shown: { from: p.from, count: p.shown.length, rest: p.rest },
    more: `${p.rest ? `offset: ${p.from + p.shown.length} for the next groups; ` : ""}${FULL_HINT} (every bulletin, newest first; offset pages it).`,
  };
}

// ---- logs ----------------------------------------------------------------------------------------------------------

/** look kind logs: lines grouped by level, logger and message pattern, plus the newest lines (each clipped). */
export function logsShape(body: Any, a: Record<string, unknown>) {
  const entries = (Array.isArray(body?.entries) ? body.entries : []) as Any[];
  if (full(a)) { const p = page(entries, a, entries.length); return p.from ? { ...body, entries: p.shown, offset: p.from } : body; }
  const groups = new Map<string, Any>();
  for (const e of entries) {
    const k = `${e.level}\0${e.logger}\0${pattern(e.text)}`;
    const g = groups.get(k) ?? { level: e.level, logger: e.logger, count: 0, first: e.at, last: e.at, members: new Set<string>(), text: clip(e.text, 300) };
    g.count++;
    if (e.at < g.first) g.first = e.at;
    if (e.at > g.last) { g.last = e.at; g.text = clip(e.text, 300); }
    if (e.member) g.members.add(e.member);
    groups.set(k, g);
  }
  const all = [...groups.values()].sort((x, y) => y.count - x.count || String(y.last).localeCompare(String(x.last)));
  const p = page(all, a, 20);
  const levels = new Map<string, number>();
  for (const e of entries) bump(levels, String(e.level ?? "?"));
  const { entries: _all, ...rest } = body ?? {};
  return {
    ...rest,
    count: entries.length, levels: Object.fromEntries(levels), groups: all.length,
    top: p.shown.map((g) => ({ ...g, members: [...g.members] })),
    newest: entries.slice(-8).map((e) => ({ at: e.at, member: e.member, level: e.level, logger: e.logger, text: clip(e.text, 300) })),
    shown: { from: p.from, count: p.shown.length, rest: p.rest },
    more: `${p.rest ? `offset: ${p.from + p.shown.length} for the next groups; ` : ""}${FULL_HINT} (every line; offset pages it); a narrower query, member or from–to finds one thing.`,
  };
}

// ---- describe ------------------------------------------------------------------------------------------------------

/** describe of one service, short: to-do details, gap texts and the analysis' summary clipped; a business's detail
 *  (flow) whole, since it was asked for. */
export function describeShape(body: Any, a: Record<string, unknown>) {
  if (full(a) || !body || typeof body !== "object" || !body.machine) return body;
  const { flow, ...rest } = body;
  return {
    ...(compactDeep({
      ...rest,
      todos: (rest.todos ?? []).map((t: Any) => ({ id: t.id, flow: t.flow, source: t.source, severity: t.severity, title: t.title, detail: clip(t.detail, 100), action: t.action ? { kind: t.action.kind, label: t.action.label } : null, createdAt: t.createdAt })),
    }, 400, 20) as Any),
    ...(flow !== undefined ? { flow } : {}),
    more: `${FULL_HINT} (to-dos' whole details and actions).`,
  };
}
