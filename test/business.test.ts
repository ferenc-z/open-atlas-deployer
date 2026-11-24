// pages-rethink B3, B4, P3, A8 (ops step 3b): the business light — the six anomalies (and a DROP at an exit that is
// none), stuck at its two times, a gate rejection as unknown — and the business detail (#8).

import assert from "node:assert/strict";
import { test } from "node:test";
import { BusinessScanner, businessCheck, businessLight, classifyEvents, flowLight, locator } from "../src/server/services/business.ts";
import type { Topology } from "../src/server/services/flowcounts.ts";
import { flowDetail } from "../src/server/services/page-views.ts";
import type { ModelV2, Segment } from "../src/server/services/trace/model.ts";
import { Store, type FlowCountRow, type FlowRecord } from "../src/server/store.ts";

const admin = { id: "admin", via: "cli" } as const;
const FLOW = "flw_invoice1";
const member = (https: number) => ({ host: "local", installDir: `/lab/${https}`, serviceUser: "ferenc", startEnvironment: null, ports: { https }, nodeAddress: null, discovery: null });
const frag = (key: string) => ({ key, processors: 2, names: [key], inputs: [], outputs: [], remoteIn: [], s2sOut: [], starts: 1 });
const iso = (ms: number) => new Date(ms).toISOString();

/** n1: Ingest (A, with a nested group A2) is the business invoice; Errors (E) is a shared error group; Ingest sends to
 *  c2's port orders by S2S, where Receive (R) is the business's second segment. */
function world() {
  const clock = { t: new Date("2026-11-19T12:00:00Z") };
  const store = new Store(":memory:", () => clock.t);
  store.addStandalone({ kind: "standalone", id: "n1", service: "nifi", profile: "nifi-1.x", version: "1.12.1", webUrl: "https://n1:8443/nifi", member: member(8443) } as never, "uat", admin);
  store.addStandalone({ kind: "standalone", id: "c2", service: "nifi", profile: "nifi-2.x", version: "2.5.0", webUrl: null, member: member(9443) } as never, "uat", admin);
  const t1: Topology = {
    root: { id: "root", name: "NiFi Flow" },
    groups: [{ id: "A", name: "Ingest", root: false, fragments: [frag("a")] }, { id: "E", name: "Errors", root: false, fragments: [frag("e")] }],
    links: [{ connection: "l1", from: { group: "A", fragment: "a", port: "err" }, to: { group: "E", fragment: "e", port: "in" } }],
    s2sIn: [], s2sOut: [{ ref: "https://c2:9443/nifi#orders", name: "orders", targets: ["https://c2:9443/nifi"], group: "A", fragment: "a" }],
    nested: { A2: "A" },
  };
  const t2: Topology = { root: { id: "r2", name: "NiFi Flow" }, groups: [{ id: "R", name: "Receive", root: false, fragments: [frag("r")] }], links: [], s2sIn: [{ id: "p-in", name: "orders", group: "R", fragment: "r" }], s2sOut: [] };
  store.putTopology("n1", "2026-11-19T10:00:00Z", "h1", t1);
  store.putTopology("c2", "2026-11-19T10:00:00Z", "h2", t2);
  const seg = (o: Partial<Segment>): Segment => ({ id: "x", name: "x", match: [], steps: [], entries: [], exits: [], group: { id: "x", name: "x" }, slice: "*", role: "segment", ...o } as Segment);
  const m1: ModelV2 = { version: 2, service: "n1", sources: [], segments: [
    seg({ id: "A", name: "Ingest", flow: FLOW, group: { id: "A", name: "Ingest" }, steps: [{ id: "g", name: "Ingest", position: { kind: "process-group", id: "A" } }],
      entries: [{ id: "in", step: "g", channel: { type: "external", system: "mailbox" }, cues: [{ cue: "fileName", key: "filename" }] }],
      exits: [{ id: "s2s", step: "g", channel: { type: "s2s", service: "c2", port: "orders" }, component: "p-send" }, { id: "archive", step: "g", channel: { type: "external", system: "archive" }, component: "p-put", relationship: "success" }] }),
    seg({ id: "E", name: "Errors", group: { id: "E", name: "Errors" }, role: "shared", steps: [{ id: "g", name: "Errors", position: { kind: "process-group", id: "E" } }], entries: [{ id: "in", step: "g", channel: { type: "external", system: "-" } }] }),
  ] };
  const m2: ModelV2 = { version: 2, service: "c2", sources: [], segments: [
    seg({ id: "R", name: "Receive", flow: FLOW, group: { id: "R", name: "Receive" }, steps: [{ id: "g", name: "Receive", position: { kind: "process-group", id: "R" } }], entries: [{ id: "in", step: "g", channel: { type: "s2s", port: "orders" } }], exits: [{ id: "db", step: "g", channel: { type: "external", system: "db" }, component: "p-db", relationship: "success" }] }),
  ] };
  store.flowTransaction(() => {
    store.insertFlowModel("n1", 0, m1, "ai", { id: "ai", via: "key" }, []);
    store.insertFlowModel("c2", 0, m2, "ai", { id: "ai", via: "key" }, []);
  });
  const f: FlowRecord = { id: FLOW, name: "Invoices", nameBy: "person", status: "confirmed", summary: "mail → db", reason: null, risks: [], pendings: [], stuck: null, createdAt: "2026-11-19T09:00:00Z", confirmedAt: "2026-11-19T09:30:00Z", confirmedBy: "admin", updatedAt: "2026-11-19T09:30:00Z" };
  store.putFlow(f);
  store.setFlowSegments(FLOW, [{ service: "n1", segment: "A" }, { service: "c2", segment: "R" }]);
  const row = (service: string, bucket: string, kind: FlowCountRow["kind"], ref: string, fin: number, fout: number): FlowCountRow => ({ service, bucket, kind, ref, name: ref, flowfilesIn: fin, flowfilesOut: fout, bytesIn: 0, bytesOut: 0, transferred: 0, source: "sample" });
  store.putFlowCounts([row("n1", "2026-11-19T11:00:00Z", "group", "A", 5, 5), row("c2", "2026-11-19T11:00:00Z", "group", "R", 5, 5)]);
  return { store, clock, row };
}
const open = (store: Store) => store.flowAnomalies({ state: "open" }).map((a) => `${a.service} ${a.anomaly} ${a.light} ${a.ref} ${a.count}`).sort();

test("a confirmed business with flow data and nothing wrong is healthy; the service's light follows", () => {
  const { store } = world();
  assert.deepEqual([flowLight(store, store.flow(FLOW)!).light, businessLight(store, "n1").light], ["healthy", "healthy"]);
  assert.deepEqual(businessLight(store, "n1").flows.map((f) => [f.name, f.services, f.light]), [["Invoices", ["n1", "c2"], "healthy"]]);
  assert.equal(businessLight(store, "n1").confirmedAt, "2026-11-19T09:30:00Z");
});

test("the provenance scan: a DROP outside the exits and an EXPIRE are data dropped (failing); a DROP at an exit and a queue emptied by hand are not; failure and invalid relationships", async () => {
  const { store, clock } = world();
  const events: Record<string, unknown[]> = {
    "EventType=DROP": [
      { eventType: "DROP", componentId: "p-route", componentName: "RouteOnAttribute", groupId: "A2", details: "Auto-Terminated by unmatched Relationship", at: "2026-11-19T11:58:00Z" },
      { eventType: "DROP", componentId: "p-route", componentName: "RouteOnAttribute", groupId: "A2", details: "Auto-Terminated by unmatched Relationship", at: "2026-11-19T11:59:00Z" },
      { eventType: "DROP", componentId: "p-put", groupId: "A", details: "Auto-Terminated by success Relationship", at: "2026-11-19T11:59:00Z" },
      { eventType: "DROP", componentId: "p-put", groupId: "A", details: "FlowFile Queue emptied by admin", at: "2026-11-19T11:59:00Z" },
    ],
    "EventType=EXPIRE": [{ eventType: "EXPIRE", componentId: "p-slow", groupId: "A", details: "Expiration Threshold = 60 sec", at: "2026-11-19T11:57:00Z" }],
    "Relationship=failure": [{ eventType: "ROUTE", componentId: "p-parse", groupId: "A", relationship: "failure", at: "2026-11-19T11:56:00Z" }],
    "Relationship=invalid": [{ eventType: "ROUTE", componentId: "p-validate", groupId: "A2", relationship: "invalid", at: "2026-11-19T11:56:00Z" }],
  };
  const asked: string[] = [];
  const scanner = new BusinessScanner(store, { search: async (_id, q) => { asked.push(`${q.field}=${q.value} ${q.from}`); return { events: events[`${q.field}=${q.value}`] ?? [], limitReached: false }; } });
  await scanner.scan("n1", clock.t);
  assert.equal(asked.length, 4);
  assert.match(asked[0]!, /2026-11-19T11:55:00.000Z$/, "the first scan reads the last 5 minutes");
  assert.deepEqual(open(store), ["n1 data-dropped failing p-route 2", "n1 data-dropped failing p-slow 1", "n1 invalid-data attention p-validate 1", "n1 other-drop healthy p-put 1", "n1 processing-failed attention p-parse 1"], "the queue emptied by hand is kept as other-drop (owner 2026-11-20)");
  assert.equal(store.flowAnomalies({ flow: FLOW }).find((a) => a.anomaly === "other-drop")!.detail.details, "FlowFile Queue emptied by admin");
  const l = flowLight(store, store.flow(FLOW)!);
  assert.equal(l.light, "failing");
  assert.ok(!l.anomalies.some((a) => (a.anomaly as string) === "other-drop"), "it lights nothing");
  assert.equal(l.sentence, "Data expired in the queue before p-slow (1) (+3 more)", "the worst first, then the oldest");
  // The next scan starts where this one ended; nothing new for an hour closes the events.
  clock.t = new Date("2026-11-19T12:05:00Z");
  await new BusinessScanner(store, { search: async (_id, q) => { asked.push(`${q.field}=${q.value} ${q.from}`); return { events: [] }; } }).scan("n1", clock.t);
  assert.match(asked.at(-1)!, /2026-11-19T12:00:00.000Z$/);
  clock.t = new Date("2026-11-19T13:01:00Z");
  businessCheck(store, "n1", clock.t);
  assert.deepEqual(open(store), []);
  assert.equal(flowLight(store, store.flow(FLOW)!).light, "healthy");
});

test("classifyEvents: a DROP at a marked exit is a normal end, at the same component by another relationship it is dropped", () => {
  const { store } = world();
  const model = store.flowModel("n1")!.model;
  const got = classifyEvents(model, locator(store, "n1"), [
    { eventType: "DROP", componentId: "p-put", groupId: "A", details: "Auto-Terminated by success Relationship", at: "2026-11-19T11:59:00Z" },
    { eventType: "DROP", componentId: "p-put", groupId: "A", details: "Auto-Terminated by failure Relationship", at: "2026-11-19T11:59:00Z" },
    { eventType: "DROP", componentId: "p-zzz", groupId: "nowhere", details: "Auto-Terminated by failure Relationship", at: "2026-11-19T11:59:00Z" },
  ]);
  assert.deepEqual([got.exits, got.unplaced, got.observations.map((o) => [o.anomaly, o.detail.relationship])], [1, 1, [["data-dropped", "failure"]]]);
});

test("processor error: an ERROR bulletin of the business's component (attention); WARN ones and shared groups' are not", () => {
  const { store, clock } = world();
  store.addServiceBulletins([
    { service: "n1", member: "local:/lab/8443", node: "n", id: 1, at: "2026-11-19T11:58:00Z", level: "ERROR", category: "Log Message", source: "PutDatabaseRecord", sourceType: "PROCESSOR", message: "connection refused", sourceId: "p-db1", groupId: "A2" },
    { service: "n1", member: "local:/lab/8443", node: "n", id: 2, at: "2026-11-19T11:58:30Z", level: "WARNING", category: "Log Message", source: "X", sourceType: "PROCESSOR", message: "slow", sourceId: "p-x", groupId: "A" },
    { service: "n1", member: "local:/lab/8443", node: "n", id: 3, at: "2026-11-19T11:59:00Z", level: "ERROR", category: "Log Message", source: "LogError", sourceType: "PROCESSOR", message: "x", sourceId: "p-e", groupId: "E" },
  ]);
  businessCheck(store, "n1", clock.t);
  assert.deepEqual(open(store), ["n1 processor-error attention p-db1 1"]);
  assert.equal(businessLight(store, "n1").light, "attention");
  businessCheck(store, "n1", new Date(clock.t.getTime() + 60_000));
  assert.deepEqual(open(store), ["n1 processor-error attention p-db1 1"], "a bulletin counts once");
});

test("stuck (B4): a queue never empty for the attention time is attention, for the failing time failing; it closes once empty; the business's own times count", () => {
  const { store, clock } = world();
  const start = Date.parse("2026-11-19T11:00:00Z");
  const reading = (at: number, queued: number) => ({ service: "n1", member: "local:/lab/8443", at: iso(at), nifi: { backpressure: { connections: 3, full: 0, maxPercent: 5, top: queued ? [{ id: "c1", name: "success", group: "deep", groupId: "A2", sourceName: "Fetch", destinationName: "PutDB", destinationId: "p-db1", flowFilesQueued: queued, percentUseCount: 5 }] : [] } } });
  for (let m = 0; m <= 15; m += 5) store.addServiceSamples([reading(start + m * 60_000, 4)] as never);
  clock.t = new Date(start + 16 * 60_000);
  businessCheck(store, "n1", clock.t);
  assert.deepEqual(open(store), ["n1 stuck attention c1 4"], "16 minutes over the default 10");
  for (let m = 20; m <= 60; m += 5) store.addServiceSamples([reading(start + m * 60_000, 6)] as never);
  clock.t = new Date(start + 61 * 60_000);
  businessCheck(store, "n1", clock.t);
  assert.deepEqual(open(store), ["n1 stuck failing c1 6"], "61 minutes over the default 60");
  assert.match(flowLight(store, store.flow(FLOW)!).sentence, /6 flowfiles have been waiting before PutDB for 61 min/);
  // A person's longer times: the same queue is only attention.
  store.putFlow({ ...store.flow(FLOW)!, stuck: { attentionS: 30 * 60, failingS: 120 * 60, by: "person", basis: "人设的值" } });
  businessCheck(store, "n1", clock.t);
  assert.deepEqual(open(store), ["n1 stuck attention c1 6"]);
  store.addServiceSamples([reading(start + 65 * 60_000, 0)] as never);
  clock.t = new Date(start + 66 * 60_000);
  businessCheck(store, "n1", clock.t);
  assert.deepEqual(open(store), []);
  // A queue named failure that holds data is processing failed (queues only count for the business light).
  store.addServiceSamples([{ service: "n1", member: "local:/lab/8443", at: iso(start + 70 * 60_000), nifi: { backpressure: { top: [{ id: "c9", name: "failure", groupId: "A", sourceName: "PutDB", destinationName: "LogIt", destinationId: "p-log", flowFilesQueued: 3 }] } } }] as never);
  clock.t = new Date(start + 71 * 60_000);
  businessCheck(store, "n1", clock.t);
  assert.deepEqual(open(store), ["n1 processing-failed attention c9 3"]);
});

test("hand-over lost: n1 sent 20 by S2S, c2 received 5 (failing); balanced, it closes; data into the shared error group is processing failed", () => {
  const { store, clock, row } = world();
  store.putFlowCounts([row("n1", "2026-11-19T10:25:00Z", "s2s-out", "https://c2:9443/nifi#orders", 20, 20), row("n1", "2026-11-19T10:30:00Z", "s2s-out", "https://c2:9443/nifi#orders", 20, 20), row("c2", "2026-11-19T10:25:00Z", "s2s-in", "p-in", 5, 5), row("c2", "2026-11-19T10:30:00Z", "s2s-in", "p-in", 5, 5)]);
  businessCheck(store, "n1", clock.t);
  assert.deepEqual(open(store), ["n1 handover-lost failing s2s:c2:orders 15"]);
  assert.match(flowLight(store, store.flow(FLOW)!).sentence, /S2S to c2 port orders: 20 sent, 5 received/);
  store.putFlowCounts([row("c2", "2026-11-19T10:25:00Z", "s2s-in", "p-in", 20, 20), row("c2", "2026-11-19T10:30:00Z", "s2s-in", "p-in", 20, 20), row("n1", "2026-11-19T11:50:00Z", "group", "E", 4, 0)]);
  businessCheck(store, "n1", clock.t);
  assert.deepEqual(open(store), ["n1 processing-failed attention E 4"]);
});

test("gate rejected (A8): the business is unknown whatever its anomalies, until a publish of its service passes", () => {
  const { store, clock } = world();
  store.noteFlowAnomaly({ flow: FLOW, service: "n1", ref: "p-x", anomaly: "data-dropped", light: "failing", at: "2026-11-19T11:59:00Z", count: 1, detail: { segment: "A" } });
  clock.t = new Date("2026-11-19T12:10:00Z");
  store.addFlowChange({ flow: FLOW, service: "n1", by: "ai", kind: "rejected", text: "闸门不过", revision: null, verdict: "rejected" });
  const l = flowLight(store, store.flow(FLOW)!);
  assert.deepEqual([l.light, l.reason], ["unknown", "gate-rejected"]);
  assert.equal(l.anomalies.length, 1, "its anomalies are still listed");
  assert.deepEqual([businessLight(store, "n1").light, businessLight(store, "n1").reason], ["unknown", "gate-rejected"]);
});

test("unknown reasons: proposed (unconfirmed), no flow data (no-evidence)", () => {
  const { store } = world();
  store.putFlow({ ...store.flow(FLOW)!, status: "proposed", confirmedAt: null });
  assert.deepEqual([flowLight(store, store.flow(FLOW)!).reason, businessLight(store, "n1").reason], ["unconfirmed", "unconfirmed"]);
  const empty = new Store(":memory:");
  empty.addStandalone({ kind: "standalone", id: "n9", service: "nifi", profile: "nifi-1.x", version: "1.12.1", webUrl: null, member: member(1) } as never, "uat", admin);
  assert.deepEqual([businessLight(empty, "n9").light, businessLight(empty, "n9").reason, businessLight(empty, "n9").flows], ["unknown", "no-evidence", []]);
});

test("#8 the business detail: light and problems with titles, the graph's lights and Dropped node, last 7 days with lights, find-by clues, history", () => {
  const { store, clock } = world();
  store.noteFlowAnomaly({ flow: FLOW, service: "n1", ref: "p-route", anomaly: "data-dropped", light: "failing", at: "2026-11-19T11:59:00Z", count: 7, detail: { segment: "A", component: "p-route", componentName: "RouteOnAttribute", relationship: "unmatched" } });
  store.noteFlowAnomaly({ flow: FLOW, service: "c2", ref: "p-db", anomaly: "processor-error", light: "attention", at: "2026-11-18T08:00:00Z", count: 2, detail: { segment: "R", component: "p-db", componentName: "PutDB" } });
  store.closeFlowAnomaly(store.flowAnomalies({ flow: FLOW }).find((a) => a.anomaly === "processor-error")!.id, "2026-11-18T09:00:00Z");
  store.addFlowChange({ flow: FLOW, service: "n1", by: "ai", kind: "found", text: "AI 找到这条业务", revision: 1, verdict: "published" });
  store.noteFlowAnomaly({ flow: FLOW, service: "n1", ref: "c-q", anomaly: "other-drop", light: "healthy", at: "2026-11-19T11:30:00Z", count: 12, detail: { segment: "A", component: "c-q", componentName: "success", details: "FlowFile Queue emptied by admin" } });
  const d = flowDetail(store, FLOW, clock.t)!;
  assert.deepEqual([d.light, d.reason, d.flow.id, d.flow.services], ["failing", undefined, FLOW, ["n1", "c2"]]);
  assert.deepEqual(d.problems.map((p) => [p.anomaly, p.light, p.title, p.service, p.group, p.component, p.count, p.nifiUrl]),
    [["data-dropped", "failing", "Data dropped at RouteOnAttribute (unmatched) (7)", "n1", "Ingest", "p-route", 7, "https://n1:8443/nifi/?processGroupId=A&componentIds=p-route"]]);
  assert.deepEqual(d.flow.graph.nodes.find((n) => n.id === "n1/A")!.light, "failing");
  assert.deepEqual(d.flow.graph.nodes.find((n) => n.id === "drop:n1/A"), { id: "drop:n1/A", kind: "external", service: null, label: "Dropped", detail: "Dropped · 7 个" });
  assert.ok(d.flow.graph.edges.some((e) => e.kind === "drop" && e.label === "unmatched"));
  assert.deepEqual(d.last7Days.map((x) => [x.day, x.anomaly, x.light]), [["2026-11-19", "data-dropped", "failing"], ["2026-11-19", "other-drop", "healthy"], ["2026-11-18", "processor-error", "attention"]]);
  assert.equal(d.last7Days[1]!.text, "success: FlowFile Queue emptied by admin × 12", "NiFi's details and the count");
  assert.match(d.last7Days[2]!.text, /^Error bulletins from PutDB$/);
  assert.deepEqual(d.findBy, [{ cue: "fileName", attribute: "filename" }]);
  assert.deepEqual(d.history.map((h) => [h.by, h.text, h.verdict]), [["ai", "AI 找到这条业务", "published"]]);
  assert.equal(flowDetail(store, "flw_none", clock.t), undefined);
});
