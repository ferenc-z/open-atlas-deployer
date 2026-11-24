// pages-rethink A7, §10.2 step 1: the business skeleton the code finds (certain), for the AI to name and judge and the
// gate to check (step 2). By default a group directly under root is one business, or one segment of one; four
// exceptions come from the wiring and the counts:
//   ① merge: A's output ports go only to B (and B is fed by A alone; edges to shared steps aside) -> one business, A before B;
//   ② split: a group's pieces are not connected to each other -> one candidate per piece, and a question;
//   ③ shared: no start of its own, fed by several groups -> a shared step, not a business;
//   ④ idle: no traffic for 7 days -> maybe nothing to watch.
// Across services: an RPG's target address and port name pair it with the other service's remote input port, the two
// groups then two segments of one business (T1, T2); a pair found by the port name alone is asked once. Components on
// the root canvas itself are taken piece by piece (each piece a candidate, no question). An input port on the root canvas
// (S2S or local) that leads straight into groups belongs to those groups, not to the root canvas: in NiFi a port only
// passes on what it gets, so the units it connects to are where the data is received (several of them: a fan-out).

import type { Store } from "../store.ts";
import type { ServiceMember } from "./draft.ts";
import type { Topology, TopologyFragment } from "./flowcounts.ts";
import { watchList } from "./watch.ts";

const DAY = 86_400_000;
export const IDLE_DAYS = 7;

/** A group's traffic over the last 7 days: none-7d (④), none-short (no traffic, but counted for less than 7 days), unknown (no counts). */
export type Traffic = "yes" | "none-7d" | "none-short" | "unknown";
export type SkeletonException = "merge" | "split" | "cross-service" | "idle";

export interface SkeletonSegment {
  /** service/group, or service/group/fragment when the group is taken piece by piece. */
  id: string;
  service: string; group: { id: string; name: string }; fragment: string | null; root: boolean;
  processors: number; names: string[]; traffic: Traffic;
}
export interface SkeletonFlow {
  /** The first segment's id: stable while the business keeps its first segment. */
  key: string;
  /** Upstream first. */
  segments: SkeletonSegment[];
  exceptions: SkeletonException[];
  reason: string | null;
}
export type QuestionKind = "split" | "multi-feed" | "fan-out" | "s2s-unpaired" | "s2s-name-only";
export interface Skeleton {
  flows: SkeletonFlow[];
  /** ③ shared steps, with the businesses (flow keys) that feed them. */
  shared: (SkeletonSegment & { feeders: string[] })[];
  /** Groups with nothing in them. */
  empty: { service: string; group: { id: string; name: string } }[];
  /** Every edge between segments: root-level links and S2S pairs (match: how the pair was found). */
  edges: { from: string; to: string; kind: "link" | "s2s"; match?: "address" | "name"; port?: string }[];
  questions: { kind: QuestionKind; service: string; group: string; text: string }[];
  /** Services without a topology yet. */
  noTopology: string[];
}

export interface SkeletonInput {
  id: string;
  /** host:port (lower case) this service answers S2S on. */
  addresses: string[];
  topology: Topology | null;
  /** Per group id: in + out + transferred (§10.3) over the last IDLE_DAYS days and the first bucket counted. */
  traffic: Map<string, { total: number; first: string }>;
}

/** host:port of an RPG target URI (lower case; the scheme's port when none). */
export function addressOf(uri: string): string | null {
  try {
    const u = new URL(uri);
    return `${u.hostname.toLowerCase()}:${u.port || (u.protocol === "http:" ? "80" : "443")}`;
  } catch { return null; }
}

function trafficOf(s: SkeletonInput, group: string, now: Date): Traffic {
  const t = s.traffic.get(group);
  if (!t) return "unknown";
  if (t.total > 0) return "yes";
  return Date.parse(t.first) <= now.getTime() - IDLE_DAYS * DAY ? "none-7d" : "none-short";
}

/** Input ports on the root canvas that are in no piece of it (they only lead into groups) -> the ends they lead to.
 *  Such a port belongs to the groups it connects to (the gate counts it for them too). */
export function rootPortTargets(t: Topology): Map<string, { group: string; fragment: string | null }[]> {
  const out = new Map<string, { group: string; fragment: string | null }[]>();
  for (const l of t.links) {
    if (l.from.group !== t.root.id || l.from.fragment !== null || !l.from.port || l.to.group === t.root.id) continue;
    const list = out.get(l.from.port) ?? [];
    if (!list.some((x) => x.group === l.to.group && x.fragment === l.to.fragment)) list.push({ group: l.to.group, fragment: l.to.fragment });
    out.set(l.from.port, list);
  }
  return out;
}

export function identify(services: SkeletonInput[], now: Date): Skeleton {
  const segs = new Map<string, SkeletonSegment & { starts: number; remoteIn: string[] }>();
  const out: Skeleton = { flows: [], shared: [], empty: [], edges: [], questions: [], noTopology: [] };
  // (service, group, fragment) -> segment id
  const segOf = new Map<string, string>();
  const byGroup = new Map<string, string[]>();
  for (const s of services) {
    const t = s.topology;
    if (!t) { out.noTopology.push(s.id); continue; }
    for (const g of t.groups) {
      if (!g.fragments.length) { out.empty.push({ service: s.id, group: { id: g.id, name: g.name } }); continue; }
      const piecewise = g.root || g.fragments.length > 1;
      if (!g.root && g.fragments.length > 1) {
        out.questions.push({ kind: "split", service: s.id, group: g.id, text: `组 ${g.name} 里有 ${g.fragments.length} 片互不相连的部分，先按片拆成 ${g.fragments.length} 条，是否其实是一件事要问人。` });
      }
      const traffic = trafficOf(s, g.id, now);
      const add = (f: TopologyFragment | null, frags: TopologyFragment[]) => {
        const id = f && piecewise ? `${s.id}/${g.id}/${f.key}` : `${s.id}/${g.id}`;
        const names = [...new Set(frags.flatMap((x) => x.names))];
        segs.set(id, {
          id, service: s.id, group: { id: g.id, name: g.name }, fragment: f && piecewise ? f.key : null, root: g.root,
          processors: frags.reduce((n, x) => n + x.processors, 0), names: names.slice(0, 5), traffic,
          starts: frags.reduce((n, x) => n + x.starts, 0), remoteIn: frags.flatMap((x) => x.remoteIn),
        });
        for (const x of frags) segOf.set(`${s.id}\0${g.id}\0${x.key}`, id);
        byGroup.set(`${s.id}\0${g.id}`, [...(byGroup.get(`${s.id}\0${g.id}`) ?? []), id]);
      };
      if (piecewise) for (const f of g.fragments) add(f, [f]);
      else add(g.fragments[0], g.fragments);
    }
  }
  const resolve = (service: string, group: string, fragment: string | null): string | undefined => {
    if (fragment) { const id = segOf.get(`${service}\0${group}\0${fragment}`); if (id) return id; }
    const all = byGroup.get(`${service}\0${group}`) ?? [];
    return all.length === 1 ? all[0] : undefined;
  };
  const edges = new Map<string, Skeleton["edges"][number]>();
  const addEdge = (e: Skeleton["edges"][number]) => { if (e.from !== e.to && !edges.has(`${e.from}\0${e.to}`)) edges.set(`${e.from}\0${e.to}`, e); };
  /** Remote input ports (segment id -> names) that a paired S2S feeds: not a start of their own. */
  const fedPorts = new Map<string, Set<string>>();
  const rootPorts = new Map(services.map((s) => [s.id, s.topology ? rootPortTargets(s.topology) : new Map<string, { group: string; fragment: string | null }[]>()]));
  /** The segments a port of service b (group, fragment, name) receives into: a root-level port's targets, else its own. */
  const receivers = (b: string, group: string, fragment: string | null, name: string): string[] => {
    const t = services.find((x) => x.id === b)?.topology;
    const via = t && group === t.root.id && fragment === null ? rootPorts.get(b)?.get(name) : undefined;
    if (via?.length) return [...new Set(via.map((x) => resolve(b, x.group, x.fragment)).filter((x): x is string => Boolean(x)))];
    const one = resolve(b, group, fragment);
    return one ? [one] : [];
  };
  for (const s of services) {
    const t = s.topology;
    if (!t) continue;
    for (const l of t.links) {
      // A root-level port's own link is its hand-over, not a link from the root canvas' pieces.
      if (l.from.group === t.root.id && l.from.fragment === null && l.from.port && rootPorts.get(s.id)?.has(l.from.port)) continue;
      const from = resolve(s.id, l.from.group, l.from.fragment), to = resolve(s.id, l.to.group, l.to.fragment);
      if (from && to) addEdge({ from, to, kind: "link" });
    }
    for (const o of t.s2sOut) {
      const from = resolve(s.id, o.group, o.fragment);
      if (!from) continue;
      const targets = new Set(o.targets.map(addressOf).filter((a): a is string => Boolean(a)));
      const byAddress = services.filter((b) => b.topology && b.addresses.some((a) => targets.has(a.toLowerCase())));
      let match: "address" | "name" = "address";
      let candidates = byAddress.flatMap((b) => b.topology!.s2sIn.filter((p) => p.name === o.name).map((p) => ({ b, p })));
      if (!byAddress.length) {
        match = "name";
        candidates = services.filter((b) => b.id !== s.id && b.topology).flatMap((b) => b.topology!.s2sIn.filter((p) => p.name === o.name).map((p) => ({ b, p })));
      }
      const pair = candidates.length === 1 ? candidates[0] : undefined;
      const tos = pair ? receivers(pair.b.id, pair.p.group, pair.p.fragment, pair.p.name) : [];
      if (!pair || !tos.length) {
        out.questions.push({ kind: "s2s-unpaired", service: s.id, group: o.group,
          text: byAddress.length
            ? `发往 ${o.targets.join(", ")} 端口 ${o.name} 的 S2S 在对方服务里找不到同名的远程输入端口。`
            : candidates.length > 1
              ? `发往 ${o.targets.join(", ")} 端口 ${o.name} 的 S2S：地址对不上任何受管服务，同名端口有 ${candidates.length} 个（${candidates.map((c) => c.b.id).join(", ")}），要问人接的是哪个。`
              : `发往 ${o.targets.join(", ")} 端口 ${o.name} 的 S2S 对不上任何受管服务（可能发往没接管的 NiFi）。` });
        continue;
      }
      for (const to of tos) {
        addEdge({ from, to, kind: "s2s", match, port: o.name });
        fedPorts.set(to, new Set([...(fedPorts.get(to) ?? []), pair.p.name]));
      }
      if (match === "name") {
        out.questions.push({ kind: "s2s-name-only", service: s.id, group: o.group,
          text: `发往 ${o.targets.join(", ")} 端口 ${o.name} 的 S2S 地址对不上受管服务，按端口名接到了 ${pair.b.id} 的 ${o.name}，要确认一次。` });
      }
    }
  }
  out.edges = [...edges.values()].sort((a, b) => (a.from + a.to < b.from + b.to ? -1 : 1));
  const ups = new Map<string, Set<string>>(), downs = new Map<string, Set<string>>();
  for (const e of out.edges) {
    ups.set(e.to, new Set([...(ups.get(e.to) ?? []), e.from]));
    downs.set(e.from, new Set([...(downs.get(e.from) ?? []), e.to]));
  }
  const ownStarts = (id: string) => {
    const s = segs.get(id)!;
    const fed = fedPorts.get(id) ?? new Set();
    return s.starts - s.remoteIn.filter((p) => fed.has(p)).length;
  };
  // ③ shared: no start of its own, fed by several.
  const shared = new Set([...segs.keys()].filter((id) => (ups.get(id)?.size ?? 0) >= 2 && ownStarts(id) <= 0));
  // ① merge (and the S2S pairs, the same rule): A goes only to B, B is fed by A alone, B not shared.
  const up: Record<string, string> = {};
  const find = (x: string): string => (up[x] && up[x] !== x ? (up[x] = find(up[x])) : x);
  const why = new Map<string, Set<SkeletonException>>();
  const reasons = new Map<string, string[]>();
  const note = (id: string, ex: SkeletonException, text?: string) => {
    why.set(id, new Set([...(why.get(id) ?? []), ex]));
    if (text) reasons.set(id, [...(reasons.get(id) ?? []), text]);
  };
  for (const e of out.edges) {
    if (shared.has(e.from) || shared.has(e.to)) continue;
    const a = segs.get(e.from)!, b = segs.get(e.to)!;
    // Edges to and from shared steps (error handling, audit) do not count: a business that also sends its errors to
    // the shared error handler still goes only to its next segment.
    const nDown = [...downs.get(e.from)!].filter((d) => !shared.has(d)).length, nUp = [...ups.get(e.to)!].filter((u) => !shared.has(u)).length;
    if (nDown === 1 && nUp === 1) {
      up[find(e.from)] = find(e.to);
      const cross = a.service !== b.service;
      const text = cross ? `${a.service} 的 ${a.group.name} 经 S2S 送到 ${b.service} 的 ${b.group.name}，连成前后两段` : `${a.group.name} 的输出只接到 ${b.group.name}，合成一条，前后两段`;
      note(e.from, cross ? "cross-service" : "merge", text); note(e.to, cross ? "cross-service" : "merge");
      continue;
    }
    if (nUp > 1 && !out.questions.some((q) => q.kind === "multi-feed" && q.group === b.group.id && q.service === b.service)) {
      out.questions.push({ kind: "multi-feed", service: b.service, group: b.group.id, text: `${b.group.name} 有 ${nUp} 个上游，但有自己的起点，不算公共环节，也没和上游合并，要问人。` });
    }
    if (nDown > 1 && !out.questions.some((q) => q.kind === "fan-out" && q.group === a.group.id && q.service === a.service)) {
      out.questions.push({ kind: "fan-out", service: a.service, group: a.group.id, text: `${a.group.name} 往 ${nDown} 处送数据，没和下游合并，要问人是不是一件事。` });
    }
  }
  const members = new Map<string, string[]>();
  for (const id of segs.keys()) if (!shared.has(id)) members.set(find(id), [...(members.get(find(id)) ?? []), id]);
  for (const ids of members.values()) {
    // Upstream first: Kahn over the edges inside the business, ties by id.
    const inside = new Set(ids);
    const indeg = new Map(ids.map((id) => [id, [...(ups.get(id) ?? [])].filter((u) => inside.has(u)).length]));
    const order: string[] = [];
    const ready = ids.filter((id) => indeg.get(id) === 0).sort();
    while (ready.length) {
      const id = ready.shift()!;
      order.push(id);
      for (const d of [...(downs.get(id) ?? [])].filter((x) => inside.has(x)).sort()) {
        indeg.set(d, indeg.get(d)! - 1);
        if (indeg.get(d) === 0) ready.push(d);
      }
    }
    for (const id of ids) if (!order.includes(id)) order.push(id);
    const segments = order.map((id) => strip(segs.get(id)!));
    const exceptions = new Set<SkeletonException>(order.flatMap((id) => [...(why.get(id) ?? [])]));
    const texts = order.flatMap((id) => reasons.get(id) ?? []);
    for (const s of segments) {
      if (s.fragment && !s.root) { exceptions.add("split"); texts.push(`组 ${s.group.name} 里互不相连的一片（${s.names.slice(0, 3).join("、") || "无处理器"}）`); break; }
    }
    if (segments.every((s) => s.traffic === "none-7d")) { exceptions.add("idle"); texts.push(`${IDLE_DAYS} 天没有流量，可能不用管`); }
    out.flows.push({ key: order[0], segments, exceptions: [...exceptions].sort(), reason: texts.length ? texts.join("；") : null });
  }
  out.flows.sort((a, b) => (a.key < b.key ? -1 : 1));
  const flowOf = new Map(out.flows.flatMap((f) => f.segments.map((s) => [s.id, f.key] as const)));
  out.shared = [...shared].sort().map((id) => ({ ...strip(segs.get(id)!), feeders: [...new Set([...(ups.get(id) ?? [])].map((u) => flowOf.get(u) ?? u))].sort() }));
  return out;
}

function strip(s: SkeletonSegment & { starts: number; remoteIn: string[] }): SkeletonSegment {
  const { starts: _s, remoteIn: _r, ...rest } = s;
  return rest;
}

/** host:port (lower case, no trailing dot) each service's members answer on: a member's host, node address and
 *  nifi.web.https.host, each with the HTTPS port (and the HTTP port too with http: true, for instances on plain http).
 *  Shared by skeletonOf (S2S pairing) and the registration's link parsing (S39 §7.6). */
export function memberAddresses(store: Store, members: { service: string; m: ServiceMember }[], opts: { http?: boolean } = {}): Map<string, Set<string>> {
  const addresses = new Map<string, Set<string>>();
  const httpsHosts = new Map<string, string | null>();
  for (const host of new Set(members.map((x) => x.m.host))) {
    for (const w of watchList(store, host)) httpsHosts.set(`${w.service}\0${w.member}`, w.https.host);
  }
  for (const { service, m } of members) {
    const ports = [m.ports?.https, ...(opts.http ? [m.ports?.http] : [])].filter((p): p is number => typeof p === "number" && p > 0);
    if (!ports.length) continue;
    const set = addresses.get(service) ?? new Set<string>();
    for (const h of [m.host, m.nodeAddress, ...[...httpsHosts].filter(([k]) => k.startsWith(`${service}\0`)).map(([, v]) => v)]) {
      if (typeof h === "string" && h.trim()) for (const port of ports) set.add(`${h.trim().toLowerCase().replace(/\.$/, "")}:${port}`);
    }
    addresses.set(service, set);
  }
  return addresses;
}

/** The skeleton of every managed service from what the store holds: the newest topology, the addresses the members
 *  answer on (host, node address and nifi.web.https.host, each with the HTTPS port), the last 7 days' group counts. */
export function skeletonOf(store: Store, now: Date, only?: string[]): Skeleton {
  const members = [
    ...store.standalones().map((s) => ({ service: s.id, m: s.member })),
    ...store.clusters().flatMap((c) => c.nodes.map((m) => ({ service: c.id, m }))),
  ].filter((x) => !only || only.includes(x.service));
  const addresses = memberAddresses(store, members);
  const since = new Date(now.getTime() - IDLE_DAYS * DAY).toISOString();
  const inputs: SkeletonInput[] = [...new Set(members.map((x) => x.service))].map((id) => {
    const recent = new Map(store.flowCountTotals(id, since).filter((r) => r.kind === "group").map((r) => [r.ref, r.flowfilesIn + r.flowfilesOut + r.transferred]));
    return {
      id, addresses: [...(addresses.get(id) ?? [])],
      topology: (store.latestTopology(id)?.body as Topology | undefined) ?? null,
      // first: the oldest bucket kept (30 days), so "no traffic for 7 days" needs counts that old.
      traffic: new Map(store.flowCountTotals(id, "").filter((r) => r.kind === "group").map((r) => [r.ref, { total: recent.get(r.ref) ?? 0, first: r.first }])),
    };
  });
  return identify(inputs, now);
}
