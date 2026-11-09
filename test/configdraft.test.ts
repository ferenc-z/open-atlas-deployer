// Phase 3 step 4 (§7, §13, §16.3): configuration drafts and revisions over HTTP: who may do what, a draft on an old
// revision, "(hidden)" refused, a secret's value only for an admin in a browser and nowhere else, a cluster's first edit
// splitting it into layers, what each member should have, and an old database getting it filled in.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
import { OmaSessions, type OmaEvent } from "../src/server/oma.ts";
import { deployerEntry } from "../src/server/setup-ai.ts";
import { SecretBox } from "../src/server/secretbox.ts";
import { sealFile, type ConfigFileRecord, type ConfigMember, type ServiceConfigBody } from "../src/server/services/config.ts";
import { ConfigReviewer } from "../src/server/services/configreview.ts";
import type { DraftCluster, DraftStandalone } from "../src/server/services/draft.ts";
import { Takeover } from "../src/server/services/takeover.ts";
import { watchList } from "../src/server/services/watch.ts";
import { ingest } from "../src/server/services/metrics.ts";
import { check } from "../src/server/services/rules.ts";
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

function setup(name = "uat", store = new Store(":memory:"), review?: (store: Store) => ConfigReviewer) {
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
  // What the hosts have, by path: a stand-in for the service executor's svc-read.
  const live = new Map<string, string>();
  const reads: Record<string, unknown>[] = [];
  const answerReads = async () => {
    for (let job = store.claimExecutorJob("local", "service"); job; job = store.claimExecutorJob("local", "service")) {
      reads.push(job);
      const files = (job.files as string[]).flatMap((name) => {
        const path = `${String(job.installDir)}/conf/${name}`, text = live.get(path);
        return text === undefined ? [] : [{ name, path, sha256: sha(Buffer.from(text, "latin1")), size: text.length, modifiedAt: "2026-11-09T00:00:00Z", content: Buffer.from(text, "latin1").toString("base64") }];
      });
      handoff.putEnvContent(String(job.id), JSON.stringify({ files }));
      handoff.putStatus(String(job.id), { state: "succeeded", steps: [], result: { files: files.map(({ content: _c, ...f }) => f) } as never });
    }
  };
  const app = createApp({ config, store, takeover, keys, liveRead: { sleep: answerReads, timeoutMs: 2000, pollMs: 1 }, ...(review ? { configReview: review(store) } : {}), sessions: new WorkbenchSessions(config.workbenchUrl, fetcher), observer, deployments, versions: new Versions(undefined, fetcher), env, workbench: new WorkbenchAdmin(config.workbenchUrl, () => "", fetcher) });
  type As = { as?: string; key?: string };
  const call = (method: string, path: string, who: As, body?: unknown) => {
    const headers = new Headers({ "content-type": "application/json" });
    if (who.as) { headers.set("cookie", `open_atlas_workbench_session=${who.as}`); headers.set("x-csrf-token", `csrf-${who.as}`); }
    if (who.key) headers.set("authorization", `Bearer ${who.key}`);
    return app.request(`/deploy${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  };
  return { app, store, call, handoff, live, reads };
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

test("permissions in UAT (§13): viewers read, deploy-uat and its personal keys draft and save, the Assistant's key only creates drafts, only a browser admin reveals", async () => {
  const t = setup();
  takenOver(t.store);
  const drafts = "/api/services/solo/config/drafts";
  const create = (who: { as?: string; key?: string }) => t.call("POST", drafts, who, { changes: [BANNER] });

  assert.equal((await create({})).status, 401);
  for (const who of [{ as: "viewer" }, { as: "prod" }, { as: "nobody" }]) assert.equal((await create(who)).status, 403, JSON.stringify(who));
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

// --- Phase 3 step 6 (§10, §16.3): the AI writes drafts and nothing else, never sees or touches a secret; the review is advice.

type T = ReturnType<typeof setup>;
async function tool(t: T, key: string, name: string, args: Record<string, unknown>) {
  const res = await t.call("POST", "/mcp", { key }, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const body = await res.json() as any;
  const text = body.result.content[0].text as string;
  return { text, value: JSON.parse(text), isError: Boolean(body.result.isError) };
}
const AI = "dps_assistant";
let requestId = 0;
const draftTool = (t: T, id: string, changes: unknown[], key = AI, extra: Record<string, unknown> = {}) =>
  tool(t, key, "draft_service_config", { id, changes, note: "As asked", request_id: `r${++requestId}`, ...extra });
const openDrafts = (t: T, service: string) => t.store.serviceConfigDrafts(service, "open");

for (const name of ["uat", "prod"]) {
  test(`draft_service_config in ${name.toUpperCase()}: the service key makes a draft, a person saves it`, async () => {
    const t = setup(name);
    takenOver(t.store);
    const listed = await (await t.call("POST", "/mcp", { key: AI }, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json() as any;
    const entry = listed.result.tools.find((x: { name: string }) => x.name === "draft_service_config");
    assert.equal(entry.annotations.readOnlyHint, false);
    assert.equal(entry.annotations.destructiveHint, false);
    for (const n of ["list_service_changes", "get_service_change", "get_service_drift"]) assert.equal(listed.result.tools.find((x: { name: string }) => x.name === n)?.annotations.readOnlyHint, true, n);
    assert.ok(!listed.result.tools.some((x: { name: string }) => /save|apply|restart/.test(x.name) && /service/.test(x.name)), "no tool saves or applies a service's configuration");

    const made = await draftTool(t, "solo", [BANNER]);
    assert.equal(made.isError, false, made.text);
    assert.equal(made.value.saved, false);
    assert.equal(made.value.base, 1);
    assert.equal(made.value.restart, "restart", "a key the catalog does not know counts as needing a restart");
    assert.ok(made.value.findings.some((f: { code: string }) => f.code === "config/unknown-key"));
    assert.match(made.value.differences[0].files[0].diff, /\+ nifi\.ui\.banner\.text=hello/);
    assert.doesNotMatch(made.text, LEAK);
    assert.doesNotMatch(made.text, /sha256/);
    assert.match(made.value.next, /open_service_change/);
    const kept = t.store.serviceConfigDraft("solo", made.value.draft)!;
    assert.equal(kept.via, "service", "the page marks it as the AI's");
    assert.equal(kept.createdBy, "assistant");
    assert.equal(t.store.serviceConfig("solo")!.revision, 1, "no revision");

    const path = `/api/services/solo/config/drafts/${made.value.draft}`;
    assert.equal((await t.call("POST", `${path}/save`, { key: AI }, {})).status, 403, "the service key does not save");
    assert.equal((await t.call("PUT", path, { key: AI }, { changes: [] })).status, 403);
    assert.equal((await t.call("DELETE", path, { key: AI })).status, 403);
    const saved = await t.call("POST", `${path}/save`, { as: name }, {});
    assert.equal(saved.status, 201, "a person does");
    assert.equal((await saved.json()).revision, 2);

    const again = await tool(t, AI, "draft_service_config", { id: "solo", changes: [BANNER], note: "x", request_id: "same" });
    const retry = await tool(t, AI, "draft_service_config", { id: "solo", changes: [BANNER], note: "x", request_id: "same" });
    assert.equal(retry.value.draft, again.value.draft, "a retry does not make a second draft");
    assert.equal(openDrafts(t, "solo").length, 1);

    const personal = await draftTool(t, "solo", [BANNER], name === "prod" ? "dpk_prod" : "dpk_uat");
    if (name === "prod") assert.equal(personal.value.finding.code, "auth/browser-only", "PROD takes no personal key");
    else assert.equal(personal.isError, false);
  });

  test(`draft_service_config in ${name.toUpperCase()}: it cannot touch a secret, in any form, and nothing is drafted`, async () => {
    const t = setup(name);
    takenOver(t.store);
    const P = "nifi.properties", X = "authorizers.xml";
    const refused: unknown[][] = [
      [{ file: P, key: "nifi.security.keystorePasswd", value: "new-pass" }],
      [{ file: P, key: "nifi.sensitive.props.key", value: "new-pass" }],
      [{ file: P, key: "nifi.security.keystorePasswd", unset: true }],
      [{ file: P, key: "nifi.security.keystorePasswd", hidden: true }],
      [{ file: P, key: "my.api.token", value: "new-pass" }],
      [{ file: P, key: "nifi.security.keystore\\Passwd", value: "new-pass" }],
      [{ file: P, key: "nifi.ui.banner.text", secret: "new-pass" }],
      [BANNER, { file: P, key: "nifi.security.keyPasswd", value: "new-pass" }],
      [{ file: X, text: AUTH("new-pass") }],
      [{ file: X, text: "<authorizers>\n  <property name=\"Url\">ldap://x</property>\n</authorizers>\n" }],
      [{ file: X, text: `${AUTH("(hidden)")}<!-- --><property name="Secret">new-pass</property>\n` }],
    ];
    for (const changes of refused) {
      const out = await draftTool(t, "solo", changes);
      assert.equal(out.value.finding?.code, "config/secret-by-person", JSON.stringify(changes));
      assert.equal(out.isError, true);
      assert.doesNotMatch(out.text, /new-pass/);
    }
    assert.equal(openDrafts(t, "solo").length, 0, "nothing drafted");
    assert.equal((await t.call("POST", "/api/services/solo/config/drafts", { key: AI }, { changes: [{ file: P, key: "nifi.security.keystorePasswd", value: "new-pass" }] })).status, 400, "the route itself, not only the tool");

    // A key the name rule catches but the catalog lists as not sensitive is an ordinary key; XML with its (hidden) kept is fine.
    assert.equal((await draftTool(t, "solo", [{ file: P, key: "nifi.web.max.access.token.requests.per.second", value: "30" }])).isError, false);
    const xml = await draftTool(t, "solo", [{ file: X, text: AUTH("(hidden)").replace("ldap://x", "ldap://y") }]);
    assert.equal(xml.isError, false, xml.text);
    assert.match(xml.value.differences[0].files[0].diff, /ldap:\/\/y/);
    assert.doesNotMatch(xml.text, LEAK);
    const d = t.store.serviceConfigDraft("solo", xml.value.draft)!;
    assert.equal((await t.call("POST", `/api/services/solo/config/drafts/${d.id}/save`, { as: name }, {})).status, 201);
    assert.equal(opened(fileIn(t.store, "solo", undefined, "local:/opt/solo", X)).includes("solo-xml-s3cret"), true, "the secret stays as it was");

    assert.equal((await draftTool(t, "solo", [])).value.finding.code, "config-draft/empty");
    assert.equal((await draftTool(t, "solo", [{ file: P, key: "nifi.ui.banner.text", value: "(hidden)" }])).isError, true);
    assert.equal((await draftTool(t, "solo", [BANNER], AI, { base: 1 })).value.finding.code, "config-draft/stale");
  });
}

test("draft_service_config on a cluster: common layer and one node, restart or whole cluster, no revision and no secret labels", async () => {
  const t = setup();
  takenOver(t.store);
  // A person made the nodes' sensitive key differ: the page's finding has labels for it, the AI's has none.
  const person = await (await t.call("POST", "/api/services/flow/config/drafts", { as: "uat" }, { changes: [{ file: "nifi.properties", member: A, key: "nifi.sensitive.props.key", secret: "new-pass" }] })).json();
  await t.call("POST", `/api/services/flow/config/drafts/${person.id}/save`, { as: "uat" }, {});
  const revision = t.store.serviceConfig("flow")!.revision;

  const one = await draftTool(t, "flow", [{ ...BANNER, member: B }]);
  assert.equal(one.isError, false, one.text);
  assert.deepEqual(one.value.differences.map((m: { member: string }) => m.member), [B]);
  const pageView = await (await t.call("GET", `/api/services/flow/config/drafts/${one.value.draft}`, { as: "uat" })).json();
  assert.match(JSON.stringify(pageView.preview.findings), /value A/, "the page does have the labels");
  assert.doesNotMatch(one.text, /value [AB]\b/);
  assert.doesNotMatch(one.text, LEAK);

  const all = await draftTool(t, "flow", [BANNER]);
  assert.equal(all.value.restart, "rolling");
  assert.deepEqual(all.value.differences.map((m: { member: string }) => m.member).sort(), [A, B]);

  const full = await draftTool(t, "flow", [{ file: "nifi.properties", key: "nifi.zookeeper.root.node", value: "/other" }, BANNER]);
  assert.equal(full.value.restart, "whole-cluster");
  assert.deepEqual(full.value.fullBecause.map((x: { key: string }) => x.key), ["nifi.zookeeper.root.node"]);
  assert.ok(full.value.findings.some((f: { code: string }) => f.code === "config/not-rolling-safe"));

  assert.equal((await draftTool(t, "flow", [{ ...BANNER, member: "local:/nope" }])).value.finding.code, "config/unknown-member");
  assert.equal(t.store.serviceConfig("flow")!.revision, revision, "drafts make no revision, not even the first split");
});

test("diff_service_config compares two revisions for the AI: a changed secret by name, a password in a comment hidden; the node comparison stays", async () => {
  const t = setup();
  takenOver(t.store);
  const made = await (await t.call("POST", "/api/services/solo/config/drafts", { as: "uat" }, { changes: [BANNER, { file: "nifi.properties", key: "nifi.security.keystorePasswd", secret: "new-pass" }, { file: "authorizers.xml", text: `<!-- password=comment-s3cret -->\n${AUTH("(hidden)")}` }] })).json();
  assert.equal((await t.call("POST", `/api/services/solo/config/drafts/${made.id}/save`, { as: "uat" }, {})).status, 201);

  const diff = await tool(t, AI, "diff_service_config", { id: "solo", to: 2 });
  assert.equal(diff.isError, false, diff.text);
  assert.equal(diff.value.from, 1);
  assert.equal(diff.value.to, 2);
  const files = diff.value.members[0].files as { name: string; diff: string; secretsChanged: string[] }[];
  assert.deepEqual(files.find((f) => f.name === "nifi.properties")!.secretsChanged, ["nifi.security.keystorePasswd"]);
  assert.match(files.find((f) => f.name === "nifi.properties")!.diff, /banner\.text=hello/);
  assert.match(files.find((f) => f.name === "authorizers.xml")!.diff, /password=\[hidden\]/);
  assert.doesNotMatch(diff.text, LEAK);
  assert.doesNotMatch(diff.text, /[0-9a-f]{64}/, "no hashes");
  assert.equal((await tool(t, AI, "diff_service_config", { id: "solo", from: 1, to: 2, member: "local:/nope" })).value.finding.code, "config/unknown-member");
  assert.equal((await tool(t, AI, "diff_service_config", { id: "solo", from: 9 })).value.finding.code, "service-config/none");
  const nodes = await tool(t, AI, "diff_service_config", { id: "flow" });
  assert.equal(nodes.value.kind, "cluster");
  assert.match((await tool(t, AI, "diff_service_config", { id: "solo" })).value.note, /from or to/);
});

test("the read tools for what comes later say they know nothing yet", async () => {
  const t = setup();
  takenOver(t.store);
  const list = await tool(t, AI, "list_service_changes", { id: "solo" });
  assert.deepEqual(list.value.changes, []);
  assert.match(list.value.note, /not there yet/);
  assert.equal((await tool(t, AI, "get_service_change", { id: "solo", change: "x" })).value.finding.code, "service-change/unknown");
  assert.equal((await tool(t, AI, "get_service_drift", { id: "solo" })).value.known, false, "no samples yet: not known");
  for (const name of ["list_service_changes", "get_service_drift"]) assert.equal((await tool(t, AI, name, { id: "nope" })).value.finding.code, "service/unknown");
  assert.equal((await t.call("GET", "/api/services/solo/drift", {})).status, 401);
});

/** A stand-in for OMA's sessions. */
function fakeOma() {
  const fake = {
    prompts: [] as { title: string; correlation: string; text: string }[],
    events: [] as OmaEvent[],
    openFails: null as Error | null,
    eventsFail: null as Error | null,
    hold: null as Promise<void> | null,
    async open(title: string, correlation: string, text: string) {
      fake.prompts.push({ title, correlation, text });
      if (fake.hold) await fake.hold;
      if (fake.openFails) throw fake.openFails;
      return "sess-1";
    },
    async events_() { if (fake.eventsFail) throw fake.eventsFail; return fake.events; },
  };
  return fake;
}
function withReview(name = "uat") {
  const oma = fakeOma();
  const clock = { now: Date.parse("2026-11-09T00:00:00Z") };
  let reviewer!: ConfigReviewer;
  const t = setup(name, new Store(":memory:"), (store) => (reviewer = new ConfigReviewer(store, { open: oma.open, events: oma.events_ }, box, () => name, () => clock.now)));
  takenOver(t.store);
  const save = async (changes: unknown[], note = "Why") => {
    const made = await (await t.call("POST", "/api/services/solo/config/drafts", { as: name }, { changes })).json();
    return t.call("POST", `/api/services/solo/config/drafts/${made.id}/save`, { as: name }, { note });
  };
  const review = () => t.store.serviceConfig("solo")!.review as { state: string; session: string | null; text?: string; error?: string } | null;
  return { t, oma, clock, save, review, poll: () => reviewer.poll() };
}

for (const name of ["uat", "prod"]) {
  test(`configuration review in ${name.toUpperCase()}: opened on save with nothing secret, answer kept on the revision`, async () => {
    const r = withReview(name);
    const res = await r.save([
      { file: "nifi.properties", key: "nifi.web.https.port", value: "7444" }, BANNER,
      { file: "nifi.properties", key: "nifi.security.keystorePasswd", secret: "new-pass" },
      { file: "authorizers.xml", text: `<!-- password=comment-s3cret -->\n${AUTH("(hidden)")}` },
    ], "password=note-s3cret for the migration");
    assert.equal(res.status, 201);
    await new Promise((done) => setImmediate(done));
    assert.equal(r.oma.prompts.length, 1);
    const { title, correlation, text } = r.oma.prompts[0]!;
    assert.match(title, /solo r2/);
    assert.equal(correlation, "solo#2");
    assert.match(text, /Configuration review/);
    assert.match(text, /nifi\.web\.https\.port/, "the differences");
    assert.match(text, /config\/unknown-key/, "the check's findings");
    assert.match(text, /"key": "nifi\.web\.https\.port",\s+"file": "nifi\.properties"/, "the catalog's entry for a changed key");
    assert.match(text, /"secretsChanged": \[\s+"nifi\.security\.keystorePasswd"/, "a changed secret by name");
    assert.doesNotMatch(text, LEAK, "no secret, not even in a comment or the note");
    assert.doesNotMatch(text, /[0-9a-f]{64}/, "no hashes");
    assert.doesNotMatch(text, /value [AB]\b/);

    assert.deepEqual([r.review()?.state, r.review()?.session], ["running", "sess-1"]);
    await r.poll();
    assert.equal(r.review()?.state, "running", "no answer yet");
    r.oma.events = [{ type: "agent.message", content: [{ type: "text", text: "**结论** 没问题" }] }, { type: "session.status_idle" }];
    await r.poll();
    assert.deepEqual([r.review()?.state, r.review()?.text], ["done", "**结论** 没问题"]);
    const seen = await (await r.t.call("GET", "/api/services/solo/config", { as: "viewer" })).json();
    assert.equal(seen.review.text, "**结论** 没问题", "the page shows it");
    await r.poll();
    assert.equal(r.oma.prompts.length, 1);
  });
}

test("the review stops nothing: OMA failing, slow or unreachable, or an error in the checks, and the revision is saved all the same", async () => {
  // Opening fails.
  const failing = withReview();
  failing.oma.openFails = new Error("OMA POST /v1/sessions returned HTTP 503");
  assert.equal((await failing.save([BANNER])).status, 201);
  await new Promise((done) => setImmediate(done));
  assert.equal(failing.t.store.serviceConfig("solo")!.revision, 2);
  assert.equal(failing.review()?.state, "failed");
  assert.match(failing.review()!.error!, /HTTP 503/);
  assert.equal((await failing.t.call("GET", "/api/services/solo/config", { as: "viewer" })).status, 200);

  // OMA does not answer: the save does not wait, and the review shows as running from the start.
  const slow = withReview();
  let release!: () => void;
  slow.oma.hold = new Promise((done) => { release = done; });
  assert.equal((await slow.save([BANNER])).status, 201);
  assert.deepEqual([slow.review()?.state, slow.review()?.session], ["running", null]);
  release();
  await new Promise((done) => setImmediate(done));
  assert.equal(slow.review()?.session, "sess-1");

  // OMA goes away: still running until the time limit.
  const gone = withReview();
  assert.equal((await gone.save([BANNER])).status, 201);
  await new Promise((done) => setImmediate(done));
  gone.oma.eventsFail = new Error("connection refused");
  await gone.poll();
  assert.equal(gone.review()?.state, "running");
  gone.clock.now += 11 * 60_000;
  await gone.poll();
  assert.deepEqual([gone.review()?.state, gone.review()?.error], ["failed", "connection refused"]);

  // A session that errors, and one that never ends.
  const erring = withReview();
  await erring.save([BANNER]);
  await new Promise((done) => setImmediate(done));
  erring.oma.events = [{ type: "session.error", error: "model unavailable" }];
  await erring.poll();
  assert.equal(erring.review()?.state, "failed");
  assert.match(erring.review()!.error!, /model unavailable/);
  const silent = withReview();
  await silent.save([BANNER]);
  await new Promise((done) => setImmediate(done));
  silent.clock.now += 11 * 60_000;
  await silent.poll();
  assert.match(silent.review()!.error!, /no result after 10 minutes/);

  // A check's error is no reason either.
  const wrong = withReview();
  assert.equal((await wrong.save([{ file: "nifi.properties", key: "nifi.web.https.port", value: "not-a-port" }])).status, 201);
  await new Promise((done) => setImmediate(done));
  assert.match(wrong.oma.prompts[0]!.text, /config\/bad-value/);

  // Without OMA there is no review at all; the saves above in other tests go the same way.
  const plain = setup();
  takenOver(plain.store);
  const made = await (await plain.call("POST", "/api/services/solo/config/drafts", { as: "uat" }, { changes: [BANNER] })).json();
  assert.equal((await plain.call("POST", `/api/services/solo/config/drafts/${made.id}/save`, { as: "uat" }, {})).status, 201);
  assert.equal(plain.store.serviceConfig("solo")!.review, null);
});

test("the review's session has no Vault, so no tools: a session opened without vaults sends none", async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    if (init.body) bodies.push(JSON.parse(String(init.body)));
    return Response.json({ id: "s" });
  }) as unknown as typeof fetch;
  await new OmaSessions({ url: "http://oma", keyFile: () => "k", agent: "a", vaults: [] }, fetcher).open("t", "c", "x");
  assert.equal("vault_ids" in bodies[0]!, false);
  assert.match(readFileSync("src/server/index.ts", "utf8"), /new ConfigReviewer\(store, new OmaSessions\(\{[^\n]*vaults: \[\]/, "index.ts opens it that way");
});

test("the open_service_change card: Workbench's entry, the example and the page list the same operations, and saving the entry again brings new ones", () => {
  const entry = (existing?: Record<string, unknown>) => (deployerEntry("https://x/deploy/", existing).chat as { hostOperations: string[]; starters: unknown }).hostOperations;
  assert.ok(entry().includes("open_service_change"));
  assert.deepEqual(entry({ chat: { hostOperations: ["plan_deploy"], starters: [] } }), entry(), "an entry saved earlier gets the new list");
  const example = JSON.parse(readFileSync("examples/workbench-application.deployer.json", "utf8")).chat.hostOperations;
  assert.deepEqual(example, entry());
  const page = /HOST_OPERATIONS = (\[[^\]]*\])/.exec(readFileSync("src/web/Assistant.tsx", "utf8"))![1]!;
  assert.deepEqual(JSON.parse(page), entry());
  assert.match(readFileSync("agents/deploy-assistant.md", "utf8"), /`open_service_change`/);
});

// --- Phase 3 step 7 (§7, §16.3): drift

const SOLO = "local:/opt/solo";
const SOLO_PROPS = "/opt/solo/conf/nifi.properties";
const HEX = /[0-9a-f]{64}/;

function drifting(name = "uat") {
  const t = setup(name);
  takenOver(t.store);
  t.store.setHeartbeat("local", { executor: "service", version: "0.9.0", protocols: [2], kinds: ["svc-read", "svc-read@2"] }, "service");
  return t;
}
/** What the Deployer should have there, as the host has it to begin with. */
const keptText = (t: T, service: string, member: string, file: string) => opened(fileIn(t.store, service, undefined, member, file)).toString();
const syncLive = (t: T) => {
  for (const [service, member] of [["solo", SOLO], ["flow", A], ["flow", B]] as const) {
    for (const f of t.store.serviceMemberFiles(service).filter((x) => x.member === member)) t.live.set(f.path, keptText(t, service, member, f.file));
  }
};
/** A round of the collector for one member: fingerprints of what the host has, unless the sample is an older executor's. */
function round(t: T, service: string, member: string, o: { files?: boolean; at?: string } = {}) {
  const at = o.at ?? new Date().toISOString();
  const files = t.store.serviceMemberFiles(service).filter((f) => f.member === member).map((f) => {
    const text = t.live.get(f.path);
    return text === undefined ? { name: f.file, path: f.path, missing: true } : { name: f.file, path: f.path, sha256: sha(Buffer.from(text, "latin1")) };
  });
  ingest(t.store, [{ service, member, at, process: { running: true, pid: 7, startedAt: "2026-11-01T00:00:00Z" }, nifi: { state: "ok" }, ...(o.files === false ? {} : { files }) }]);
  check(t.store, (h) => t.handoff.executor(h, "service"), service);
}
const driftOf = async (t: T, service: string, member?: string) => (await t.call("GET", `/api/services/${service}/drift${member ? `?member=${encodeURIComponent(member)}` : ""}`, { as: "viewer" })).json() as Promise<any>;
const openDrift = (t: T, service: string) => t.store.serviceAlerts({ service, state: "open", limit: 50 }).filter((a) => a.rule === "config-drift");
const eventKinds = (t: T, service: string) => t.store.serviceEvents(service, { limit: 100 }).map((e) => e.kind);
const adopt = (t: T, service: string, body: Record<string, unknown>, who: { as?: string; key?: string } = { as: "uat" }) => t.call("POST", `/api/services/${service}/drift/adopt`, who, body);

test("the watch list names each member's files, and a sample's fingerprints are not kept in its body", () => {
  const t = drifting();
  syncLive(t);
  const entry = watchList(t.store, "local").find((w) => w.member === SOLO)!;
  assert.deepEqual(entry.files.map((f) => f.name).sort(), ["authorizers.xml", "nifi.properties"]);
  assert.equal(entry.files.find((f) => f.name === "nifi.properties")!.path, SOLO_PROPS);
  round(t, "solo", SOLO);
  assert.equal(t.store.latestServiceSamples("solo")[0]!.body.files, undefined);
  const row = t.store.serviceMemberFiles("solo").find((f) => f.file === "nifi.properties")!;
  assert.equal(row.actualSha256, row.expectedSha256);
  const was = row.actualAt!;
  // A sample from before what is recorded (a backlog) changes nothing.
  ingest(t.store, [{ service: "solo", member: SOLO, at: "2020-01-01T00:00:00Z", files: [{ name: "nifi.properties", sha256: "0".repeat(64) }] }]);
  const after = t.store.serviceMemberFiles("solo").find((f) => f.file === "nifi.properties")!;
  assert.deepEqual([after.actualSha256, after.actualAt], [row.expectedSha256, was]);
});

test("drift is unknown without fingerprints: an older executor's samples neither open nor close the alert", async () => {
  const t = drifting();
  syncLive(t);
  assert.equal((await driftOf(t, "solo")).known, false, "no samples yet");
  round(t, "solo", SOLO, { files: false });
  const old = await driftOf(t, "solo");
  assert.equal(old.known, false);
  assert.equal(old.members[0].state, "unknown");
  assert.match(old.members[0].reason, /too old/);
  assert.equal(openDrift(t, "solo").length, 0);
  t.live.set(SOLO_PROPS, `${t.live.get(SOLO_PROPS)}# a comment\n`);
  round(t, "solo", SOLO);
  assert.equal(openDrift(t, "solo").length, 1);
  round(t, "solo", SOLO, { files: false });
  assert.equal(openDrift(t, "solo").length, 1, "cannot tell: the alert stays");
  assert.equal((await driftOf(t, "solo")).known, false);
});

test("a changed file: the alert and the timeline name it, the differences hide its secrets, and nothing of it stays", async () => {
  const t = drifting();
  syncLive(t);
  round(t, "solo", SOLO);
  const same = await driftOf(t, "solo");
  assert.deepEqual([same.known, same.drifted, same.members[0].state], [true, false, "same"]);
  assert.equal(openDrift(t, "solo").length, 0);

  const text = t.live.get(SOLO_PROPS)!;
  t.live.set(SOLO_PROPS, `${text.replace("keystore-s3cret", "other-s3cret").replace("nifi.ui.banner.text=", "nifi.ui.banner.text=by-hand")}# password=comment-s3cret\nnifi.extra.password=added-s3cret\n`);
  round(t, "solo", SOLO);
  const alert = openDrift(t, "solo")[0]!;
  assert.equal(alert.level, "WARN");
  assert.match(String(alert.detail.text), /nifi\.properties/);
  assert.doesNotMatch(JSON.stringify(alert), HEX);
  assert.ok(eventKinds(t, "solo").includes("drift-detected"));
  assert.doesNotMatch(JSON.stringify(t.store.serviceEvents("solo", { limit: 100 })), HEX);
  const status = await (await t.call("GET", "/api/services/solo/status", { as: "viewer" })).json() as any;
  assert.deepEqual(status.members[0].configDrift, ["nifi.properties"]);

  const summary = await driftOf(t, "solo");
  assert.deepEqual([summary.known, summary.drifted, summary.members[0].state], [true, true, "drift"]);
  assert.equal(summary.differences, undefined);
  assert.equal(t.reads.length, 0, "the summary reads nothing from the host");

  const read = await driftOf(t, "solo", SOLO);
  assert.equal(t.reads.length, 1);
  assert.deepEqual(t.reads[0]!.files, ["nifi.properties"], "only what differs is read");
  const file = read.differences.files[0];
  assert.equal(file.name, "nifi.properties");
  assert.deepEqual(file.secretsChanged.sort(), ["nifi.extra.password", "nifi.security.keystorePasswd"]);
  assert.match(file.diff, /\+ nifi\.ui\.banner\.text=by-hand/);
  assert.equal(file.sha256, sha(Buffer.from(t.live.get(SOLO_PROPS)!, "latin1")));
  assert.doesNotMatch(JSON.stringify(read), LEAK);
  const left = (t.store as any).db.prepare("SELECT env_content, request FROM executor_jobs").all() as { env_content: unknown; request: string }[];
  assert.ok(left.every((r) => r.env_content === null), "what was read is not kept");
  assert.doesNotMatch(JSON.stringify(left), /s3cret/);

  // The AI: the same, without a hash.
  const ai = await tool(t, AI, "get_service_drift", { id: "solo", member: SOLO });
  assert.equal(ai.value.drifted, true);
  assert.deepEqual(ai.value.differences.files[0].secretsChanged.sort(), ["nifi.extra.password", "nifi.security.keystorePasswd"]);
  assert.doesNotMatch(ai.text, HEX);
  assert.doesNotMatch(ai.text, LEAK);
  assert.doesNotMatch((await tool(t, AI, "get_service_drift", { id: "solo" })).text, HEX);
  assert.equal((await tool(t, AI, "get_service_drift", { id: "solo", member: "local:/nope" })).value.finding.code, "config/unknown-member");
});

test("adopting: who may, the same content as was shown, a new revision, nothing written, and the alert closes", async () => {
  const t = drifting();
  syncLive(t);
  t.live.set(SOLO_PROPS, `${t.live.get(SOLO_PROPS)}# by hand\n`);
  round(t, "solo", SOLO);
  const shown = (await driftOf(t, "solo", SOLO)).differences.files[0].sha256 as string;
  const body = { member: SOLO, file: "nifi.properties", sha256: shown };

  assert.equal((await adopt(t, "solo", body, {})).status, 401);
  for (const who of [{ as: "viewer" }, { key: AI }]) assert.equal((await adopt(t, "solo", body, who)).status, 403, JSON.stringify(who));
  assert.equal((await adopt(t, "solo", { member: SOLO }, { as: "uat" })).status, 400);
  assert.equal((await adopt(t, "solo", { ...body, file: "nope.xml" })).status, 404);
  const other = await adopt(t, "solo", { ...body, sha256: "0".repeat(64) });
  assert.deepEqual([other.status, (await other.json() as any).error], [409, "drift/changed"]);
  assert.equal(t.store.serviceConfig("solo")!.revision, 1);

  const saved = await adopt(t, "solo", body);
  assert.equal(saved.status, 201);
  const out = await saved.json() as any;
  assert.equal(out.revision, 2);
  assert.doesNotMatch(JSON.stringify(out), LEAK);
  const revision = t.store.serviceConfig("solo")!;
  assert.deepEqual([revision.source, revision.base], ["adopt", 1]);
  assert.equal(fileIn(t.store, "solo", 2, SOLO, "nifi.properties").sha256, shown);
  const row = t.store.serviceMemberFiles("solo").find((f) => f.file === "nifi.properties")!;
  assert.deepEqual([row.expectedSha256, row.revision], [shown, 2]);
  assert.equal(openDrift(t, "solo").length, 0);
  assert.ok(eventKinds(t, "solo").includes("drift-resolved"));
  assert.ok(t.store.listAudit(50, { action: "service.config-adopted" }).length > 0);
  assert.deepEqual((await (await t.call("GET", "/api/services/solo/status", { as: "viewer" })).json() as any).members[0].configPending, [], "the newest revision is what the host has");

  // Put back by hand and adopted back: a third revision, with the original bytes.
  syncLive(t);
  const original = NIFI({ "nifi.web.https.port": "7443" });
  t.live.set(SOLO_PROPS, original);
  round(t, "solo", SOLO);
  assert.equal(openDrift(t, "solo").length, 1);
  assert.equal((await adopt(t, "solo", { member: SOLO, file: "nifi.properties", sha256: sha(original) })).status, 201);
  assert.equal(fileIn(t.store, "solo", 3, SOLO, "nifi.properties").sha256, fileIn(t.store, "solo", 1, SOLO, "nifi.properties").sha256);
  round(t, "solo", SOLO);
  assert.equal(openDrift(t, "solo").length, 0);
  assert.equal((await adopt(t, "solo", { member: SOLO, file: "nifi.properties", sha256: sha(original) })).status, 409, "no drift: nothing to adopt");
});

test("adopting refuses a file that is gone, says so before replacing a change not applied yet, and on PROD takes a browser", async () => {
  const t = drifting();
  syncLive(t);
  t.live.delete(SOLO_PROPS);
  round(t, "solo", SOLO);
  const gone = await driftOf(t, "solo");
  assert.equal(gone.members[0].files.find((f: any) => f.name === "nifi.properties").state, "missing");
  assert.match(String(openDrift(t, "solo")[0]!.detail.text), /gone/);
  const read = await driftOf(t, "solo", SOLO);
  assert.deepEqual([read.differences.files[0].change, read.differences.files[0].sha256], ["removed", null]);
  assert.doesNotMatch(JSON.stringify(read), LEAK);
  const refused = await adopt(t, "solo", { member: SOLO, file: "nifi.properties", sha256: "0".repeat(64) });
  assert.deepEqual([refused.status, (await refused.json() as any).error], [409, "drift/missing"]);

  syncLive(t);
  const made = await (await t.call("POST", "/api/services/solo/config/drafts", { as: "uat" }, { changes: [BANNER] })).json() as any;
  assert.equal((await t.call("POST", `/api/services/solo/config/drafts/${made.id}/save`, { as: "uat" }, {})).status, 201);
  t.live.set(SOLO_PROPS, `${t.live.get(SOLO_PROPS)}# by hand\n`);
  round(t, "solo", SOLO);
  const hash = sha(Buffer.from(t.live.get(SOLO_PROPS)!, "latin1"));
  const pending = await adopt(t, "solo", { member: SOLO, file: "nifi.properties", sha256: hash });
  assert.deepEqual([pending.status, (await pending.json() as any).error], [409, "drift/pending"]);
  assert.equal(t.store.serviceConfig("solo")!.revision, 2);
  assert.equal((await adopt(t, "solo", { member: SOLO, file: "nifi.properties", sha256: hash, replacePending: true })).status, 201);

  const prod = drifting("prod");
  syncLive(prod);
  prod.live.set(SOLO_PROPS, `${prod.live.get(SOLO_PROPS)}# by hand\n`);
  round(prod, "solo", SOLO);
  const body = { member: SOLO, file: "nifi.properties", sha256: sha(Buffer.from(prod.live.get(SOLO_PROPS)!, "latin1")) };
  assert.equal((await adopt(prod, "solo", body, { key: "dpk_prod" })).status, 403);
  assert.equal((await adopt(prod, "solo", body, { as: "prod" })).status, 201);
});

test("adopting on a cluster goes into that node's layer: by key when that gives the same bytes, else the whole file; the other node stays", async () => {
  const t = drifting();
  syncLive(t);
  const path = "/opt/a/conf/nifi.properties";
  const before = t.store.serviceMemberFiles("flow");
  const bBefore = fileIn(t.store, "flow", undefined, B, "nifi.properties").sha256;
  // A value changed in place, a secret among them.
  const valued = t.live.get(path)!.replace("nifi.ui.banner.text=", "nifi.ui.banner.text=on-a").replace("node-8443-s3cret", "changed-s3cret");
  t.live.set(path, valued);
  round(t, "flow", A);
  round(t, "flow", B);
  assert.deepEqual(openDrift(t, "flow").map((a) => a.member), [A]);
  const first = await adopt(t, "flow", { member: A, file: "nifi.properties", sha256: sha(valued) });
  assert.equal(first.status, 201);
  assert.equal((await first.json() as any).revision, 3, "split first, as a first edit is");
  const config = t.store.serviceConfig("flow")!;
  assert.deepEqual([config.source, t.store.serviceConfig("flow", 2)!.source], ["adopt", "split"]);
  const own = config.body.layers!.nodes[A]!["nifi.properties"]!;
  assert.ok("set" in own, "by key");
  assert.ok(own.set.some((v) => v.key === "nifi.ui.banner.text" && "value" in v && v.value === "on-a"));
  assert.ok(own.set.some((v) => v.key === "nifi.security.keystorePasswd" && "sealed" in v), "a secret is sealed in the layer");
  assert.doesNotMatch(JSON.stringify(config.body.layers), /changed-s3cret/);
  assert.equal(fileIn(t.store, "flow", 3, A, "nifi.properties").sha256, sha(valued));
  assert.equal(fileIn(t.store, "flow", 3, B, "nifi.properties").sha256, bBefore);
  const expectedOf = (rows: typeof before) => rows.filter((f) => f.member === B).map((f) => [f.file, f.expectedSha256, f.revision]);
  assert.deepEqual(expectedOf(t.store.serviceMemberFiles("flow")), expectedOf(before));
  assert.equal(openDrift(t, "flow").length, 0);

  // A comment cannot be said by key: the whole file, byte for byte.
  const commented = `${valued}# on a only\n`;
  t.live.set(path, commented);
  round(t, "flow", A);
  assert.equal((await adopt(t, "flow", { member: A, file: "nifi.properties", sha256: sha(commented) })).status, 201);
  const next = t.store.serviceConfig("flow")!;
  assert.ok("replace" in next.body.layers!.nodes[A]!["nifi.properties"]!);
  assert.equal(fileIn(t.store, "flow", next.revision, A, "nifi.properties").sha256, sha(commented));
  // An edit on this node afterwards still works, and the differences on the page hide what the layer holds.
  assert.doesNotMatch(JSON.stringify(await (await t.call("GET", `/api/services/flow/config`, { as: "viewer" })).json()), LEAK);
});

test("with the service executor offline the differences say so at once; the summary cannot tell", async () => {
  const t = setup();
  takenOver(t.store);
  syncLive(t);
  const res = await t.call("GET", `/api/services/solo/drift?member=${encodeURIComponent(SOLO)}`, { as: "viewer" });
  assert.equal((await res.json() as any).members[0].state, "unknown", "nothing has drifted as far as is known: nothing to read");
  round(t, "solo", SOLO);
  const summary = await driftOf(t, "solo");
  assert.equal(summary.known, false);
  assert.match(summary.members[0].reason, /offline/);
  t.live.set(SOLO_PROPS, "changed=1\n");
  round(t, "solo", SOLO);
  const read = await t.call("GET", `/api/services/solo/drift?member=${encodeURIComponent(SOLO)}`, { as: "viewer" });
  assert.deepEqual([read.status, (await read.json() as any).error], [409, "drift/executor"]);
  assert.equal(openDrift(t, "solo").length, 0, "no executor: the rule cannot tell");
});
