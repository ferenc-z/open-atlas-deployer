// S39 step 7 (business-registration §4.3): monitoring looks at what was registered and nothing else. With the switch
// DEPLOYER_REGISTERED_GROUPS=1 (watch.ts registeredGroupsOn) the businesses a service lists, the business light, the
// gaps, the brief and the canvas-change check read only the businesses and shared modules somebody registered, and only
// their groups; without it everything reads as before (until step 9 clears the old businesses and the switch goes on).

import type { FlowRecord, Store } from "../store.ts";
import { topologyFingerprint, type Topology } from "./flowcounts.ts";
import { WHOLE } from "./trace/model.ts";
import { FLOW_GROUPS_KIND, registeredGroupsOn } from "./watch.ts";

/** The businesses of a service as monitoring sees them: only the registered ones when the switch is on. */
export function watchedFlows(store: Store, service: string, on = registeredGroupsOn()): FlowRecord[] {
  const flows = store.flows(service);
  if (!on) return flows;
  const owners = new Set(store.flowRegistrations({ service }).filter((r) => r.role === "segment").map((r) => r.owner));
  return flows.filter((f) => owners.has(f.id));
}

/** The registered group ids of a service (businesses' and modules'). */
export const registeredGroupIds = (store: Store, service: string): Set<string> => new Set(store.flowRegistrations({ service }).map((r) => r.groupId));

/** The shared modules registered on a service's groups (the module's name, its groups here). */
export function registeredModules(store: Store, service: string): { id: string; name: string; groups: { id: string; name: string }[] }[] {
  const out = new Map<string, { id: string; name: string; groups: { id: string; name: string }[] }>();
  for (const r of store.flowRegistrations({ service })) {
    if (r.role !== "shared") continue;
    const m = out.get(r.owner) ?? { id: r.owner, name: store.sharedModule(r.owner)?.name ?? r.groupName, groups: [] };
    m.groups.push({ id: r.groupId, name: r.groupName });
    out.set(r.owner, m);
  }
  return [...out.values()];
}

/** The topology cut down to some groups: their units, the connections, ports and ends on them, their subgroups and
 *  neighbours. A snapshot read with scope "groups" holds only registered groups already; a whole-canvas one is cut. */
export function restrictTopology(t: Topology, ids: Set<string>): Topology {
  if (t.scope === "groups") {
    const mine = new Set(t.groups.filter((g) => ids.has(g.id)).map((g) => g.id));
    if (mine.size === t.groups.length) return t;
    ids = mine;
  }
  const keep = (g: string | undefined | null) => Boolean(g && ids.has(g));
  const groups = t.groups.filter((g) => ids.has(g.id));
  const frags = new Set(groups.flatMap((g) => g.fragments.map((f) => f.key)));
  return {
    ...t,
    groups,
    links: t.links.filter((l) => keep(l.from.group) || keep(l.to.group)),
    s2sIn: t.s2sIn.filter((p) => keep(p.group)),
    s2sOut: t.s2sOut.filter((o) => keep(o.group)),
    ...(t.ends ? { ends: t.ends.filter((e) => keep(e.group)) } : {}),
    ...(t.nested ? { nested: Object.fromEntries(Object.entries(t.nested).filter(([, unit]) => keep(unit))) } : {}),
    ...(t.split ? { split: Object.fromEntries(Object.entries(t.split).filter(([, frag]) => frags.has(frag))) } : {}),
    ...(t.neighbors ? { neighbors: t.neighbors.filter((n) => keep(n.group)) } : {}),
    ...(t.missing ? { missing: t.missing.filter((g) => ids.has(g)) } : {}),
  };
}

/** The fingerprint of just these groups' part of the canvas: what is inside them (pieces, ports, processors, ends, S2S).
 *  Left out (S39 UAT 2026-11-25): the connections between groups and the one hop out, which change whenever a neighbour
 *  is registered or not, and processor names past the first five (executors before 0.9.8 sent only five). */
export const registeredFingerprint = (t: Topology | null | undefined, ids: Set<string>): string | null => {
  if (!t) return null;
  const r = restrictTopology(t, ids);
  const groups = r.groups.map((g) => ({ ...g, fragments: (g.fragments ?? []).map((f) => ({ ...f, names: (f.names ?? []).slice(0, 5) })) }));
  return topologyFingerprint({ ...r, groups, links: [], ...(r.neighbors ? { neighbors: [] } : {}) });
};

/** What to compare a registration's groups against: the canvas when the model was published, or, when that snapshot was
 *  read before these groups were registered (only registered groups are read), the first snapshot after it that has them. */
function baseline(store: Store, service: string, publishedAt: string, ids: string[]): Topology | undefined {
  const has = (t: Topology | undefined) => !t || t.scope !== "groups" || ids.every((id) => t.groups.some((g) => g.id === id));
  const then = store.latestTopology(service, publishedAt)?.body as Topology | undefined;
  if (has(then)) return then;
  for (const s of store.topologies(service, publishedAt)) {
    const t = store.latestTopology(service, s.takenAt)?.body as Topology | undefined;
    if (t && has(t)) return t;
  }
  return undefined;
}

/** describe's executor-old gap: the switch is on, something is registered, and the executors of the service answer but
 *  none names flow-groups@1 (they would read the whole canvas, not the registered groups). An offline one is another thing. */
export function groupsExecutorOld(store: Store, service: string, on = registeredGroupsOn()): boolean {
  if (!on || !store.flowRegistrations({ service }).length) return false;
  const standalone = store.standalones().find((s) => s.id === service);
  const nodes = standalone ? [standalone.member] : store.clusters().find((c) => c.id === service)?.nodes ?? [];
  const beats = nodes.map((n) => store.executorBeat(n.host, "service")).filter((b): b is NonNullable<typeof b> => Boolean(b));
  if (!beats.length) return false;
  return !beats.some((b) => { const k = (b.heartbeat as { kinds?: unknown } | null | undefined)?.kinds; return Array.isArray(k) && k.includes(FLOW_GROUPS_KIND); });
}

// ---- canvas changes of registered groups ---------------------------------------------------------------------------

export interface CanvasChange {
  owner: string; role: "segment" | "shared"; name: string;
  groups: { id: string; name: string; what: "gone" | "renamed" | "slice" | "changed"; text: string }[];
}

/** The registered businesses and modules of a service whose groups changed on the canvas since the model was published:
 *  a group gone or renamed, a registered slice that no longer exists, or the structure of their groups (fingerprint of
 *  just those groups, then and now) different. Nothing about groups nobody registered. */
export function canvasChanges(store: Store, service: string): CanvasChange[] {
  const m = store.flowModel(service);
  const now = store.latestTopology(service);
  const regs = store.flowRegistrations({ service });
  if (!m || !now || !regs.length) return [];
  const topo = now.body as Topology;
  const owners = new Map<string, typeof regs>();
  for (const r of regs) owners.set(r.owner, [...(owners.get(r.owner) ?? []), r]);
  const out: CanvasChange[] = [];
  for (const [owner, rows] of owners) {
    const role = rows[0]!.role;
    const name = (role === "segment" ? store.flow(owner)?.name : store.sharedModule(owner)?.name) ?? owner;
    const groups: CanvasChange["groups"] = [];
    for (const r of rows) {
      const g = topo.groups.find((x) => x.id === r.groupId);
      const gone = (topo.missing ?? []).includes(r.groupId) || (topo.scope === "groups" && !g);
      if (gone) groups.push({ id: r.groupId, name: r.groupName, what: "gone", text: `组「${r.groupName}」在画布上找不到了` });
      else if (g && g.name !== r.groupName) groups.push({ id: r.groupId, name: r.groupName, what: "renamed", text: `组「${r.groupName}」在画布上改名成了「${g.name}」` });
      else if (g && r.slice !== WHOLE && !g.fragments.some((f) => f.key === r.slice)) groups.push({ id: r.groupId, name: r.groupName, what: "slice", text: `组「${r.groupName}」里登记的那一片不在了（组里的连线变了，片要重新选）` });
    }
    if (!groups.length) {
      const ids = new Set(rows.map((r) => r.groupId));
      const was = registeredFingerprint(baseline(store, service, m.publishedAt, [...ids]), ids), is = registeredFingerprint(topo, ids);
      if (was && is && was !== is) groups.push({ id: rows[0]!.groupId, name: rows[0]!.groupName, what: "changed", text: `组「${rows.map((r) => r.groupName).join("、")}」里的处理器或连线变了` });
    }
    if (groups.length) out.push({ owner, role, name, groups });
  }
  return out;
}

/** Opens (or updates) one to-do per changed registered business or module, "needs the owner to confirm"; closes the
 *  ones whose change is gone again (a republish took the new canvas as the baseline, or the canvas went back). */
export function canvasChangeTodos(store: Store, service: string, changes = canvasChanges(store, service)) {
  const live = new Set<string>();
  for (const c of changes) {
    const key = `canvas:${c.owner}`;
    live.add(key);
    store.upsertTodo({
      service, flow: c.role === "segment" ? c.owner : null, source: "flows", key, severity: "attention",
      title: `${c.role === "segment" ? "业务" : "公共模块"}「${c.name}」登记的组在画布上变了，需要负责人确认`,
      detail: `${c.groups.map((g) => g.text).join("；")}。请负责人看一下这条${c.role === "segment" ? "业务" : "模块"}现在对不对，要改就重新登记（加组、删组、改名）；没问题就让 AI 重新串联一次。`,
      action: null, analysis: null,
    }, "deployer");
  }
  for (const t of store.todos(service)) if (t.key.startsWith("canvas:") && !live.has(t.key)) store.closeTodo(t.id, "done", { id: "deployer", via: "service" });
  // The whole-canvas way's "Confirm the flows the AI found" (flows:<service>) has nothing left to confirm once businesses
  // are registered: registering publishes without it, so nothing else closes it (S39 UAT 2026-11-25).
  for (const t of store.todos(service)) if (t.key === `flows:${service}`) store.closeTodo(t.id, "done", { id: "deployer", via: "service" });
}
