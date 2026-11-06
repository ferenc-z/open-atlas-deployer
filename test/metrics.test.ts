// Phase 2 step 2 (§15.3): samples into points, rates, bulletins dated and kept once, certificates by readAt, rollups,
// retention, the metrics view, and the live member states.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExecutorInfo } from "../src/server/handoff.ts";
import { bulletinTime, ingest, localOffset, metrics, pointOf, prune, rollUp, trend } from "../src/server/services/metrics.ts";
import { serviceStatus } from "../src/server/services/status.ts";
import type { ServiceSample } from "../src/server/services/watch.ts";
import { Store } from "../src/server/store.ts";

const admin = { id: "admin", via: "cli" } as const;
const node = (installDir: string, https: number) => ({ host: "local", installDir, serviceUser: "ferenc", startEnvironment: null, ports: { https }, nodeAddress: "localhost", discovery: null });
const KEY1 = "local:/lab/c250-1", KEY2 = "local:/lab/c250-2";

function lab(now: { t: Date }) {
  const store = new Store(":memory:", () => now.t);
  store.addCluster({ kind: "cluster", id: "c250", service: "nifi", profile: "nifi-2.x", version: "2.5.0", webUrl: null, zookeeper: "zk:2181", zookeeperRoot: "/c250", nodes: [node("/lab/c250-1", 18445), node("/lab/c250-2", 18446)] }, "uat", admin);
  return store;
}

const snapshot = (used: number, gcMillis: number, gcCount: number) => ({
  heap: { usedBytes: used, maxBytes: 1 << 30, totalBytes: 1 << 30 }, nonHeapUsedBytes: 100, totalThreads: 150,
  gc: [{ name: "G1 Young Generation", count: gcCount, millis: gcMillis }, { name: "G1 Old Generation", count: 0, millis: 0 }],
  repositories: { flowfile: [{ totalSpaceBytes: 1000, usedSpaceBytes: 100 }], content: [{ totalSpaceBytes: 1000, usedSpaceBytes: 250 }, { totalSpaceBytes: 1000, usedSpaceBytes: 500 }], provenance: [] },
});
// A c250 node's sample as the collector sends it (the shape of the lab's, §15.5 step 1): both nodes' nodewise
// snapshots and cluster view; node 1 is the coordinator.
function sample(member: string, at: string, more: { cpu?: number; started?: string; used?: number; gc?: [number, number]; bulletins?: unknown[]; certsReadAt?: string; status2?: string; running?: boolean } = {}): ServiceSample {
  const [ms, n] = more.gc ?? [100, 10];
  return {
    service: "c250", member, at,
    process: more.running === false ? { running: false } : { running: true, pid: 7, startedAt: more.started ?? "2026-11-06T11:00:00Z", rssBytes: 1 << 30, threads: 190, cpuSeconds: more.cpu ?? 100 },
    host: { cpus: 32, load: [0.5, 0.4, 0.3], memory: { totalBytes: 1000, availableBytes: 400 } },
    disks: [{ device: 1, path: "/lab", totalBytes: 1000, freeBytes: 900, usedBytes: 100, holds: ["content"] }],
    nifi: {
      state: "ok", about: { version: "2.5.0", timezone: "CST" },
      diagnostics: { aggregate: snapshot(1, 1, 1), nodes: [{ address: "localhost", apiPort: 18445, ...snapshot(more.used ?? 1 << 29, ms, n) }, { address: "localhost", apiPort: 18446, ...snapshot(1 << 28, 5, 1) }] },
      status: { flowFilesQueued: 30, bytesQueued: 3000, activeThreadCount: 2 },
      cluster: { nodes: [
        { address: "localhost", apiPort: 18445, status: "CONNECTED", roles: ["Primary Node", "Cluster Coordinator"], heartbeat: "11/06/2026 20:15:28 CST", flowFilesQueued: 10, bytesQueued: 1000, activeThreadCount: 1 },
        { address: "localhost", apiPort: 18446, status: member === KEY1 ? (more.status2 ?? "CONNECTED") : "CONNECTED", roles: [], heartbeat: "11/06/2026 20:15:28 CST", flowFilesQueued: 20, bytesQueued: 2000, activeThreadCount: 1 },
      ] },
      backpressure: { connections: 3, full: 1, maxPercent: 100, top: [] },
      bulletins: more.bulletins ?? [],
    },
    ...(more.certsReadAt ? { certs: { readAt: more.certsReadAt, stores: [
      { store: "keystore", path: "/lab/keystore.p12", type: "PKCS12", certificates: [{ alias: "nifi-key", chain: 1, subject: "CN=node1.lab", issuer: "CN=ca", notBefore: "2026-11-04T00:00:00Z", notAfter: "2026-12-01T00:00:00Z" }] },
      { store: "truststore", path: "/lab/truststore.jks", type: "JKS", error: "the truststore password is encrypted in nifi.properties" },
    ] } } : {}),
  } as ServiceSample;
}

test("a sample's point: the node's own snapshot and queue share, repositories, host; rates from the previous sample", () => {
  const m = node("/lab/c250-1", 18445);
  const first = pointOf(sample(KEY1, "2026-11-06T12:00:00Z"), m);
  assert.deepEqual([first.up, first.heapUsed, first.heapPct, first.threads, first.queuedCount, first.queuedBytes, first.activeThreads], [1, 1 << 29, 50, 150, 10, 1000, 1], "node 1's own numbers, not the aggregate or the cluster's");
  assert.deepEqual([first.repoFlowfilePct, first.repoContentPct, first.repoProvenancePct, first.bpFull, first.bpMaxPct], [10, 50, null, 1, 100]);
  assert.deepEqual([first.load1, first.memPct, first.diskPct, first.rss], [0.5, 60, 10, 1 << 30]);
  assert.deepEqual([first.cpuPct, first.gcMsPerMin], [null, null], "no previous sample: no rates");
  const second = pointOf(sample(KEY1, "2026-11-06T12:01:00Z", { cpu: 130, gc: [160, 13] }), m, first, "2026-11-06T12:00:00Z");
  assert.deepEqual([second.cpuPct, second.gcMsPerMin, second.gcPerMin], [50, 60, 3], "30 CPU seconds in 60 s; 60 ms of GC in a minute");
  const restarted = pointOf(sample(KEY1, "2026-11-06T12:02:00Z", { cpu: 5, started: "2026-11-06T12:01:30Z" }), m, second, "2026-11-06T12:01:00Z");
  assert.equal(restarted.cpuPct, null, "a restart resets the counters");
  const stopped = pointOf(sample(KEY1, "2026-11-06T12:03:00Z", { running: false }), m, restarted, "2026-11-06T12:02:00Z");
  assert.equal(stopped.up, 0);
  // A standalone takes the aggregate and /flow/status.
  const s = sample(KEY1, "2026-11-06T12:00:00Z") as Record<string, any>;
  delete s.nifi.diagnostics.nodes; delete s.nifi.cluster;
  const single = pointOf(s, { ports: { https: 18443 }, nodeAddress: null });
  assert.deepEqual([single.heapUsed, single.queuedCount], [1, 30]);
});

test("bulletin times: NiFi's time of day dated by the sample, across midnight; the offset from the cluster view or the newest bulletin", () => {
  const off = 8 * 3600_000;
  assert.equal(bulletinTime("20:14:00 CST", "2026-11-06T12:15:32Z", off), "2026-11-06T12:14:00Z");
  assert.equal(bulletinTime("23:59:50 CST", "2026-11-06T16:00:30Z", off), "2026-11-06T15:59:50Z", "the day before, local time");
  assert.equal(bulletinTime("00:00:10 CST", "2026-11-06T16:00:30Z", off), "2026-11-06T16:00:10Z");
  assert.equal(bulletinTime("nonsense", "2026-11-06T16:00:30Z", off), null);
  assert.equal(localOffset(sample(KEY1, "2026-11-06T12:15:32Z"), "a"), off, "from the cluster heartbeat");
  const single = { at: "2026-11-06T05:00:30Z", nifi: { about: { timezone: "CDT" }, bulletins: [{ timestamp: "23:57:00 CDT" }, { timestamp: "23:58:10 CDT" }] } };
  assert.equal(localOffset(single, "b"), -5 * 3600_000, "from the newest bulletin");
  assert.equal(localOffset({ at: "2026-11-06T09:00:00Z", nifi: { about: { timezone: "CDT" } } }, "b"), -5 * 3600_000, "remembered");
  assert.equal(localOffset({ at: "2026-11-06T09:00:00Z", nifi: {} }, "c"), null);
});

test("ingest: bulletins once across the nodes (and again after a restart's ids), certificates only when read later, raw bodies without them", () => {
  const now = { t: new Date("2026-11-06T12:20:00Z") };
  const store = lab(now);
  const b = (id: number, ts: string, level = "WARNING") => ({ id, timestamp: ts, nodeAddress: "localhost:18445", level, sourceName: "GenerateFlowFile", message: `m${id}` });
  // Both nodes report the same two bulletins (each node's board has the whole cluster's).
  ingest(store, [sample(KEY1, "2026-11-06T12:15:00Z", { bulletins: [b(0, "20:14:00 CST"), b(1, "20:14:30 CST", "ERROR")], certsReadAt: "2026-11-06T12:00:00Z" }), sample(KEY2, "2026-11-06T12:15:01Z", { bulletins: [b(0, "20:14:00 CST"), b(1, "20:14:30 CST", "ERROR")] })]);
  assert.deepEqual(store.serviceBulletins("c250").map((x) => [x.id, x.at, x.level, x.member]), [[1, "2026-11-06T12:14:30Z", "ERROR", KEY1], [0, "2026-11-06T12:14:00Z", "WARNING", KEY1]]);
  // After a restart id 0 comes again, at another time: a new bulletin.
  ingest(store, [sample(KEY1, "2026-11-06T12:16:00Z", { bulletins: [b(0, "20:15:50 CST")] })]);
  assert.equal(store.serviceBulletins("c250").length, 3);
  assert.deepEqual(store.serviceBulletins("c250", { level: "ERROR" }).map((x) => x.id), [1]);

  let certs = store.serviceCerts("c250");
  assert.deepEqual(certs.map((c) => [c.store, c.alias, c.notAfter, c.error !== null]), [["keystore", "nifi-key", "2026-12-01T00:00:00Z", false], ["truststore", null, null, true]]);
  ingest(store, [sample(KEY1, "2026-11-06T12:17:00Z", { certsReadAt: "2026-11-06T12:00:00Z" })]);
  assert.equal(store.serviceCerts("c250").length, 2, "the same reading again changes nothing");
  const later = sample(KEY1, "2026-11-06T12:18:00Z", { certsReadAt: "2026-11-06T12:18:00Z" }) as Record<string, any>;
  later.certs.stores = [later.certs.stores[0]];
  ingest(store, [later as ServiceSample]);
  certs = store.serviceCerts("c250");
  assert.deepEqual(certs.map((c) => [c.store, c.readAt]), [["keystore", "2026-11-06T12:18:00Z"]], "only the newest reading stays");

  const raw = store.latestServiceSamples("c250").find((x) => x.member === KEY1)!;
  assert.equal("certs" in raw.body, false);
  assert.equal("bulletins" in (raw.body.nifi as object), false);
  assert.equal(raw.point!.heapPct, 50);
  store.close();
});

test("live states: running as of the sample, unknown after 3 periods, lost with the executor offline; node connections in the coordinator's view", () => {
  const now = { t: new Date("2026-11-06T12:15:40Z") };
  const store = lab(now);
  const online: ExecutorInfo = { online: true, host: "local", heartbeat: { collector: { seconds: 30 } } as never };
  ingest(store, [sample(KEY1, "2026-11-06T12:15:30Z", { status2: "DISCONNECTED", certsReadAt: "2026-11-06T12:00:00Z" }), sample(KEY2, "2026-11-06T12:14:30Z", { running: false })]);
  let st = serviceStatus(store, () => online, "c250", now.t)!;
  assert.deepEqual(st.members.map((m) => [m.state, m.source, m.asOf, m.live?.connection]), [["running", "samples", "2026-11-06T12:15:30Z", "CONNECTED"], ["stopped", "samples", "2026-11-06T12:14:30Z", "DISCONNECTED"]],
    "node 2's own view says CONNECTED, the coordinator's says DISCONNECTED");
  assert.deepEqual([st.summary.running, st.summary.asOf, st.summary.period, st.summary.cert?.days, st.summary.certErrors], [1, "2026-11-06T12:14:30Z", 30, 24, 1]);
  now.t = new Date("2026-11-06T12:17:00Z");
  st = serviceStatus(store, () => online, "c250", now.t)!;
  assert.deepEqual(st.members.map((m) => m.state), ["running", "unknown"], "node 2's sample is 2.5 minutes old: more than 3 × 30 s");
  st = serviceStatus(store, () => ({ online: false, host: "local", reason: "No heartbeat" }), "c250", now.t)!;
  assert.deepEqual(st.members.map((m) => [m.state, m.asOf]), [["lost", "2026-11-06T12:15:30Z"], ["lost", "2026-11-06T12:14:30Z"]]);
  store.close();
});

test("rollups every 5 minutes, retention, the metrics view from samples or rollups, the cards' trend", () => {
  const now = { t: new Date("2026-11-06T12:00:00Z") };
  const store = lab(now);
  const samples: ServiceSample[] = [];
  for (let i = 0; i < 20; i++) samples.push(sample(KEY1, new Date(Date.parse("2026-11-06T11:00:00Z") + i * 60_000).toISOString().replace(".000Z", "Z"), { used: (i + 1) * (1 << 24), cpu: 100 + i * 30 }));
  ingest(store, samples);
  assert.equal(rollUp(store, new Date("2026-11-06T11:17:00Z")), 3, "11:00, 11:05, 11:10 (11:15 is not over)");
  assert.equal(rollUp(store, new Date("2026-11-06T11:17:30Z")), 0);
  assert.equal(rollUp(store, new Date("2026-11-06T11:21:00Z")), 1, "11:15");
  const r = store.serviceRollups("c250", "2026-11-06T11:00:00Z", "2026-11-06T11:05:01Z")[0]!;
  assert.deepEqual([r.bucket, r.body.n, r.body.max.heapUsed, r.body.last.heapUsed, r.body.avg.heapUsed], ["2026-11-06T11:00:00Z", 5, 5 << 24, 5 << 24, 3 << 24]);
  assert.equal(r.body.avg.cpuPct, 50, "rates rolled up like the rest");

  const view = metrics(store, "c250", { from: new Date("2026-11-06T11:00:00Z"), to: new Date("2026-11-06T11:20:00Z"), now: now.t, step: 300, fields: ["heapUsed"] });
  assert.equal(view.source, "samples");
  assert.deepEqual(view.members.map((m) => [m.member, m.at.length, m.values.heapUsed?.[0]]), [[KEY1, 4, 3 << 24]]);
  const month = metrics(store, "c250", { from: new Date("2026-10-07T12:00:00Z"), to: now.t, now: now.t });
  assert.equal(month.source, "rollups");
  assert.ok(month.members[0]!.at.length >= 1);
  assert.equal(trend(store, "c250", new Date("2026-11-06T11:21:00Z")).heapPct.filter((v) => v !== null).length, 4);

  // Two days on, the raw samples go; the rollups stay 30 days.
  assert.deepEqual(prune(store, new Date("2026-11-08T11:30:00Z")), { samples: 20, bulletins: 0, rollups: 0 });
  assert.deepEqual(prune(store, new Date("2026-12-06T11:30:00Z")), { samples: 0, bulletins: 0, rollups: 4 });
  store.close();
});
