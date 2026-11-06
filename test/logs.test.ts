// Phase 2 step 4 (§9.3, §15.3): the log summary from the samples (patterns, 5-minute counts, the ZooKeeper rule), and
// reading logs through the service executors: a search of both nodes merged by time, a download, a tail shared by
// its followers and carried on from its cursor while someone follows; jobs only for executors that name them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Handoff } from "../src/server/handoff.ts";
import { ingest } from "../src/server/services/metrics.ts";
import { check } from "../src/server/services/rules.ts";
import { bucketOf, logPatternsOf, parseSearch, ServiceLogs } from "../src/server/services/logs.ts";
import type { ExecutorInfo } from "../src/server/handoff.ts";
import type { ServiceSample } from "../src/server/services/watch.ts";
import { Store } from "../src/server/store.ts";

const admin = { id: "admin", via: "cli" } as const;
const node = (installDir: string, https: number) => ({ host: "local", installDir, serviceUser: "ferenc", startEnvironment: null, ports: { https }, nodeAddress: "localhost", discovery: null });
const KEY1 = "local:/lab/c250-1", KEY2 = "local:/lab/c250-2";
const KINDS = ["svc-discover", "svc-read", "log-read", "log-tail", "executor-upgrade"];

function lab(now: { t: Date }) {
  const store = new Store(":memory:", () => now.t);
  store.addCluster({ kind: "cluster", id: "c250", service: "nifi", profile: "nifi-2.x", version: "2.5.0", webUrl: null, zookeeper: "zk:2181", zookeeperRoot: "/c250", nodes: [node("/lab/c250-1", 18445), node("/lab/c250-2", 18446)] }, "uat", admin);
  return store;
}
const pattern = (key: string, at: string, more: Record<string, unknown> = {}) => ({ key, level: "WARN", logger: "o.a.c.f.s.ConnectionStateManager", template: "State change: SUSPENDED", exception: null, count: 2, firstAt: at, lastAt: at, first: `first ${at}`, last: `last ${at}`, ...more });
const sample = (member: string, at: string, patterns: unknown[]): ServiceSample => ({ service: "c250", member, at, process: { running: true, pid: 1, startedAt: "2026-11-06T11:00:00Z" }, logs: { file: "/lab/logs/nifi-app.log", inode: 7, offset: 100, lines: 5, patterns } } as ServiceSample);

test("the log summary: patterns summed per member with the first sample kept, 5-minute counts, the raw sample without them", () => {
  const now = { t: new Date("2026-11-06T12:10:00Z") };
  const store = lab(now);
  ingest(store, [sample(KEY1, "2026-11-06T12:01:00Z", [pattern("aaaaaaaaaaaaaaaa", "2026-11-06T12:00:30Z"), { key: "nothex!", level: "WARN", count: 1 }])]);
  ingest(store, [sample(KEY1, "2026-11-06T12:06:00Z", [pattern("aaaaaaaaaaaaaaaa", "2026-11-06T12:05:40Z", { count: 3 })]), sample(KEY2, "2026-11-06T12:06:00Z", [pattern("aaaaaaaaaaaaaaaa", "2026-11-06T12:05:50Z")])]);
  const ps = store.serviceLogPatterns("c250", { since: "2026-11-06T00:00:00Z" });
  assert.deepEqual(ps.map((p) => [p.member, p.total, p.count, p.firstSample, p.lastSample, p.firstAt, p.lastAt]), [
    [KEY1, 5, 5, "first 2026-11-06T12:00:30Z", "last 2026-11-06T12:05:40Z", "2026-11-06T12:00:30Z", "2026-11-06T12:05:40Z"],
    [KEY2, 2, 2, "first 2026-11-06T12:05:50Z", "last 2026-11-06T12:05:50Z", "2026-11-06T12:05:50Z", "2026-11-06T12:05:50Z"],
  ], "the malformed pattern is left out");
  assert.deepEqual(store.serviceLogCounts("c250", "2026-11-06T12:05:00Z").map((c) => [c.member, c.bucket, c.count]), [[KEY1, "2026-11-06T12:05:00Z", 3], [KEY2, "2026-11-06T12:05:00Z", 2]]);
  assert.equal(store.serviceLogPatterns("c250", { since: "2026-11-06T12:05:00Z" })[0]!.count, 3, "count: within the period asked");
  const raw = store.latestServiceSamples("c250").find((s) => s.member === KEY1)!.body;
  assert.deepEqual(raw.logs, { file: "/lab/logs/nifi-app.log", inode: 7, offset: 100, lines: 5, patterns: 1 });
  assert.equal(bucketOf("2026-11-06T12:04:59.999Z"), "2026-11-06T12:00:00Z");
  assert.equal(logPatternsOf({ service: "c250", member: KEY1, at: "x" } as ServiceSample).length, 0);
  const pruned = store.pruneServiceData("2026-11-06T12:05:00Z", "2026-11-06T12:01:00Z");
  assert.deepEqual([pruned.logCounts, pruned.logPatterns], [1, 0]);
});

test("the ZooKeeper rule counts nifi-app.log's summary as well as the bulletins", () => {
  const now = { t: new Date("2026-11-06T12:06:10Z") };
  const store = lab(now);
  const online: ExecutorInfo = { online: true, host: "local", ageSeconds: 5, heartbeat: { collector: { seconds: 30 } } as never };
  const zk = (key: string, at: string, count: number, more = {}) => pattern(key, at, { level: "ERROR", logger: "o.a.z.ClientCnxn", template: "Session <hex> for server localhost/<ip>:<n>, Closing socket connection", count, ...more });
  ingest(store, [sample(KEY1, "2026-11-06T12:06:00Z", [zk("bbbbbbbbbbbbbbbb", "2026-11-06T12:05:50Z", 2), pattern("cccccccccccccccc", "2026-11-06T12:05:50Z", { level: "INFO", template: "zookeeper fine", count: 50 })])]);
  check(store, () => online, "c250", now.t);
  assert.equal(store.serviceAlerts({ service: "c250", state: "open" }).filter((a) => a.rule === "zk-errors").length, 0, "2 of 3; INFO does not count");
  ingest(store, [sample(KEY2, "2026-11-06T12:06:05Z", [zk("dddddddddddddddd", "2026-11-06T12:06:01Z", 1, { logger: "o.a.n.c.l.e.CuratorLeaderElectionManager", template: "Failed to ..." })])]);
  check(store, () => online, "c250", now.t);
  const open = store.serviceAlerts({ service: "c250", state: "open" }).find((a) => a.rule === "zk-errors");
  assert.ok(open, "3 ZooKeeper messages in the log open it");
  assert.deepEqual([open.detail.count, open.detail.log, open.detail.bulletins], [3, 3, 0]);
});

test("a search request is checked and has its defaults", () => {
  const now = new Date("2026-11-06T12:00:00Z");
  assert.deepEqual(parseSearch({}, now), { from: "2026-11-06T11:00:00.000Z", to: "2026-11-06T12:00:00.000Z", limit: 1000 });
  for (const bad of [{ from: "2026-11-06T13:00:00Z" }, { levels: ["LOUD"] }, { files: ["../x"] }, { regex: true, query: "(" }, { limit: 0 }, { limit: 5001 }, { members: "x" }])
    assert.ok("error" in parseSearch(bad, now), JSON.stringify(bad));
  assert.deepEqual(parseSearch({ query: "conn", regex: true, levels: ["ERROR"], files: ["nifi-app.log"], members: [KEY1], limit: 5 }, now),
    { from: "2026-11-06T11:00:00.000Z", to: "2026-11-06T12:00:00.000Z", limit: 5, query: "conn", regex: true, levels: ["ERROR"], files: ["nifi-app.log"], members: [KEY1] });
});

/** A lab with a handoff, an online service executor naming `kinds`, and a fake executor answering its jobs. */
function withExecutor(kinds = KINDS) {
  const now = { t: new Date() };
  const store = lab(now);
  const handoff = new Handoff(store);
  const beat = (k = kinds) => handoff.heartbeat("local", { executor: "service", version: "0.8.0", protocols: [2], kinds: k, at: "", project: "", registries: [], databaseBackup: {}, busy: null }, "service");
  beat();
  const logs = new ServiceLogs(store, handoff, { pollMs: 5, waitMs: 3000, tailSeconds: 1, retryMs: 20 });
  const jobs: Record<string, unknown>[] = [];
  const claim = async () => { for (let i = 0; i < 400; i++) { const j = await handoff.next("local", 0, undefined, "service"); if (j) { jobs.push(j); return j; } await new Promise((r) => setTimeout(r, 5)); } throw new Error("no job"); };
  const done = (id: string, result: Record<string, unknown>, state: "succeeded" | "failed" = "succeeded", message?: string) => handoff.putStatus(id, { state, steps: [], result: result as never, ...(message ? { message } : {}) });
  return { store, handoff, logs, claim, done, jobs, beat };
}

test("a search runs on both nodes in parallel and the matches are merged by time; a failed node is said, not fatal", async () => {
  const x = withExecutor();
  const running = x.logs.search("c250", { from: "2026-11-06T10:00:00.000Z", to: "2026-11-06T11:00:00.000Z", limit: 100, query: "ConnectionLoss", levels: ["ERROR"] });
  const a = await x.claim(), b = await x.claim();
  assert.deepEqual([a.kind, a.mode, a.query, a.levels, a.from, a.limit], ["log-read", "search", "ConnectionLoss", ["ERROR"], "2026-11-06T10:00:00.000Z", 100]);
  assert.deepEqual([a.member, b.member].sort(), [KEY1, KEY2]);
  const entry = (at: string, text: string) => ({ file: "nifi-app.log", at, local: at, level: "ERROR", logger: "o.a.z.ClientCnxn", thread: "main", text });
  const one = a.member === KEY1 ? a : b, two = a.member === KEY1 ? b : a;
  x.handoff.putContent(String(one.id), Buffer.from(JSON.stringify({ entries: [entry("2026-11-06T10:00:01.000Z", "KeeperException$ConnectionLoss 1"), entry("2026-11-06T10:00:05.000Z", "KeeperException$ConnectionLoss 3")], truncated: null, files: ["nifi-app.log"] })));
  x.done(String(one.id), { mode: "search", entries: 2 });
  x.handoff.putContent(String(two.id), Buffer.from(JSON.stringify({ entries: [entry("2026-11-06T10:00:03.000Z", "KeeperException$ConnectionLoss 2")], truncated: null, files: ["nifi-app.log"] })));
  x.done(String(two.id), { mode: "search", entries: 1 });
  const r = await running;
  assert.deepEqual(r.entries.map((e) => [e.label, e.text.slice(-1)]), [["localhost:18445", "1"], ["localhost:18446", "2"], ["localhost:18445", "3"]]);
  assert.deepEqual(r.members.map((m) => [m.label, m.state, m.entries]), [["localhost:18445", "ok", 2], ["localhost:18446", "ok", 1]]);
  assert.equal(x.store.executorJob(String(one.id))!.status!.result && JSON.stringify(x.store.executorJob(String(one.id))!.status).includes("ConnectionLoss"), false, "the lines are not kept in the job");

  const again = x.logs.search("c250", { from: "2026-11-06T10:00:00.000Z", to: "2026-11-06T11:00:00.000Z", limit: 100, members: [KEY2] });
  const c = await x.claim();
  x.done(String(c.id), {}, "failed", "nifi-app.log is not in the log directory");
  const r2 = await again;
  assert.deepEqual(r2.members.map((m) => [m.member, m.state, m.error]), [[KEY2, "failed", "localhost:18446: nifi-app.log is not in the log directory"]]);
});

test("log jobs go only to an executor that names them, and only while it is online", async () => {
  const x = withExecutor(["svc-discover", "svc-read", "executor-upgrade"]);
  await assert.rejects(x.logs.files("c250", KEY1), /cannot read logs/);
  assert.throws(() => x.logs.tail("c250", KEY1, "nifi-app.log", () => {}), /cannot follow logs/);
  const r = await x.logs.search("c250", { from: "2026-11-06T10:00:00.000Z", to: "2026-11-06T11:00:00.000Z", limit: 10 });
  assert.deepEqual(r.members.map((m) => m.state), ["failed", "failed"]);
  assert.equal(x.store.executorJobs("local").length, 0, "nothing queued");
  await assert.rejects(x.logs.files("c250", "local:/elsewhere"), /not a member/);
  await assert.rejects(x.logs.files("nope", KEY1), /No standalone instance or cluster/);
  assert.throws(() => x.logs.tail("c250", KEY1, "../x", () => {}), /file is the name/);
  assert.deepEqual(x.logs.members("c250")!.map((m) => [m.label, m.logDir, m.canRead]), [["localhost:18445", "/lab/c250-1/logs", false], ["localhost:18446", "/lab/c250-2/logs", false]]);
});

test("a download comes back over the content channel, cut at its limit", async () => {
  const x = withExecutor();
  const running = x.logs.download("c250", KEY1, ["nifi-app.log", "nifi-bootstrap.log"]);
  const j = await x.claim();
  assert.deepEqual([j.mode, j.files, j.maxBytes], ["download", ["nifi-app.log", "nifi-bootstrap.log"], 50 << 20]);
  x.handoff.putContent(String(j.id), Buffer.from("tar.gz bytes"));
  x.done(String(j.id), { mode: "download", files: ["nifi-app.log", "nifi-bootstrap.log"] });
  const got = await running;
  assert.equal(got.data.toString(), "tar.gz bytes");
  assert.match(got.name, /^c250-localhost_18445-logs-\d{8}T\d{6}\.tar\.gz$/);
  // The content channel cuts at the request's maxBytes.
  x.handoff.submit("log-read-cut-1", { kind: "log-read", member: KEY1, mode: "lines", maxBytes: 4 }, "local", "service");
  assert.deepEqual(x.handoff.putContent("log-read-cut-1", Buffer.from("123456")), { bytes: 4, truncated: true });
  assert.equal(x.handoff.takeContent("log-read-cut-1")!.data.toString(), "1234");
  assert.equal(x.handoff.takeContent("log-read-cut-1"), undefined, "handed over once");
});

test("a tail is shared by its followers, renewed from its cursor while someone follows, and told to stop when nobody does", async () => {
  const x = withExecutor();
  const seen1: Record<string, unknown>[] = [], seen2: Record<string, unknown>[] = [];
  const stop1 = x.logs.tail("c250", KEY1, "nifi-app.log", (e) => seen1.push(e));
  const first = await x.claim();
  assert.deepEqual([first.kind, first.member, first.file, first.seconds, first.lines, first.cursor], ["log-tail", KEY1, "nifi-app.log", 1, 100, undefined]);
  assert.deepEqual(x.handoff.putChunk(String(first.id), { seq: 1, inode: 7, offset: 10, text: "line 1\n", first: true }), { stop: false });
  const stop2 = x.logs.tail("c250", KEY1, "nifi-app.log", (e) => seen2.push(e));
  assert.deepEqual(x.logs.tailing().map((t) => [t.followers, t.job]), [[2, first.id]], "one tail for both");
  assert.deepEqual(seen2.filter((e) => e.type === "lines").map((e) => [e.text, e.backlog]), [["line 1\n", true]], "a newcomer gets the recent lines");
  x.handoff.putChunk(String(first.id), { seq: 2, inode: 7, offset: 17, text: "line 2\n" });
  // The tail ends (its 120 seconds): the next one carries on from where it stood, a rollover included.
  x.done(String(first.id), { file: "nifi-app.log", inode: 8, offset: 3 });
  const second = await x.claim();
  assert.deepEqual([second.kind, second.cursor, second.lines], ["log-tail", { inode: 8, offset: 3 }, undefined]);
  assert.ok(seen1.some((e) => e.type === "state" && e.state === "renewed"));
  x.handoff.putChunk(String(second.id), { seq: 1, inode: 8, offset: 20, text: "after the restart\n" });
  assert.deepEqual(seen1.filter((e) => e.type === "lines").map((e) => e.text), ["line 1\n", "line 2\n", "after the restart\n"]);
  assert.deepEqual(seen2.filter((e) => e.type === "lines").map((e) => e.text), ["line 1\n", "line 2\n", "after the restart\n"]);
  stop1();
  assert.deepEqual(x.handoff.putChunk(String(second.id), { seq: 2, inode: 8, offset: 20, text: "" }), { stop: false }, "one still follows");
  stop2();
  assert.deepEqual(x.handoff.putChunk(String(second.id), { seq: 3, inode: 8, offset: 20, text: "" }), { stop: true }, "nobody follows: the executor ends it");
  x.done(String(second.id), { inode: 8, offset: 20, stopped: true });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(x.logs.tailing(), [], "not renewed");
  assert.equal(x.jobs.length, 2);
});

test("a tail whose executor fails says so and tries again while someone follows", async () => {
  const x = withExecutor();
  const seen: Record<string, unknown>[] = [];
  const stop = x.logs.tail("c250", KEY2, "nifi-app.log", (e) => seen.push(e));
  const j = await x.claim();
  x.done(String(j.id), {}, "failed", "timed out after 120 seconds");
  const again = await x.claim();
  assert.equal(again.kind, "log-tail");
  assert.ok(seen.some((e) => e.type === "state" && e.state === "error" && String(e.message).includes("timed out")));
  stop();
  x.done(String(again.id), {});
});
