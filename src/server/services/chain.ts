// S39 step 3 (business-registration.md §3, §4.3, §7.2–§7.5): the chain of one registration. Given the groups a person
// registered for a business (any depth, any number of services), each service's topology of those groups (the scoped
// body, scope "groups": what the nifi-groups read gives for a preview, or the watch's for a registered business), the
// e2e_trace schedule definitions, the shared modules already registered and the hand-overs the owner told, it says in
// what order the segments come, how each hands over to the next, and where the chain does not close (the gaps a person
// has to answer before committing). A pure function: no store, no executor.
//
// The rules are the skeleton's (skeleton.ts), per registered group instead of per group under root (§7.7 Q1):
//   - a unit is a registered group (or one slice of it); its subgroups are inside it; its pieces stay one segment;
//   - between two registered groups: the parent's connections (topology.links), or a funnel in the parent both touch;
//   - S2S: an RPG's target address (else the port name alone, inferred) and the port name pair it with a remote input
//     port, inside a registered group or beside it in the parent (a 1.x root port passes on what it gets: the groups it
//     feeds receive the data);
//   - MQ: equal exchange/routing key on both sides (the service's Publish/Consume properties, when the caller has them);
//   - 2.x workers: schedule_header/schedule_detail order, a worker placed on the registered group whose name is its
//     worker_name (§7.8 6), the manager on the group named manager_name; a schedule's final worker (final_schedule_seq /
//     final_worker_id) hands over to the next schedule whose trigger it publishes to;
//   - shared modules (§7.2): an exit that reaches a module's entry (input port id, S2S key, MQ key) and back from its exit;
//   - told hand-overs (§7.3): a declared edge with the owner's words, inferred.
// One hop out: what a registered group sends to or gets from anything not registered (a group, a processor or port of
// the parent, an S2S or MQ nobody here receives) is a gap, and so are registered groups not joined to the rest. A
// registered group inside another one of the same registration is refused like a duplicate registration.

import type { Topology, TopologyFragment, TopologyNeighbor } from "./flowcounts.ts";
import { RegError, type Taken } from "./registration.ts";
import { addressOf } from "./skeleton.ts";
import type { Channel, Condition } from "./trace/model.ts";

type Row = Record<string, string | number | null>;

// --- input ------------------------------------------------------------------------------------------------------

/** One registered group: slice "*" (or none) the whole group, else one fragment key (§7.1 "按片分开"). */
export interface ChainGroup { service: string; group: string; slice?: string | null; link?: string | null }
/** An MQ end read from a Publish / Consume processor's properties (side out = publishes). */
export interface ChainMq { group: string; component: string; name?: string; side: "in" | "out"; exchange: string; routingKey: string }
export interface ChainService {
  id: string;
  /** host:port (lower case) the service answers S2S on; every managed service, also those without groups here. */
  addresses: string[];
  /** The scoped topology of this registration's groups on the service (nifi-groups' topology). */
  topology?: Topology | null;
  mq?: ChainMq[];
  /** A group's link in NiFi's UI, "{id}" for the group id (for the gaps' neighbors). */
  linkTemplate?: string | null;
}
/** A registered module's endpoint (§7.2): channel external "port:<id>" is a canvas port (an exit may name it by component). */
export interface ChainModuleEndpoint { id: string; step?: string; channel: Channel; component?: string; relationship?: string; when?: Condition[] }
export interface ChainModule {
  id: string; name: string; service: string; group: { id: string; name: string }; link?: string | null;
  entries: ChainModuleEndpoint[]; exits: ChainModuleEndpoint[];
}
/** A told hand-over (flow_handoffs, §7.3). */
export interface ChainHandoff {
  id: string;
  from: { service: string; group: string; component: string; relationship?: string };
  to: { service: string; group: string } | { system: string };
  quote: string; by?: string; at?: string;
}
/** An S2S sender somewhere on the managed services (their latest topologies, sendersOf): who feeds a remote input port. */
export interface ChainSender { service: string; group: { id: string; name: string }; port: string; targets: string[] }
export interface ChainInput {
  name?: string;
  /** The business, when a registered one is previewed (for the nested-group refusal). */
  flow?: string;
  groups: ChainGroup[];
  services: ChainService[];
  schedules?: { headers: Row[]; details: Row[] };
  modules?: ChainModule[];
  handoffs?: ChainHandoff[];
  /** Known S2S senders (sendersOf over every managed service's latest topology): a registered remote input port fed by
   *  a group not registered here is then a gap, not an entry. Without them such a port is an entry from outside. */
  senders?: ChainSender[];
}

/** The S2S senders in topologies (whole-canvas or scoped): in-group RPG ports and, scoped, the RPGs beside a group. */
export function sendersOf(list: { service: string; topology: Topology | null | undefined }[]): ChainSender[] {
  const out: ChainSender[] = [];
  for (const { service, topology: t } of list) {
    if (!t) continue;
    const name = (id: string) => t.groups.find((g) => g.id === id)?.name ?? (id === t.root.id ? t.root.name : id);
    for (const o of t.s2sOut) out.push({ service, group: { id: o.group, name: name(o.group) }, port: o.name, targets: o.targets });
    for (const n of t.neighbors ?? []) if (n.side === "out" && n.other.kind === "rpg") out.push({ service, group: { id: n.group, name: name(n.group) }, port: n.other.port?.name ?? n.other.name, targets: n.other.targets ?? [] });
  }
  return out;
}

// --- output (§7.5 Preview) ----------------------------------------------------------------------------------------

export type GroupState = "ok" | "missing";
export interface PreviewGroup { ref: string; service: string; group: { id: string; name: string; path: string }; slice: string; link: string | null; state: GroupState; segment?: string }
export interface PreviewSegment {
  id: string; service: string; group: { id: string; name: string }; slice: string;
  role: "segment" | "shared"; module?: string; origin: "topology" | "e2e_trace"; steps: string[]; link: string | null;
}
export type EdgeKind = "link" | "s2s" | "mq" | "schedule" | "shared-entry" | "shared-exit" | "declared";
export type EdgeBasis = "topology" | "rpg-address" | "rpg-name" | "mq-props" | "e2e" | "owner";
export interface PreviewEdge { from: string; to: string; kind: EdgeKind; via: string; basis: EdgeBasis; inferred: boolean; quote?: string; handoff?: string }
export interface PreviewEnd { segment: string; label: string; channel?: string; component?: string }
export type GapKind = "disconnected" | "exit-unregistered" | "entry-unregistered" | "s2s-unpaired" | "mq-unpaired" | "worker-unplaced" | "group-missing";
export interface PreviewGap {
  id: string; kind: GapKind; segment: string | null; text: string;
  neighbor?: { service: string; group?: { id: string; name: string }; port?: string; link?: string | null };
  /** The registered group's component the data leaves by (a declared hand-over names it as from.component). */
  component?: string;
  candidates?: { component: string; name: string }[];
  /** disconnected: the segments of the part not joined to the rest. */
  segments?: string[];
}
export interface Preview {
  name: string; groups: PreviewGroup[]; segments: PreviewSegment[]; layers: string[][]; edges: PreviewEdge[];
  entries: PreviewEnd[]; exits: PreviewEnd[]; gaps: PreviewGap[]; notes: string[];
}

// --- the chain ----------------------------------------------------------------------------------------------------

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();
const str = (v: unknown) => (v === null || v === undefined || v === "" ? undefined : String(v));
const mqKey = (exchange: unknown, routingKey: unknown) => `mq:${exchange}/${routingKey}`;
const portOf = (c: ChainModuleEndpoint): string | undefined => {
  const m = c.channel?.type === "external" ? /^port:(.+)$/.exec(c.channel.system ?? "") : null;
  return m?.[1] ?? (c.channel?.type === "external" ? c.component : undefined);
};

interface Seg extends PreviewSegment { frags: TopologyFragment[]; starts: number }
interface S2sOut { service: string; seg: string; name: string; targets: string[]; component: string; candidates: { component: string; name: string }[] }
interface S2sIn { service: string; seg: string; name: string; id: string }
interface MqEnd { seg: string; key: string; label: string; component: string }

export function chain(input: ChainInput): Preview {
  const services = new Map(input.services.map((s) => [s.id, s]));
  const linkOf = (service: string, id: string) => services.get(service)?.linkTemplate?.replace("{id}", id) ?? null;
  const out: Preview = { name: input.name ?? "", groups: [], segments: [], layers: [], edges: [], entries: [], exits: [], gaps: [], notes: [] };

  // ① The registered groups: found, not nested in each other, one segment each (or per slice).
  const seen = new Set<string>();
  const found: { g: ChainGroup; tg: Topology["groups"][number]; t: Topology; slice: string }[] = [];
  for (const g of input.groups) {
    const slice = g.slice && g.slice !== "*" ? g.slice : "*";
    const key = `${g.service}\0${g.group}\0${slice}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const t = services.get(g.service)?.topology ?? null;
    const tg = t?.groups.find((x) => x.id === g.group);
    const ref = `g${out.groups.length + 1}`;
    const okSlice = slice === "*" || Boolean(tg?.fragments.some((f) => f.key === slice));
    const path = tg ? [...(tg.path ?? []).map((p) => p.name), tg.name].join(" / ") : "";
    out.groups.push({ ref, service: g.service, group: { id: g.group, name: tg?.name ?? g.group, path }, slice, link: g.link ?? linkOf(g.service, g.group), state: tg && okSlice ? "ok" : "missing" });
    if (!t || !tg || !okSlice) {
      out.gaps.push({ id: "", kind: "group-missing", segment: null, neighbor: { service: g.service, group: { id: g.group, name: tg?.name ?? g.group }, link: g.link ?? null },
        text: !t ? `${g.service} 没有这些组的拓扑（还没现读到），组 ${g.group} 串不起来。`
          : !tg ? `${g.service} 上没有组 ${g.group}（可能已删除）。` : `${g.service} 的组 ${tg.name} 里已经没有登记的那一片（${slice}）。` });
      continue;
    }
    found.push({ g, tg, t, slice });
  }
  const nested: Taken[] = [];
  for (const a of found) for (const b of found) {
    if (a !== b && a.g.service === b.g.service && (b.tg.path ?? []).some((p) => p.id === a.tg.id)) {
      nested.push({ service: b.g.service, group: { id: b.tg.id, name: b.tg.name }, relation: "inside", by: { kind: "flow", id: input.flow ?? "", name: input.name ?? "", registeredBy: "" } });
    }
  }
  if (nested.length) {
    throw new RegError("register/group-taken", `登记的组里有嵌套：${nested.map((n) => `${n.service} 的 ${n.group.name}`).join("、")} 在同一条业务登记的另一个组里面，登记外层的组就包含了它。`,
      { taken: nested, options: [] });
  }

  const segs = new Map<string, Seg>();
  const byGroup = new Map<string, Seg[]>();
  for (const { g, tg, slice } of found) {
    const frags = slice === "*" ? tg.fragments : tg.fragments.filter((f) => f.key === slice);
    const seg: Seg = {
      id: `s${segs.size + 1}`, service: g.service, group: { id: tg.id, name: tg.name }, slice, role: "segment", origin: "topology", steps: [],
      link: g.link ?? linkOf(g.service, tg.id), frags, starts: frags.reduce((n, f) => n + f.starts - f.remoteIn.length, 0),
    };
    segs.set(seg.id, seg);
    byGroup.set(`${g.service}\0${tg.id}`, [...(byGroup.get(`${g.service}\0${tg.id}`) ?? []), seg]);
    out.groups.find((x) => x.service === g.service && x.group.id === tg.id && x.slice === slice)!.segment = seg.id;
    if (slice === "*" && frags.length > 1) out.notes.push(`${g.service} 的 ${tg.name} 里有 ${frags.length} 片互不相连的部分，按登记算一段。`);
    if (!frags.length) out.notes.push(`${g.service} 的 ${tg.name} 是空组。`);
  }
  /** The segment of a component's fragment in a registered group (a slice, else the whole group). */
  const resolve = (service: string, group: string, fragment: string | null | undefined): Seg | undefined => {
    const all = byGroup.get(`${service}\0${group}`) ?? [];
    return (fragment ? all.find((s) => s.slice === fragment) : undefined) ?? all.find((s) => s.slice === "*") ?? (all.length === 1 ? all[0] : undefined);
  };
  /** The segment one of the group's own ports is in. */
  const byPort = (service: string, group: string, port: string, side: "in" | "out"): Seg | undefined => {
    const all = byGroup.get(`${service}\0${group}`) ?? [];
    return all.find((s) => s.frags.some((f) => (side === "in" ? f.inputs : f.outputs).includes(port))) ?? resolve(service, group, null);
  };
  const parentName = (service: string, group: string) => {
    const tg = found.find((x) => x.g.service === service && x.tg.id === group)?.tg;
    return tg?.path?.[tg.path.length - 1]?.name ?? "上一层";
  };

  // Modules: by canvas port id and by channel key; a module becomes a segment (role shared) once something reaches it.
  const modEntryPort = new Map<string, ChainModule>(), modExitPort = new Map<string, ChainModule>();
  const modEntryKey = new Map<string, ChainModule[]>(), modExitKey = new Map<string, ChainModule[]>();
  const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => m.set(k, [...(m.get(k) ?? []), v]);
  const keyOf = (svc: string, c: Channel, side: "entry" | "exit") =>
    c.type === "s2s" ? `s2s:${side === "entry" ? svc : c.service ?? svc}/${c.port}` : c.type === "mq" ? mqKey(c.exchange, c.routingKey) : null;
  for (const m of input.modules ?? []) {
    for (const e of m.entries) { const p = portOf(e); if (p) modEntryPort.set(`${m.service}\0${p}`, m); const k = keyOf(m.service, e.channel, "entry"); if (k) push(modEntryKey, k, m); }
    for (const e of m.exits) { const p = portOf(e) ?? e.component; if (p) modExitPort.set(`${m.service}\0${p}`, m); const k = keyOf(m.service, e.channel, "exit"); if (k) push(modExitKey, k, m); }
  }
  const modSegs = new Map<string, PreviewSegment>();
  const modSeg = (m: ChainModule): string => {
    let s = modSegs.get(m.id);
    if (!s) {
      s = { id: `m${modSegs.size + 1}`, service: m.service, group: m.group, slice: "*", role: "shared", module: m.id, origin: "topology", steps: [], link: m.link ?? linkOf(m.service, m.group.id) };
      modSegs.set(m.id, s);
    }
    return s.id;
  };

  /** component: on a shared-entry, the registered group's component the data leaves by. */
  const edges = new Map<string, PreviewEdge & { component?: string }>();
  const edge = (e: PreviewEdge & { component?: string }) => {
    if (e.from === e.to) return;
    const k = `${e.from}\0${e.to}\0${e.kind}\0${e.via}`;
    if (!edges.has(k)) edges.set(k, e);
  };
  const gap = (g: Omit<PreviewGap, "id">) => out.gaps.push({ id: "", ...g });
  const nb = (service: string, group: { id: string; name: string } | undefined, port?: string) =>
    ({ service, ...(group ? { group, link: linkOf(service, group.id) } : {}), ...(port ? { port } : {}) });

  // ② Canvas: links between registered groups, the one hop out (neighbors), S2S both ways.
  const s2sOut: S2sOut[] = [], s2sIn: S2sIn[] = [];
  for (const s of input.services) {
    const t = s.topology;
    if (!t) continue;
    for (const l of t.links) {
      const from = resolve(s.id, l.from.group, l.from.fragment), to = resolve(s.id, l.to.group, l.to.fragment);
      if (from && to) edge({ from: from.id, to: to.id, kind: "link", via: `${l.from.port ?? "?"} → ${l.to.port ?? "?"}`, basis: "topology", inferred: false });
    }
    const funnels = new Map<string, { name: string; group: string; ins: { seg: Seg; n: TopologyNeighbor }[]; outs: { seg: Seg; n: TopologyNeighbor }[] }>();
    for (const n of t.neighbors ?? []) {
      const seg = byPort(s.id, n.group, n.port.name, n.side);
      if (!seg) continue;
      const o = n.other;
      if (o.kind === "group") {
        const mine = byGroup.has(`${s.id}\0${o.id}`);
        if (mine) {
          const other = byPort(s.id, o.id, o.port?.name ?? "", n.side === "out" ? "in" : "out")!;
          const [a, b, pa, pb] = n.side === "out" ? [seg, other, n.port.name, o.port?.name] : [other, seg, o.port?.name, n.port.name];
          edge({ from: a.id, to: b.id, kind: "link", via: `${pa ?? "?"} → ${pb ?? "?"}`, basis: "topology", inferred: false });
          continue;
        }
        const m = o.port ? (n.side === "out" ? modEntryPort : modExitPort).get(`${s.id}\0${o.port.id}`) : undefined;
        if (m) {
          if (n.side === "out") edge({ from: seg.id, to: modSeg(m), kind: "shared-entry", via: `${n.port.name} → ${m.name}.${o.port!.name}`, basis: "topology", inferred: false, component: n.port.id });
          else edge({ from: modSeg(m), to: seg.id, kind: "shared-exit", via: `${m.name}.${o.port!.name} → ${n.port.name}`, basis: "topology", inferred: false });
          continue;
        }
        if (n.side === "out") gap({ kind: "exit-unregistered", segment: seg.id, component: n.port.id, neighbor: nb(s.id, { id: o.id, name: o.name }, o.port?.name),
          text: `${seg.group.name} 的输出端口 ${n.port.name} 连到没登记的组 ${o.name}${o.port ? ` 的 ${o.port.name}` : ""}。` });
        else gap({ kind: "entry-unregistered", segment: seg.id, neighbor: nb(s.id, { id: o.id, name: o.name }, o.port?.name),
          text: `${seg.group.name} 的输入端口 ${n.port.name} 从没登记的组 ${o.name}${o.port ? ` 的 ${o.port.name}` : ""} 收数据。` });
        continue;
      }
      if (o.kind === "rpg") {
        if (n.side === "out") s2sOut.push({ service: s.id, seg: seg.id, name: o.port?.name ?? o.name, targets: o.targets ?? [], component: n.port.id, candidates: [{ component: n.port.id, name: n.port.name }] });
        else out.entries.push({ segment: seg.id, label: `S2S 从 ${o.name} 拉取 ${o.port?.name ?? ""}`.trim(), component: n.port.id });
        continue;
      }
      if (o.kind === "port" && n.side === "in" && o.remote) { s2sIn.push({ service: s.id, seg: seg.id, name: o.name, id: o.id }); continue; }
      if (o.kind === "funnel") {
        const f = funnels.get(o.id) ?? { name: o.name, group: o.group, ins: [], outs: [] };
        (n.side === "out" ? f.ins : f.outs).push({ seg, n });
        funnels.set(o.id, f);
        continue;
      }
      // A processor or a port of the parent: the data goes on (or comes from) where nothing is registered.
      const parent = { id: o.group, name: parentName(s.id, n.group) };
      const what = o.kind === "port" ? `${parent.name} 的${n.side === "out" ? "输出" : "输入"}端口 ${o.name}` : `${parent.name} 里的${o.kind === "processor" ? "处理器" : ` ${o.kind} `} ${o.name}`;
      if (n.side === "out") gap({ kind: "exit-unregistered", segment: seg.id, component: n.port.id, neighbor: nb(s.id, parent), candidates: [{ component: n.port.id, name: n.port.name }],
        text: `${seg.group.name} 的输出端口 ${n.port.name} 接到${what}，那里没有登记。` });
      else gap({ kind: "entry-unregistered", segment: seg.id, neighbor: nb(s.id, parent), text: `${seg.group.name} 的输入端口 ${n.port.name} 从${what}收数据，那里没有登记。` });
    }
    // A funnel in the parent only passes data on: the groups feeding it hand over to the groups it feeds.
    for (const f of funnels.values()) {
      for (const a of f.ins) for (const b of f.outs) edge({ from: a.seg.id, to: b.seg.id, kind: "link", via: `${a.n.port.name} → 漏斗 → ${b.n.port.name}`, basis: "topology", inferred: false });
      const parent = { id: f.group, name: (f.ins[0] ?? f.outs[0]) ? parentName(s.id, (f.ins[0] ?? f.outs[0]).n.group) : "上一层" };
      if (!f.outs.length) for (const a of f.ins) gap({ kind: "exit-unregistered", segment: a.seg.id, component: a.n.port.id, neighbor: nb(s.id, parent),
        candidates: [{ component: a.n.port.id, name: a.n.port.name }], text: `${a.seg.group.name} 的输出端口 ${a.n.port.name} 接到 ${parent.name} 里的漏斗，往后没有登记的组。` });
      if (!f.ins.length) for (const b of f.outs) gap({ kind: "entry-unregistered", segment: b.seg.id, neighbor: nb(s.id, parent), text: `${b.seg.group.name} 的输入端口 ${b.n.port.name} 从 ${parent.name} 里的漏斗收数据，往前没有登记的组。` });
    }
    for (const o of t.s2sOut) {
      const seg = resolve(s.id, o.group, o.fragment);
      if (!seg) continue;
      const candidates = (o.sources ?? []).map((x) => ({ component: x.id, name: x.name }));
      s2sOut.push({ service: s.id, seg: seg.id, name: o.name, targets: o.targets, component: candidates[0]?.component ?? o.ref, candidates });
    }
    for (const p of t.s2sIn) {
      const seg = resolve(s.id, p.group, p.fragment);
      if (seg) s2sIn.push({ service: s.id, seg: seg.id, name: p.name, id: p.id });
    }
  }
  const fed = new Set<S2sIn>();
  for (const o of s2sOut) {
    const targets = new Set(o.targets.map(addressOf).filter((a): a is string => Boolean(a)));
    const byAddress = input.services.filter((b) => b.addresses.some((a) => targets.has(a.toLowerCase())));
    const label = `S2S ${byAddress[0]?.id ?? o.targets.join(", ")}/${o.name}`;
    let to = s2sIn.filter((p) => p.name === o.name && byAddress.some((b) => b.id === p.service));
    let mods = byAddress.flatMap((b) => modEntryKey.get(`s2s:${b.id}/${o.name}`) ?? []);
    let basis: EdgeBasis = "rpg-address";
    if (!byAddress.length) {
      basis = "rpg-name";
      to = s2sIn.filter((p) => p.name === o.name && p.service !== o.service);
      mods = (input.modules ?? []).filter((m) => m.service !== o.service && m.entries.some((e) => e.channel?.type === "s2s" && e.channel.port === o.name));
      const svcs = new Set([...to.map((p) => p.service), ...mods.map((m) => m.service)]);
      if (svcs.size > 1) {
        gap({ kind: "s2s-unpaired", segment: o.seg, component: o.component, candidates: o.candidates, neighbor: { service: [...svcs].join(", "), port: o.name },
          text: `发往 ${o.targets.join(", ")} 端口 ${o.name} 的 S2S 地址对不上受管服务，同名端口在 ${[...svcs].join("、")} 都有，要问负责人接的是哪个。` });
        continue;
      }
    }
    for (const p of to) {
      edge({ from: o.seg, to: p.seg, kind: "s2s", via: `S2S ${p.service}/${o.name}`, basis, inferred: basis === "rpg-name" });
      fed.add(p);
    }
    for (const m of mods) edge({ from: o.seg, to: modSeg(m), kind: "shared-entry", via: `S2S ${m.service}/${o.name}`, basis, inferred: basis === "rpg-name", component: o.component });
    if (to.length || mods.length) {
      if (basis === "rpg-name") out.notes.push(`${segs.get(o.seg)!.group.name} 发往 ${o.targets.join(", ")} 的 S2S 地址对不上受管服务，按端口名 ${o.name} 接上，要确认一次。`);
      continue;
    }
    if (byAddress.length) gap({ kind: "exit-unregistered", segment: o.seg, component: o.component, candidates: o.candidates, neighbor: { service: byAddress[0].id, port: o.name },
      text: `${segs.get(o.seg)!.group.name} 经 ${label} 发出，${byAddress[0].id} 上收这个端口的组没有登记。` });
    else gap({ kind: "s2s-unpaired", segment: o.seg, component: o.component, candidates: o.candidates, neighbor: { service: "", port: o.name },
      text: `${segs.get(o.seg)!.group.name} 发往 ${o.targets.join(", ")} 端口 ${o.name} 的 S2S 对不上任何受管服务（可能发往没接管的 NiFi），要问负责人交到哪里。` });
  }
  for (const p of s2sIn) {
    if (fed.has(p)) continue;
    const mods = modExitKey.get(`s2s:${p.service}/${p.name}`) ?? [];
    for (const m of mods) edge({ from: modSeg(m), to: p.seg, kind: "shared-exit", via: `S2S ${p.service}/${p.name}`, basis: "rpg-address", inferred: false });
    if (mods.length) continue;
    const mine = new Set((services.get(p.service)?.addresses ?? []).map((a) => a.toLowerCase()));
    const from = (input.senders ?? []).filter((x) => x.port === p.name && !byGroup.has(`${x.service}\0${x.group.id}`) && !(input.modules ?? []).some((m) => m.service === x.service && m.group.id === x.group.id)
      && x.targets.some((u) => mine.has(addressOf(u) ?? "")));
    for (const x of from) gap({ kind: "entry-unregistered", segment: p.seg, neighbor: nb(x.service, x.group, p.name),
      text: `${segs.get(p.seg)!.group.name} 的远程输入端口 ${p.name} 由 ${x.service} 的 ${x.group.name} 经 S2S 送来，那个组没有登记。` });
    if (!from.length) out.entries.push({ segment: p.seg, label: `S2S ${p.name}`, channel: `s2s:${p.service}/${p.name}`, component: p.id });
  }

  // ③ Schedules (2.x): workers by worker_name = group name, the manager by manager_name; triggers and final workers.
  const byName = new Map<string, Seg[]>();
  for (const s of segs.values()) push(byName, norm(s.group.name), s);
  const place = (name: unknown): Seg | undefined => {
    const all = byName.get(norm(name)) ?? [];
    return new Set(all.map((s) => `${s.service}\0${s.group.id}`)).size === 1 ? all[0] : undefined;
  };
  const triggers: (MqEnd & { schedule: string })[] = [];
  const finals = new Map<string, { schedule: string; worker: string }[]>();
  const workerKeys = new Set<string>();
  const { headers = [], details = [] } = input.schedules ?? {};
  for (const h of [...headers].sort((a, b) => Number(a.schedule_id) - Number(b.schedule_id))) {
    const name = String(h.schedule_name ?? `schedule ${h.schedule_id}`);
    let rows = details.filter((d) => Number(d.schedule_id) === Number(h.schedule_id)).sort((a, b) => Number(a.schedule_seq) - Number(b.schedule_seq));
    for (const d of rows) {
      if (str(d.worker_exchange_name) && str(d.worker_routing_key)) workerKeys.add(mqKey(d.worker_exchange_name, d.worker_routing_key));
      if (str(d.manager_exchange_name) && str(d.manager_routing_key)) workerKeys.add(mqKey(d.manager_exchange_name, d.manager_routing_key));
    }
    const finalSeq = str(h.final_schedule_seq) ? Number(h.final_schedule_seq) : undefined;
    const finalRow = rows.find((d) => str(h.final_worker_id) !== undefined && Number(d.worker_id) === Number(h.final_worker_id))
      ?? (finalSeq !== undefined ? rows.find((d) => Number(d.schedule_seq) === finalSeq) : undefined);
    if (finalRow) rows = rows.filter((d) => Number(d.schedule_seq) <= Number(finalRow.schedule_seq));
    const placed = rows.map((d) => place(d.worker_name));
    const manager = place(h.manager_name);
    if (!placed.some(Boolean) && !manager) continue;
    if (str(h.final_worker_id) !== undefined && !finalRow) out.notes.push(`schedule ${name}：final_worker_id ${h.final_worker_id} 不在它的步骤里。`);
    if (manager) { manager.origin = "e2e_trace"; manager.steps.push(String(h.manager_name)); }
    let prev: { seg: Seg; seq: number } | undefined;
    const skipped: string[] = [];
    rows.forEach((d, i) => {
      const seg = placed[i];
      const worker = String(d.worker_name ?? `worker ${d.worker_id}`);
      if (!seg) {
        const near = placed.slice(0, i).reverse().find(Boolean) ?? placed.slice(i + 1).find(Boolean) ?? manager;
        gap({ kind: "worker-unplaced", segment: near?.id ?? null, neighbor: { service: "" },
          text: `schedule ${name} 第 ${d.schedule_seq} 步 ${worker} 对不上登记的组（按组名对 worker_name），要问负责人它在哪个组，或者不在 NiFi 上。` });
        skipped.push(`第 ${d.schedule_seq} 步 ${worker}`);
        return;
      }
      seg.origin = "e2e_trace";
      if (!seg.steps.includes(worker)) seg.steps.push(worker);
      const from = prev?.seg ?? manager;
      if (from) edge({ from: from.id, to: seg.id, kind: "schedule", basis: "e2e", inferred: false,
        via: `schedule ${name} ${prev ? `${prev.seq}→${d.schedule_seq}` : `调度 → ${d.schedule_seq}`}${skipped.length ? `（跳过没对上的${skipped.join("、")}）` : ""}` });
      skipped.length = 0;
      prev = { seg, seq: Number(d.schedule_seq) };
    });
    const first = manager ?? placed.find(Boolean);
    const ex = str(h.trigger_exchange_name), rk = str(h.trigger_routing_key);
    if (first && ex && rk) triggers.push({ seg: first.id, key: mqKey(ex, rk), label: `schedule ${name} 的 trigger MQ ${ex}/${rk}`, component: "", schedule: name });
    else if (first) out.entries.push({ segment: first.id, label: `schedule ${name} 的 trigger（定义里没写 MQ）` });
    const last = finalRow ? placed[rows.indexOf(finalRow)] : undefined;
    if (last && finalRow) {
      push(finals, last.id, { schedule: name, worker: String(finalRow.worker_name) });
      out.exits.push({ segment: last.id, label: `schedule ${name} 收尾：第 ${finalRow.schedule_seq} 步 ${finalRow.worker_name}（final，之后接下一个 trigger）` });
    }
  }

  // ④ MQ: the services' Publish / Consume ends (worker / manager queues are the schedule's own), triggers as entries.
  const mqOut: MqEnd[] = [], mqIn: MqEnd[] = [...triggers];
  for (const s of input.services) for (const m of s.mq ?? []) {
    const seg = resolve(s.id, m.group, null);
    const key = mqKey(m.exchange, m.routingKey);
    if (!seg || workerKeys.has(key)) continue;
    (m.side === "out" ? mqOut : mqIn).push({ seg: seg.id, key, label: `MQ ${m.exchange}/${m.routingKey}`, component: m.component });
  }
  const gotMq = new Set<MqEnd>();
  for (const o of mqOut) {
    const to = mqIn.filter((i) => i.key === o.key);
    const mods = modEntryKey.get(o.key) ?? [];
    for (const i of to) {
      gotMq.add(i);
      const t = triggers.find((x) => x === i);
      const fin = finals.get(o.seg)?.[0];
      if (t) edge({ from: o.seg, to: i.seg, kind: "schedule", basis: "mq-props", inferred: false, via: `${fin ? `schedule ${fin.schedule} 收尾` : o.label} → schedule ${t.schedule} trigger ${o.key.slice(3)}` });
      else edge({ from: o.seg, to: i.seg, kind: "mq", basis: "mq-props", inferred: true, via: o.label });
    }
    for (const m of mods) edge({ from: o.seg, to: modSeg(m), kind: "shared-entry", basis: "mq-props", inferred: true, via: o.label, component: o.component });
    if (!to.length && !mods.length) gap({ kind: "mq-unpaired", segment: o.seg, component: o.component, candidates: [{ component: o.component, name: o.label }],
      text: `${segs.get(o.seg)!.group.name} 发到 ${o.label}，这条业务里没有组收它，要问负责人交到哪里。` });
  }
  for (const i of mqIn) {
    if (gotMq.has(i)) continue;
    const mods = modExitKey.get(i.key) ?? [];
    for (const m of mods) edge({ from: modSeg(m), to: i.seg, kind: "shared-exit", basis: "mq-props", inferred: true, via: i.label });
    if (!mods.length) out.entries.push({ segment: i.seg, label: i.label, channel: i.key, ...(i.component ? { component: i.component } : {}) });
  }

  // ⑤ Told hand-overs: a declared edge with the owner's words; the exit it answers is no longer a gap.
  for (const h of input.handoffs ?? []) {
    const from = resolve(h.from.service, h.from.group, null);
    const to = "system" in h.to ? undefined : resolve(h.to.service, h.to.group, null);
    // A told hand-over whose group is no longer registered: the data still goes (or comes) there.
    if (!from && to) { gap({ kind: "entry-unregistered", segment: to.id, neighbor: nb(h.from.service, { id: h.from.group, name: h.from.group }),
      text: `负责人说过 ${h.from.service} 的组 ${h.from.group} 交给 ${to.group.name}（${h.id}），那个组现在没有登记。` }); continue; }
    if (!from) { out.notes.push(`口头交接 ${h.id} 的起点 ${h.from.service}/${h.from.group} 不是这条业务登记的组，没画。`); continue; }
    out.gaps = out.gaps.filter((g) => !(g.segment === from.id && g.component === h.from.component && ["exit-unregistered", "s2s-unpaired", "mq-unpaired"].includes(g.kind)));
    if ("system" in h.to) {
      out.exits.push({ segment: from.id, label: `交到 NiFi 外：${h.to.system}（负责人说明）`, component: h.from.component, channel: `declared:${h.id}` });
      continue;
    }
    if (!to) { gap({ kind: "exit-unregistered", segment: from.id, component: h.from.component, neighbor: nb(h.to.service, { id: h.to.group, name: h.to.group }),
      text: `负责人说过 ${from.group.name} 交给 ${h.to.service} 的组 ${h.to.group}（${h.id}），那个组现在没有登记。` }); continue; }
    edge({ from: from.id, to: to.id, kind: "declared", via: `负责人说明 ${h.id}`, basis: "owner", inferred: true, quote: h.quote, handoff: h.id });
  }

  // ⑥ The exits (where data leaves NiFi) and the starts of each segment.
  const segList = [...segs.values()];
  for (const s of segList) {
    const t = services.get(s.service)!.topology!;
    for (const e of t.ends ?? []) if (e.group === s.group.id && (s.slice === "*" || e.fragment === s.slice)) out.exits.push({ segment: s.id, label: e.name, component: e.id });
    if (s.starts > 0) out.entries.push({ segment: s.id, label: `${s.group.name}：${s.starts} 个起点处理器` });
  }

  // Data has to start somewhere: with no start of its own, no entry from outside and only modules feeding it, what
  // feeds the module for this business is not registered.
  if (segList.length && !out.entries.length && !out.gaps.some((g) => g.kind === "entry-unregistered")) {
    const fedBy = [...edges.values()].find((e) => e.kind === "shared-exit" && segs.has(e.to));
    const m = fedBy ? modSegs.get([...modSegs.entries()].find(([, s]) => s.id === fedBy.from)![0]) : undefined;
    const at = fedBy ? segs.get(fedBy.to)! : segList[0];
    gap({ kind: "entry-unregistered", segment: at.id, ...(m ? { neighbor: nb(m.service, m.group) } : {}),
      text: `这条业务没有自己的起点${m ? `：数据从公共模块 ${m.group.name} 进到 ${at.group.name}，模块前面是哪个组没有登记` : `，${at.group.name} 的数据从哪来要问负责人`}。` });
  }
  // A module that passes data on (it has exits) but none of its exits comes back here: where it goes is not registered.
  for (const e of [...edges.values()]) {
    if (e.kind !== "shared-entry" || !segs.has(e.from)) continue;
    const id = [...modSegs.entries()].find(([, s]) => s.id === e.to)![0];
    const m = (input.modules ?? []).find((x) => x.id === id)!;
    if (!m.exits.length || [...edges.values()].some((x) => x.kind === "shared-exit" && x.from === e.to && segs.has(x.to))) continue;
    gap({ kind: "exit-unregistered", segment: e.from, ...(e.component ? { component: e.component } : {}), neighbor: nb(m.service, m.group),
      text: `${segs.get(e.from)!.group.name} 经 ${e.via} 进了公共模块 ${m.name}，模块的出口没有接回这条业务登记的组。` });
  }

  // ⑦ One business: registered segments not joined to the rest (through a module only from its entry to its exit).
  out.edges = [...edges.values()].map(({ component: _c, ...e }) => e).sort((a, b) => order(a.from, b.from) || order(a.to, b.to) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  const up = new Map<string, string>();
  const find = (x: string): string => { while (up.has(x) && up.get(x) !== x) x = up.get(x)!; return x; };
  const join = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) up.set(rb, ra); };
  const into = new Map<string, string[]>(), outOf = new Map<string, string[]>();
  for (const e of out.edges) {
    if (segs.has(e.from) && segs.has(e.to)) join(e.from, e.to);
    else if (e.kind === "shared-entry") push(into, e.to, e.from);
    else if (e.kind === "shared-exit") push(outOf, e.from, e.to);
  }
  for (const [m, xs] of into) for (const x of xs) for (const y of outOf.get(m) ?? []) join(x, y);
  const parts = new Map<string, Seg[]>();
  for (const s of segList) push(parts, find(s.id), s);
  if (parts.size > 1) {
    const sorted = [...parts.values()].sort((a, b) => b.length - a.length || order(a[0].id, b[0].id));
    const main = sorted[0];
    for (const p of sorted.slice(1)) {
      const names = p.map((s) => `${s.service} 的 ${s.group.name}`).join("、");
      const candidates = out.exits.filter((x) => p.some((s) => s.id === x.segment) && x.component).map((x) => ({ component: x.component!, name: x.label }));
      gap({ kind: "disconnected", segment: p[0].id, segments: p.map((s) => s.id), neighbor: nb(main[0].service, main[0].group), ...(candidates.length ? { candidates } : {}),
        text: `${names} 和这条业务其余的组（${main.map((s) => s.group.name).join("、")}）之间找不到连线、S2S、MQ 或 schedule 的交接，要问负责人数据怎么过去。` });
    }
  }

  // ⑧ Columns, upstream first: the longest path from a start; a cycle is cut where it is entered first.
  out.segments = [...segList.map(({ frags: _f, starts: _s, ...rest }) => rest), ...modSegs.values()];
  out.layers = layers(out.segments.map((s) => s.id), out.edges);
  out.gaps = dedupeGaps(out.gaps).map((g, i) => ({ ...g, id: `gap${i + 1}` }));
  return out;
}

/** s2 before s10, segments before modules. */
function order(a: string, b: string): number {
  const ka = [a[0] === "m" ? 1 : 0, Number(a.slice(1))], kb = [b[0] === "m" ? 1 : 0, Number(b.slice(1))];
  return ka[0] - kb[0] || ka[1] - kb[1];
}

function layers(ids: string[], edges: PreviewEdge[]): string[][] {
  const preds = new Map(ids.map((id) => [id, new Set<string>()]));
  for (const e of edges) if (preds.has(e.from) && preds.has(e.to)) preds.get(e.to)!.add(e.from);
  const layer = new Map<string, number>();
  const left = new Set(ids);
  while (left.size) {
    let ready = [...left].filter((id) => [...preds.get(id)!].every((p) => layer.has(p) || p === id));
    // A cycle: take the first segment some of whose upstream is placed (else the first left), as if the rest came later.
    if (!ready.length) ready = [[...left].sort(order).find((id) => [...preds.get(id)!].some((p) => layer.has(p))) ?? [...left].sort(order)[0]];
    for (const id of ready.sort(order)) {
      layer.set(id, Math.max(-1, ...[...preds.get(id)!].filter((p) => layer.has(p)).map((p) => layer.get(p)!)) + 1);
      left.delete(id);
    }
  }
  const cols: string[][] = [];
  for (const id of [...ids].sort(order)) (cols[layer.get(id)!] ??= []).push(id);
  return cols.filter(Boolean);
}

function dedupeGaps(gaps: PreviewGap[]): PreviewGap[] {
  const seen = new Set<string>();
  return gaps.filter((g) => {
    const k = `${g.kind}\0${g.segment}\0${g.component ?? ""}\0${g.text}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
