// S39 step 5 (business-registration §4.3 step 5 ②–④): the gate of a registration's publish. Every service the action
// touches gets its new model in one go (register-publish.ts), and the gate judges them together, against the models
// they replace, on the registered businesses only (a business nobody registered, a group nobody registered, is none of
// its business):
//   - coverage: every registered group (a business's, a shared module's) is a segment of its service's model;
//   - reachable: a business's segments are joined (paired channels, through a module from its entry to its exit, a told
//     hand-over), and over a connection between two of its groups what one sent in the window the other received;
//   - no-dangling: a registered business's exits all reach an entry (a told hand-over is not dangling: it leads
//     outside by design, §7.3), its canvas entries all have a sender, and each exit names its component;
//   - s2s-balance: each S2S hand-over of a registered business, the two sides' hourly counts (the latest topology says
//     which RPG port and remote input port; without them nothing is judged);
//   - no-regression: a registered business without a problem under the current models gets none under the new ones.
// A check fails on what the change makes, not on what was there (a problem the current models have too is said, not
// held against it). A refusal names the business, the group and its link, or the two sides of the hand-over, so the AI
// can take it back to the owner.

import type { Topology } from "./flowcounts.ts";
import type { GateCheck } from "./flowmodel.ts";
import { CANVAS_CHANNEL, dangling, links, type Link } from "./trace/channels.ts";
import { toTraceModel, WHOLE, type ModelV2, type Segment } from "./trace/model.ts";

export const GATE_DAYS = 7;
const DAY = 86_400_000;
const HOUR = 3_600_000;

/** A registered group as the gate reads it (the registrations after the action). */
export interface GateReg { owner: string; role: "segment" | "shared"; service: string; groupId: string; groupName: string; slice: string; link: string | null }
export interface GateSide { service: string; group: { id: string; name: string }; link?: string | null }
export interface GateProblem {
  check: GateCheck; flow: string | null; key: string; text: string;
  /** The registered group the problem is on (coverage, reachable, no-dangling). */
  group?: GateSide;
  /** The hand-over the problem is on (reachable data, s2s-balance, no-dangling of an exit). */
  link?: { channel: string; from: GateSide; to?: GateSide };
}
export interface GateResult {
  verdict: "published" | "rejected";
  window: { from: string; to: string };
  checks: { check: GateCheck; ok: boolean; text: string }[];
  /** The problems the change makes (what the refusal is about). */
  problems: GateProblem[];
  regressions: { flow: string; text: string }[];
}
export interface GateCount { kind: string; ref: string; bucket: string; in: number; out: number; moved: number }
export interface GateInput {
  base: ModelV2[]; draft: ModelV2[]; regs: GateReg[];
  topology: (service: string) => Topology | null;
  counts: (service: string, from: string, to: string) => GateCount[];
  now?: Date;
  names?: (flow: string) => string;
  /** The businesses and modules the action registers or changes: their groups have to be covered whatever the current
   *  models say (a group registered before step 5 and never published is another owner's old problem). */
  own?: Set<string>;
}

interface Node { service: string; s: Segment }
const nodeKey = (service: string, segment: string) => `${service}\0${segment}`;

/** The RPG ports of a group sending to a port (in the group, or beside it in the parent), as the counts name them. */
function senderRefs(t: Topology | null, group: string, port: string): string[] {
  if (!t) return [];
  const refs = t.s2sOut.filter((o) => o.group === group && o.name === port).map((o) => o.ref);
  for (const n of t.neighbors ?? []) {
    if (n.group !== group || n.side !== "out" || n.other.kind !== "rpg" || (n.other.port?.name ?? n.other.name) !== port || !n.other.targets?.length) continue;
    refs.push(`${n.other.targets[0]}#${port}`);
  }
  return refs;
}
/** The remote input ports receiving for a group (in it, a root port on a whole canvas, a remote port in its parent). */
function receiverIds(t: Topology | null, group: string, port: string): string[] {
  if (!t) return [];
  const ids = t.s2sIn.filter((p) => p.name === port && (p.group === group || p.group === t.root?.id)).map((p) => p.id);
  for (const n of t.neighbors ?? []) if (n.group === group && n.side === "in" && n.other.kind === "port" && n.other.remote && n.other.name === port) ids.push(n.other.id);
  return ids;
}

function problemsOf(models: ModelV2[], c: GateInput & { from: string; to: string; services: Set<string>; isBase?: boolean }): GateProblem[] {
  const out: GateProblem[] = [];
  const regLink = (service: string, group: string) => c.regs.find((r) => r.service === service && r.groupId === group)?.link ?? null;
  const side = (service: string, s: Segment): GateSide => ({ service, group: { id: s.group.id, name: s.group.name }, link: regLink(service, s.group.id) });
  const owners = new Set(c.regs.map((r) => r.owner));
  const flows = new Set(c.regs.filter((r) => r.role === "segment").map((r) => r.owner));
  const nodes: Node[] = models.flatMap((m) => m.segments.map((s) => ({ service: m.service, s })));
  const byKey = new Map(nodes.map((n) => [nodeKey(n.service, n.s.id), n]));
  const ownerOf = (n: Node) => (n.s.role === "shared" ? n.s.module : n.s.flow);
  const registered = (n: Node) => { const o = ownerOf(n); return !!o && owners.has(o); };

  // coverage: each registered group of the touched services is a segment of its owner.
  for (const r of c.regs) {
    if (!c.services.has(r.service) || (c.isBase && c.own?.has(r.owner))) continue;
    const m = models.find((x) => x.service === r.service);
    const hit = m?.segments.some((s) => s.group.id === r.groupId && (r.slice === WHOLE ? s.slice === WHOLE : s.slice === r.slice)
      && (r.role === "segment" ? s.flow === r.owner : s.role === "shared" && s.module === r.owner));
    if (!hit) out.push({ check: "coverage", flow: r.role === "segment" ? r.owner : null, key: `coverage:${r.owner}:${r.service}/${r.groupId}/${r.slice}`,
      text: `登记的组 ${r.groupName}（${r.service}）不在模型的段里`, group: { service: r.service, group: { id: r.groupId, name: r.groupName }, link: r.link } });
  }

  const ls = links(models.map(toTraceModel));
  const from = (l: Link) => byKey.get(nodeKey(l.from.service, l.from.business));
  const to = (l: Link) => byKey.get(nodeKey(l.to.service, l.to.business));

  // reachable: a registered business's segments joined; data over a connection between two of its groups.
  for (const f of flows) {
    const members = nodes.filter((n) => n.s.role === "segment" && n.s.flow === f);
    if (!members.length) continue;
    const mine = new Set(members.map((n) => nodeKey(n.service, n.s.id)));
    if (members.length > 1) {
      const up = new Map<string, string>();
      const find = (x: string): string => { while ((up.get(x) ?? x) !== x) x = up.get(x)!; return x; };
      const join = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) up.set(rb, ra); };
      const into = new Map<string, Set<string>>(), outOf = new Map<string, Set<string>>();
      for (const l of ls) {
        const a = nodeKey(l.from.service, l.from.business), b = nodeKey(l.to.service, l.to.business);
        if (mine.has(a) && mine.has(b)) join(a, b);
        else if (mine.has(a) && to(l)?.s.role === "shared") into.set(b, new Set([...(into.get(b) ?? []), a]));
        else if (mine.has(b) && from(l)?.s.role === "shared") outOf.set(a, new Set([...(outOf.get(a) ?? []), b]));
      }
      // Through a module only from its entry to its exit (an error or audit step that keeps the data joins nothing).
      for (const [m, xs] of into) for (const x of xs) for (const y of outOf.get(m) ?? []) join(x, y);
      for (const n of members) for (const e of n.s.exits) {
        const t = e.declared?.to;
        if (!t || !("service" in t)) continue;
        const target = members.find((x) => x.service === t.service && x.s.group.id === t.group);
        if (target) join(nodeKey(n.service, n.s.id), nodeKey(target.service, target.s.id));
      }
      const roots = new Map<string, Node[]>();
      for (const n of members) { const r = find(nodeKey(n.service, n.s.id)); roots.set(r, [...(roots.get(r) ?? []), n]); }
      if (roots.size > 1) {
        const parts = [...roots.values()].sort((a, b) => b.length - a.length);
        for (const p of parts.slice(1)) for (const n of p) {
          out.push({ check: "reachable", flow: f, key: `reachable:${f}:${n.service}/${n.s.group.id}/${n.s.slice}`, group: side(n.service, n.s),
            text: `${n.service} 的 ${n.s.group.name} 和这条业务其余的段之间没有交接（连线、S2S、MQ、schedule、公共模块或口头说明）` });
        }
      }
    }
    for (const l of ls) {
      if (!l.channel.startsWith("link:") || l.channel.startsWith("link:schedule-") || l.from.service !== l.to.service) continue;
      const a = from(l), b = to(l);
      if (!a || !b || a.s.flow !== f || b.s.flow !== f) continue;
      const rows = c.counts(a.service, c.from, c.to).filter((r) => r.kind === "group");
      const ta = rows.filter((r) => r.ref === a.s.group.id), tb = rows.filter((r) => r.ref === b.s.group.id);
      if (!ta.length || !tb.length) continue;
      const sent = ta.reduce((n, r) => n + r.out, 0), got = tb.reduce((n, r) => n + r.in + r.moved, 0);
      if (sent > 0 && got === 0) out.push({ check: "reachable", flow: f, key: `reachable:data:${a.service}/${a.s.id}>${b.s.id}`, link: { channel: l.channel, from: side(a.service, a.s), to: side(b.service, b.s) },
        text: `${a.s.group.name} ${GATE_DAYS} 天送出 ${sent} 个，${b.s.group.name} 一个也没收到` });
    }
  }

  // no-dangling: a registered business's exits reach an entry; its canvas entries have a sender; exits name a component.
  for (const d of dangling(models.map(toTraceModel))) {
    const n = byKey.get(nodeKey(d.service, d.business));
    if (!n || n.s.role !== "segment" || !registered(n)) continue;
    if (d.side === "entry" && !CANVAS_CHANNEL.test(d.channel)) continue; // S2S / MQ from outside the managed services
    const label = d.channel.replace(/^s2s:/, "S2S ").replace(/^mq:/, "MQ ");
    out.push({ check: "no-dangling", flow: n.s.flow ?? null, key: `dangling:${d.side}:${d.channel}:${d.service}/${n.s.group.id}:${d.endpoint}`, group: side(n.service, n.s),
      ...(d.side === "exit" ? { link: { channel: d.channel, from: side(n.service, n.s) } } : {}),
      text: d.side === "exit" ? `${n.s.group.name} 的出口 ${d.endpoint} 发往 ${label}，没有哪个登记的段在那里收` : `${n.s.group.name} 的入口 ${d.endpoint} 在 ${label} 上收，没有哪个登记的段往这里发` });
  }
  for (const n of nodes) {
    if (n.s.role !== "segment" || !registered(n)) continue;
    for (const e of n.s.exits) if (!e.component) out.push({ check: "no-dangling", flow: n.s.flow ?? null, key: `exit-component:${n.service}/${n.s.id}:${e.id}`, group: side(n.service, n.s), text: `${n.s.group.name} 的出口 ${e.id} 没标是哪个组件出去的` });
  }

  // s2s-balance: each S2S hand-over with a registered side; fan-in (several senders to one port) as their sum.
  const byReceiver = new Map<string, Link[]>();
  for (const l of ls) {
    if (!l.channel.startsWith("s2s:")) continue;
    const a = from(l), b = to(l);
    if (!a || !b || (!registered(a) && !registered(b))) continue;
    const k = `${l.to.service}\0${l.to.business}\0${l.to.endpoint}`;
    byReceiver.set(k, [...(byReceiver.get(k) ?? []), l]);
  }
  for (const feeds of byReceiver.values()) {
    const b = to(feeds[0]!)!;
    const port = feeds[0]!.channel.slice(feeds[0]!.channel.indexOf("/") + 1);
    const ids = receiverIds(c.topology(b.service), b.s.group.id, port);
    const senders = feeds.map((l) => ({ l, a: from(l)!, refs: senderRefs(c.topology(l.from.service), from(l)!.s.group.id, port) })).filter((x) => x.refs.length);
    if (!ids.length || !senders.length) continue;
    // Per 5-minute bucket, and only the buckets every side was counted in: a side whose history starts later (a node
    // restarted, a port added) must not make its first, partial hour look like data lost (lab 2026-11-24).
    const buckets = (rows: GateCount[], kind: string, set: string[], pick: (r: GateCount) => number) => {
      const m = new Map<number, number>();
      for (const r of rows) if (r.kind === kind && set.includes(r.ref)) { const t = Date.parse(r.bucket); m.set(t, (m.get(t) ?? 0) + pick(r)); }
      return m;
    };
    const per = senders.map((x) => buckets(c.counts(x.a.service, c.from, c.to), "s2s-out", x.refs, (r) => r.out));
    const recv = buckets(c.counts(b.service, c.from, c.to), "s2s-in", ids, (r) => Math.max(r.in, r.out));
    // The bucket a side's history starts in may itself be partial: start after the latest first bucket.
    const first = Math.max(...[recv, ...per].map((m) => Math.min(...m.keys())));
    const common = [...recv.keys()].filter((t) => t > first && per.every((m) => m.has(t)));
    const sent = new Map<number, number>(), got = new Map<number, number>();
    for (const t of common) {
      const h = Math.floor(t / HOUR);
      sent.set(h, (sent.get(h) ?? 0) + per.reduce((n, m) => n + m.get(t)!, 0));
      got.set(h, (got.get(h) ?? 0) + recv.get(t)!);
    }
    const hours = [...sent.keys()].sort((x, y) => x - y);
    if (!hours.length) continue;
    const s = hours.reduce((n, h) => n + sent.get(h)!, 0), g = hours.reduce((n, h) => n + got.get(h)!, 0);
    // A hand-over late by a bucket shows as +n then -n: only a difference that stays is a mismatch.
    const bound = Math.max(5, Math.ceil(0.02 * Math.max(s, g)));
    let cum = 0, off: number | null = null;
    for (const h of hours) { cum += sent.get(h)! - got.get(h)!; if (off === null && Math.abs(cum) > bound) off = h; }
    if (off === null || Math.abs(cum) <= bound) continue;
    const a = senders[0]!.a;
    const flow = (b.s.role === "segment" ? b.s.flow : undefined) ?? (a.s.role === "segment" ? a.s.flow : undefined) ?? null;
    out.push({ check: "s2s-balance", flow, key: `s2s:${feeds[0]!.channel}>${b.service}/${b.s.id}`, link: { channel: feeds[0]!.channel, from: side(a.service, a.s), to: side(b.service, b.s) },
      text: `S2S ${senders.map((x) => `${x.a.service} 的 ${x.a.s.group.name}`).join("、")} → ${b.service} 的 ${b.s.group.name}（端口 ${port}）：${hours.length} 个小时里发出 ${s} 个、收到 ${g} 个，从 ${new Date(off * HOUR).toISOString().slice(0, 13)}:00 起对不上` });
  }
  return out;
}

const CHECKS = ["coverage", "reachable", "no-dangling", "s2s-balance"] as const;

/** The gate over the new models of every touched service at once, against the models they replace. */
export function registrationGate(input: GateInput): GateResult {
  const now = input.now ?? new Date();
  const to = now.toISOString(), from = new Date(now.getTime() - GATE_DAYS * DAY).toISOString();
  const services = new Set(input.draft.map((m) => m.service));
  // The same counts for both sides (read once per service).
  const cache = new Map<string, GateCount[]>();
  const counts = (s: string, f: string, t: string) => { if (!cache.has(s)) cache.set(s, input.counts(s, f, t)); return cache.get(s)!; };
  const ctx = { ...input, counts, from, to, services };
  // Untouched services' models are the same on both sides: the hand-overs into them are judged too.
  const draftAll = [...input.draft, ...input.base.filter((m) => !services.has(m.service))];
  const pb = problemsOf(input.base, { ...ctx, isBase: true }), pd = problemsOf(draftAll, ctx);
  const had = new Set(pb.map((p) => p.key));
  const fresh = pd.filter((p) => !had.has(p.key));
  const checks: GateResult["checks"] = CHECKS.map((check) => {
    const mine = fresh.filter((p) => p.check === check), old = pd.filter((p) => p.check === check && had.has(p.key));
    return { check, ok: !mine.length, text: mine.length ? mine.slice(0, 3).map((p) => p.text).join("；") + (mine.length > 3 ? `；还有 ${mine.length - 3} 处` : "")
      : old.length ? `原有 ${old.length} 处（不是这次改出来的）：${old.slice(0, 2).map((p) => p.text).join("；")}` : "通过" };
  });
  // no-regression: a registered business that had segments and no problem now gets one.
  const regressions: GateResult["regressions"] = [];
  const flows = new Set(input.regs.filter((r) => r.role === "segment").map((r) => r.owner));
  for (const f of flows) {
    if (!input.base.some((m) => m.segments.some((s) => s.flow === f)) || pb.some((p) => p.flow === f)) continue;
    const now = pd.filter((p) => p.flow === f);
    if (now.length) regressions.push({ flow: f, text: `${input.names?.(f) ?? f}：${now[0]!.text}` });
  }
  checks.push({ check: "no-regression", ok: !regressions.length, text: regressions.length ? `${regressions.length} 条原本没问题的业务改坏了：${regressions[0]!.text}` : "通过" });
  return { verdict: checks.some((x) => !x.ok) ? "rejected" : "published", window: { from, to }, checks, problems: fresh, regressions };
}
