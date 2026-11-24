// S39 step 6: the MCP verb register. Who sees it (not the check-up; publish_model no longer the Assistant's), the
// Assistant's key fills drafts only (commit, unregister and a business's changes without a draft are a person's:
// register/person-only), a draft of a registered business's changes, and a refusal keeps its details for the AI.

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
import type { Topology, TopologyFragment, TopologyNeighbor } from "../src/server/services/flowcounts.ts";
import type { GroupInfo, GroupReader } from "../src/server/services/registration.ts";
import { Store } from "../src/server/store.ts";
import { Versions } from "../src/server/versions.ts";

const ROOT = { id: "aaaaaaaa-0000-0000-0000-000000000000", name: "NiFi Flow" };
const C = "00000000-0000-0000-0000-000000000003", D = "00000000-0000-0000-0000-000000000004";
const link = (g: string) => `https://h-a1:8443/nifi/?processGroupId=${g}&componentIds=`;
const frag = (more: Partial<TopologyFragment> = {}): TopologyFragment => ({ key: "f", processors: 1, names: [], inputs: [], outputs: [], remoteIn: [], s2sOut: [], starts: 0, ...more });
const near = (group: string, side: "in" | "out", port: { id: string; name: string }, other: { id: string; name: string; port: { id: string; name: string } }): TopologyNeighbor =>
  ({ group, connection: "conn-cd", side, port, relationships: [], other: { kind: "group", id: other.id, name: other.name, group: ROOT.id, port: other.port, registered: true } } as TopologyNeighbor);
/** n1: C sends to D on the canvas; D writes a file. */
const canvas: Record<string, { name: string; frag: TopologyFragment; near: TopologyNeighbor[]; ends?: NonNullable<Topology["ends"]> }> = {
  [C]: { name: "对账收", frag: frag({ starts: 1, outputs: ["out"] }), near: [near(C, "out", { id: "c-out", name: "out" }, { id: D, name: "对账写", port: { id: "d-in", name: "in" } })] },
  [D]: { name: "对账写", frag: frag({ inputs: ["in"] }), near: [near(D, "in", { id: "d-in", name: "in" }, { id: C, name: "对账收", port: { id: "c-out", name: "out" } })],
    ends: [{ id: "put-d", name: "PutFile", type: "PutFile", group: D, fragment: null, relationships: ["success"] }] },
};
const reader: GroupReader = {
  async read(s, ids) { return (await this.scan(s, ids)).groups; },
  async scan(_s, ids) {
    const groups: GroupInfo[] = ids.map((x) => canvas[x] ? { id: x, exists: true, name: canvas[x]!.name, path: [ROOT] } : { id: x, exists: false });
    const here = ids.filter((x) => canvas[x]);
    const topology = { scope: "groups", root: ROOT, links: [], s2sOut: [], s2sIn: [], missing: [], ends: here.flatMap((x) => canvas[x]!.ends ?? []),
      groups: here.map((x) => ({ id: x, name: canvas[x]!.name, root: false, parent: ROOT.id, path: [ROOT], fragments: [canvas[x]!.frag] })),
      neighbors: here.flatMap((x) => canvas[x]!.near) } as unknown as Topology;
    return { groups, topology };
  },
};

const person = (id: string): Principal => ({ id, displayName: id, via: "key", keyKind: "personal", groups: ["deploy-viewer"], isAdmin: false, permissions: permissionsFor(["deploy-viewer"], false), csrfToken: "" });
const bot = (id: string, keyKind: "service" | "checkup"): Principal => ({ id, displayName: id, via: "service", keyKind, groups: [], isAdmin: false, permissions: ["view"], csrfToken: "" });
const KEYS: Record<string, Principal> = { dpk_owner: person("owner@x"), dps_assistant: bot("service:assistant", "service"), dpc_checkup: bot("checkup:checkup", "checkup") };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "register-assistant-"));
  const environmentFile = join(dir, "environment.json");
  writeFileSync(environmentFile, JSON.stringify({ name: "uat", project: "open-atlas", bindIp: "127.0.0.1", registries: {}, apps: {} }));
  const fetcher = (async () => Response.json({ error: "auth/unauthorized" }, { status: 401 })) as unknown as typeof fetch;
  const config = { bind: "127.0.0.1", port: 0, basePath: "/deploy", dataDir: dir, workbenchUrl: "http://workbench:8090", workbenchPublicUrl: "/", environmentFile, observeUrls: {}, secureCookies: false, webDir: join(dir, "web"), templatesDir: join(dir, "templates"), initialManifestsDir: join(dir, "manifests"), peerKeySha256: [], githubApi: "https://api.github.com", omaVaults: [], omaAssessorVaults: [], briefHour: 8, deployerReleaseTag: "v{version}" } as unknown as Config;
  const store = new Store(":memory:");
  const handoff = new Handoff(store);
  const observer = new Observer({}, fetcher);
  const deployments = new Deployments(store, handoff, observer, environmentFile, {});
  const keys = { resolve: async (bearer: string) => KEYS[bearer] } as unknown as Keys;
  const env = new EnvManager(store, deployments, new Schemas(undefined, join(dir, "templates"), fetcher), new SecretBox(Buffer.alloc(32, 9).toString("base64")), "compare");
  const app = createApp({ config, store, keys, groupReader: reader, sessions: new WorkbenchSessions(config.workbenchUrl, fetcher), observer, deployments, versions: new Versions(undefined, fetcher), env, workbench: new WorkbenchAdmin(config.workbenchUrl, () => "", fetcher) });
  store.addStandalone({ kind: "standalone", id: "n1", service: "nifi", profile: "nifi-1.x", version: "1.12.1", webUrl: "https://h-a1:8443/nifi",
    member: { host: "h-a1", installDir: "/opt/n1", serviceUser: "nifi", startEnvironment: null, ports: { https: 8443 }, discovery: null } } as never, "uat", { id: "admin", via: "cli" });
  let id = 0, rid = 0;
  const rpc = async (key: string, method: string, params?: unknown) => (await (await app.request("/deploy/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, ...(params ? { params } : {}) }) })).json()) as any;
  const names = async (key: string) => ((await rpc(key, "tools/list")).result.tools as { name: string }[]).map((t) => t.name);
  const register = async (key: string, args: Record<string, unknown>) => {
    const body = await rpc(key, "tools/call", { name: "register", arguments: { ...args, request_id: `r${++rid}` } });
    return { isError: Boolean(body.result.isError), value: JSON.parse(body.result.content[0].text) };
  };
  const http = async (key: string, method: string, path: string) => { const res = await app.request(`/deploy/api/${path}`, { method, headers: { authorization: `Bearer ${key}` } }); return { status: res.status, body: (await res.json()) as any }; };
  return { store, names, register, http };
}

test("register: the Assistant and people see it, the check-up does not; publish_model is no longer the Assistant's", async () => {
  const t = setup();
  const assistant = await t.names("dps_assistant"), owner = await t.names("dpk_owner"), checkup = await t.names("dpc_checkup");
  assert.ok(assistant.includes("register") && owner.includes("register"));
  assert.ok(!checkup.includes("register"), "the check-up only looks at health");
  assert.ok(!assistant.includes("publish_model"), "internal now");
  assert.ok(checkup.includes("publish_model"), "until step 7 decides");
  assert.equal((await t.register("dpk_owner", { action: "nope" })).value.finding.code, "mcp/arguments");
});

test("register: the Assistant fills a draft, a refusal keeps gaps and preview, and only a person commits", async () => {
  const t = setup();
  const d = (await t.register("dps_assistant", { action: "draft" })).value;
  assert.match(d.draft, /^rgd_/);
  const added = await t.register("dps_assistant", { action: "add", draft: d.draft, links: [link(C)] });
  assert.equal(added.isError, false, JSON.stringify(added.value));
  const preview = (await t.register("dps_assistant", { action: "preview", draft: d.draft })).value;
  const gap = preview.gaps.find((g: { kind: string }) => g.kind === "exit-unregistered");
  assert.ok(gap, JSON.stringify(preview.gaps));

  await t.register("dps_assistant", { action: "rename", draft: d.draft, name: "对账" });
  // The Assistant's key never commits; it says so in a way the model can act on.
  const own = await t.register("dps_assistant", { action: "commit", draft: d.draft });
  assert.deepEqual([own.isError, own.value.finding.code], [true, "register/person-only"]);
  // The person's commit with the gap open: the gaps and the preview come back to the AI as they are.
  const open = await t.register("dpk_owner", { action: "commit", draft: d.draft });
  assert.equal(open.value.finding.code, "register/gaps-open");
  assert.ok(open.value.gaps.some((g: { kind: string }) => g.kind === "exit-unregistered"), "gaps passed through");
  assert.ok(Array.isArray(open.value.preview.segments), "preview passed through");

  // The owner tells where the data goes; the Assistant records it in the draft; the person commits.
  const told = await t.register("dps_assistant", { action: "declare-handoff", draft: d.draft, from: { service: "n1", group: C, component: gap.component }, to: { system: "对账系统" }, quote: "交给对账系统" });
  assert.equal(told.isError, false, JSON.stringify(told.value));
  const done = (await t.register("dpk_owner", { action: "commit", draft: d.draft })).value;
  assert.match(done.flow, /^flw_/);
  assert.equal(done.name, "对账");
  assert.equal(t.store.flowHandoffs(done.flow).length, 1);

  // Another draft wanting the same group: group-taken with who has it.
  const other = (await t.register("dps_assistant", { action: "draft" })).value;
  const taken = await t.register("dps_assistant", { action: "add", draft: other.draft, links: [link(C)] });
  assert.equal(taken.value.finding.code, "register/group-taken");
  assert.equal(taken.value.taken[0].by.id, done.flow, "taken passed through");
});

test("register: a registered business changes through a draft of it, which a person confirms", async () => {
  const t = setup();
  const d = (await t.register("dpk_owner", { action: "draft", name: "对账" })).value;
  await t.register("dpk_owner", { action: "add", draft: d.draft, links: [link(C)] });
  await t.register("dpk_owner", { action: "declare-handoff", draft: d.draft, from: { service: "n1", group: C, component: "c-out" }, to: { system: "对账系统" }, quote: "先交给对账系统" });
  const flow = (await t.register("dpk_owner", { action: "commit", draft: d.draft })).value.flow as string;

  // Without a draft the Assistant changes nothing, nor unregisters.
  for (const args of [{ action: "add", flow, links: [link(D)] }, { action: "rename", flow, name: "x" }, { action: "unregister", flow }]) {
    const r = await t.register("dps_assistant", args);
    assert.equal(r.value.finding.code, "register/person-only", JSON.stringify(args));
  }
  assert.deepEqual(t.store.flowRegistrations({ owner: flow }).map((r) => r.groupId), [C]);

  // A draft of its changes starts as a copy; D joins, the told hand-over gives way to the canvas link, a new name.
  const e = (await t.register("dps_assistant", { action: "draft", flow })).value;
  assert.deepEqual([e.flow, e.name, e.groups.map((g: { group: { id: string } }) => g.group.id), e.handoffs.length], [flow, "对账", [C], 1]);
  assert.equal((await t.register("dps_assistant", { action: "add", draft: e.draft, links: [link(D)] })).isError, false);
  await t.register("dps_assistant", { action: "declare-handoff", draft: e.draft, remove: e.handoffs[0].id });
  await t.register("dps_assistant", { action: "rename", draft: e.draft, name: "对账入档" });
  const p = (await t.register("dps_assistant", { action: "preview", draft: e.draft })).value;
  assert.deepEqual(p.gaps, []);
  assert.equal(t.store.flowRegistrations({ owner: flow }).length, 1, "nothing changed before the person confirms");
  assert.equal((await t.register("dps_assistant", { action: "commit", draft: e.draft })).value.finding.code, "register/person-only");

  const r = (await t.register("dpk_owner", { action: "commit", draft: e.draft })).value;
  assert.deepEqual([r.flow, r.name, r.published], [flow, "对账入档", true]);
  assert.deepEqual(t.store.flowRegistrations({ owner: flow }).map((x) => x.groupId).sort(), [C, D]);
  assert.equal(t.store.flowHandoffs(flow).length, 0);
  assert.equal(t.store.flow(flow)!.name, "对账入档");
  const kinds = new Set(t.store.flowChanges({ flow }).map((c) => c.kind));
  for (const k of ["add-group", "declare-handoff", "rename"]) assert.ok(kinds.has(k as never), k);
  assert.equal(t.store.registrationDraft(e.draft), null, "the draft is gone");
  // A draft with no change confirms to nothing.
  const same = (await t.register("dps_assistant", { action: "draft", flow })).value;
  const none = (await t.register("dpk_owner", { action: "commit", draft: same.draft })).value;
  assert.deepEqual([none.published, none.revisions], [false, []]);
});

test("pages: the business list, its registration block, the drafts that change it, the cards' business counts", async () => {
  const t = setup();
  const d = (await t.register("dpk_owner", { action: "draft", name: "对账" })).value;
  await t.register("dpk_owner", { action: "add", draft: d.draft, links: [link(C)] });
  await t.register("dpk_owner", { action: "declare-handoff", draft: d.draft, from: { service: "n1", group: C, component: "c-out" }, to: { system: "对账系统" }, quote: "先交给对账系统" });
  const flow = (await t.register("dpk_owner", { action: "commit", draft: d.draft })).value.flow as string;

  const list = (await t.http("dpk_owner", "GET", "businesses")).body.businesses;
  assert.deepEqual(list.map((b: { id: string; name: string; groupCount: number; handoffCount: number; registeredBy: string; services: string[] }) => [b.id, b.name, b.groupCount, b.handoffCount, b.registeredBy, b.services]), [[flow, "对账", 1, 1, "owner@x", ["n1"]]]);

  const detail = (await t.http("dpk_owner", "GET", `flows/${flow}`)).body;
  assert.equal(detail.registration.by, "owner@x");
  assert.deepEqual(detail.registration.groups.map((g: { id: string; name: string }) => [g.id, g.name]), [[C, "对账收"]]);
  assert.equal(detail.registration.handoffs[0].quote, "先交给对账系统");
  assert.ok(detail.registration.changes.length >= 1);
  assert.ok(detail.flow.graph.edges.some((e: { kind: string; label?: string }) => e.kind === "declared" && e.label === "先交给对账系统"), JSON.stringify(detail.flow.graph));

  // The assistant's modification draft is found by the business; a person discards it, the assistant cannot.
  const e = (await t.register("dps_assistant", { action: "draft", flow })).value;
  const found = (await t.http("dpk_owner", "GET", `registrations/drafts?flow=${flow}`)).body.drafts;
  assert.deepEqual(found.map((x: { draft: string }) => x.draft), [e.draft]);
  assert.equal((await t.http("dps_assistant", "DELETE", `registrations/drafts/${e.draft}`)).status, 403);
  assert.equal((await t.http("dpk_owner", "DELETE", `registrations/drafts/${e.draft}`)).status, 200);
  assert.deepEqual((await t.http("dpk_owner", "GET", `registrations/drafts?flow=${flow}`)).body.drafts, []);
  assert.equal((await t.http("dpk_owner", "GET", `registrations/drafts?flow=`)).status, 400);

  const card = (await t.http("dpk_owner", "GET", "services/overview")).body.services.find((c: { id: string }) => c.id === "n1");
  assert.equal(card.businesses.count, 1);
  const page = (await t.http("dpk_owner", "GET", "services/n1/page")).body;
  assert.equal(page.businessCount, 1);
  assert.ok(Array.isArray(page.affected));
});
