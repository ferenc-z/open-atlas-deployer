// Phase 2 step 3 (§15.3): the health rules, alerts (one open per rule and member, resolved after), the timeline
// (disconnect and reconnect, restart, version, takeover), thresholds (defaults, overrides, bounds) and their routes.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExecutorInfo } from "../src/server/handoff.ts";
import { ingest } from "../src/server/services/metrics.ts";
import { check, checkAll, heldSince, parseThresholds } from "../src/server/services/rules.ts";
import { NIFI_THRESHOLDS } from "../src/server/services/profiles.ts";
import { serviceStatus, thresholdsOf } from "../src/server/services/status.ts";
import type { ServiceSample } from "../src/server/services/watch.ts";
import { Store } from "../src/server/store.ts";

const admin = { id: "admin", via: "cli" } as const;
const node = (installDir: string, https: number) => ({ host: "local", installDir, serviceUser: "ferenc", startEnvironment: null, ports: { https }, nodeAddress: "localhost", discovery: null });
const KEY1 = "local:/lab/c250-1", KEY2 = "local:/lab/c250-2";
const online: ExecutorInfo = { online: true, host: "local", ageSeconds: 5, heartbeat: { collector: { seconds: 30 } } as never };

function lab(now: { t: Date }) {
  const store = new Store(":memory:", () => now.t);
  store.addCluster({ kind: "cluster", id: "c250", service: "nifi", profile: "nifi-2.x", version: "2.5.0", webUrl: null, zookeeper: "zk:2181", zookeeperRoot: "/c250", nodes: [node("/lab/c250-1", 18445), node("/lab/c250-2", 18446)] }, "uat", admin);
  return store;
}

type More = { running?: boolean; started?: string; heap?: number; repo?: number; bp?: number; status2?: string; coordinator?: boolean; version?: string; nifi?: string; bulletins?: unknown[]; certs?: string };
const diag = (port: number, heap: number, repo: number) => ({ address: "localhost", apiPort: port, heap: { usedBytes: heap, maxBytes: 100 }, totalThreads: 1, gc: [], repositories: { flowfile: [{ totalSpaceBytes: 100, usedSpaceBytes: repo }], content: [], provenance: [] } });
function sample(member: string, at: string, m: More = {}): ServiceSample {
  const own = member === KEY1 ? 18445 : 18446;
  return {
    service: "c250", member, at,
    process: m.running === false ? { running: false } : { running: true, pid: own, startedAt: m.started ?? "2026-11-06T11:00:00Z" },
    nifi: m.running === false ? { state: "not-running" } : {
      state: m.nifi ?? "ok", about: { version: m.version ?? "2.5.0", timezone: "UTC" },
      diagnostics: { nodes: [diag(18445, m.heap ?? 50, m.repo ?? 10), diag(18446, m.heap ?? 50, m.repo ?? 10)] },
      cluster: { nodes: [
        { address: "localhost", apiPort: 18445, status: "CONNECTED", roles: m.coordinator === false ? [] : ["Cluster Coordinator"] },
        { address: "localhost", apiPort: 18446, status: m.status2 ?? "CONNECTED", roles: [] },
      ] },
      backpressure: { connections: 3, full: m.bp ?? 0, maxPercent: m.bp ? 100 : 10 },
      bulletins: m.bulletins ?? [],
    },
    ...(m.certs ? { certs: { readAt: at, stores: [{ store: "keystore", certificates: [{ alias: "k", chain: 1, subject: "CN=node.lab", issuer: "CN=ca", notBefore: "2026-01-01T00:00:00Z", notAfter: m.certs }] }] } } : {}),
  } as ServiceSample;
}
const both = (at: string, m: More = {}, m2: More = m) => [sample(KEY1, at, m), sample(KEY2, at, m2)];
const openRules = (store: Store) => store.serviceAlerts({ service: "c250", state: "open" }).map((a) => `${a.level} ${a.rule} ${a.member === "*" ? "*" : a.member === KEY1 ? "1" : "2"}`).sort();
const kinds = (store: Store) => store.serviceEvents("c250").map((e) => e.kind).reverse();

test("a node stopped: process down and disconnected open, with the disconnect on the timeline; started: they resolve, reconnected and restarted", () => {
  const now = { t: new Date("2026-11-06T12:00:10Z") };
  const store = lab(now);
  ingest(store, both("2026-11-06T12:00:00Z"));
  assert.deepEqual(check(store, () => online, "c250", now.t), { opened: 0, changed: 0, resolved: 0, events: 0 }, "the first look only records the facts");
  assert.deepEqual(openRules(store), []);
  now.t = new Date("2026-11-06T12:00:40Z");
  ingest(store, [sample(KEY1, "2026-11-06T12:00:30Z", { status2: "DISCONNECTED" }), sample(KEY2, "2026-11-06T12:00:30Z", { running: false })]);
  check(store, () => online, "c250", now.t);
  assert.deepEqual(openRules(store), ["CRIT node-disconnected 2", "CRIT process-down 2"]);
  check(store, () => online, "c250", now.t);
  assert.equal(store.serviceAlerts({ service: "c250" }).length, 2, "still one alert per rule and member");
  assert.deepEqual(kinds(store).sort(), ["alert-opened", "alert-opened", "node-disconnected", "taken-over"]);
  const st = serviceStatus(store, () => online, "c250", now.t)!;
  assert.deepEqual(st.summary.alerts, { open: 2, CRIT: 2, WARN: 0 });
  now.t = new Date("2026-11-06T12:02:10Z");
  ingest(store, both("2026-11-06T12:02:00Z", {}, { started: "2026-11-06T12:01:40Z" }));
  check(store, () => online, "c250", now.t);
  assert.deepEqual(openRules(store), []);
  const events = store.serviceEvents("c250");
  assert.deepEqual(events.filter((e) => ["node-reconnected", "process-restarted", "alert-resolved"].includes(e.kind)).map((e) => e.kind).sort(), ["alert-resolved", "alert-resolved", "node-reconnected", "process-restarted"]);
  assert.equal(events.find((e) => e.kind === "process-restarted")!.at, "2026-11-06T12:01:40Z", "the restart at the new start time");
  assert.match(String(events.find((e) => e.kind === "node-reconnected")!.detail.text), /localhost:18446 connected/);
  store.close();
});

test("the executor offline: lost only after the threshold; no fresh sample keeps the sample rules' alerts as they are", () => {
  const now = { t: new Date("2026-11-06T12:00:10Z") };
  const store = lab(now);
  ingest(store, both("2026-11-06T12:00:00Z", { repo: 95 }));
  check(store, () => online, "c250", now.t);
  assert.deepEqual(openRules(store), ["CRIT repo-disk 1", "CRIT repo-disk 2"]);
  const offline = (age: number): ExecutorInfo => ({ online: false, host: "local", ageSeconds: age, reason: `No heartbeat for ${age} seconds` });
  check(store, () => offline(60), "c250", now.t);
  assert.deepEqual(openRules(store), ["CRIT repo-disk 1", "CRIT repo-disk 2"], "a minute offline: not lost yet (2 minutes); the disk alerts stay");
  check(store, () => offline(200), "c250", now.t);
  assert.deepEqual(openRules(store), ["CRIT executor-lost 1", "CRIT executor-lost 2", "CRIT repo-disk 1", "CRIT repo-disk 2"]);
  // Back online with an old sample: the executor alert resolved; no samples once it has been online 3 periods (30 s).
  now.t = new Date("2026-11-06T12:05:00Z");
  check(store, () => online, "c250", now.t);
  assert.deepEqual(openRules(store), ["CRIT repo-disk 1", "CRIT repo-disk 2"], "just back: its first sample is on the way");
  now.t = new Date("2026-11-06T12:06:40Z");
  check(store, () => online, "c250", now.t);
  assert.deepEqual(openRules(store), ["CRIT repo-disk 1", "CRIT repo-disk 2", "WARN no-samples 1", "WARN no-samples 2"], "online for 3 periods, still nothing");
  ingest(store, both("2026-11-06T12:06:35Z", { repo: 85 }));
  check(store, () => online, "c250", now.t);
  assert.deepEqual(openRules(store), ["WARN repo-disk 1", "WARN repo-disk 2"], "80 % is a warning: the open alert changes level");
  assert.equal(store.serviceEvents("c250", { kind: "alert-changed" }).length, 2);
  store.close();
});

test("sustained rules: heap and back pressure need their minutes; back pressure is one alert for the service", () => {
  const now = { t: new Date("2026-11-06T12:00:00Z") };
  const store = lab(now);
  for (let i = 0; i <= 12; i++) {
    const at = new Date(Date.parse("2026-11-06T12:00:00Z") + i * 60_000).toISOString().replace(".000Z", "Z");
    now.t = new Date(Date.parse(at) + 5000);
    ingest(store, both(at, { heap: i >= 2 ? 90 : 50, bp: 2 }));
    check(store, () => online, "c250", now.t);
    if (i === 6) assert.deepEqual(openRules(store), [], "heap high since 12:02 (4 min), back pressure since 12:00 (6 min)");
    if (i === 7) assert.deepEqual(openRules(store), ["WARN heap 1", "WARN heap 2"]);
  }
  assert.deepEqual(openRules(store), ["WARN backpressure *", "WARN heap 1", "WARN heap 2"]);
  ingest(store, both("2026-11-06T12:13:00Z", { heap: 50, bp: 0 }));
  now.t = new Date("2026-11-06T12:13:05Z");
  check(store, () => online, "c250", now.t);
  assert.deepEqual(openRules(store), []);
  assert.deepEqual(heldSince([{ at: "a", v: 1 }, { at: "b", v: 0 }, { at: "c", v: 1 }, { at: "d", v: 1 }], (x) => x.v > 0)?.since, "c");
  store.close();
});

test("cluster-wide rules: no coordinator, versions differ, ERROR bulletins, ZooKeeper; certificates and no monitor certificate", () => {
  const now = { t: new Date("2026-11-06T12:00:10Z") };
  const store = lab(now);
  const errors = Array.from({ length: 10 }, (_, i) => ({ id: i, timestamp: "11:59:0" + (i % 10) + " UTC", level: "ERROR", sourceName: "PutFile", message: `boom ${i}`, nodeAddress: "localhost:18445" }));
  const zk = [1, 2, 3].map((i) => ({ id: 100 + i, timestamp: "11:59:30 UTC", level: "WARNING", sourceName: "Cluster", message: "ConnectionLoss for /nifi/leaders", nodeAddress: "localhost:18445" }));
  ingest(store, [sample(KEY1, "2026-11-06T12:00:00Z", { coordinator: false, bulletins: [...errors, ...zk], certs: "2026-11-20T00:00:00Z" }), sample(KEY2, "2026-11-06T12:00:00Z", { coordinator: false, version: "2.5.1", nifi: "no-certificate" })]);
  check(store, () => online, "c250", now.t);
  assert.deepEqual(openRules(store), ["CRIT no-coordinator *", "WARN cert-expiry 1", "WARN error-bulletins *", "WARN no-certificate 2", "WARN version-mismatch *", "WARN zk-errors *"]);
  // An expired certificate is critical; 7 days or less too.
  store.setServiceThresholds("c250", { certCritDays: 20 }, admin);
  check(store, () => online, "c250", now.t);
  assert.ok(openRules(store).includes("CRIT cert-expiry 1"), "13 days left, critical below 20");
  store.close();
});

test("thresholds: the profile's defaults, overrides from the column, bounds and order checked; the WARN days pushed up opens the certificate alert", () => {
  const now = { t: new Date("2026-11-06T12:00:10Z") };
  const store = lab(now);
  assert.deepEqual(thresholdsOf(store, "c250", "nifi-2.x"), { defaults: NIFI_THRESHOLDS, overrides: {}, effective: NIFI_THRESHOLDS });
  assert.deepEqual(parseThresholds({ thresholds: { certWarnDays: 400, heapPct: 85, executorLostMinutes: null } }, NIFI_THRESHOLDS), { overrides: { certWarnDays: 400 } }, "a default or null is no override");
  const bad = parseThresholds({ thresholds: { certWarnDays: 5, nope: 1, heapPct: 101 } }, NIFI_THRESHOLDS);
  assert.ok("error" in bad && bad.details.length === 3, JSON.stringify(bad));
  assert.ok("error" in parseThresholds({}, NIFI_THRESHOLDS));
  ingest(store, both("2026-11-06T12:00:00Z", { certs: "2027-11-06T00:00:00Z" }));
  checkAll(store, () => online, now.t);
  assert.deepEqual(openRules(store), []);
  store.setServiceThresholds("c250", { certWarnDays: 400 }, admin);
  check(store, () => online, "c250", now.t);
  assert.deepEqual(openRules(store), ["WARN cert-expiry 1", "WARN cert-expiry 2"]);
  assert.equal(serviceStatus(store, () => online, "c250", now.t)!.summary.certDays.warn, 400);
  store.setServiceThresholds("c250", {}, admin);
  check(store, () => online, "c250", now.t);
  assert.deepEqual(openRules(store), []);
  assert.equal(store.serviceEvents("c250", { kind: "thresholds" }).length, 2);
  store.close();
});
