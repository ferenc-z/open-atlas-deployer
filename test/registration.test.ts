// S39 business-registration step 2: link parsing, the address-to-service match, and the registration actions
// (add, remove, rename, unregister) with a fake "read a group now"; the route's answers.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/server/app.ts";
import { permissionsFor, WorkbenchSessions, type Principal } from "../src/server/auth.ts";
import type { Config } from "../src/server/config.ts";
import { Deployments } from "../src/server/deploy.ts";
import { WorkbenchAdmin } from "../src/server/drivers/workbench.ts";
import { EnvManager, Schemas } from "../src/server/env.ts";
import { Handoff } from "../src/server/handoff.ts";
import type { Keys } from "../src/server/keys.ts";
import { Observer } from "../src/server/observe.ts";
import { SecretBox } from "../src/server/secretbox.ts";
import { parseLink, RegError, Registrations, resolveLink, serviceAddresses, type GroupInfo, type GroupReader } from "../src/server/services/registration.ts";
import { Store, type Actor, type FlowRecord } from "../src/server/store.ts";
import { Versions } from "../src/server/versions.ts";

import type { DatabaseSync } from "node:sqlite";
const sql = (s: Store) => (s as unknown as { db: DatabaseSync }).db;
const admin: Actor = { id: "admin@x", via: "key" };
const G1 = "0d1c2e3f-0178-1000-a3b2-9f8e7d6c5b4a";
const G2 = "7f3a1b2c-0178-1000-9c8d-1a2b3c4d5e6f";
const G3 = "11111111-2222-3333-4444-555555555555";
const PARENT = "99999999-0178-1000-8888-777766665555";
const ROOT_ID = "aaaaaaaa-0178-1000-bbbb-cccccccccccc";

const member = (host: string, port: number, extra: Record<string, unknown> = {}) =>
  ({ host, installDir: `/opt/${host}`, serviceUser: "nifi", startEnvironment: null, ports: { https: port }, discovery: null, ...extra });

function seed(store: Store) {
  store.addStandalone({ kind: "standalone", id: "n1", service: "nifi", profile: "nifi-1.x", version: "1.12.1", webUrl: null, member: member("h-a1", 8443) } as never, "uat", admin);
  store.addCluster({ kind: "cluster", id: "c2", service: "nifi", profile: "nifi-2.x", version: "2.5.0", webUrl: "https://nifi-lb.corp/nifi", zookeeper: "zk:2181", zookeeperRoot: "/c2",
    nodes: [member("h-b1", 8443, { nodeAddress: "nifi-b1.corp" }), member("h-b2", 8443, { nodeAddress: "nifi-b2.corp" })] } as never, "uat", admin);
}

/** The fake "read a group now": groups by service and id; the ones not listed do not exist. */
const canvas: Record<string, GroupInfo[]> = {
  n1: [
    { id: PARENT, exists: true, name: "订单", path: [{ id: ROOT_ID, name: "NiFi Flow" }] },
    { id: G1, exists: true, name: "收单", path: [{ id: ROOT_ID, name: "NiFi Flow" }, { id: PARENT, name: "订单" }] },
    { id: G2, exists: true, name: "入库", path: [{ id: ROOT_ID, name: "NiFi Flow" }] },
  ],
  c2: [{ id: G3, exists: true, name: "对账", path: [{ id: ROOT_ID, name: "NiFi Flow" }] }],
};
const reads: { service: string; ids: string[] }[] = [];
const reader: GroupReader = {
  async read(service, ids) {
    reads.push({ service, ids });
    return ids.map((id) => canvas[service]?.find((g) => g.id === id) ?? { id, exists: false });
  },
};

const flow = (id: string, name: string): FlowRecord => ({ id, name, nameBy: "ai", status: "confirmed", summary: "", reason: null, risks: [], pendings: [], stuck: null, createdAt: "2026-11-24T00:00:00Z", confirmedAt: null, confirmedBy: null, updatedAt: "2026-11-24T00:00:00Z" });

const refused = async (p: Promise<unknown> | (() => unknown), code: string) => {
  try { await (typeof p === "function" ? p() : p); } catch (e) { assert.ok(e instanceof RegError, String(e)); assert.equal(e.code, code, e.message); return e; }
  assert.fail(`expected ${code}`);
};

test("parseLink: NiFi 1.x and 2.x writes of a group link", () => {
  const one = parseLink(`https://h-a1:8443/nifi/?processGroupId=${G1}&componentIds=`);
  assert.deepEqual([one.groupId, one.version, one.address], [G1, "1.x", "h-a1:8443"]);
  assert.equal(parseLink(`https://h-a1:8443/nifi/?processGroupId=${G1}&componentIds=abc-def`).groupId, G1);
  for (const tail of ["", "/", `/Processor/${G2}`, `/bulk/${G2},${G3}`, "/edit", "?x=1"]) {
    const two = parseLink(`https://nifi-b2.corp:8443/nifi/#/process-groups/${G1.toUpperCase()}${tail}`);
    assert.deepEqual([two.groupId, two.version, two.address], [G1, "2.x", "nifi-b2.corp:8443"], tail);
  }
  assert.equal(parseLink(`https://NIFI-B2.corp./nifi/#/process-groups/${G1}`).address, "nifi-b2.corp:443", "lower case, no trailing dot, the scheme's port");
  assert.equal(parseLink(`http://h-a1/nifi/?processGroupId=${G1}`).address, "h-a1:80");
  assert.equal(parseLink(`https://h:8443/nifi/?processGroupId=${G1}#/process-groups/${G2}`).groupId, G2, "2.x is tried first");
});

test("parseLink: root, no group, not an address", () => {
  for (const link of ["https://h:8443/nifi/#/process-groups/root", "https://h:8443/nifi/#/process-groups/ROOT/Processor/x", "https://h:8443/nifi/?processGroupId=root"])
    assert.throws(() => parseLink(link), (e: RegError) => e.code === "register/root-group" && e.status === 400, link);
  for (const link of ["https://h:8443/nifi/", "https://h:8443/nifi/#/", "https://h:8443/nifi/?processGroupId=not-an-id", "not a url", "ftp://h/nifi/?processGroupId=" + G1, "https://h:8443/nifi/#/process-groups/short"])
    assert.throws(() => parseLink(link), (e: RegError) => e.code === "register/bad-link", link);
});

test("resolveLink: any node of a cluster is the cluster, a member's several names, the service's web address", () => {
  const store = new Store(":memory:");
  seed(store);
  const at = (host: string) => resolveLink(store, { link: `https://${host}/nifi/?processGroupId=${G1}` }).service;
  assert.equal(at("h-a1:8443"), "n1");
  assert.equal(at("nifi-b1.corp:8443"), "c2");
  assert.equal(at("NIFI-B2.corp:8443"), "c2", "the other node is the same service");
  assert.equal(at("h-b2:8443"), "c2", "the member's host id too (skeleton's set)");
  assert.equal(at("nifi-lb.corp"), "c2", "the service's web address (port 443)");
  // The set is the skeleton's, with the HTTP port added.
  assert.ok(serviceAddresses(store).get("n1")!.has("h-a1:8443"));
});

test("resolveLink: an address no service has, two services with one address, a hint", () => {
  const store = new Store(":memory:");
  seed(store);
  store.addStandalone({ kind: "standalone", id: "n9", service: "nifi", profile: "nifi-1.x", version: "1.12.1", webUrl: null, member: member("h-a1", 8443, { installDir: "/opt/other" }) } as never, "uat", admin);
  const link = (host: string) => `https://${host}/nifi/?processGroupId=${G1}`;
  assert.throws(() => resolveLink(store, { link: link("proxy.corp:9000") }), (e: RegError) => e.code === "register/unknown-address" && (e.extra.services as string[]).join() === "c2,n1,n9");
  assert.throws(() => resolveLink(store, { link: link("localhost:8443") }), (e: RegError) => e.code === "register/unknown-address");
  assert.throws(() => resolveLink(store, { link: link("h-a1:8443") }), (e: RegError) => e.code === "register/ambiguous-address" && (e.extra.services as string[]).join() === "n1,n9");
  assert.equal(resolveLink(store, { link: link("proxy.corp:9000"), service: "c2" }).service, "c2", "the hint takes only the group id");
  assert.equal(resolveLink(store, { link: link("h-a1:8443"), service: "n9" }).service, "n9");
  assert.throws(() => resolveLink(store, { link: link("proxy.corp:9000"), service: "nope" }), (e: RegError) => e.code === "register/unknown-address");
});

function setup() {
  const store = new Store(":memory:");
  seed(store);
  store.putFlow(flow("flw_aaaaaa", "订单入库"));
  store.putFlow(flow("flw_bbbbbb", "对账"));
  reads.length = 0;
  return { store, regs: new Registrations(store, reader) };
}
const l1 = (g: string, host = "h-a1:8443") => `https://${host}/nifi/?processGroupId=${g}&componentIds=`;
const l2 = (g: string, host = "nifi-b2.corp:8443") => `https://${host}/nifi/#/process-groups/${g}`;

test("add: registers the groups, one change row per service, names and path from the read", async () => {
  const { store, regs } = setup();
  const out = await regs.add("flw_aaaaaa", [l1(G1), l1(G2), l2(G3)], admin);
  assert.deepEqual(out.added.map((a) => [a.service, a.group.name, a.group.path]), [["n1", "收单", "NiFi Flow / 订单 / 收单"], ["n1", "入库", "NiFi Flow / 入库"], ["c2", "对账", "NiFi Flow / 对账"]]);
  assert.equal(out.published, false);
  const rows = store.flowRegistrations({ owner: "flw_aaaaaa" });
  assert.deepEqual(rows.map((r) => [r.service, r.groupId, r.role, r.slice, r.registeredBy]), [["n1", G1, "segment", "*", "admin@x"], ["n1", G2, "segment", "*", "admin@x"], ["c2", G3, "segment", "*", "admin@x"]]);
  assert.equal(rows[0]!.link, l1(G1));
  const changes = store.flowChanges({ flow: "flw_aaaaaa" });
  assert.deepEqual(changes.map((c) => [c.service, c.kind]).sort(), [["c2", "add-group"], ["n1", "add-group"]], "a change touching two services is two rows");
  assert.ok(changes.find((c) => c.service === "n1")!.text.includes("收单") && changes.find((c) => c.service === "n1")!.text.includes("入库"));
  // Adding a group the business has again (or one inside it) changes nothing.
  const again = await regs.add("flw_aaaaaa", [l1(G1)], admin);
  assert.deepEqual([again.added.length, again.unchanged.length], [0, 1]);
  assert.equal(store.flowRegistrations({ owner: "flw_aaaaaa" }).length, 3);
});

test("add: a group that is not there, the same group in two links, bad input", async () => {
  const { store, regs } = setup();
  const gone = "deadbeef-0000-0000-0000-000000000000";
  const e = await refused(regs.add("flw_aaaaaa", [l1(G1), l1(gone)], admin), "register/group-missing");
  assert.equal(e.status, 404);
  assert.deepEqual(e.extra.groups, [{ service: "n1", group: gone, link: l1(gone) }]);
  assert.equal(store.flowRegistrations().length, 0, "nothing was written");
  assert.equal((await regs.add("flw_aaaaaa", [l1(G1), l2(G1, "h-a1:8443")], admin)).added.length, 1, "one group, two links: once");
  await refused(regs.add("flw_nope", [l1(G1)], admin), "register/not-found");
  await refused(regs.add("flw_aaaaaa", [], admin), "register/bad-request");
  await refused(regs.add("flw_aaaaaa", Array.from({ length: 21 }, () => l1(G1)), admin), "register/bad-request");
  await refused(regs.add("flw_aaaaaa", [l1("root")], admin), "register/root-group");
  await refused(regs.add("flw_aaaaaa", ["https://proxy.corp/nifi/?processGroupId=" + G1], admin), "register/unknown-address");
  const noReader = new Registrations(store);
  await refused(noReader.add("flw_aaaaaa", [l1(G1)], admin), "register/executor-old");
});

test("add: the executor's own refusals pass through (old, offline)", async () => {
  const { store } = setup();
  for (const code of ["register/executor-old", "register/executor-offline"] as const) {
    const regs = new Registrations(store, { read: async () => { throw new RegError(code, "x"); } });
    const e = await refused(regs.add("flw_aaaaaa", [l1(G1)], admin), code);
    assert.equal(e.status, 503);
  }
});

test("add: a group another business has is refused, so is one inside or around it; the answer names who has it", async () => {
  const { store, regs } = setup();
  await regs.add("flw_aaaaaa", [l1(G1)], admin);
  const same = await refused(regs.add("flw_bbbbbb", [l1(G1)], admin), "register/group-taken");
  assert.equal(same.status, 409);
  const taken = same.extra.taken as { relation: string; group: { id: string }; by: { kind: string; id: string; name: string; registeredBy: string } }[];
  assert.deepEqual([taken[0]!.relation, taken[0]!.group.id, taken[0]!.by], ["same", G1, { kind: "flow", id: "flw_aaaaaa", name: "订单入库", registeredBy: "admin@x" }]);
  assert.deepEqual((same.extra.options as { kind: string }[]).map((o) => o.kind), ["shared", "slice"], "the two ways out");
  // The parent of a registered group contains it; another business's registered group inside is also taken.
  const around = await refused(regs.add("flw_bbbbbb", [l1(PARENT)], admin), "register/group-taken");
  assert.equal((around.extra.taken as { relation: string }[])[0]!.relation, "contains");
  // A group inside a registered one: G2's child. The fake canvas gets one.
  const child = "c0c0c0c0-0178-1000-aaaa-000000000001";
  canvas.n1!.push({ id: child, exists: true, name: "收单子组", path: [{ id: ROOT_ID, name: "NiFi Flow" }, { id: PARENT, name: "订单" }, { id: G1, name: "收单" }] });
  try {
    const inside = await refused(regs.add("flw_bbbbbb", [l1(child)], admin), "register/group-taken");
    assert.equal((inside.extra.taken as { relation: string }[])[0]!.relation, "inside");
    // The same business adding a group inside its own registered group: nothing new (it is included already).
    const own = await regs.add("flw_aaaaaa", [l1(child)], admin);
    assert.deepEqual([own.added.length, own.unchanged.length], [0, 1]);
  } finally { canvas.n1!.pop(); }
  assert.equal(store.flowRegistrations({ service: "n1" }).length, 1, "the refused ones wrote nothing");
  // Another service's group is not taken: ids are per service.
  await regs.add("flw_bbbbbb", [l2(G3)], admin);
  // A shared module's group is taken as well, and the answer says it is a module.
  sql(store).prepare("INSERT INTO shared_modules (id, name, created_by, created_at, updated_at) VALUES ('shm_aaaaaa', '公共校验', 'a', 'x', 'x')").run();
  store.flowTransaction(() => store.addFlowRegistrations([{ owner: "shm_aaaaaa", role: "shared", service: "n1", groupId: G2, groupName: "入库", groupPath: null, slice: "*", link: null, registeredBy: "a" }]));
  const mod = await refused(regs.add("flw_bbbbbb", [l1(G2)], admin), "register/group-taken");
  assert.deepEqual((mod.extra.taken as { by: { kind: string; name: string } }[])[0]!.by.kind, "module");
});

test("remove: takes groups out, one change row per service, the last one stays (unregister does that)", async () => {
  const { store, regs } = setup();
  await regs.add("flw_aaaaaa", [l1(G1), l1(G2), l2(G3)], admin);
  const out = regs.remove("flw_aaaaaa", [{ service: "n1", group: G1 }, { service: "c2", group: G3.toUpperCase() }], admin);
  assert.deepEqual(out.removed, [{ service: "n1", group: G1 }, { service: "c2", group: G3 }]);
  assert.deepEqual(store.flowRegistrations({ owner: "flw_aaaaaa" }).map((r) => r.groupId), [G2]);
  const rm = store.flowChanges({ flow: "flw_aaaaaa" }).filter((c) => c.kind === "remove-group");
  assert.deepEqual(rm.map((c) => c.service).sort(), ["c2", "n1"]);
  assert.throws(() => regs.remove("flw_aaaaaa", [{ service: "n1", group: G1 }], admin), (e: RegError) => e.code === "register/not-found");
  assert.throws(() => regs.remove("flw_aaaaaa", [{ service: "n1", group: G2 }], admin), (e: RegError) => e.code === "register/empty" && e.status === 409);
  assert.throws(() => regs.remove("flw_aaaaaa", "x", admin), (e: RegError) => e.code === "register/bad-request");
  assert.equal(store.flowRegistrations({ owner: "flw_aaaaaa" }).length, 1);
});

test("rename: the business's name is a person's from now on, and the history says so", async () => {
  const { store, regs } = setup();
  await regs.add("flw_aaaaaa", [l1(G1), l2(G3)], admin);
  assert.deepEqual(regs.rename("flw_aaaaaa", "  订单全流程 ", admin), { flow: "flw_aaaaaa", name: "订单全流程" });
  const f = store.flow("flw_aaaaaa")!;
  assert.deepEqual([f.name, f.nameBy], ["订单全流程", "person"]);
  assert.deepEqual(store.flowChanges({ flow: "flw_aaaaaa" }).filter((c) => c.kind === "rename").map((c) => c.service).sort(), ["c2", "n1"]);
  assert.throws(() => regs.rename("flw_aaaaaa", "", admin), (e: RegError) => e.code === "register/bad-request");
  assert.throws(() => regs.rename("flw_aaaaaa", "x".repeat(201), admin), (e: RegError) => e.code === "register/bad-request");
  assert.throws(() => regs.rename("flw_zzz", "x", admin), (e: RegError) => e.code === "register/not-found");
});

test("unregister: the business and its groups go, the history stays, and the groups can be registered again", async () => {
  const { store, regs } = setup();
  await regs.add("flw_aaaaaa", [l1(G1), l2(G3)], admin);
  const out = regs.unregister({ flow: "flw_aaaaaa" }, admin);
  assert.deepEqual(out.removed, { flow: "flw_aaaaaa", groups: 2 });
  assert.equal(store.flow("flw_aaaaaa"), null);
  assert.equal(store.flowRegistrations().length, 0);
  assert.deepEqual(store.flowChanges({ flow: "flw_aaaaaa" }).filter((c) => c.kind === "unregister").map((c) => c.service).sort(), ["c2", "n1"]);
  assert.equal((await regs.add("flw_bbbbbb", [l1(G1)], admin)).added.length, 1);
  assert.throws(() => regs.unregister({ flow: "flw_aaaaaa" }, admin), (e: RegError) => e.code === "register/not-found");
  assert.throws(() => regs.unregister({}, admin), (e: RegError) => e.code === "register/bad-request");
  assert.throws(() => regs.unregister({ flow: "flw_bbbbbb", module: "shm_x" }, admin), (e: RegError) => e.code === "register/bad-request");
  // A shared module: its groups and the module go.
  sql(store).prepare("INSERT INTO shared_modules (id, name, created_by, created_at, updated_at) VALUES ('shm_aaaaaa', '公共校验', 'a', 'x', 'x')").run();
  store.flowTransaction(() => store.addFlowRegistrations([{ owner: "shm_aaaaaa", role: "shared", service: "n1", groupId: G2, groupName: "入库", groupPath: null, slice: "*", link: null, registeredBy: "a" }]));
  assert.deepEqual(regs.unregister({ module: "shm_aaaaaa" }, admin).removed, { module: "shm_aaaaaa", groups: 1 });
  assert.equal(store.sharedModule("shm_aaaaaa"), null);
  assert.throws(() => regs.unregister({ module: "shm_aaaaaa" }, admin), (e: RegError) => e.code === "register/not-found");
});

test("the three tables exist on a store that had none (create if not exists), and unregistering cascades the handoffs", () => {
  const store = new Store(":memory:");
  const names = (sql(store).prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
  for (const t of ["flow_registrations", "shared_modules", "flow_handoffs"]) assert.ok(names.includes(t), t);
  store.putFlow(flow("flw_aaaaaa", "x"));
  sql(store).prepare("INSERT INTO flow_handoffs (id, flow, from_service, from_group, from_component, quote, declared_by, declared_at) VALUES ('hof_aaaaaa', 'flw_aaaaaa', 'n1', 'g', 'c', '口头', 'a', 'x')").run();
  store.deleteFlow("flw_aaaaaa");
  assert.equal((sql(store).prepare("SELECT COUNT(*) AS n FROM flow_handoffs").get() as { n: number }).n, 0);
});

// --- the route ---------------------------------------------------------------------------------------------------

const person = (id: string): Principal => ({ id, displayName: id, via: "key", keyKind: "personal", groups: ["deploy-viewer"], isAdmin: false, permissions: permissionsFor(["deploy-viewer"], false), csrfToken: "" });
const bot = (id: string, keyKind: "service" | "checkup"): Principal => ({ id, displayName: id, via: "service", keyKind, groups: [], isAdmin: false, permissions: ["view"], csrfToken: "" });
const KEYS: Record<string, Principal> = { dpk_viewer: person("v@x"), dps_assistant: bot("service:assistant", "service"), dpc_checkup: bot("checkup:checkup", "checkup") };

function route() {
  const dir = mkdtempSync(join(tmpdir(), "registration-"));
  const environmentFile = join(dir, "environment.json");
  writeFileSync(environmentFile, JSON.stringify({ name: "uat", project: "open-atlas", bindIp: "127.0.0.1", registries: {}, apps: {} }));
  const fetcher = (async () => Response.json({ error: "auth/unauthorized" }, { status: 401 })) as typeof fetch;
  const config = { bind: "127.0.0.1", port: 0, basePath: "/deploy", dataDir: dir, workbenchUrl: "http://workbench:8090", workbenchPublicUrl: "/", environmentFile, observeUrls: {}, secureCookies: false, webDir: join(dir, "web"), templatesDir: join(dir, "templates"), initialManifestsDir: join(dir, "manifests"), peerKeySha256: [], githubApi: "https://api.github.com", omaVaults: [], omaAssessorVaults: [], briefHour: 8, deployerReleaseTag: "v{version}" } as unknown as Config;
  const store = new Store(":memory:");
  const handoff = new Handoff(store);
  const observer = new Observer({}, fetcher);
  const deployments = new Deployments(store, handoff, observer, environmentFile, {});
  const keys = { resolve: async (bearer: string) => KEYS[bearer] } as unknown as Keys;
  const box = new SecretBox(Buffer.alloc(32, 9).toString("base64"));
  const env = new EnvManager(store, deployments, new Schemas(undefined, join(dir, "templates"), fetcher), box, "compare");
  const app = createApp({ config, store, keys, groupReader: reader, sessions: new WorkbenchSessions(config.workbenchUrl, fetcher), observer, deployments, versions: new Versions(undefined, fetcher), env, workbench: new WorkbenchAdmin(config.workbenchUrl, () => "", fetcher) });
  seed(store);
  store.putFlow(flow("flw_aaaaaa", "订单入库"));
  const post = async (action: string, body: unknown, key?: string) => {
    const headers = new Headers({ "content-type": "application/json" });
    if (key) headers.set("authorization", `Bearer ${key}`);
    const res = await app.request(`/deploy/api/registrations/${action}`, { method: "POST", headers, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { store, post };
}

test("route: who may call, request_id on writes, the actions of this step and the ones that wait", async () => {
  const t = route();
  assert.equal((await t.post("add", { flow: "flw_aaaaaa", links: [l1(G1)], request_id: "r1" })).status, 401, "not signed in");
  assert.equal((await t.post("add", { flow: "flw_aaaaaa", links: [l1(G1)], request_id: "r1" }, "dpc_checkup")).status, 403, "the check-up only reads");
  const no = await t.post("add", { flow: "flw_aaaaaa", links: [l1(G1)] }, "dpk_viewer");
  assert.deepEqual([no.status, no.body.error], [400, "register/bad-request"]);
  // A viewer with no admin right may register; so may the Assistant.
  const add = await t.post("add", { flow: "flw_aaaaaa", links: [l1(G1), l2(G3)], request_id: "r2" }, "dpk_viewer");
  assert.equal(add.status, 200, JSON.stringify(add.body));
  assert.deepEqual(add.body.added.map((a: { service: string }) => a.service), ["n1", "c2"]);
  const taken = await t.post("add", { flow: "flw_aaaaaa", links: [l1(G2)], request_id: "r3" }, "dps_assistant");
  assert.equal(taken.status, 200);
  t.store.putFlow(flow("flw_bbbbbb", "对账"));
  const dup = await t.post("add", { flow: "flw_bbbbbb", links: [l1(G1)], request_id: "r4" }, "dps_assistant");
  assert.deepEqual([dup.status, dup.body.error, dup.body.taken[0].by.name, dup.body.options.length], [409, "register/group-taken", "订单入库", 2]);
  const root = await t.post("add", { flow: "flw_bbbbbb", links: ["https://h-a1:8443/nifi/#/process-groups/root"], request_id: "r5" }, "dpk_viewer");
  assert.deepEqual([root.status, root.body.error], [400, "register/root-group"]);
  const unk = await t.post("add", { flow: "flw_bbbbbb", links: [l1(G1, "proxy.corp:1")], request_id: "r6" }, "dpk_viewer");
  assert.deepEqual([unk.status, unk.body.error, unk.body.services], [400, "register/unknown-address", ["c2", "n1"]]);
  const rn = await t.post("rename", { flow: "flw_aaaaaa", name: "订单全流程", request_id: "r7" }, "dpk_viewer");
  assert.deepEqual([rn.status, rn.body.name], [200, "订单全流程"]);
  assert.equal((await t.post("remove", { flow: "flw_aaaaaa", groups: [{ service: "c2", group: G3 }], request_id: "r8" }, "dpk_viewer")).status, 200);
  assert.equal((await t.post("unregister", { flow: "flw_bbbbbb", request_id: "r9" }, "dpk_viewer")).status, 200);
  assert.equal((await t.post("unregister", { flow: "flw_bbbbbb", request_id: "r10" }, "dpk_viewer")).status, 404);
  for (const action of ["preview", "commit", "declare-handoff", "shared"]) {
    const later = await t.post(action, { links: [l1(G1)] }, "dpk_viewer");
    assert.deepEqual([later.status, later.body.error], [501, "register/not-implemented"], action);
  }
  assert.equal((await t.post("nope", {}, "dpk_viewer")).status, 404);
});
