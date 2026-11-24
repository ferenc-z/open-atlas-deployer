// S39 step 3: the chain of one registration (services/chain.ts): registered groups at any depth, links and the one hop
// out, S2S, shared modules, schedules, told hand-overs, gaps.

import assert from "node:assert/strict";
import { test } from "node:test";
import { chain, sendersOf, type ChainInput, type ChainModule, type Preview } from "../src/server/services/chain.ts";
import type { Topology, TopologyFragment, TopologyNeighbor } from "../src/server/services/flowcounts.ts";
import { RegError } from "../src/server/services/registration.ts";

const ROOT = { id: "root", name: "NiFi Flow" };
const frag = (key: string, more: Partial<TopologyFragment> = {}): TopologyFragment =>
  ({ key, processors: 1, names: [key], inputs: [], outputs: [], remoteIn: [], s2sOut: [], starts: 0, ...more });
/** A registered group under parent P (path root > P). */
const grp = (id: string, name: string, frags: TopologyFragment[], parent = "P") =>
  ({ id, name, root: false, parent, path: [ROOT, { id: parent, name: `Parent ${parent}` }], fragments: frags });
const scoped = (groups: Topology["groups"], more: Partial<Topology> = {}): Topology =>
  ({ scope: "groups", root: ROOT, groups, links: [], s2sIn: [], s2sOut: [], ends: [], neighbors: [], missing: [], ...more });
const nbr = (group: string, side: "in" | "out", port: string, other: TopologyNeighbor["other"]): TopologyNeighbor =>
  ({ group, connection: `${group}-${side}-${port}`, side, port: { id: `${group}:${port}`, name: port }, relationships: [], other });
const inp = (groups: [string, string][], services: ChainInput["services"], more: Partial<ChainInput> = {}): ChainInput =>
  ({ name: "biz", groups: groups.map(([service, group]) => ({ service, group })), services, ...more });
const names = (p: Preview) => p.layers.map((l) => l.map((id) => p.segments.find((s) => s.id === id)!.group.name));
const edge = (p: Preview, kind: string) => p.edges.filter((e) => e.kind === kind).map((e) => `${p.segments.find((s) => s.id === e.from)!.group.name}>${p.segments.find((s) => s.id === e.to)!.group.name}`);

test("chain: siblings deep in the canvas joined by the parent's link; the one hop out to unregistered groups and processors is a gap", () => {
  const t = scoped([
    grp("A", "Ingest", [frag("a", { outputs: ["out", "err"], starts: 2 })]),
    grp("B", "Load", [frag("b", { inputs: ["in"], outputs: ["done"] })]),
  ], {
    links: [{ connection: "c1", from: { group: "A", fragment: "a", port: "out" }, to: { group: "B", fragment: "b", port: "in" } }],
    neighbors: [
      nbr("A", "out", "out", { kind: "group", id: "B", name: "Load", group: "P", port: { id: "B:in", name: "in" }, registered: true }),
      nbr("A", "out", "err", { kind: "group", id: "X", name: "Errors", group: "P", port: { id: "X:in", name: "in" } }),
      nbr("B", "out", "done", { kind: "processor", id: "p9", name: "LogAttribute", group: "P" }),
    ],
    ends: [{ id: "e1", name: "PutFile", type: "org.apache.nifi.processors.standard.PutFile", group: "B", fragment: "b", relationships: [] }],
  });
  const p = chain(inp([["n1", "A"], ["n1", "B"]], [{ id: "n1", addresses: [], topology: t, linkTemplate: "https://n1/nifi/?processGroupId={id}" }]));
  assert.deepEqual(names(p), [["Ingest"], ["Load"]]);
  assert.deepEqual(p.edges.map((e) => [e.kind, e.basis, e.inferred, e.via]), [["link", "topology", false, "out → in"]]);
  assert.deepEqual(p.gaps.map((g) => [g.kind, g.segment, g.neighbor?.group?.name, g.component]), [
    ["exit-unregistered", "s1", "Errors", "A:err"], ["exit-unregistered", "s2", "Parent P", "B:done"]]);
  assert.equal(p.gaps[0].neighbor!.link, "https://n1/nifi/?processGroupId=X");
  assert.deepEqual(p.exits, [{ segment: "s2", label: "PutFile", component: "e1" }]);
  assert.deepEqual(p.entries, [{ segment: "s1", label: "Ingest：2 个起点处理器" }]);
  assert.equal(p.groups[0].group.path, "NiFi Flow / Parent P / Ingest");
  // Not joined at all: disconnected.
  const q = chain(inp([["n1", "A"], ["n1", "C"]], [{ id: "n1", addresses: [], topology: scoped([grp("A", "Ingest", [frag("a", { starts: 1 })]), grp("C", "Other", [frag("c", { starts: 1 })])]) }]));
  assert.deepEqual(q.gaps.map((g) => [g.kind, g.segments]), [["disconnected", ["s2"]]]);
});

test("chain: S2S by address, by name (inferred), into a parent's remote port; unpaired and unregistered receivers are gaps", () => {
  const a = scoped([grp("A", "Send", [frag("a", { starts: 1 })])], {
    s2sOut: [
      { ref: "https://b1:8443/nifi#in-order", name: "in-order", targets: ["https://b1:8443/nifi"], group: "A", fragment: "a", sources: [{ id: "pa", name: "Prepare", kind: "processor", relationships: ["success"] }] },
      { ref: "https://lb:8443/nifi#by-name", name: "by-name", targets: ["https://lb:8443/nifi"], group: "A", fragment: "a" },
      { ref: "https://far:8443/nifi#gone", name: "gone", targets: ["https://far:8443/nifi"], group: "A", fragment: "a", sources: [{ id: "pg", name: "Send far", kind: "processor", relationships: [] }] },
      { ref: "https://c1:8443/nifi#other", name: "other", targets: ["https://c1:8443/nifi"], group: "A", fragment: "a" },
    ],
  });
  // nifi-b: a 1.x root remote port in-order feeds the registered group B (beside it, one hop out); by-name inside C.
  const b = scoped([grp("B", "Receive", [frag("b", { inputs: ["in"] })], "root"), grp("C", "Named", [frag("c", { remoteIn: ["by-name"], starts: 1 })], "root")], {
    neighbors: [nbr("B", "in", "in", { kind: "port", id: "rp1", name: "in-order", group: "root", remote: true })],
    s2sIn: [{ id: "rp2", name: "by-name", group: "C", fragment: "c" }],
  });
  const p = chain(inp([["a", "A"], ["b", "B"], ["b", "C"]], [
    { id: "a", addresses: ["a1:8443"], topology: a }, { id: "b", addresses: ["b1:8443"], topology: b }, { id: "c", addresses: ["c1:8443"], topology: null },
  ]));
  assert.deepEqual(p.edges.map((e) => [e.kind, e.basis, e.inferred, e.via]), [
    ["s2s", "rpg-address", false, "S2S b/in-order"], ["s2s", "rpg-name", true, "S2S b/by-name"]]);
  assert.deepEqual(p.gaps.map((g) => [g.kind, g.component, g.neighbor?.service, g.neighbor?.port]), [
    ["s2s-unpaired", "pg", "", "gone"], ["exit-unregistered", "https://c1:8443/nifi#other", "c", "other"]]);
  assert.ok(p.notes.some((n) => /按端口名 by-name 接上/.test(n)));
  // A known sender on another service that is not registered: the remote input port's entry is a gap.
  const senders = sendersOf([{ service: "a", topology: a }]);
  const q = chain(inp([["b", "B"]], [{ id: "a", addresses: ["a1:8443"] }, { id: "b", addresses: ["b1:8443"], topology: b }], { senders }));
  assert.deepEqual(q.gaps.map((g) => [g.kind, g.neighbor?.service, g.neighbor?.group?.id]), [["entry-unregistered", "a", "A"]]);
});

test("chain: shared modules join by port id; passing through one joins the business, an error sink does not", () => {
  const t = scoped([
    grp("A", "Intake", [frag("a", { outputs: ["to-check", "errors"], starts: 1 })]),
    grp("B", "Route", [frag("b", { inputs: ["in"], outputs: ["errors"] })]),
    grp("Z", "Lonely", [frag("z", { outputs: ["errors"], starts: 1 })]),
  ], {
    neighbors: [
      nbr("A", "out", "to-check", { kind: "group", id: "V", name: "Validate", group: "P", port: { id: "V:in", name: "in" } }),
      nbr("A", "out", "errors", { kind: "group", id: "E", name: "Errors", group: "P", port: { id: "E:in", name: "in" } }),
      nbr("B", "in", "in", { kind: "group", id: "V", name: "Validate", group: "P", port: { id: "V:orders", name: "orders" } }),
      nbr("B", "out", "errors", { kind: "group", id: "E", name: "Errors", group: "P", port: { id: "E:in", name: "in" } }),
      nbr("Z", "out", "errors", { kind: "group", id: "E", name: "Errors", group: "P", port: { id: "E:in", name: "in" } }),
    ],
  });
  const modules: ChainModule[] = [
    { id: "shm_v", name: "Validate", service: "n1", group: { id: "V", name: "Validate" }, entries: [{ id: "i", channel: { type: "external", system: "port:V:in" } }],
      exits: [{ id: "o", component: "V:orders", channel: { type: "external", system: "port:V:orders" }, when: [{ attr: "biz.type", op: "equals", value: "order" }] }] },
    { id: "shm_e", name: "Errors", service: "n1", group: { id: "E", name: "Errors" }, entries: [{ id: "i", channel: { type: "external", system: "port:E:in" } }],
      // An error step writes out of NiFi (S39 UAT 2026-11-25: this exit made every business into it report a gap).
      exits: [{ id: "w", component: "E:write", channel: { type: "external", system: "Write error log" } }] },
  ];
  const svc = [{ id: "n1", addresses: [], topology: t }];
  const p = chain(inp([["n1", "A"], ["n1", "B"], ["n1", "Z"]], svc, { modules }));
  assert.deepEqual(edge(p, "shared-entry").sort(), ["Intake>Errors", "Intake>Validate", "Lonely>Errors", "Route>Errors"]);
  assert.deepEqual(edge(p, "shared-exit"), ["Validate>Route"]);
  assert.deepEqual(p.segments.filter((s) => s.role === "shared").map((s) => s.module), ["shm_v", "shm_e"]);
  assert.deepEqual(p.gaps.map((g) => [g.kind, g.segments]), [["disconnected", ["s3"]]]);
  assert.deepEqual(names(p), [["Intake", "Lonely"], ["Validate"], ["Route"], ["Errors"]]);
  // Without B: the data goes into Validate and none of its exits comes back.
  const q = chain(inp([["n1", "A"]], svc, { modules }));
  assert.deepEqual(q.gaps.map((g) => [g.kind, g.component, g.neighbor?.group?.name]), [["exit-unregistered", "A:to-check", "Validate"]]);
  // Without A: Route has no start of its own and only the module feeds it.
  const r = chain(inp([["n1", "B"]], svc, { modules }));
  assert.deepEqual(r.gaps.map((g) => [g.kind, g.neighbor?.group?.name]), [["entry-unregistered", "Validate"]]);
});

test("chain: schedules place workers by worker_name = group name and the manager; an unplaced worker is a gap; a final worker triggers the next schedule", () => {
  const t = scoped(["mgr", "reader", "loader", "notify", "next_mgr", "mailer"].map((n) => grp(n, n, [frag(n)])));
  const headers = [
    { schedule_id: 1, schedule_name: "intake", manager_name: "mgr", trigger_exchange_name: "ex.trigger", trigger_routing_key: "intake", final_schedule_seq: 3, final_worker_id: 13 },
    { schedule_id: 2, schedule_name: "notice", manager_name: "next_mgr", trigger_exchange_name: "ex.trigger", trigger_routing_key: "notice", final_schedule_seq: null, final_worker_id: null },
    { schedule_id: 3, schedule_name: "elsewhere", manager_name: "far", trigger_exchange_name: "ex.trigger", trigger_routing_key: "x", final_schedule_seq: null, final_worker_id: null },
  ];
  const d = (s: number, seq: number, id: number, name: string) => ({ schedule_id: s, schedule_seq: seq, worker_id: id, worker_name: name, worker_exchange_name: "ex.worker", worker_routing_key: `w.${name}` });
  const details = [d(1, 1, 11, "Reader"), d(1, 2, 12, "java_service"), d(1, 3, 13, "loader"), d(1, 4, 14, "after_final"), d(2, 1, 21, "mailer"), d(3, 1, 31, "far_worker")];
  const mq = [
    { group: "loader", component: "pub1", side: "out" as const, exchange: "ex.trigger", routingKey: "notice" },
    { group: "reader", component: "c1", side: "in" as const, exchange: "ex.worker", routingKey: "w.Reader" },
  ];
  const p = chain(inp(["mgr", "reader", "loader", "next_mgr", "mailer"].map((g) => ["n1", g] as [string, string]), [{ id: "n1", addresses: [], topology: t, mq }], { schedules: { headers, details } }));
  assert.deepEqual(p.edges.filter((e) => e.kind === "schedule").map((e) => [edge({ ...p, edges: [e] }, "schedule")[0], e.basis, e.via]), [
    ["mgr>reader", "e2e", "schedule intake 调度 → 1"],
    ["reader>loader", "e2e", "schedule intake 1→3（跳过没对上的第 2 步 java_service）"],
    ["loader>next_mgr", "mq-props", "schedule intake 收尾 → schedule notice trigger ex.trigger/notice"],
    ["next_mgr>mailer", "e2e", "schedule notice 调度 → 1"],
  ]);
  assert.deepEqual(p.gaps.map((g) => [g.kind, g.segment]), [["worker-unplaced", "s2"]]);
  assert.deepEqual(p.segments.filter((s) => s.origin === "e2e_trace").map((s) => [s.group.name, s.steps]), [["mgr", ["mgr"]], ["reader", ["Reader"]], ["loader", ["loader"]], ["next_mgr", ["next_mgr"]], ["mailer", ["mailer"]]]);
  assert.deepEqual(p.entries.filter((e) => e.channel), [{ segment: "s1", label: "schedule intake 的 trigger MQ ex.trigger/intake", channel: "mq:ex.trigger/intake" }]);
  assert.ok(p.exits.some((e) => e.segment === "s3" && /intake 收尾：第 3 步 loader/.test(e.label)));
  assert.deepEqual(names(p), [["mgr"], ["reader"], ["loader"], ["next_mgr"], ["mailer"]]);
});

test("chain: a schedule whose workers only match processors in the registered groups is asked about, with candidates", () => {
  // S39 UAT 2026-11-25: worker names that are processor names, not group names, made the schedule vanish from the chain.
  const t = scoped([grp("A", "cx-mail", [frag("a", { names: ["mail_reader"], starts: 1 })]), grp("B", "cx-post", [frag("b", { names: ["erp_poster"] })])]);
  const headers = [
    { schedule_id: 7, schedule_name: "mail_parse", manager_name: null, trigger_exchange_name: "ex.trigger", trigger_routing_key: "m", final_schedule_seq: null, final_worker_id: null },
    { schedule_id: 8, schedule_name: "elsewhere", manager_name: null, trigger_exchange_name: "ex.trigger", trigger_routing_key: "x", final_schedule_seq: null, final_worker_id: null },
  ];
  const d = (s: number, seq: number, name: string) => ({ schedule_id: s, schedule_seq: seq, worker_id: s * 10 + seq, worker_name: name, worker_exchange_name: "ex.worker", worker_routing_key: `w.${name}` });
  const details = [d(7, 1, "mail_reader"), d(7, 2, "erp_poster"), d(7, 3, "approval_notifier"), d(8, 1, "far_worker")];
  const p = chain(inp([["n1", "A"], ["n1", "B"]], [{ id: "n1", addresses: [], topology: t }], { schedules: { headers, details } }));
  const asked = p.gaps.filter((g) => g.kind === "worker-unplaced");
  assert.deepEqual(asked.map((g) => [g.worker?.name, (g.places ?? []).map((x) => [x.group.name, x.basis])]), [
    ["mail_reader", [["cx-mail", "processor-name"]]], ["erp_poster", [["cx-post", "processor-name"]]], ["approval_notifier", []],
  ]);
  assert.ok(!p.gaps.some((g) => g.worker?.name === "far_worker"));
});

test("chain: told hand-overs are declared edges with the owner's words and close the gap they answer", () => {
  const t = scoped([grp("A", "Export", [frag("a", { outputs: ["out"], starts: 1 })]), grp("B", "Import", [frag("b", { starts: 1 })])], {
    neighbors: [nbr("A", "out", "out", { kind: "processor", id: "p1", name: "PutSFTP", group: "P" })],
  });
  const svc = [{ id: "n1", addresses: [], topology: t }];
  const handoffs = [{ id: "hof_1", from: { service: "n1", group: "A", component: "A:out" }, to: { service: "n1", group: "B" }, quote: "SFTP 目录 /in 由 Import 取走" }];
  const p = chain(inp([["n1", "A"], ["n1", "B"]], svc, { handoffs }));
  assert.deepEqual(p.edges, [{ from: "s1", to: "s2", kind: "declared", via: "负责人说明 hof_1", basis: "owner", inferred: true, quote: "SFTP 目录 /in 由 Import 取走", handoff: "hof_1" }]);
  assert.deepEqual(p.gaps, []);
  const q = chain(inp([["n1", "A"]], svc, { handoffs: [{ id: "hof_2", from: { service: "n1", group: "A", component: "A:out" }, to: { system: "partner SFTP" }, quote: "交给合作方" }] }));
  assert.deepEqual([q.gaps, q.exits.map((e) => e.channel)], [[], ["declared:hof_2"]]);
  // The hand-over's other group no longer registered: a gap again.
  const r = chain(inp([["n1", "A"]], svc, { handoffs }));
  assert.deepEqual(r.gaps.map((g) => g.kind), ["exit-unregistered"]);
});

test("chain: a group inside another of the same registration is refused; a missing group or slice is a gap; a slice is one piece; a funnel passes on", () => {
  const inner = { ...grp("B", "Inner", [frag("b")]), path: [ROOT, { id: "A", name: "Outer" }] };
  assert.throws(() => chain(inp([["n1", "A"], ["n1", "B"]], [{ id: "n1", addresses: [], topology: scoped([grp("A", "Outer", [frag("a")], "root"), inner]) }])),
    (e: unknown) => e instanceof RegError && e.code === "register/group-taken" && (e.extra.taken as { relation: string }[])[0].relation === "inside");
  const t = scoped([grp("A", "Two pieces", [frag("a1", { starts: 1, outputs: ["o1"] }), frag("a2", { starts: 1, outputs: ["o2"] })]), grp("C", "Next", [frag("c", { inputs: ["in"] })])], {
    missing: ["G"],
    neighbors: [
      nbr("A", "out", "o1", { kind: "funnel", id: "f1", name: "funnel", group: "P" }),
      nbr("C", "in", "in", { kind: "funnel", id: "f1", name: "funnel", group: "P" }),
    ],
  });
  const p = chain({ name: "x", groups: [{ service: "n1", group: "A", slice: "a1" }, { service: "n1", group: "C" }, { service: "n1", group: "G" }, { service: "n1", group: "A", slice: "zz" }], services: [{ id: "n1", addresses: [], topology: t }] });
  assert.deepEqual(p.groups.map((g) => [g.group.id, g.slice, g.state, g.segment]), [["A", "a1", "ok", "s1"], ["C", "*", "ok", "s2"], ["G", "*", "missing", undefined], ["A", "zz", "missing", undefined]]);
  assert.deepEqual(p.edges.map((e) => [e.from, e.to, e.via]), [["s1", "s2", "o1 → 漏斗 → in"]]);
  assert.deepEqual(p.gaps.map((g) => g.kind), ["group-missing", "group-missing"]);
  assert.deepEqual(p.entries, [{ segment: "s1", label: "Two pieces：1 个起点处理器" }]);
});
