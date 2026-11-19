// S37 step 2 (pages-rethink §4.1), step 3a (C1): the to-do list over the machine checks, the findings-only preventive
// risk and the health body (with the machine light).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExecutorInfo } from "../src/server/handoff.ts";
import { ingest } from "../src/server/services/metrics.ts";
import { check, health, machineLight, preventive } from "../src/server/services/rules.ts";
import { opsDesk } from "../src/server/services/ops.ts";
import { NIFI_THRESHOLDS } from "../src/server/services/profiles.ts";
import type { ServiceSample } from "../src/server/services/watch.ts";
import { Store } from "../src/server/store.ts";

const admin = { id: "admin", via: "cli" } as const;
const node = (installDir: string, https: number) => ({ host: "local", installDir, serviceUser: "ferenc", startEnvironment: null, ports: { https }, nodeAddress: "localhost", discovery: null });
const KEY1 = "local:/lab/c250-1", KEY2 = "local:/lab/c250-2";
const online: ExecutorInfo = { online: true, host: "local", ageSeconds: 5, heartbeat: { collector: { seconds: 30 } } as never };

function lab(now: { t: Date }) {
  const store = new Store(":memory:", () => now.t);
  store.addCluster({ kind: "cluster", id: "c250", service: "nifi", profile: "nifi-2.x", version: "2.5.0", webUrl: "https://localhost:18445/nifi", zookeeper: "zk:2181", zookeeperRoot: "/c250", nodes: [node("/lab/c250-1", 18445), node("/lab/c250-2", 18446)] }, "uat", admin);
  return store;
}
type More = { running?: boolean; heap?: number; repo?: number; nifi?: string; status2?: string; certs?: string; selfNodeId?: string };
const diag = (port: number, heap: number, repo: number) => ({ address: "localhost", apiPort: port, nodeId: `id-${port}`, heap: { usedBytes: heap, maxBytes: 100 }, totalThreads: 1, gc: [], repositories: { flowfile: [{ totalSpaceBytes: 100, usedSpaceBytes: repo }], content: [], provenance: [] } });
function sample(member: string, at: string, m: More = {}): ServiceSample {
  const own = member === KEY1 ? 18445 : 18446;
  return {
    service: "c250", member, at,
    process: m.running === false ? { running: false } : { running: true, pid: own, startedAt: "2026-11-06T11:00:00Z" },
    nifi: m.running === false ? { state: "not-running" } : {
      state: m.nifi ?? "ok", about: { version: "2.5.0", timezone: "UTC" },
      ...(m.selfNodeId ? { selfNodeId: m.selfNodeId } : {}),
      diagnostics: { nodes: [diag(18445, m.heap ?? 50, m.repo ?? 10), diag(18446, m.heap ?? 50, m.repo ?? 10)] },
      cluster: { nodes: [
        { address: "localhost", apiPort: 18445, status: "CONNECTED", roles: ["Cluster Coordinator", "Primary Node"] },
        { address: "localhost", apiPort: 18446, status: m.status2 ?? "CONNECTED", roles: [] },
      ] },
      backpressure: { connections: 3, full: 0, maxPercent: 10 }, bulletins: [],
    },
    ...(m.certs ? { certs: { readAt: at, stores: [{ store: "keystore", certificates: [{ alias: "k", chain: 1, subject: "CN=node.lab", issuer: "CN=ca", notBefore: "2026-01-01T00:00:00Z", notAfter: m.certs }] }] } } : {}),
  } as ServiceSample;
}
const both = (at: string, m: More = {}, m2: More = m) => [sample(KEY1, at, m), sample(KEY2, at, m2)];
const rules = (h: ReturnType<typeof health>) => h!.todos.map((x) => `${x.severity} ${x.rule} ${x.member === "*" ? "*" : x.member === KEY1 ? "1" : "2"}`).sort();
const t = NIFI_THRESHOLDS;

test("healthy: nothing to do, verdict ok, the machine light healthy, one row per node", () => {
  const now = { t: new Date("2026-11-06T12:00:10Z") };
  const store = lab(now);
  ingest(store, both("2026-11-06T12:00:00Z"));
  const h = health(store, () => online, "c250", now.t)!;
  assert.equal(h.verdict, "ok");
  assert.deepEqual(h.todos, []);
  assert.equal(h.machine.light, "healthy");
  assert.deepEqual(h.machine, machineLight(store, () => online, "c250", now.t), "the same light as machineLight()");
  assert.deepEqual(h.members.map((m) => [m.label, m.connection, m.heapPct]), [["localhost:18445", "CONNECTED", 50], ["localhost:18446", "CONNECTED", 50]]);
  assert.equal(health(store, () => online, "nope", now.t), undefined);
  store.close();
});

test("a stopped node: the process check's CRIT to-do with cause, evidence and Start; since is the alert's opening; investigate and metrics are gone", () => {
  const now = { t: new Date("2026-11-06T12:00:10Z") };
  const store = lab(now);
  ingest(store, both("2026-11-06T12:00:00Z"));
  check(store, () => online, "c250", now.t);
  now.t = new Date("2026-11-06T12:00:40Z");
  ingest(store, [sample(KEY1, "2026-11-06T12:00:30Z", { status2: "DISCONNECTED" }), sample(KEY2, "2026-11-06T12:00:30Z", { running: false })]);
  check(store, () => online, "c250", now.t);
  now.t = new Date("2026-11-06T12:01:00Z");
  const h = health(store, () => online, "c250", now.t)!;
  assert.equal(h.verdict, "critical");
  assert.equal(h.machine.light, "failing");
  assert.deepEqual(rules(h), ["CRIT process 2"]);
  const down = h.todos[0]!;
  assert.equal(down.since, "2026-11-06T12:00:40.000Z", "since: when the alert opened, not now");
  assert.equal(down.memberLabel, "localhost:18446");
  assert.match(down.cause, /NiFi is not running/);
  assert.match(down.evidence[0]!, /no NiFi process/);
  assert.match(down.evidence[1]!, /disconnected in the coordinator's view/);
  assert.deepEqual(down.actions.map((a) => [a.kind, a.label]), [["member-control", "Start"]]);
  assert.deepEqual(h.counts, { CRIT: 1, WARN: 0, INFO: 0 });
  store.close();
});

const rows = (n: number, f: (i: number) => Record<string, number | null>) => Array.from({ length: n }, (_, i) => ({ bucket: new Date(Date.parse("2026-11-05T12:00:00Z") + i * 5 * 60_000).toISOString(), avg: f(i) }));

test("preventive: disk growing fills in days (WARN within 3 days, INFO within 14), flat or already failing stays quiet, too little history stays quiet", () => {
  // 24 h of 5-minute points: 288. 40 -> 52 % in a day = 12 points a day: 48 % left = 4 days
  const grow = (perDay: number, start: number) => rows(288, (i) => ({ repoContentPct: start + (perDay * i) / 288 }));
  let p = preventive(grow(12, 40), t);
  assert.equal(p.length, 1);
  assert.equal(p[0]!.severity, "INFO");
  assert.match(p[0]!.text, /content repository.*full in about 4/);
  p = preventive(grow(30, 20), t); // (100-50)/30 = 1.7 days
  assert.equal(p[0]!.severity, "WARN");
  assert.deepEqual(preventive(grow(0, 40), t), []);
  assert.deepEqual(preventive(grow(2, 40), t), [], "more than 14 days away");
  assert.deepEqual(preventive(grow(12, 85), t), [], "already over the failing threshold: the check's");
  assert.deepEqual(preventive(grow(12, 40).slice(0, 10), t), [], "under an hour of points");
});

test("preventive: a heap baseline that keeps rising warns, a sawtooth around a stable baseline does not", () => {
  const saw = (base: (i: number) => number) => rows(288, (i) => ({ heapPct: base(i) + (i % 12 === 0 ? 0 : 20) })); // peaks 20 points over the low
  const rising = preventive(saw((i) => 30 + (i / 288) * 30), t); // low 30 -> 60 % in a day
  assert.equal(rising.length, 1);
  assert.equal(rising[0]!.kind, "heap");
  assert.match(rising[0]!.text, /lowest level rose from 3\d % to [56]\d %/);
  assert.deepEqual(preventive(saw(() => 35), t), []);
  assert.deepEqual(preventive(saw((i) => 30 + (i / 288) * 3), t), [], "a small rise");
});

test("preventive in the health body: disk rollups of a node, and a certificate beyond the attention days but within 90; the machine light does not move (C1)", () => {
  const now = { t: new Date("2026-11-06T12:00:10Z") };
  const store = lab(now);
  ingest(store, both("2026-11-06T12:00:00Z", { certs: "2027-01-20T00:00:00Z" }));
  const out = Array.from({ length: 288 }, (_, i) => ({ service: "c250", member: KEY2, bucket: new Date(Date.parse("2026-11-05T12:00:00Z") + i * 5 * 60_000).toISOString(), body: { avg: { repoContentPct: 30 + (i * 30) / 288 } } }));
  store.putServiceRollups(out);
  const h = health(store, () => online, "c250", now.t)!;
  const pre = h.todos.filter((x) => x.rule === "preventive-risk");
  assert.equal(pre.filter((x) => x.member === KEY2 && /repository/.test(x.evidence[0]!)).length, 1);
  assert.ok(pre.some((x) => /expires in 74 days/.test(x.evidence[0]!)), JSON.stringify(pre.map((x) => x.evidence)));
  assert.ok(pre.every((x) => x.severity !== "CRIT"));
  assert.equal(h.verdict, "attention");
  assert.equal(h.machine.light, "healthy", "full in days is the analysis's, not the light's");
  store.close();
});

test("an expired or close certificate is the certificate check's CRIT to-do, not doubled by the preventive one", () => {
  const now = { t: new Date("2026-11-06T12:00:10Z") };
  const store = lab(now);
  ingest(store, both("2026-11-06T12:00:00Z", { certs: "2026-11-10T00:00:00Z" }));
  const h = health(store, () => online, "c250", now.t)!;
  assert.deepEqual(rules(h), ["CRIT certificate 1", "CRIT certificate 2"]);
  store.close();
});

test("ops desk: one queue worst first and one sentence per service, from the same health()", () => {
  const now = { t: new Date("2026-11-06T12:00:10Z") };
  const store = lab(now);
  ingest(store, both("2026-11-06T12:00:00Z"));
  let desk = opsDesk(store, () => online, now.t);
  assert.deepEqual(desk.queue, []);
  assert.deepEqual(desk.services.map((x) => [x.id, x.verdict, x.sentence]), [["c250", "ok", "Normal. Nothing needs doing."]]);
  ingest(store, [sample(KEY1, "2026-11-06T12:00:05Z"), sample(KEY2, "2026-11-06T12:00:05Z", { running: false })]);
  desk = opsDesk(store, () => online, now.t);
  const h = health(store, () => online, "c250", now.t)!;
  assert.equal(desk.services[0]!.verdict, "critical");
  assert.deepEqual(desk.queue.map((x) => x.id), h.todos.map((x) => x.id));
  assert.ok(desk.queue.every((x) => x.service === "c250"));
  assert.match(desk.services[0]!.sentence, /^Critical: /);
  store.close();
});
