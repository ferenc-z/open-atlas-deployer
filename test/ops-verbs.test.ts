// pages-rethink §10.2 step 4: the managed-service MCP collapsed into seven verbs, who sees which (a personal key as its
// owner, the Assistant's dps_ with publish_model and record for to-dos only, the check-up's dpc_ without draft_change),
// the to-dos and analyses record writes, the gate's to-dos through the sink, and the to-do buttons.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/server/app.ts";
import { opsBusinessHooks, opsPageSources } from "../src/server/services/page-views.ts";
import { permissionsFor, WorkbenchSessions, type Principal } from "../src/server/auth.ts";
import type { Config } from "../src/server/config.ts";
import { Deployments } from "../src/server/deploy.ts";
import { WorkbenchAdmin } from "../src/server/drivers/workbench.ts";
import { EnvManager, Schemas } from "../src/server/env.ts";
import { Handoff } from "../src/server/handoff.ts";
import type { Keys } from "../src/server/keys.ts";
import { TOOLS } from "../src/server/mcp.ts";
import { Observer } from "../src/server/observe.ts";
import { SecretBox } from "../src/server/secretbox.ts";
import { topologyFingerprint, topologyHash, type Topology, type TopologyFragment } from "../src/server/services/flowcounts.ts";
import { analysisMessage } from "../src/server/services/analyses.ts";
import { CHECKUP_MESSAGE } from "../src/server/services/checkup-schedule.ts";
import { INLINE_BUDGET, inlineBytes } from "../src/server/services/look-summary.ts";
import { draftFromSkeleton } from "../src/server/services/flowmodel.ts";
import { opsReads, todoSink } from "../src/server/services/todos.ts";
import { Store, type FlowCountRow } from "../src/server/store.ts";
import { Versions } from "../src/server/versions.ts";

const NOW = new Date("2026-11-19T12:00:00Z");
const box = new SecretBox(Buffer.alloc(32, 9).toString("base64"));
const USERS: Record<string, { groups: string[]; isAdmin?: boolean }> = { viewer: { groups: ["deploy-viewer"] }, admin: { groups: [], isAdmin: true } };
const person = (id: string, groups: string[], isAdmin = false): Principal => ({ id, displayName: id, via: "key", keyKind: "personal", groups, isAdmin, permissions: permissionsFor(groups, isAdmin), csrfToken: "" });
const bot = (id: string, keyKind: "service" | "checkup"): Principal => ({ id, displayName: id, via: "service", keyKind, groups: [], isAdmin: false, permissions: ["view"], csrfToken: "" });
const KEYS: Record<string, Principal> = { dpk_viewer: person("v@x", ["deploy-viewer"]), dpk_admin: person("a@x", [], true), dps_assistant: bot("service:assistant", "service"), dpc_checkup: bot("checkup:checkup", "checkup") };
const VERBS = ["describe", "look", "trace", "run_model", "publish_model", "record", "draft_change"];
const OLD = ["get_metrics", "list_alerts", "list_events", "get_bulletins", "search_logs", "tail_logs", "search_provenance", "get_lineage", "get_provenance_event", "get_service_config", "diff_service_config", "draft_service_config", "list_service_changes", "get_service_change", "get_service_drift", "lookup_property", "get_service_health", "investigate_service", "list_service_cases", "trace_business_data", "list_service_clusters", "get_cluster_status"];

const frag = (key: string, more: Partial<TopologyFragment> = {}): TopologyFragment => ({ key, processors: 1, names: [key], inputs: [], outputs: [], remoteIn: [], s2sOut: [], starts: 1, ...more });
const row = (bucket: string, ref: string, fin: number, fout: number): FlowCountRow => ({ service: "n1", bucket, kind: "group", ref, name: ref, flowfilesIn: fin, flowfilesOut: fout, bytesIn: 0, bytesOut: 0, transferred: 0, source: "sample" });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ops-verbs-"));
  const environmentFile = join(dir, "environment.json");
  writeFileSync(environmentFile, JSON.stringify({ name: "uat", project: "open-atlas", bindIp: "127.0.0.1", registries: {}, apps: {} }));
  const fetcher = (async (input: URL | string, init?: RequestInit) => {
    if (new URL(String(input)).pathname === "/health") return Response.json({ status: "ok" });
    const token = /open_atlas_workbench_session=([^;]+)/.exec(new Headers(init?.headers).get("cookie") ?? "")?.[1] ?? "";
    const user = USERS[token];
    if (!user) return Response.json({ error: "auth/unauthorized" }, { status: 401 });
    return Response.json({ user: { id: token, email: `${token}@x`, displayName: token, enabled: true, role: user.isAdmin ? "admin" : "member", isAdmin: !!user.isAdmin }, csrfToken: `csrf-${token}`, groups: user.groups });
  }) as typeof fetch;
  const config = { bind: "127.0.0.1", port: 0, basePath: "/deploy", dataDir: dir, workbenchUrl: "http://workbench:8090", workbenchPublicUrl: "/", environmentFile, observeUrls: {}, secureCookies: false, webDir: join(dir, "web"), templatesDir: join(dir, "templates"), initialManifestsDir: join(dir, "manifests"), peerKeySha256: [], githubApi: "https://api.github.com", omaVaults: [], omaAssessorVaults: [], briefHour: 8, deployerReleaseTag: "v{version}" } as unknown as Config;
  const store = new Store(":memory:");
  const handoff = new Handoff(store);
  const observer = new Observer({}, fetcher);
  const deployments = new Deployments(store, handoff, observer, environmentFile, {});
  const keys = { resolve: async (bearer: string) => KEYS[bearer] } as unknown as Keys;
  const env = new EnvManager(store, deployments, new Schemas(undefined, join(dir, "templates"), fetcher), box, "compare");
  const app = createApp({ config, store, pageSources: opsPageSources(store), businessHooks: opsBusinessHooks(store), keys, sessions: new WorkbenchSessions(config.workbenchUrl, fetcher), observer, deployments, versions: new Versions(undefined, fetcher), env, workbench: new WorkbenchAdmin(config.workbenchUrl, () => "", fetcher) });
  // n1: Ingest -> Load (one business), Reports on its own; an hour of counts.
  store.addStandalone({ kind: "standalone", id: "n1", service: "nifi", profile: "nifi-1.x", version: "1.12.1", webUrl: null, member: { host: "local", installDir: "/lab/n1", serviceUser: "nifi", startEnvironment: null, ports: { https: 18443 }, discovery: null } } as never, "uat", { id: "admin", via: "cli" });
  const bucket = new Date(Date.now() - 30 * 60_000).toISOString();
  store.putTopology("n1", bucket, "h1", {
    root: { id: "root", name: "NiFi Flow" }, s2sIn: [], s2sOut: [],
    groups: [{ id: "A", name: "Ingest", root: false, fragments: [frag("a", { outputs: ["out"] })] }, { id: "B", name: "Load", root: false, fragments: [frag("b", { inputs: ["in"], starts: 0 })] }, { id: "C", name: "Reports", root: false, fragments: [frag("c")] }],
    links: [{ connection: "A-B", from: { group: "A", fragment: "a", port: "out" }, to: { group: "B", fragment: "b", port: "in" } }],
  } as Topology);
  store.putFlowCounts([row(bucket, "A", 0, 10), row(bucket, "B", 10, 10), row(bucket, "C", 0, 4)]);
  const call = (method: string, path: string, who: { as?: string; key?: string }, body?: unknown) => {
    const headers = new Headers({ "content-type": "application/json" });
    if (who.as) { headers.set("cookie", `open_atlas_workbench_session=${who.as}`); headers.set("x-csrf-token", `csrf-${who.as}`); }
    if (who.key) headers.set("authorization", `Bearer ${who.key}`);
    return app.request(`/deploy${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  };
  let id = 0;
  const rpc = async (key: string, method: string, params?: unknown) => (await (await call("POST", "/mcp", { key }, { jsonrpc: "2.0", id: ++id, method, ...(params ? { params } : {}) })).json()) as any;
  const names = async (key: string) => ((await rpc(key, "tools/list")).result.tools as { name: string }[]).map((t) => t.name);
  let rid = 0;
  const tool = async (key: string, name: string, args: Record<string, unknown> = {}) => {
    const t = TOOLS.find((x) => x.name === name);
    const body = await rpc(key, "tools/call", { name, arguments: t && !t.readOnly && !args.request_id ? { ...args, request_id: `r${++rid}` } : args });
    return { isError: Boolean(body.result.isError), value: JSON.parse(body.result.content[0].text) };
  };
  return { store, call, names, tool };
}

test("three kinds of key: what each sees; the 22 old service tools are gone", async () => {
  const t = setup();
  const viewer = await t.names("dpk_viewer"), admin = await t.names("dpk_admin"), assistant = await t.names("dps_assistant"), checkup = await t.names("dpc_checkup");
  assert.deepEqual(VERBS.filter((v) => viewer.includes(v)), ["describe", "look", "trace", "run_model", "draft_change"], "a viewer's key: no publish_model, no record");
  assert.deepEqual(VERBS.filter((v) => admin.includes(v)), VERBS);
  assert.deepEqual(VERBS.filter((v) => assistant.includes(v)), VERBS.filter((v) => v !== "publish_model"), "P5: the Assistant saves to-dos; publish_model is internal (S39 step 6)");
  assert.ok(assistant.includes("plan_deploy") && !assistant.includes("deploy"));
  assert.deepEqual(checkup.sort(), VERBS.filter((v) => v !== "draft_change").sort(), "the check-up: the verbs without draft_change, nothing else");
  for (const list of [viewer, admin, assistant, checkup]) for (const old of OLD) assert.ok(!list.includes(old), old);
  for (const old of OLD) assert.ok(!TOOLS.some((x) => x.name === old), old);
  assert.equal((await t.tool("dpc_checkup", "draft_change", { service: "n1", changes: [{ file: "nifi.properties", key: "a", value: "b" }], note: "x" })).value.finding.code, "mcp/unknown-tool");
  const direct = await t.call("POST", "/api/services/n1/config/drafts", { key: "dpc_checkup" }, { changes: [{ file: "nifi.properties", key: "a", value: "b" }] });
  assert.equal(direct.status, 403, "nor through the route");
  assert.equal((await t.tool("dpk_viewer", "publish_model", { service: "n1", base: 0, model: {}, note: "x" })).value.finding.code, "mcp/unknown-tool");
});

test("describe and look: the lights, gaps pointing at their fix, and look's kinds", async () => {
  const t = setup();
  const all = await t.tool("dps_assistant", "describe");
  assert.deepEqual(all.value.services.map((s: { id: string; kind: string }) => [s.id, s.kind]), [["n1", "standalone"]]);
  const one = (await t.tool("dps_assistant", "describe", { service: "n1" })).value;
  assert.equal(one.service.label, "NiFi 1.12.1 · standalone");
  assert.deepEqual(one.machine.checks.map((c: { check: string }) => c.check), ["process", "disk", "heap", "certificate", "coordinator", "collection"]);
  assert.deepEqual([one.business.light, one.business.reason, one.model, one.analysis, one.todos, one.provenance.supported], ["unknown", "no-evidence", null, null, [], true]);
  const gaps = one.gaps.map((g: { code: string; fix: { verb: string } }) => [g.code, g.fix.verb]);
  assert.deepEqual(gaps, [["no-model", "run_model"]], "counts exist, no model yet");
  assert.equal((await t.tool("dps_assistant", "describe", { service: "nope" })).value.finding.code, "service/unknown");
  assert.equal((await t.tool("dps_assistant", "describe", { flow: "flw_x" })).value.finding.code, "describe/flow-needs-service");

  const model = (await t.tool("dps_assistant", "look", { service: "n1", kind: "model" })).value;
  assert.deepEqual([model.kind, model.data.base, model.data.current, model.data.draft], ["model", 0, null, null], "S39 step 7: no skeleton draft any more");
  const topo = (await t.tool("dps_assistant", "look", { service: "n1", kind: "topology" })).value.data;
  assert.deepEqual([topo.counts.units, topo.units.length, topo.links, topo.skeleton.flows.length], [3, 3, ["Ingest:out → Load:in"], 2], "⑰ a summary by default");
  const whole = (await t.tool("dps_assistant", "look", { service: "n1", kind: "topology", detail: "full" })).value.data;
  assert.deepEqual([whole.topology.groups.length, whole.skeleton.flows.length], [3, 2]);
  const unit = (await t.tool("dps_assistant", "look", { service: "n1", kind: "topology", group: "Load" })).value.data;
  assert.deepEqual([unit.found, unit.unit.id, unit.links.length], [true, "B", 1]);
  assert.equal((await t.tool("dps_assistant", "look", { service: "n1", kind: "topology", detail: "all" })).value.finding.code, "mcp/arguments");
  const counts = (await t.tool("dps_assistant", "look", { service: "n1", kind: "flow-counts" })).value.data;
  assert.deepEqual(counts.rows.map((r: { ref: string; in: number; out: number }) => [r.ref, r.in, r.out]), [["A", 0, 10], ["B", 10, 10], ["C", 0, 4]]);
  assert.equal((await t.tool("dps_assistant", "look", { service: "n1", kind: "flow-counts", component: "B" })).value.data.buckets.length, 1);
  assert.equal((await t.tool("dps_assistant", "look", { service: "n1", kind: "components" })).value.finding.code, "mcp/arguments");
  assert.equal((await t.tool("dps_assistant", "trace", { service: "n1" })).value.finding.code, "trace/query", "trace needs a clue");
  assert.equal((await t.tool("dps_assistant", "trace", { service: "n1", flow: "flw_nothing", fileName: "a" })).value.finding.code, "trace/query");
});

test("run_model and publish_model: the gate's verdicts, the to-do it opens, a stale base refused", async () => {
  const t = setup();
  const draft = draftFromSkeleton(t.store, "n1", NOW);
  const run = (await t.tool("dpc_checkup", "run_model", { service: "n1", model: draft })).value;
  assert.equal(run.verdict, "needs-confirmation");
  assert.ok(run.checks.every((c: { ok: boolean }) => c.ok));
  assert.equal((await t.tool("dpc_checkup", "run_model", { service: "n1", model: { version: 1 } })).value.finding.code, "flow-model/invalid");
  assert.equal(t.store.flowModel("n1"), null, "run_model saves nothing");

  const got = (await t.tool("dpk_admin", "publish_model", { service: "n1", base: 0, model: draft, note: "first" })).value;
  assert.deepEqual([got.verdict, got.revision], ["needs-confirmation", 1]);
  assert.match(got.todo, /^td_/);
  const todo = t.store.todo(got.todo)!;
  assert.deepEqual([todo.source, todo.key, todo.action?.kind, todo.createdBy], ["flows", "flows:n1", "confirm-flows", "deployer"]);
  assert.equal((await t.tool("dpc_checkup", "publish_model", { service: "n1", base: 0, model: draft, note: "again" })).value.finding.code, "flow-model/stale");
  assert.equal((await t.call("POST", "/api/services/n1/model/publish", { as: "viewer" }, { base: 1, model: draft, note: "x" })).status, 403, "a viewer does not publish");

  const after = (await t.tool("dpk_viewer", "describe", { service: "n1" })).value;
  assert.deepEqual([after.model.revision, after.todos.length, after.business.toConfirm], [1, 1, 2]);
  assert.ok(after.gaps.some((g: { code: string }) => g.code === "unconfirmed"));
});

test("record: the Assistant saves to-dos only; the check-up writes the analysis, to-dos and what recovered", async () => {
  const t = setup();
  const todo = { key: "heap:n1", severity: "attention", title: "加大 n1 的堆内存", detail: "堆持续 90%（password=hunter2）", action: { kind: "config-change", label: "Raise the heap", changes: [{ file: "bootstrap.conf", key: "java.arg.3", value: "-Xmx8g" }], note: "堆不够" } };
  const saved = (await t.tool("dps_assistant", "record", { service: "n1", todos: [todo] })).value;
  assert.deepEqual([saved.analysis, saved.todos.length, saved.resolved], [null, 1, []]);
  const kept = t.store.todo(saved.todos[0])!;
  assert.deepEqual([kept.source, kept.createdBy, kept.action?.kind], ["chat", "service:assistant", "config-change"]);
  assert.ok(!kept.detail.includes("hunter2"), "redacted");
  const again = (await t.tool("dps_assistant", "record", { service: "n1", todos: [{ ...todo, title: "堆内存要加" }] })).value;
  assert.equal(again.todos[0], saved.todos[0], "the same key updates the open to-do");
  assert.equal(t.store.todo(saved.todos[0])!.title, "堆内存要加");
  const analysis = { trigger: "schedule", machine: "机器正常", business: "业务待确认", summary: "两条业务等人确认。", lookedAt: ["拓扑"] };
  assert.equal((await t.tool("dps_assistant", "record", { service: "n1", analysis })).value.finding.code, "record/todos-only", "P5");
  assert.equal((await t.tool("dps_assistant", "record", { service: "n1", resolve: [saved.todos[0]] })).value.finding.code, "record/todos-only");
  assert.equal((await t.tool("dps_assistant", "record", { service: "n1", todos: [{ ...todo, action: { kind: "restart-now", label: "x" } }] })).value.finding.code, "record/invalid");
  assert.equal((await t.tool("dps_assistant", "record", { service: "n1" })).value.finding.code, "record/empty");

  // The check-up: into the running analysis the session was opened for; to-dos linked to it; one resolved.
  const running = t.store.addAnalysis({ service: "n1", run: "run-1", trigger: "schedule", state: "running", session: "s1", requestedBy: "deployer", startedAt: new Date().toISOString(), finishedAt: null, machineLight: "unknown", businessLight: "unknown", body: null, error: null });
  const draft = draftFromSkeleton(t.store, "n1", NOW);
  await t.tool("dpc_checkup", "publish_model", { service: "n1", base: 0, model: draft, note: "first" });
  const flow = t.store.flows("n1")[0]!.id;
  const wrote = (await t.tool("dpc_checkup", "record", { service: "n1", analysis_id: running, analysis: { ...analysis, stuckSuggestions: [{ flow, attentionMinutes: 20, failingMinutes: 120, basis: "平时 5 分钟内处理完" }], intro: "按 root 下的组分。" }, todos: [{ key: "disk:n1", severity: "failing", title: "磁盘快满", detail: "content 仓库 96%" }], resolve: [saved.todos[0]] })).value;
  assert.deepEqual([wrote.analysis, wrote.todos.length, wrote.resolved], [running, 1, [saved.todos[0]]]);
  const a = t.store.analysis(running)!;
  assert.deepEqual([a.state, a.session, (a.body as { summary: string }).summary], ["done", "s1", "两条业务等人确认。"]);
  assert.equal(t.store.todo(wrote.todos[0])!.analysis, running);
  assert.equal(t.store.todo(saved.todos[0])!.state, "done");
  assert.deepEqual(t.store.flow(flow)!.stuck, { attentionS: 1200, failingS: 7200, by: "ai", basis: "平时 5 分钟内处理完" });
  assert.equal((await t.tool("dpc_checkup", "record", { service: "n1", analysis_id: running, analysis })).value.finding.code, "record/analysis-done");
  assert.equal((await t.tool("dpc_checkup", "record", { service: "n1", todos: [{ ...todo, flow: "flw_000000" }] })).value.finding.code, "record/unknown-flow");

  // Without a running analysis a new one; what step 3b reads.
  const fresh = (await t.tool("dpk_admin", "record", { service: "n1", analysis: { ...analysis, trigger: "check-now" } })).value;
  assert.ok(fresh.analysis > running);
  const reads = opsReads(t.store);
  const view = reads.analysis("n1")!;
  assert.deepEqual([view.id, view.trigger, view.state, view.stale, view.summary, view.lookedAt], [fresh.analysis, "check-now", "done", false, "两条业务等人确认。", ["拓扑"]]);
  assert.equal(reads.analysis("n1", { machine: "failing", business: "unknown" })!.stale, true, "a light changed since");
  assert.equal(reads.intro("n1"), "按 root 下的组分。");
  assert.deepEqual(reads.todos("n1").map((x) => x.severity), ["failing", "attention"], "failing first");
  assert.equal(reads.todoCount("n1"), 2);
  assert.deepEqual([reads.lastCheckup()?.trigger, reads.lastCheckup()?.state, reads.running()], ["schedule", "done", false], "the round run-1, finished by record");
  const described = (await t.tool("dpc_checkup", "describe", { service: "n1" })).value;
  assert.equal(described.analysis.id, fresh.analysis);
  assert.equal(described.todos[0].title, "磁盘快满");
});

test("the to-do buttons: done or not needed (admin), Apply only from the page and only with a change", async () => {
  const t = setup();
  const sink = todoSink(t.store);
  const plain = sink.open({ service: "n1", source: "gate", key: "gate:n1", severity: "attention", title: "模型没通过", detail: "coverage" })!;
  assert.equal(sink.open({ service: "n1", source: "gate", key: "gate:n1", severity: "attention", title: "模型还是没通过", detail: "coverage" }), plain, "the gate's to-do is updated, not repeated");
  const change = t.store.upsertTodo({ service: "n1", flow: null, source: "chat", key: "heap", severity: "attention", title: "加堆", detail: "d", action: { kind: "config-change", label: "Raise", changes: [{ file: "bootstrap.conf", key: "java.arg.3", value: "-Xmx8g" }], note: "n" }, analysis: null }, "x").id;
  assert.equal((await t.call("POST", `/api/todos/${plain}/state`, { as: "viewer" }, { state: "done" })).status, 403);
  assert.equal((await t.call("POST", `/api/todos/${plain}/state`, { as: "admin" }, { state: "later" })).status, 400);
  const done = await t.call("POST", `/api/todos/${plain}/state`, { as: "admin" }, { state: "dismissed" });
  assert.deepEqual([done.status, (await done.json()).id], [200, plain]);
  assert.equal(t.store.todo(plain)!.state, "dismissed");
  assert.equal((await t.call("POST", `/api/todos/${plain}/state`, { as: "admin" }, { state: "done" })).status, 409);
  assert.equal((await t.call("POST", `/api/todos/td_nothing/state`, { as: "admin" }, { state: "done" })).status, 404);
  assert.equal((await t.call("POST", `/api/todos/${change}/draft`, { key: "dpk_admin" }, {})).status, 403, "browser only");
  const sink2 = sink.open({ service: "n1", source: "flows", key: "flows:n1", severity: "attention", title: "确认", detail: "d", action: { kind: "confirm-flows", label: "Review flows" } })!;
  assert.equal((await t.call("POST", `/api/todos/${sink2}/draft`, { as: "admin" }, {})).status, 409, "no configuration change in it");
  const applied = await t.call("POST", `/api/todos/${change}/draft`, { as: "admin" }, {});
  assert.equal(applied.status, 404, "the draft route answers as the person: n1 has no configuration here");
  assert.equal((await applied.json()).error, "service-config/none");
});

test("steps 3b + 4 wired: describe shows the real business light; the service page shows service_todos", async () => {
  const t = setup();
  const flow = "flw_wired";
  t.store.putFlow({ id: flow, name: "Invoices", nameBy: "person", status: "confirmed", summary: "in → out", reason: null, risks: [], pendings: [], stuck: null, createdAt: "2026-11-19T09:00:00Z", confirmedAt: "2026-11-19T09:30:00Z", confirmedBy: "admin", updatedAt: "2026-11-19T09:30:00Z" } as never);
  t.store.setFlowSegments(flow, [{ service: "n1", segment: "A" }]);
  t.store.noteFlowAnomaly({ flow, service: "n1", ref: "p-db", anomaly: "processor-error", light: "attention", at: new Date().toISOString(), count: 1, detail: { segment: "A", component: "p-db" } });
  const business = (await t.tool("dps_assistant", "describe", { service: "n1" })).value.business;
  assert.deepEqual([business.light, business.flows.map((f: { id: string; light: string }) => [f.id, f.light])], ["attention", [[flow, "attention"]]], "3b's light, not the stand-in's unknown");

  t.store.upsertTodo({ service: "n1", flow: null, source: "chat", key: "heap", severity: "attention", title: "Raise the heap", detail: "d", action: null, analysis: null }, "x");
  const page = await (await t.call("GET", "/api/services/n1/page", { as: "viewer" })).json() as { todos: { title: string }[]; business: { light: string } };
  assert.deepEqual([page.todos.map((x) => x.title), page.business.light], [["Raise the heap"], "attention"]);
  const overview = await (await t.call("GET", "/api/services/overview", { as: "viewer" })).json() as { services: { id: string; todoCount: number }[] };
  assert.equal(overview.services.find((s) => s.id === "n1")?.todoCount, 1);
});

// ⑰ saving tokens: the brief, and "the canvas has not changed since the model" by its structural fingerprint.
const CANVAS: Topology = {
  root: { id: "root", name: "NiFi Flow" }, s2sIn: [], s2sOut: [],
  groups: [{ id: "A", name: "Ingest", root: false, fragments: [frag("a", { outputs: ["out"] })] }, { id: "B", name: "Load", root: false, fragments: [frag("b", { inputs: ["in"], starts: 0 })] }, { id: "C", name: "Reports", root: false, fragments: [frag("c")] }],
  links: [{ connection: "A-B", from: { group: "A", fragment: "a", port: "out" }, to: { group: "B", fragment: "b", port: "in" } }],
};
const later = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

test("⑰ brief (S39 step 7): no skeleton draft, no rebuild; the canvas state of what is registered, and a change is the owner's to confirm", async () => {
  const t = setup();
  const before = (await t.tool("dpc_checkup", "describe", { service: "n1", brief: true })).value;
  assert.deepEqual([before.skeletonDraft, before.topology.questions, before.model.rebuild, before.model.revision], [undefined, undefined, undefined, 0], "the check-up is not asked to build the model");
  assert.match(before.next, /Do not build or publish a business model/);
  assert.ok(before.topology.fingerprint);

  await t.tool("dpc_checkup", "publish_model", { service: "n1", base: 0, model: draftFromSkeleton(t.store, "n1", NOW), note: "first" });
  assert.ok(t.store.flowModel("n1")!.topologyFp, "the fingerprint is kept with the revision");
  // The executor walks the canvas again in another order, the link drawn again: a new snapshot, the same structure.
  const reordered: Topology = { ...CANVAS, groups: [...CANVAS.groups].reverse(), links: [{ ...CANVAS.links[0]!, connection: "A-B-again" }] };
  assert.ok(t.store.putTopology("n1", later(1), topologyHash(reordered), reordered));
  const kept = (await t.tool("dpc_checkup", "describe", { service: "n1", brief: true })).value;
  assert.equal(kept.model.topology, "unchanged");
  assert.match(kept.model.note, /^拓扑未变，沿用已发布模型 r1/);
  assert.ok(!kept.gaps.some((g: { code: string }) => g.code === "topology-changed"), "a new snapshot of the same structure is no change");
  assert.ok(Buffer.byteLength(JSON.stringify(kept)) < 6000, `the brief stays small (${Buffer.byteLength(JSON.stringify(kept))} bytes)`);

  // A structural change (a new link): changed, the gap; still nothing to rebuild.
  const changed: Topology = { ...CANVAS, links: [...CANVAS.links, { connection: "B-C", from: { group: "B", fragment: "b", port: null }, to: { group: "C", fragment: "c", port: null } }] };
  t.store.putTopology("n1", later(2), topologyHash(changed), changed);
  const now = (await t.tool("dpc_checkup", "describe", { service: "n1", brief: true })).value;
  assert.equal(now.model.topology, "changed");
  assert.match(now.model.note, /Do not build or publish a business model/);
  assert.ok(now.gaps.some((g: { code: string }) => g.code === "topology-changed"));

  const all = (await t.tool("dpc_checkup", "describe", { brief: true })).value;
  assert.deepEqual(all.services.map((s: { service: { id: string } }) => s.service.id), ["n1"]);
  const flow = t.store.flows("n1")[0]!;
  assert.equal((await t.tool("dpc_checkup", "describe", { service: "n1", flow: flow.id, brief: true })).value.finding.code, "describe/brief-flow");
});

test("⑰ topologyFingerprint: order, connection ids and extra fields do not count; structure does", () => {
  const fp = topologyFingerprint(CANVAS)!;
  assert.match(fp, /^[0-9a-f]{16}$/);
  const shuffled = { ...CANVAS, groups: [CANVAS.groups[2]!, CANVAS.groups[0]!, CANVAS.groups[1]!].map((g) => ({ ...g, fragments: g.fragments.map((f) => ({ ...f, names: [...f.names].reverse() })) })), links: [{ ...CANVAS.links[0]!, connection: "other" }] };
  assert.equal(topologyFingerprint(shuffled), fp);
  assert.equal(topologyFingerprint({ ...CANVAS, takenAt: "2026-11-23T00:00:00Z", queued: 5 } as unknown as Topology), fp, "fields beside the structure");
  assert.notEqual(topologyFingerprint({ ...CANVAS, groups: CANVAS.groups.slice(0, 2) }), fp);
  assert.notEqual(topologyFingerprint({ ...CANVAS, groups: CANVAS.groups.map((g) => (g.id === "C" ? { ...g, name: "Reports v2" } : g)) }), fp);
  assert.notEqual(topologyFingerprint({ ...CANVAS, links: [{ ...CANVAS.links[0]!, to: { group: "C", fragment: "c", port: "in" } }] }), fp);
  assert.equal(topologyFingerprint(null), null);
});

test("⑰ the first message carries the briefs; the scheduled one asks describe for them", () => {
  const plain = analysisMessage("check-now", [{ id: 7, service: "n1" }]);
  assert.ok(!plain.includes("brief"));
  const withBrief = analysisMessage("check-now", [{ id: 7, service: "n1" }], {}, undefined, [{ service: { id: "n1" }, model: { note: "拓扑未变，沿用已发布模型 r3" } }]);
  assert.match(withBrief, /Each service's brief/);
  assert.match(withBrief, /拓扑未变，沿用已发布模型 r3/);
  assert.match(CHECKUP_MESSAGE, /describe \{brief: true\}/);
});

test("⑰ run_model / publish_model with from current + changes: the Deployer builds the draft; from skeleton is gone", async () => {
  const t = setup();
  const whole = draftFromSkeleton(t.store, "n1", NOW);
  assert.equal((await t.tool("dpc_checkup", "run_model", { service: "n1", from: "current", changes: [] })).value.finding.code, "flow-model/no-current");
  const byWhole = (await t.tool("dpc_checkup", "run_model", { service: "n1", model: whole })).value;
  assert.equal(byWhole.draft, undefined, "a whole model sent gets no lines back");
  const skeleton = (await t.tool("dpc_checkup", "run_model", { service: "n1", from: "skeleton", changes: [] })).value;
  assert.equal(skeleton.finding.code, "flow-model/from");
  assert.match(skeleton.finding.message ?? JSON.stringify(skeleton), /skeleton is gone/);
  assert.equal((await t.tool("dpc_checkup", "run_model", { service: "n1", model: whole, from: "current" })).value.finding.code, "mcp/arguments");
  assert.equal((await t.tool("dpc_checkup", "run_model", { service: "n1" })).value.finding.code, "mcp/arguments");

  const pub = (await t.tool("dpc_checkup", "publish_model", { service: "n1", base: 0, model: whole, note: "first" })).value;
  assert.equal(pub.revision, 1);
  const bySame = (await t.tool("dpc_checkup", "run_model", { service: "n1", from: "current", changes: [] })).value;
  assert.equal(bySame.draft.lines.length, 3);
  assert.ok(inlineBytes(bySame) < INLINE_BUDGET);
  const bad = (await t.tool("dpc_checkup", "run_model", { service: "n1", from: "current", changes: [{ op: "remove", segments: ["nope"] }] })).value;
  assert.equal(bad.finding.code, "flow-model/changes");
  assert.match(bad.details[0], /no segment nope/);
  const shared = (await t.tool("dpc_checkup", "run_model", { service: "n1", from: "current", changes: [{ op: "share", segments: ["C"] }, { op: "add-exit", segment: "B", exit: { channel: { type: "external", system: "Warehouse" }, component: "b" } }] })).value;
  const lines = Object.fromEntries(shared.draft.lines.map((l: { id: string }) => [l.id, l]));
  assert.deepEqual([lines.C.role, lines.C.flow, lines.B.exits.at(-1)], ["shared", null, "out-1 external:Warehouse @b"]);
});

