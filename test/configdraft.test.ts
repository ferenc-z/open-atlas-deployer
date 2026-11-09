// Phase 3 step 4 (§7, §13, §16.3): configuration drafts and revisions over HTTP: who may do what, a draft on an old
// revision, "(hidden)" refused, a secret's value only for an admin in a browser and nowhere else, a cluster's first edit
// splitting it into layers, what each member should have, and an old database getting it filled in.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { Handoff, hostIds } from "../src/server/handoff.ts";
import type { Keys } from "../src/server/keys.ts";
import { Observer } from "../src/server/observe.ts";
import { SecretBox } from "../src/server/secretbox.ts";
import { sealFile, type ConfigFileRecord, type ConfigMember, type ServiceConfigBody } from "../src/server/services/config.ts";
import type { DraftCluster, DraftStandalone } from "../src/server/services/draft.ts";
import { Takeover } from "../src/server/services/takeover.ts";
import { Store } from "../src/server/store.ts";
import { Versions } from "../src/server/versions.ts";

const box = new SecretBox(Buffer.alloc(32, 9).toString("base64"));
const cli = { id: "admin", via: "cli" } as const;
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

const USERS: Record<string, { groups: string[]; isAdmin?: boolean }> = {
  viewer: { groups: ["deploy-viewer"] }, uat: { groups: ["deploy-uat"] }, prod: { groups: ["deploy-prod"] }, admin: { groups: [], isAdmin: true }, nobody: { groups: ["sales"] },
};

const keyPrincipal = (id: string, via: "key" | "service", groups: string[], isAdmin = false): Principal => ({ id, displayName: id, via, groups, isAdmin, permissions: via === "service" ? ["view"] : permissionsFor(groups, isAdmin), csrfToken: "" });
const KEYS: Record<string, Principal> = {
  dpk_uat: keyPrincipal("u@x", "key", ["deploy-uat"]), dpk_prod: keyPrincipal("p@x", "key", ["deploy-prod"]), dpk_admin: keyPrincipal("a@x", "key", [], true), dps_assistant: keyPrincipal("assistant", "service", []),
};

function setup(name = "uat", store = new Store(":memory:")) {
  const dir = mkdtempSync(join(tmpdir(), "configdraft-"));
  const environmentFile = join(dir, "environment.json");
  writeFileSync(environmentFile, JSON.stringify({ name, project: "open-atlas", bindIp: "127.0.0.1", registries: {}, apps: {} }));
  const fetcher = (async (input: URL | string, init?: RequestInit) => {
    if (new URL(String(input)).pathname === "/health") return Response.json({ status: "ok" });
    const token = /open_atlas_workbench_session=([^;]+)/.exec(new Headers(init?.headers).get("cookie") ?? "")?.[1] ?? "";
    const user = USERS[token];
    if (!user) return Response.json({ error: "auth/unauthorized" }, { status: 401 });
    return Response.json({ user: { id: token, email: `${token}@x`, displayName: token, enabled: true, role: user.isAdmin ? "admin" : "member", isAdmin: !!user.isAdmin }, csrfToken: `csrf-${token}`, groups: user.groups });
  }) as typeof fetch;
  const config = { bind: "127.0.0.1", port: 0, basePath: "/deploy", dataDir: dir, workbenchUrl: "http://workbench:8090", workbenchPublicUrl: "/", environmentFile, observeUrls: {}, secureCookies: false, webDir: join(dir, "web"), templatesDir: join(dir, "templates"), initialManifestsDir: join(dir, "manifests"), peerKeySha256: [], githubApi: "https://api.github.com", omaVaults: [], omaAssessorVaults: [], briefHour: 8, deployerReleaseTag: "v{version}" } as unknown as Config;
  const handoff = new Handoff(store);
  const observer = new Observer({}, fetcher);
  const deployments = new Deployments(store, handoff, observer, environmentFile, {});
  const takeover = new Takeover({ store, handoff, box, environment: () => deployments.environment().env.name, hosts: () => hostIds(deployments.environment().env) });
  const keys = { resolve: async (bearer: string) => KEYS[bearer] } as unknown as Keys;
  const env = new EnvManager(store, deployments, new Schemas(undefined, join(dir, "templates"), fetcher), box, "compare");
  const app = createApp({ config, store, takeover, keys, sessions: new WorkbenchSessions(config.workbenchUrl, fetcher), observer, deployments, versions: new Versions(undefined, fetcher), env, workbench: new WorkbenchAdmin(config.workbenchUrl, () => "", fetcher) });
  type As = { as?: string; key?: string };
  const call = (method: string, path: string, who: As, body?: unknown) => {
    const headers = new Headers({ "content-type": "application/json" });
    if (who.as) { headers.set("cookie", `open_atlas_workbench_session=${who.as}`); headers.set("x-csrf-token", `csrf-${who.as}`); }
    if (who.key) headers.set("authorization", `Bearer ${who.key}`);
    return app.request(`/deploy${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  };
  return { app, store, call };
}

const NIFI = (over: Record<string, string>) => {
  const v: Record<string, string> = { "nifi.ui.banner.text": "", "nifi.web.https.port": "8443", "nifi.security.keystorePasswd": "keystore-s3cret", "nifi.sensitive.props.key": "props-s3cret", "nifi.cluster.is.node": "false", ...over };
  return `# NiFi\n${Object.entries(v).map(([k, x]) => `${k}=${x}`).join("\n")}\n`;
};
const AUTH = (password: string) => `<authorizers>\n  <property name="Password">${password}</property>\n  <property name="Url">ldap://x</property>\n</authorizers>\n`;

function memberOf(host: string, dir: string, files: Record<string, string>): ConfigMember {
  return { host, installDir: dir, missing: [], files: Object.entries(files).map(([name, text]) => sealFile({ name, path: `${dir}/conf/${name}`, modifiedAt: "2026-11-01T00:00:00Z" }, Buffer.from(text), box)) };
}

const serviceMember = (dir: string, https: number) => ({ host: "local", installDir: dir, serviceUser: "nifi", startEnvironment: null, ports: { https }, nodeAddress: null, discovery: null });

/** Takes over a standalone "solo" and a two-node cluster "flow" the way a confirmed draft does. */
function takenOver(store: Store) {
  const solo: DraftStandalone = { kind: "standalone", id: "solo", service: "nifi", profile: "nifi-2.x", version: "2.0.0", webUrl: null, member: serviceMember("/opt/solo", 7443) } as DraftStandalone;
  const flow: DraftCluster = { kind: "cluster", id: "flow", service: "nifi", profile: "nifi-2.x", version: "2.5.0", webUrl: null, zookeeper: "zk:2181", zookeeperRoot: "/flow", nodes: [serviceMember("/opt/a", 8443), serviceMember("/opt/b", 9443)] } as DraftCluster;
  const draft = store.createServiceDraft("uat", [], [solo, flow], cli);
  const node = (dir: string, https: string, password: string) => memberOf("local", dir, {
    "nifi.properties": NIFI({ "nifi.web.https.port": https, "nifi.cluster.is.node": "true", "nifi.security.keystorePasswd": `node-${https}-s3cret` }),
    "logback.xml": "<configuration/>\n",
    "authorizers.xml": AUTH(password),
  });
  const configs: Record<string, ServiceConfigBody> = {
    solo: { members: [memberOf("local", "/opt/solo", { "nifi.properties": NIFI({ "nifi.web.https.port": "7443" }), "authorizers.xml": AUTH("solo-xml-s3cret") })] },
    flow: { members: [node("/opt/a", "8443", "a-xml-s3cret"), node("/opt/b", "9443", "b-xml-s3cret")] },
  };
  store.confirmServiceDraft(draft.id, configs, cli);
}

const A = "local:/opt/a", B = "local:/opt/b";
const LEAK = /s3cret|new-pass|v1:|"sealed/;
const opened = (f: ConfigFileRecord) => Buffer.from(box.open(f.sealed), "base64").toString("latin1");
const fileIn = (store: Store, service: string, revision: number | undefined, member: string, name: string) =>
  store.serviceConfig(service, revision)!.body.members.find((m) => `${m.host}:${m.installDir}` === member)!.files.find((f) => f.name === name)!;
const BANNER = { file: "nifi.properties", key: "nifi.ui.banner.text", value: "hello" };

test("permissions in UAT (§13): viewers read, deploy-uat and its personal keys draft and save, the Assistant's key does not, only a browser admin reveals", async () => {
  const t = setup();
  takenOver(t.store);
  const drafts = "/api/services/solo/config/drafts";
  const create = (who: { as?: string; key?: string }) => t.call("POST", drafts, who, { changes: [BANNER] });

  assert.equal((await create({})).status, 401);
  for (const who of [{ as: "viewer" }, { as: "prod" }, { as: "nobody" }, { key: "dps_assistant" }]) assert.equal((await create(who)).status, 403, JSON.stringify(who));
  assert.equal((await t.app.request(`/deploy${drafts}`, { method: "POST", headers: { cookie: "open_atlas_workbench_session=uat" }, body: "{}" })).status, 403, "no CSRF token");

  const made = await (await create({ as: "uat" })).json();
  assert.equal(made.via, "workbench");
  const viaKey = await create({ key: "dpk_uat" });
  assert.equal(viaKey.status, 201, "UAT takes a personal key");
  assert.equal((await viaKey.json()).via, "key");
  assert.equal((await create({ as: "admin" })).status, 201);

  for (const who of [{ as: "viewer" }, { key: "dps_assistant" }]) {
    assert.equal((await t.call("GET", drafts, who)).status, 200);
    assert.equal((await t.call("GET", `${drafts}/${made.id}`, who)).status, 200);
    assert.equal((await t.call("GET", "/api/services/solo/config/diff", who)).status, 200);
    assert.equal((await t.call("PUT", `${drafts}/${made.id}`, who, { changes: [] })).status, 403);
    assert.equal((await t.call("DELETE", `${drafts}/${made.id}`, who)).status, 403);
    assert.equal((await t.call("POST", `${drafts}/${made.id}/save`, who, {})).status, 403);
  }
  assert.equal((await t.call("GET", drafts, { as: "nobody" })).status, 403);

  const flags = async (who: { as?: string; key?: string }) => { const c = await (await t.call("GET", "/api/services/solo/config", who)).json(); return [c.canDraft, c.canReveal]; };
  assert.deepEqual(await flags({ as: "viewer" }), [false, false]);
  assert.deepEqual(await flags({ as: "uat" }), [true, false]);
  assert.deepEqual(await flags({ as: "admin" }), [true, true]);
  assert.deepEqual(await flags({ key: "dpk_admin" }), [true, false]);

  const reveal = (who: { as?: string; key?: string }) => t.call("POST", "/api/services/solo/config/reveal", who, { file: "nifi.properties", key: "nifi.security.keystorePasswd" });
  for (const who of [{ as: "viewer" }, { as: "uat" }, { key: "dpk_uat" }, { key: "dps_assistant" }]) assert.equal((await reveal(who)).status, 403, JSON.stringify(who));
  const asKey = await reveal({ key: "dpk_admin" });
  assert.equal(asKey.status, 403);
  assert.equal((await asKey.json()).error, "auth/browser-only");
  assert.equal((await reveal({ as: "admin" })).status, 200);
});

test("permissions on PROD (§13, D7): deploy-prod in a browser only; no API key changes anything", async () => {
  const t = setup("prod");
  takenOver(t.store);
  const drafts = "/api/services/solo/config/drafts";
  const made = await t.call("POST", drafts, { as: "prod" }, { changes: [BANNER] });
  assert.equal(made.status, 201);
  const { id } = await made.json();
  assert.equal((await t.call("POST", drafts, { as: "uat" }, { changes: [BANNER] })).status, 403);
  for (const key of ["dpk_prod", "dpk_admin"]) {
    for (const r of [await t.call("POST", drafts, { key }, { changes: [BANNER] }), await t.call("PUT", `${drafts}/${id}`, { key }, { note: "x" }), await t.call("DELETE", `${drafts}/${id}`, { key }), await t.call("POST", `${drafts}/${id}/save`, { key }, {})]) {
      assert.equal(r.status, 403);
      assert.equal((await r.json()).error, "auth/browser-only");
    }
  }
  assert.equal((await t.call("GET", drafts, { key: "dpk_prod" })).status, 200, "reading is fine");
  assert.equal((await (await t.call("GET", "/api/services/solo/config", { key: "dpk_prod" })).json()).canDraft, false);
  assert.equal((await t.call("POST", `${drafts}/${id}/save`, { as: "prod" }, {})).status, 201);
  assert.equal((await t.call("POST", "/api/services/solo/config/reveal", { as: "prod" }, { file: "nifi.properties", key: "nifi.ui.banner.text" })).status, 403);
  assert.equal((await t.call("POST", "/api/services/solo/config/reveal", { as: "admin" }, { file: "nifi.properties", key: "nifi.ui.banner.text" })).status, 200);
});

test("a standalone: a draft is checked, not refused; saving changes one line, makes a revision and is pending until applied", async () => {
  const t = setup();
  takenOver(t.store);
  const drafts = "/api/services/solo/config/drafts";
  const before = opened(fileIn(t.store, "solo", 1, "local:/opt/solo", "nifi.properties"));
  const made = await (await t.call("POST", drafts, { as: "uat" }, { changes: [BANNER, { file: "nifi.properties", key: "nifi.web.https.port", value: "not-a-port" }], note: "try" })).json();
  assert.equal(made.base, 1);
  assert.equal(made.state, "open");
  assert.equal(made.stale, false);
  assert.ok(made.findings.some((f: any) => f.code === "config/bad-value" && f.severity === "error" && f.introduced), "findings do not stop a draft");
  assert.equal(made.preview.change.restart, true);
  assert.match(made.preview.members[0].files[0].diff, /\+ nifi\.ui\.banner\.text=hello/);
  assert.equal(t.store.serviceConfigRevisions("solo").length, 1, "a draft is not a revision");

  const saved = await t.call("POST", `${drafts}/${made.id}/save`, { as: "uat" }, { note: "banner" });
  assert.equal(saved.status, 201, "nor do they stop saving");
  const out = await saved.json();
  assert.equal(out.revision, 2);
  assert.equal(out.draft.state, "saved");
  assert.equal(out.draft.savedRevision, 2);

  const cfg = await (await t.call("GET", "/api/services/solo/config", { as: "viewer" })).json();
  assert.deepEqual([cfg.revision, cfg.source, cfg.base, cfg.note, cfg.savedBy], [2, "edit", 1, "banner", "uat@x"]);
  assert.ok(cfg.findings.some((f: any) => f.code === "config/bad-value"));
  assert.equal(cfg.revisions[0].base, 1);
  assert.equal(cfg.body.layers, undefined, "a standalone has no layers");
  const after = opened(fileIn(t.store, "solo", undefined, "local:/opt/solo", "nifi.properties"));
  assert.equal(after, before.replace("nifi.ui.banner.text=", "nifi.ui.banner.text=hello").replace("nifi.web.https.port=7443", "nifi.web.https.port=not-a-port"), "only those lines");

  // The timeline and the audit trail, and what the member should have: still the import.
  const events = await (await t.call("GET", "/api/services/solo/events", { as: "viewer" })).json();
  assert.ok(JSON.stringify(events).includes("Configuration revision 2 saved: banner"));
  const files = t.store.serviceMemberFiles("solo");
  assert.deepEqual(files.map((f) => [f.file, f.revision]), [["authorizers.xml", 1], ["nifi.properties", 1]]);
  const status = await (await t.call("GET", "/api/services/solo/status", { as: "viewer" })).json();
  assert.deepEqual(status.members[0].configPending, ["nifi.properties"]);
  assert.equal(files.find((f) => f.file === "nifi.properties")!.expectedSha256, sha(before));

  // Comparing two revisions, either way; the same revision has nothing to show.
  const diff = await (await t.call("GET", "/api/services/solo/config/diff?from=1&to=2", { as: "viewer" })).json();
  assert.deepEqual([diff.from, diff.to, diff.members[0].member, diff.members[0].files.map((f: any) => f.name)], [1, 2, "local:/opt/solo", ["nifi.properties"]]);
  assert.match(diff.members[0].files[0].diff, /\+ nifi\.web\.https\.port=not-a-port\n[^]*- nifi\.web\.https\.port=7443\n/);
  assert.ok(!diff.members[0].files[0].diff.includes("nifi.cluster.is.node"), "only around the changes");
  assert.deepEqual((await (await t.call("GET", "/api/services/solo/config/diff", { as: "viewer" })).json()).from, 1, "the default: the newest against what it was made on");
  assert.deepEqual((await (await t.call("GET", "/api/services/solo/config/diff?from=2&to=2", { as: "viewer" })).json()).members, []);
  assert.equal((await t.call("GET", "/api/services/solo/config/diff?from=9", { as: "viewer" })).status, 404);
  assert.equal((await t.call("GET", "/api/services/solo/config/diff?from=x", { as: "viewer" })).status, 400);
  assert.equal((await t.call("GET", "/api/services/solo/config/diff?member=nope", { as: "viewer" })).status, 404);

  const audit = (t.store as any).db.prepare("SELECT action, detail FROM audit WHERE target LIKE 'solo%'").all() as { action: string; detail: string }[];
  assert.ok(audit.some((a) => a.action === "service.config-draft-created"));
  assert.ok(audit.some((a) => a.action === "service.config-saved" && a.detail.includes(made.id)));
});

test("a draft on an old revision: 409 to save, until it is moved to the newest; closed drafts stay closed", async () => {
  const t = setup();
  takenOver(t.store);
  const drafts = "/api/services/solo/config/drafts";
  const one = await (await t.call("POST", drafts, { as: "uat" }, { changes: [BANNER] })).json();
  const two = await (await t.call("POST", drafts, { as: "uat" }, { base: 1, changes: [{ ...BANNER, value: "other" }] })).json();
  assert.equal((await t.call("POST", `${drafts}/${one.id}/save`, { as: "uat" }, {})).status, 201);

  const stale = await t.call("POST", `${drafts}/${two.id}/save`, { as: "uat" }, {});
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error, "config-draft/stale");
  assert.equal((await (await t.call("GET", `${drafts}/${two.id}`, { as: "viewer" })).json()).stale, true);
  assert.equal(t.store.serviceConfigRevisions("solo").length, 2);
  // A note is free text: what looks like a password does not reach the timeline, which the AI reads.
  const noted = await (await t.call("PUT", `${drafts}/${two.id}`, { as: "uat" }, { note: "password=new-pass-9" })).json();
  assert.equal(noted.note, "password=[hidden]");
  const oldBase = await t.call("POST", drafts, { as: "uat" }, { base: 1, changes: [BANNER] });
  assert.equal(oldBase.status, 409, "nor can a new one start from an old revision");
  assert.equal((await t.call("PUT", `${drafts}/${two.id}`, { as: "uat" }, { base: 1 })).status, 409);

  const moved = await (await t.call("PUT", `${drafts}/${two.id}`, { as: "uat" }, { base: 2 })).json();
  assert.deepEqual([moved.base, moved.stale, moved.changes[0].value], [2, false, "other"]);
  assert.equal((await t.call("POST", `${drafts}/${two.id}/save`, { as: "uat" }, {})).status, 201);

  for (const r of [await t.call("POST", `${drafts}/${one.id}/save`, { as: "uat" }, {}), await t.call("PUT", `${drafts}/${one.id}`, { as: "uat" }, { note: "x" }), await t.call("DELETE", `${drafts}/${one.id}`, { as: "uat" })]) {
    assert.equal(r.status, 409);
    assert.equal((await r.json()).error, "config-draft/closed");
  }
  const three = await (await t.call("POST", drafts, { as: "uat" }, { changes: [{ ...BANNER, value: "third" }] })).json();
  const gone = await t.call("DELETE", `${drafts}/${three.id}`, { as: "uat" });
  assert.equal((await gone.json()).state, "discarded");
  assert.equal((await t.call("POST", `${drafts}/${three.id}/save`, { as: "uat" }, {})).status, 409);
  assert.deepEqual((await (await t.call("GET", `${drafts}?state=open`, { as: "viewer" })).json()).drafts, []);
  assert.equal((await (await t.call("GET", drafts, { as: "viewer" })).json()).drafts.length, 3);
  assert.equal((await t.call("GET", `/api/services/flow/config/drafts/${three.id}`, { as: "viewer" })).status, 404, "a draft belongs to its service");
  assert.equal((await t.call("POST", `/api/services/flow/config/drafts/${three.id}/save`, { as: "uat" }, {})).status, 404);
  assert.equal((await t.call("POST", "/api/services/none/config/drafts", { as: "uat" }, { changes: [] })).status, 404);

  // Nothing to save: no changes, or changes that come to the same bytes.
  for (const changes of [[], [{ ...BANNER, value: "other" }]]) {
    const same = await (await t.call("POST", drafts, { as: "uat" }, { changes })).json();
    const r = await t.call("POST", `${drafts}/${same.id}/save`, { as: "uat" }, {});
    assert.equal(r.status, 409);
    assert.equal((await r.json()).error, "config-draft/no-change");
  }
});

test('"(hidden)" is a placeholder, never a value; what cannot be made is refused', async () => {
  const t = setup();
  takenOver(t.store);
  const drafts = "/api/services/solo/config/drafts";
  const post = (changes: unknown) => t.call("POST", drafts, { as: "uat" }, { changes });
  const refused = async (changes: unknown, code: string, status = 400) => {
    const r = await post(changes);
    assert.equal(r.status, status, JSON.stringify(changes));
    assert.equal((await r.json()).error, code);
  };
  await refused([{ file: "nifi.properties", key: "nifi.security.keystorePasswd", value: "(hidden)" }], "config/hidden-value");
  await refused([{ file: "nifi.properties", key: "nifi.security.keystorePasswd", secret: "(hidden)" }], "config/hidden-value");
  await refused([{ file: "nifi.properties", key: "nifi.ui.banner.text", value: "a (hidden) b" }], "config/hidden-value");
  await refused([{ file: "nifi.properties", key: "nifi.security.keystorePasswd", hidden: true }], "config/hidden-unmatched");
  // XML: a "(hidden)" goes back to the same name's value; a new or renamed one has none, and stray ones are refused.
  await refused([{ file: "authorizers.xml", text: AUTH("(hidden)").replace("Password", "Passphrase") }], "config/hidden-unmatched");
  await refused([{ file: "authorizers.xml", text: `<!-- (hidden) -->\n${AUTH("(hidden)")}` }], "config/hidden-value");
  await refused([{ file: "nifi.properties", key: "a\nb", value: "x" }], "config/bad-key");
  await refused([{ file: "nifi.properties", key: "nifi.ui.banner.text", value: "a\nb" }], "config/bad-value");
  await refused([{ file: "nifi.properties", text: "x" }], "config/not-editable");
  await refused([{ file: "authorizers.xml", key: "Password", value: "x" }], "config/not-editable");
  await refused([{ file: "flow.xml", text: "x" }], "config/unknown-file");
  await refused([{ file: "nifi.properties", member: "local:/opt/other", key: "k", value: "v" }], "config/unknown-member");
  await refused("nope", "config/bad-change");
  await refused([{ key: "k", value: "v" }], "config/bad-change");
  await refused([{ file: "nifi.properties", key: "k" }], "config/bad-change");

  // The redacted copy sent back unchanged gives the same bytes: nothing to save.
  const same = await (await post([{ file: "authorizers.xml", text: AUTH("(hidden)") }])).json();
  assert.equal((await t.call("POST", `${drafts}/${same.id}/save`, { as: "uat" }, {})).status, 409);
  // Malformed XML is a finding, not a refusal (§16.2).
  const broken = await (await post([{ file: "authorizers.xml", text: "<authorizers>" }])).json();
  assert.ok(broken.findings.some((f: any) => f.code === "config/xml-malformed"));
});

test("secrets: only sealed in the draft, hidden in every answer and in the audit, and read back only by reveal", async () => {
  const t = setup();
  takenOver(t.store);
  const drafts = "/api/services/solo/config/drafts";
  const texts: string[] = [];
  const seen = async (r: Response) => { const text = await r.clone().text(); texts.push(text); return JSON.parse(text); };

  const made = await seen(await t.call("POST", drafts, { as: "uat" }, { changes: [
    { file: "nifi.properties", key: "nifi.security.keystorePasswd", value: "new-pass-1" },
    { file: "nifi.properties", key: "nifi.security.keyPasswd", secret: "new-pass-2" },
    { file: "authorizers.xml", text: AUTH("new-pass-3") },
  ] }));
  assert.deepEqual(made.changes.slice(0, 2), [{ file: "nifi.properties", member: null, key: "nifi.security.keystorePasswd", hidden: true }, { file: "nifi.properties", member: null, key: "nifi.security.keyPasswd", hidden: true }]);
  assert.equal(made.changes[2].text, AUTH("(hidden)"));
  const row = (t.store as any).db.prepare("SELECT changes FROM service_config_drafts WHERE id = ?").get(made.id).changes as string;
  assert.ok(!/new-pass/.test(row), "sealed before it is stored");

  // What the page shows goes back as it is and keeps the draft's own values, not the revision's.
  const kept = await seen(await t.call("PUT", `${drafts}/${made.id}`, { as: "uat" }, { changes: [...made.changes.slice(0, 1), made.changes[2], BANNER] }));
  assert.equal(kept.changes.length, 3);
  await seen(await t.call("GET", `${drafts}/${made.id}`, { as: "viewer" }));
  await seen(await t.call("GET", drafts, { as: "viewer" }));
  const out = await seen(await t.call("POST", `${drafts}/${made.id}/save`, { as: "uat" }, {}));
  assert.equal(out.revision, 2);
  const file = fileIn(t.store, "solo", 2, "local:/opt/solo", "nifi.properties");
  assert.match(opened(file), /nifi\.security\.keystorePasswd=new-pass-1\n/);
  assert.ok(!opened(file).includes("new-pass-2"), "left out of the second version of the draft");
  assert.ok(opened(fileIn(t.store, "solo", 2, "local:/opt/solo", "authorizers.xml")).includes("new-pass-3"), "XML kept the draft's value through (hidden)");

  // The comparison names the secrets that changed and shows no value, not even in the lines around.
  const diff = await seen(await t.call("GET", "/api/services/solo/config/diff?from=1&to=2", { as: "viewer" }));
  const files = Object.fromEntries(diff.members[0].files.map((f: any) => [f.name, f]));
  assert.deepEqual(files["nifi.properties"].secretsChanged, ["nifi.security.keystorePasswd"]);
  assert.deepEqual(files["authorizers.xml"].secretsChanged, ["Password"]);
  assert.ok(!files["nifi.properties"].diff.includes("nifi.security.keystorePasswd=new"));
  await seen(await t.call("GET", "/api/services/solo/config?revision=2", { as: "viewer" }));
  await seen(await t.call("GET", "/api/services/solo/status", { as: "viewer" }));
  await seen(await t.call("GET", "/api/services/solo/events", { as: "viewer" }));
  for (const text of texts) assert.ok(!LEAK.test(text), text.slice(0, 400));
  const logged = JSON.stringify((t.store as any).db.prepare("SELECT * FROM audit").all());
  assert.ok(!/new-pass|s3cret/.test(logged), "not in the audit trail");
  assert.ok(!/new-pass|s3cret/.test(JSON.stringify((t.store as any).db.prepare("SELECT * FROM service_events").all())));

  // Only reveal gives a value, one key at a time, and says so in the audit.
  const reveal = (body: unknown) => t.call("POST", "/api/services/solo/config/reveal", { as: "admin" }, body);
  const old = await reveal({ revision: 1, file: "nifi.properties", key: "nifi.security.keystorePasswd" });
  assert.equal(old.headers.get("cache-control"), "no-store");
  assert.equal((await old.json()).value, "keystore-s3cret");
  assert.equal((await (await reveal({ file: "nifi.properties", key: "nifi.security.keystorePasswd" })).json()).value, "new-pass-1");
  assert.equal((await (await reveal({ file: "authorizers.xml", key: "Password" })).json()).value, "new-pass-3");
  assert.equal((await reveal({ file: "authorizers.xml", key: "Url" })).status, 404, "only XML's secret places");
  assert.equal((await reveal({ file: "nifi.properties", key: "nope" })).status, 404);
  assert.equal((await reveal({ revision: 9, file: "nifi.properties", key: "nope" })).status, 404);
  assert.equal((await reveal({ file: "nifi.properties" })).status, 400);
  const revealed = (t.store as any).db.prepare("SELECT target, detail FROM audit WHERE action = 'service.config-revealed'").all() as { target: string; detail: string }[];
  assert.equal(revealed.length, 3);
  assert.equal(revealed[0]!.target, "solo#1");
  assert.ok(revealed.every((a) => !/new-pass|s3cret/.test(a.detail)));
  assert.equal((await t.call("POST", "/api/services/flow/config/reveal", { as: "admin" }, { file: "nifi.properties", key: "nifi.ui.banner.text" })).status, 400, "a cluster's needs its member");
});

test("a cluster's first edit keeps a split revision, then the edit; common and node changes reach the right nodes", async () => {
  const t = setup();
  takenOver(t.store);
  const drafts = "/api/services/flow/config/drafts";
  const first = await (await t.call("POST", drafts, { as: "uat" }, { changes: [BANNER, { file: "nifi.properties", member: B, key: "nifi.security.keystorePasswd", value: "new-pass-b" }, { file: "nifi.properties", key: "nifi.web.https.port", value: "1234" }] })).json();
  assert.ok(first.findings.some((f: any) => f.code === "config/node-override" && f.key === "nifi.web.https.port" && f.member === A), "a node's own value wins over the common layer, and it is said");
  assert.equal(t.store.serviceConfigRevisions("flow").length, 1, "drafting splits nothing");
  const saved = await (await t.call("POST", `${drafts}/${first.id}/save`, { as: "uat" }, {})).json();
  assert.equal(saved.revision, 3);
  assert.deepEqual(t.store.serviceConfigRevisions("flow").map((r) => [r.revision, r.source, r.base]), [[3, "edit", 2], [2, "split", 1], [1, "import", null]]);

  for (const n of [1, 2]) assert.equal(fileIn(t.store, "flow", n, A, "nifi.properties").sha256 === fileIn(t.store, "flow", 3, A, "nifi.properties").sha256, false, "the banner changed");
  assert.equal(fileIn(t.store, "flow", 2, A, "logback.xml").sha256, fileIn(t.store, "flow", 1, A, "logback.xml").sha256);
  assert.equal(fileIn(t.store, "flow", 2, A, "nifi.properties").sha256, fileIn(t.store, "flow", 1, A, "nifi.properties").sha256, "the split alone is the same bytes");
  const a = opened(fileIn(t.store, "flow", 3, A, "nifi.properties")), b = opened(fileIn(t.store, "flow", 3, B, "nifi.properties"));
  assert.match(a, /nifi\.ui\.banner\.text=hello/);
  assert.match(b, /nifi\.ui\.banner\.text=hello/);
  assert.match(a, /nifi\.web\.https\.port=8443/, "kept its own");
  assert.match(b, /nifi\.web\.https\.port=9443/);
  assert.match(a, /keystorePasswd=node-8443-s3cret/);
  assert.match(b, /keystorePasswd=new-pass-b/);
  const pending = await (await t.call("GET", "/api/services/flow/status", { as: "viewer" })).json();
  assert.deepEqual(pending.members.map((m: any) => m.configPending), [["nifi.properties"], ["nifi.properties"]]);

  // Now layered: no second split. A node's value removed goes back to the common one; another node is not touched.
  const second = await (await t.call("POST", drafts, { as: "uat" }, { changes: [{ file: "nifi.properties", member: A, key: "nifi.ui.banner.text", value: "only-a" }, { file: "nifi.properties", member: B, key: "nifi.web.https.port", unset: true }] })).json();
  const out = await (await t.call("POST", `${drafts}/${second.id}/save`, { as: "uat" }, {})).json();
  assert.equal(out.revision, 4);
  assert.deepEqual(out.change.members.map((m: any) => m.member), [A, B]);
  assert.match(opened(fileIn(t.store, "flow", 4, A, "nifi.properties")), /banner\.text=only-a/);
  assert.match(opened(fileIn(t.store, "flow", 4, B, "nifi.properties")), /banner\.text=hello/);
  assert.ok(!/nifi\.web\.https\.port=9443/.test(opened(fileIn(t.store, "flow", 4, B, "nifi.properties"))));

  // XML the nodes differ on has no common copy; each node's goes on its own, with its own secret back from "(hidden)".
  const common = await t.call("POST", drafts, { as: "uat" }, { changes: [{ file: "authorizers.xml", text: AUTH("(hidden)") }] });
  assert.equal(common.status, 400);
  assert.equal((await common.json()).error, "config/no-common-copy");
  const noKey = await t.call("POST", drafts, { as: "uat" }, { changes: [{ file: "authorizers.xml", member: A, text: AUTH("(hidden)").replace("ldap://x", "ldap://y") }] });
  const third = await noKey.json();
  await t.call("POST", `${drafts}/${third.id}/save`, { as: "uat" }, {});
  const xml = opened(fileIn(t.store, "flow", 5, A, "authorizers.xml"));
  assert.ok(xml.includes("a-xml-s3cret") && xml.includes("ldap://y"));
  assert.ok(opened(fileIn(t.store, "flow", 5, B, "authorizers.xml")).includes("ldap://x"));
  // XML they share: a node may take its own copy, and the common copy no longer reaches it.
  const fourth = await (await t.call("POST", drafts, { as: "uat" }, { changes: [{ file: "logback.xml", member: B, text: "<configuration scan=\"true\"/>\n" }] })).json();
  await t.call("POST", `${drafts}/${fourth.id}/save`, { as: "uat" }, {});
  const fifth = await (await t.call("POST", drafts, { as: "uat" }, { changes: [{ file: "logback.xml", text: "<configuration debug=\"true\"/>\n" }] })).json();
  assert.ok(fifth.findings.some((f: any) => f.code === "config/node-override" && f.file === "logback.xml" && f.member === B));

  // Nothing of it comes out of any GET, in the layers either.
  const clean = (where: string, text: string) => assert.ok(!LEAK.test(text), `${where}: ${text.slice(0, 300)}`);
  const paths = [...new Set(t.app.routes.filter((r) => r.method === "GET" && r.path.includes("/config")).map((r) => r.path.replace(/^\/deploy/, "")))];
  assert.ok(paths.includes("/api/services/:id/config/drafts/:draft") && paths.includes("/api/services/:id/config/diff"));
  for (const path of paths) {
    const url = path.replace(":id", "flow").replace(":draft", fifth.id);
    clean(url, await (await t.call("GET", url, { as: "admin" })).text());
  }
  for (const revision of [1, 2, 3, 4, 5, 6]) clean(`revision ${revision}`, await (await t.call("GET", `/api/services/flow/config?revision=${revision}`, { as: "viewer" })).text());
  clean("diff", await (await t.call("GET", "/api/services/flow/config/diff?from=1&to=6", { as: "viewer" })).text());
});

test("what members should have: filled at takeover, and for an old database when it opens", () => {
  const file = join(mkdtempSync(join(tmpdir(), "configdraft-db-")), "state.db");
  const first = new Store(file);
  takenOver(first);
  const rows = first.serviceMemberFiles("flow");
  assert.deepEqual(rows.map((r) => [r.member, r.file, r.revision, r.change, r.actualSha256]).slice(0, 2), [[A, "authorizers.xml", 1, null, null], [A, "logback.xml", 1, null, null]]);
  assert.equal(rows.length, 6);
  const expected = fileIn(first, "flow", 1, B, "nifi.properties");
  assert.deepEqual([rows.find((r) => r.member === B && r.file === "nifi.properties")!.expectedSha256, rows.find((r) => r.member === B && r.file === "nifi.properties")!.path], [expected.sha256, expected.path]);

  // A database from before: neither table, and revisions without the later columns' values.
  (first as any).db.exec("DROP TABLE service_member_files; DROP TABLE service_config_drafts;");
  first.close();
  const reopened = new Store(file);
  assert.equal(reopened.serviceMemberFiles("flow").length, 6);
  assert.equal(reopened.serviceMemberFiles("solo").length, 2);
  assert.deepEqual(reopened.serviceConfigDrafts("flow"), []);
  // What is there stays: opening again changes nothing.
  (reopened as any).db.prepare("UPDATE service_member_files SET revision = 7 WHERE service = 'solo' AND file = 'nifi.properties'").run();
  reopened.close();
  const again = new Store(file);
  assert.equal(again.serviceMemberFiles("solo").find((r) => r.file === "nifi.properties")!.revision, 7);
  again.close();
});

test("a file kept by an older version that cannot be opened cannot be edited, only compared", async () => {
  const t = setup();
  takenOver(t.store);
  const db = (t.store as any).db;
  const row = db.prepare("SELECT body FROM service_configs WHERE service = 'solo' AND revision = 1").get() as { body: string };
  const body = JSON.parse(row.body) as ServiceConfigBody;
  const f = body.members[0]!.files.find((x) => x.name === "nifi.properties")!;
  // As an older version kept it: the bytes as UTF-8, which lost something when they were not.
  f.sealed = box.seal("nifi.ui.banner.text=�\n");
  delete f.sealedAs;
  db.prepare("UPDATE service_configs SET body = ? WHERE service = 'solo' AND revision = 1").run(JSON.stringify(body));

  const r = await t.call("POST", "/api/services/solo/config/drafts", { as: "uat" }, { changes: [BANNER] });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, "config/reimport");
  // Other files can still be edited; the comparison of the unopenable one uses the kept copy and says so.
  const ok = await t.call("POST", "/api/services/solo/config/drafts", { as: "uat" }, { changes: [{ file: "authorizers.xml", text: AUTH("(hidden)").replace("ldap://x", "ldap://z") }] });
  assert.equal(ok.status, 201);
  const made = await ok.json();
  assert.ok(made.findings.some((x: any) => x.code === "config/reimport"));
  assert.equal((await t.call("POST", `/api/services/solo/config/drafts/${made.id}/save`, { as: "uat" }, {})).status, 201);
  const reveal = await t.call("POST", "/api/services/solo/config/reveal", { as: "admin" }, { file: "nifi.properties", key: "nifi.ui.banner.text" });
  assert.equal(reveal.status, 409);
});
