// S39 step 4: the registration's preview on what NiFi has now (register-chain.ts), worker places, shared modules (one
// group used by two businesses, made a module out of one of them), the module's own health, module-in-use.

import assert from "node:assert/strict";
import { test } from "node:test";
import { chain } from "../src/server/services/chain.ts";
import type { Topology, TopologyFragment, TopologyNeighbor } from "../src/server/services/flowcounts.ts";
import { moduleViews, RegisterChain, type ScheduleRows } from "../src/server/services/register-chain.ts";
import { RegisterPublisher } from "../src/server/services/register-publish.ts";
import { RegError, Registrations, type GroupInfo, type GroupReader } from "../src/server/services/registration.ts";
import { Store, type Actor, type FlowRecord } from "../src/server/store.ts";

const admin: Actor = { id: "admin@x", via: "key" };
const ROOT = { id: "aaaaaaaa-0000-0000-0000-000000000000", name: "NiFi Flow" };
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const A = id(1), B = id(2), V = id(3), O = id(4), I = id(5), L = id(6), M = id(7);
const link = (g: string) => `https://h-a1:8443/nifi/?processGroupId=${g}&componentIds=`;

const frag = (more: Partial<TopologyFragment> = {}): TopologyFragment => ({ key: "f", processors: 1, names: [], inputs: [], outputs: [], remoteIn: [], s2sOut: [], starts: 0, ...more });
const nbr = (group: string, side: "in" | "out", port: { id: string; name: string }, other: TopologyNeighbor["other"]): TopologyNeighbor =>
  ({ group, connection: `${group}-${port.id}`, side, port, relationships: [], other });
const g = (gid: string, name: string) => ({ kind: "group", id: gid, name, group: ROOT.id });

/** The canvas of n1: Orders (A) and Invoices (B) both feed Validate (V); its exits go to Order out (O) and Invoice out
 *  (I). Loader (L, with a processor named Loader) and Mgr (M) for the schedules. */
const canvas: Record<string, { name: string; frag: TopologyFragment; info?: Partial<GroupInfo>; near: TopologyNeighbor[] }> = {
  [A]: { name: "Orders", frag: frag({ outputs: ["to-v"], starts: 1 }), near: [nbr(A, "out", { id: "a-out", name: "to-v" }, { ...g(V, "Validate"), port: { id: "vin", name: "in" } })] },
  [B]: { name: "Invoices", frag: frag({ outputs: ["to-v"], starts: 1 }), near: [nbr(B, "out", { id: "b-out", name: "to-v" }, { ...g(V, "Validate"), port: { id: "vin", name: "in" } })] },
  [V]: { name: "Validate", frag: frag({ inputs: ["in"], outputs: ["orders", "invoices"] }),
    info: { inputPorts: [{ id: "vin", name: "in" }], outputPorts: [{ id: "vo", name: "orders" }, { id: "vi", name: "invoices" }] },
    near: [nbr(V, "in", { id: "vin", name: "in" }, { ...g(A, "Orders"), port: { id: "a-out", name: "to-v" } }), nbr(V, "in", { id: "vin", name: "in" }, { ...g(B, "Invoices"), port: { id: "b-out", name: "to-v" } }),
      nbr(V, "out", { id: "vo", name: "orders" }, { ...g(O, "Order out"), port: { id: "o-in", name: "in" } }), nbr(V, "out", { id: "vi", name: "invoices" }, { ...g(I, "Invoice out"), port: { id: "i-in", name: "in" } })] },
  [O]: { name: "Order out", frag: frag({ inputs: ["in"] }), near: [nbr(O, "in", { id: "o-in", name: "in" }, { ...g(V, "Validate"), port: { id: "vo", name: "orders" } })] },
  [I]: { name: "Invoice out", frag: frag({ inputs: ["in"] }), near: [nbr(I, "in", { id: "i-in", name: "in" }, { ...g(V, "Validate"), port: { id: "vi", name: "invoices" } })] },
  [L]: { name: "load_stage", frag: frag({ names: ["Read", "Loader"] }), info: { inputPorts: [{ id: "l-in", name: "in" }] }, near: [] },
  [M]: { name: "mgr", frag: frag({ starts: 1 }), near: [] },
};
const reader: GroupReader = {
  async read(_s, ids) { return (await this.scan(_s, ids)).groups; },
  async scan(_s, ids) {
    const groups: GroupInfo[] = ids.map((x) => canvas[x] ? { id: x, exists: true, name: canvas[x]!.name, path: [ROOT], ...canvas[x]!.info } : { id: x, exists: false });
    const topology = {
      scope: "groups", root: ROOT, links: [], s2sIn: [], s2sOut: [], ends: [], missing: [],
      groups: ids.filter((x) => canvas[x]).map((x) => ({ id: x, name: canvas[x]!.name, root: false, parent: ROOT.id, path: [ROOT], fragments: [canvas[x]!.frag] })),
      neighbors: ids.flatMap((x) => canvas[x]?.near ?? []),
    } as unknown as Topology;
    return { groups, topology };
  },
};
const flow = (fid: string, name: string): FlowRecord => ({ id: fid, name, nameBy: "person", status: "confirmed", summary: "", reason: null, risks: [], pendings: [], stuck: null, createdAt: "2026-11-24T00:00:00Z", confirmedAt: null, confirmedBy: null, updatedAt: "2026-11-24T00:00:00Z" });

function setup(schedules?: (s: string) => Promise<ScheduleRows | null>) {
  const store = new Store(":memory:");
  store.addStandalone({ kind: "standalone", id: "n1", service: "nifi", profile: "nifi-1.x", version: "1.12.1", webUrl: "https://h-a1:8443/nifi", member: { host: "h-a1", installDir: "/opt/a", serviceUser: "nifi", startEnvironment: null, ports: { https: 8443 }, discovery: null } } as never, "uat", admin);
  const regs = new Registrations(store, reader);
  const chains = new RegisterChain({ store, registrations: regs, reader, ...(schedules ? { schedules } : {}) });
  return { store, regs, chains, publisher: new RegisterPublisher({ store, registrations: regs, chains }) };
}
const refused = async (p: Promise<unknown>, code: string) => {
  try { await p; } catch (e) { assert.ok(e instanceof RegError, String(e)); assert.equal(e.code, code, e.message); return e; }
  assert.fail(`expected ${code}`);
};
const edges = (p: { edges: { from: string; to: string; kind: string }[]; segments: { id: string; group: { name: string } }[] }) =>
  p.edges.map((e) => `${p.segments.find((s) => s.id === e.from)!.group.name}>${p.segments.find((s) => s.id === e.to)!.group.name}:${e.kind}`).sort();

test("shared: a group two businesses use becomes a module out of the one that had it; both join it by its ports; history on both", async () => {
  const { store, regs, chains, publisher } = setup();
  store.putFlow(flow("flw_orders", "订单"));
  store.putFlow(flow("flw_invoice", "发票"));
  await regs.add("flw_orders", [link(A), link(V), link(O)], admin);
  await regs.add("flw_invoice", [link(B), link(I)], admin);
  // The second business wants V too: taken; the way out is a module.
  const taken = await refused(regs.add("flw_invoice", [link(V)], admin), "register/group-taken");
  assert.deepEqual((taken.extra.options as { kind: string }[]).map((o) => o.kind), ["shared", "slice"]);
  const body = { name: "校验", links: [link(V)], entries: [{ port: "in" }],
    exits: [{ component: "orders", when: [{ attr: "biz.type", op: "equals", value: "order" }] }, { component: "invoices", when: [{ attr: "biz.type", op: "equals", value: "invoice" }] }] };
  const asked = await refused(chains.shared({ ...body, commit: true }, admin), "register/group-taken");
  assert.equal(asked.extra.takeover, true, "the answer says takeover: true would move it");
  await refused(chains.shared({ ...body, takeover: true, entries: [{ port: "nope" }] }, admin), "register/port-missing");

  const look = await chains.shared({ ...body, takeover: true }, admin) as { segments: { role: string }[]; users: { flow: string }[]; takeover: { flow: string } };
  assert.deepEqual([look.segments.map((s) => s.role), look.users.map((u) => u.flow).sort(), look.takeover.flow], [["shared"], ["flw_invoice", "flw_orders"], "flw_orders"]);
  assert.equal(store.sharedModules().length, 0, "a preview writes nothing");

  const done = await publisher.shared({ ...body, takeover: true, commit: true }, admin) as { module: string; users: { flow: string; joined: boolean; gaps: number }[] };
  assert.match(done.module, /^shm_/);
  assert.deepEqual(store.flowRegistrations({ owner: "flw_orders" }).map((r) => r.groupId), [A, O], "V left the business");
  assert.deepEqual(store.flowRegistrations({ owner: done.module }).map((r) => [r.groupId, r.role]), [[V, "shared"]]);
  for (const f of ["flw_orders", "flw_invoice"]) assert.ok(store.flowChanges({ flow: f }).some((c) => c.kind === "shared"), `${f} has a line in its history`);
  assert.deepEqual(done.users.map((u) => [u.flow, u.joined, u.gaps]).sort(), [["flw_invoice", true, 0], ["flw_orders", true, 0]]);

  // Both chain through the module by its ports, each out of its own exit.
  const orders = await chains.preview({ flow: "flw_orders" });
  assert.deepEqual(edges(orders), ["Orders>Validate:shared-entry", "Validate>Order out:shared-exit"]);
  const invoice = await chains.preview({ flow: "flw_invoice" });
  assert.deepEqual(edges(invoice), ["Invoices>Validate:shared-entry", "Validate>Invoice out:shared-exit"]);
  assert.deepEqual(invoice.gaps, []);

  // The module's own health: its group's counts, not split over the businesses.
  const at = new Date();
  store.putFlowCounts([{ service: "n1", bucket: new Date(at.getTime() - 10 * 60_000).toISOString(), kind: "group", ref: V, name: "Validate", flowfilesIn: 30, flowfilesOut: 0, bytesIn: 1, bytesOut: 0, transferred: 0, source: "sample" }]);
  const view = moduleViews(store, undefined, at)[0]!;
  assert.deepEqual([view.name, view.health.light, view.health.flowfilesIn, view.entries.length, view.exits.length], ["校验", "attention", 30, 1, 2]);
  assert.match(view.exits[0]!.text, /biz\.type equals order/);

  // Still in use: not unregistered.
  const busy = await refused(chains.assertModuleFree(done.module), "register/module-in-use");
  assert.deepEqual((busy.extra.users as { flow: string }[]).map((u) => u.flow).sort(), ["flw_invoice", "flw_orders"]);
});

test("shared: the business's only group is not taken over; without takeover the group stays", async () => {
  const { store, regs, chains, publisher } = setup();
  store.putFlow(flow("flw_one", "只有校验"));
  await regs.add("flw_one", [link(V)], admin);
  await refused(chains.shared({ name: "校验", links: [link(V)], entries: [{ port: "in" }], takeover: true, commit: true }, admin), "register/empty");
  await refused(chains.shared({ name: "校验", links: [link(V), link(A)], entries: [{ port: "in" }] }, admin), "register/bad-request");
  // A free group: registered, nobody uses it yet, so it can go.
  const { module } = await publisher.shared({ name: "订单", links: [link(B)], entries: [], commit: true }, admin).catch((e) => e) as { module?: string };
  assert.equal(module, undefined, "a module needs an entry");
  const ok = await publisher.shared({ name: "收尾", links: [link(L)], entries: [{ port: "in" }], commit: true }, admin) as { module: string };
  await chains.assertModuleFree(ok.module);
  assert.equal(regs.unregister({ module: ok.module }, admin).removed.groups, 1);
});

const sched = (fail = false) => async (): Promise<ScheduleRows | null> => {
  if (fail) throw new Error("Studio down");
  return {
    headers: [{ schedule_id: 7, schedule_name: "load", manager_name: "mgr", trigger_exchange_name: null, trigger_routing_key: null, final_schedule_seq: null, final_worker_id: null }],
    details: [{ schedule_id: 7, schedule_seq: 1, worker_id: 71, worker_name: "Loader" }, { schedule_id: 7, schedule_seq: 2, worker_id: 72, worker_name: "java_side" }],
  };
};

test("preview of a draft: kept on the draft; an unplaced worker comes with candidates; place-worker places it or says not in NiFi", async () => {
  const { store, regs, chains } = setup(sched());
  const d = regs.createDraft(admin, "装载");
  await regs.draftAdd(d.id, [link(M), link(L)], admin);
  const p = await chains.preview({ draft: d.id });
  assert.deepEqual(store.registrationDraft(d.id)!.preview, JSON.parse(JSON.stringify(p)), "the draft keeps the last preview");
  const unplaced = p.gaps.filter((x) => x.kind === "worker-unplaced");
  assert.deepEqual(unplaced.map((x) => x.worker?.name), ["Loader", "java_side"]);
  assert.deepEqual(unplaced[0]!.places, [{ service: "n1", group: { id: L, name: "load_stage" }, basis: "processor-name", processor: "Loader" }]);
  assert.deepEqual(unplaced[1]!.places, []);
  // The owner says where: the code uses it, it does not guess.
  regs.placeWorker({ draft: d.id }, { schedule: 7, worker: "Loader", group: { service: "n1", group: L }, quote: "Loader 就是 load_stage 那个组" }, admin);
  regs.placeWorker({ draft: d.id }, { schedule: "7", worker: "java_side", outside: true, quote: "那是 Java 服务" }, admin);
  assert.throws(() => regs.placeWorker({ draft: d.id }, { schedule: 7, worker: "x", group: { service: "n1", group: A }, quote: "q" }, admin), (e: RegError) => e.code === "register/bad-handoff");
  const q = await chains.preview({ draft: d.id });
  assert.deepEqual(q.gaps, []);
  assert.deepEqual(edges(q), ["mgr>load_stage:schedule"]);
  assert.deepEqual(store.registrationDraft(d.id)!.places.map((x) => [x.worker, x.group]), [["Loader", L], ["java_side", null]]);
  // A group that leaves the draft takes its places.
  regs.draftRemove(d.id, [{ service: "n1", group: L }]);
  assert.deepEqual(store.registrationDraft(d.id)!.places.map((x) => x.worker), ["java_side"]);
});

test("preview of a business: worker places kept in worker_places with a history line; e2e unreadable still chains, with a note", async () => {
  const { store, regs, chains } = setup(sched());
  store.putFlow(flow("flw_load", "装载"));
  await regs.add("flw_load", [link(M), link(L)], admin);
  regs.placeWorker({ flow: "flw_load" }, { schedule: 7, worker: "Loader", group: { service: "n1", group: L }, quote: "在 load_stage" }, admin);
  regs.placeWorker({ flow: "flw_load" }, { schedule: 7, worker: "java_side", outside: true, quote: "不在 NiFi" }, admin);
  assert.deepEqual(store.workerPlaces("flw_load").map((x) => [x.worker, x.group]), [["Loader", L], ["java_side", null]]);
  assert.equal(store.flowChanges({ flow: "flw_load" }).filter((c) => c.kind === "place-worker").length, 2);
  assert.deepEqual((await chains.preview({ flow: "flw_load" })).gaps, []);
  regs.placeWorker({ flow: "flw_load" }, { schedule: 7, worker: "java_side", remove: true }, admin);
  assert.equal(store.workerPlaces("flw_load").length, 1);
  const down = setup(sched(true));
  down.store.putFlow(flow("flw_load", "装载"));
  await down.regs.add("flw_load", [link(M), link(L)], admin);
  const p = await down.chains.preview({ flow: "flw_load" });
  assert.ok(p.notes.some((n) => /Studio down/.test(n)), p.notes.join(" | "));
  assert.deepEqual(p.gaps.filter((x) => x.kind === "worker-unplaced"), []);
  // Unregistering the business takes its places with it.
  regs.unregister({ flow: "flw_load" }, admin);
  assert.equal(store.workerPlaces("flw_load").length, 0);
});

test("chain: an error module whose only exit is another module's entry (dead letters to the DLQ) is a sink, not a gap", () => {
  const t = { scope: "groups", root: ROOT, links: [], s2sIn: [], s2sOut: [], ends: [], missing: [],
    groups: [{ id: "G", name: "biz", root: false, path: [ROOT], fragments: [frag({ outputs: ["errors"], starts: 1 })] }],
    neighbors: [nbr("G", "out", { id: "g-err", name: "errors" }, { ...g("E", "errors"), port: { id: "e-in", name: "in" } })] } as unknown as Topology;
  const modules = [
    { id: "shm_e", name: "errors", service: "n1", group: { id: "E", name: "errors" }, entries: [{ id: "i", channel: { type: "external" as const, system: "port:e-in" } }],
      exits: [{ id: "o", component: "x", channel: { type: "s2s" as const, service: "c2", port: "dlq-in" } }] },
    { id: "shm_d", name: "dlq", service: "c2", group: { id: "D", name: "dlq" }, entries: [{ id: "i", channel: { type: "s2s" as const, port: "dlq-in" } }], exits: [] },
  ];
  const services = [{ id: "n1", addresses: [], topology: t }, { id: "c2", addresses: [] }];
  assert.deepEqual(chain({ groups: [{ service: "n1", group: "G" }], services, modules }).gaps, []);
  // Without the DLQ module the errors module passes data on somewhere not registered.
  assert.deepEqual(chain({ groups: [{ service: "n1", group: "G" }], services, modules: [modules[0]!] }).gaps.map((x) => x.kind), ["exit-unregistered"]);
});

test("chain: placements put a worker in a group, or leave it out of NiFi, before the name rule", () => {
  const t = { scope: "groups", root: ROOT, links: [], s2sIn: [], s2sOut: [], ends: [], neighbors: [], missing: [],
    groups: [{ id: "G", name: "stage-one", root: false, path: [ROOT], fragments: [frag({ names: ["worker_a"], starts: 1 })] }] } as unknown as Topology;
  const schedules = { headers: [{ schedule_id: 1, schedule_name: "s", manager_name: "x" }], details: [{ schedule_id: 1, schedule_seq: 1, worker_id: 1, worker_name: "worker_a" }, { schedule_id: 1, schedule_seq: 2, worker_id: 2, worker_name: "STAGE-ONE" }] };
  const base = { groups: [{ service: "n1", group: "G" }], services: [{ id: "n1", addresses: [], topology: t }], schedules };
  // STAGE-ONE is the group by name; worker_a is a candidate by its processor.
  const p = chain(base);
  assert.deepEqual(p.gaps.map((x) => [x.kind, x.worker?.name, x.places?.map((c) => c.basis)]), [["worker-unplaced", "worker_a", ["processor-name"]]]);
  const q = chain({ ...base, placements: [{ schedule: "1", worker: "WORKER_A", service: "n1", group: "G" }] });
  assert.deepEqual(q.gaps, []);
  const r = chain({ ...base, placements: [{ schedule: "s", worker: "worker_a", group: null }] });
  assert.deepEqual(r.gaps, []);
  // A place in a group that is no longer registered: asked again.
  const s = chain({ ...base, placements: [{ schedule: "1", worker: "worker_a", service: "n1", group: "gone" }] });
  assert.match(s.gaps[0]!.text, /负责人说过/);
});
