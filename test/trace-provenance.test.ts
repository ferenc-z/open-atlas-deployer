// S37 step 6 (§4.2.0 T3/T4): the provenance evidence source with recorded-shape events (the lab's S2S n112 1.12.1 →
// c250 2.5.0 cluster) — event states, positions and children; by key narrowed to a step, by position, the S2S pairing
// by sourceSystemFlowFileId (urn:nifi:<uuid>); expired judged by the nodes' oldest events; an unreadable NiFi is
// unavailable, not empty; and the engine tracing through the adapter end to end.
import assert from "node:assert/strict";
import { test } from "node:test";
import { LogsError } from "../src/server/services/logs.ts";
import type { ProvenanceSearch, ServiceProvenance } from "../src/server/services/provenance.ts";
import { TraceEngine } from "../src/server/services/trace/engine.ts";
import type { TraceModel } from "../src/server/services/trace/model.ts";
import { ProvenanceAdapter, sourceId, stateOf, toEvent } from "../src/server/services/trace/provenance-adapter.ts";

const NOW = new Date("2026-11-18T08:30:00.000Z");
const T = (s: number) => new Date(Date.parse("2026-11-18T08:09:53.000Z") + s * 1000).toISOString();
const SENT = "9f015846-a0e3-4c81-b6fd-54cb73bff75b", RECV = "79946934-a9fc-47a8-8e4d-80ebd36a5f0b";
const ID = { gen: "gen", rename: "rename", remote: "remote-port", port: "c250-port", load: "c250-load" };
const fn = { filename: "orders-20261118-160953.csv" };
const n112 = [
  { eventId: 10, eventType: "CREATE", componentId: ID.gen, componentType: "GenerateFlowFile", componentName: "n112 gen", flowFileUuid: SENT, at: T(0), attributes: { filename: "123" } },
  { eventId: 11, eventType: "ATTRIBUTES_MODIFIED", componentId: ID.rename, componentType: "UpdateAttribute", componentName: "n112 rename", flowFileUuid: SENT, at: T(0.4), attributes: fn },
  { eventId: 12, eventType: "SEND", componentId: ID.remote, componentType: "Remote Input Port", componentName: "from-n112", flowFileUuid: SENT, at: T(0.5), attributes: fn, transitUri: "https://localhost:18446/nifi-api/data-transfer/input-ports/c250-port/transactions/t1/flow-files" },
  { eventId: 13, eventType: "DROP", componentId: ID.remote, componentType: "Remote Input Port", componentName: "from-n112", flowFileUuid: SENT, at: T(0.5), attributes: fn, details: "Remote Input Port sent" },
];
const c250 = [
  { eventId: 10, eventType: "RECEIVE", componentId: ID.port, componentType: "Input Port", componentName: "from-n112", flowFileUuid: RECV, at: T(0.55), attributes: fn, sourceSystemFlowFileId: `urn:nifi:${SENT}`, clusterNodeId: "node-2", clusterNodeAddress: "localhost:18446" },
  { eventId: 11, eventType: "ATTRIBUTES_MODIFIED", componentId: ID.load, componentType: "UpdateAttribute", componentName: "c250 load", flowFileUuid: RECV, at: T(0.6), attributes: { ...fn, loaded: "yes" }, clusterNodeId: "node-2" },
  { eventId: 12, eventType: "DROP", componentId: ID.load, componentType: "UpdateAttribute", componentName: "c250 load", flowFileUuid: RECV, at: T(0.6), attributes: fn, details: "Auto-Terminated by success Relationship", clusterNodeId: "node-2" },
];

/** A ServiceProvenance that answers from lists of events the way the executor's search does (by field, in range). */
function fakeProv(data: Record<string, any[]>, opts: { oldest?: Record<string, string>; fail?: Error; limit?: boolean } = {}) {
  const asked: string[] = [];
  const prov = {
    info: (id: string) => { if (!data[id]) throw new LogsError(404, "service/unknown", "no"); return {}; },
    search: async (id: string, q: ProvenanceSearch) => {
      asked.push(`${id} ${q.uuid ? `uuid=${q.uuid}` : `${q.field}=${q.value}`}${q.attributes ? " +attrs" : ""}`);
      if (opts.fail) throw opts.fail;
      const hit = (e: any) => (q.uuid ? e.flowFileUuid === q.uuid : q.field === "Filename" ? e.attributes?.filename === q.value : q.field === "ProcessorID" ? e.componentId === q.value : e.attributes?.[q.field!] === q.value);
      return { events: data[id]!.filter((e) => e.at >= q.from && e.at <= q.to && hit(e)), limitReached: Boolean(opts.limit), errors: [], oldest: opts.oldest?.[id] ?? "2026-11-07T05:20:29.000Z" };
    },
    oldest: async (id: string) => { asked.push(`${id} oldest`); return [{ node: "node-1", address: "localhost:18445", oldest: "2026-11-07T05:20:29.000Z" }, { node: "node-2", address: "localhost:18446", oldest: opts.oldest?.[id] ?? "2026-11-07T05:20:29.000Z" }]; },
  };
  return { prov: prov as unknown as ServiceProvenance, asked };
}

const W = { from: T(-60), to: NOW.toISOString() };

test("provenance events become observed events: states, positions, children (FORK, JOIN), the S2S source id", () => {
  assert.deepEqual(["RECEIVE", "FETCH", "SEND", "DROP", "EXPIRE", "ROUTE", "CONTENT_MODIFIED"].map((t) => stateOf({ eventType: t })), ["received", "received", "sent", "dropped", "failure", "end", "end"]);
  assert.equal(stateOf({ eventType: "DROP", details: "Auto-Terminated by failure Relationship" }), "failure");
  assert.equal(stateOf({ eventType: "ROUTE", relationship: "failure" }), "failure");
  const r = toEvent("c250", c250[0]);
  assert.deepEqual([r.key, r.position, r.state, r.ref], [{ name: "flowfile", value: RECV }, { kind: "input-port", id: ID.port, name: "from-n112" }, "received", { node: "node-2", eventId: 10 }]);
  assert.equal(sourceId(c250[0]), SENT);
  assert.deepEqual(toEvent("n", { eventType: "FORK", flowFileUuid: "p", childUuids: ["c1", "c2"], at: T(0) }).children, [{ name: "flowfile", value: "c1" }, { name: "flowfile", value: "c2" }]);
  const join = toEvent("n", { eventType: "JOIN", flowFileUuid: "merged", parentUuids: ["p", "q"], at: T(0) }, "p");
  assert.deepEqual([join.key.value, join.children], ["p", [{ name: "flowfile", value: "merged" }]]);
  assert.equal(toEvent("n", { eventType: "DROP", details: "Auto-Terminated by failure Relationship", at: T(0) }).attrs.error, "Auto-Terminated by failure Relationship");
});

test("by key narrowed to the step, by position, the S2S hand-over paired by the source FlowFile id (T3)", async () => {
  const { prov, asked } = fakeProv({ n112, c250 });
  const a = new ProvenanceAdapter(prov, () => NOW.getTime());
  assert.deepEqual(a.capabilities("n112"), { byKey: "*", byPosition: true, handover: ["s2s"] });
  assert.deepEqual(a.capabilities("nope").byKey, []);
  const start = await a.byKey({ service: "n112", key: { name: "filename", value: fn.filename }, ...W, position: { kind: "processor", id: ID.rename } });
  assert.deepEqual(start.events.map((e) => [e.key.value, e.state]), [[SENT, "end"]]);
  // Every step asks for the same FlowFile: one search for the trace.
  for (const id of [ID.gen, ID.rename, ID.remote]) await a.byKey({ service: "n112", key: { name: "flowfile", value: SENT }, ...W, position: { kind: "processor", id } });
  assert.equal(asked.filter((x) => x.includes(`uuid=${SENT}`)).length, 1);
  assert.ok(asked.every((x) => x.endsWith("+attrs") || x.endsWith("oldest")), "the trace asks with attributes");
  const sent = (await a.byKey({ service: "n112", key: { name: "flowfile", value: SENT }, ...W, position: { kind: "input-port", id: ID.remote } })).events.find((e) => e.state === "sent")!;
  const window = { from: T(-119.5), to: T(120.5) };
  const paired = await a.handover({ service: "c250", channel: "s2s", sent, position: { kind: "input-port", id: ID.port }, ...window });
  assert.deepEqual(paired.events.map((e) => e.key.value), [RECV]);
  const other = await a.handover({ service: "c250", channel: "s2s", sent: { ...sent, key: { name: "flowfile", value: "00000000-0000-4000-8000-000000000000" } }, position: { kind: "input-port", id: ID.port }, ...window });
  assert.deepEqual(other.events, []);
  const byName = await a.byPosition({ service: "c250", position: { kind: "input-port", id: ID.port }, ...window, where: { name: "filename", value: fn.filename } });
  assert.deepEqual(byName.events.map((e) => e.key.value), [RECV]);
  const pg = await a.byPosition({ service: "c250", position: { kind: "process-group", id: "pg" }, ...window });
  assert.match(pg.missing!.message, /process group/);
});

test("T4: nothing found in a range that starts before a node's oldest event is expired; NiFi unreadable is unavailable", async () => {
  const { prov } = fakeProv({ n112, c250 }, { oldest: { c250: "2026-11-18T08:05:00.000Z" } });
  const a = new ProvenanceAdapter(prov, () => NOW.getTime());
  const gone = await a.byKey({ service: "c250", key: { name: "filename", value: "old.csv" }, from: "2026-11-18T07:00:00.000Z", to: NOW.toISOString() });
  assert.equal(gone.missing?.reason, "expired");
  assert.equal(gone.missing?.earliest, "2026-11-18T08:05:00.000Z");
  assert.match(gone.missing!.message, /on localhost:18446 holds events from 2026-11-18T08:05:00.000Z/);
  const fresh = await a.byKey({ service: "c250", key: { name: "filename", value: "old.csv" }, from: "2026-11-18T08:06:00.000Z", to: NOW.toISOString() });
  assert.deepEqual(fresh, { events: [] }, "within what NiFi holds: simply nothing there");
  const off = new ProvenanceAdapter(fakeProv({ n112 }, { fail: new LogsError(409, "provenance/executor-offline", "Every member's service executor is offline.") }).prov);
  assert.equal((await off.byKey({ service: "n112", key: { name: "filename", value: "x" }, ...W })).missing?.reason, "unavailable");
  const full = new ProvenanceAdapter(fakeProv({ n112 }, { limit: true }).prov, () => NOW.getTime());
  assert.match((await full.byKey({ service: "n112", key: { name: "filename", value: "x" }, ...W })).missing!.message, /limit of 100/);
});

test("the engine traces through the adapter: n112 by file name, over S2S to c250, completed; the receiver's events hidden: handover-lost", async () => {
  const model = (service: string, steps: [string, string, "processor" | "input-port"][], entries: any[], exits: any[]) => ({ service, sources: [], businesses: [{ id: "orders", name: `Orders ${service}`, match: [], steps: steps.map(([id, pid, kind]) => ({ id, name: id, position: { kind, id: pid } })), entries, exits }] }) as TraceModel;
  const models = [
    model("n112", [["gen", ID.gen, "processor"], ["rename", ID.rename, "processor"], ["send", ID.remote, "input-port"]], [{ id: "in", step: "rename", channel: { type: "external", system: "generator" }, cues: [{ cue: "fileName", key: "filename" }] }], [{ id: "to-c250", step: "send", channel: { type: "s2s", service: "c250", port: "from-n112" } }]),
    model("c250", [["rx", ID.port, "input-port"], ["load", ID.load, "processor"]], [{ id: "from-n112", step: "rx", channel: { type: "s2s", port: "from-n112" } }], [{ id: "db", step: "load", channel: { type: "external", system: "warehouse" } }]),
  ];
  const run = async (data: Record<string, any[]>) => {
    const a = new ProvenanceAdapter(fakeProv(data).prov, () => NOW.getTime());
    const e = new TraceEngine({ models: () => models, adapters: new Map([["provenance", a]]), now: () => NOW });
    const r = await e.trace({ service: "n112", fileName: fn.filename, from: T(-3600), to: NOW.toISOString() });
    assert.equal(r.traces.length, 1, JSON.stringify(r));
    return r.traces[0]!;
  };
  let tr = await run({ n112, c250 });
  assert.equal(tr.verdict.kind, "completed", tr.verdict.message);
  assert.deepEqual(tr.segments.map((s) => [s.service, s.handover?.state]), [["n112", "confirmed"], ["c250", "outside"]]);
  assert.deepEqual(tr.segments[1]!.key, { name: "flowfile", value: RECV });
  tr = await run({ n112, c250: [] });
  assert.equal(tr.verdict.kind, "handover-lost", tr.verdict.message);
});
