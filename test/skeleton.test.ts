// pages-rethink §10.2 step 1: flow counts and topology snapshots in the store, and the business skeleton (A7): the four
// exceptions and the S2S pairing across services.

import assert from "node:assert/strict";
import { test } from "node:test";
import { bucketOfWindow, flowRows, ingestFlow, pruneFlow, topologyFingerprint, type Topology, type TopologyFragment } from "../src/server/services/flowcounts.ts";
import { addressOf, identify, skeletonOf, type SkeletonInput } from "../src/server/services/skeleton.ts";
import { ingest } from "../src/server/services/metrics.ts";
import { watchList, type ServiceSample } from "../src/server/services/watch.ts";
import { Store } from "../src/server/store.ts";

const admin = { id: "admin", via: "cli" } as const;
const NOW = new Date("2026-11-19T12:00:00Z");
const frag = (key: string, more: Partial<TopologyFragment> = {}): TopologyFragment =>
  ({ key, processors: 1, names: [key], inputs: [], outputs: [], remoteIn: [], s2sOut: [], starts: 1, ...more });
const topo = (root: string, groups: Topology["groups"], more: Partial<Topology> = {}): Topology =>
  ({ root: { id: root, name: "NiFi Flow" }, groups, links: [], s2sIn: [], s2sOut: [], ...more });
const link = (from: string, fromFrag: string | null, to: string, toFrag: string | null) =>
  ({ connection: `${from}-${to}`, from: { group: from, fragment: fromFrag, port: "out" }, to: { group: to, fragment: toFrag, port: "in" } });
const busy = (...groups: string[]) => new Map(groups.map((g) => [g, { total: 5, first: "2026-11-01T00:00:00Z" }]));
const svc = (id: string, topology: Topology | null, traffic = new Map<string, { total: number; first: string }>(), addresses: string[] = []): SkeletonInput =>
  ({ id, addresses, topology, traffic });

test("skeleton: one root group = one business; ① A only to B merges (A first); ③ shared; ④ idle", () => {
  const t = topo("root", [
    { id: "A", name: "Ingest", root: false, fragments: [frag("a", { outputs: ["out"] })] },
    { id: "B", name: "Load", root: false, fragments: [frag("b", { inputs: ["in"], starts: 0 })] },
    { id: "P", name: "Partner", root: false, fragments: [frag("p", { outputs: ["out"] })] },
    { id: "Q", name: "Other", root: false, fragments: [frag("q", { outputs: ["out"] })] },
    { id: "S", name: "Archive", root: false, fragments: [frag("s", { inputs: ["in"], starts: 0 })] },
    { id: "Z", name: "Old", root: false, fragments: [frag("z")] },
    { id: "E", name: "Empty", root: false, fragments: [] },
  ], { links: [link("A", "a", "B", "b"), link("P", "p", "S", "s"), link("Q", "q", "S", "s")] });
  const traffic = new Map([...busy("A", "B", "P", "Q", "S"), ["Z", { total: 0, first: "2026-11-01T00:00:00Z" }]]);
  const sk = identify([svc("n1", t, traffic)], NOW);
  const flows = Object.fromEntries(sk.flows.map((f) => [f.segments.map((s) => s.group.name).join(" > "), f]));
  assert.deepEqual(Object.keys(flows).sort(), ["Ingest > Load", "Old", "Other", "Partner"]);
  assert.deepEqual(flows["Ingest > Load"].exceptions, ["merge"]);
  assert.match(flows["Ingest > Load"].reason!, /Ingest 的输出只接到 Load/);
  assert.equal(flows["Ingest > Load"].key, "n1/A");
  assert.deepEqual(sk.shared.map((s) => [s.group.name, s.feeders]), [["Archive", ["n1/P", "n1/Q"]]], "③ no start of its own, two feeders");
  assert.deepEqual(flows.Old.exceptions, ["idle"], "④ counted for 7+ days, nothing");
  assert.deepEqual(flows.Partner.exceptions, [], "a feeder of a shared step stays its own business");
  assert.deepEqual(sk.empty.map((e) => e.group.name), ["Empty"]);
  assert.deepEqual(sk.questions, []);

  // ④ needs 7 days of counts: a quiet group counted 2 days, or not counted at all, is not idle.
  const short = identify([svc("n1", topo("root", [{ id: "Z", name: "Old", root: false, fragments: [frag("z")] }]), new Map([["Z", { total: 0, first: "2026-11-17T12:00:00Z" }]]))], NOW);
  assert.deepEqual([short.flows[0].exceptions, short.flows[0].segments[0].traffic], [[], "none-short"]);
  const none = identify([svc("n1", topo("root", [{ id: "Z", name: "Old", root: false, fragments: [frag("z")] }]))], NOW);
  assert.equal(none.flows[0].segments[0].traffic, "unknown");
});

test("skeleton: ② a group's unconnected pieces split and are asked about; the root canvas' pieces split without asking", () => {
  const t = topo("root", [
    { id: "root", name: "NiFi Flow", root: true, fragments: [frag("r1"), frag("r2")] },
    { id: "M", name: "Mixed", root: false, fragments: [frag("m1", { names: ["GetFile"] }), frag("m2", { names: ["ListenHTTP"] })] },
  ]);
  const sk = identify([svc("n1", t, busy("root", "M"))], NOW);
  assert.deepEqual(sk.flows.map((f) => [f.key, f.exceptions]), [["n1/M/m1", ["split"]], ["n1/M/m2", ["split"]], ["n1/root/r1", []], ["n1/root/r2", []]]);
  assert.match(sk.flows[0].reason!, /Mixed 里互不相连的一片（GetFile）/);
  assert.deepEqual(sk.questions.map((q) => [q.kind, q.group]), [["split", "M"]]);
  // A link into one piece of a split group goes to that piece only.
  const linked = identify([svc("n1", topo("root", [
    { id: "A", name: "A", root: false, fragments: [frag("a")] },
    { id: "M", name: "Mixed", root: false, fragments: [frag("m1", { starts: 0 }), frag("m2")] },
  ], { links: [link("A", "a", "M", "m1")] }))], NOW);
  assert.deepEqual(linked.flows.map((f) => f.segments.map((s) => s.id)), [["n1/A", "n1/M/m1"], ["n1/M/m2"]]);
});

test("skeleton: several feeders but a start of its own, and a fan-out: not merged, asked", () => {
  const t = topo("root", [
    { id: "A", name: "A", root: false, fragments: [frag("a")] },
    { id: "B", name: "B", root: false, fragments: [frag("b")] },
    { id: "C", name: "C", root: false, fragments: [frag("c", { starts: 1 })] },
    { id: "D", name: "D", root: false, fragments: [frag("d", { starts: 0 })] },
  ], { links: [link("A", "a", "C", "c"), link("B", "b", "C", "c"), link("B", "b", "D", "d")] });
  const sk = identify([svc("n1", t)], NOW);
  assert.deepEqual(sk.shared, []);
  assert.equal(sk.flows.length, 4);
  assert.deepEqual(sk.questions.map((q) => [q.kind, q.group]).sort(), [["fan-out", "B"], ["multi-feed", "C"]]);
});

test("skeleton across services: RPG target address + port name pairs two groups as two segments; by name alone it is asked; unpaired said", () => {
  // n112: root canvas piece gen -> rename -> RPG to c250's "from-n112" (the lab); c250: remote input port -> load.
  const n112 = topo("r112", [
    { id: "r112", name: "NiFi Flow", root: true, fragments: [frag("g", { names: ["n112 gen", "n112 rename"], s2sOut: ["https://localhost:18445/nifi#from-n112"] })] },
    { id: "X", name: "Exports", root: false, fragments: [frag("x", { s2sOut: ["https://elsewhere:8443/nifi#drop"] })] },
  ], { s2sOut: [
    { ref: "https://localhost:18445/nifi#from-n112", name: "from-n112", targets: ["https://localhost:18445/nifi"], group: "r112", fragment: "g" },
    { ref: "https://elsewhere:8443/nifi#drop", name: "drop", targets: ["https://elsewhere:8443/nifi"], group: "X", fragment: "x" },
  ] });
  const c250 = topo("r250", [
    { id: "r250", name: "NiFi Flow", root: true, fragments: [frag("p", { names: ["c250 load"], remoteIn: ["from-n112"], starts: 1 }), frag("e", { names: ["e2e gen"] })] },
  ], { s2sIn: [{ id: "port", name: "from-n112", group: "r250", fragment: "p" }] });
  const both = [svc("n112", n112, busy("r112")), svc("c250", c250, busy("r250"), ["localhost:18445", "localhost:18446"])];
  const sk = identify(both, NOW);
  const cross = sk.flows.find((f) => f.segments.length === 2)!;
  assert.deepEqual(cross.segments.map((s) => [s.service, s.names[0]]), [["n112", "n112 gen"], ["c250", "c250 load"]]);
  assert.deepEqual(cross.exceptions, ["cross-service"]);
  assert.match(cross.reason!, /n112 的 NiFi Flow 经 S2S 送到 c250 的 NiFi Flow/);
  assert.deepEqual(sk.edges.filter((e) => e.kind === "s2s"), [{ from: "n112/r112/g", to: "c250/r250/p", kind: "s2s", match: "address", port: "from-n112" }]);
  assert.deepEqual(sk.questions.map((q) => q.kind), ["s2s-unpaired"], "the RPG to an unmanaged NiFi");
  assert.equal(sk.flows.length, 3, "n112+c250, Exports, c250's other piece");

  // The address does not match (another host name): paired by the port name, asked once.
  const byName = identify([both[0], { ...both[1], addresses: ["nifi-a:18445"] }], NOW);
  assert.deepEqual(byName.edges.filter((e) => e.kind === "s2s").map((e) => e.match), ["name"]);
  assert.deepEqual(byName.questions.map((q) => q.kind).sort(), ["s2s-name-only", "s2s-unpaired"]);
  // The receiving side is fed by two services through the S2S port and has no other start: shared.
  const other = topo("r9", [{ id: "r9", name: "NiFi Flow", root: true, fragments: [frag("o", { s2sOut: ["https://localhost:18445/nifi#from-n112"] })] }],
    { s2sOut: [{ ref: "https://localhost:18445/nifi#from-n112", name: "from-n112", targets: ["https://localhost:18445/nifi"], group: "r9", fragment: "o" }] });
  const two = identify([...both, svc("n9", other)], NOW);
  assert.deepEqual(two.shared.map((s) => [s.id, s.feeders]), [["c250/r250/p", ["n112/r112/g", "n9/r9/o"]]]);
  assert.equal(addressOf("https://Node1.lab/nifi"), "node1.lab:443");
});

test("flow counts and topology from samples: buckets, sample over history, topology only on change, 30 days, the watch flag", () => {
  let now = NOW;
  const store = new Store(":memory:", () => now);
  const member = { host: "local", installDir: "/lab/n112", serviceUser: "ferenc", startEnvironment: null, ports: { https: 18443 }, nodeAddress: null, discovery: null };
  store.addStandalone({ kind: "standalone", id: "n112", service: "nifi", profile: "nifi-1.x", version: "1.12.1", webUrl: null, member } as never, "uat", admin);
  const node = (d: string, https: number) => ({ host: "local", installDir: d, serviceUser: "ferenc", startEnvironment: null, ports: { https }, nodeAddress: "localhost", discovery: null });
  store.addCluster({ kind: "cluster", id: "c250", service: "nifi", profile: "nifi-2.x", version: "2.5.0", webUrl: null, zookeeper: "zk:2181", zookeeperRoot: "/c250", nodes: [node("/lab/c250-1", 18445), node("/lab/c250-2", 18446)] } as never, "uat", admin);
  const key = watchList(store, "local").find((w) => w.service === "n112")!.member;
  assert.equal(watchList(store, "local").every((w) => w.flowHistory), true, "no counts yet: read NiFi's history");

  assert.equal(bucketOfWindow(Date.parse("2026-11-19T12:03:10Z")), "2026-11-19T12:00:00Z", "the window 11:58–12:03 is the 12:00 bucket");
  assert.equal(bucketOfWindow(Date.parse("2026-11-19T12:00:20Z")), "2026-11-19T11:55:00Z", "history: the first snapshot after 12:00 covers 11:55–12:00");
  const t112 = topo("r112", [{ id: "r112", name: "NiFi Flow", root: true, fragments: [frag("g", { s2sOut: ["https://localhost:18445/nifi#from-n112"] })] }],
    { s2sOut: [{ ref: "https://localhost:18445/nifi#from-n112", name: "from-n112", targets: ["https://localhost:18445/nifi"], group: "r112", fragment: "g" }] });
  const flowSample = (at: string, flowCounts: Record<string, unknown>): ServiceSample =>
    ({ service: "n112", member: key, at, process: { running: true }, nifi: { state: "ok", flowCounts } } as ServiceSample);
  ingest(store, [flowSample("2026-11-19T12:03:10Z", {
    at: "2026-11-19T12:03:10Z", topology: t112,
    counts: [{ kind: "group", ref: "r112", name: "NiFi Flow", flowFilesIn: 4, flowFilesOut: 3, bytesIn: 40, bytesOut: 30 },
             { kind: "s2s-out", ref: "https://localhost:18445/nifi#from-n112", name: "from-n112", flowFilesIn: 3, flowFilesOut: 3, bytesIn: 30, bytesOut: 30 }],
    history: [{ kind: "group", ref: "r112", name: "NiFi Flow", points: [[Date.parse("2026-11-19T12:05:20Z"), 9, 9, 9, 9], [Date.parse("2026-11-19T11:00:10Z"), 1, 2, 3, 4]] }],
  })]);
  const rows = store.flowCounts("n112", "2026-11-19T00:00:00Z", "2026-11-20T00:00:00Z");
  assert.deepEqual(rows.map((r) => [r.bucket, r.kind, r.flowfilesIn, r.source]), [
    ["2026-11-19T10:55:00Z", "group", 1, "nifi-history"],
    ["2026-11-19T12:00:00Z", "group", 4, "sample"],
    ["2026-11-19T12:00:00Z", "s2s-out", 3, "sample"],
  ], "history does not overwrite a sampled bucket");
  assert.equal(watchList(store, "local").find((w) => w.service === "n112")!.flowHistory, false);
  assert.equal(watchList(store, "local").find((w) => w.service === "c250")!.flowHistory, true);
  const raw = store.latestServiceSamples("n112");
  assert.equal(raw.length, 1);
  assert.equal(JSON.stringify(raw).includes("flowCounts"), false, "the raw sample keeps no flow counts");

  // The same topology again (keys in another order): no new snapshot; a changed one: a new snapshot.
  const reordered = JSON.parse(JSON.stringify({ s2sOut: t112.s2sOut, s2sIn: [], links: [], groups: t112.groups, root: t112.root }));
  assert.equal(ingestFlow(store, flowSample("2026-11-19T12:08:10Z", { at: "2026-11-19T12:08:10Z", topology: reordered, counts: [] })).topology, false);
  const changed = { ...t112, groups: [{ ...t112.groups[0], fragments: [frag("g2")] }] };
  assert.equal(ingestFlow(store, flowSample("2026-11-19T12:13:10Z", { at: "2026-11-19T12:13:10Z", topology: changed, counts: [] })).topology, true);
  assert.equal(store.topologies("n112", "").length, 2);
  assert.deepEqual(flowRows("n112", { at: "nonsense", counts: [{ kind: "group", ref: "x" }], history: [{ kind: "bad", ref: "y", points: [[1, 1]] }] }), []);

  // c250's topology, then the skeleton from the store: n112 -> c250 by the node address + port.
  const t250 = topo("r250", [{ id: "r250", name: "NiFi Flow", root: true, fragments: [frag("p", { remoteIn: ["from-n112"] })] }],
    { s2sIn: [{ id: "port", name: "from-n112", group: "r250", fragment: "p" }] });
  store.putTopology("c250", "2026-11-19T12:00:00Z", "h", t250);
  store.putTopology("n112", "2026-11-19T12:20:00Z", "h3", t112);
  const sk = skeletonOf(store, NOW);
  assert.deepEqual(sk.flows.filter((f) => f.segments.length === 2).map((f) => f.segments.map((s) => s.service)), [["n112", "c250"]]);
  assert.deepEqual(sk.edges.map((e) => e.match), ["address"]);

  // 30 days: counts go, each service's newest topology stays.
  now = new Date("2026-12-25T00:00:00Z");
  const pruned = pruneFlow(store, now);
  assert.deepEqual(pruned, { counts: 3, topologies: 2 });
  assert.equal(store.latestTopology("n112")?.hash, "h3");
  assert.ok(store.latestTopology("c250"));
});

test("skeleton: edges to a shared step (errors, audit) do not stop the merge or the S2S pair", () => {
  // A -> B, and both A and B also send to the shared error handler E (fed by A, B and C); C is another business.
  const t = topo("root", [
    { id: "A", name: "Intake", root: false, fragments: [frag("a", { outputs: ["out", "errors"] })] },
    { id: "B", name: "Route", root: false, fragments: [frag("b", { inputs: ["in"], outputs: ["errors"], starts: 0 })] },
    { id: "C", name: "Other", root: false, fragments: [frag("c", { outputs: ["errors"] })] },
    { id: "E", name: "Errors", root: false, fragments: [frag("e", { inputs: ["in"], starts: 0 })] },
  ], { links: [link("A", "a", "B", "b"), link("A", "a", "E", "e"), link("B", "b", "E", "e"), link("C", "c", "E", "e")] });
  const sk = identify([svc("n1", t, busy("A", "B", "C", "E"))], NOW);
  assert.deepEqual(sk.flows.map((f) => f.segments.map((s) => s.group.name).join(" > ")).sort(), ["Intake > Route", "Other"]);
  assert.deepEqual(sk.shared.map((s) => [s.group.name, s.feeders]), [["Errors", ["n1/A", "n1/C"]]]);
  assert.deepEqual(sk.questions, [], "no fan-out question for the error output");
});

test("skeleton: an input port on the root canvas belongs to the groups it leads into, not to the root canvas' pieces", () => {
  // n2's root canvas: a piece of its own (gen), and two remote input ports in no piece, each linked straight into a group;
  // "both" leads into two groups (a fan-out). n1 sends to all three ports.
  const rpg = (name: string) => ({ ref: `https://h2:8443/nifi#${name}`, name, targets: ["https://h2:8443/nifi"], group: "S", fragment: "s" });
  const n1 = topo("r1", [{ id: "S", name: "Send", root: false, fragments: [frag("s")] }], { s2sOut: [rpg("to-a"), rpg("both")] });
  const rootLink = (port: string, to: string) => ({ connection: `${port}-${to}`, from: { group: "r2", fragment: null, port }, to: { group: to, fragment: to.toLowerCase(), port: "in" } });
  const n2 = topo("r2", [
    { id: "r2", name: "NiFi Flow", root: true, fragments: [frag("gen")] },
    { id: "A", name: "Apply", root: false, fragments: [frag("a", { inputs: ["in"], starts: 0 })] },
    { id: "B", name: "Book", root: false, fragments: [frag("b", { inputs: ["in"], starts: 0 })] },
  ], { s2sIn: [{ id: "p1", name: "to-a", group: "r2", fragment: null }, { id: "p2", name: "both", group: "r2", fragment: null }],
    links: [rootLink("to-a", "A"), rootLink("both", "A"), rootLink("both", "B")] });
  const sk = identify([svc("n1", n1, busy("S")), svc("n2", n2, busy("r2", "A", "B"), ["h2:8443"])], NOW);
  assert.deepEqual(sk.edges.map((e) => [e.from, e.to, e.kind, e.port]), [["n1/S", "n2/A", "s2s", "to-a"], ["n1/S", "n2/B", "s2s", "both"]]);
  assert.equal(sk.edges.some((e) => e.from.startsWith("n2/r2") || e.to.startsWith("n2/r2")), false, "the root canvas' own piece is not in the hand-over");
  assert.deepEqual(sk.questions.map((q) => [q.kind, q.service, q.group]), [["fan-out", "n1", "S"]], "the fan-out is the sender's, as for any port leading to two units");
  assert.ok(sk.flows.some((f) => f.key === "n2/r2/gen" && f.segments.length === 1), "the root piece stays a business of its own");
});

test("S39 step 1: the watch's registered groups; a cluster's groups read by one node (§7.7 question 6); scope in the fingerprint", () => {
  const store = new Store(":memory:", () => NOW);
  const member = { host: "local", installDir: "/lab/n112", serviceUser: "ferenc", startEnvironment: null, ports: { https: 18443 }, nodeAddress: null, discovery: null };
  store.addStandalone({ kind: "standalone", id: "n112", service: "nifi", profile: "nifi-1.x", version: "1.12.1", webUrl: null, member } as never, "uat", admin);
  const node = (d: string, https: number) => ({ host: "local", installDir: d, serviceUser: "ferenc", startEnvironment: null, ports: { https }, nodeAddress: "localhost", discovery: null });
  store.addCluster({ kind: "cluster", id: "c250", service: "nifi", profile: "nifi-2.x", version: "2.5.0", webUrl: null, zookeeper: "zk:2181", zookeeperRoot: "/c250", nodes: [node("/lab/c250-1", 18445), node("/lab/c250-2", 18446)] } as never, "uat", admin);
  assert.equal(watchList(store, "local").some((w) => "groups" in w), false, "nothing registered: no key, the whole canvas as before");
  const groups = (s: string) => (s === "c250" ? ["g-1", "g-2"] : s === "n112" ? [] : undefined);
  const of = (now = NOW) => Object.fromEntries(watchList(store, "local", groups, now.getTime()).map((w) => [w.member.split(":").pop(), w.groups]));
  assert.deepEqual(of(), { "/lab/n112": [], "/lab/c250-1": [{ id: "g-1" }, { id: "g-2" }], "/lab/c250-2": [] }, "no beat yet: the first node");
  store.setHeartbeat("local", { version: "0.9.7", kinds: ["nifi-groups@1", "flow-groups@1"], protocols: [2] }, "service");
  const second = watchList(store, "local").find((w) => w.member.endsWith("/lab/c250-2"))!.member;
  ingest(store, [{ service: "c250", member: second, at: NOW.toISOString(), process: { running: true }, nifi: { state: "ok" } } as ServiceSample]);
  assert.deepEqual([of()["/lab/c250-1"], of()["/lab/c250-2"]], [[], [{ id: "g-1" }, { id: "g-2" }]], "the first node whose NiFi answered");
  assert.deepEqual(of(new Date(NOW.getTime() + 60_000))["/lab/c250-1"], [{ id: "g-1" }, { id: "g-2" }], "the beat is old: back to the first node");

  const canvas = topo("r", [{ id: "A", name: "A", root: false, fragments: [frag("a")] }]);
  const scoped: Topology = { ...canvas, scope: "groups", missing: [], groups: [{ ...canvas.groups[0], parent: "P", path: [{ id: "r", name: "NiFi Flow" }, { id: "P", name: "P" }] }], neighbors: [] };
  assert.equal(topologyFingerprint(canvas), topologyFingerprint({ ...canvas }), "the whole canvas' fingerprint is unchanged");
  assert.notEqual(topologyFingerprint(scoped), topologyFingerprint(canvas));
  assert.notEqual(topologyFingerprint({ ...scoped, groups: [{ ...scoped.groups[0], parent: "Q" }] }), topologyFingerprint(scoped), "moved to another parent");
});
