// S37 step 7 (pages-rethink §6 step 7): the e2e_trace evidence source with a fake Studio data plane. The four run-record
// cases of the test data (testdata/e2e-trace/seed.sql) — normal, a failure, stuck at the MQ hand-over, a missing piece
// — through the engine on the model imported from the schedule definitions; the missing piece filled by another source
// (a fake provenance); the T10 allowance from the P95; T9 capabilities; the configuration and import routes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import type { Context } from "hono";
import type { Permission, Principal } from "../src/server/auth.ts";
import { SecretBox } from "../src/server/secretbox.ts";
import { Store } from "../src/server/store.ts";
import { e2eImport, mountE2eTrace } from "../src/server/services/trace/e2e-routes.ts";
import { publishModel } from "../src/server/services/flowmodel.ts";
import { E2E_SAVED_QUERIES, e2eTraceContract } from "../src/server/services/trace/e2e-graph.ts";
import { businessesFrom, E2eTraceSource, E2E_ID, recordEvent } from "../src/server/services/trace/e2e-trace.ts";
import { TraceEngine } from "../src/server/services/trace/engine.ts";
import type { EvidenceAdapter, KeyQuery } from "../src/server/services/trace/events.ts";
import { parseModel, type TraceModel } from "../src/server/services/trace/model.ts";
import { mountTrace } from "../src/server/services/trace/routes.ts";

// Real time: the trace route's engine has no clock of its own to fake.
const NOW = new Date(Math.floor(Date.now() / 1000) * 1000);
const ago = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString();
const box = new SecretBox(Buffer.alloc(32, 7).toString("base64"));
const WORKERS = ["mail_reader", "pdf_parser", "erp_pusher"];
const CID = { A: "aaaaaaaa-0000-4000-8000-00000000000a", B: "bbbbbbbb-0000-4000-8000-00000000000b", C: "cccccccc-0000-4000-8000-00000000000c", D: "dddddddd-0000-4000-8000-00000000000d", E: "eeeeeeee-0000-4000-8000-00000000000e" };
type Case = keyof typeof CID;

/** A run record as the saved query returns it (nullable columns null). */
const rec = (c: Case, seq: number, stage: string, status: string, secondsAgo: number, hasNext = 1) => ({
  row_key: `${CID[c]}|${seq}|${stage}|${secondsAgo}`, correlation_id: CID[c], schedule_id: 101, schedule_name: "invoice_email", schedule_seq: seq, manager_name: "invoice_manager",
  worker_id: 10 + seq, worker_name: WORKERS[seq - 1]!, process_stage: stage, process_status: status, node_name: seq === 2 ? "c250-2" : "c250-1", has_next_worker: hasNext,
  next_worker_names: seq === 3 ? "" : WORKERS[seq]!, final_worker_name: "erp_pusher", file_name: `INV-${c}-001.pdf`, source_path: null,
  email_from: `billing-${c.toLowerCase()}@supplier.example`, email_subject: `Invoice ${c}-001`, received_at: ago(secondsAgo),
});
/** The same four cases as seed.sql (A normal, B failure, C stuck at the MQ hand-over, D pdf_parser missing), plus E: in pdf_parser for 5 minutes. */
const RECORDS = [
  rec("A", 1, "start", "success", 2400), rec("A", 1, "end", "success", 2390), rec("A", 2, "start", "success", 2380), rec("A", 2, "end", "success", 2350), rec("A", 3, "start", "success", 2340), rec("A", 3, "end", "success", 2320, 0),
  rec("B", 1, "start", "success", 2100), rec("B", 1, "end", "success", 2090), rec("B", 2, "start", "success", 2080), rec("B", 2, "end", "failure", 2060, 0),
  rec("C", 1, "start", "success", 3600), rec("C", 1, "end", "success", 3590),
  rec("D", 1, "start", "success", 1800), rec("D", 1, "end", "success", 1790), rec("D", 3, "start", "success", 1700), rec("D", 3, "end", "success", 1690, 0),
  rec("E", 1, "start", "success", 420), rec("E", 1, "end", "success", 410), rec("E", 2, "start", "success", 300),
];
const HEADERS = [
  { schedule_id: 101, schedule_name: "invoice_email", schedule_desc: "Invoices", schedule_type: "business", manager_id: 1, manager_name: "invoice_manager", manager_mq_name: "q.invoice_manager", trigger_exchange_name: "ex.trigger", trigger_routing_key: "invoice.trigger", final_schedule_seq: 3, final_worker_id: 13, project_name: "finance", on_demand_flag: "auto" },
  { schedule_id: 102, schedule_name: "sftp_orders", schedule_desc: null, schedule_type: "data", manager_id: 2, manager_name: "orders_manager", manager_mq_name: null, trigger_exchange_name: null, trigger_routing_key: null, final_schedule_seq: 2, final_worker_id: 22, project_name: null, on_demand_flag: "on_demand" },
];
const step = (id: number, seq: number, w: number, name: string) => ({ row_key: `${id}|${seq}|${w}`, schedule_id: id, schedule_name: id === 101 ? "invoice_email" : "sftp_orders", schedule_seq: seq, worker_id: w, worker_name: name, worker_message_name: `msg.${name}`, previous_worker_id: null, previous_worker_name: null, worker_exchange_name: "ex.worker", worker_routing_key: `r.${name}`, manager_exchange_name: null, manager_routing_key: null });
const DETAILS = [step(101, 2, 12, "pdf_parser"), step(101, 1, 11, "mail_reader"), step(101, 3, 13, "erp_pusher"), step(102, 1, 21, "sftp_fetcher"), step(102, 2, 22, "order_loader")];

/** The data plane as Studio answers run_saved_query: the rows of the query's collection, namespaced. */
function fakeStudio(opts: { durations?: { worker_name: string; p95_seconds: number; samples: number }[]; down?: boolean } = {}) {
  const calls: { name: string; params: Record<string, string> }[] = [];
  const ns = (prefix: string, rows: object[]) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [`${prefix}/${k}`, v])));
  const client = (_url: string, token: string) => ({
    async call(tool: string, args: Record<string, any>) {
      assert.equal(tool, "run_saved_query");
      assert.equal(token, "oat_v1.test-graph-token");
      if (opts.down) throw new Error("connect ECONNREFUSED");
      const { name, params } = args as { name: string; params: Record<string, string> };
      calls.push({ name, params });
      assert.ok(E2E_SAVED_QUERIES.some((q) => q.name === name), `unknown saved query ${name}`);
      const inRange = (r: { received_at: string }) => r.received_at >= params.from! && r.received_at < params.to!;
      const by = (f: (r: (typeof RECORDS)[number]) => boolean, root: string) => ({ result: { [root]: ns("e2e.record", RECORDS.filter((r) => inRange(r) && f(r))) } });
      if (name === "e2e_records_by_correlation") return by((r) => r.correlation_id === params.correlation_id, "e2e.by_correlation/records");
      if (name === "e2e_records_by_file") return by((r) => r.file_name === params.file_name, "e2e.by_file/records");
      if (name === "e2e_records_by_subject") return by((r) => r.email_subject.toLowerCase().includes(params.email_subject!.toLowerCase()), "e2e.by_subject/records");
      if (name === "e2e_records_by_sender") return by((r) => r.email_from.includes(params.email_from!), "e2e.by_sender/records");
      if (name === "e2e_schedules") return { result: { "e2e.schedule/all": ns("e2e.schedule", HEADERS) } };
      if (name === "e2e_schedule_steps") return { result: { "e2e.step/all": ns("e2e.step", DETAILS) } };
      if (name === "e2e_worker_durations") return { result: { "e2e.durations/workers": ns("e2e.duration", (opts.durations ?? []).map((d) => ({ row_key: `invoice_email|${d.worker_name}`, schedule_name: "invoice_email", ...d }))) } };
      throw new Error(`no ${name}`);
    },
  });
  return { client, calls };
}

const actor = { id: "admin", via: "workbench" as const };
function configured(studio = fakeStudio()) {
  const store = new Store(":memory:");
  const source = new E2eTraceSource({ store, box, dataUrl: "http://studio:9632/mcp", client: studio.client, now: () => NOW });
  store.setTraceSource("c250", E2E_ID, { graph: "s37/e2e-trace", token: box.seal("oat_v1.test-graph-token") }, actor);
  return { store, source, studio };
}

/** A provenance stand-in that has the pdf_parser step the run records miss (case D), by correlation_id. */
const provenance = (): EvidenceAdapter & { asked: string[] } => {
  const asked: string[] = [];
  return {
    id: "provenance", asked, capabilities: () => ({ byKey: ["correlation_id"], byPosition: false, handover: [] }),
    async byKey(q: KeyQuery) {
      asked.push(`${q.key.value}@${q.position?.id}`);
      if (q.key.value !== CID.D || q.position?.id !== "pdf_parser") return { events: [] };
      return { events: [{ source: "provenance", service: "c250", key: q.key, position: q.position, at: ago(1750), state: "end" as const, attrs: { correlation_id: CID.D } }] };
    },
  };
};

async function modelOf(source: E2eTraceSource): Promise<TraceModel> {
  const { model } = await source.importModel("c250", { service: "c250", sources: [], businesses: [] });
  const parsed = parseModel("c250", model);
  assert.ok("model" in parsed, JSON.stringify(parsed));
  return parsed.model;
}
const traceOf = async (source: E2eTraceSource, model: TraceModel, clue: Record<string, string>, more: EvidenceAdapter[] = []) => {
  const engine = new TraceEngine({ models: () => [model], adapters: new Map([[E2E_ID, source.adapter], ...more.map((a) => [a.id, a] as [string, EvidenceAdapter])]), now: () => NOW });
  return engine.trace({ service: "c250", ...clue, from: ago(86400), to: NOW.toISOString() });
};

test("e2e_trace: the import makes one business per schedule, steps in schedule_seq order, the MQ trigger as entry with clue mappings", async () => {
  const { source } = configured();
  const model = await modelOf(source);
  assert.deepEqual(model.sources, ["e2e_trace", "provenance"]);
  assert.deepEqual(model.businesses.map((b) => [b.id, b.name, b.steps.map((s) => s.id)]), [["schedule-101", "invoice_email", WORKERS], ["schedule-102", "sftp_orders", ["sftp_fetcher", "order_loader"]]]);
  const [inv, orders] = model.businesses;
  assert.deepEqual(inv!.match, [{ attr: "schedule_name", op: "equals", value: "invoice_email" }]);
  assert.deepEqual(inv!.steps[0]!.position, { kind: "worker", id: "mail_reader", name: "msg.mail_reader" });
  assert.deepEqual(inv!.entries[0]!.channel, { type: "mq", exchange: "ex.trigger", routingKey: "invoice.trigger" });
  assert.deepEqual(inv!.entries[0]!.cues!.map((c) => c.cue), ["fileName", "emailSubject", "emailFrom"]);
  // A schedule without a trigger exchange (null columns) enters from outside.
  assert.deepEqual(orders!.entries[0]!.channel, { type: "external", system: "trigger of sftp_orders" });
  // Importing again replaces the same businesses and keeps the hand-made ones and the source order.
  const again = await source.importModel("c250", { service: "c250", sources: ["provenance"], businesses: [{ ...inv!, name: "renamed" }, { id: "own", name: "Own", match: [], steps: inv!.steps, entries: inv!.entries, exits: [] }] });
  assert.deepEqual(again.replaced, ["schedule-101"]);
  assert.deepEqual(again.imported, ["schedule-102"]);
  assert.deepEqual(again.model.businesses.map((b) => b.id), ["schedule-101", "own", "schedule-102"]);
  assert.equal(again.model.businesses[0]!.name, "invoice_email");
  assert.deepEqual(again.model.sources, ["e2e_trace", "provenance"]);
  // A schedule with no steps is left out, with a note.
  assert.match(businessesFrom([{ ...HEADERS[0]!, schedule_id: 9 }], DETAILS).notes[0]!, /no steps/);
});

test("e2e_trace: the four test cases are judged right (normal, failure, stuck at the MQ hand-over, a gap the records cannot close)", async () => {
  const { source, studio } = configured();
  const model = await modelOf(source);
  const a = await traceOf(source, model, { fileName: "INV-A-001.pdf" });
  assert.equal(a.traces.length, 1);
  assert.deepEqual(a.traces[0]!.start.key, { name: "correlation_id", value: CID.A });
  assert.equal(a.traces[0]!.verdict.kind, "completed");
  assert.deepEqual(a.traces[0]!.segments[0]!.steps.map((s) => s.state), ["done", "done", "done"]);

  const b = await traceOf(source, model, { emailSubject: "invoice b" });
  assert.equal(b.traces[0]!.verdict.kind, "failed");
  assert.equal(b.traces[0]!.verdict.step, "pdf_parser");
  assert.match(b.traces[0]!.verdict.message, /pdf_parser ended in failure on c250-2/);

  const c = await traceOf(source, model, { emailFrom: "billing-c@" });
  assert.equal(c.traces[0]!.verdict.kind, "stuck");
  assert.equal(c.traces[0]!.verdict.step, "mail_reader");
  assert.match(c.traces[0]!.verdict.message, /never reached pdf_parser/);
  assert.equal(c.traces[0]!.segments[0]!.steps[0]!.events.at(-1)!.attrs.next_worker_names, "pdf_parser");

  const d = await traceOf(source, model, { fileName: "INV-D-001.pdf" });
  assert.equal(d.traces[0]!.verdict.kind, "insufficient");
  assert.match(d.traces[0]!.verdict.message, /skip pdf_parser: erp_pusher recorded this data afterwards/);
  // Every run-record query carried a time range, and one trace read one correlation id once (cached across steps).
  assert.ok(studio.calls.every((x) => x.name.startsWith("e2e_schedule") || (x.params.from && x.params.to)));
  assert.equal(studio.calls.filter((x) => x.name === "e2e_records_by_correlation" && x.params.correlation_id === CID.A).length, 1);
});

test("e2e_trace: where the run records miss a step, the engine takes it from the next source (provenance) and goes on", async () => {
  const { source } = configured();
  const model = await modelOf(source);
  const prov = provenance();
  const d = await traceOf(source, model, { fileName: "INV-D-001.pdf" }, [prov]);
  assert.equal(d.traces[0]!.verdict.kind, "completed");
  assert.deepEqual(d.traces[0]!.segments[0]!.steps.map((s) => [s.step, s.state, s.source]), [["mail_reader", "done", "e2e_trace"], ["pdf_parser", "done", "provenance"], ["erp_pusher", "done", "e2e_trace"]]);
  assert.ok(prov.asked.includes(`${CID.D}@pdf_parser`));
  // C is not a gap: provenance is asked too, has nothing, and the verdict stays stuck.
  const c = await traceOf(source, model, { fileName: "INV-C-001.pdf" }, [prov]);
  assert.equal(c.traces[0]!.verdict.kind, "stuck");
});

// The engine's use of `allowance` (model maxSeconds > first source's allowance > default) is step 6's (cc68c4a);
// here the adapter's answer. E (in pdf_parser for 300 s) is in progress under the default either way.
test("e2e_trace T10: a step's allowed time is the worker's P95 (at least 60 s, from 20 runs), else no opinion", async () => {
  const quick = configured(fakeStudio({ durations: [{ worker_name: "pdf_parser", p95_seconds: 100, samples: 40 }] }));
  const q = (id: string, kind: "worker" | "processor" = "worker") => ({ service: "c250", business: "schedule-101", step: id, position: { kind, id } });
  assert.equal(await quick.source.adapter.allowance!(q("pdf_parser")), 100);
  assert.equal(await quick.source.adapter.allowance!(q("erp_pusher")), undefined);
  // Too few runs: no P95.
  const few = configured(fakeStudio({ durations: [{ worker_name: "pdf_parser", p95_seconds: 100, samples: 5 }] }));
  assert.equal(await few.source.allowance("c250", { kind: "worker", id: "pdf_parser" }), undefined);
  assert.equal((await traceOf(few.source, await modelOf(few.source), { fileName: "INV-E-001.pdf" })).traces[0]!.verdict.kind, "in-progress");
  // A small P95 is raised to the floor; a processor position has none.
  const tiny = configured(fakeStudio({ durations: [{ worker_name: "mail_reader", p95_seconds: 3, samples: 99 }] }));
  assert.equal(await tiny.source.allowance("c250", { kind: "worker", id: "mail_reader" }), 60);
  assert.equal(await tiny.source.allowance("c250", { kind: "processor", id: "x" }), undefined);
  // The durations were asked over the last 7 days.
  const asked = quick.studio.calls.find((x) => x.name === "e2e_worker_durations")!;
  assert.equal(new Date(asked.params.to!).getTime() - new Date(asked.params.from!).getTime(), 7 * 86400_000);
});

test("e2e_trace T9: only a configured service has the source; Studio down reads as an error, not as no data", async () => {
  const store = new Store(":memory:");
  const bare = new E2eTraceSource({ store, box, dataUrl: "http://studio:9632/mcp", client: fakeStudio().client });
  assert.deepEqual(bare.capabilities("c250").byKey, []);
  assert.deepEqual(new E2eTraceSource({ store, client: fakeStudio().client }).prerequisites().length, 2);
  const { source } = configured();
  assert.ok((source.capabilities("c250").byKey as string[]).includes("correlation_id"));
  assert.deepEqual(source.capabilities("n112").byKey, []);
  const down = configured(fakeStudio({ down: true }));
  const got = await down.source.byKey({ service: "c250", key: { name: "correlation_id", value: CID.A }, from: ago(3600), to: NOW.toISOString() });
  assert.equal(got.missing?.reason, "error");
  assert.match(got.missing!.message, /ECONNREFUSED/);
  // A processor position cannot be answered from worker records.
  assert.equal((await source.byKey({ service: "c250", key: { name: "correlation_id", value: CID.A }, from: ago(3600), to: NOW.toISOString(), position: { kind: "processor", id: "p" } })).missing?.reason, "unavailable");
  // Nullable columns stay out of the attributes.
  assert.equal("source_path" in recordEvent("c250", rec("A", 1, "start", "success", 10)).attrs, false);
});

test("e2e_trace: the contract and its saved queries name only declared attributes, every record query takes a time range", () => {
  const text = e2eTraceContract();
  for (const q of E2E_SAVED_QUERIES) {
    for (const a of q.eql.match(/:e2e\.[a-z_]+\/[a-z0-9_]+/g) ?? []) assert.ok(text.includes(a), `${q.name}: ${a} is not in the contract`);
    for (const p of q.params) assert.ok(q.eql.includes(`?${p.name}`), `${q.name}: ?${p.name} unused`);
    if (q.name.startsWith("e2e_records_")) assert.deepEqual(q.params.filter((p) => p.name === "from" || p.name === "to").map((p) => p.required), [true, true]);
  }
  assert.match(text, /schedule_header FINAL/);
  assert.match(text, /schedule_detail FINAL/);
});

// The routes, on a bare app with a fake sign-in: "x-as: admin" or a viewer.
function routes(builder?: { call(name: string, args: Record<string, unknown>): Promise<any> }) {
  const store = new Store(":memory:");
  const studio = fakeStudio();
  const source = new E2eTraceSource({ store, box, dataUrl: "http://studio:9632/mcp", client: studio.client, now: () => NOW, ...(builder ? { builder } : {}) });
  const reject = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 429 | 503, code: string, message: string, details: string[] = []) => c.json({ error: { code, message, details } }, status);
  const authenticate = async (c: Context, need: Permission): Promise<Principal | Response> => {
    const admin = c.req.header("x-as") === "admin";
    if (need === "admin" && !admin) return reject(c, 403, "auth/forbidden", "Only Workbench admins change this.");
    return { id: admin ? "admin" : "viewer", displayName: "x", via: "workbench", groups: [], isAdmin: admin, permissions: admin ? ["view", "admin"] : ["view"] } as unknown as Principal;
  };
  const api = new Hono();
  const common = { store, authenticate, reject, registered: (id: string) => (id === "c250" ? {} : undefined), actorOf: (p: Principal) => ({ id: p.id, via: p.via }) };
  mountE2eTrace(api, { ...common, source });
  mountTrace(api, { ...common, provenance: {} as never, adapters: new Map([[E2E_ID, source.adapter]]) });
  const call = async (method: string, path: string, body?: unknown, as = "admin") => {
    const r = await api.request(path, { method, headers: { "content-type": "application/json", "x-as": as }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    return { status: r.status, body: (r.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text) as any };
  };
  return { store, call, source };
}

test("e2e_trace routes: an admin sets the Graph and token (sealed), viewers read only; the imported model is saved and edited like a hand-made one", async () => {
  const { store, call, source } = routes();
  const viewer = await call("GET", "/api/services/c250/trace-sources", undefined, "viewer");
  assert.equal(viewer.status, 200);
  assert.deepEqual([viewer.body.canEdit, viewer.body.e2e_trace, viewer.body.canIssue], [false, null, false]);
  assert.equal((await call("PUT", "/api/services/c250/trace-sources/e2e_trace", { graph: "s37/e2e-trace", token: "oat_v1.test-graph-token" }, "viewer")).status, 403);
  assert.equal((await call("PUT", "/api/services/c250/trace-sources/e2e_trace", { graph: "bad\"name", token: "oat_v1.test-graph-token" })).status, 400);
  assert.equal((await call("PUT", "/api/services/c250/trace-sources/e2e_trace", { graph: "s37/e2e-trace", token: "not-a-token" })).status, 400);
  assert.equal((await call("PUT", "/api/services/c250/trace-sources/e2e_trace", { graph: "s37/e2e-trace" })).status, 503); // no Builder to issue one
  const saved = await call("PUT", "/api/services/c250/trace-sources/e2e_trace", { graph: "s37/e2e-trace", token: "oat_v1.test-graph-token" });
  assert.equal(saved.status, 200);
  assert.deepEqual([saved.body.e2e_trace.graph, saved.body.check.ok, saved.body.check.schedules], ["s37/e2e-trace", true, 2]);
  const kept = JSON.stringify(store.traceSource("c250", E2E_ID)!.body);
  assert.ok(!kept.includes("test-graph-token"), "the token is kept sealed");
  assert.equal((await call("GET", "/api/services/n999/trace-sources")).status, 404);

  // ops step 2: the import route and GET trace-model are gone; publish_model with source e2e_trace takes the schedules
  // (steps, entries, match) and the AI's draft only places them. What the AI wrote in their steps is not kept.
  assert.equal((await call("POST", "/api/services/c250/trace-model/import-e2e", {})).status, 404);
  assert.equal((await call("GET", "/api/services/c250/trace-model", undefined, "viewer")).status, 404);
  const placed = { version: 2, sources: [], segments: ["schedule-101", "schedule-102"].map((id, i) => ({
    id, flow: `new:s${i}`, group: { id: `pg-${i}`, name: `group ${i}` }, slice: "*", role: "segment",
    steps: [{ id: "x", name: "made up", position: { kind: "worker", id: "x" } }], entries: [{ id: "e", step: "x", channel: { type: "external", system: "x" } }], exits: [] })) };
  const deps = { store, e2e: e2eImport(source), now: () => NOW };
  const ai = { id: "assistant", via: "key" } as const;
  await assert.rejects(publishModel(deps, { service: "c250", base: 0, model: { ...placed, segments: placed.segments.slice(0, 1) }, note: "e2e", source: "e2e_trace", actor: ai }), /Place every e2e_trace schedule: .*schedule-102/);
  await assert.rejects(publishModel({ store }, { service: "c250", base: 0, model: placed, note: "e2e", source: "e2e_trace", actor: ai }), /no e2e_trace source/);
  const got = await publishModel(deps, { service: "c250", base: 0, model: placed, note: "e2e", source: "e2e_trace", actor: ai });
  assert.equal(got.verdict, "needs-confirmation", "a first model's businesses are new: a person confirms them");
  const stored = store.flowModel("c250")!;
  assert.deepEqual([stored.revision, stored.source, stored.model.sources], [1, "e2e_trace", ["e2e_trace", "provenance"]]);
  assert.deepEqual(stored.model.segments.map((s) => [s.id, s.origin, s.steps.map((x) => x.id), s.group.id]), [["schedule-101", "e2e_trace", WORKERS, "pg-0"], ["schedule-102", "e2e_trace", ["sftp_fetcher", "order_loader"], "pg-1"]]);
  assert.deepEqual(store.flows("c250").map((f) => [f.name, f.status]), [["group 0", "proposed"], ["group 1", "proposed"]]);
  // The AI publishing on its own later keeps e2e_trace's steps; it may move the segment.
  const again = await publishModel(deps, { service: "c250", base: 1, actor: ai, note: "move", model: { ...stored.model, segments: stored.model.segments.map((s) => ({ ...s, steps: [{ id: "x", name: "x", position: { kind: "worker", id: "x" } }], entries: [{ id: "e", step: "x", channel: { type: "external", system: "x" } }] })) } });
  assert.equal(again.verdict, "published");
  assert.deepEqual(store.flowModel("c250")!.model.segments[0]!.steps.map((x) => x.id), WORKERS);
  const traced = await call("POST", "/api/services/c250/trace-business-data", { fileName: "INV-B-001.pdf", from: ago(86400), to: NOW.toISOString() }, "viewer");
  assert.equal(traced.body.traces[0].verdict.kind, "failed");

  assert.equal((await call("DELETE", "/api/services/c250/trace-sources/e2e_trace")).body.e2e_trace, null);
});

test("e2e_trace routes: without a token the Builder MCP issues one for the graph", async () => {
  const asked: unknown[] = [];
  const { call } = routes({ async call(name, args) { asked.push([name, args]); return { "token-id": "t1", secret: "oat_v1.test-graph-token", record: {} }; } });
  const r = await call("PUT", "/api/services/c250/trace-sources/e2e_trace", { graph: "s37/e2e-trace" });
  assert.equal(r.status, 200);
  assert.equal(r.body.issued, true);
  assert.deepEqual(asked, [["issue_graph_token", { graph: "s37/e2e-trace", label: "open-atlas-deployer c250 e2e_trace" }]]);
  assert.ok(!JSON.stringify(r.body).includes("oat_v1."), "the token is not sent back");
});
