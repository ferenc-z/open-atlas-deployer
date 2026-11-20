// Ops step 5 (pages-rethink A1): starting the AI's analyses — Check now, a round, machine-red, user-visit (deduplicated),
// flows feedback, following the session (timeout, an answer without a record) — and the check-up's OMA schedule.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import type { OmaEvent } from "../src/server/oma.ts";
import { Analyses, AnalysisError, checkupDone } from "../src/server/services/analyses.ts";
import { mountAnalyses } from "../src/server/services/analysis-routes.ts";
import { CHECKUP_MESSAGE, CheckupSchedule } from "../src/server/services/checkup-schedule.ts";
import { mountFlows } from "../src/server/services/flow-routes.ts";
import { mountPages } from "../src/server/services/page-routes.ts";
import { opsPageSources } from "../src/server/services/page-views.ts";
import type { MachineTurn } from "../src/server/services/rules.ts";
import type { Lights } from "../src/server/services/ops-types.ts";
import { opsReads, parseRecord, record, todoSink } from "../src/server/services/todos.ts";
import { Store } from "../src/server/store.ts";

const admin = { id: "admin", via: "cli" } as const;
const node = (installDir: string, https: number) => ({ host: "local", installDir, serviceUser: "ferenc", startEnvironment: null, ports: { https }, nodeAddress: "localhost", discovery: null });
const T0 = "2026-11-19T10:00:00.000Z";
const tick = () => new Promise((r) => setImmediate(r));

function fakeOma() {
  const opened: { title: string; key: string; text: string; id: string }[] = [];
  const log = new Map<string, OmaEvent[]>();
  const o = {
    opened, log, down: false,
    open: async (title: string, key: string, text: string) => {
      if (o.down) throw new Error("OMA is down");
      const id = `ses_${opened.length + 1}`;
      opened.push({ title, key, text, id });
      log.set(id, [{ type: "user.message", content: [{ type: "text", text }] }]);
      return id;
    },
    events: async (s: string) => log.get(s) ?? [],
    answer: (s: string) => log.get(s)!.push({ type: "agent.message", content: [{ type: "text", text: "done" }] }, { type: "session.status_idle" }),
  };
  return o;
}

function setup(o: { oma?: boolean } = {}) {
  const now = { t: new Date(T0) };
  const store = new Store(":memory:", () => now.t);
  store.addCluster({ kind: "cluster", id: "c250", service: "nifi", profile: "nifi-2.x", version: "2.5.0", webUrl: null, zookeeper: "zk:2181", zookeeperRoot: "/c250", nodes: [node("/lab/c250-1", 18445), node("/lab/c250-2", 18446)] } as never, "uat", admin);
  store.addStandalone({ kind: "standalone", id: "n112", service: "nifi", profile: "nifi-2.x", version: "2.5.0", webUrl: null, member: node("/lab/n112", 18443) } as never, "uat", admin);
  const lights = new Map<string, Lights>([["c250", { machine: "failing", business: "healthy" }], ["n112", { machine: "healthy", business: "healthy" }]]);
  const oma = fakeOma();
  const analyses = new Analyses({ store, ...(o.oma === false ? {} : { oma }), lights: (s) => lights.get(s)!, services: () => ["c250", "n112"], now: () => now.t });
  return { now, store, lights, oma, analyses };
}

const recordFor = (store: Store, service: string, body: Record<string, unknown>, at: Date) =>
  record({ store, actor: { id: "checkup", via: "service" }, scope: "full", lights: () => ({ machine: "failing", business: "healthy" }), now: () => at },
    parseRecord(service, { ...body, analysis: { machine: "机器", business: "业务", summary: "原因", lookedAt: ["日志"], ...(body.analysis as object) } }));

test("Check now: a running row first, then one session whose first message names the analysis id; 409 while it runs", async () => {
  const t = setup();
  const a = t.analyses.checkNow("c250", "alice");
  assert.equal(a.state, "running");
  assert.equal(a.trigger, "check-now");
  assert.equal(a.requestedBy, "alice");
  assert.equal(a.machineLight, "failing", "the lights at the start are kept (stale)");
  await tick();
  assert.equal(t.oma.opened.length, 1);
  assert.match(t.oma.opened[0]!.text, new RegExp(`"analysis_id": ${a.id}`));
  assert.match(t.oma.opened[0]!.text, /trigger: check-now/);
  assert.equal(t.store.analysis(a.id)!.session, "ses_1");
  assert.throws(() => t.analyses.checkNow("c250", "bob"), (e: unknown) => e instanceof AnalysisError && e.status === 409 && e.analysis?.id === a.id);
  // The agent records into it: done.
  recordFor(t.store, "c250", { analysisId: a.id, analysis: { trigger: "check-now" } }, t.now.t);
  assert.equal(t.store.analysis(a.id)!.state, "done");
  assert.equal(t.analyses.checkNow("c250", "bob").state, "running", "a new one once it is done");
  const off = setup({ oma: false });
  assert.throws(() => off.analyses.checkNow("c250", "alice"), (e: unknown) => e instanceof AnalysisError && e.status === 503);
  assert.equal(off.store.analyses("c250").length, 0);
});

test("following the session: an answer without a record, an OMA error at opening, and no answer in time all fail the row", async () => {
  const t = setup();
  const a = t.analyses.checkNow("c250", "alice");
  await tick();
  await t.analyses.poll();
  assert.equal(t.store.analysis(a.id)!.state, "running");
  t.oma.answer("ses_1");
  await t.analyses.poll();
  assert.equal(t.store.analysis(a.id)!.state, "failed");
  assert.match(t.store.analysis(a.id)!.error!, /without recording/);

  t.oma.down = true;
  const b = t.analyses.checkNow("c250", "alice");
  await tick();
  assert.equal(t.store.analysis(b.id)!.state, "failed");
  assert.match(t.store.analysis(b.id)!.error!, /OMA is down/);

  t.oma.down = false;
  const c = t.analyses.checkNow("c250", "alice");
  await tick();
  t.now.t = new Date(Date.parse(T0) + 11 * 60_000);
  await t.analyses.poll();
  assert.equal(t.store.analysis(c.id)!.state, "failed");
  assert.match(t.store.analysis(c.id)!.error!, /No answer after 10 minutes/);

  // A running row whose session never opened (the Deployer restarted) fails after a grace period.
  const id = t.store.addAnalysis({ service: "n112", run: null, trigger: "check-now", state: "running", session: null, requestedBy: "x", startedAt: t.now.t.toISOString(), finishedAt: null, machineLight: "healthy", businessLight: "healthy", body: null, error: null });
  await t.analyses.poll();
  assert.equal(t.store.analysis(id)!.state, "running");
  t.now.t = new Date(t.now.t.getTime() + 3 * 60_000);
  await t.analyses.poll();
  assert.equal(t.store.analysis(id)!.state, "failed");
});

test("a round: one session over every service, one run; 409 while it runs; the overview's last check-up", async () => {
  const t = setup();
  const r = t.analyses.round("alice");
  assert.deepEqual(r.services, ["c250", "n112"]);
  await tick();
  assert.equal(t.oma.opened.length, 1, "one session");
  const rows = t.store.analysisRun(r.run);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((a) => a.session === "ses_1" && a.trigger === "check-now"));
  assert.throws(() => t.analyses.round("bob"), (e: unknown) => e instanceof AnalysisError && e.status === 409 && e.run === r.run);
  assert.deepEqual(opsReads(t.store, () => t.now.t).lastCheckup(), { at: T0, trigger: "check-now", state: "running" });
  for (const a of rows) recordFor(t.store, a.service, { analysisId: a.id, analysis: { trigger: "check-now" } }, t.now.t);
  assert.equal(opsReads(t.store, () => t.now.t).lastCheckup()!.state, "done");
  // A service already being analysed is left out of a round.
  t.analyses.checkNow("c250", "alice");
  assert.deepEqual(t.analyses.round("alice").services, ["n112"]);
});

test("machine-red starts an analysis at once (not recovery, not while one runs)", async () => {
  const t = setup();
  const turn = (kind: MachineTurn["kind"]): MachineTurn => ({ service: "c250", kind, from: "healthy", to: kind === "machine-red" ? "failing" : "healthy", at: T0, text: "c250-2 process down" });
  assert.equal(t.analyses.machineTurn(turn("machine-recovered")), null);
  const a = t.analyses.machineTurn(turn("machine-red"))!;
  assert.equal(a.trigger, "machine-red");
  assert.equal(a.requestedBy, "deployer");
  await tick();
  assert.match(t.oma.opened[0]!.text, /c250-2 process down/);
  assert.equal(t.analyses.machineTurn(turn("machine-red")), null, "one runs already");
});

test("user-visit: only for a service that is not green with an out-of-date analysis, at most once an hour, once for concurrent visits", async () => {
  const t = setup();
  const reads = () => opsReads(t.store, () => t.now.t);
  const seen = (s: string) => ({ service: s, ...t.lights.get(s)!, analysis: reads().analysis(s, t.lights.get(s)) });
  assert.deepEqual(t.analyses.visit([seen("n112")], "alice"), [], "green: nothing");
  // Two visits in the same moment (the overview and the page, the 15-second polling): one analysis.
  const first = t.analyses.visit([seen("c250"), seen("n112")], "alice");
  assert.deepEqual(first.map((a) => [a.service, a.trigger]), [["c250", "user-visit"]]);
  assert.deepEqual(t.analyses.visit([seen("c250")], "bob"), []);
  await tick();
  recordFor(t.store, "c250", { analysisId: first[0]!.id, analysis: { trigger: "user-visit" } }, t.now.t);
  // Fresh: nothing. A light changed (out of date) but within the hour of the last user-visit: still nothing.
  assert.deepEqual(t.analyses.visit([seen("c250")], "alice"), []);
  t.lights.set("c250", { machine: "attention", business: "healthy" });
  assert.equal(seen("c250").analysis!.stale, true);
  assert.deepEqual(t.analyses.visit([seen("c250")], "alice"), []);
  t.now.t = new Date(Date.parse(T0) + 61 * 60_000);
  assert.equal(t.analyses.visit([seen("c250")], "alice").length, 1, "an hour later, out of date: again");
  // The table counts too (a Deployer restarted within the hour does not start another).
  const again = new Analyses({ store: t.store, oma: t.oma, lights: (s) => t.lights.get(s)!, services: () => ["c250"], now: () => new Date(t.now.t.getTime() + 30 * 60_000) });
  t.store.setAnalysis({ ...t.store.analyses("c250")[0]!, state: "failed", finishedAt: t.now.t.toISOString(), error: "x" });
  assert.deepEqual(again.visit([{ service: "c250", machine: "attention", business: "healthy", analysis: null }], "alice"), []);
});

test("the pages: a person's visit starts it (the page shows it running), a key's does not", async () => {
  const t = setup();
  const sources = opsPageSources(t.store);
  const app = new Hono();
  let who: Record<string, unknown> = { id: "alice", via: "workbench", permissions: ["view"] };
  mountPages(app, {
    store: t.store, executor: () => ({ online: false, host: "local" }) as never, sources,
    authenticate: async () => who as never, reject: (c, s, code) => c.json({ error: code }, s),
    visit: (seen, by) => t.analyses.visit(seen.map((v) => ({ ...v, ...t.lights.get(v.service)! })), by), view: (a) => t.analyses.view(a),
  });
  who = { id: "dpc", via: "service", permissions: ["view"] };
  await app.request("/api/services/c250/page");
  assert.equal(t.store.analyses("c250").length, 0, "the AI's key is no visit");
  who = { id: "alice", via: "workbench", permissions: ["view"] };
  const page = await (await app.request("/api/services/c250/page")).json() as { analysis: { state: string; trigger: string } };
  assert.deepEqual([page.analysis.state, page.analysis.trigger], ["running", "user-visit"]);
  await app.request("/api/services/overview");
  assert.equal(t.store.analyses("c250", 10).length, 1, "the overview right after: no second one");
});

test("HTTP #3, #4, #5: 202 running, 409 with the running one, 503 without the agent, 404 unknown", async () => {
  const t = setup();
  const app = new Hono();
  mountAnalyses(app, { store: t.store, analyses: t.analyses, authenticate: async () => ({ id: "alice", via: "workbench", permissions: ["view"] }) as never, reject: (c, s, code, message) => c.json({ error: code, message }, s), registered: (id) => ["c250", "n112"].includes(id) });
  const post = (p: string) => app.request(p, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
  const r1 = await post("/api/services/c250/analyses");
  assert.equal(r1.status, 202);
  const a = await r1.json() as { id: number; state: string; trigger: string };
  assert.deepEqual([a.state, a.trigger], ["running", "check-now"]);
  const r2 = await post("/api/services/c250/analyses");
  assert.equal(r2.status, 409);
  assert.deepEqual(await r2.json().then((b: any) => [b.error, b.analysis.id]), ["analysis/running", a.id]);
  assert.equal((await post("/api/services/nope/analyses")).status, 404);
  const got = await (await app.request(`/api/analyses/${a.id}`)).json() as { id: number; state: string };
  assert.deepEqual([got.id, got.state], [a.id, "running"]);
  assert.equal((await app.request("/api/analyses/999")).status, 404);
  const r4 = await post("/api/analyses");
  assert.equal(r4.status, 202);
  assert.deepEqual((await r4.json() as { services: string[] }).services, ["n112"], "c250 runs already");
  assert.equal((await post("/api/analyses")).status, 409);
  const off = new Hono();
  mountAnalyses(off, { store: t.store, authenticate: async () => ({ id: "alice", via: "workbench", permissions: ["view"] }) as never, reject: (c, s, code) => c.json({ error: code }, s), registered: () => true });
  assert.equal((await off.request("/api/analyses", { method: "POST" })).status, 503);
  assert.equal((await off.request(`/api/analyses/${a.id}`)).status, 200, "reading still works");
});

test("flows feedback: split and not-right start a flows-feedback analysis with what the person said", async () => {
  const t = setup();
  const flow = "flw_abc123";
  t.store.putFlow({ id: flow, name: "发票入库", nameBy: "ai", status: "proposed", summary: "in → out", reason: null, risks: [], pending: null, stuck: null, createdAt: T0, confirmedAt: null, confirmedBy: null, updatedAt: T0 } as never);
  t.store.setFlowSegments(flow, [{ service: "n112", segment: "A" }, { service: "c250", segment: "B" }]);
  const app = new Hono();
  mountFlows(app, {
    store: t.store, model: { store: t.store, todos: todoSink(t.store) } as never, authenticate: async () => ({ id: "alice", via: "workbench", permissions: ["view", "admin"] }) as never,
    reject: (c, s, code) => c.json({ error: code }, s), registered: () => true, actorOf: (p) => ({ id: p.id, via: p.via }),
    feedback: (f, services, kind, note, by) => t.analyses.feedback(f, services, kind, note, by),
  });
  const act = (body: unknown) => app.request(`/api/flows/${flow}/actions`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  assert.equal((await act({ kind: "rename", name: "发票" })).status, 200);
  assert.equal(t.store.analyses("n112").length, 0, "a rename starts nothing");
  assert.equal((await act({ kind: "not-right", note: "c250 那段是另一条业务" })).status, 200);
  await tick();
  const rows = [t.store.analyses("n112")[0]!, t.store.analyses("c250")[0]!];
  assert.ok(rows.every((a) => a.trigger === "flows-feedback" && a.state === "running" && a.session === "ses_1"), "one session over both services");
  assert.match(t.oma.opened[0]!.text, /c250 那段是另一条业务/);
  assert.match(t.oma.opened[0]!.text, /"flow": "flw_abc123"/);
});

test("the scheduled check-up's analyses (no ids) make one round and never fill another start's running row; the brief waits for them", () => {
  const t = setup();
  const visit = t.analyses.visit([{ service: "c250", machine: "failing", business: "healthy", analysis: null }], "alice")[0]!;
  const r1 = recordFor(t.store, "c250", { analysis: { trigger: "schedule" } }, t.now.t);
  assert.notEqual(r1.analysis, visit.id);
  assert.equal(t.store.analysis(visit.id)!.state, "running", "the user-visit row is left alone");
  assert.equal(checkupDone(t.store, ["c250", "n112"], new Date(Date.parse(T0) - 3_600_000)), false);
  const later = new Date(Date.parse(T0) + 5 * 60_000);
  const r2 = recordFor(t.store, "n112", { analysis: { trigger: "schedule" } }, later);
  const a1 = t.store.analysis(r1.analysis!)!, a2 = t.store.analysis(r2.analysis!)!;
  assert.ok(a1.run && a1.run === a2.run, "one round");
  assert.equal(opsReads(t.store, () => later).lastCheckup()!.trigger, "schedule");
  assert.equal(checkupDone(t.store, ["c250", "n112"], new Date(Date.parse(T0) - 3_600_000)), true);
  // Four hours later: a new round.
  const r3 = recordFor(t.store, "c250", { analysis: { trigger: "schedule" } }, new Date(Date.parse(T0) + 4 * 3_600_000));
  assert.notEqual(t.store.analysis(r3.analysis!)!.run, a1.run);
});

test("the OMA schedule: created when missing, left alone when it matches, put back when it differs", async () => {
  const calls: string[] = [];
  const schedules: any[] = [];
  let agentVersion = 3;
  const fetcher = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}`);
    assert.equal(new Headers(init?.headers).get("x-api-key"), "oma-key");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname === "/v1/agents/agent-chk") return Response.json({ id: "agent-chk", version: agentVersion });
    if (url.pathname === "/v1/agent-schedules" && method === "GET") return Response.json({ data: schedules });
    const row = (id: string) => ({ id, name: body.name, agent_id: body.agent_id, agent_version: body.agent_version, environment_id: body.environment_id ?? "env-local-runtime", initial_message: body.initial_message, cron_expression: body.cron.expression, timezone: body.cron.timezone, vault_ids: body.vault_ids, status: "active", next_run_at: "2026-11-19T12:00:00.000Z" });
    if (url.pathname === "/v1/agent-schedules" && method === "POST") { const s = row("sch_1"); schedules.push(s); return Response.json(s, { status: 201 }); }
    if (url.pathname === "/v1/agent-schedules/sch_1" && method === "PUT") { schedules[0] = row("sch_1"); return Response.json(schedules[0]); }
    return Response.json({ error: "not found" }, { status: 404 });
  }) as typeof fetch;
  const config = { url: "http://oma:8787/", keyFile: () => "oma-key", agent: "agent-chk", vaults: ["vlt_dpc"], cron: "0 */4 * * *", timezone: "Asia/Shanghai", name: "deployer-checkup-uat" };
  const s = new CheckupSchedule(config, fetcher);
  const made = await s.ensure();
  assert.deepEqual(made, { action: "created", id: "sch_1", nextRunAt: "2026-11-19T12:00:00.000Z" });
  assert.equal(schedules[0].initial_message, CHECKUP_MESSAGE);
  assert.deepEqual([schedules[0].agent_version, schedules[0].vault_ids, schedules[0].timezone], [3, ["vlt_dpc"], "Asia/Shanghai"]);
  assert.equal((await s.ensure()).action, "unchanged");
  assert.equal(s.nextRunAt, "2026-11-19T12:00:00.000Z");
  agentVersion = 4;
  assert.equal((await s.ensure()).action, "updated", "a new agent version");
  assert.equal(schedules[0].agent_version, 4);
  assert.equal((await new CheckupSchedule({ ...config, cron: "0 */8 * * *" }, fetcher).ensure()).action, "updated");
  assert.equal(schedules.length, 1);
  assert.ok(!calls.some((c) => c.startsWith("DELETE")));
  await assert.rejects(new CheckupSchedule({ ...config, agent: "nope" }, fetcher).ensure(), /HTTP 404: not found/);
});
