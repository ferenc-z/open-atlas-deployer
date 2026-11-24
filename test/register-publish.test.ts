// S39 step 5: a registration takes effect. One business across two services publishes both models at once; changing
// one business leaves the others' segments as they were; a gap refuses, a told hand-over answers it; the gate refuses a
// hand-over whose two sides do not agree and names it; a module's segment carries its module id and the trace passes
// through its canvas ports; the model keeps `declared` and `module`.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Topology, TopologyFragment, TopologyNeighbor } from "../src/server/services/flowcounts.ts";
import { RegisterChain } from "../src/server/services/register-chain.ts";
import { RegisterPublisher } from "../src/server/services/register-publish.ts";
import { RegError, Registrations, type GroupInfo, type GroupReader } from "../src/server/services/registration.ts";
import { TraceEngine } from "../src/server/services/trace/engine.ts";
import type { EvidenceAdapter, ObservedEvent } from "../src/server/services/trace/events.ts";
import { parseModelV2, toTraceModel } from "../src/server/services/trace/model.ts";
import { Store, type Actor } from "../src/server/store.ts";

const admin: Actor = { id: "admin@x", via: "key" };
const ROOT = { id: "aaaaaaaa-0000-0000-0000-000000000000", name: "NiFi Flow" };
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const A = id(1), B = id(2), C = id(3), D = id(4), X = id(5), Y = id(6), M = id(7);
const l1 = (g: string) => `https://h-a1:8443/nifi/?processGroupId=${g}&componentIds=`;
const l2 = (g: string) => `https://nifi-b1.corp:8443/nifi/#/process-groups/${g}`;
const RPG_TARGET = "https://nifi-b1.corp:8443/nifi";

const frag = (more: Partial<TopologyFragment> = {}): TopologyFragment => ({ key: "f", processors: 1, names: [], inputs: [], outputs: [], remoteIn: [], s2sOut: [], starts: 0, ...more });
const nbr = (group: string, side: "in" | "out", port: { id: string; name: string }, other: TopologyNeighbor["other"], connection = `${group}-${port.id}`): TopologyNeighbor =>
  ({ group, connection, side, port, relationships: [], other });
const grp = (gid: string, name: string, port: { id: string; name: string }, registered = true) => ({ kind: "group", id: gid, name, group: ROOT.id, port, registered });

interface G { name: string; frag: TopologyFragment; near?: TopologyNeighbor[]; s2sIn?: Topology["s2sIn"]; ends?: NonNullable<Topology["ends"]>; info?: Partial<GroupInfo> }
/** n1 (1.x): A sends over S2S to c2's B (which writes to a DB); C → D on the canvas; X and Y both through module M. */
const canvas: Record<string, Record<string, G>> = {
  n1: {
    [A]: { name: "收单", frag: frag({ starts: 1, outputs: ["to-c2"] }), near: [nbr(A, "out", { id: "a-out", name: "to-c2" }, { kind: "rpg", id: "rpg1", name: "c2", group: ROOT.id, port: { id: "rp", name: "in-order" }, targets: [RPG_TARGET] })] },
    [C]: { name: "对账收", frag: frag({ starts: 1, outputs: ["out"] }), near: [nbr(C, "out", { id: "c-out", name: "out" }, grp(D, "对账写", { id: "d-in", name: "in" }), "conn-cd")] },
    [D]: { name: "对账写", frag: frag({ inputs: ["in"] }), near: [nbr(D, "in", { id: "d-in", name: "in" }, grp(C, "对账收", { id: "c-out", name: "out" }), "conn-cd")],
      ends: [{ id: "put-d", name: "PutFile", type: "PutFile", group: D, fragment: null, relationships: ["success"] }] },
    [X]: { name: "订单", frag: frag({ starts: 1, outputs: ["v"] }), near: [nbr(X, "out", { id: "x-out", name: "v" }, grp(M, "校验", { id: "m-in", name: "in" }, false), "conn-xm")] },
    [Y]: { name: "发票", frag: frag({ inputs: ["in"] }), near: [nbr(Y, "in", { id: "y-in", name: "in" }, grp(M, "校验", { id: "m-out", name: "ok" }, false), "conn-my")],
      ends: [{ id: "put-y", name: "PutDB", type: "PutDB", group: Y, fragment: null, relationships: ["success"] }] },
    [M]: { name: "校验", frag: frag({ inputs: ["in"], outputs: ["ok"] }), info: { inputPorts: [{ id: "m-in", name: "in" }], outputPorts: [{ id: "m-out", name: "ok" }] },
      near: [nbr(M, "in", { id: "m-in", name: "in" }, grp(X, "订单", { id: "x-out", name: "v" }, false), "conn-xm"), nbr(M, "out", { id: "m-out", name: "ok" }, grp(Y, "发票", { id: "y-in", name: "in" }, false), "conn-my")] },
  },
  c2: {
    [B]: { name: "入库", frag: frag({ remoteIn: ["in-order"] }), s2sIn: [{ id: "rin", name: "in-order", group: B, fragment: null }],
      ends: [{ id: "put-b", name: "PutDatabaseRecord", type: "PutDatabaseRecord", group: B, fragment: null, relationships: ["success"] }] },
  },
};
const reader: GroupReader = {
  async read(s, ids) { return (await this.scan(s, ids)).groups; },
  async scan(s, ids) {
    const mine = canvas[s] ?? {};
    const groups: GroupInfo[] = ids.map((x) => mine[x] ? { id: x, exists: true, name: mine[x]!.name, path: [ROOT], ...mine[x]!.info } : { id: x, exists: false });
    const here = ids.filter((x) => mine[x]);
    const topology = {
      scope: "groups", root: ROOT, links: [], s2sOut: [], missing: [],
      s2sIn: here.flatMap((x) => mine[x]!.s2sIn ?? []), ends: here.flatMap((x) => mine[x]!.ends ?? []),
      groups: here.map((x) => ({ id: x, name: mine[x]!.name, root: false, parent: ROOT.id, path: [ROOT], fragments: [mine[x]!.frag] })),
      neighbors: here.flatMap((x) => mine[x]!.near ?? []),
    } as unknown as Topology;
    return { groups, topology };
  },
};

function setup() {
  const store = new Store(":memory:");
  const member = (host: string, extra: Record<string, unknown> = {}) => ({ host, installDir: `/opt/${host}`, serviceUser: "nifi", startEnvironment: null, ports: { https: 8443 }, discovery: null, ...extra });
  store.addStandalone({ kind: "standalone", id: "n1", service: "nifi", profile: "nifi-1.x", version: "1.12.1", webUrl: "https://h-a1:8443/nifi", member: member("h-a1") } as never, "uat", admin);
  store.addCluster({ kind: "cluster", id: "c2", service: "nifi", profile: "nifi-2.x", version: "2.5.0", webUrl: null, zookeeper: "zk:2181", zookeeperRoot: "/c2",
    nodes: [member("h-b1", { nodeAddress: "nifi-b1.corp" }), member("h-b2", { nodeAddress: "nifi-b2.corp" })] } as never, "uat", admin);
  const registrations = new Registrations(store, reader);
  const chains = new RegisterChain({ store, registrations, reader });
  return { store, registrations, chains, pub: new RegisterPublisher({ store, registrations, chains }) };
}
const refused = async (p: Promise<unknown>, code: string) => {
  try { await p; } catch (e) { assert.ok(e instanceof RegError, String(e)); assert.equal(e.code, code, e.message); return e; }
  assert.fail(`expected ${code}`);
};

test("commit: one business over two services publishes both models in one go; the rows of the action share an op", async () => {
  const { store, pub } = setup();
  const r = await pub.commit({ name: "订单入库", links: [l1(A), l2(B)] }, admin);
  assert.deepEqual(r.revisions.sort((a, b) => a.service.localeCompare(b.service)), [{ service: "c2", revision: 1 }, { service: "n1", revision: 1 }]);
  const n1 = store.flowModel("n1")!.model, c2 = store.flowModel("c2")!.model;
  assert.deepEqual([n1.segments.map((s) => [s.group.id, s.flow]), c2.segments.map((s) => [s.group.id, s.flow])], [[[A, r.flow]], [[B, r.flow]]]);
  assert.deepEqual(n1.segments[0]!.exits.map((e) => [e.channel.type, e.channel.service, e.channel.port, e.component]), [["s2s", "c2", "in-order", "a-out"]]);
  assert.deepEqual(c2.segments[0]!.entries.map((e) => e.channel), [{ type: "s2s", port: "in-order" }]);
  assert.deepEqual(c2.segments[0]!.exits.map((e) => [e.channel.system, e.component]), [["PutDatabaseRecord", "put-b"]]);
  assert.deepEqual(store.flowSegments(r.flow).map((s) => [s.service, s.segment]), [["n1", A], ["c2", B]], "upstream first");
  const row = store.flow(r.flow)!;
  assert.deepEqual([row.name, row.nameBy, row.status], ["订单入库", "person", "confirmed"]);
  const changes = store.flowChanges({ flow: r.flow });
  assert.deepEqual(changes.map((c) => [c.kind, c.service, c.revision]).sort(), [["register", "c2", 1], ["register", "n1", 1]]);
  assert.equal(new Set(changes.map((c) => c.op)).size, 1, "one op over both services");
  assert.match(changes[0]!.op!, /^op_/);
  // Each model as a publish would parse it.
  for (const m of [n1, c2]) assert.ok(!("errors" in parseModelV2(m.service, m)));
  // Registered again: the groups are taken.
  await refused(pub.commit({ name: "又一条", links: [l1(A)] }, admin), "register/group-taken");
});

test("a change to one business publishes only its services and leaves the other businesses' segments as they were", async () => {
  const { store, pub } = setup();
  const x = await pub.commit({ name: "订单入库", links: [l1(A), l2(B)] }, admin);
  // C alone sends out of its port to D, not registered: told it leaves for the outside for now.
  await refused(pub.commit({ name: "对账", links: [l1(C)] }, admin), "register/gaps-open");
  const y = await pub.commit({ name: "对账", links: [l1(C)], handoffs: [{ from: { service: "n1", group: C, component: "c-out" }, to: { system: "下游对账系统" }, quote: "先交给下游" }] }, admin);
  assert.deepEqual(y.revisions, [{ service: "n1", revision: 2 }]);
  const before = store.flowModel("n1")!.model.segments.filter((s) => s.flow === x.flow);
  const added = await pub.add({ flow: y.flow, links: [l1(D)] }, admin);
  assert.deepEqual(added.revisions, [{ service: "n1", revision: 3 }], "c2 is not touched");
  assert.equal(store.flowModel("c2")!.revision, 1);
  assert.deepEqual(store.flowModel("n1")!.model.segments.filter((s) => s.flow === x.flow), before);
  assert.deepEqual(store.flowSegments(x.flow).map((s) => s.segment), [A, B]);
  // The canvas connection C → D is the same link on both sides.
  const segs = store.flowModel("n1")!.model.segments;
  assert.deepEqual(segs.find((s) => s.group.id === C)!.exits.map((e) => [e.channel.system?.replace(/hof_\w+/, "hof"), e.component]), [["link:conn-cd", "c-out"], ["declared:hof", "c-out"]]);
  assert.deepEqual(segs.find((s) => s.group.id === D)!.entries.map((e) => e.channel.system), ["link:conn-cd"]);
  assert.deepEqual(store.flowSegments(y.flow).map((s) => s.segment), [C, D]);
  // Removing D: C alone again (its told hand-over answers where the data goes), one more n1 revision.
  const rm = await pub.remove({ flow: y.flow, groups: [{ service: "n1", group: D }] }, admin);
  assert.deepEqual(rm.revisions, [{ service: "n1", revision: 4 }]);
  assert.deepEqual(store.flowModel("n1")!.model.segments.filter((s) => s.flow === y.flow).map((s) => s.group.id), [C]);
  assert.deepEqual(store.flowModel("n1")!.model.segments.filter((s) => s.flow === x.flow), before);
  // Unregistering a business publishes its services without it.
  const un = await pub.unregister({ flow: x.flow }, admin);
  assert.deepEqual(un.revisions.map((r) => r.service).sort(), ["c2", "n1"]);
  assert.deepEqual(store.flowModel("c2")!.model.segments, []);
  assert.equal(store.flow(x.flow), null);
});

test("gaps: a commit with a gap open is refused; told hand-overs answer it; a registered business keeps the gaps it had", async () => {
  const { store, pub, registrations } = setup();
  const gaps = await refused(pub.commit({ name: "两段", links: [l1(C), l1(A)] }, admin), "register/gaps-open");
  assert.ok((gaps.extra.gaps as { kind: string }[]).some((g) => g.kind === "disconnected"));
  assert.equal(store.flowRegistrations().length, 0, "nothing registered");
  assert.equal(store.flowModel("n1"), null, "nothing published");
  // A draft: told that C's data goes over to A (a directory both use), it registers.
  const d = registrations.createDraft(admin, "两段");
  await registrations.draftAdd(d.id, [l1(C), l1(A), l2(B)], admin);
  // C → D exists on the canvas but D is not registered: a gap too.
  await refused(pub.commit({ draft: d.id }, admin), "register/gaps-open");
  registrations.draftDeclareHandoff(d.id, { from: { service: "n1", group: C, component: "c-out" }, to: { service: "n1", group: A }, quote: "对账收写到 /share，收单从那里取" }, admin);
  const r = await pub.commit({ draft: d.id }, admin);
  const c = store.flowModel("n1")!.model.segments.find((s) => s.group.id === C)!;
  const told = c.exits.find((e) => e.declared)!;
  assert.deepEqual([told.channel.system?.startsWith("declared:hof_"), told.component, told.declared!.quote], [true, "c-out", "对账收写到 /share，收单从那里取"]);
  assert.equal(store.flowHandoffs(r.flow).length, 1);
  assert.equal(store.registrationDraft(d.id), null, "the draft became the business");
  // declare-handoff on the business: replaced, published again.
  const h = store.flowHandoffs(r.flow)[0]!;
  const again = await pub.declareHandoff({ flow: r.flow, replace: h.id, from: { service: "n1", group: C, component: "c-out" }, to: { service: "n1", group: A }, quote: "改：经 /share2" }, admin);
  assert.deepEqual(again.revisions, [{ service: "n1", revision: 2 }]);
  assert.equal(store.flowModel("n1")!.model.segments.find((s) => s.group.id === C)!.exits.find((e) => e.declared)!.declared!.quote, "改：经 /share2");
  // Taking the hand-over away opens the gap again: refused, nothing changes.
  await refused(pub.declareHandoff({ flow: r.flow, remove: h.id }, admin), "register/gaps-open");
  assert.equal(store.flowHandoffs(r.flow).length, 1);
});

test("gate: an S2S hand-over whose two sides stop agreeing is refused, naming both sides", async () => {
  const { store, pub } = setup();
  // The services' latest topologies (the watch's) name the RPG port and the remote input port the counts are kept by.
  const now = Date.now();
  store.putTopology("n1", new Date(now).toISOString(), "h1", (await reader.scan("n1", [A])).topology);
  store.putTopology("c2", new Date(now).toISOString(), "h2", (await reader.scan("c2", [B])).topology);
  const rows = [];
  for (let h = 1; h <= 6; h++) {
    const bucket = new Date(Math.floor(now / 3_600_000) * 3_600_000 - h * 3_600_000).toISOString();
    rows.push({ service: "n1", bucket, kind: "s2s-out" as const, ref: `${RPG_TARGET}#in-order`, name: "in-order", flowfilesIn: 0, flowfilesOut: 100, bytesIn: 0, bytesOut: 0, transferred: 0, source: "sample" });
    rows.push({ service: "c2", bucket, kind: "s2s-in" as const, ref: "rin", name: "in-order", flowfilesIn: h > 3 ? 100 : 0, flowfilesOut: 0, bytesIn: 0, bytesOut: 0, transferred: 0, source: "sample" });
  }
  store.putFlowCounts(rows as never);
  const e = await refused(pub.commit({ name: "订单入库", links: [l1(A), l2(B)] }, admin), "register/gate-rejected");
  const checks = e.extra.checks as { check: string; ok: boolean }[];
  assert.deepEqual(checks.filter((c) => !c.ok).map((c) => c.check), ["s2s-balance"]);
  const p = (e.extra.problems as { check: string; link?: { from: { service: string; group: { id: string } }; to: { service: string } } }[])[0]!;
  assert.deepEqual([p.check, p.link?.from.service, p.link?.from.group.id, p.link?.to.service], ["s2s-balance", "n1", A, "c2"]);
  assert.equal(store.flowRegistrations().length, 0, "refused: nothing registered");
  assert.equal(store.flowModel("n1"), null);
});

test("gate: a receiver whose history starts later (its first bucket partial) is not a lost hand-over", async () => {
  const { store, pub } = setup();
  const now = Date.now();
  store.putTopology("n1", new Date(now).toISOString(), "h1", (await reader.scan("n1", [A])).topology);
  store.putTopology("c2", new Date(now).toISOString(), "h2", (await reader.scan("c2", [B])).topology);
  const rows = [];
  const base = Math.floor(now / 300_000) * 300_000;
  for (let i = 1; i <= 36; i++) {
    const bucket = new Date(base - i * 300_000).toISOString();
    rows.push({ service: "n1", bucket, kind: "s2s-out" as const, ref: `${RPG_TARGET}#in-order`, name: "in-order", flowfilesIn: 0, flowfilesOut: 8, bytesIn: 0, bytesOut: 0, transferred: 0, source: "nifi-history" });
    // The receiver restarted 2 hours ago: no history before, a partial first bucket, then the same as sent.
    if (i <= 24) rows.push({ service: "c2", bucket, kind: "s2s-in" as const, ref: "rin", name: "in-order", flowfilesIn: i === 24 ? 1 : 8, flowfilesOut: 0, bytesIn: 0, bytesOut: 0, transferred: 0, source: "nifi-history" });
  }
  store.putFlowCounts(rows as never);
  const r = await pub.commit({ name: "订单入库", links: [l1(A), l2(B)] }, admin);
  assert.deepEqual(r.gate.map((c) => [c.check, c.ok]), [["coverage", true], ["reachable", true], ["no-dangling", true], ["s2s-balance", true], ["no-regression", true]]);
});

test("shared module: its segment carries the module id; the businesses join it by its ports and the trace passes through", async () => {
  const { store, pub } = setup();
  const x = await pub.commit({ name: "订单", links: [l1(X), l1(M), l1(Y)] }, admin);
  const m = await pub.shared({ name: "校验", links: [l1(M)], entries: [{ port: "in" }], exits: [{ component: "ok" }], takeover: true, commit: true }, admin) as { module: string; revisions: { service: string; revision: number }[]; users: { flow: string; joined: boolean }[] };
  assert.deepEqual(m.revisions, [{ service: "n1", revision: 2 }]);
  assert.deepEqual(m.users.map((u) => [u.flow, u.joined]), [[x.flow, true]]);
  const model = store.flowModel("n1")!.model;
  const mod = model.segments.find((s) => s.group.id === M)!;
  assert.deepEqual([mod.role, mod.module, mod.flow, mod.entries.map((e) => e.channel.system), mod.exits.map((e) => e.channel.system)], ["shared", m.module, undefined, ["port:m-in"], ["port:m-out"]]);
  assert.ok(!("errors" in parseModelV2("n1", model)), "module and declared survive parsing");
  assert.equal((parseModelV2("n1", model) as { model: { segments: { module?: string }[] } }).model.segments.find((s) => s.module)!.module, m.module);
  assert.deepEqual(store.flowSegments(x.flow).map((s) => s.segment), [X, Y], "the business's own segments; the module is read by itself");
  // The trace: X's exit is the module's entry port, the module's exit Y's entry: followed by the same key.
  const at = new Date(Date.now() - 60_000).toISOString();
  const seen: string[] = [];
  const adapter: EvidenceAdapter = {
    id: "provenance", capabilities: () => ({ byKey: "*", byPosition: true, handover: ["s2s"] }),
    async byKey(q) {
      seen.push(q.position?.id ?? "");
      const ev = (state: ObservedEvent["state"]): ObservedEvent => ({ source: "provenance", service: q.service, key: q.key, position: q.position!, at, state, attrs: { filename: "o1.csv" } });
      return { events: [ev("success")] };
    },
  };
  const engine = new TraceEngine({ models: () => store.flowModels().map((s) => toTraceModel(s.model)), adapters: new Map([["provenance", adapter]]) });
  const got = await engine.trace({ service: "n1", fileName: "o1.csv", from: new Date(Date.now() - 3_600_000).toISOString(), to: new Date().toISOString() });
  const t = got.traces.find((tr) => tr.segments[0]!.business === X)!;
  assert.deepEqual(t.segments.map((s) => s.business), [X, M, Y], JSON.stringify(got.traces.map((tr) => tr.verdict)));
  assert.equal(t.verdict.kind, "completed");
  assert.ok(seen.includes(M), "asked at the module's group");
});
