// pages-rethink §9.1 A4 (replay gate), A7, A8, B4; §10.2 step 2: the business model v2 written by the AI and kept by
// the gate. The code's skeleton (skeleton.ts) becomes a draft; run_model replays a draft against the last 7 days
// (coverage, reachable, nothing dangling, the two sides of each S2S hand-over agreeing hour by hour, no business that
// was right made wrong) and saves nothing; publish_model runs the same gate and then draws A8's line: changes inside a
// business take effect (and are noted), changes to the list of businesses a person knows wait for that person
// (pending), a draft that fails the gate leaves the model as it was and its businesses' lights unknown. The AI never
// renames a business a person named or confirmed. With e2e_trace configured its schedules are the segments' steps
// (importModel), the AI only places them on the canvas.

import { newFlowId, StoreError, type Actor, type FlowPending, type FlowRecord, type Store } from "../store.ts";
import { topologyFingerprint, type Topology } from "./flowcounts.ts";
import type { GateVerdict, TodoAction } from "./ops-types.ts";
import { skeletonOf, type Skeleton, type SkeletonSegment } from "./skeleton.ts";
import { dangling, links } from "./trace/channels.ts";
import { parseModelV2, toTraceModel, UNPLACED, WHOLE, type Business, type Exit, type FlowNote, type ModelDraft, type ModelV2, type Segment } from "./trace/model.ts";

export const REPLAY_DAYS = 7;
const DAY = 86_400_000;
const HOUR = 3_600_000;
/** B4 defaults until the AI suggests (or a person sets) a business's stuck times. */
export const DEFAULT_STUCK = { attentionMinutes: 10, failingMinutes: 60 };

export type GateCheck = "coverage" | "reachable" | "no-dangling" | "s2s-balance" | "no-regression";
export const GATE_CHECKS: readonly GateCheck[] = ["coverage", "reachable", "no-dangling", "s2s-balance", "no-regression"];
export type ChangeKind = "inside" | "counts" | "cues" | "new" | "gone" | "merge" | "split" | "cross-service";
/** A8: what changes the list of businesses a person knows waits for that person. */
export const NEEDS_PERSON: readonly ChangeKind[] = ["new", "gone", "merge", "split", "cross-service"];

export interface RunResult {
  window: { from: string; to: string };
  verdict: GateVerdict;
  checks: { check: GateCheck; ok: boolean; text: string }[];
  changes: { flow: string | null; kind: ChangeKind; text: string }[];
  regressions: { flow: string; text: string }[];
}
export interface PublishResult {
  verdict: GateVerdict; revision: number | null; reasons: string[];
  pending: { flow: string; kind: string; text: string }[]; todo: string | null;
}

/** Where the gate's to-dos go (service_todos is step 4's; until then nothing is written and todo is null). */
export interface TodoSink {
  open(t: { service: string; flow?: string; source: "gate" | "flows"; key: string; severity: "failing" | "attention"; title: string; detail: string; action?: TodoAction }): string | null;
  /** Closes the open to-do of that key (a later publish holds nothing any more). */
  close?(service: string, key: string): void;
}
export interface ModelDeps {
  store: Store;
  now?: () => Date;
  todos?: TodoSink;
  /** e2e_trace's schedules as businesses (E2eTraceSource.importModel); without it source "e2e_trace" is refused. */
  e2e?: (service: string) => Promise<{ businesses: Business[]; notes: string[] }>;
}

export class ModelError extends Error {
  readonly status: 400 | 409;
  readonly code: string;
  readonly details: string[];
  constructor(status: 400 | 409, code: string, message: string, details: string[] = []) { super(message); this.status = status; this.code = code; this.details = details; }
}

// ---- the gate ---------------------------------------------------------------------------------------------------

interface Problem { check: Exclude<GateCheck, "no-regression">; flow: string | null; key: string; text: string }

/** What the replay reads, once per run: the skeleton, every service's newest model and topology, the window's counts. */
interface Ctx {
  service: string; from: string; to: string; skeleton: Skeleton; registered: Set<string>;
  others: ModelV2[]; topology: (service: string) => Topology | null;
  counts: (service: string) => { kind: string; ref: string; bucket: string; in: number; out: number; moved: number }[];
}

function context(store: Store, service: string, now: Date): Ctx {
  const to = now.toISOString(), from = new Date(now.getTime() - REPLAY_DAYS * DAY).toISOString();
  const topo = new Map<string, Topology | null>(), cnt = new Map<string, ReturnType<Ctx["counts"]>>();
  return {
    service, from, to, skeleton: skeletonOf(store, now),
    registered: new Set([...store.standalones().map((s) => s.id), ...store.clusters().map((s) => s.id)]),
    others: store.flowModels().filter((m) => m.service !== service).map((m) => m.model),
    topology: (s) => {
      if (!topo.has(s)) topo.set(s, (store.latestTopology(s)?.body as Topology | undefined) ?? null);
      return topo.get(s)!;
    },
    counts: (s) => {
      if (!cnt.has(s)) cnt.set(s, store.flowCounts(s, from, to).map((r) => ({ kind: r.kind, ref: r.ref, bucket: r.bucket, in: r.flowfilesIn, out: r.flowfilesOut, moved: r.transferred })));
      return cnt.get(s)!;
    },
  };
}

/** The skeleton units a segment sits on (several when the skeleton split a group the segment takes whole). */
function unitsOf(service: string, s: Segment, sk: Skeleton): SkeletonSegment[] {
  const all = [...sk.flows.flatMap((f) => f.segments), ...sk.shared].filter((u) => u.service === service && u.group.id === s.group.id);
  if (s.slice === WHOLE) return all;
  return all.filter((u) => u.fragment === s.slice || u.fragment === null);
}

const label = (s: Segment) => (s.group.name && s.group.name !== s.id ? `${s.group.name}` : s.id);

const NEW_FLOW = "新的业务：";
/** The flows to-do's one sentence: what waits for a person, counted by kind (diff's texts are per segment, too many to list). */
export function pendingText(held: { flow: string | null; kind: string; text: string }[]): string {
  const distinct = (xs: { flow: string | null; text: string }[]) => new Set(xs.map((x) => x.flow ?? x.text)).size;
  const of = (k: string) => held.filter((x) => x.kind === k);
  const newFlows = held.filter((x) => x.kind === "new" && x.text.startsWith(NEW_FLOW));
  const names = [...new Set(newFlows.map((x) => x.text.slice(NEW_FLOW.length)))];
  const parts = [
    newFlows.length ? `${names.length} 条新业务（${names.slice(0, 5).join("、")}${names.length > 5 ? " 等" : ""}）` : "",
    of("new").length > newFlows.length ? `${of("new").length - newFlows.length} 处新增的组或公共环节` : "",
    of("cross-service").length ? `${of("cross-service").length} 处跨服务连接` : "",
    of("gone").length ? `${distinct(of("gone"))} 条业务的一部分在画布上已没有` : "",
    of("merge").length ? `${of("merge").length} 处要合并的业务` : "",
    of("split").length ? `${of("split").length} 处要拆开的业务` : "",
  ].filter(Boolean);
  return `AI 识别出${parts.length ? ` ${parts.join("、")}` : "业务清单的变化"}，等你在流程页确认。`;
}

function problems(model: ModelV2 | null, c: Ctx): Problem[] {
  if (!model) return [];
  const out: Problem[] = [];
  const all = [model, ...c.others];
  const topology = c.topology(c.service);
  // coverage: every unit under root is in a business or a shared step; every segment is placed on a group.
  if (topology) {
    const units = [...c.skeleton.flows.flatMap((f) => f.segments), ...c.skeleton.shared].filter((u) => u.service === c.service);
    for (const u of units) {
      const covered = model.segments.some((s) => s.group.id === u.group.id && (s.slice === WHOLE || s.slice === u.fragment
        || (u.fragment === null && topology.groups.find((g) => g.id === u.group.id)?.fragments.some((f) => f.key === s.slice))));
      if (!covered) out.push({ check: "coverage", flow: null, key: `coverage:${u.id}`, text: `${u.group.name}${u.fragment ? `（${u.names.slice(0, 3).join("、") || u.fragment} 那一片）` : ""} 不在任何业务或公共环节里` });
    }
  }
  for (const s of model.segments) {
    if (s.group.id === UNPLACED) out.push({ check: "coverage", flow: s.flow ?? null, key: `coverage:unplaced:${s.id}`, text: `段 ${s.id} 还没放到流程组上` });
  }
  // reachable: a business's segments are joined (root links, S2S pairs or the model's channels), and what one sent in
  // the window the next one received.
  const channelLinks = links(all.map(toTraceModel));
  const edges = c.skeleton.edges;
  // Engine test round 3: two groups whose only link is a shared step between them (a common validation that routes by
  // an attribute) are joined through it; which business a FlowFile takes there the shared step decides, not a link.
  const sharedUnits = new Set(c.skeleton.shared.map((u) => u.id));
  const throughShared = (ua: Set<string>, ub: Set<string>) => edges.some((e1) => ua.has(e1.from) && sharedUnits.has(e1.to) && edges.some((e2) => e2.from === e1.to && ub.has(e2.to)));
  const flowsHere = [...new Set(model.segments.map((s) => s.flow).filter((f): f is string => Boolean(f)))];
  for (const f of flowsHere) {
    const members = all.flatMap((m) => m.segments.filter((s) => s.flow === f).map((s) => ({ service: m.service, s })));
    if (members.length < 2) continue;
    const key = (x: { service: string; s: Segment }) => `${x.service}\0${x.s.id}`;
    const unitIds = new Map(members.map((x) => [key(x), new Set(unitsOf(x.service, x.s, c.skeleton).map((u) => u.id))]));
    const adj = new Map(members.map((x) => [key(x), new Set<string>()]));
    const join = (a: string, b: string) => { adj.get(a)?.add(b); adj.get(b)?.add(a); };
    for (const a of members) for (const b of members) {
      if (a === b) continue;
      const ua = unitIds.get(key(a))!, ub = unitIds.get(key(b))!;
      if (edges.some((e) => ua.has(e.from) && ub.has(e.to)) || throughShared(ua, ub)) join(key(a), key(b));
      if (channelLinks.some((l) => l.from.service === a.service && l.from.business === a.s.id && l.to.service === b.service && l.to.business === b.s.id)) join(key(a), key(b));
    }
    const seen = new Set<string>([key(members[0]!)]);
    const stack = [key(members[0]!)];
    while (stack.length) for (const n of adj.get(stack.pop()!) ?? []) if (!seen.has(n)) { seen.add(n); stack.push(n); }
    for (const x of members) if (!seen.has(key(x))) out.push({ check: "reachable", flow: f, key: `reachable:${f}:${key(x)}`, text: `${x.service} 的 ${label(x.s)} 和同一业务的其他段之间没有连线（root 层连线或 S2S）` });
    // The data: a root-level link inside the business where the sender sent and the receiver got nothing.
    for (const a of members) for (const b of members) {
      if (a === b || a.service !== b.service || (a.service !== c.service)) continue;
      const ua = unitIds.get(key(a))!, ub = unitIds.get(key(b))!;
      if (!edges.some((e) => e.kind === "link" && ua.has(e.from) && ub.has(e.to))) continue;
      const totals = (s: Segment) => c.counts(a.service).filter((r) => r.kind === "group" && r.ref === s.group.id);
      const ta = totals(a.s), tb = totals(b.s);
      if (!ta.length || !tb.length) continue;
      const sent = ta.reduce((n, r) => n + r.out, 0), got = tb.reduce((n, r) => n + r.in + r.moved, 0);
      if (sent > 0 && got === 0) out.push({ check: "reachable", flow: f, key: `reachable:data:${key(a)}>${key(b)}`, text: `${label(a.s)} ${REPLAY_DAYS} 天送出 ${sent} 个，${label(b.s)} 一个也没收到` });
    }
  }
  // no-dangling: an S2S hand-over between managed services has both sides in the models (a side whose service has no
  // model yet is waited for; an entry fed from outside the managed services is not dangling); every exit names its
  // component. MQ may lead to and come from outside, so it is not checked.
  // The other side is also waited for when its service has a model but none of it is on the group the canvas shows at
  // the other end yet: two services that already have models each add their side of a new hand-over in their own
  // publish, and neither could go first (engine test 2026-11-22). A port the other canvas does not have stays dangling.
  const modelled = new Set(all.map((m) => m.service));
  const covers = (service: string, group: string) => !!all.find((m) => m.service === service)?.segments.some((s) => s.group.id === group);
  for (const d of dangling(all.map(toTraceModel))) {
    if (d.service !== c.service || !d.channel.startsWith("s2s:")) continue;
    const seg = model.segments.find((s) => s.id === d.business);
    if (d.side === "exit") {
      const [target, port] = d.channel.slice(4).split("/") as [string, string];
      if (!modelled.has(target) && c.registered.has(target)) continue;
      const groups = (c.topology(target)?.s2sIn ?? []).filter((p) => p.name === port).map((p) => p.group);
      if (modelled.has(target) && groups.length && !groups.some((g) => covers(target, g))) continue;
    } else {
      const units = seg ? new Set(unitsOf(c.service, seg, c.skeleton).map((u) => u.id)) : new Set<string>();
      const from = c.skeleton.edges.filter((e) => e.kind === "s2s" && units.has(e.to)).map((e) => e.from.split("/"));
      if (!from.some(([s]) => modelled.has(s!))) continue;
      if (!from.some(([s, g]) => modelled.has(s!) && covers(s!, g!))) continue;
    }
    out.push({ check: "no-dangling", flow: seg?.flow ?? null, key: `dangling:${d.side}:${d.channel}:${d.business}:${d.endpoint}`, text: d.side === "exit" ? `${label(seg ?? ({ id: d.business, group: { name: d.business } } as Segment))} 的出口 ${d.endpoint} 发往 ${d.channel.replace(/^s2s:/, "S2S ").replace(/^mq:/, "MQ ")}，没有哪个服务的模型在这条通道上有入口` : `${d.business} 的入口 ${d.endpoint} 在 ${d.channel.replace(/^s2s:/, "S2S ")} 上收，没有哪个服务的模型往这里发` });
  }
  for (const s of model.segments) for (const e of s.exits) {
    if (!e.component || e.component === UNPLACED) out.push({ check: "no-dangling", flow: s.flow ?? null, key: `exit-component:${s.id}:${e.id}`, text: `${label(s)} 的出口 ${e.id} 没标是哪个组件、哪个关系出去的` });
  }
  // s2s-balance: each S2S hand-over this service sends or receives, the two sides' hourly counts. What a remote input
  // port received: NiFi's port status counts it as the port's out (in stays 0), its connections' history as in.
  for (const l of channelLinks) {
    if (!l.channel.startsWith("s2s:") || (l.from.service !== c.service && l.to.service !== c.service)) continue;
    const fromModel = all.find((m) => m.service === l.from.service)!, toModel = all.find((m) => m.service === l.to.service)!;
    const sender = fromModel.segments.find((s) => s.id === l.from.business)!, receiver = toModel.segments.find((s) => s.id === l.to.business)!;
    const exit = sender.exits.find((e) => e.id === l.from.endpoint)!;
    const port = exit.channel.port!;
    const ts = c.topology(l.from.service), tr = c.topology(l.to.service);
    const flow = (l.from.service === c.service ? sender.flow : receiver.flow) ?? null;
    const key = `s2s:${l.from.service}/${sender.id}/${exit.id}>${l.to.service}/${receiver.id}`;
    if (!ts || !tr) continue;
    const refs = ts.s2sOut.filter((o) => o.name === port && (sender.group.id === UNPLACED || o.group === sender.group.id)).map((o) => o.ref);
    const ids = tr.s2sIn.filter((p) => p.name === port && (receiver.group.id === UNPLACED || p.group === receiver.group.id || p.group === tr.root.id)).map((p) => p.id); // a root-level port feeds the group it links to
    if (!refs.length || !ids.length) {
      out.push({ check: "s2s-balance", flow, key: `${key}:port`, text: `S2S ${l.from.service} → ${l.to.service} 端口 ${port}：${!refs.length ? `${l.from.service} 的 ${label(sender)} 里没有发往这个端口的 RPG` : `${l.to.service} 的 ${label(receiver)} 里没有这个远程输入端口`}` });
      continue;
    }
    const hourly = (rows: ReturnType<Ctx["counts"]>, kind: string, set: string[], pick: (r: ReturnType<Ctx["counts"]>[number]) => number) => {
      const m = new Map<number, number>();
      for (const r of rows) if (r.kind === kind && set.includes(r.ref)) { const h = Math.floor(Date.parse(r.bucket) / HOUR); m.set(h, (m.get(h) ?? 0) + pick(r)); }
      return m;
    };
    // Engine test round 4: a port several services send to (dead letters from every service's error handling) receives
    // their sum; each sender the skeleton links to the receiving unit counts, modelled or not.
    const recvUnits = new Set(unitsOf(l.to.service, receiver, c.skeleton).map((u) => u.id));
    const feeders = [...new Set(c.skeleton.edges.filter((e) => e.kind === "s2s" && recvUnits.has(e.to)).map((e) => e.from))]
      .map((u) => { const [svc, group] = u.split("/") as [string, string]; return { svc, refs: (c.topology(svc)?.s2sOut ?? []).filter((o) => o.name === port && o.group === group).map((o) => o.ref) }; })
      .filter((f) => f.refs.length);
    // Only the hours every sender was counted in (a sender whose RPG the topology did not show yet has no rows then).
    const perFeeder = (feeders.length > 1 ? feeders : [{ svc: l.from.service, refs }]).map((f) => hourly(c.counts(f.svc), "s2s-out", f.refs, (r) => r.out));
    const a = new Map<number, number>();
    for (const m of perFeeder) for (const [h, n] of m) a.set(h, (a.get(h) ?? 0) + n);
    const b = hourly(c.counts(l.to.service), "s2s-in", ids, (r) => Math.max(r.in, r.out));
    if (feeders.length > 1 && out.some((x) => x.check === "s2s-balance" && x.key === `s2s:fan-in:${l.channel}`)) continue;
    const hours = [...a.keys()].filter((h) => b.has(h) && perFeeder.every((m) => m.has(h))).sort((x, y) => x - y);
    if (!hours.length) continue;
    const sent = hours.reduce((n, h) => n + a.get(h)!, 0), got = hours.reduce((n, h) => n + b.get(h)!, 0);
    // A hand-over late by a bucket shows as +n then -n: only a difference that stays is a mismatch.
    const bound = Math.max(5, Math.ceil(0.02 * Math.max(sent, got)));
    let cum = 0, off: number | null = null;
    for (const h of hours) { cum += a.get(h)! - b.get(h)!; if (off === null && Math.abs(cum) > bound) off = h; }
    if (off !== null && Math.abs(cum) > bound) {
      const many = feeders.length > 1;
      out.push({ check: "s2s-balance", flow, key: many ? `s2s:fan-in:${l.channel}` : key, text: `S2S ${many ? feeders.map((f) => f.svc).join("、") : l.from.service} → ${l.to.service} 端口 ${port}：${hours.length} 个小时里发出 ${sent} 个、收到 ${got} 个，从 ${new Date(off * HOUR).toISOString().slice(0, 13)}:00 起对不上` });
    }
  }
  return out;
}

/** A segment's changes against the one it replaces, as change kinds (inside / cues / cross-service). */
function compare(b: Segment, d: Segment): ChangeKind[] {
  const kinds = new Set<ChangeKind>();
  const strip = (s: Segment) => ({ match: s.match, steps: s.steps, entries: s.entries.map(({ cues: _c, ...e }) => e), exits: s.exits.filter((e) => e.channel.type !== "s2s") });
  if (JSON.stringify(strip(b)) !== JSON.stringify(strip(d))) kinds.add("inside");
  if (JSON.stringify(b.entries.map((e) => e.cues ?? [])) !== JSON.stringify(d.entries.map((e) => e.cues ?? []))) kinds.add("cues");
  const s2s = (s: Segment) => JSON.stringify(s.exits.filter((e) => e.channel.type === "s2s").map((e) => [e.channel.service, e.channel.port]).sort());
  if (s2s(b) !== s2s(d)) kinds.add("cross-service");
  return [...kinds];
}

interface Diff {
  changes: RunResult["changes"];
  /** draft flow key -> the business it is (an existing id, or the new key itself). */
  resolve: Map<string, string>;
  /** Segment ids of the base the draft drops, and those whose group is gone from the canvas. */
  removed: string[]; gone: string[];
}

function diff(base: ModelV2 | null, draft: ModelV2, c: Ctx): Diff {
  const changes: RunResult["changes"] = [];
  const bySeg = new Map((base?.segments ?? []).map((s) => [s.id, s]));
  const byPlace = new Map((base?.segments ?? []).filter((s) => s.group.id !== UNPLACED).map((s) => [`${s.group.id}\0${s.slice}`, s]));
  const matched = new Map<string, Segment>(); // draft id -> base segment
  for (const d of draft.segments) {
    const b = bySeg.get(d.id) ?? byPlace.get(`${d.group.id}\0${d.slice}`);
    if (b && ![...matched.values()].includes(b)) matched.set(d.id, b);
  }
  // A new key whose segments all were one business no other key keeps is that business under another name — unless
  // that business has segments in other services too: then this service's part leaves it (a split, engine test
  // 2026-11-22: "split" feedback on a cross-service business was taken as a rename and silently undone).
  const elsewhere = (f: string) => c.others.some((m) => m.segments.some((s) => s.flow === f));
  const resolve = new Map<string, string>();
  const keys = [...new Set(draft.segments.map((s) => s.flow).filter((f): f is string => Boolean(f)))];
  const used = new Set(keys.filter((k) => !k.startsWith("new:")));
  for (const k of keys) {
    if (!k.startsWith("new:")) { resolve.set(k, k); continue; }
    const was = new Set(draft.segments.filter((s) => s.flow === k).map((s) => matched.get(s.id)?.flow).filter(Boolean));
    const only = was.size === 1 ? [...was][0]! : undefined;
    const all = draft.segments.filter((s) => s.flow === k).every((s) => matched.get(s.id)?.flow);
    if (only && all && !used.has(only) && !elsewhere(only)) { resolve.set(k, only); used.add(only); } else resolve.set(k, k);
  }
  const flowOf = (s: Segment) => (s.flow ? resolve.get(s.flow) ?? s.flow : null);
  const topology = c.topology(c.service);
  const onCanvas = (s: Segment) => !topology || s.group.id === UNPLACED || topology.groups.some((g) => g.id === s.group.id);
  for (const d of draft.segments) {
    const b = matched.get(d.id);
    const f = flowOf(d);
    if (!b) {
      if (f && !f.startsWith("new:") && elsewhere(f) && !(base?.segments.some((s) => s.flow === f))) changes.push({ flow: f, kind: "cross-service", text: `${label(d)} 接进别的服务已有的业务，成为它的一段` });
      else changes.push({ flow: f, kind: "new", text: f && !f.startsWith("new:") ? `新的组 ${label(d)} 加进这条业务` : d.role === "shared" ? `新的公共环节 ${label(d)}` : `${NEW_FLOW}${label(d)}` });
      continue;
    }
    if (!onCanvas(d)) changes.push({ flow: f, kind: "gone", text: `${label(d)} 在画布上已没有` });
    for (const k of compare(b, d)) changes.push({ flow: f, kind: k, text: k === "inside" ? `${label(d)} 组内的步骤、条件或出口有变化` : k === "cues" ? `${label(d)} 的线索查法有变化` : `${label(d)} 的 S2S 去向有变化` });
  }
  const removed = (base?.segments ?? []).filter((b) => ![...matched.values()].includes(b)).map((b) => b.id);
  for (const id of removed) { const b = bySeg.get(id)!; changes.push({ flow: b.flow ?? null, kind: "gone", text: `${label(b)} 不在新模型里了` }); }
  const gone = draft.segments.filter((d) => matched.has(d.id) && !onCanvas(d)).map((d) => matched.get(d.id)!.id);
  // merge: one draft business made of several; split: one business spread over several.
  for (const k of new Set(draft.segments.map(flowOf).filter((f): f is string => Boolean(f)))) {
    const from = new Set(draft.segments.filter((s) => flowOf(s) === k).map((s) => matched.get(s.id)?.flow).filter((f): f is string => Boolean(f)));
    if (from.size >= 2) changes.push({ flow: k, kind: "merge", text: `${[...from].length} 条业务合成一条` });
  }
  for (const f of new Set((base?.segments ?? []).map((s) => s.flow).filter((x): x is string => Boolean(x)))) {
    const into = new Set(draft.segments.filter((d) => matched.get(d.id)?.flow === f).map(flowOf));
    if (into.size >= 2) changes.push({ flow: f, kind: "split", text: `一条业务拆成 ${into.size} 条` });
    // A cross-service business whose part here all goes to another business: split across the services.
    else if (into.size === 1 && !into.has(f) && elsewhere(f)) changes.push({ flow: f, kind: "split", text: "这条跨服务业务在本服务的部分拆成另一条业务" });
  }
  return { changes, resolve, removed, gone };
}

function verdictOf(base: Problem[], draft: Problem[], baseModel: ModelV2 | null, draftModel: ModelV2): Omit<RunResult, "window" | "changes" | "verdict"> {
  const had = new Set(base.map((p) => p.key));
  const checks: RunResult["checks"] = [];
  for (const check of ["coverage", "reachable", "no-dangling", "s2s-balance"] as const) {
    const mine = draft.filter((p) => p.check === check);
    const fresh = mine.filter((p) => !had.has(p.key)), old = mine.filter((p) => had.has(p.key));
    checks.push({
      check, ok: fresh.length === 0,
      text: fresh.length ? fresh.slice(0, 3).map((p) => p.text).join("；") + (fresh.length > 3 ? `；还有 ${fresh.length - 3} 处` : "")
        : old.length ? `原有 ${old.length} 处（不是这次改出来的）：${old.slice(0, 2).map((p) => p.text).join("；")}` : "通过",
    });
  }
  // no-regression: a business with no problem under the current model must not get one under the draft.
  const regressions: RunResult["regressions"] = [];
  const flows = new Set([...(baseModel?.segments ?? []), ...draftModel.segments].map((s) => s.flow).filter((f): f is string => Boolean(f) && !f!.startsWith("new:")));
  for (const f of flows) {
    if (!baseModel?.segments.some((s) => s.flow === f)) continue;
    if (base.some((p) => p.flow === f)) continue;
    const now = draft.filter((p) => p.flow === f);
    if (now.length) regressions.push({ flow: f, text: now[0]!.text });
  }
  checks.push({ check: "no-regression", ok: regressions.length === 0, text: regressions.length ? `${regressions.length} 条原本没问题的业务改坏了：${regressions[0]!.text}` : "通过" });
  return { checks, regressions };
}

/** run_model: the draft replayed against the last 7 days, and the verdict a publish would get; nothing is saved. */
export function runModel(store: Store, service: string, draft: ModelV2, now = new Date()): RunResult {
  const c = context(store, service, now);
  return replay(c, store.flowModel(service)?.model ?? null, draft);
}

function replay(c: Ctx, base: ModelV2 | null, draft: ModelV2): RunResult {
  const d = diff(base, draft, c);
  // The draft's own business keys resolved, so problems compare by business.
  const resolved: ModelV2 = { ...draft, segments: draft.segments.map((s) => (s.flow ? { ...s, flow: d.resolve.get(s.flow) ?? s.flow } : s)) };
  const pb = problems(base, c), pd = problems(resolved, c);
  const v = verdictOf(pb, pd, base, resolved);
  const verdict: GateVerdict = v.checks.some((x) => !x.ok) ? "rejected" : d.changes.some((x) => NEEDS_PERSON.includes(x.kind)) ? "needs-confirmation" : "published";
  return { window: { from: c.from, to: c.to }, verdict, ...v, changes: d.changes };
}

// ---- publish ------------------------------------------------------------------------------------------------------

/** Checks a draft's businesses exist, and parses it. */
export function parseDraft(store: Store, service: string, body: unknown): { model: ModelV2; notes: FlowNote[] } {
  const got = parseModelV2(service, body);
  if ("errors" in got) throw new ModelError(400, "flow-model/invalid", "The model is not a valid business model v2.", got.errors);
  const unknown = [...new Set([...got.model.segments.map((s) => s.flow), ...got.notes.map((n) => n.flow)].filter((f): f is string => Boolean(f) && f!.startsWith("flw_") && !store.flow(f!)))];
  if (unknown.length) throw new ModelError(400, "flow-model/unknown-flow", `No business ${unknown.join(", ")}: use an id describe gave, or new:<key> for a new one.`);
  // A group of one part is the whole group: its only fragment's key as the slice means "*" (engine test 2026-11-22:
  // the key made the same place look like a new group and a gone one).
  const topo = store.latestTopology(service)?.body as { groups?: { id: string; fragments?: { key: string }[] }[] } | undefined;
  const only = new Map((topo?.groups ?? []).filter((g) => g.fragments?.length === 1).map((g) => [g.id, g.fragments![0]!.key]));
  got.model.segments = got.model.segments.map((s) => (s.slice !== WHOLE && only.get(s.group.id) === s.slice ? { ...s, slice: WHOLE } : s));
  return got;
}

/** e2e_trace's schedules are the segments (steps, entries, match); the AI's draft only places them (group, slice,
 *  business, exits). A schedule the draft does not place is refused; segments imported before keep their steps when
 *  the AI publishes on its own. */
async function withE2e(d: ModelDeps, service: string, draft: ModelV2, base: ModelV2 | null, source: "ai" | "e2e_trace"): Promise<{ model: ModelV2; notes: string[] }> {
  if (source === "ai") {
    const kept = new Map((base?.segments ?? []).filter((s) => s.origin === "e2e_trace").map((s) => [s.id, s]));
    return { model: { ...draft, segments: draft.segments.map((s) => { const k = kept.get(s.id); return k ? { ...s, name: k.name, match: k.match, steps: k.steps, entries: k.entries, origin: "e2e_trace" as const } : s; }) }, notes: [] };
  }
  if (!d.e2e) throw new ModelError(409, "flow-model/no-e2e", `${service} has no e2e_trace source: configure it, or publish with source "ai".`);
  let got: Awaited<ReturnType<NonNullable<ModelDeps["e2e"]>>>;
  try { got = await d.e2e(service); } catch (error) { throw new ModelError(409, "flow-model/e2e", `e2e_trace: ${(error as Error).message}`); }
  const { businesses, notes } = got;
  // The graph's definitions are every schedule of the environment, not this service's: one whose workers are not on
  // this canvas is left out (2026-11-22 engine test; describe's e2e-unplaced keeps it in view). Placing none is refused.
  const unplaced = businesses.filter((b) => !draft.segments.some((s) => s.id === b.id)).map((b) => `${b.id}（${b.name}）`);
  if (businesses.length && unplaced.length === businesses.length) throw new ModelError(400, "flow-model/e2e-unplaced", `Place the e2e_trace schedules that run on ${service}: a segment with the schedule's id (group, slice, flow) for each, e.g. ${unplaced.slice(0, 5).join(", ")}; publish with source "ai" when none of them runs here.`, notes);
  if (unplaced.length) notes.push(`Not placed in ${service} (left out): ${unplaced.join(", ")}.`);
  const imported = new Map(businesses.map((b) => [b.id, b]));
  const segments = draft.segments.map((s) => {
    const b = imported.get(s.id);
    if (b) return { ...s, name: b.name, match: b.match, steps: b.steps.map(({ maxSeconds: _m, ...x }) => x), entries: b.entries, origin: "e2e_trace" as const };
    // A schedule the definitions no longer have: the segment is the AI's from now on (its own steps).
    if (s.origin === "e2e_trace") { const { origin: _o, ...rest } = s; notes.push(`${s.id} is no longer in e2e_trace's definitions: kept as an ordinary segment.`); return rest; }
    return s;
  });
  const sources = draft.sources.includes("e2e_trace") ? draft.sources : ["e2e_trace", ...(draft.sources.length ? draft.sources : ["provenance"])];
  return { model: { ...draft, sources, segments }, notes };
}

const flowName = (segs: Segment[]) => segs[0]?.group.name || segs[0]?.id || "业务";
/** A8: a name a person gave or confirmed is never changed by the AI. */
export const nameLocked = (f: FlowRecord) => f.nameBy === "person" || f.confirmedAt !== null;

/** publish_model: the gate, then A8's line. `confirm`: a person confirmed the held change (FlowAction confirm), so
 *  nothing is held again. */
export async function publishModel(d: ModelDeps, input: { service: string; base: number; model: unknown; note: string; source?: "ai" | "e2e_trace"; actor: Actor; confirm?: boolean }): Promise<PublishResult> {
  const { store } = d;
  const now = d.now?.() ?? new Date();
  const service = input.service;
  const source = input.source ?? "ai";
  const current = store.flowModel(service);
  if ((current?.revision ?? 0) !== input.base) throw new ModelError(409, "flow-model/stale", `${service}'s model is at revision ${current?.revision ?? 0}, not ${input.base}: read it again (describe) and redo the draft on it.`);
  const parsed = parseDraft(store, service, input.model);
  const placed = await withE2e(d, service, parsed.model, current?.model ?? null, source);
  const draft = placed.model;
  const c = context(store, service, now);
  const run = replay(c, current?.model ?? null, draft);
  const by = input.actor.via === "key" || input.actor.via === "service" ? "ai" : input.actor.id;
  const reasons = [...run.checks.filter((x) => !x.ok).map((x) => `${x.check}: ${x.text}`), ...placed.notes];

  if (run.verdict === "rejected") {
    // The model stays; the businesses the draft broke show unknown (gate-rejected) until a publish passes.
    const flows = new Set([...run.regressions.map((r) => r.flow), ...problems(draft, c).map((p) => p.flow).filter((f): f is string => Boolean(f) && f!.startsWith("flw_"))]);
    let todo: string | null = null;
    store.flowTransaction(() => {
      for (const f of flows) if (store.flow(f)) store.addFlowChange({ flow: f, service, by, kind: "rejected", text: `模型没生效：${reasons[0] ?? ""}`, revision: null, verdict: "rejected" });
      store.addFlowChange({ flow: null, service, by, kind: "rejected", text: `模型没生效（${input.note}）：${reasons.join("；")}`.slice(0, 2000), revision: null, verdict: "rejected" });
    });
    todo = d.todos?.open({ service, source: "gate", key: `gate:${service}`, severity: "attention", title: "AI 改的业务模型没通过回放检查", detail: reasons.join("\n").slice(0, 2000) }) ?? null;
    return { verdict: "rejected", revision: null, reasons, pending: [], todo };
  }

  const diffed = diff(current?.model ?? null, draft, c);
  const held = input.confirm ? [] : run.changes.filter((x) => NEEDS_PERSON.includes(x.kind));
  // Business keys: an existing id, or a new business (its id made now).
  const ids = new Map<string, string>();
  for (const [k, v] of diffed.resolve) ids.set(k, v.startsWith("new:") ? newFlowId() : v);
  const real = (key: string | undefined) => (key ? ids.get(key) ?? key : undefined);
  const notes = new Map(parsed.notes.map((n) => [real(n.flow)!, n]));

  // What takes effect: with nothing held, the draft. Otherwise the current model with the draft's changes inside its
  // businesses, and the draft's wholly new businesses (they are proposed: a person confirms them on the flows page).
  const base = current?.model ?? null;
  const heldFlows = new Set(held.map((x) => (x.flow ? real(x.flow) ?? x.flow : null)).filter((f): f is string => Boolean(f)));
  const draftById = new Map(draft.segments.map((s) => [s.id, s]));
  const placeOf = (s: Segment) => `${s.group.id}\0${s.slice}`;
  const matchedBase = (s: Segment) => (base?.segments ?? []).some((b) => b.id === s.id || (b.group.id !== UNPLACED && placeOf(b) === placeOf(s)));
  // A new business none of whose segments was in the current model takes effect as proposed; the rest waits, keyed
  // as the draft resolved them (new:<key> stays new until the person confirms).
  const cleanNew = new Set([...diffed.resolve].filter(([k, v]) => v.startsWith("new:") && !draft.segments.some((s) => s.flow === k && matchedBase(s))).map(([k]) => k));
  const laterKey = (k: string) => (cleanNew.has(k) || !held.length ? real(k)! : diffed.resolve.get(k) ?? k);
  let effective: ModelV2;
  const pendingSegs: Segment[] = [];
  const pendingRemove: string[] = [];
  if (!held.length) {
    effective = { ...draft, segments: draft.segments.map((s) => (s.flow ? { ...s, flow: real(s.flow)! } : s)) };
  } else {
    const keep: Segment[] = [];
    for (const b of base?.segments ?? []) {
      const dseg = draftById.get(b.id) ?? draft.segments.find((x) => x.group.id !== UNPLACED && placeOf(x) === placeOf(b));
      const f = dseg?.flow ? real(dseg.flow) : undefined;
      const sameFlow = (f ?? null) === (b.flow ?? null);
      if (dseg && sameFlow && !heldFlows.has(b.flow ?? "") && !compare(b, dseg).includes("cross-service")) keep.push({ ...dseg, flow: b.flow, id: b.id });
      else keep.push(b);
      if (!dseg) pendingRemove.push(b.id);
    }
    const known = new Set(keep.map((s) => s.id));
    for (const s of draft.segments) {
      const later = { ...s, ...(s.flow ? { flow: diffed.resolve.get(s.flow) ?? s.flow } : {}) };
      if (matchedBase(s)) { pendingSegs.push(later); continue; }
      const wholeNew = !s.flow || cleanNew.has(s.flow);
      if (wholeNew && !known.has(s.id)) { keep.push({ ...s, ...(s.flow ? { flow: real(s.flow)! } : {}) }); known.add(s.id); }
      else pendingSegs.push(later);
    }
    effective = { ...draft, segments: keep };
  }

  const gate = run.checks;
  let revision = 0;
  const pendingOut: PublishResult["pending"] = [];
  store.flowTransaction(() => {
    revision = store.insertFlowModel(service, input.base, effective, source, input.actor, gate, topologyFingerprint(store.latestTopology(service)?.body as Topology | undefined));
    const at = now.toISOString();
    // Businesses of this service before and after.
    const before = new Set(store.flows(service).map((f) => f.id));
    const after = new Map<string, Segment[]>();
    for (const s of effective.segments) if (s.flow) after.set(s.flow, [...(after.get(s.flow) ?? []), s]);
    for (const [f, segs] of after) {
      const was = store.flow(f);
      const n = notes.get(f);
      const isNew = !was;
      const row: FlowRecord = was ?? {
        id: f, name: n?.name ?? flowName(segs), nameBy: "ai", status: "proposed", summary: n?.summary ?? "", reason: n?.reason ?? null, risks: n?.risks ?? [],
        pending: null, stuck: null, createdAt: at, confirmedAt: null, confirmedBy: null, updatedAt: at,
      };
      if (n) {
        if (n.name && !nameLocked(row)) row.name = n.name;
        if (n.summary !== undefined) row.summary = n.summary;
        if (n.reason !== undefined) row.reason = n.reason;
        if (n.risks) row.risks = n.risks;
        if (n.stuck && row.stuck?.by !== "person") row.stuck = { attentionS: n.stuck.attentionMinutes * 60, failingS: n.stuck.failingMinutes * 60, by: "ai", basis: n.stuck.basis };
        if (n.ignore && row.status === "proposed") row.status = "ignored";
      }
      if (diffed.gone.some((id) => segs.some((s) => s.id === id)) && row.status !== "gone") {
        row.status = "gone";
      }
      store.putFlow(row);
      orderSegments(store, c, f, service, segs, [effective, ...c.others]);
      if (isNew) store.addFlowChange({ flow: f, service, by, kind: "found", text: `AI 识别出这条业务（${segs.map(label).join(" → ")}）`, revision, verdict: run.verdict });
    }
    for (const f of before) if (!after.has(f)) {
      const left = store.flowSegments(f).filter((s) => s.service !== service);
      if (left.length) store.setFlowSegments(f, left);
      else { store.addFlowChange({ flow: f, service, by, kind: "updated", text: "这条业务已没有段（并进了别的业务或已从画布上去掉），从清单里去掉", revision, verdict: run.verdict }); store.deleteFlow(f); }
    }
    // A publish is the AI's whole picture: what an earlier publish of this service held and this one does not hold
    // again is dropped (engine test 2026-11-22: a corrected draft left the first draft's "new / gone" waiting).
    for (const f of store.flows(service)) if (f.pending && f.pending.service === service) store.putFlow({ ...f, pending: null });
    for (const x of run.changes) {
      const f = x.flow ? real(x.flow) ?? null : null;
      if (x.kind === "new" && f && !before.has(f)) continue; // said as "found"
      const isHeld = held.includes(x);
      store.addFlowChange({ flow: f && store.flow(f) ? f : null, service, by, kind: "updated", text: `${isHeld ? "等人确认：" : ""}${x.text}`, revision, verdict: run.verdict });
    }
    if (held.length) {
      const pending: FlowPending = {
        id: `pnd_${revision}_${service}`, kind: held[0]!.kind as FlowPending["kind"], text: held.map((x) => x.text).join("；"), service, at,
        segments: pendingSegs, remove: [...new Set([...pendingRemove, ...diffed.gone])], notes: parsed.notes.map((n) => ({ ...n, flow: laterKey(n.flow) })),
      };
      const targets = new Set<string>();
      for (const x of held) {
        const f = x.flow ? real(x.flow) : undefined;
        if (f && store.flow(f)) targets.add(f);
      }
      for (const id of pending.remove) { const b = base?.segments.find((s) => s.id === id); if (b?.flow && store.flow(b.flow)) targets.add(b.flow); }
      for (const f of targets) {
        const row = store.flow(f)!;
        const mine = held.filter((x) => (x.flow ? real(x.flow) : undefined) === f);
        store.putFlow({ ...row, pending: { ...pending, kind: (mine[0]?.kind ?? pending.kind) as FlowPending["kind"], text: (mine.length ? mine : held).map((x) => x.text).join("；") } });
        pendingOut.push({ flow: f, kind: mine[0]?.kind ?? pending.kind, text: (mine.length ? mine : held).map((x) => x.text).join("；") });
      }
    }
    if (input.confirm) for (const f of after.keys()) { const row = store.flow(f); if (row?.pending) store.putFlow({ ...row, pending: null }); }
  });
  const todo = pendingOut.length
    ? d.todos?.open({ service, source: "flows", key: `flows:${service}`, severity: "attention", title: "Confirm the flows the AI found", detail: pendingText(held), action: { kind: "confirm-flows", label: "Review flows" } }) ?? null
    : null;
  // Nothing waits any more (no held change, no proposed business): the flows to-do is done.
  if (!pendingOut.length && !store.flows(service).some((f) => f.status === "proposed" || f.pending)) d.todos?.close?.(service, `flows:${service}`);
  return { verdict: held.length ? "needs-confirmation" : "published", revision, reasons, pending: pendingOut, todo };
}

/** The flow's segments in order, upstream first: the skeleton's edges and the channels between them; other
 *  services' rows kept. */
function orderSegments(store: Store, c: Ctx, flow: string, service: string, segs: Segment[], models: ModelV2[]) {
  const others = store.flowSegments(flow).filter((s) => s.service !== service);
  const all = [...others.map((s) => ({ service: s.service, segment: s.segment })), ...segs.map((s) => ({ service, segment: s.id }))];
  const segOf = (x: { service: string; segment: string }) => models.find((m) => m.service === x.service)?.segments.find((s) => s.id === x.segment);
  const unit = new Map(all.map((x) => [`${x.service}\0${x.segment}`, new Set((segOf(x) ? unitsOf(x.service, segOf(x)!, c.skeleton) : []).map((u) => u.id))]));
  const ch = links(models.map(toTraceModel));
  const before = (a: typeof all[number], b: typeof all[number]) => {
    const ua = unit.get(`${a.service}\0${a.segment}`)!, ub = unit.get(`${b.service}\0${b.segment}`)!;
    return c.skeleton.edges.some((e) => ua.has(e.from) && ub.has(e.to)) || ch.some((l) => l.from.service === a.service && l.from.business === a.segment && l.to.service === b.service && l.to.business === b.segment);
  };
  const order: typeof all = [];
  const left = [...all];
  while (left.length) {
    const i = left.findIndex((x) => !left.some((y) => y !== x && before(y, x)));
    order.push(...left.splice(i < 0 ? 0 : i, 1));
  }
  store.setFlowSegments(flow, order);
}

/** A person confirmed a business (FlowAction confirm): its held change is applied by publishing the current model
 *  with it, through the gate again; a business gone from the canvas is removed. */
export async function confirmFlow(d: ModelDeps, flow: string, actor: Actor): Promise<{ result: PublishResult | null; removed: boolean }> {
  const { store } = d;
  const row = store.flow(flow);
  if (!row) throw new ModelError(400, "flow/unknown", `No business ${flow}.`);
  const at = (d.now?.() ?? new Date()).toISOString();
  const confirmed = (r: FlowRecord): FlowRecord => ({ ...r, status: r.status === "gone" ? r.status : "confirmed", pending: null, confirmedAt: at, confirmedBy: actor.id });
  const p = row.pending;
  if (!p) {
    if (row.status === "gone") return { result: null, removed: removeFlow(store, row, actor) };
    store.flowTransaction(() => { store.putFlow(confirmed(row)); store.addFlowChange({ flow, service: store.flowSegments(flow)[0]?.service ?? "-", by: actor.id, kind: "confirmed", text: "确认了这条业务", revision: null, verdict: null }); store.auditFlow(actor, flow, "confirm"); });
    return { result: null, removed: false };
  }
  const current = store.flowModel(p.service);
  const model = current?.model ?? { version: 2, service: p.service, sources: [], segments: [] };
  const removedPlaces = new Set(model.segments.filter((s) => p.remove.includes(s.id) && s.group.id !== UNPLACED).map((s) => `${s.group.id}\0${s.slice}`));
  const pend = (p.segments as Segment[]).filter((s) => !p.remove.includes(s.id) && !removedPlaces.has(`${s.group.id}\0${s.slice}`));
  const ids = new Set(pend.map((s) => s.id));
  const places = new Set(pend.filter((s) => s.group.id !== UNPLACED).map((s) => `${s.group.id}\0${s.slice}`));
  const segments = [...model.segments.filter((s) => !p.remove.includes(s.id) && !ids.has(s.id) && !places.has(`${s.group.id}\0${s.slice}`)), ...pend];
  const next: ModelDraft = { ...model, segments, flows: p.notes as FlowNote[] };
  const result = await publishModel(d, { service: p.service, base: current?.revision ?? 0, model: next, note: `确认：${p.text}`, actor, confirm: true });
  if (result.verdict === "rejected") return { result, removed: false };
  store.flowTransaction(() => {
    for (const f of store.flows()) if (f.pending?.id === p.id) store.putFlow({ ...f, pending: null });
    const after = store.flow(flow);
    if (after) store.putFlow(confirmed({ ...after, status: after.status === "gone" ? "confirmed" : after.status }));
    store.addFlowChange({ flow, service: p.service, by: actor.id, kind: "confirmed", text: `确认了变化：${p.text}`, revision: result.revision, verdict: result.verdict });
    store.auditFlow(actor, flow, "confirm");
  });
  return { result, removed: !store.flow(flow) };
}

/** A business gone from the canvas, confirmed: its segments leave the models' business index and the row goes; its
 *  history stays. */
function removeFlow(store: Store, row: FlowRecord, actor: Actor): boolean {
  store.flowTransaction(() => {
    const service = store.flowSegments(row.id)[0]?.service ?? "-";
    store.addFlowChange({ flow: row.id, service, by: actor.id, kind: "confirmed", text: "确认画布上已没有这条业务，从清单里去掉", revision: null, verdict: null });
    store.deleteFlow(row.id);
    store.auditFlow(actor, row.id, "remove");
  });
  return true;
}

/** Whether a business's light is unknown because the last draft touching it failed the gate (and no publish of its
 *  service passed since). */
export function gateRejected(store: Store, flow: string): boolean {
  const last = store.flowChanges({ flow, limit: 20 }).find((c) => c.verdict !== null);
  if (!last || last.verdict !== "rejected") return false;
  const m = store.flowModel(last.service);
  return !m || m.publishedAt <= last.at;
}

// ---- the skeleton as a draft -------------------------------------------------------------------------------------

const segIdOf = (group: string, slice: string) => (slice === WHOLE ? group : `${group.slice(0, 27)}.${slice.slice(0, 36)}`).slice(0, 64);

/** The skeleton of a service as a draft over its current model: segments the model has (by group and slice) are kept,
 *  units it lacks become segments with one step on their group, an entry and the S2S exits the topology shows; a
 *  business the model does not know yet gets new:<skeleton key>. For the AI to name, judge and complete (exits'
 *  components) before run_model. */
export function draftFromSkeleton(store: Store, service: string, now = new Date()): ModelDraft {
  const sk = skeletonOf(store, now);
  const current = store.flowModel(service)?.model ?? null;
  const topo = (store.latestTopology(service)?.body as Topology | undefined) ?? null;
  const segments: Segment[] = [];
  const seen = new Set<string>();
  const known = (u: SkeletonSegment) => current?.segments.find((s) => s.group.id === u.group.id && (s.slice === (u.fragment ?? WHOLE) || s.slice === WHOLE));
  const notes: FlowNote[] = [];
  const units = new Map<string, SkeletonSegment>([...sk.flows.flatMap((f) => f.segments), ...sk.shared].map((x) => [x.id, x]));
  const add = (u: SkeletonSegment, flowKey: string | undefined, role: Segment["role"]) => {
    const k = known(u);
    if (k) { if (!seen.has(k.id)) { segments.push(k); seen.add(k.id); } return k.flow; }
    const slice = u.fragment ?? WHOLE;
    const id = segIdOf(u.group.id, slice);
    if (seen.has(id)) return flowKey;
    seen.add(id);
    const ins = (topo?.s2sIn ?? []).filter((p) => p.group === u.group.id && (u.fragment === null || p.fragment === u.fragment));
    const outs = (topo?.s2sOut ?? []).filter((o) => o.group === u.group.id && (u.fragment === null || o.fragment === u.fragment));
    // The S2S edge this RPG port is: to a business's or a shared step's unit (dead letters go to a shared one) whose
    // service has a remote input port of that name on that group (a fan-out has one edge per target service).
    const edgeTo = (o: { name: string }) => sk.edges.find((e) => {
      if (e.kind !== "s2s" || e.from !== u.id) return false;
      const t = units.get(e.to);
      if (!t) return false;
      const tt = store.latestTopology(t.service)?.body as Topology | undefined;
      return !tt || tt.s2sIn.some((p) => p.name === o.name && p.group === t.group.id);
    });
    const exits: Exit[] = outs.map((o, i) => {
      const target = edgeTo(o)?.to.split("/")[0];
      // Executor 0.9.5 reports what feeds the RPG port: the exit is that component (its first relationship, if any).
      const from = o.sources?.[0];
      return { id: `s2s-${i + 1}`, step: "g", channel: { type: "s2s", service: target ?? "?", port: o.name }, component: from?.id ?? UNPLACED, ...(from?.relationships[0] ? { relationship: from.relationships[0] } : {}) };
    });
    // Executor 0.9.6: the unit's ends (writing processors that lead nowhere on the canvas) are its external exits.
    const ends = (topo?.ends ?? []).filter((x) => x.group === u.group.id && (u.fragment === null || x.fragment === u.fragment));
    exits.push(...ends.map((x, i): Exit => ({ id: `out-${i + 1}`, step: "g", channel: { type: "external", system: x.name }, component: x.id, ...(x.relationships.includes("success") ? { relationship: "success" } : x.relationships[0] ? { relationship: x.relationships[0] } : {}) })));
    segments.push({
      id, name: u.group.name, match: [], steps: [{ id: "g", name: u.group.name, position: { kind: "process-group", id: u.group.id, name: u.group.name } }],
      entries: ins.length ? ins.map((p, i) => ({ id: `s2s-in-${i + 1}`, step: "g", channel: { type: "s2s", port: p.name } })) : [{ id: "in", step: "g", channel: { type: "external", system: "外部来源（待 AI 写明）" } }],
      exits, group: u.group, slice, role, ...(role === "segment" && flowKey ? { flow: flowKey } : {}),
    });
    return flowKey;
  };
  for (const f of sk.flows) {
    if (!f.segments.some((s) => s.service === service)) continue;
    const existing = f.segments.map((u) => (u.service === service ? known(u)?.flow : undefined)).find(Boolean)
      ?? store.flows().find((x) => store.flowSegments(x.id).some((s) => s.service !== service && f.segments.some((u) => {
        // The other service's part by group and, in a group of several pieces, by the piece (two businesses can share a group).
        const m = u.service === s.service ? store.flowModel(s.service)?.model.segments.find((y) => y.id === s.segment) : undefined;
        return !!m && m.group.id === u.group.id && (m.slice === WHOLE || u.fragment === null || m.slice === u.fragment);
      })))?.id;
    const key = existing ?? `new:${f.key.replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 60)}`;
    for (const u of f.segments) if (u.service === service) add(u, key, "segment");
    if (!existing) notes.push({ flow: key, name: f.segments[0]!.group.name, ...(f.reason ? { reason: f.reason } : {}), ...(f.exceptions.includes("idle") ? { ignore: true } : {}) });
  }
  for (const u of sk.shared) if (u.service === service) add(u, undefined, "shared");
  // Segments the canvas no longer has stay (the gate holds their removal for a person).
  for (const s of current?.segments ?? []) if (!seen.has(s.id)) segments.push(s);
  return { version: 2, service, sources: current?.sources ?? [], segments, flows: notes };
}

/** B3 "data dropped": whether a DROP at (component, relationship) is one of the service's marked exits (a normal end). */
export function exitOf(model: ModelV2 | null, component: string, relationship: string | null): { segment: Segment; exit: Exit } | null {
  for (const segment of model?.segments ?? []) for (const exit of segment.exits) {
    if (exit.component === component && (!exit.relationship || exit.relationship === relationship)) return { segment, exit };
  }
  return null;
}

/** §10.1 DROP probe: "Auto-Terminated by <relationship> Relationship" -> the relationship; anything else null. */
export function dropRelationship(details: string | null | undefined): string | null {
  return details?.match(/^Auto-Terminated by (.+) Relationship$/)?.[1] ?? null;
}

export { StoreError };
