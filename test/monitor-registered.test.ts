// S39 step 7: monitoring looks at what was registered. With DEPLOYER_REGISTERED_GROUPS=1 the business list and light, the
// gaps and the canvas-change to-do cover registered businesses and modules only; the runtime hand-over check uses the
// gate's bucket rule; the graph draws port:/link: as inside; publish_model cannot write over a registration's segments.

import assert from "node:assert/strict";
import { test } from "node:test";
import { businessCheck, businessLight } from "../src/server/services/business.ts";
import { flowGraph } from "../src/server/services/flow-views.ts";
import type { Topology } from "../src/server/services/flowcounts.ts";
import { publishModel } from "../src/server/services/flowmodel.ts";
import { gapsOf } from "../src/server/services/ops-routes.ts";
import { canvasChanges, canvasChangeTodos, groupsExecutorOld, registeredFingerprint, watchedFlows } from "../src/server/services/registered.ts";
import type { ModelV2, Segment } from "../src/server/services/trace/model.ts";
import { Store, type FlowCountRow } from "../src/server/store.ts";

const admin = { id: "admin", via: "cli" } as const;
const ai = { id: "ai", via: "key" } as const;
const member = { host: "local", installDir: "/lab/1", serviceUser: "u", startEnvironment: null, ports: { https: 8443 }, nodeAddress: null, discovery: null };
const frag = (key: string) => ({ key, processors: 2, names: [key], inputs: [], outputs: [], remoteIn: [], s2sOut: [], starts: 1 });
const FLOW = "flw_reg00001", OLD = "flw_old00001", MOD = "shm_mod00001";

async function withSwitch<T>(f: () => T | Promise<T>): Promise<T> {
  const was = process.env.DEPLOYER_REGISTERED_GROUPS;
  process.env.DEPLOYER_REGISTERED_GROUPS = "1";
  try { return await f(); } finally { if (was === undefined) delete process.env.DEPLOYER_REGISTERED_GROUPS; else process.env.DEPLOYER_REGISTERED_GROUPS = was; }
}

const seg = (o: Partial<Segment>): Segment => ({ id: "x", name: "x", match: [], steps: [], entries: [], exits: [], group: { id: "x", name: "x" }, slice: "*", role: "segment", ...o } as Segment);
const topo = (names: Record<string, string>): Topology => ({
  root: { id: "root", name: "NiFi Flow" }, scope: "groups" as const, links: [], s2sIn: [], s2sOut: [], missing: [],
  groups: Object.entries(names).map(([id, name]) => ({ id, name, root: false, fragments: [frag("f")] })),
});

function world() {
  const clock = { t: new Date("2026-11-24T12:00:00Z") };
  const store = new Store(":memory:", () => clock.t);
  store.addStandalone({ kind: "standalone", id: "n1", service: "nifi", profile: "nifi-1.x", version: "1.12.1", webUrl: null, member } as never, "uat", admin);
  const m: ModelV2 = { version: 2, service: "n1", sources: [], segments: [
    seg({ id: "A", name: "收单", flow: FLOW, group: { id: "A", name: "收单" }, steps: [{ id: "g", name: "收单", position: { kind: "process-group", id: "A" } }],
      entries: [{ id: "in", step: "g", channel: { type: "external", system: "mail" } }],
      exits: [{ id: "p", step: "g", channel: { type: "external", system: "port:P1" }, component: "P1" }, { id: "db", step: "g", channel: { type: "external", system: "db" }, component: "put" }] }),
    seg({ id: "M", name: "校验", role: "shared", module: MOD, group: { id: "M", name: "校验" }, steps: [{ id: "g", name: "校验", position: { kind: "process-group", id: "M" } }],
      entries: [{ id: "in", step: "g", channel: { type: "external", system: "port:P1" } }], exits: [] }),
    seg({ id: "O", name: "旧", flow: OLD, group: { id: "O", name: "旧" }, steps: [{ id: "g", name: "旧", position: { kind: "process-group", id: "O" } }], entries: [{ id: "in", step: "g", channel: { type: "external", system: "old-in" } }], exits: [{ id: "out", step: "g", channel: { type: "external", system: "old-out" }, component: "po" }] }),
  ] };
  store.putTopology("n1", "2026-11-24T10:00:00Z", "h1", topo({ A: "收单", M: "校验", O: "旧" }));
  store.insertFlowModel("n1", 0, m, "register", ai, []);
  const flow = (id: string, name: string) => store.putFlow({ id, name, nameBy: "person", status: "confirmed", summary: "", reason: null, risks: [], pendings: [], stuck: null, createdAt: "2026-11-24T09:00:00Z", confirmedAt: "2026-11-24T09:00:00Z", confirmedBy: "admin", updatedAt: "2026-11-24T09:00:00Z" } as never);
  flow(FLOW, "订单"); flow(OLD, "旧业务");
  store.setFlowSegments(FLOW, [{ service: "n1", segment: "A" }]);
  store.setFlowSegments(OLD, [{ service: "n1", segment: "O" }]);
  store.putSharedModule({ id: MOD, name: "公共校验", createdBy: "admin", entries: [], exits: [] });
  store.addFlowRegistrations([
    { owner: FLOW, role: "segment", service: "n1", groupId: "A", groupName: "收单", groupPath: null, slice: "*", link: null, registeredBy: "admin" },
    { owner: MOD, role: "shared", service: "n1", groupId: "M", groupName: "校验", groupPath: null, slice: "*", link: null, registeredBy: "admin" },
  ]);
  return { store, clock };
}

test("switch on: only the registered businesses are listed, lit and in the gaps; off: everything as before", async () => {
  const { store } = world();
  assert.deepEqual(watchedFlows(store, "n1", false).map((f) => f.id).sort(), [FLOW, OLD].sort());
  await withSwitch(() => {
    assert.deepEqual(watchedFlows(store, "n1").map((f) => f.id), [FLOW]);
    assert.deepEqual(businessLight(store, "n1").flows.map((f) => f.id), [FLOW], "the old business is not on the page");
    // The unregistered group O has no exit: no-exit names A's problem only, never O.
    const gaps = gapsOf(store, "n1", watchedFlows(store, "n1"), new Date("2026-11-24T12:00:00Z"));
    assert.ok(!gaps.some((g) => g.text.includes("O")  && g.code === "no-exit" && /\bO\b/.test(g.text)), JSON.stringify(gaps));
  });
  // Nothing registered on a service: no gaps at all.
  const empty = new Store(":memory:");
  empty.addStandalone({ kind: "standalone", id: "n9", service: "nifi", profile: "nifi-1.x", version: "1.12.1", webUrl: null, member } as never, "uat", admin);
  await withSwitch(() => assert.deepEqual(gapsOf(empty, "n9", [], new Date()), []));
});

test("a change in a group nobody registered is none; a registered group renamed, gone or changed is a to-do for its owner", () => {
  const { store } = world();
  // O changes: the registered groups' fingerprint stays.
  const was = topo({ A: "收单", M: "校验", O: "旧" }), withO = { ...was, groups: was.groups.map((g) => (g.id === "O" ? { ...g, name: "旧改名" } : g)) };
  assert.equal(registeredFingerprint(was, new Set(["A", "M"])), registeredFingerprint(withO, new Set(["A", "M"])));
  store.putTopology("n1", "2026-11-24T11:00:00Z", "h2", withO);
  assert.deepEqual(canvasChanges(store, "n1"), []);
  canvasChangeTodos(store, "n1");
  assert.equal(store.todos("n1").length, 0);
  // A is renamed on the canvas.
  store.putTopology("n1", "2026-11-24T11:30:00Z", "h3", topo({ A: "收单新", M: "校验", O: "旧" }));
  const ch = canvasChanges(store, "n1");
  assert.deepEqual(ch.map((c) => [c.owner, c.groups[0]!.what]), [[FLOW, "renamed"]]);
  canvasChangeTodos(store, "n1");
  const todo = store.todos("n1")[0]!;
  assert.deepEqual([todo.key, todo.flow, todo.severity], [`canvas:${FLOW}`, FLOW, "attention"]);
  assert.match(todo.title, /需要负责人确认/);
  canvasChangeTodos(store, "n1");
  assert.equal(store.todos("n1").length, 1, "the same key again updates the one to-do");
  // M is gone; the canvas goes back for A: its to-do closes, M's opens.
  store.putTopology("n1", "2026-11-24T11:45:00Z", "h4", { ...topo({ A: "收单", O: "旧" }), missing: ["M"] });
  canvasChangeTodos(store, "n1");
  assert.deepEqual(store.todos("n1").map((t) => t.key), [`canvas:${MOD}`]);
  assert.match(store.todos("n1")[0]!.title, /公共模块/);
});

test("businessCheck opens the canvas to-do only with the switch on", async () => {
  const { store, clock } = world();
  store.putTopology("n1", "2026-11-24T11:30:00Z", "h3", topo({ A: "收单新", M: "校验", O: "旧" }));
  businessCheck(store, "n1", clock.t);
  assert.equal(store.todos("n1").length, 0);
  await withSwitch(() => businessCheck(store, "n1", clock.t));
  assert.equal(store.todos("n1").length, 1);
});

test("describe's executor-old gap: registered, the executor answers but names no flow-groups@1", async () => {
  const { store } = world();
  assert.equal(groupsExecutorOld(store, "n1", true), false, "no beat: offline is another thing");
  store.setHeartbeat("local", { kinds: ["nifi-sample@1"] }, "service");
  assert.equal(groupsExecutorOld(store, "n1", false), false, "switch off");
  assert.equal(groupsExecutorOld(store, "n1", true), true);
  await withSwitch(() => assert.equal(gapsOf(store, "n1", watchedFlows(store, "n1"), new Date())[0]?.code, "executor-old"));
  store.setHeartbeat("local", { kinds: ["flow-groups@1"] }, "service");
  assert.equal(groupsExecutorOld(store, "n1", true), false);
});

test("handover-lost uses the gate's bucket rule: only buckets both sides have, not the first of either", () => {
  const { store, clock } = world();
  // c2 receives in the second service; n1's model gets an S2S exit.
  store.addStandalone({ kind: "standalone", id: "c2", service: "nifi", profile: "nifi-2.x", version: "2.5.0", webUrl: null, member: { ...member, installDir: "/lab/2", ports: { https: 9443 } } } as never, "uat", admin);
  const cur = store.flowModel("n1")!.model;
  store.insertFlowModel("n1", 1, { ...cur, segments: cur.segments.map((s) => (s.id === "A" ? { ...s, exits: [{ id: "s2s", step: "g", channel: { type: "s2s", service: "c2", port: "orders" }, component: "p" }] } : s)) } as ModelV2, "register", ai, []);
  store.putTopology("n1", "2026-11-24T10:30:00Z", "h5", { ...topo({ A: "收单", M: "校验", O: "旧" }), s2sOut: [{ ref: "r1", name: "orders", targets: [], group: "A", fragment: "f" }] });
  store.putTopology("c2", "2026-11-24T10:00:00Z", "h6", { ...topo({ R: "收" }), s2sIn: [{ id: "p-in", name: "orders", group: "R", fragment: "f" }] });
  const row = (service: string, bucket: string, kind: FlowCountRow["kind"], ref: string, n: number): FlowCountRow => ({ service, bucket, kind, ref, name: ref, flowfilesIn: n, flowfilesOut: n, bytesIn: 0, bytesOut: 0, transferred: 0, source: "sample" } as never);
  // One bucket each side: it is the first of both, nothing is judged.
  store.putFlowCounts([row("n1", "2026-11-24T11:50:00Z", "s2s-out", "r1", 20), row("c2", "2026-11-24T11:50:00Z", "s2s-in", "p-in", 0)]);
  businessCheck(store, "n1", clock.t);
  assert.deepEqual(store.flowAnomalies({ state: "open" }).map((a) => a.anomaly), []);
  // Two buckets: the second is compared (20 sent, 0 received).
  store.putFlowCounts([row("n1", "2026-11-24T11:45:00Z", "s2s-out", "r1", 20), row("c2", "2026-11-24T11:45:00Z", "s2s-in", "p-in", 0)]);
  businessCheck(store, "n1", clock.t);
  assert.deepEqual(store.flowAnomalies({ state: "open" }).map((a) => [a.anomaly, a.count]), [["handover-lost", 20]]);
});

test("the graph draws port: and link: exits as inside, and a module by its module id", () => {
  const { store } = world();
  const g = flowGraph(store, FLOW);
  assert.ok(!g.nodes.some((n) => n.kind === "external" && /port:/.test(n.label)), JSON.stringify(g.nodes));
  const mod = g.nodes.find((n) => n.module === MOD)!;
  assert.deepEqual([mod.label, mod.detail], ["公共校验", "公共模块"]);
  assert.ok(g.edges.some((e) => e.from === "n1/A" && e.to === mod.id));
  assert.ok(g.nodes.some((n) => n.kind === "external" && n.label === "db"), "a real outside exit stays");
});

test("publish_model cannot change or take over what a registration wrote (only with the switch on)", async () => {
  const { store } = world();
  const deps = { store };
  const cur = store.flowModel("n1")!;
  const edited = { ...cur.model, segments: cur.model.segments.map((s) => (s.id === "A" ? { ...s, name: "别的名字" } : s)) };
  await withSwitch(async () => {
    await assert.rejects(publishModel(deps, { service: "n1", base: 1, model: edited, note: "x", actor: ai }), (e: { code?: string; details?: string[] }) => e.code === "flow-model/registered" || (console.log(e.code, e.details), false));
    await assert.rejects(publishModel(deps, { service: "n1", base: 1, model: { ...cur.model, segments: cur.model.segments.map((s) => (s.id === "M" ? { ...s, name: "改" } : s)) }, note: "x", actor: ai }), (e: { code?: string; details?: string[] }) => e.code === "flow-model/registered" || (console.log(e.code, e.details), false));
  });
});
