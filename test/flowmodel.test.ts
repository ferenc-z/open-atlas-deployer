// pages-rethink §10.2 step 2: the business model v2 and its gate — the skeleton as a draft, run_model's replay, the
// three verdicts of publish_model and A8's line (inside: takes effect; new / gone / split / cross-service: waits for a
// person), the AI never renaming a person's business, the S2S balance, the v1 migration, the flow counts' transferred
// column, the flows page and a person's actions, the graph.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono, type Context } from "hono";
import type { Permission, Principal } from "../src/server/auth.ts";
import { flowRows, type Topology, type TopologyFragment } from "../src/server/services/flowcounts.ts";
import { confirmFlow, draftFromSkeleton, dropRelationship, exitOf, gateRejected, publishModel, runModel, type ModelDeps, type TodoSink } from "../src/server/services/flowmodel.ts";
import { applyFlowAction, mountFlows } from "../src/server/services/flow-routes.ts";
import { flowCard, flowGraph, flowsReview } from "../src/server/services/flow-views.ts";
import { UNPLACED, type ModelV2, type Segment } from "../src/server/services/trace/model.ts";
import { allModels } from "../src/server/services/trace/routes.ts";
import { Store, type FlowCountRow } from "../src/server/store.ts";

const admin = { id: "admin", via: "cli" } as const;
const ai = { id: "assistant", via: "key" } as const;
const NOW = new Date("2026-11-19T12:00:00Z");
const frag = (key: string, more: Partial<TopologyFragment> = {}): TopologyFragment =>
  ({ key, processors: 1, names: [key], inputs: [], outputs: [], remoteIn: [], s2sOut: [], starts: 1, ...more });
const topo = (root: string, groups: Topology["groups"], more: Partial<Topology> = {}): Topology =>
  ({ root: { id: root, name: "NiFi Flow" }, groups, links: [], s2sIn: [], s2sOut: [], ...more });
const link = (from: string, fromFrag: string, to: string, toFrag: string) =>
  ({ connection: `${from}-${to}`, from: { group: from, fragment: fromFrag, port: "out" }, to: { group: to, fragment: toFrag, port: "in" } });
const row = (service: string, bucket: string, kind: FlowCountRow["kind"], ref: string, fin: number, fout: number, transferred = 0): FlowCountRow =>
  ({ service, bucket, kind, ref, name: ref, flowfilesIn: fin, flowfilesOut: fout, bytesIn: 0, bytesOut: 0, transferred, source: "sample" });
const member = (https: number, nodeAddress: string | null = null) => ({ host: "local", installDir: `/lab/${https}`, serviceUser: "ferenc", startEnvironment: null, ports: { https }, nodeAddress, discovery: null });

function world() {
  let now = NOW;
  const store = new Store(":memory:", () => now);
  const todos: Parameters<TodoSink["open"]>[0][] = [];
  const deps: ModelDeps = { store, now: () => now, todos: { open: (t) => { todos.push(t); return `td_${todos.length}`; } } };
  return { store, deps, todos, tick: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

/** n1: Ingest -> Load (one business, two segments), Reports on its own. */
function single() {
  const w = world();
  w.store.addStandalone({ kind: "standalone", id: "n1", service: "nifi", profile: "nifi-1.x", version: "1.12.1", webUrl: null, member: member(18443) } as never, "uat", admin);
  w.store.putTopology("n1", "2026-11-19T11:00:00Z", "h1", topo("root", [
    { id: "A", name: "Ingest", root: false, fragments: [frag("a", { outputs: ["out"] })] },
    { id: "B", name: "Load", root: false, fragments: [frag("b", { inputs: ["in"], starts: 0 })] },
    { id: "C", name: "Reports", root: false, fragments: [frag("c")] },
  ], { links: [link("A", "a", "B", "b")] }));
  w.store.putFlowCounts([row("n1", "2026-11-19T10:00:00Z", "group", "A", 0, 10), row("n1", "2026-11-19T10:00:00Z", "group", "B", 10, 10), row("n1", "2026-11-19T10:00:00Z", "group", "C", 0, 0, 7)]);
  return w;
}
const flowOf = (store: Store, service: string, group: string) => store.flowModel(service)!.model.segments.find((s) => s.group.id === group)!.flow!;

test("the skeleton as a draft; a first model is published with its businesses proposed (new: a person confirms them); names the AI gives", async () => {
  const { store, deps, todos } = single();
  const draft = draftFromSkeleton(store, "n1", NOW);
  assert.deepEqual(draft.segments.map((s) => [s.id, s.group.name, s.slice, s.role, s.flow]), [["A", "Ingest", "*", "segment", "new:n1-A"], ["B", "Load", "*", "segment", "new:n1-A"], ["C", "Reports", "*", "segment", "new:n1-C"]]);
  draft.flows = [{ flow: "new:n1-A", name: "进货入库", summary: "从 SFTP 收文件 → 入库", stuck: { attentionMinutes: 15, failingMinutes: 90, basis: "P95 约 6 分钟" } }];
  const run = runModel(store, "n1", draft, NOW);
  assert.equal(run.verdict, "needs-confirmation");
  assert.ok(run.checks.every((c) => c.ok), JSON.stringify(run.checks));
  assert.deepEqual(run.changes.map((c) => c.kind), ["new", "new", "new"]);
  assert.equal(store.flowModel("n1"), null, "run_model saves nothing");

  const got = await publishModel(deps, { service: "n1", base: 0, model: draft, note: "first", actor: ai });
  assert.deepEqual([got.verdict, got.revision, got.todo], ["needs-confirmation", 1, "td_1"]);
  assert.deepEqual(todos.map((t) => [t.source, t.key, t.action?.kind]), [["flows", "flows:n1", "confirm-flows"]]);
  const flows = store.flows("n1");
  assert.deepEqual(flows.map((f) => [f.name, f.status, f.pending?.kind]), [["进货入库", "proposed", "new"], ["Reports", "proposed", "new"]]);
  assert.deepEqual(flows[0]!.stuck, { attentionS: 900, failingS: 5400, by: "ai", basis: "P95 约 6 分钟" }, "B4: the AI's two stuck times, kept on the business");
  assert.deepEqual(store.flowSegments(flows[0]!.id).map((s) => s.segment), ["A", "B"], "upstream first");
  assert.match(store.flowChanges({ flow: flows[0]!.id })[0]!.text, /Ingest → Load/);
  // The trace engine reads the v2 model; a segment's allowed time is its business's stuck time.
  assert.deepEqual(allModels(store).map((m) => [m.service, m.businesses.map((b) => b.id)]), [["n1", ["A", "B", "C"]]]);
  // A stale base is refused.
  await assert.rejects(publishModel(deps, { service: "n1", base: 0, model: draft, note: "again", actor: ai }), /at revision 1, not 0/);
  await assert.rejects(publishModel(deps, { service: "n1", base: 1, model: { ...draft, segments: [{ ...draft.segments[0]!, flow: "flw_nothere" }] }, note: "x", actor: ai }), /No business flw_nothere/);
});

test("A8: confirmed, then a change inside a business takes effect; the AI never renames a business a person named or confirmed", async () => {
  const { store, deps } = single();
  const first = draftFromSkeleton(store, "n1", NOW);
  await publishModel(deps, { service: "n1", base: 0, model: first, note: "first", actor: ai });
  const f = flowOf(store, "n1", "A"), r = flowOf(store, "n1", "C");
  // One publish's held changes are one set: confirming one business applies it; the other is then confirmed as it is.
  assert.equal((await confirmFlow(deps, f, admin)).result?.verdict, "published");
  assert.equal(store.flow(r)!.pending, null);
  assert.equal((await confirmFlow(deps, r, admin)).result, null);
  assert.deepEqual(store.flows("n1").map((x) => [x.status, x.pending, x.confirmedBy]), [["confirmed", null, "admin"], ["confirmed", null, "admin"]]);
  applyFlowAction(store, store.flow(r)!, { kind: "rename", name: "日报" }, admin);
  const m = store.flowModel("n1")!;
  const changed: ModelV2 & { flows?: unknown } = { ...m.model, segments: m.model.segments.map((s) => (s.id === "A" ? { ...s, steps: [...s.steps, { id: "unpack", name: "UnpackContent", position: { kind: "processor", id: "p-unpack" } }] } : s)) };
  (changed as any).flows = [{ flow: r, name: "AI 想改的名" }, { flow: f, name: "AI 也想改这个", summary: "新的说明" }];
  const got = await publishModel(deps, { service: "n1", base: m.revision, model: changed, note: "a processor added", actor: ai });
  assert.deepEqual([got.verdict, got.pending], ["published", []]);
  assert.equal(store.flowModel("n1")!.model.segments[0]!.steps.length, 2);
  assert.deepEqual([store.flow(r)!.name, store.flow(r)!.nameBy], ["日报", "person"], "a person's name stays");
  assert.deepEqual([store.flow(f)!.name, store.flow(f)!.summary], ["Ingest", "新的说明"], "a confirmed name stays; the AI's summary changes");
  assert.ok(store.flowChanges({ flow: f }).some((c) => c.kind === "updated" && /组内的步骤/.test(c.text) && c.verdict === "published"));
});

test("A8: a new group, a split and a group gone from the canvas wait for a person; confirming applies them through the gate", async () => {
  const w = single();
  const { store, deps } = w;
  await publishModel(deps, { service: "n1", base: 0, model: draftFromSkeleton(store, "n1", NOW), note: "first", actor: ai });
  const f = flowOf(store, "n1", "A"), r = flowOf(store, "n1", "C");
  await confirmFlow(deps, f, admin); await confirmFlow(deps, r, admin);
  // Split: Load as a business of its own. The model keeps Load in Ingest's business until a person confirms.
  let m = store.flowModel("n1")!;
  const split = { ...m.model, segments: m.model.segments.map((s) => (s.id === "B" ? { ...s, flow: "new:load" } : s)) };
  assert.ok(runModel(store, "n1", split, NOW).changes.some((c) => c.kind === "split"));
  const held = await publishModel(deps, { service: "n1", base: m.revision, model: split, note: "split", actor: ai });
  assert.equal(held.verdict, "needs-confirmation");
  assert.deepEqual(held.pending.map((p) => [p.flow, p.kind]), [[f, "split"]]);
  assert.equal(flowOf(store, "n1", "B"), f, "held: Load is still in Ingest's business");
  const { result } = await confirmFlow(deps, f, admin);
  assert.equal(result!.verdict, "published");
  const load = flowOf(store, "n1", "B");
  assert.notEqual(load, f);
  assert.deepEqual([store.flowSegments(f).map((s) => s.segment), store.flowSegments(load).map((s) => s.segment), store.flow(f)!.pending], [["A"], ["B"], null]);
  // Merge (only replayed): Load back into Ingest's business.
  m = store.flowModel("n1")!;
  assert.ok(runModel(store, "n1", { ...m.model, segments: m.model.segments.map((s) => (s.id === "A" ? { ...s, flow: load } : s)) }, NOW).changes.some((c) => c.kind === "merge"));

  // A new group under root: proposed, pending new.
  w.tick(60_000);
  store.putTopology("n1", "2026-11-19T11:30:00Z", "h2", topo("root", [
    { id: "A", name: "Ingest", root: false, fragments: [frag("a", { outputs: ["out"] })] },
    { id: "B", name: "Load", root: false, fragments: [frag("b", { inputs: ["in"], starts: 0 })] },
    { id: "D", name: "Invoices", root: false, fragments: [frag("d")] },
  ], { links: [link("A", "a", "B", "b")] }));
  const draft = draftFromSkeleton(store, "n1", NOW);
  assert.deepEqual(draft.segments.map((s) => [s.id, s.flow?.startsWith("new:") ? "new" : "known"]), [["A", "known"], ["B", "known"], ["D", "new"], ["C", "known"]], "Reports is kept though the canvas lost it");
  m = store.flowModel("n1")!;
  const got = await publishModel(deps, { service: "n1", base: m.revision, model: draft, note: "canvas changed", actor: ai });
  assert.equal(got.verdict, "needs-confirmation");
  const invoices = flowOf(store, "n1", "D");
  assert.deepEqual(got.pending.map((p) => p.kind).sort(), ["gone", "new"]);
  assert.deepEqual([store.flow(invoices)!.status, store.flow(r)!.status], ["proposed", "gone"], "Reports: gone from the canvas, not deleted");
  // Confirming the gone one removes it from the list (its history stays).
  const gone = await confirmFlow(deps, r, admin);
  assert.equal(gone.removed, true);
  assert.equal(store.flow(r), null);
  assert.ok(store.flowChanges({ flow: r }).length > 0);
  assert.equal(store.flowModel("n1")!.model.segments.some((s) => s.id === "C"), false);
});

test("gate rejected: the model stays, the business it broke is unknown (gate-rejected) until a publish passes, a gate to-do", async () => {
  const w = single();
  const { store, deps, todos } = w;
  await publishModel(deps, { service: "n1", base: 0, model: draftFromSkeleton(store, "n1", NOW), note: "first", actor: ai });
  const f = flowOf(store, "n1", "A");
  const m = store.flowModel("n1")!;
  w.tick(60_000);
  const broken = { ...m.model, segments: m.model.segments.map((s) => (s.id === "A" ? { ...s, group: { id: UNPLACED, name: "?" } } : s)) };
  const run = runModel(store, "n1", broken, NOW);
  assert.equal(run.verdict, "rejected");
  assert.deepEqual(run.checks.filter((c) => !c.ok).map((c) => c.check), ["coverage", "reachable", "no-regression"]);
  assert.deepEqual(run.regressions.map((r) => r.flow), [f]);
  const got = await publishModel(deps, { service: "n1", base: m.revision, model: broken, note: "bad", actor: ai });
  assert.deepEqual([got.verdict, got.revision, got.todo], ["rejected", null, "td_2"]);
  assert.match(got.reasons.join(" "), /Ingest（a 那一片）|Ingest 不在任何业务/);
  assert.deepEqual(todos.at(-1)!.source, "gate");
  assert.equal(store.flowModel("n1")!.revision, m.revision, "the model did not change");
  assert.equal(gateRejected(store, f), true);
  assert.equal(gateRejected(store, flowOf(store, "n1", "C")), false);
  w.tick(60_000);
  assert.equal((await publishModel(deps, { service: "n1", base: m.revision, model: m.model, note: "same again", actor: ai })).verdict, "published");
  assert.equal(gateRejected(store, f), false, "a passing publish clears it");
});

/** n112 Send --S2S orders--> c250 Receive, counts each hour. */
function crossing(received: (h: number) => number) {
  const w = world();
  const { store } = w;
  store.addStandalone({ kind: "standalone", id: "n112", service: "nifi", profile: "nifi-1.x", version: "1.12.1", webUrl: null, member: member(18443) } as never, "uat", admin);
  store.addCluster({ kind: "cluster", id: "c250", service: "nifi", profile: "nifi-2.x", version: "2.5.0", webUrl: null, zookeeper: "zk:2181", zookeeperRoot: "/c250", nodes: [member(18445, "localhost"), member(18446, "localhost")] } as never, "uat", admin);
  const ref = "https://localhost:18445/nifi#orders";
  store.putTopology("n112", "2026-11-19T11:00:00Z", "a", topo("r1", [{ id: "S", name: "Send", root: false, fragments: [frag("s", { s2sOut: [ref] })] }], { s2sOut: [{ ref, name: "orders", targets: ["https://localhost:18445/nifi"], group: "S", fragment: "s" }] }));
  store.putTopology("c250", "2026-11-19T11:00:00Z", "b", topo("r2", [{ id: "R", name: "Receive", root: false, fragments: [frag("r", { remoteIn: ["orders"] })] }], { s2sIn: [{ id: "p-orders", name: "orders", group: "R", fragment: "r" }] }));
  const rows: FlowCountRow[] = [];
  for (let h = 0; h < 6; h++) {
    const at = (m: number) => new Date(Date.parse("2026-11-19T04:00:00Z") + h * 3_600_000 + m * 60_000).toISOString().replace(".000Z", "Z");
    rows.push(row("n112", at(0), "s2s-out", ref, 10, 10), row("n112", at(0), "group", "S", 0, 10), row("c250", at(5), "s2s-in", "p-orders", received(h), received(h)), row("c250", at(5), "group", "R", received(h), 0));
  }
  store.putFlowCounts(rows);
  return w;
}
const sender = (store: Store): ModelV2 => {
  const d = draftFromSkeleton(store, "n112", NOW);
  return { ...d, segments: d.segments.map((s) => ({ ...s, exits: s.exits.map((e) => ({ ...e, component: "p-send" })) })) };
};
const receiver = (flow: string): ModelV2 => ({ version: 2, service: "c250", sources: [], segments: [{
  id: "R", name: "Receive", match: [], steps: [{ id: "g", name: "Receive", position: { kind: "process-group", id: "R" } }],
  entries: [{ id: "in", step: "g", channel: { type: "s2s", port: "orders" } }],
  exits: [{ id: "db", step: "g", channel: { type: "external", system: "订单库" }, component: "p-put", relationship: "success" }],
  flow, group: { id: "R", name: "Receive" }, slice: "*", role: "segment" } as Segment] });

test("S2S: the two sides' hourly counts must agree; a business across services waits for a person; then a broken port is a regression", async () => {
  const w = crossing((h) => (h >= 3 ? 2 : 10));
  const { store, deps } = w;
  const first = sender(store);
  assert.deepEqual(first.segments[0]!.exits.map((e) => [e.channel.service, e.channel.port]), [["c250", "orders"]], "the draft's S2S exit from the topology");
  assert.equal((await publishModel(deps, { service: "n112", base: 0, model: first, note: "first", actor: ai })).verdict, "needs-confirmation", "c250 has no model yet: its side is waited for");
  const f = flowOf(store, "n112", "S");
  await confirmFlow(deps, f, admin);
  const bad = runModel(store, "c250", receiver(f), NOW);
  assert.equal(bad.verdict, "rejected");
  assert.match(bad.checks.find((c) => c.check === "s2s-balance")!.text, /6 个小时里发出 60 个、收到 36 个，从 2026-11-19T0[67]:00 起对不上/);
  // Late by a bucket is not a mismatch: the counts are fixed (sample rows replace), and the receiver is a business across services.
  store.putFlowCounts(Array.from({ length: 6 }, (_, h) => row("c250", new Date(Date.parse("2026-11-19T04:05:00Z") + h * 3_600_000).toISOString().replace(".000Z", "Z"), "s2s-in", "p-orders", h === 2 ? 4 : h === 3 ? 16 : 10, 0)));
  const ok = runModel(store, "c250", receiver(f), NOW);
  assert.ok(ok.checks.every((c) => c.ok), JSON.stringify(ok.checks));
  assert.deepEqual([ok.verdict, ok.changes.map((c) => c.kind)], ["needs-confirmation", ["cross-service"]]);
  const held = await publishModel(deps, { service: "c250", base: 0, model: receiver(f), note: "receiver", actor: ai });
  assert.deepEqual(held.pending.map((p) => [p.flow, p.kind]), [[f, "cross-service"]]);
  assert.deepEqual(store.flowModel("c250")!.model.segments, [], "held until confirmed");
  assert.equal((await confirmFlow(deps, f, admin)).result!.verdict, "published");
  assert.deepEqual(store.flowSegments(f).map((s) => `${s.service}/${s.segment}`), ["n112/S", "c250/R"]);

  // The graph: services as areas, the S2S edge, the outside as external nodes; a drop (step 3) as an external node.
  const g = flowGraph(store, f, { drops: [{ service: "c250", segment: "R", count: 7, relationship: "failure" }] });
  assert.deepEqual(g.services.map((s) => s.id), ["n112", "c250"]);
  assert.ok(g.edges.some((e) => e.from === "n112/S" && e.to === "c250/R" && e.kind === "s2s" && e.label === "orders"));
  assert.ok(g.nodes.some((n) => n.kind === "external" && n.label === "订单库"));
  assert.deepEqual(g.nodes.find((n) => n.id === "drop:c250/R"), { id: "drop:c250/R", kind: "external", service: null, label: "Dropped", detail: "Dropped · 7 个" });
  assert.ok(g.edges.some((e) => e.kind === "drop" && e.label === "failure"));
  const card = flowCard(store, store.flow(f)!);
  assert.deepEqual([card.services, card.exits.map((e) => [e.component, e.relationship, e.text])], [["n112", "c250"], [["p-put", "success", "送到 订单库"]]]);
  assert.deepEqual(card.stuck, { attentionMinutes: 10, failingMinutes: 60, by: "ai", basis: "AI 还没给建议，先用默认值" });
  // B3: a DROP at a marked exit is a normal end.
  const c250 = store.flowModel("c250")!.model;
  assert.equal(exitOf(c250, "p-put", dropRelationship("Auto-Terminated by success Relationship"))?.exit.id, "db");
  assert.equal(exitOf(c250, "p-put", "failure"), null);

  // n112 sends to a port c250's model does not receive on: dangling, a regression of a business that was right.
  const m = store.flowModel("n112")!;
  w.tick(60_000);
  const wrong = { ...m.model, segments: m.model.segments.map((s) => ({ ...s, exits: s.exits.map((e) => ({ ...e, channel: { ...e.channel, port: "orderz" } })) })) };
  const got = await publishModel(deps, { service: "n112", base: m.revision, model: wrong, note: "port", actor: ai });
  assert.equal(got.verdict, "rejected");
  assert.match(got.reasons.join(" "), /no-dangling: .*orderz/);
  assert.match(got.reasons.join(" "), /no-regression/);
  assert.equal(gateRejected(store, f), true);
});

test("migration: v1 service_trace_models become flow_models revision 1 (migrated), each business a proposed one; the v1 table goes", () => {
  const file = join(mkdtempSync(join(tmpdir(), "flowmodel-")), "deployer.db");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE service_trace_models (service TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL, saved_at TEXT NOT NULL, saved_by TEXT NOT NULL)");
  const v1 = { sources: ["provenance"], businesses: [
    { id: "orders", name: "Orders", match: [], steps: [{ id: "pg", name: "Orders", position: { kind: "process-group", id: "G1", name: "Orders group" }, maxSeconds: 120 }, { id: "put", name: "Put", position: { kind: "processor", id: "p-put" } }],
      entries: [{ id: "in", step: "pg", channel: { type: "external", system: "SFTP" } }], exits: [{ id: "out", step: "put", channel: { type: "s2s", service: "c250", port: "orders" } }] },
    { id: "w", name: "Worker", match: [], steps: [{ id: "x", name: "x", position: { kind: "worker", id: "x" } }], entries: [{ id: "t", step: "x", channel: { type: "mq", exchange: "e", routingKey: "k" } }], exits: [] },
  ] };
  db.prepare("INSERT INTO service_trace_models VALUES (?, ?, ?, ?, ?)").run("n112", 3, JSON.stringify(v1), "2026-11-18T10:00:00Z", "admin");
  db.close();
  const store = new Store(file);
  const m = store.flowModel("n112")!;
  assert.deepEqual([m.revision, m.source, m.publishedBy, m.model.version, m.model.sources], [1, "migrated", "admin", 2, ["provenance"]]);
  assert.deepEqual(m.model.segments.map((s) => [s.id, s.group.id, s.slice, s.role, s.exits.map((e) => e.component)]), [["orders", "G1", "*", "segment", ["p-put"]], ["w", UNPLACED, "*", "segment", []]]);
  assert.equal("maxSeconds" in m.model.segments[0]!.steps[0]!, false, "B4: stuck times are the business's");
  const flows = store.flows("n112");
  assert.deepEqual(flows.map((f) => [f.name, f.status, f.nameBy]), [["Orders", "proposed", "ai"], ["Worker", "proposed", "ai"]]);
  assert.deepEqual(m.model.segments.map((s) => s.flow), flows.map((f) => f.id));
  const tables = (new DatabaseSync(file).prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
  assert.equal(tables.includes("service_trace_models"), false);
  store.close();
  assert.equal(new Store(file).flowModels().length, 1, "opening again migrates nothing twice");
});

test("§10.3 transferred: read from the executor's counts and history, summed; ④ idle needs in, out and transferred all 0", () => {
  const rows = flowRows("n1", { at: "2026-11-19T12:03:10Z", counts: [{ kind: "group", ref: "G", flowFilesIn: 0, flowFilesOut: 0, bytesIn: 0, bytesOut: 0, transferred: 9 }],
    history: [{ kind: "group", ref: "G", points: [[Date.parse("2026-11-19T11:00:10Z"), 0, 0, 0, 0, 4]] }] });
  assert.deepEqual(rows.map((r) => [r.bucket, r.transferred]), [["2026-11-19T12:00:00Z", 9], ["2026-11-19T10:55:00Z", 4]]);
  const store = new Store(":memory:");
  store.putFlowCounts(rows);
  assert.equal(store.flowCountTotals("n1", "")[0]!.transferred, 13);
  // Reports (C) only moves data inside: not idle even with 7 days of counts.
  const { store: s } = single();
  s.putFlowCounts([row("n1", "2026-11-01T00:00:00Z", "group", "C", 0, 0, 0)]);
  const draft = draftFromSkeleton(s, "n1", NOW);
  assert.equal(draft.flows!.find((n) => n.flow === "new:n1-C")!.ignore, undefined);
});

test("flows page and a person's actions: rename, stuck times (attention < failing), ignore / watch, feedback; admin only", async () => {
  const { store, deps } = single();
  await publishModel(deps, { service: "n1", base: 0, model: draftFromSkeleton(store, "n1", NOW), note: "first", actor: ai });
  const reject = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 429 | 503, code: string, message: string, details: string[] = []) => c.json({ error: { code, message, details } }, status);
  const authenticate = async (c: Context, need: Permission): Promise<Principal | Response> => {
    const isAdmin = c.req.header("x-as") === "admin";
    if (need === "admin" && !isAdmin) return reject(c, 403, "auth/forbidden", "admins only");
    return { id: isAdmin ? "admin" : "viewer", via: "workbench", permissions: isAdmin ? ["view", "admin"] : ["view"] } as unknown as Principal;
  };
  const api = new Hono();
  mountFlows(api, { store, model: deps, authenticate, reject, registered: (id) => (id === "n1" ? {} : undefined), actorOf: (p) => ({ id: p.id, via: p.via }) });
  const call = async (method: string, path: string, body?: unknown, as = "admin") => {
    const r = await api.request(path, { method, headers: { "content-type": "application/json", "x-as": as }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json() as any };
  };
  const page = await call("GET", "/api/services/n1/flows", undefined, "viewer");
  assert.equal(page.status, 200);
  assert.deepEqual([page.body.flows.map((f: any) => [f.name, f.status, f.pending?.kind]), page.body.allConfirmed, page.body.ignored], [[["Ingest", "proposed", "new"], ["Reports", "proposed", "new"]], false, []]);
  assert.deepEqual(page.body.flows[0].graph.edges.filter((e: any) => !e.from.startsWith("ext:")), [{ from: "n1/A", to: "n1/B", kind: "data" }]);
  assert.equal((await call("GET", "/api/services/n9/flows")).status, 404);
  const id = page.body.flows[1].id;
  const act = (body: unknown, as = "admin") => call("POST", `/api/flows/${id}/actions`, body, as);
  assert.equal((await act({ kind: "rename", name: "日报" }, "viewer")).status, 403);
  assert.deepEqual([(await act({ kind: "rename", name: "日报" })).body.flow.nameBy, store.flow(id)!.name], ["person", "日报"]);
  assert.equal((await act({ kind: "stuck", attentionMinutes: 60, failingMinutes: 30 })).status, 400);
  assert.deepEqual((await act({ kind: "stuck", attentionMinutes: 20, failingMinutes: 120 })).body.flow.stuck, { attentionMinutes: 20, failingMinutes: 120, by: "person", basis: "人设的值" });
  assert.equal((await act({ kind: "not-right" })).status, 400);
  await act({ kind: "not-right", note: "这是两件事" });
  await act({ kind: "ignore" });
  assert.deepEqual(flowsReview(store, "n1").ignored.map((f) => f.name), ["日报"]);
  await act({ kind: "watch" });
  assert.equal(store.flow(id)!.status, "confirmed");
  assert.deepEqual(store.flowChanges({ flow: id }).map((c) => c.kind).slice(0, 5), ["watched", "ignored", "not-right", "stuck", "renamed"]);
  // An AI suggestion of stuck times does not overwrite a person's.
  const m = store.flowModel("n1")!;
  await publishModel(deps, { service: "n1", base: m.revision, model: { ...m.model, flows: [{ flow: id, stuck: { attentionMinutes: 5, failingMinutes: 10, basis: "x" } }] } as never, note: "stuck", actor: ai });
  assert.equal(store.flow(id)!.stuck!.by, "person");
  const ok = await act({ kind: "confirm" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.flow.pending, null);
});

test("engine test 2026-11-22: a cross-service business's part here moved to a new business is a split, not a rename", async () => {
  const w = crossing(() => 10);
  const { store, deps } = w;
  await publishModel(deps, { service: "n112", base: 0, model: sender(store), note: "first", actor: ai });
  const f = flowOf(store, "n112", "S");
  await confirmFlow(deps, f, admin);
  await publishModel(deps, { service: "c250", base: 0, model: receiver(f), note: "receiver", actor: ai });
  await confirmFlow(deps, f, admin);
  assert.deepEqual(store.flowSegments(f).map((s) => `${s.service}/${s.segment}`), ["n112/S", "c250/R"]);
  const m = store.flowModel("c250")!;
  const split = { ...m.model, segments: m.model.segments.map((s) => ({ ...s, flow: "new:ingest" })) };
  assert.deepEqual(runModel(store, "c250", split, NOW).changes.map((c) => [c.flow, c.kind]), [[f, "split"]], "before, the new key was read as f renamed: no change");
  const held = await publishModel(deps, { service: "c250", base: m.revision, model: split, note: "split", actor: ai });
  assert.deepEqual([held.verdict, held.pending.map((p) => [p.flow, p.kind])], ["needs-confirmation", [[f, "split"]]]);
  assert.equal((await confirmFlow(deps, f, admin)).result!.verdict, "published");
  assert.deepEqual(store.flowSegments(f).map((s) => `${s.service}/${s.segment}`), ["n112/S"], "the part here left the business");
  const other = flowOf(store, "c250", "R");
  assert.notEqual(other, f);
  assert.deepEqual(store.flowSegments(other).map((s) => `${s.service}/${s.segment}`), ["c250/R"]);
});

// Engine test 2026-11-23 (B4/B5): each side of an S2S hand-over already in a confirmed business of its own; the draft
// kept each service's business, so the two never joined. Now either side's draft joins them, held as a merge.
async function twoBusinesses(first: "n112" | "c250") {
  const w = crossing(() => 10);
  const { store, deps } = w;
  const n112 = async () => {
    const d = sender(store);
    await publishModel(deps, { service: "n112", base: 0, model: { ...d, segments: d.segments.map((s) => ({ ...s, flow: "new:send" })), flows: [] }, note: "n112", actor: ai });
    await confirmFlow(deps, flowOf(store, "n112", "S"), admin);
  };
  const c250 = async () => {
    await publishModel(deps, { service: "c250", base: 0, model: receiver("new:recv"), note: "c250", actor: ai });
    await confirmFlow(deps, flowOf(store, "c250", "R"), admin);
  };
  if (first === "n112") { await n112(); w.tick(60_000); await c250(); } else { await c250(); w.tick(60_000); await n112(); }
  const send = flowOf(store, "n112", "S"), recv = flowOf(store, "c250", "R");
  assert.notEqual(send, recv, "two confirmed businesses across the hand-over");
  return { ...w, send, recv };
}

test("engine test 2026-11-23: two confirmed businesses across an S2S hand-over join, whichever side went first; the merge waits for a person", async () => {
  for (const first of ["n112", "c250"] as const) {
    const { store, deps, send, recv } = await twoBusinesses(first);
    // Equal size: the older business takes the other; the service whose part moves drafts the move.
    const [keep, moves, svc, group] = first === "n112" ? [send, recv, "c250", "R"] as const : [recv, send, "n112", "S"] as const;
    const other = svc === "c250" ? "n112" : "c250";
    assert.equal(draftFromSkeleton(store, other, NOW).segments[0]!.flow, keep, `${first} first: the other side stays`);
    const d = draftFromSkeleton(store, svc, NOW);
    assert.equal(d.segments.find((s) => s.group.id === group)!.flow, keep, `${first} first: before, the draft kept ${moves}`);
    const run = runModel(store, svc, d, NOW);
    assert.ok(run.checks.every((c) => c.ok), JSON.stringify(run.checks));
    assert.deepEqual([run.verdict, run.changes.map((c) => [c.flow, c.kind])], ["needs-confirmation", [[keep, "merge"]]]);
    const held = await publishModel(deps, { service: svc, base: store.flowModel(svc)!.revision, model: d, note: "join", actor: ai });
    assert.deepEqual(held.pending.map((p) => [p.flow, p.kind]), [[keep, "merge"]]);
    assert.equal(flowOf(store, svc, group), moves, "never merged on its own");
    assert.equal((await confirmFlow(deps, keep, admin)).result!.verdict, "published");
    assert.deepEqual(store.flowSegments(keep).map((s) => `${s.service}/${s.segment}`), ["n112/S", "c250/R"]);
    assert.ok(!store.flow(moves), "the business taken in is gone");
  }
});

test("engine test 2026-11-23: a business a person said is really two is not joined across the hand-over", async () => {
  const { store, send, recv } = await twoBusinesses("n112");
  store.addFlowChange({ flow: recv, service: "c250", by: "admin", kind: "split-asked", text: "人说这其实是两条业务", revision: null, verdict: null });
  assert.equal(draftFromSkeleton(store, "c250", NOW).segments[0]!.flow, recv);
  assert.equal(draftFromSkeleton(store, "n112", NOW).segments[0]!.flow, send);
});

test("engine test 2026-11-22: both services already have models; a new S2S hand-over is waited for on either side, a port the other canvas lacks is dangling", () => {
  const { store } = crossing(() => 10);
  for (const id of ["n112", "c250"]) store.insertFlowModel(id, 0, { version: 2, service: id, sources: [], segments: [] }, "ai", ai, []);
  const dangles = (r: ReturnType<typeof runModel>) => r.checks.filter((c) => c.check === "no-dangling" && !c.ok).map((c) => c.text).join(" ");
  assert.equal(dangles(runModel(store, "n112", sender(store), NOW)), "", "c250's model is not on Receive yet");
  assert.equal(dangles(runModel(store, "c250", receiver("new:orders"), NOW)), "", "n112's model is not on Send yet");
  const d = sender(store);
  const wrong = { ...d, segments: d.segments.map((x) => ({ ...x, exits: x.exits.map((e) => ({ ...e, channel: { ...e.channel, port: "orderz" } })) })) };
  assert.match(dangles(runModel(store, "n112", wrong, NOW)), /orderz/);
});

test("engine test 2026-11-22: executor 0.9.5 names what feeds an RPG port, and the draft's S2S exit is that component", () => {
  const { store } = crossing(() => 10);
  const ref = "https://localhost:18445/nifi#orders";
  store.putTopology("n112", "2026-11-19T12:00:00Z", "a2", topo("r1", [{ id: "S", name: "Send", root: false, fragments: [frag("s", { s2sOut: [ref] })] }], { s2sOut: [{ ref, name: "orders", targets: ["https://localhost:18445/nifi"], group: "S", fragment: "s", sources: [{ id: "p-send", name: "Send orders", kind: "processor", relationships: ["success"] }] }] }));
  const exit = draftFromSkeleton(store, "n112", NOW).segments[0]!.exits[0]!;
  assert.deepEqual([exit.component, exit.relationship, exit.channel.port], ["p-send", "success", "orders"]);
  assert.equal(runModel(store, "n112", draftFromSkeleton(store, "n112", NOW), NOW).checks.find((c) => c.check === "no-dangling")!.ok, true);
});

test("engine test 2026-11-22: each RPG port of a fan-out exit names its own target service", () => {
  const { store } = crossing(() => 10);
  store.addStandalone({ kind: "standalone", id: "n200", service: "nifi", profile: "nifi-2.x", version: "2.0.0", webUrl: null, member: member(18444) } as never, "uat", admin);
  store.putTopology("n200", "2026-11-19T11:00:00Z", "c", topo("r3", [{ id: "Q", name: "Other", root: false, fragments: [frag("q", { remoteIn: ["other"] })] }], { s2sIn: [{ id: "p-other", name: "other", group: "Q", fragment: "q" }] }));
  const a = "https://localhost:18445/nifi#orders", b = "https://localhost:18444/nifi#other";
  const src = (id: string) => [{ id, name: id, kind: "processor", relationships: ["success"] }];
  store.putTopology("n112", "2026-11-19T12:00:00Z", "a3", topo("r1", [{ id: "S", name: "Send", root: false, fragments: [frag("s", { s2sOut: [a, b] })] }], { s2sOut: [
    { ref: a, name: "orders", targets: ["https://localhost:18445/nifi"], group: "S", fragment: "s", sources: src("p-a") },
    { ref: b, name: "other", targets: ["https://localhost:18444/nifi"], group: "S", fragment: "s", sources: src("p-b") }] }));
  const exits = draftFromSkeleton(store, "n112", NOW).segments.find((x) => x.group.id === "S")!.exits;
  assert.deepEqual(exits.map((e) => [e.channel.port, e.channel.service, e.component]).sort(), [["orders", "c250", "p-a"], ["other", "n200", "p-b"]]);
});

// owner 2026-11-23: an S2S fan-out to other services, each downstream fed by it alone, is one business; the downstream
// parts join the upstream's (held as a merge). Fed by several (with a start of its own, so not a shared step), it stays
// the skeleton's question.
function fanOut(alsoFeedsQ: boolean) {
  const w = crossing(() => 10);
  const { store } = w;
  store.addStandalone({ kind: "standalone", id: "n200", service: "nifi", profile: "nifi-2.x", version: "2.0.0", webUrl: null, member: member(18444) } as never, "uat", admin);
  store.putTopology("n200", "2026-11-19T11:00:00Z", "c", topo("r3", [{ id: "Q", name: "Other", root: false, fragments: [frag("q", { remoteIn: ["other"], starts: alsoFeedsQ ? 2 : 0 })] }], { s2sIn: [{ id: "p-other", name: "other", group: "Q", fragment: "q" }] }));
  const a = "https://localhost:18445/nifi#orders", b = "https://localhost:18444/nifi#other";
  const src = (id: string) => [{ id, name: id, kind: "processor", relationships: ["success"] }];
  store.putTopology("n112", "2026-11-19T12:00:00Z", "a3", topo("r1", [
    { id: "S", name: "Send", root: false, fragments: [frag("s", { s2sOut: [a, b] })] },
    ...(alsoFeedsQ ? [{ id: "T", name: "Also", root: false, fragments: [frag("t", { s2sOut: [b] })] }] : []),
  ], { s2sOut: [
    { ref: a, name: "orders", targets: ["https://localhost:18445/nifi"], group: "S", fragment: "s", sources: src("p-a") },
    { ref: b, name: "other", targets: ["https://localhost:18444/nifi"], group: "S", fragment: "s", sources: src("p-b") },
    ...(alsoFeedsQ ? [{ ref: b, name: "other", targets: ["https://localhost:18444/nifi"], group: "T", fragment: "t", sources: src("p-t") }] : [])] }));
  return w;
}

test("owner 2026-11-23: an S2S fan-out to other services joins the downstream parts into the upstream's business, held as a merge", async () => {
  const { store, deps } = fanOut(false);
  const d = draftFromSkeleton(store, "n112", NOW);
  const model = { ...d, segments: d.segments.map((s) => ({ ...s, flow: s.role === "segment" ? `new:${s.group.id}` : s.flow, exits: s.exits.map((e) => ({ ...e, component: "p-send" })) })), flows: [] };
  await publishModel(deps, { service: "n112", base: 0, model, note: "n112", actor: ai });
  const f = flowOf(store, "n112", "S");
  await confirmFlow(deps, f, admin);
  await publishModel(deps, { service: "c250", base: 0, model: receiver("new:recv"), note: "c250", actor: ai });
  const g = flowOf(store, "c250", "R");
  await confirmFlow(deps, g, admin);
  assert.notEqual(f, g);
  assert.equal(draftFromSkeleton(store, "n200", NOW).segments.find((s) => s.group.id === "Q")!.flow, f, "a part with no model yet joins the upstream's business");
  const c = draftFromSkeleton(store, "c250", NOW);
  assert.equal(c.segments.find((s) => s.group.id === "R")!.flow, f, "before, the draft kept the receiver's own business");
  const run = runModel(store, "c250", c, NOW);
  assert.ok(run.checks.every((x) => x.ok), JSON.stringify(run.checks));
  assert.deepEqual([run.verdict, run.changes.map((x) => [x.flow, x.kind])], ["needs-confirmation", [[f, "merge"]]]);
  assert.equal(draftFromSkeleton(store, "n112", NOW).segments.find((s) => s.group.id === "S")!.flow, f, "the upstream keeps its business");
});

test("owner 2026-11-23: a fan-out to a part fed by several stays apart (the skeleton asks)", async () => {
  const { store, deps } = fanOut(true);
  const d = draftFromSkeleton(store, "n112", NOW);
  const model = { ...d, segments: d.segments.map((s) => ({ ...s, flow: s.role === "segment" ? `new:${s.group.id}` : s.flow, exits: s.exits.map((e) => ({ ...e, component: "p-send" })) })), flows: [] };
  await publishModel(deps, { service: "n112", base: 0, model, note: "n112", actor: ai });
  await publishModel(deps, { service: "c250", base: 0, model: receiver("new:recv"), note: "c250", actor: ai });
  const g = flowOf(store, "c250", "R");
  assert.equal(draftFromSkeleton(store, "c250", NOW).segments.find((s) => s.group.id === "R")!.flow, g);
  assert.match(draftFromSkeleton(store, "n200", NOW).segments.find((s) => s.group.id === "Q")!.flow!, /^new:/);
});

test("engine test 2026-11-22: a remote input port's status counts what it received as out (in is 0): the hand-over balances", () => {
  const w = crossing(() => 10);
  const { store } = w;
  store.putFlowCounts(Array.from({ length: 6 }, (_, h) => row("c250", new Date(Date.parse("2026-11-19T04:05:00Z") + h * 3_600_000).toISOString().replace(".000Z", "Z"), "s2s-in", "p-orders", 0, 10)));
  for (const id of ["n112", "c250"]) store.insertFlowModel(id, 0, { version: 2, service: id, sources: [], segments: [] }, "ai", ai, []);
  store.insertFlowModel("n112", 1, sender(store), "ai", ai, []);
  const r = runModel(store, "c250", receiver("new:orders"), NOW);
  assert.equal(r.checks.find((c) => c.check === "s2s-balance")!.ok, true, JSON.stringify(r.checks));
});

test("engine test round 3: two groups joined only through a shared step are one business (reachable)", () => {
  const w = world();
  const { store } = w;
  store.addStandalone({ kind: "standalone", id: "n1", service: "nifi", profile: "nifi-1.x", version: "1.12.1", webUrl: null, member: member(18443) } as never, "uat", admin);
  store.putTopology("n1", "2026-11-19T11:00:00Z", "h1", topo("root", [
    { id: "A", name: "Orders in", root: false, fragments: [frag("a", { outputs: ["out"] })] },
    { id: "X", name: "Invoices in", root: false, fragments: [frag("x", { outputs: ["out"] })] },
    { id: "V", name: "Common validate", root: false, fragments: [frag("v", { inputs: ["in"], outputs: ["orders", "invoices"], starts: 0 })] },
    { id: "B", name: "Orders route", root: false, fragments: [frag("b", { inputs: ["in"], starts: 0 })] },
    { id: "Y", name: "Invoices extract", root: false, fragments: [frag("y", { inputs: ["in"], starts: 0 })] },
  ], { links: [link("A", "a", "V", "v"), link("X", "x", "V", "v"), link("V", "v", "B", "b"), link("V", "v", "Y", "y")] }));
  const d = draftFromSkeleton(store, "n1", NOW);
  const shared = d.segments.filter((s) => s.role === "shared").map((s) => s.group.id);
  assert.deepEqual(shared, ["V"], JSON.stringify(d.segments.map((s) => [s.group.id, s.role, s.flow])));
  const one = { ...d, segments: d.segments.map((s) => ({ ...s, ...(s.group.id === "A" || s.group.id === "B" ? { flow: "new:orders" } : {}), exits: s.exits.map((e) => ({ ...e, component: "p" })) })) };
  const r = runModel(store, "n1", one, NOW);
  assert.equal(r.checks.find((c) => c.check === "reachable")!.ok, true, JSON.stringify(r.checks));
});

test("engine test round 4: a port two services send to balances against their sum", () => {
  const { store } = crossing(() => 10);
  store.addStandalone({ kind: "standalone", id: "n200", service: "nifi", profile: "nifi-2.x", version: "2.0.0", webUrl: null, member: member(18444) } as never, "uat", admin);
  const ref = "https://localhost:18445/nifi#orders";
  store.putTopology("n200", "2026-11-19T11:00:00Z", "c", topo("r3", [{ id: "T", name: "Send too", root: false, fragments: [frag("t", { s2sOut: [ref] })] }], { s2sOut: [{ ref, name: "orders", targets: ["https://localhost:18445/nifi"], group: "T", fragment: "t" }] }));
  const rows: FlowCountRow[] = [];
  for (let h = 0; h < 6; h++) {
    const at = (m: number) => new Date(Date.parse("2026-11-19T04:00:00Z") + h * 3_600_000 + m * 60_000).toISOString().replace(".000Z", "Z");
    rows.push(row("n200", at(0), "s2s-out", ref, 5, 5), row("c250", at(5), "s2s-in", "p-orders", 0, 15));
  }
  store.putFlowCounts(rows);
  for (const id of ["n112", "c250", "n200"]) store.insertFlowModel(id, 0, { version: 2, service: id, sources: [], segments: [] }, "ai", ai, []);
  store.insertFlowModel("n112", 1, sender(store), "ai", ai, []);
  const r = runModel(store, "c250", receiver("new:orders"), NOW);
  assert.equal(r.checks.find((c) => c.check === "s2s-balance")!.ok, true, JSON.stringify(r.checks));
});

test("executor 0.9.6: a unit's ends (writing processors that lead nowhere) are the draft's external exits", () => {
  const { store } = single();
  const body = store.latestTopology("n1")!.body as Record<string, unknown>;
  store.putTopology("n1", "2026-11-19T12:00:00Z", "h2", { ...body, ends: [
    { id: "p-put", name: "Write to store", type: "org.apache.nifi.processors.standard.PutFile", group: "B", fragment: "b", relationships: ["failure", "success"] },
    { id: "p-pub", name: "Publish", type: "org.apache.nifi.processors.kafka.pubsub.PublishKafka", group: "C", fragment: "c", relationships: [] }] } as never);
  const d = draftFromSkeleton(store, "n1", NOW);
  const exits = (g: string) => d.segments.find((x) => x.group.id === g)!.exits.map((e) => [e.channel.type, e.channel.system, e.component, e.relationship ?? null]);
  assert.deepEqual(exits("B"), [["external", "Write to store", "p-put", "success"]]);
  assert.deepEqual(exits("C"), [["external", "Publish", "p-pub", null]]);
  assert.deepEqual(exits("A"), []);
});

test("engine test 2026-11-23: a kept segment's S2S hand-over the model has as external becomes S2S in the skeleton draft, on both sides", () => {
  const { store } = crossing(() => 10);
  const ref = "https://localhost:18445/nifi#orders";
  store.putTopology("n112", "2026-11-19T12:00:00Z", "a2", topo("r1", [{ id: "S", name: "Send", root: false, fragments: [frag("s", { s2sOut: [ref] })] }], { s2sOut: [{ ref, name: "orders", targets: ["https://localhost:18445/nifi"], group: "S", fragment: "s", sources: [{ id: "p-send", name: "Send orders", kind: "processor", relationships: ["success"] }] }] }));
  const first = draftFromSkeleton(store, "n112", NOW);
  // Published while c250 had no model: the hand-over was written down as an external system.
  const ext = { ...first, segments: first.segments.map((s) => ({ ...s, flow: "flw_send", exits: s.exits.map((e) => ({ ...e, channel: { type: "external" as const, system: "c250 的 orders 端口" } })) })) } as ModelV2;
  store.insertFlowModel("n112", 0, ext, "ai", ai, []);
  const rcv = receiver("flw_rcv");
  store.insertFlowModel("c250", 0, { ...rcv, segments: rcv.segments.map((s) => ({ ...s, entries: [{ id: "in", step: "g", channel: { type: "external", system: "外部来源" } }] })) }, "ai", ai, []);
  const out = draftFromSkeleton(store, "n112", NOW).segments[0]!.exits;
  assert.deepEqual(out.map((e) => [e.id, e.channel, e.component]), [["s2s-1", { type: "s2s", service: "c250", port: "orders" }, "p-send"]], "the same exit, now S2S: no second exit");
  const ins = draftFromSkeleton(store, "c250", NOW).segments.find((s) => s.id === "R")!.entries;
  assert.deepEqual(ins.map((e) => [e.id, e.channel]), [["in", { type: "s2s", port: "orders" }]], "no start of its own: its one entry is the port");
  const run = runModel(store, "n112", draftFromSkeleton(store, "n112", NOW), NOW);
  assert.ok(run.changes.some((c) => c.kind === "cross-service"), "the gate sees it as a change across services (held for a person, never dropped)");
});
