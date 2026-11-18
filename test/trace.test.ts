// S37 step 5 (pages-rethink §4.2.0, S38): the business data trace's core with fake evidence sources — the five
// verdicts (and in-progress), a trace joined across two services by channels (S2S paired, S2S inferred by file name,
// MQ by correlation_id), one source with a gap and another filling it, an expired source, dangling endpoints, the
// model's checks and storage, and the HTTP skeleton.
import assert from "node:assert/strict";
import { test } from "node:test";
import { dangling, links } from "../src/server/services/trace/channels.ts";
import { autoSources, describeStuck, TraceEngine, type TraceQuery } from "../src/server/services/trace/engine.ts";
import { stuckContextFrom } from "../src/server/services/trace/flowstate.ts";
import type { AdapterAnswer, Capabilities, EvidenceAdapter, HandoverQuery, KeyQuery, ObservedEvent, PositionQuery } from "../src/server/services/trace/events.ts";
import { parseModel, type Business, type TraceModel } from "../src/server/services/trace/model.ts";
import { parseTraceQuery } from "../src/server/services/trace/routes.ts";
import { Store } from "../src/server/store.ts";

const NOW = new Date("2026-11-18T10:00:00.000Z");
const at = (min: number) => new Date(NOW.getTime() - (60 - min) * 60_000).toISOString(); // at(0) is an hour ago
const Q: TraceQuery = { service: "n112", fileName: "orders.csv", from: at(-60), to: NOW.toISOString() };

/** A fake source: a list of events, answered by key (with position), by position, and S2S pairing by sourceFlowFileId. */
class Fake implements EvidenceAdapter {
  readonly id: string;
  events: ObservedEvent[];
  caps: Capabilities;
  missing?: AdapterAnswer["missing"];
  fail?: string;
  asked: string[] = [];
  constructor(id: string, events: Partial<ObservedEvent>[], caps: Partial<Capabilities> = {}) {
    this.id = id;
    this.events = events.map((e) => ({ source: id, service: "n112", key: { name: "flowfile", value: "ff-1" }, position: { kind: "processor", id: "p-in" }, at: at(0), state: "end", attrs: {}, ...e }) as ObservedEvent);
    this.caps = { byKey: "*", byPosition: true, handover: ["s2s"], ...caps };
  }
  capabilities() { return this.caps; }
  private answer(events: ObservedEvent[]): AdapterAnswer {
    if (this.fail) throw new Error(this.fail);
    return { events, ...(this.missing && !events.length ? { missing: this.missing } : {}) };
  }
  async byKey(q: KeyQuery) {
    this.asked.push(`key ${q.service} ${q.key.name}=${q.key.value} @${q.position?.id}`);
    return this.answer(this.events.filter((e) => e.service === q.service && (!q.position || e.position.id === q.position.id)
      && (q.key.name === e.key.name ? e.key.value === q.key.value : e.attrs[q.key.name] === q.key.value)));
  }
  async byPosition(q: PositionQuery) {
    this.asked.push(`position ${q.service} @${q.position.id}`);
    return this.answer(this.events.filter((e) => e.service === q.service && e.position.id === q.position.id && e.at >= q.from && e.at <= q.to && (!q.where || e.attrs[q.where.name] === q.where.value)));
  }
  async handover(q: HandoverQuery) {
    this.asked.push(`handover ${q.service} @${q.position.id}`);
    return this.answer(this.events.filter((e) => e.service === q.service && e.position.id === q.position.id && e.attrs.sourceFlowFileId === q.sent.key.value && e.at >= q.from && e.at <= q.to));
  }
}

const pos = (id: string) => ({ kind: "processor" as const, id });
/** n112: in → transform → send (S2S to c250's port "from-n112"); c250: receive → load → out (external "warehouse"). */
function models(over: { n112?: Partial<Business>; c250?: Partial<Business>; sources?: Record<string, string[]> } = {}): TraceModel[] {
  return [
    { service: "n112", sources: over.sources?.n112 ?? ["a", "b"], businesses: [{
      id: "orders", name: "Orders", match: [], steps: [{ id: "in", name: "Pick up", position: pos("p-in") }, { id: "tx", name: "Transform", position: pos("p-tx"), maxSeconds: 300 }, { id: "send", name: "Send", position: pos("p-send") }],
      entries: [{ id: "sftp", step: "in", channel: { type: "external", system: "sftp:/in" }, cues: [{ cue: "fileName", key: "filename" }] }],
      exits: [{ id: "to-c250", step: "send", channel: { type: "s2s", service: "c250", port: "from-n112" } }], ...over.n112 }] },
    { service: "c250", sources: over.sources?.c250 ?? ["a", "b"], businesses: [{
      id: "orders-load", name: "Orders load", match: [], steps: [{ id: "rx", name: "Receive", position: pos("c-rx") }, { id: "load", name: "Load", position: pos("c-load") }],
      entries: [{ id: "from-n112", step: "rx", channel: { type: "s2s", port: "from-n112" } }],
      exits: [{ id: "dw", step: "load", channel: { type: "external", system: "warehouse" } }], ...over.c250 }] },
  ];
}

const n112 = (stepPos: string, min: number, state: ObservedEvent["state"] = "end", extra: Partial<ObservedEvent> = {}): Partial<ObservedEvent> =>
  ({ service: "n112", position: pos(stepPos), at: at(min), state, attrs: { filename: "orders.csv" }, ...extra });
const c250 = (stepPos: string, min: number, state: ObservedEvent["state"] = "end", extra: Partial<ObservedEvent> = {}): Partial<ObservedEvent> =>
  ({ service: "c250", key: { name: "flowfile", value: "ff-9" }, position: pos(stepPos), at: at(min), state, attrs: { filename: "orders.csv", sourceFlowFileId: "ff-1" }, ...extra });
const happy = () => [n112("p-in", 0, "received"), n112("p-tx", 1), n112("p-send", 2, "sent"), c250("c-rx", 2.1, "received"), c250("c-load", 3)];

const engine = (ms: TraceModel[], ...adapters: EvidenceAdapter[]) => new TraceEngine({ models: () => ms, adapters: new Map(adapters.map((a) => [a.id, a])), now: () => NOW });
const one = async (e: TraceEngine, q = Q) => { const r = await e.trace(q); assert.equal(r.traces.length, 1, JSON.stringify(r.notFound ?? r)); return r.traces[0]!; };

test("completed: found at the entry by file name, joined across two services by the S2S channel", async () => {
  const tr = await one(engine(models(), new Fake("a", happy())));
  assert.equal(tr.verdict.kind, "completed");
  assert.equal(tr.verdict.inferred, false);
  assert.deepEqual(tr.segments.map((s) => [s.service, s.steps.map((x) => x.state).join(","), s.handover?.state]), [["n112", "done,done,done", "confirmed"], ["c250", "done,done", "outside"]]);
  assert.deepEqual(tr.segments[1]!.key, { name: "flowfile", value: "ff-9" });
});

test("failed: a failure event stops the trace at its step", async () => {
  const tr = await one(engine(models(), new Fake("a", [n112("p-in", 0), n112("p-tx", 1, "failure", { attrs: { filename: "orders.csv", error: "bad header" } })])));
  assert.deepEqual([tr.verdict.kind, tr.verdict.step, tr.verdict.message], ["failed", "tx", "Failed at Transform: bad header."]);
  assert.deepEqual(tr.segments[0]!.steps.map((s) => s.state), ["done", "failed", "not-reached"]);
});

test("stuck: started and over its time; never reached the next step; in progress while within it", async () => {
  let tr = await one(engine(models(), new Fake("a", [n112("p-in", 0), n112("p-tx", 1, "start")])));
  assert.deepEqual([tr.verdict.kind, tr.verdict.step], ["stuck", "tx"]);
  tr = await one(engine(models(), new Fake("a", [n112("p-in", 0)])));
  assert.deepEqual([tr.verdict.kind, tr.verdict.step], ["stuck", "in"]);
  tr = await one(engine(models(), new Fake("a", [n112("p-in", 58), n112("p-tx", 59, "start")])));
  assert.equal(tr.verdict.kind, "in-progress");
});

test("handover-lost: sent over S2S, the receiver has nothing in the window (not even by file name)", async () => {
  const tr = await one(engine(models(), new Fake("a", happy().slice(0, 3))));
  assert.equal(tr.verdict.kind, "handover-lost");
  assert.equal(tr.segments[0]!.handover?.state, "lost");
  assert.deepEqual(tr.segments[0]!.handover?.to, { service: "c250", business: "orders-load", entry: "from-n112" });
});

test("S2S not pairable: one step down to the same file name in the window, marked inferred (T3)", async () => {
  const events = happy().map((e) => (e.service === "c250" ? { ...e, attrs: { filename: "orders.csv" } } : e));
  const tr = await one(engine(models(), new Fake("a", events)));
  assert.equal(tr.verdict.kind, "completed");
  assert.equal(tr.verdict.inferred, true);
  assert.equal(tr.segments[0]!.handover?.state, "inferred");
  assert.match(tr.segments[0]!.handover!.note!, /same file name/);
});

test("insufficient: a source says its evidence has expired, or none can be asked", async () => {
  const a = new Fake("a", [n112("p-in", 0)]);
  a.missing = { reason: "expired", message: "provenance before 2026-11-18T09:30Z is gone", earliest: at(30) };
  const tr = await one(engine(models({ sources: { n112: ["a"] } }), a));
  assert.equal(tr.verdict.kind, "insufficient");
  assert.match(tr.verdict.message, /expired|gone/);
  // No source of the receiver can pair an S2S hand-over or search by position: not "lost", insufficient.
  const b = new Fake("b", happy().slice(0, 3), { handover: [], byPosition: false });
  const tr2 = await one(engine(models({ sources: { n112: ["b"], c250: ["b"] } }), b));
  assert.equal(tr2.verdict.kind, "insufficient");
});

test("one source has a gap, the next one fills it; a failing source is skipped", async () => {
  const a = new Fake("a", [n112("p-in", 0), n112("p-send", 2, "sent")]); // the run records miss Transform
  const b = new Fake("b", [n112("p-tx", 1), ...happy().slice(3)]);
  const tr = await one(engine(models(), a, b));
  assert.equal(tr.verdict.kind, "completed");
  assert.deepEqual(tr.segments[0]!.steps.map((s) => s.source), ["a", "b", "a"]);
  const broken = new Fake("a", []);
  broken.fail = "Studio did not answer";
  const tr2 = await one(engine(models(), broken, new Fake("b", happy())));
  assert.equal(tr2.verdict.kind, "completed");
  assert.ok(tr2.segments.every((s) => s.steps.every((x) => x.source === "b")));
});

test("MQ: the key travels in correlation_id (or the endpoint's attribute); exit conditions split", async () => {
  const ms = models({
    n112: { exits: [{ id: "mq-x", step: "send", channel: { type: "mq", exchange: "ex", routingKey: "orders" }, when: [{ attr: "kind", op: "equals", value: "order" }] }] },
    c250: { entries: [{ id: "mq-in", step: "rx", channel: { type: "mq", exchange: "ex", routingKey: "orders" } }] },
  });
  const sent = n112("p-send", 2, "sent", { attrs: { filename: "orders.csv", kind: "order", correlation_id: "cid-7" } });
  const recv = c250("c-rx", 2.5, "received", { key: { name: "correlation_id", value: "cid-7" }, attrs: { correlation_id: "cid-7" } });
  const load = c250("c-load", 3, "end", { key: { name: "correlation_id", value: "cid-7" }, attrs: {} });
  let tr = await one(engine(ms, new Fake("a", [n112("p-in", 0), n112("p-tx", 1), sent, recv, load])));
  assert.equal(tr.verdict.kind, "completed");
  assert.deepEqual(tr.segments[0]!.handover?.key, { name: "correlation_id", value: "cid-7" });
  tr = await one(engine(ms, new Fake("a", [n112("p-in", 0), n112("p-tx", 1), sent])));
  assert.equal(tr.verdict.kind, "handover-lost");
  // The exit's condition does not hold: the data ends in this segment.
  tr = await one(engine(ms, new Fake("a", [n112("p-in", 0), n112("p-tx", 1), { ...sent, attrs: { kind: "invoice", filename: "orders.csv" } }])));
  assert.equal(tr.verdict.kind, "completed");
  assert.equal(tr.segments.length, 1);
});

test("children keys are followed inside a segment; match rules pick the business", async () => {
  const ms = models({ n112: { match: [{ attr: "filename", op: "regex", value: "^orders" }] } });
  const tr = await one(engine(ms, new Fake("a", [n112("p-in", 0, "end", { children: [{ name: "flowfile", value: "ff-2" }] }), n112("p-tx", 1, "end", { key: { name: "flowfile", value: "ff-2" } }), n112("p-send", 2, "sent"), ...happy().slice(3)])));
  assert.equal(tr.verdict.kind, "completed");
  const none = await engine(ms, new Fake("a", happy())).trace({ ...Q, fileName: "invoice.csv" });
  assert.equal(none.traces.length, 0);
  assert.equal(none.notFound?.insufficient, false);
});

test("no model, no cue mapping, no clue matched: said, not guessed", async () => {
  assert.match((await engine([], new Fake("a", [])).trace(Q)).notFound!.message, /no business model/);
  assert.match((await engine(models(), new Fake("a", [])).trace({ ...Q, fileName: undefined, emailSubject: "x" })).notFound!.message, /maps the clues/);
  const r = await engine(models({ sources: { n112: ["provenance"] } })).trace(Q);
  assert.equal(r.notFound?.insufficient, true);
  assert.match(r.notes[0]!, /provenance is not available/);
});

test("channels: an exit links to the entry with the same channel; unmatched S2S/MQ endpoints are dangling, external never", () => {
  const ms = models();
  assert.deepEqual(links(ms).map((l) => [l.channel, l.from.service, l.to.service]), [["s2s:c250/from-n112", "n112", "c250"]]);
  assert.deepEqual(dangling(ms), []);
  const only = [ms[0]!];
  assert.deepEqual(dangling(only).map((d) => [d.service, d.side, d.endpoint]), [["n112", "exit", "to-c250"]]);
  assert.deepEqual(dangling([ms[1]!]).map((d) => [d.service, d.side, d.endpoint]), [["c250", "entry", "from-n112"]]);
});

test("a dangling exit makes the trace insufficient (the model is incomplete), not lost", async () => {
  const tr = await one(engine([models()[0]!], new Fake("a", happy())));
  assert.equal(tr.verdict.kind, "insufficient");
  assert.match(tr.verdict.message, /model is incomplete/);
});

test("the model is checked as a whole; storage keeps revisions and refuses a stale save", () => {
  const good = { sources: ["a"], businesses: models()[0]!.businesses };
  assert.ok("model" in parseModel("n112", good));
  const bad = parseModel("n112", { businesses: [{ id: "x y", name: "", steps: [{ id: "s", name: "S", position: { kind: "funnel", id: "" } }], entries: [{ id: "e", step: "nope", channel: { type: "s2s" }, cues: [{ cue: "subject", key: "" }] }],
    exits: [{ id: "o", step: "s", channel: { type: "mq", exchange: "ex" }, when: [{ attr: "a", op: "regex", value: "(" }] }] }] });
  assert.ok("errors" in bad);
  const text = (bad as { errors: string[] }).errors.join("\n");
  for (const want of [/businesses\[0\]\.id/, /name is required/, /position\.kind/, /position\.id/, /entries\[0\]\.step/, /channel\.port/, /cues\[0\]\.cue/, /routingKey/, /regular expression/]) assert.match(text, want);
  const store = new Store(":memory:");
  const actor = { id: "admin", via: "cli" } as const;
  assert.equal(store.saveTraceModel("n112", good, 0, actor), 1);
  assert.equal(store.saveTraceModel("n112", good, 1, actor), 2);
  assert.throws(() => store.saveTraceModel("n112", good, 1, actor), /saved by someone else/);
  assert.equal(store.traceModel("n112")?.revision, 2);
  assert.deepEqual(store.traceModels().map((m) => m.service), ["n112"]);
});

test("trace_business_data's conditions: a clue required, the last 24 hours by default, at most 31 days", () => {
  assert.deepEqual(parseTraceQuery("n112", { fileName: " a.csv " }, NOW), { service: "n112", fileName: "a.csv", from: "2026-11-17T10:00:00.000Z", to: NOW.toISOString() });
  for (const bad of [{}, { fileName: "a", from: "2026-01-01T00:00:00Z", to: "2026-03-01T00:00:00Z" }, { fileName: 3 }, { fileName: "a", from: "x" }])
    assert.ok("error" in parseTraceQuery("n112", bad, NOW), JSON.stringify(bad));
});

// --- S37 step 6: T9–T13 ---

test("T9: a model without sources is traced with every capable adapter, business keys first, provenance filling the gaps", async () => {
  const prov = new Fake("provenance", happy());
  const e2e = new Fake("e2e_trace", [], { byKey: ["correlation_id", "filename"], byPosition: false, handover: [] });
  const off = new Fake("unconfigured", [], { byKey: [], byPosition: false, handover: [] });
  const adapters = new Map<string, EvidenceAdapter>([["provenance", prov], ["e2e_trace", e2e], ["unconfigured", off]]);
  assert.deepEqual(autoSources(adapters, "n112"), ["e2e_trace", "provenance"]);
  const tr = await one(new TraceEngine({ models: () => models({ sources: { n112: [], c250: [] } }), adapters, now: () => NOW }));
  assert.equal(tr.verdict.kind, "completed");
  assert.ok(e2e.asked.length > 0, "the business-key source is asked first");
  assert.deepEqual(off.asked, [], "a source with no capability for the service is not asked");
  assert.ok(tr.segments[0]!.steps.every((s) => s.source === "provenance"));
  assert.ok("model" in parseModel("n112", { businesses: models()[0]!.businesses }), "sources may be left out");
});

test("T10: steps are allowed 600 s by default; a source's allowance (P95) applies, the model's own value wins", async () => {
  const startedAgo = (min: number) => [n112("p-in", 60 - min - 1), n112("p-tx", 60 - min, "start")];
  const noMax = models({ n112: { steps: [{ id: "in", name: "Pick up", position: pos("p-in") }, { id: "tx", name: "Transform", position: pos("p-tx") }, { id: "send", name: "Send", position: pos("p-send") }] } });
  let tr = await one(engine(noMax, new Fake("a", startedAgo(11))));
  assert.deepEqual([tr.verdict.kind, tr.verdict.allowed], ["stuck", { seconds: 600, by: "default" }]);
  tr = await one(engine(noMax, new Fake("a", startedAgo(9))));
  assert.deepEqual([tr.verdict.kind, tr.verdict.allowed?.seconds], ["in-progress", 600]);
  const p95 = Object.assign(new Fake("a", startedAgo(11)), { allowance: async () => 1200 });
  tr = await one(engine(noMax, p95));
  assert.deepEqual([tr.verdict.kind, tr.verdict.allowed], ["in-progress", { seconds: 1200, by: "a" }]);
  // models() gives Transform maxSeconds 300: it wins over the source's 1200.
  tr = await one(engine(models(), Object.assign(new Fake("a", startedAgo(6)), { allowance: async () => 1200 })));
  assert.deepEqual([tr.verdict.kind, tr.verdict.allowed], ["stuck", { seconds: 300, by: "model" }]);
});

test("T11: a stuck verdict carries the connection's queue, back pressure and whether the component downstream runs", async () => {
  const sample = { member: "m1", at: at(55), backpressure: { at: at(55), top: [{ id: "c1", name: "to transform", sourceId: "p-in", destinationId: "p-tx", percentUseCount: 100, flowFilesQueued: 10000 }], notRunning: [{ id: "p-tx", name: "Transform", runStatus: "Stopped" }] } };
  const store = { latestServiceBackpressure: () => sample } as unknown as Store;
  const e = new TraceEngine({ models: () => models(), adapters: new Map([["a", new Fake("a", [n112("p-in", 0)])]]), now: () => NOW, stuckContext: stuckContextFrom(store, () => NOW) });
  const tr = await one(e);
  assert.equal(tr.verdict.kind, "stuck");
  assert.deepEqual(tr.verdict.context?.queue, { name: "to transform", flowFilesQueued: 10000, percent: 100, backpressure: true });
  assert.deepEqual(tr.verdict.context?.downstream, { id: "p-tx", name: "Transform", running: false, runStatus: "Stopped" });
  assert.match(tr.verdict.message, /10000 flowfiles .*back pressure on.*Transform is stopped/);
  // Not among the fullest queues, an old executor without processor states, no reading at all: said, not guessed.
  const old = stuckContextFrom({ latestServiceBackpressure: () => ({ ...sample, backpressure: { top: [] } }) } as unknown as Store, () => NOW)({ service: "n112", from: pos("p-in"), to: pos("p-tx") });
  assert.deepEqual([old.queue, old.downstream?.running], [null, null]);
  assert.match(old.notes.join(" "), /No queue of n112 was above 0 %.*older than 0\.9\.4/);
  const none = stuckContextFrom({ latestServiceBackpressure: () => undefined } as unknown as Store, () => NOW)({ service: "n112", to: pos("p-tx") });
  assert.match(none.notes[0]!, /no back pressure reading/);
  assert.match(describeStuck(none), /no back pressure reading/);
});

test("T12: a dangling exit names the channel and whose model lacks the entry, with a way to complete it", async () => {
  const tr = await one(engine([models()[0]!], new Fake("a", happy())));
  assert.equal(tr.verdict.kind, "insufficient");
  assert.match(tr.verdict.message, /model is incomplete.*exit to-c250 to S2S c250\/from-n112, but c250's model has no entry on input port from-n112/);
  assert.deepEqual(tr.verdict.actions, [{ kind: "edit-model", service: "c250", channel: "s2s:c250/from-n112" }]);
});

test("T13: an external exit ends NiFi's part with when and by what; an external entry with nothing says where to look", async () => {
  const ms = models({ c250: { steps: [{ id: "rx", name: "Receive", position: pos("c-rx") }, { id: "load", name: "Load", position: { kind: "processor", id: "c-load", name: "PutDatabaseRecord" } }] } });
  const tr = await one(engine(ms, new Fake("a", happy())));
  assert.equal(tr.verdict.kind, "completed");
  assert.match(tr.verdict.message, /pushed to warehouse at .* by PutDatabaseRecord \(end\)\. The NiFi part is fine; check in warehouse/);
  assert.deepEqual(tr.verdict.actions, [{ kind: "open-nifi", service: "c250", component: "c-load" }]);
  const r = await engine(models(), new Fake("a", happy())).trace({ ...Q, fileName: "missing.csv" });
  assert.equal(r.notFound?.insufficient, false);
  assert.match(r.notFound!.message, /n112 received no email or file matching fileName missing\.csv .* at sftp:\/in: check that it was sent/);
});

test("S37 step 9: a source that cannot be asked a key is skipped quietly; said only when no source could be asked", async () => {
  const cannot = new Fake("a", []);
  cannot.missing = { reason: "incapable", message: "Provenance of n112: file_name is not searchable on this NiFi" };
  let r = await engine(models(), cannot, new Fake("b", [])).trace(Q);
  assert.deepEqual([r.notFound?.insufficient, r.notFound?.missing.length], [false, 0]);
  r = await engine(models({ sources: { n112: ["a"], c250: ["a"] } }), cannot).trace(Q);
  assert.equal(r.notFound?.insufficient, true);
  assert.deepEqual(r.notFound?.missing.map((m) => [m.source, m.reason]), [["a", "incapable"]]);
});
