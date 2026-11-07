// Phase 2 step 7 (§9.5, S28): provenance read by the Deployer itself through the service executors — the requests
// checked (a time range always), a cluster asked as a whole through one member and the next member tried when one
// fails, lineage and events per node, the versions supported, two queries per service at a time, jobs only for an
// executor that names nifi-provenance@1, and what reaches the AI redacted.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Handoff } from "../src/server/handoff.ts";
import { ServiceLogs } from "../src/server/services/logs.ts";
import { parseLineage, parseProvenance, provenanceSupport, ServiceProvenance } from "../src/server/services/provenance.ts";
import { redactProvenance } from "../src/server/services/redact.ts";
import { Store } from "../src/server/store.ts";

const admin = { id: "admin", via: "cli" } as const;
const node = (installDir: string, https: number) => ({ host: "local", installDir, serviceUser: "ferenc", startEnvironment: null, ports: { https }, nodeAddress: "localhost", discovery: null });
const KEY1 = "local:/lab/c250-1", KEY2 = "local:/lab/c250-2";
const KINDS = ["svc-discover", "svc-read", "log-read", "log-tail", "nifi-provenance", "nifi-provenance@1", "executor-upgrade"];
const UUID = "11111111-2222-4333-8444-555555555555";
const WINDOW = { from: "2026-11-06T15:00:00.000Z", to: "2026-11-06T16:00:00.000Z" };

function lab(kinds = KINDS, version = "2.5.0") {
  const store = new Store(":memory:");
  store.addCluster({ kind: "cluster", id: "c250", service: "nifi", profile: version.startsWith("1.") ? "nifi-1.x" : "nifi-2.x", version, webUrl: null, zookeeper: "zk:2181", zookeeperRoot: "/c250", nodes: [node("/lab/c250-1", 18445), node("/lab/c250-2", 18446)] }, "uat", admin);
  store.addStandalone({ kind: "standalone", id: "n112", service: "nifi", profile: "nifi-1.x", version: "1.12.1", webUrl: null, member: { host: "local", installDir: "/lab/n112", serviceUser: "ferenc", startEnvironment: null, ports: { https: 18443 }, discovery: null } }, "uat", admin);
  const handoff = new Handoff(store);
  handoff.heartbeat("local", { executor: "service", version: "0.8.0", protocols: [2], kinds, at: "", project: "", registries: [], databaseBackup: {}, busy: null }, "service");
  const logs = new ServiceLogs(store, handoff, { pollMs: 5, waitMs: 3000 });
  const prov = new ServiceProvenance(store, handoff, logs, { pollMs: 5, waitMs: 3000, busyMs: 300 });
  const claim = async () => { for (let i = 0; i < 400; i++) { const j = await handoff.next("local", 0, undefined, "service"); if (j) return j; await new Promise((r) => setTimeout(r, 5)); } throw new Error("no job"); };
  const answer = (id: unknown, body: unknown, state: "succeeded" | "failed" | "refused" = "succeeded", message?: string) => {
    if (state === "succeeded") handoff.putContent(String(id), Buffer.from(JSON.stringify(body)));
    handoff.putStatus(String(id), { state, steps: [], result: {} as never, ...(message ? { message } : {}) });
  };
  return { store, handoff, prov, claim, answer };
}

test("requests are checked: a time range always, a UUID or a field and value, at most 100, a node id", () => {
  assert.match((parseProvenance({ uuid: UUID }) as { error: string }).error, /from and to are required/);
  assert.deepEqual(parseProvenance({ uuid: UUID.toUpperCase(), ...WINDOW }), { ...WINDOW, maxResults: 100, uuid: UUID });
  assert.deepEqual(parseProvenance({ field: "Filename", value: " a.csv ", maxResults: 5, node: "node-1", ...WINDOW }), { ...WINDOW, maxResults: 5, field: "Filename", value: "a.csv", node: "node-1" });
  for (const bad of [{ uuid: "x", ...WINDOW }, { ...WINDOW }, { field: "Filename", ...WINDOW }, { uuid: UUID, maxResults: 101, ...WINDOW }, { uuid: UUID, node: "../x", ...WINDOW },
    { uuid: UUID, from: WINDOW.to, to: WINDOW.from }, { uuid: UUID, from: "2026-01-01T00:00:00Z", to: "2026-03-01T00:00:00Z" }])
    assert.ok("error" in parseProvenance(bad), JSON.stringify(bad));
  assert.deepEqual(parseLineage({ uuid: UUID, node: "n1" }), { direction: "FLOWFILE", uuid: UUID, node: "n1" });
  assert.deepEqual(parseLineage({ eventId: 4, direction: "CHILDREN" }), { direction: "CHILDREN", eventId: 4 });
  for (const bad of [{}, { eventId: 4 }, { uuid: "x" }, { eventId: -1, direction: "PARENTS" }, { uuid: UUID, direction: "SIDEWAYS" }]) assert.ok("error" in parseLineage(bad), JSON.stringify(bad));
});

test("the versions tried are supported; others are said to be not", () => {
  for (const v of ["1.12.1", "1.28.1", "2.0.0", "2.5.0"]) assert.equal(provenanceSupport(v).supported, true, v);
  for (const v of ["1.11.4", "3.0.0", ""]) assert.match(provenanceSupport(v).note, /not supported/, v);
});

test("a cluster is searched as a whole through one member; events get their member; the next member when one fails", async () => {
  const x = lab();
  assert.deepEqual(x.prov.info("c250").members.map((m) => [m.key, m.canQuery]), [[KEY1, true], [KEY2, true]]);
  const running = x.prov.search("c250", { uuid: UUID, maxResults: 100, ...WINDOW });
  const a = await x.claim();
  assert.deepEqual([a.kind, a.op, a.member, a.uuid, a.from, a.to, a.maxResults, a.node], ["nifi-provenance", "provenance", KEY1, UUID, WINDOW.from, WINDOW.to, 100, undefined]);
  x.answer(a.id, null, "failed", "NiFi did not answer POST provenance: timed out");
  const b = await x.claim();
  assert.equal(b.member, KEY2, "the other node's executor");
  const ev = (eventId: number, address: string) => ({ eventId, eventType: "CREATE", flowFileUuid: UUID, at: "2026-11-06T15:20:00.000Z", clusterNodeId: address === "localhost:18445" ? "node-1" : "node-2", clusterNodeAddress: address });
  x.answer(b.id, { op: "provenance", events: [ev(1, "localhost:18445"), ev(1, "localhost:18446")], total: 2, timeOffset: 28800000, scope: "cluster", shiftedHours: 14 });
  const r = await running;
  assert.deepEqual(r.events.map((e: { member: string }) => e.member), [KEY1, KEY2]);
  assert.deepEqual([r.via.member, r.scope, r.shiftedHours, r.from], [KEY2, "cluster", 14, WINDOW.from]);
  assert.equal(JSON.stringify(x.store.executorJob(String(b.id))!.status).includes(UUID), false, "events are not kept in the job");
  // The event view gets the offset the search found; lineage and events need the node on a cluster.
  const one = x.prov.event("c250", 1, "node-2");
  const c = await x.claim();
  assert.deepEqual([c.op, c.eventId, c.node, c.timeOffset], ["event", 1, "node-2", 28800000]);
  x.answer(c.id, { op: "event", event: { eventId: 1, clusterNodeAddress: "localhost:18446", attributesHidden: true } });
  assert.equal((await one).member, KEY2);
  await assert.rejects(x.prov.lineage("c250", { direction: "FLOWFILE", uuid: UUID }), /give node/);
  await assert.rejects(x.prov.event("c250", 1), /give node/);
  await assert.rejects(x.prov.event("n112", 1, "node-1"), /only for a cluster/);
  const lin = x.prov.lineage("c250", { direction: "FLOWFILE", uuid: UUID, node: "node-1" });
  const d = await x.claim();
  assert.deepEqual([d.op, d.direction, d.uuid, d.node], ["lineage", "FLOWFILE", UUID, "node-1"]);
  x.answer(d.id, { op: "lineage", nodes: [{ id: UUID, type: "FLOWFILE" }, { id: "1", type: "EVENT", componentName: "Generate" }], links: [{ sourceId: "1", targetId: UUID }] });
  assert.equal((await lin).nodes.length, 2);
  // A refusal is about the request: not tried on the next member.
  const refused = x.prov.search("c250", { field: "Details", value: "x", maxResults: 100, ...WINDOW });
  const e = await x.claim();
  x.answer(e.id, null, "refused", "Details is not searchable on this NiFi");
  await assert.rejects(refused, (err: Error & { status?: number }) => err.status === 400 && /not searchable/.test(err.message));
});

test("a standalone's events are its own; two queries per service at a time; jobs only for an executor that names nifi-provenance@1", async () => {
  const x = lab();
  const first = x.prov.search("n112", { field: "EventType", value: "CREATE", maxResults: 10, ...WINDOW });
  const second = x.prov.search("n112", { field: "EventType", value: "DROP", maxResults: 10, ...WINDOW });
  const third = x.prov.search("n112", { field: "EventType", value: "ROUTE", maxResults: 10, ...WINDOW });
  const a = await x.claim(), b = await x.claim();
  await assert.rejects(third, /Two provenance queries of n112 are running/);
  x.answer(a.id, { op: "provenance", events: [{ eventId: 0, eventType: "CREATE" }] });
  x.answer(b.id, { op: "provenance", events: [] });
  assert.equal((await first).events[0].member, "local:/lab/n112");
  await second;
  // An older executor, and a version not tried.
  const old = lab(["svc-discover", "svc-read", "log-read", "log-tail", "executor-upgrade"]);
  assert.equal(old.prov.info("n112").ready, false);
  assert.match(old.prov.info("n112").members[0]!.reason!, /nifi-provenance@1/);
  await assert.rejects(old.prov.search("n112", { uuid: UUID, maxResults: 100, ...WINDOW }), (err: Error & { code?: string }) => err.code === "executor/unsupported");
  const unsupported = lab(KINDS, "1.11.4");
  assert.equal(unsupported.prov.info("c250").supported, false);
  await assert.rejects(unsupported.prov.search("c250", { uuid: UUID, maxResults: 100, ...WINDOW }), /not supported/);
  assert.throws(() => x.prov.info("nope"), /No standalone instance or cluster/);
  assert.throws(() => old.handoff.submit("nifi-provenance-x", { kind: "nifi-provenance", member: "local:/lab/n112" }, "local", "service"), /nifi-provenance@1/);
});

test("what reaches the AI: attributes with secret-looking names hidden, and the usual redaction of every text", () => {
  const event = { event: { eventId: 7, details: "url https://u:pw@db.example/x", attributes: [
    { name: "filename", value: "a.csv", previousValue: "a.csv" }, { name: "db.password", value: "hunter2", previousValue: "old" },
    { name: "http.headers.Authorization", value: "Bearer abcdefghijkl" }, { name: "api_key", value: "k-123" }, { name: "note", value: "token=abc123" }] } };
  const out = redactProvenance(event);
  assert.deepEqual(out.event.attributes.map((a) => a.value), ["a.csv", "[hidden]", "[hidden]", "[hidden]", "token=[hidden]"]);
  assert.equal(out.event.attributes[1]!.previousValue, "[hidden]");
  assert.equal(out.event.details, "url https://u:[hidden]@db.example/x");
  assert.equal(event.event.attributes[1]!.value, "hunter2", "the page's answer is left alone");
});
