// S37 step 4 (pages-rethink §4.3): the investigation's evidence: bulletins by component with a NiFi link, log patterns
// new or surging against the day before, metrics off their baseline, restarts (timeline and samples), out of memory,
// the changes of the 24 hours before, the window's limits.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExecutorInfo } from "../src/server/handoff.ts";
import { investigate, InvestigateError, nifiLink } from "../src/server/services/investigate.ts";
import { ingest } from "../src/server/services/metrics.ts";
import { check } from "../src/server/services/rules.ts";
import type { ServiceSample } from "../src/server/services/watch.ts";
import { Store } from "../src/server/store.ts";

const admin = { id: "admin", via: "cli" } as const;
const node = (installDir: string, https: number) => ({ host: "local", installDir, serviceUser: "ferenc", startEnvironment: null, ports: { https }, nodeAddress: "localhost", discovery: null });
const KEY1 = "local:/lab/c250-1", KEY2 = "local:/lab/c250-2";
const online: ExecutorInfo = { online: true, host: "local", ageSeconds: 5, heartbeat: { collector: { seconds: 30 } } as never };
const exec = () => online;

type More = { heap?: number; startedAt?: string; patterns?: Record<string, unknown>[]; bulletins?: Record<string, unknown>[] };
const diag = (port: number, heap: number) => ({ address: "localhost", apiPort: port, nodeId: `id-${port}`, heap: { usedBytes: heap, maxBytes: 100 }, totalThreads: 1, gc: [], repositories: { flowfile: [], content: [], provenance: [] } });
function sample(member: string, at: string, m: More = {}): ServiceSample {
  const own = member === KEY1 ? 18445 : 18446;
  return {
    service: "c250", member, at,
    process: { running: true, pid: own, startedAt: m.startedAt ?? "2026-11-01T00:00:00Z" },
    nifi: {
      state: "ok", about: { version: "2.5.0", timezone: "UTC" }, selfNodeId: `id-${own}`,
      diagnostics: { nodes: [diag(18445, member === KEY1 ? m.heap ?? 50 : 50), diag(18446, member === KEY2 ? m.heap ?? 50 : 50)] },
      cluster: { nodes: [{ address: "localhost", apiPort: 18445, nodeId: "id-18445", status: "CONNECTED", roles: ["Cluster Coordinator"] }, { address: "localhost", apiPort: 18446, nodeId: "id-18446", status: "CONNECTED", roles: [] }] },
      backpressure: { connections: 3, full: 0, maxPercent: 10 }, bulletins: m.bulletins ?? [],
    },
    ...(m.patterns ? { logs: { patterns: m.patterns } } : {}),
  } as ServiceSample;
}
const pattern = (key: string, level: string, count: number, at: string, template: string, extra: Record<string, unknown> = {}) =>
  ({ key, level, count, template, firstAt: at, lastAt: at, first: `${at} ${level} ${template} (first)`, last: `${at} ${level} ${template} (last)`, logger: "org.apache.nifi.processors.standard.InvokeHTTP", ...extra });

function lab(now: { t: Date }) {
  const store = new Store(":memory:", () => now.t);
  store.addCluster({ kind: "cluster", id: "c250", service: "nifi", profile: "nifi-2.x", version: "2.5.0", webUrl: "https://localhost:18445/nifi", zookeeper: "zk:2181", zookeeperRoot: "/c250", nodes: [node("/lab/c250-1", 18445), node("/lab/c250-2", 18446)] }, "uat", admin);
  return store;
}

/** A day before 12:00–13:00 (baseline) and the window itself, a sample a minute for both nodes. */
function fill(store: Store, now: { t: Date }, window: (min: number) => [More, More], baseline: (min: number) => [More, More]) {
  for (const [day, f] of [["2026-11-05", baseline], ["2026-11-06", window]] as const) {
    for (let min = 0; min < 60; min += 1) {
      const at = `${day}T12:${String(min).padStart(2, "0")}:00Z`;
      now.t = new Date(Date.parse(at) + 5_000);
      const [a, b] = f(min);
      ingest(store, [sample(KEY1, at, a), sample(KEY2, at, b)]);
      check(store, exec, "c250", now.t);
    }
  }
  now.t = new Date("2026-11-06T13:00:00Z");
}

test("a processor error, a surging and a new log pattern, the heap off its baseline, a restart: each on its card", () => {
  const now = { t: new Date("2026-11-05T12:00:00Z") };
  const store = lab(now);
  store.addServiceEvent({ service: "c250", member: null, at: "2026-11-06T02:00:00Z", kind: "config-saved", detail: { text: "Configuration revision 2 saved", by: "admin" } });
  store.addServiceEvent({ service: "c250", member: null, at: "2026-11-04T02:00:00Z", kind: "config-saved", detail: { text: "too old", by: "admin" } });
  fill(store, now,
    (min) => [
      {
        heap: min >= 30 ? 92 : 55, startedAt: min >= 40 ? "2026-11-06T12:39:30Z" : undefined,
        patterns: min % 10 === 0 ? [pattern("aaaaaaaa", "WARN", 4, `2026-11-06T12:${String(min).padStart(2, "0")}:00Z`, "Connection refused to {}"), ...(min === 20 ? [pattern("bbbbbbbb", "ERROR", 3, "2026-11-06T12:20:00Z", "Failed to process session due to {}", { exception: "java.net.ConnectException" })] : [])] : [],
        bulletins: min === 20 ? [{ id: 7, timestamp: "12:19:58 UTC", nodeAddress: "localhost:18445", level: "ERROR", sourceName: "Call API", sourceType: "InvokeHTTP", sourceId: "proc-1", groupId: "pg-1", message: "InvokeHTTP[id=proc-1] Routing to Failure due to java.net.ConnectException" },
          { id: 8, timestamp: "12:19:59 UTC", nodeAddress: "localhost:18445", level: "ERROR", sourceName: "Call API", sourceType: "InvokeHTTP", sourceId: "proc-1", groupId: "pg-1", message: "InvokeHTTP[id=proc-1] second" }] : [],
      },
      {},
    ],
    (min) => [{ heap: 50, patterns: min === 0 ? [pattern("aaaaaaaa", "WARN", 2, "2026-11-05T12:00:00Z", "Connection refused to {}")] : [] }, {}]);

  const r = investigate(store, exec, "c250", { from: "2026-11-06T12:00:00Z", to: "2026-11-06T13:00:00Z" }, now.t)!;
  const card = (k: string) => r.cards.find((c) => c.kind === k)!;
  assert.equal(r.baseline.from, "2026-11-05T12:00:00Z");

  const b = card("bulletins");
  assert.equal(b.weight, "high");
  assert.equal(b.items.length, 1);
  assert.match(b.items[0]!.text, /Call API \(InvokeHTTP\): 2 ERROR/);
  assert.equal(b.items[0]!.nifiUrl, "https://localhost:18445/nifi/?processGroupId=pg-1&componentIds=proc-1");
  assert.equal(b.items[0]!.raw!.length, 2);

  const l = card("logs");
  assert.equal(l.weight, "high");
  assert.deepEqual(l.items.map((x) => [x.detail!.pattern, x.detail!.new, x.detail!.window, x.detail!.dayBefore]), [["bbbbbbbb", true, 3, 0], ["aaaaaaaa", false, 24, 2]]);
  assert.ok(l.items[0]!.raw!.some((x) => x.includes("(first)")));

  const m = card("metrics");
  assert.equal(m.items[0]!.detail!.field, "heapPct");
  assert.equal(m.items[0]!.member, KEY1);
  assert.equal(m.items[0]!.curves!.series.length, 2);
  assert.ok(!m.items.some((x) => x.member === KEY2), "the other node did not change");

  const p = card("process");
  assert.equal(p.weight, "high");
  assert.ok(p.items.some((x) => x.detail!.kind === "process-restarted" && x.member === KEY1 && x.at === "2026-11-06T12:39:30Z"), JSON.stringify(p.items));

  const ch = card("changes");
  assert.deepEqual(ch.items.map((x) => x.text), ["config-saved: Configuration revision 2 saved (by admin)"]);

  // One node only; focus puts its card first; compact drops the curves.
  const one = investigate(store, exec, "c250", { member: KEY2, from: "2026-11-06T12:00:00Z", to: "2026-11-06T13:00:00Z", focus: "heap", compact: true }, now.t)!;
  assert.equal(one.cards[0]!.kind, "metrics");
  assert.equal(one.cards.find((c) => c.kind === "bulletins")!.items.length, 0);
  assert.equal(one.cards.find((c) => c.kind === "process")!.weight, "none");
  const all = investigate(store, exec, "c250", { from: "2026-11-06T12:00:00Z", to: "2026-11-06T13:00:00Z", compact: true }, now.t)!;
  assert.equal(all.cards.find((c) => c.kind === "metrics")!.items[0]!.curves, undefined);
  store.close();
});

test("restarts the timeline missed come from the samples; out of memory in the log weighs high", () => {
  const now = { t: new Date("2026-11-06T12:00:00Z") };
  const store = lab(now);
  // No check(): no timeline event, only the samples' start time moves.
  ingest(store, [sample(KEY1, "2026-11-06T12:00:00Z"), sample(KEY1, "2026-11-06T12:30:00Z", { startedAt: "2026-11-06T12:29:00Z", patterns: [pattern("cccccccc", "ERROR", 1, "2026-11-06T12:28:00Z", "Uncaught exception", { exception: "java.lang.OutOfMemoryError" })] })]);
  now.t = new Date("2026-11-06T12:45:00Z");
  const p = investigate(store, exec, "c250", { from: "2026-11-06T12:15:00Z" }, now.t)!.cards.find((c) => c.kind === "process")!;
  assert.equal(p.weight, "high");
  assert.deepEqual(p.items.map((x) => x.detail!.kind).sort(), ["oom", "process-started"]);
  store.close();
});

test("the window: at most 24 hours, from before to, a known member; nothing for an unknown service", () => {
  const now = { t: new Date("2026-11-06T12:00:00Z") };
  const store = lab(now);
  const err = (ask: Parameters<typeof investigate>[3]) => { try { investigate(store, exec, "c250", ask, now.t); return null; } catch (e) { return (e as InvestigateError).code; } };
  assert.equal(err({ from: "2026-11-05T11:00:00Z" }), "investigate/too-long");
  assert.equal(err({ from: "2026-11-06T12:00:00Z", to: "2026-11-06T11:00:00Z" }), "investigate/bad-window");
  assert.equal(err({ from: "yesterday" }), "investigate/bad-time");
  assert.equal(err({ member: "nope" }), "investigate/unknown-member");
  const r = investigate(store, exec, "c250", {}, now.t)!;
  assert.equal(r.from, "2026-11-06T11:00:00Z");
  assert.ok(r.notes.some((n) => n.includes("No samples in the window")));
  assert.equal(investigate(store, exec, "nope", {}, now.t), undefined);
  store.close();
});

test("NiFi links: /nifi added when missing, the component selected", () => {
  assert.equal(nifiLink("https://n1:8443", "g", "c"), "https://n1:8443/nifi/?processGroupId=g&componentIds=c");
  assert.equal(nifiLink("https://n1:8443/nifi", "g"), "https://n1:8443/nifi/?processGroupId=g");
  assert.equal(nifiLink("https://n1:8443/nifi/?x=1", undefined, "c"), "https://n1:8443/nifi/?componentIds=c");
  assert.equal(nifiLink(null, "g", "c"), undefined);
  assert.equal(nifiLink("not a url"), undefined);
});
