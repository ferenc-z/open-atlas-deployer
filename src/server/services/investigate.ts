// S37 step 4 (pages-rethink §4.3): the investigation's evidence, worked out by code (no tokens; the AI reads it in step 9).
// investigate_service(service, member?, from, to, focus?) reads what the Deployer already keeps and cuts each part into a
// card: the metrics that left their baseline (the same hours a day before), the log patterns that are new or surging
// (the executor's WARN/ERROR summary, against the day before), the bulletins by component, the changes of the 24 hours
// before, and the process's starts and stops with signs of running out of memory. Each card's items carry their raw
// content (log lines, events, the curve against its baseline) and, where NiFi has the component, a link into its UI.
// GET /api/services/:id/investigate and the MCP tool investigate_service return it (the tool redacted and compact).

import type { ExecutorInfo } from "../handoff.ts";
import type { ServiceBulletin, Store } from "../store.ts";
import { FIELDS, type Field } from "./metrics.ts";
import { memberName } from "./rules.ts";
import { serviceStatus, type MemberStatus, type ServiceStatus } from "./status.ts";

const HOUR = 3_600_000, DAY = 24 * HOUR;
/** The longest window one investigation reads (the raw samples it compares are kept two days). */
export const MAX_SPAN_HOURS = 24;
export const DEFAULT_SPAN_HOURS = 1;
/** How many items each card keeps, and points in a curve. */
export const LIMITS = { metrics: 6, logs: 8, bulletins: 10, changes: 20, process: 20, rawLines: 5, curve: 120 };

export type CardKind = "process" | "bulletins" | "logs" | "metrics" | "changes";
export const CARD_KINDS: readonly CardKind[] = ["process", "bulletins", "logs", "metrics", "changes"];
export type Weight = "high" | "medium" | "low" | "none";

export interface Curve { name: string; at: number[]; values: (number | null)[] }
export interface EvidenceItem {
  text: string;
  at?: string;
  member?: string | null;
  memberLabel?: string | null;
  /** The raw content behind the line: log lines, bulletin messages, event details. */
  raw?: string[];
  /** The metric over the window and the same hours a day before (shifted onto the window). */
  curves?: { unit: string; series: Curve[] };
  /** NiFi's UI with the component selected. */
  nifiUrl?: string;
  detail?: Record<string, unknown>;
}
export interface EvidenceCard { kind: CardKind; title: string; weight: Weight; summary: string; items: EvidenceItem[]; more?: number }
export interface Investigation {
  service: string; member: string | null; memberLabel: string | null; from: string; to: string; focus: string | null; asOf: string;
  /** The same hours a day before, what the metrics and the logs compare with; the 24 hours before `from` for the changes. */
  baseline: { from: string; to: string };
  changesFrom: string;
  cards: EvidenceCard[];
  notes: string[];
}

export class InvestigateError extends Error {
  readonly status: 400 | 404;
  readonly code: string;
  constructor(status: 400 | 404, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

export interface InvestigateAsk { member?: string | undefined; from?: string | undefined; to?: string | undefined; focus?: string | undefined; compact?: boolean | undefined }

/** Which card a to-do's rule or an alert points at first. */
const FOCUS: Record<string, CardKind> = {
  "process-down": "process", "node-disconnected": "process", "no-samples": "process", "executor-lost": "process", "no-coordinator": "process",
  "error-bulletins": "bulletins", "zk-errors": "logs", "heap": "metrics", "repo-disk": "metrics", "backpressure": "metrics",
  "collection-incomplete": "metrics", "preventive-risk": "metrics", "config-drift": "changes", "version-mismatch": "changes", "cert-expiry": "changes",
  // Step 3a (C1): the six checks.
  process: "process", collection: "process", coordinator: "logs", disk: "metrics", certificate: "changes",
};
const WEIGHT: Record<Weight, number> = { high: 0, medium: 1, low: 2, none: 3 };
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const r1 = (v: number) => Math.round(v * 10) / 10;

/** NiFi's UI with a component selected (Q5): the node's web address with ?processGroupId=…&componentIds=…. */
export function nifiLink(base: string | null | undefined, groupId?: string | null, componentId?: string | null): string | undefined {
  if (!base) return undefined;
  let u: URL;
  try { u = new URL(base); } catch { return undefined; }
  if (!/\/nifi\/?$/.test(u.pathname)) u.pathname = `${u.pathname.replace(/\/$/, "")}/nifi/`;
  else if (!u.pathname.endsWith("/")) u.pathname += "/";
  u.search = "";
  if (groupId) u.searchParams.set("processGroupId", groupId);
  if (componentId) u.searchParams.set("componentIds", componentId);
  return u.toString();
}

/** A member's own NiFi address: what discovery saw, else its node address and web port, else the service's. */
function webOf(s: ServiceStatus, m: MemberStatus | undefined): string | null {
  if (!m) return s.webUrl;
  if (m.seen?.webUrl) return m.seen.webUrl;
  const port = m.ports.https ?? m.ports.http ?? null;
  if (port) return `${m.ports.https ? "https" : "http"}://${m.nodeAddress ?? m.host}:${port}/nifi`;
  return s.webUrl;
}

export function parseWindow(ask: InvestigateAsk, now: Date): { from: number; to: number } {
  const t = (v: string | undefined, name: string) => {
    if (v === undefined || v === "") return undefined;
    const ms = Date.parse(v);
    if (Number.isNaN(ms)) throw new InvestigateError(400, "investigate/bad-time", `${name} is not a time: ${v}`);
    return ms;
  };
  const to = Math.min(t(ask.to, "to") ?? now.getTime(), now.getTime());
  const from = t(ask.from, "from") ?? to - DEFAULT_SPAN_HOURS * HOUR;
  if (from >= to) throw new InvestigateError(400, "investigate/bad-window", "from must be before to (and to not in the future).");
  if (to - from > MAX_SPAN_HOURS * HOUR) throw new InvestigateError(400, "investigate/too-long", `At most ${MAX_SPAN_HOURS} hours at a time.`);
  return { from, to };
}

/** get investigate_service: the evidence of a service (or one member) over a window. */
export function investigate(store: Store, executor: (host: string) => ExecutorInfo, id: string, ask: InvestigateAsk = {}, now: Date = new Date()): Investigation | undefined {
  const s = serviceStatus(store, executor, id, now);
  if (!s) return undefined;
  const member = ask.member ? s.members.find((m) => m.key === ask.member) : undefined;
  if (ask.member && !member) throw new InvestigateError(404, "investigate/unknown-member", `${id} has no member ${ask.member}.`);
  const { from, to } = parseWindow(ask, now);
  const focus = ask.focus ? (CARD_KINDS.includes(ask.focus as CardKind) ? (ask.focus as CardKind) : FOCUS[ask.focus] ?? null) : null;
  const ctx: Ctx = {
    store, s, from, to, baseFrom: from - DAY, baseTo: to - DAY, changesFrom: from - DAY, notes: [], compact: Boolean(ask.compact),
    only: member?.key, label: (k) => { const m = s.members.find((x) => x.key === k); return m ? memberName(s, m) : k; },
    web: (k) => webOf(s, s.members.find((x) => x.key === k)),
  };
  const cards = [processCard(ctx), bulletinCard(ctx), logCard(ctx), metricCard(ctx), changeCard(ctx)];
  cards.sort((a, b) => (a.kind === focus ? -1 : b.kind === focus ? 1 : 0) || WEIGHT[a.weight] - WEIGHT[b.weight]);
  return {
    service: id, member: member?.key ?? null, memberLabel: member ? memberName(s, member) : null, from: iso(from), to: iso(to), focus: ask.focus ?? null, asOf: now.toISOString(),
    baseline: { from: iso(ctx.baseFrom), to: iso(ctx.baseTo) }, changesFrom: iso(ctx.changesFrom), cards, notes: ctx.notes,
  };
}

interface Ctx {
  store: Store; s: ServiceStatus; from: number; to: number; baseFrom: number; baseTo: number; changesFrom: number; notes: string[]; compact: boolean;
  only: string | undefined; label: (member: string) => string; web: (member: string) => string | null;
}
const mine = (c: Ctx, member: string | null | undefined) => !c.only || !member || member === "*" || member === c.only;
const cut = <T>(list: T[], n: number) => ({ items: list.slice(0, n), ...(list.length > n ? { more: list.length - n } : {}) });

// --- process: starts, stops, disconnects, out of memory ----------------------------------------------------------------

const OOM = /OutOfMemoryError|java heap space|GC overhead limit exceeded|Cannot allocate memory|oom-kill|Killed process/i;
const PROCESS_EVENTS = new Set(["process-restarted", "node-disconnected", "node-reconnected", "node-stopped", "node-started"]);

function processCard(c: Ctx): EvidenceCard {
  const items: (EvidenceItem & { at: string })[] = [];
  const inWindow = (at: string) => { const t = Date.parse(at); return t >= c.from && t < c.to; };
  const events = c.store.serviceEvents(c.s.id, { from: iso(c.changesFrom), to: iso(c.to), limit: 1000 }).filter((e) => mine(c, e.member));
  const known = new Set<string>();
  for (const e of events) {
    const rule = String(e.detail.rule ?? "");
    const alert = (e.kind === "alert-opened" || e.kind === "alert-resolved") && (rule === "process-down" || rule === "node-disconnected" || rule === "no-samples" || rule === "process" || rule === "collection");
    if (!PROCESS_EVENTS.has(e.kind) && !alert) continue;
    if (e.kind === "process-restarted" && e.member) known.add(`${e.member}\0${String(e.detail.startedAt ?? e.at)}`);
    items.push({ at: e.at, member: e.member, memberLabel: e.member ? c.label(e.member) : null, text: String(e.detail.text ?? e.kind), raw: [JSON.stringify({ kind: e.kind, ...e.detail })], detail: { kind: e.kind } });
  }
  // Starts the samples show that the timeline has not (it skips members inside a change; the first start ever too).
  const starts = c.store.serviceProcessStarts(c.s.id, iso(c.changesFrom - DAY), iso(c.to)).filter((x) => mine(c, x.member));
  const byMember = new Map<string, typeof starts>();
  for (const x of starts) byMember.set(x.member, [...(byMember.get(x.member) ?? []), x]);
  for (const [m, list] of byMember) {
    list.forEach((x, i) => {
      if (i === 0 || known.has(`${m}\0${x.startedAt}`)) return;
      const t = Date.parse(x.startedAt);
      if (!(t >= c.changesFrom && t < c.to)) return;
      items.push({ at: x.startedAt, member: m, memberLabel: c.label(m), text: `${c.label(m)}: NiFi process started (pid ${x.pid ?? "?"}; the one before started ${list[i - 1]!.startedAt})`, detail: { kind: "process-started", pid: x.pid } });
    });
  }
  // Stretches in the window where the samples say no process ran.
  const points = c.store.servicePoints(c.s.id, iso(c.from), iso(c.to)).filter((p) => mine(c, p.member));
  const down = new Map<string, { since: string; last: string } | null>();
  const flush = (m: string) => { const d = down.get(m); if (d) items.push({ at: d.since, member: m, memberLabel: c.label(m), text: `${c.label(m)}: no NiFi process in the samples from ${d.since} to ${d.last}`, detail: { kind: "process-down", until: d.last } }); down.set(m, null); };
  for (const p of points) {
    if (p.point.up === 0) { const d = down.get(p.member); down.set(p.member, d ? { ...d, last: p.at } : { since: p.at, last: p.at }); }
    else if (p.point.up === 1) flush(p.member);
  }
  for (const m of [...down.keys()]) flush(m);
  // Out of memory in the log summary (WARN/ERROR lines) of the day before and the window.
  let oom = 0;
  for (const p of c.store.serviceLogPatterns(c.s.id, { since: iso(c.changesFrom), limit: 1000 })) {
    if (!mine(c, p.member) || Date.parse(p.lastAt) >= c.to) continue;
    if (![p.template, p.exception, p.firstSample, p.lastSample].some((x) => x && OOM.test(x))) continue;
    oom++;
    items.push({ at: p.lastAt, member: p.member, memberLabel: c.label(p.member), text: `${c.label(p.member)}: out of memory in the log (${p.level} ${p.exception ?? p.logger ?? ""}, ${p.count} since ${p.firstAt})`, raw: lines(c, [p.firstSample, p.lastSample]), detail: { kind: "oom", pattern: p.pattern } });
  }
  items.sort((a, b) => (a.at < b.at ? 1 : -1));
  const recent = items.filter((x) => inWindow(x.at) || Date.parse(x.at) >= c.from - HOUR);
  const restarts = items.filter((x) => x.detail?.kind === "process-restarted" || x.detail?.kind === "process-started").length;
  const weight: Weight = oom ? "high" : recent.length ? "high" : items.length ? "medium" : "none";
  const summary = items.length
    ? [restarts && `${restarts} start${restarts === 1 ? "" : "s"}`, oom && `${oom} out-of-memory pattern${oom === 1 ? "" : "s"}`, `${items.length} event${items.length === 1 ? "" : "s"} from ${iso(c.changesFrom)}`].filter(Boolean).join(", ")
    : "No restarts, stops, disconnections or out-of-memory signs from 24 hours before the window to its end.";
  return { kind: "process", title: "Process starts, stops and memory", weight, summary, ...cut(items, LIMITS.process) };
}

const lines = (c: Ctx, raw: (string | null | undefined)[]) => {
  const out = [...new Set(raw.filter((x): x is string => Boolean(x)))];
  return c.compact ? out.slice(0, 1) : out;
};

// --- bulletins, by component ---------------------------------------------------------------------------------------

function bulletinCard(c: Ctx): EvidenceCard {
  const list = c.store.serviceBulletins(c.s.id, { from: iso(c.from), to: iso(c.to), limit: 1000 }).filter((b) => mine(c, b.member));
  const groups = new Map<string, ServiceBulletin[]>();
  for (const b of list) { const k = b.sourceId ?? `${b.sourceType ?? ""}\0${b.source ?? "?"}`; groups.set(k, [...(groups.get(k) ?? []), b]); }
  const items = [...groups.values()].map((g): EvidenceItem & { n: number; errors: number } => {
    const newest = g[0]!, oldest = g[g.length - 1]!;
    const errors = g.filter((b) => b.level === "ERROR").length;
    const nodes = [...new Set(g.map((b) => b.node))];
    const levels = Object.entries(g.reduce<Record<string, number>>((a, b) => { const l = b.level ?? "?"; a[l] = (a[l] ?? 0) + 1; return a; }, {})).map(([l, n]) => `${n} ${l}`).join(", ");
    const messages = [...new Set(g.map((b) => b.message ?? ""))].filter(Boolean);
    const url = nifiLink(c.web(newest.member), newest.groupId, newest.sourceId);
    return {
      n: g.length, errors, at: newest.at, member: nodes.length === 1 ? newest.member : null, memberLabel: nodes.length === 1 ? c.label(newest.member) : `${nodes.length} nodes`,
      text: `${newest.source ?? (newest.sourceType === "FLOW_CONTROLLER" ? "NiFi" : "?")}${newest.sourceType ? ` (${newest.sourceType})` : ""}: ${levels} from ${oldest.at} to ${newest.at}${newest.message ? `: ${newest.message.split("\n")[0]!.slice(0, 200)}` : ""}`,
      raw: c.compact ? messages.slice(0, 2) : messages.slice(0, 20).concat(messages.length > 20 ? [`… ${messages.length - 20} more different messages`] : []),
      ...(url ? { nifiUrl: url } : {}),
      detail: { source: newest.source, sourceType: newest.sourceType, sourceId: newest.sourceId ?? null, groupId: newest.groupId ?? null, count: g.length, errors, nodes, first: oldest.at, last: newest.at },
    };
  }).sort((a, b) => b.errors - a.errors || b.n - a.n);
  const errors = items.reduce((a, x) => a + x.errors, 0);
  const out = items.map(({ n: _n, errors: _e, ...x }) => x);
  return {
    kind: "bulletins", title: "Bulletins by component", weight: errors ? "high" : items.length ? "medium" : "none",
    summary: items.length ? `${list.length} bulletin${list.length === 1 ? "" : "s"} from ${items.length} component${items.length === 1 ? "" : "s"}${errors ? `, ${errors} ERROR` : ""}` : "No bulletins in the window.",
    ...cut(out, LIMITS.bulletins),
  };
}

// --- log patterns: new or surging against the day before --------------------------------------------------------------

const BUCKET = 5 * 60_000;
const bucketStart = (ms: number) => Math.floor(ms / BUCKET) * BUCKET;

function logCard(c: Ctx): EvidenceCard {
  const counts = c.store.serviceLogCounts(c.s.id, iso(bucketStart(c.baseFrom))).filter((x) => mine(c, x.member));
  const win = new Map<string, number>(), base = new Map<string, number>();
  const key = (m: string, p: string) => `${m}\0${p}`;
  for (const x of counts) {
    const t = Date.parse(x.bucket), k = key(x.member, x.pattern);
    if (t >= bucketStart(c.from) && t < c.to) win.set(k, (win.get(k) ?? 0) + x.count);
    else if (t >= bucketStart(c.baseFrom) && t < c.baseTo) base.set(k, (base.get(k) ?? 0) + x.count);
  }
  const patterns = new Map(c.store.serviceLogPatterns(c.s.id, { since: iso(bucketStart(c.from)), limit: 1000 }).map((p) => [key(p.member, p.pattern), p] as const));
  if (!counts.length && !patterns.size) c.notes.push("No WARN/ERROR log summary for the window: the executor may not read this NiFi's nifi-app.log, or nothing was logged.");
  const items: (EvidenceItem & { score: number })[] = [];
  let seen = 0;
  for (const [k, n] of win) {
    const p = patterns.get(k);
    if (!p) continue;
    seen++;
    const before = base.get(k) ?? 0;
    const fresh = before === 0 && Date.parse(p.firstAt) >= c.baseFrom;
    const surge = before > 0 ? n >= 3 * before && n - before >= 5 : !fresh && n >= 1;
    if (!fresh && !surge) continue;
    const what = fresh ? "new" : before === 0 ? "not in the same hours a day before" : `×${r1(n / before)} the day before (${before})`;
    items.push({
      score: (p.level === "ERROR" || p.level === "FATAL" ? 1000 : 0) + (fresh ? 500 : 0) + n,
      at: p.lastAt, member: p.member, memberLabel: c.label(p.member),
      text: `${p.level} ${what}: ${n} in the window${p.exception ? ` · ${p.exception}` : ""}${p.logger ? ` · ${p.logger.split(".").pop()}` : ""}: ${p.template.slice(0, 200)}`,
      raw: lines(c, [p.firstSample, p.lastSample]),
      detail: { pattern: p.pattern, level: p.level, logger: p.logger, exception: p.exception, window: n, dayBefore: before, firstAt: p.firstAt, lastAt: p.lastAt, new: fresh },
    });
  }
  items.sort((a, b) => b.score - a.score);
  const errors = items.filter((x) => x.detail!.level === "ERROR" || x.detail!.level === "FATAL").length;
  return {
    kind: "logs", title: "Log patterns new or surging", weight: errors ? "high" : items.length ? "medium" : "none",
    summary: items.length ? `${items.length} of ${seen} WARN/ERROR pattern${seen === 1 ? "" : "s"} in the window are new or surging against the same hours a day before` : seen ? `${seen} WARN/ERROR pattern${seen === 1 ? "" : "s"} in the window, none new or surging against the day before.` : "No WARN/ERROR lines in the window.",
    ...cut(items.map(({ score: _s, ...x }) => x), LIMITS.logs),
  };
}

// --- metrics: what left its baseline ------------------------------------------------------------------------------------

/** Per field: how a change counts. pct: points above the baseline; ratio: times the baseline with a floor (so a small
 *  number doubling is not news); abs: the value alone (no baseline needed). */
const METRIC: Partial<Record<Field, { by: "pct" | "ratio"; floor?: number; at?: number }>> = {
  heapPct: { by: "pct", at: 40 }, repoFlowfilePct: { by: "pct", at: 50 }, repoContentPct: { by: "pct", at: 50 }, repoProvenancePct: { by: "pct", at: 50 },
  diskPct: { by: "pct", at: 50 }, memPct: { by: "pct", at: 50 }, cpuPct: { by: "pct", at: 30 }, bpMaxPct: { by: "pct", at: 60 },
  gcMsPerMin: { by: "ratio", floor: 200 }, queuedCount: { by: "ratio", floor: 1000 }, queuedBytes: { by: "ratio", floor: 64 << 20 },
  threads: { by: "ratio", floor: 50 }, activeThreads: { by: "ratio", floor: 4 }, bpFull: { by: "ratio", floor: 1 }, load1: { by: "ratio", floor: 1 }, rss: { by: "ratio", floor: 256 << 20 },
};
const PCT_DELTA = 15, RATIO = 2, NO_BASE_PCT = 85;

function metricCard(c: Ctx): EvidenceCard {
  const win = c.store.servicePoints(c.s.id, iso(c.from), iso(c.to)).filter((p) => mine(c, p.member));
  let base = c.store.servicePoints(c.s.id, iso(c.baseFrom), iso(c.baseTo)).filter((p) => mine(c, p.member));
  if (!base.length) base = c.store.serviceRollups(c.s.id, iso(c.baseFrom), iso(c.baseTo)).filter((r) => mine(c, r.member)).map((r) => ({ member: r.member, at: r.bucket, point: (r.body?.avg ?? {}) as never }));
  if (!win.length) c.notes.push("No samples in the window: the metrics cannot be compared.");
  else if (!base.length) c.notes.push("No samples a day before the window: only values past fixed limits are shown, not changes.");
  const members = [...new Set(win.map((p) => p.member))];
  const items: (EvidenceItem & { score: number })[] = [];
  const stat = (vs: number[]) => (vs.length ? { avg: vs.reduce((a, b) => a + b, 0) / vs.length, max: Math.max(...vs), last: vs[vs.length - 1]! } : null);
  for (const m of members) {
    const wm = win.filter((p) => p.member === m), bm = base.filter((p) => p.member === m);
    for (const [f, rule] of Object.entries(METRIC) as [Field, NonNullable<(typeof METRIC)[Field]>][]) {
      const nums = (ps: typeof win) => ps.map((p) => p.point[f]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
      const w = stat(nums(wm)), b = stat(nums(bm));
      if (!w) continue;
      let score = 0, why = "";
      const unit = FIELDS[f].unit;
      if (rule.by === "pct") {
        if (b) { const d = w.max - b.avg; if (d >= PCT_DELTA && w.max >= (rule.at ?? 0)) { score = d; why = `up to ${r1(w.max)} % against ${r1(b.avg)} % on average a day before (+${r1(d)} points)`; } }
        else if (w.max >= NO_BASE_PCT) { score = w.max - 70; why = `up to ${r1(w.max)} % (no baseline)`; }
      } else if (b) {
        const ratio = w.avg / Math.max(b.avg, rule.floor ?? 1);
        if (ratio >= RATIO && w.max > (rule.floor ?? 0)) { score = Math.min(100, (ratio - 1) * 20); why = `${r1(ratio)}× the day before on average (${fmt(w.avg, unit)} against ${fmt(b.avg, unit)}, highest ${fmt(w.max, unit)})`; }
      }
      if (!score) continue;
      items.push({
        score, member: m, memberLabel: c.label(m), at: wm[wm.length - 1]!.at,
        text: `${c.label(m)}: ${FIELDS[f].label} ${why}`,
        ...(c.compact ? {} : { curves: { unit, series: [curve("window", wm, f, 0), curve("a day before", bm, f, DAY)] } }),
        detail: { field: f, unit, window: round3(w), dayBefore: b ? round3(b) : null },
      });
    }
  }
  items.sort((a, b) => b.score - a.score);
  return {
    kind: "metrics", title: "Metrics off their baseline", weight: items.some((x) => x.score >= 30) ? "high" : items.length ? "medium" : "none",
    summary: !win.length ? "No samples in the window." : !base.length ? (items.length ? `${items.length} metric${items.length === 1 ? "" : "s"} past fixed limits (no baseline a day before)` : "Nothing past fixed limits; no samples a day before to compare with.")
      : items.length ? `${items.length} metric${items.length === 1 ? "" : "s"} far from the same hours a day before` : "Every metric close to the same hours a day before.",
    ...cut(items.map(({ score: _s, ...x }) => x), LIMITS.metrics),
  };
}
const round3 = (x: { avg: number; max: number; last: number }) => ({ avg: r1(x.avg), max: r1(x.max), last: r1(x.last) });
const fmt = (v: number, unit: string) => (unit === "bytes" ? `${r1(v / (1 << 20))} MiB` : `${r1(v)}${unit === "%" ? " %" : unit === "count" ? "" : ` ${unit}`}`);
function curve(name: string, ps: { at: string; point: Record<string, unknown> }[], f: Field, shift: number): Curve {
  const step = Math.max(1, Math.ceil(ps.length / LIMITS.curve));
  const at: number[] = [], values: (number | null)[] = [];
  for (let i = 0; i < ps.length; i += step) { const v = ps[i]!.point[f]; at.push(Date.parse(ps[i]!.at) + shift); values.push(typeof v === "number" ? v : null); }
  return { name, at, values };
}

// --- changes of the 24 hours before ------------------------------------------------------------------------------------

const CHANGE_KINDS = new Set(["config-saved", "config-applied", "config-imported", "config-rolled-back", "change-started", "change-finished", "change-stopped", "change-paused", "change-resumed",
  "drift-detected", "drift-resolved", "version-changed", "thresholds", "taken-over", "nginx-url"]);

function changeCard(c: Ctx): EvidenceCard {
  const events = c.store.serviceEvents(c.s.id, { from: iso(c.changesFrom), to: iso(c.to), limit: 1000 })
    .filter((e) => (CHANGE_KINDS.has(e.kind) || e.kind.startsWith("change-") || e.kind.startsWith("config-")) && mine(c, e.member));
  const changes = deployerChanges(c);
  const items: EvidenceItem[] = events.map((e) => ({
    at: e.at, member: e.member, memberLabel: e.member ? c.label(e.member) : null, text: `${e.kind}: ${String(e.detail.text ?? "")}${e.detail.by ? ` (by ${String(e.detail.by)})` : ""}`,
    raw: [JSON.stringify({ kind: e.kind, ...e.detail })], detail: { kind: e.kind },
  }));
  // change-started events carry the change's id: the change itself only once.
  for (const x of changes) if (!events.some((e) => e.detail.change === x.id)) items.push(x.item);
  items.sort((a, b) => ((a.at ?? "") < (b.at ?? "") ? 1 : -1));
  const inWindow = items.filter((x) => x.at && Date.parse(x.at) >= c.from).length;
  const drift = events.some((e) => e.kind === "drift-detected");
  return {
    kind: "changes", title: "Changes in the 24 hours before", weight: drift || inWindow ? "high" : items.length ? "medium" : "none",
    summary: items.length ? `${items.length} change${items.length === 1 ? "" : "s"} from ${iso(c.changesFrom)}${inWindow ? `, ${inWindow} inside the window` : ""}${drift ? ", configuration drift" : ""}` : "No configuration change, deploy or drift in the 24 hours before the window or in it.",
    ...cut(items, LIMITS.changes),
  };
}

/** The Deployer's own changes (apply, restarts) that started in the period, whether or not they left events. */
function deployerChanges(c: Ctx): { id: string; item: EvidenceItem }[] {
  return c.store.serviceChanges(c.s.id, 50).filter((x) => { const t = Date.parse(x.createdAt); return t >= c.changesFrom && t < c.to; })
    .filter((x) => !c.only || x.mode === "full" || x.currentMember === c.only || JSON.stringify(x.plan ?? {}).includes(c.only))
    .map((x) => ({ id: x.id, item: { at: x.createdAt, text: `Deployer change ${x.kind}${x.revision ? ` (revision ${x.revision})` : ""}: ${x.state}${x.message ? `: ${x.message}` : ""} (by ${x.createdBy})`, detail: { change: x.id, kind: `change-${x.kind}`, state: x.state, finishedAt: x.finishedAt } } }));
}
