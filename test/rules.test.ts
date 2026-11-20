// Step 3a (pages-rethink C1, §10.3 P2): the machine light's six checks, each bound, unknown, the merges, the alerts (one open
// per check and member, resolved after), the turn to red on the timeline, the timeline's own entries and the thresholds.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExecutorInfo } from "../src/server/handoff.ts";
import { ingest } from "../src/server/services/metrics.ts";
import { check, checkAll, heldSince, machineLight, MACHINE_CHECKS, overallLight, parseThresholds, type MachineTurn } from "../src/server/services/rules.ts";
import { NIFI_THRESHOLDS } from "../src/server/services/profiles.ts";
import { THRESHOLD_KEYS } from "../src/server/services/ops-types.ts";
import { serviceStatus, thresholdsOf } from "../src/server/services/status.ts";
import type { ServiceSample } from "../src/server/services/watch.ts";
import { Store } from "../src/server/store.ts";

const admin = { id: "admin", via: "cli" } as const;
const node = (installDir: string, https: number) => ({ host: "local", installDir, serviceUser: "ferenc", startEnvironment: null, ports: { https }, nodeAddress: "localhost", discovery: null });
const KEY1 = "local:/lab/c250-1", KEY2 = "local:/lab/c250-2";
const online: ExecutorInfo = { online: true, host: "local", ageSeconds: 5, heartbeat: { collector: { seconds: 30 } } as never };
const offline = (age: number): ExecutorInfo => ({ online: false, host: "local", ageSeconds: age, reason: `No heartbeat for ${age} seconds` });

function lab(now: { t: Date }) {
  const store = new Store(":memory:", () => now.t);
  store.addCluster({ kind: "cluster", id: "c250", service: "nifi", profile: "nifi-2.x", version: "2.5.0", webUrl: null, zookeeper: "zk:2181", zookeeperRoot: "/c250", nodes: [node("/lab/c250-1", 18445), node("/lab/c250-2", 18446)] }, "uat", admin);
  return store;
}

type More = { running?: boolean; started?: string; heap?: number; repo?: number; bp?: number; status2?: string; coordinator?: boolean; primary?: boolean; version?: string; nifi?: string; bulletins?: unknown[]; certs?: string; certError?: string; logs?: unknown[] };
const diag = (port: number, heap: number, repo: number) => ({ address: "localhost", apiPort: port, heap: { usedBytes: heap, maxBytes: 100 }, totalThreads: 1, gc: [], repositories: { flowfile: [{ totalSpaceBytes: 100, usedSpaceBytes: repo }], content: [], provenance: [] } });
function sample(member: string, at: string, m: More = {}): ServiceSample {
  const own = member === KEY1 ? 18445 : 18446;
  const certs = m.certs || m.certError ? { certs: { readAt: at, stores: m.certError ? [{ store: "truststore", error: m.certError }] : [{ store: "keystore", certificates: [{ alias: "k", chain: 1, subject: "CN=node.lab", issuer: "CN=ca", notBefore: "2026-01-01T00:00:00Z", notAfter: m.certs }] }] } } : {};
  return {
    service: "c250", member, at,
    process: m.running === false ? { running: false } : { running: true, pid: own, startedAt: m.started ?? "2026-11-06T11:00:00Z" },
    nifi: m.running === false ? { state: "not-running" } : {
      state: m.nifi ?? "ok", about: { version: m.version ?? "2.5.0", timezone: "UTC" },
      diagnostics: { nodes: [diag(18445, m.heap ?? 50, m.repo ?? 10), diag(18446, m.heap ?? 50, m.repo ?? 10)] },
      cluster: { nodes: [
        { address: "localhost", apiPort: 18445, status: "CONNECTED", roles: [...(m.coordinator === false ? [] : ["Cluster Coordinator"]), ...(m.primary === false ? [] : ["Primary Node"])] },
        { address: "localhost", apiPort: 18446, status: m.status2 ?? "CONNECTED", roles: [] },
      ] },
      backpressure: { connections: 3, full: m.bp ?? 0, maxPercent: m.bp ? 100 : 10 },
      bulletins: m.bulletins ?? [],
    },
    ...(m.logs ? { logs: { file: "/lab/logs/nifi-app.log", inode: 7, offset: 100, lines: 5, patterns: m.logs } } : {}),
    ...certs,
  } as ServiceSample;
}
const both = (at: string, m: More = {}, m2: More = m) => [sample(KEY1, at, m), sample(KEY2, at, m2)];
const short = (member: string) => (member === "*" ? "*" : member === KEY1 ? "1" : "2");
const openRules = (store: Store) => store.serviceAlerts({ service: "c250", state: "open" }).map((a) => `${a.level} ${a.rule} ${short(a.member)}`).sort();
const kinds = (store: Store) => store.serviceEvents("c250").map((e) => e.kind).reverse();
const light = (store: Store, now: Date, ex: ExecutorInfo = online) => machineLight(store, () => ex, "c250", now)!;
const row = (store: Store, now: Date, c: string, ex: ExecutorInfo = online) => light(store, now, ex).checks.find((r) => r.check === c)!;
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");

test("healthy: six rows in order, each with a sentence; a standalone's coordinator is healthy", () => {
  const now = { t: new Date("2026-11-06T12:00:10Z") };
  const store = lab(now);
  ingest(store, both("2026-11-06T12:00:00Z", { certs: "2027-06-01T00:00:00Z" }));
  const v = light(store, now.t);
  assert.equal(v.light, "healthy");
  assert.deepEqual(v.checks.map((r) => r.check), [...MACHINE_CHECKS]);
  assert.deepEqual(v.checks.map((r) => r.light), ["healthy", "healthy", "healthy", "healthy", "healthy", "healthy"]);
  assert.deepEqual(v.checks.map((r) => r.text), ["All 2 nodes running and connected", "Fullest: localhost:18445 FlowFile repository 10 %", "Highest: localhost:18445 heap 50 %", "Soonest expires in 206 days", "Primary node and coordinator present", "Up to date (oldest sample 10 s old)"]);
  assert.equal(v.sentence, "All six machine checks are fine.");
  assert.deepEqual(v.members.map((m) => [m.label, m.state, m.connection]), [["localhost:18445", "running", "CONNECTED"], ["localhost:18446", "running", "CONNECTED"]]);
  store.addStandalone({ kind: "standalone", id: "solo", service: "nifi", profile: "nifi-2.x", version: "2.5.0", webUrl: null, member: { host: "local", installDir: "/opt/nifi", serviceUser: null, startEnvironment: null, ports: {} } }, "uat", admin);
  const solo = machineLight(store, () => online, "solo", now.t)!;
  assert.deepEqual([solo.checks.find((r) => r.check === "coordinator")!.light, solo.checks.find((r) => r.check === "coordinator")!.text], ["healthy", "Standalone: no cluster roles"]);
  assert.equal(machineLight(store, () => online, "nope", now.t), undefined);
  store.close();
});

test("process: a node stopped and another disconnected are failing, one alert per member (merged); the timeline has the disconnect; started again they resolve", () => {
  const now = { t: new Date("2026-11-06T12:00:10Z") };
  const store = lab(now);
  ingest(store, both("2026-11-06T12:00:00Z"));
  assert.deepEqual(check(store, () => online, "c250", now.t), { opened: 0, changed: 0, resolved: 0, events: 0, turns: [] }, "the first look only records the facts");
  now.t = new Date("2026-11-06T12:00:40Z");
  ingest(store, [sample(KEY1, "2026-11-06T12:00:30Z", { status2: "DISCONNECTED" }), sample(KEY2, "2026-11-06T12:00:30Z", { running: false })]);
  check(store, () => online, "c250", now.t);
  assert.deepEqual(openRules(store), ["CRIT process 2"], "no process and disconnected: one condition for node 2");
  const a = store.serviceAlerts({ service: "c250", state: "open" })[0]!;
  assert.match(String(a.detail.text), /no NiFi process at .*; localhost:18446 is disconnected/);
  assert.equal(a.detail.light, "failing");
  check(store, () => online, "c250", now.t);
  assert.equal(store.serviceAlerts({ service: "c250" }).length, 1, "still one alert");
  const p = row(store, now.t, "process");
  assert.deepEqual([p.light, p.member, p.since], ["failing", KEY2, "2026-11-06T12:00:40.000Z"]);
  now.t = new Date("2026-11-06T12:02:10Z");
  ingest(store, both("2026-11-06T12:02:00Z", {}, { started: "2026-11-06T12:01:40Z" }));
  check(store, () => online, "c250", now.t);
  assert.deepEqual(openRules(store), []);
  const events = store.serviceEvents("c250");
  assert.deepEqual(events.filter((e) => ["node-disconnected", "node-reconnected", "process-restarted", "alert-opened", "alert-resolved"].includes(e.kind)).map((e) => e.kind).sort(), ["alert-opened", "alert-resolved", "node-disconnected", "node-reconnected", "process-restarted"]);
  assert.equal(events.find((e) => e.kind === "process-restarted")!.at, "2026-11-06T12:01:40Z");
  store.close();
});

test("collection: the executor offline is unknown only after 5 minutes (other rows cannot tell meanwhile); no sample for 5 minutes too; a failing check stays failing over unknown", () => {
  const now = { t: new Date("2026-11-06T12:00:10Z") };
  const store = lab(now);
  ingest(store, both("2026-11-06T12:00:00Z", { repo: 96 }, {}));
  check(store, () => online, "c250", now.t);
  assert.deepEqual(openRules(store), ["CRIT disk 1"]);
  check(store, () => offline(240), "c250", now.t);
  assert.deepEqual(openRules(store), ["CRIT disk 1"], "4 minutes: not unknown yet; the disk alert stays (cannot tell)");
  assert.equal(row(store, now.t, "collection", offline(240)).light, "healthy");
  assert.equal(row(store, now.t, "heap", offline(240)).light, "unknown", "a blind row shows unknown");
  assert.equal(light(store, now.t, offline(240)).light, "failing");
  check(store, () => offline(300), "c250", now.t);
  assert.deepEqual(openRules(store), ["CRIT disk 1", "WARN collection 1", "WARN collection 2"]);
  assert.equal(light(store, now.t, offline(300)).light, "failing", "failing wins over unknown");
  assert.equal(row(store, now.t, "collection", offline(300)).light, "unknown");
  // The disk back to normal but still blind: unknown.
  now.t = new Date("2026-11-06T12:06:00Z");
  ingest(store, both("2026-11-06T12:05:50Z"));
  check(store, () => online, "c250", now.t);
  assert.deepEqual(openRules(store), []);
  assert.equal(light(store, now.t).light, "healthy");
  // Online but no sample: the member is unknown after 3 periods; the light after 5 minutes.
  now.t = new Date("2026-11-06T12:09:00Z");
  check(store, () => online, "c250", now.t);
  assert.deepEqual(openRules(store), [], "3 minutes without a sample");
  now.t = new Date("2026-11-06T12:11:00Z");
  check(store, () => online, "c250", now.t);
  assert.deepEqual(openRules(store), ["WARN collection 1", "WARN collection 2"]);
  const v = light(store, now.t);
  assert.equal(v.light, "unknown");
  assert.match(v.sentence, /^Not known: localhost:1844\d: no sample since 2026-11-06T12:05:50Z/);
  store.close();
});

test("collection: NiFi's REST API blind (no monitor certificate) for 5 minutes is attention with a monitor-cert to-do; readable again resolves both", () => {
  const now = { t: new Date("2026-11-06T12:00:10Z") };
  const store = lab(now);
  const todos = () => store.todos("c250").map((t) => [t.key, t.source, t.severity, t.title]);
  ingest(store, both("2026-11-06T12:00:00Z", {}, { nifi: "no-certificate" }));
  check(store, () => online, "c250", now.t);
  assert.deepEqual(openRules(store), []);
  assert.deepEqual(todos(), [], "not 5 minutes yet");
  now.t = new Date("2026-11-06T12:05:20Z");
  ingest(store, both("2026-11-06T12:05:00Z", {}, { nifi: "no-certificate" }));
  check(store, () => online, "c250", now.t);
  check(store, () => online, "c250", now.t);
  assert.deepEqual(openRules(store), ["WARN collection 2"]);
  const r = row(store, now.t, "collection");
  assert.deepEqual([r.light, light(store, now.t).light], ["attention", "attention"], "not unknown: the executor itself is fine");
  assert.match(r.text, /no monitor certificate/);
  assert.deepEqual(todos(), [["monitor-cert:c250", "machine", "attention", "Add a monitoring certificate so Deployer can read NiFi"]], "one to-do, not one per check");
  // The executor offline meanwhile: cannot tell, the to-do stays.
  check(store, () => offline(30), "c250", now.t);
  assert.equal(todos().length, 1);
  now.t = new Date("2026-11-06T12:06:10Z");
  ingest(store, both("2026-11-06T12:06:00Z"));
  check(store, () => online, "c250", now.t);
  assert.deepEqual(openRules(store), []);
  assert.deepEqual(todos(), [], "closed once NiFi can be read");
  assert.equal(store.todos("c250", "done").length, 1);
  // Unreachable is the other to-do.
  ingest(store, both("2026-11-06T12:06:30Z", {}, { nifi: "unreachable" }));
  now.t = new Date("2026-11-06T12:06:40Z");
  check(store, () => online, "c250", now.t);
  now.t = new Date("2026-11-06T12:12:00Z");
  ingest(store, both("2026-11-06T12:11:50Z", {}, { nifi: "unreachable" }));
  check(store, () => online, "c250", now.t);
  check(store, () => online, "c250", now.t);
  assert.deepEqual(todos().map((t) => t[0]), ["nifi-rest:c250"]);
  store.close();
});

test("disk: the fullest repository, 84 % healthy, 85 % attention, 95 % failing", () => {
  const now = { t: new Date("2026-11-06T12:00:10Z") };
  const store = lab(now);
  for (const [repo, want] of [[84, "healthy"], [85, "attention"], [94, "attention"], [95, "failing"]] as const) {
    ingest(store, both(iso(now.t.getTime() - 5000), { repo }));
    assert.equal(row(store, now.t, "disk").light, want, `${repo} %`);
    now.t = new Date(now.t.getTime() + 30_000);
  }
  assert.match(row(store, now.t, "disk").text, /FlowFile repository's disk is 95 % full \(\+1 more\)/);
  store.close();
});

test("heap: 85 % for 10 minutes is attention; OutOfMemoryError in the log is failing until the process starts again; back pressure is not a machine check", () => {
  const now = { t: new Date("2026-11-06T12:00:00Z") };
  const store = lab(now);
  for (let i = 0; i <= 12; i++) {
    const at = iso(Date.parse("2026-11-06T12:00:00Z") + i * 60_000);
    now.t = new Date(Date.parse(at) + 5000);
    ingest(store, both(at, { heap: i >= 2 ? 85 : 84, bp: 2 }));
    check(store, () => online, "c250", now.t);
    if (i === 11) assert.deepEqual(openRules(store), [], "high since 12:02: 9 minutes");
  }
  assert.deepEqual(openRules(store), ["WARN heap 1", "WARN heap 2"], "10 minutes; back pressure opens nothing");
  assert.equal(light(store, now.t).light, "attention");
  const oom = { key: "aaaaaaaaaaaaaaaa", level: "ERROR", logger: "o.a.n.c.StandardProcessorNode", template: "Failed to run", exception: "java.lang.OutOfMemoryError", count: 1, firstAt: "2026-11-06T12:12:30Z", lastAt: "2026-11-06T12:12:30Z", first: "x", last: "x" };
  now.t = new Date("2026-11-06T12:13:05Z");
  ingest(store, [sample(KEY1, "2026-11-06T12:13:00Z", { logs: [oom] }), sample(KEY2, "2026-11-06T12:13:00Z")]);
  check(store, () => online, "c250", now.t);
  assert.deepEqual(openRules(store), ["CRIT heap 1"], "node 2's heap fell; node 1 ran out of memory");
  assert.match(row(store, now.t, "heap").text, /OutOfMemoryError in nifi-app.log at 2026-11-06T12:12:30Z/);
  now.t = new Date("2026-11-06T12:14:05Z");
  ingest(store, both("2026-11-06T12:14:00Z", { started: "2026-11-06T12:13:40Z" }));
  check(store, () => online, "c250", now.t);
  assert.deepEqual(openRules(store), [], "started again after it");
  assert.deepEqual(heldSince([{ at: "a", v: 1 }, { at: "b", v: 0 }, { at: "c", v: 1 }, { at: "d", v: 1 }], (x) => x.v > 0)?.since, "c");
  store.close();
});

test("certificate: 31 days healthy, 30 attention, 8 attention, 7 failing, expired failing; a store that cannot be read is unknown on its row only", () => {
  const now = { t: new Date("2026-11-06T12:00:10Z") };
  const store = lab(now);
  for (const [days, want] of [[31, "healthy"], [30, "attention"], [8, "attention"], [7, "failing"], [-1, "failing"]] as const) {
    ingest(store, both(iso(now.t.getTime() - 5000), { certs: iso(now.t.getTime() + days * 86_400_000 + 3_600_000) }));
    assert.equal(row(store, now.t, "certificate").light, want, `${days} days`);
    now.t = new Date(now.t.getTime() + 1000);
  }
  assert.match(row(store, now.t, "certificate").text, /expired 1 days ago/);
  ingest(store, both(iso(now.t.getTime() - 500), { certError: "encrypted password" }));
  const v = light(store, now.t);
  assert.deepEqual([v.checks.find((r) => r.check === "certificate")!.light, v.light], ["unknown", "healthy"]);
  check(store, () => online, "c250", now.t);
  const a = store.serviceAlerts({ service: "c250", state: "open" }).filter((x) => x.rule === "certificate");
  assert.deepEqual(a.map((x) => [x.level, x.detail.light]), [["WARN", "unknown"], ["WARN", "unknown"]]);
  store.close();
});

test("coordinator: no primary node or no coordinator is failing; P2: ZooKeeper errors are its attention, differing versions the process's", () => {
  const now = { t: new Date("2026-11-06T12:00:10Z") };
  const store = lab(now);
  ingest(store, both("2026-11-06T12:00:00Z", { primary: false }));
  assert.deepEqual([row(store, now.t, "coordinator").light, row(store, now.t, "coordinator").text], ["failing", "No node is the primary node in the newest view"]);
  now.t = new Date("2026-11-06T12:00:40Z");
  ingest(store, both("2026-11-06T12:00:30Z", { coordinator: false, primary: false }));
  assert.equal(row(store, now.t, "coordinator").text, "No node is the primary node or the cluster coordinator in the newest view");
  const zk = [1, 2, 3].map((i) => ({ id: 100 + i, timestamp: "12:01:30 UTC", level: "WARNING", sourceName: "Cluster", message: "ConnectionLoss for /nifi/leaders", nodeAddress: "localhost:18445" }));
  now.t = new Date("2026-11-06T12:01:40Z");
  ingest(store, [sample(KEY1, "2026-11-06T12:01:35Z", { bulletins: zk }), sample(KEY2, "2026-11-06T12:01:35Z", { version: "2.5.1" })]);
  check(store, () => online, "c250", now.t);
  assert.deepEqual(openRules(store), ["WARN coordinator *", "WARN process *"]);
  const c = store.serviceAlerts({ service: "c250", state: "open" }).find((a) => a.rule === "coordinator")!;
  assert.deepEqual([c.detail.light, c.detail.count, c.detail.bulletins], ["attention", 3, 3]);
  assert.match(row(store, now.t, "process").text, /The nodes run 2.5.0 and 2.5.1/);
  // ZooKeeper and no coordinator together: one condition, the worse light.
  ingest(store, both("2026-11-06T12:01:38Z", { coordinator: false }));
  check(store, () => online, "c250", now.t);
  const merged = store.serviceAlerts({ service: "c250", state: "open" }).filter((a) => a.rule === "coordinator");
  assert.deepEqual(merged.map((a) => [a.level, a.detail.light, a.detail.count, a.detail.missing]), [["CRIT", "failing", 3, ["cluster coordinator"]]]);
  assert.match(String(merged[0]!.detail.text), /^No node is the cluster coordinator in the newest view; 3 ZooKeeper connection messages/);
  store.close();
});

test("the light over the rows: failing first, collection unknown before attention, another row's unknown does not count", () => {
  const r = (check: string, light: string) => ({ check, light }) as Parameters<typeof overallLight>[0][number];
  assert.equal(overallLight([r("disk", "attention"), r("collection", "unknown")]), "unknown");
  assert.equal(overallLight([r("process", "failing"), r("collection", "unknown")]), "failing");
  assert.equal(overallLight([r("certificate", "unknown"), r("heap", "attention")]), "attention");
  assert.equal(overallLight([r("certificate", "unknown"), r("collection", "healthy")]), "healthy");
});

test("turning red: green or yellow (or unknown) to failing is a machine-red event and a turn for checkAll's listener; back is machine-recovered; the first look records only", () => {
  const now = { t: new Date("2026-11-06T12:00:10Z") };
  const store = lab(now);
  const turns: MachineTurn[] = [];
  const run = () => checkAll(store, () => online, now.t, (x) => turns.push(x));
  ingest(store, both("2026-11-06T12:00:00Z", { repo: 96 }));
  run();
  assert.equal(turns.length, 0, "failing at the first look: no turn from nothing");
  now.t = new Date("2026-11-06T12:00:40Z");
  ingest(store, both("2026-11-06T12:00:30Z", { repo: 90 }));
  assert.equal(run().turns[0]?.kind, "machine-recovered");
  now.t = new Date("2026-11-06T12:01:10Z");
  ingest(store, both("2026-11-06T12:01:00Z", {}, { running: false }));
  const r = run();
  assert.deepEqual(r.turns.map((x) => [x.kind, x.from, x.to]), [["machine-red", "attention", "failing"]]);
  assert.match(r.turns[0]!.text, /^Failing: localhost:18446: no NiFi process/);
  const red = store.serviceEvents("c250", { kind: "machine-red" });
  assert.deepEqual(red.map((e) => [e.detail.from, e.detail.to, e.detail.checks]), [["attention", "failing", ["process"]]]);
  run();
  assert.equal(store.serviceEvents("c250", { kind: "machine-red" }).length, 1, "staying red is no new turn");
  now.t = new Date("2026-11-06T12:01:40Z");
  ingest(store, both("2026-11-06T12:01:30Z"));
  run();
  assert.deepEqual(turns.map((x) => x.kind), ["machine-recovered", "machine-red", "machine-recovered"]);
  // Unknown to failing is red too.
  now.t = new Date("2026-11-06T12:08:00Z");
  run();
  assert.equal(light(store, now.t).light, "unknown");
  ingest(store, both("2026-11-06T12:07:55Z", {}, { running: false }));
  run();
  assert.deepEqual(turns.slice(-1).map((x) => [x.kind, x.from]), [["machine-red", "unknown"]]);
  assert.ok(kinds(store).includes("machine-red"));
  store.close();
});

test("thresholds: the C1 defaults, overrides from the column, bounds and order checked; an override moves the bound at once", () => {
  const now = { t: new Date("2026-11-06T12:00:10Z") };
  const store = lab(now);
  assert.deepEqual(NIFI_THRESHOLDS, { collectionMinutes: 5, repoDiskWarnPct: 85, repoDiskCritPct: 95, heapPct: 85, heapMinutes: 10, oomMinutes: 60, zkErrors: 3, zkMinutes: 5, certWarnDays: 30, certCritDays: 7 });
  assert.deepEqual(Object.keys(NIFI_THRESHOLDS), [...THRESHOLD_KEYS], "the names a set-threshold to-do may use are the thresholds");
  assert.deepEqual(thresholdsOf(store, "c250", "nifi-2.x"), { defaults: NIFI_THRESHOLDS, overrides: {}, effective: NIFI_THRESHOLDS });
  assert.deepEqual(parseThresholds({ thresholds: { certWarnDays: 400, heapPct: 85, collectionMinutes: null } }, NIFI_THRESHOLDS), { overrides: { certWarnDays: 400 } }, "a default or null is no override");
  const bad = parseThresholds({ thresholds: { certWarnDays: 5, nope: 1, heapPct: 101, backpressureMinutes: 3 } }, NIFI_THRESHOLDS);
  assert.ok("error" in bad && bad.details.length === 4, JSON.stringify(bad));
  assert.ok("error" in parseThresholds({}, NIFI_THRESHOLDS));
  store.setServiceThresholds("c250", { executorLostMinutes: 9 }, admin);
  assert.deepEqual(thresholdsOf(store, "c250", "nifi-2.x").overrides, {}, "an override from before C1 is ignored");
  ingest(store, both("2026-11-06T12:00:00Z", { certs: "2027-11-06T00:00:00Z", repo: 70 }));
  checkAll(store, () => online, now.t);
  assert.deepEqual(openRules(store), []);
  store.setServiceThresholds("c250", { certWarnDays: 400, repoDiskWarnPct: 60 }, admin);
  check(store, () => online, "c250", now.t);
  assert.deepEqual(openRules(store), ["WARN certificate 1", "WARN certificate 2", "WARN disk 1", "WARN disk 2"]);
  assert.equal(serviceStatus(store, () => online, "c250", now.t)!.summary.certDays.warn, 400);
  store.setServiceThresholds("c250", {}, admin);
  check(store, () => online, "c250", now.t);
  assert.deepEqual(openRules(store), []);
  store.close();
});

test("an alert from before C1 (an old rule) resolves at the next check", () => {
  const now = { t: new Date("2026-11-06T12:00:10Z") };
  const store = lab(now);
  ingest(store, both("2026-11-06T12:00:00Z"));
  store.openServiceAlert({ service: "c250", member: "*", rule: "backpressure", level: "WARN", detail: { text: "old" } }, "2026-11-06T11:00:00Z", { text: "old" });
  assert.equal(check(store, () => online, "c250", now.t)!.resolved, 1);
  assert.deepEqual(openRules(store), []);
  store.close();
});
