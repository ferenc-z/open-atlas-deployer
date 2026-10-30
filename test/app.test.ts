// The HTTP surface against a fake Workbench: sign-in by Workbench session, Group authorization,
// CSRF on changes, the grace period when Workbench is down, and the emergency account.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/server/app.ts";
import { hashPassword, permissionsFor, WorkbenchSessions } from "../src/server/auth.ts";
import type { Config } from "../src/server/config.ts";
import { Deployments } from "../src/server/deploy.ts";
import { EnvManager, Schemas } from "../src/server/env.ts";
import { Handoff } from "../src/server/handoff.ts";
import { Observer } from "../src/server/observe.ts";
import { Peer } from "../src/server/peer.ts";
import { SecretBox } from "../src/server/secretbox.ts";
import { Store } from "../src/server/store.ts";
import { Versions } from "../src/server/versions.ts";
import { Bundles } from "../src/server/bundle.ts";
import { ContractDocs } from "../src/server/contracts.ts";
import { OmaAgentDriver } from "../src/server/drivers/oma-agent.ts";
import { StudioGraphDriver } from "../src/server/drivers/studio-graph.ts";
import type { DeployDriver } from "../src/server/drivers/types.ts";
import { WorkbenchAdmin } from "../src/server/drivers/workbench.ts";
import { WorkbenchAppDriver } from "../src/server/drivers/workbench-app.ts";
import { McpClient } from "../src/server/mcp-client.ts";
import { Keys } from "../src/server/keys.ts";
import { Diagnoser } from "../src/server/diagnose.ts";
import { OmaSessions } from "../src/server/oma.ts";
import { Onboarding } from "../src/server/onboarding.ts";
import { Drift } from "../src/server/drift.ts";
import { Briefs, collectFacts, type BriefFacts } from "../src/server/brief.ts";
import { fakeServices, fakeState, sha256, tarGz, type FakeState } from "./fakes.ts";

const SESSION = "open_atlas_workbench_session";

interface FakeUser { email: string; groups: string[]; isAdmin?: boolean; enabled?: boolean }

interface SetupOptions {
  emergency?: string;
  /** UAT side: SHA-256 of the read-only keys it accepts. */
  peerKeys?: string[];
  /** PROD side: UAT's Deployer (another setup) and the key to use with it. */
  uat?: { app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> }; key: string };
  /** PROD side: what GitHub says about the release. */
  released?: { value: boolean };
  /** Phase 5: GitHub, Workbench's Administration API, Studio and OMA, faked. */
  services?: FakeState;
}

function setup(options: SetupOptions = {}) {
  const users = new Map<string, FakeUser>([
    ["viewer", { email: "v@x", groups: ["deploy-viewer"] }],
    ["uat", { email: "u@x", groups: ["deploy-uat", "sales"] }],
    ["admin", { email: "a@x", groups: [], isAdmin: true }],
    ["prod", { email: "p@x", groups: ["deploy-prod"] }],
    ["nobody", { email: "n@x", groups: ["sales"] }],
  ]);
  const workbench = { up: true, calls: 0 };
  const fetcher = (async (input: URL | string, init?: RequestInit) => {
    workbench.calls++;
    if (!workbench.up) throw new TypeError("fetch failed");
    const url = new URL(String(input));
    if (url.pathname === "/health") return Response.json({ status: "ok" });
    const cookie = new Headers(init?.headers).get("cookie") ?? "";
    const token = /open_atlas_workbench_session=([^;]+)/.exec(cookie)?.[1] ?? "";
    const user = users.get(token);
    if (!user) return Response.json({ error: "auth/unauthorized" }, { status: 401 });
    return Response.json({ user: { id: token, email: user.email, displayName: user.email, enabled: user.enabled ?? true, role: user.isAdmin ? "admin" : "member", isAdmin: !!user.isAdmin }, csrfToken: `csrf-${token}`, groups: user.groups });
  }) as typeof fetch;

  const dir = mkdtempSync(join(tmpdir(), "deployer-"));
  const environmentFile = join(dir, "environment.json");
  writeFileSync(environmentFile, JSON.stringify({ name: "uat", project: "open-atlas", bindIp: "127.0.0.1", registries: {}, apps: { shop: { version: "1.2.0" } } }));
  const config: Config = {
    bind: "127.0.0.1", port: 0, basePath: "/deploy", dataDir: dir, workbenchUrl: "http://workbench:8090", workbenchPublicUrl: "/",
    environmentFile, observeUrls: {}, secureCookies: false, webDir: join(dir, "web"), templatesDir: join(dir, "templates"), peerKeySha256: options.peerKeys ?? [], githubApi: "https://api.github.com", omaVaults: [], omaAssessorVaults: [], briefHour: 8,
    ...(options.emergency ? { emergencyPasswordHash: hashPassword(options.emergency) } : {}),
  };
  let now = Date.parse("2026-10-30T10:00:00Z");
  const store = new Store(":memory:", () => new Date(now));
  const sessions = new WorkbenchSessions(config.workbenchUrl, fetcher, () => now);
  const observer = new Observer({}, fetcher);
  const handoff = new Handoff(join(dir, "handoff"), () => now);
  let peer: Peer | undefined;
  if (options.uat) {
    writeFileSync(join(dir, "uat.key"), options.uat.key);
    const uatApp = options.uat.app;
    peer = new Peer("http://uat.internal/deploy", join(dir, "uat.key"), (async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      return uatApp.request(url.pathname + url.search, init);
    }) as typeof fetch, () => now);
  }
  const released = options.released ?? { value: false };
  const releases = { release: async (repo: string, tag: string) => (released.value ? { released: true, detail: `${repo} 的 ${tag} 已正式发布` } : { released: false, detail: `${repo} 的 ${tag} 没有 GitHub Release` }) };
  let phase5: { drivers: DeployDriver[]; bundles: Bundles; contracts: ContractDocs; workbench: WorkbenchAdmin; fetcher: typeof fetch } | undefined;
  if (options.services) {
    const f = fakeServices(options.services);
    writeFileSync(join(dir, "wb.key"), options.services.workbench.key);
    const wb = new WorkbenchAdmin("http://workbench:8090", join(dir, "wb.key"), f);
    phase5 = {
      workbench: wb, fetcher: f,
      drivers: [
        new WorkbenchAppDriver(wb),
        new StudioGraphDriver(new McpClient("http://studio.test/mcp", () => ({ authorization: "Bearer oaw_v1.test" }), f), join(dir, "templates")),
        new OmaAgentDriver(new McpClient("http://oma.test/mcp", () => ({ authorization: "Bearer omab_test" }), f), wb, join(dir, "templates")),
      ],
      bundles: new Bundles(join(dir, "bundles"), undefined, f, "https://api.github.test"),
      contracts: new ContractDocs(undefined, f, "https://api.github.test"),
    };
  }
  const deployments = new Deployments(store, handoff, observer, environmentFile, { ...(peer ? { peer } : {}), releases, now: () => now, ...(phase5 ? { drivers: phase5.drivers, bundles: phase5.bundles, contracts: phase5.contracts } : {}) });
  const versions = new Versions(undefined, (async () => Response.json([{ name: "shop-1.2.0" }, { name: "v9" }, { name: "shop-1.10.0" }])) as typeof fetch);
  const example = { text: "" };
  const schemas = new Schemas(undefined, join(dir, "templates"), (async () => new Response(example.text)) as typeof fetch);
  const env = new EnvManager(store, deployments, schemas, new SecretBox(Buffer.alloc(32, 7).toString("base64")), "shared-compare-key");
  const keys = phase5 ? new Keys(store, phase5.workbench, () => now) : undefined;
  writeFileSync(join(dir, "oma.key"), "oma_test");
  writeFileSync(join(dir, "issue.token"), "ghi_test");
  const onboarding = phase5 ? new Onboarding({
    store, deployments, oma: new OmaSessions({ url: "http://oma.test", keyFile: join(dir, "oma.key"), agent: "agent_assessor", environment: "env_isolated" }, phase5.fetcher),
    githubApi: "https://api.github.test", githubTokenFile: undefined, issueRepo: "acme/deployer", issueTokenFile: join(dir, "issue.token"),
    templatesDir: join(dir, "kept"), pageUrl: "https://wb.example/deploy/", fetcher: phase5.fetcher, now: () => now,
  }) : undefined;
  if (onboarding) deployments.evaluated = (a, v) => onboarding.evaluated(a, v);
  if (phase5) deployments.maintenance = phase5.workbench;
  const app = createApp({ config, store, sessions, observer, deployments, versions, env, ...(peer ? { peer } : {}), ...(keys ? { keys } : {}), ...(onboarding ? { onboarding } : {}) });
  const request = (path: string, init: RequestInit & { as?: string; cookie?: string } = {}) => {
    const headers = new Headers(init.headers);
    const cookies = [init.as ? `${SESSION}=${init.as}` : "", init.cookie ?? ""].filter(Boolean).join("; ");
    if (cookies) headers.set("cookie", cookies);
    return app.request(`/deploy${path}`, { ...init, headers });
  };
  const beat = () => writeFileSync(join(dir, "handoff", "executor.json"), JSON.stringify({ version: "0.3.0", protocols: [1], kinds: ["build", "deploy", "env", "env-read", "bundle", "db-migration"], at: new Date(now).toISOString(), project: "open-atlas", registries: [], databaseBackup: {}, busy: null }));
  mkdirSync(join(dir, "handoff"), { recursive: true });
  return { app, request, store, users, workbench, dir, beat, example, released, deployments, advance: (ms: number) => { now += ms; } };
}

const shop = { v: 1, app: "shop", appliesFrom: "1.0.0", release: { repo: "acme/shop", tag: "v{version}", manifest: "package.json" },
  components: [{ id: "web", type: "compose-service", service: "shop", source: { kind: "public-registry", image: "nginx:1.27.0" } }] };

test("permissions follow the deploy Groups; an administrator has all of them", () => {
  assert.deepEqual(permissionsFor(["deploy-viewer"], false), ["view"]);
  assert.deepEqual(permissionsFor(["deploy-uat"], false), ["view", "deploy-uat"]);
  assert.deepEqual(permissionsFor(["deploy-prod"], false), ["view", "deploy-prod"]);
  assert.deepEqual(permissionsFor(["sales"], false), []);
  assert.deepEqual(permissionsFor([], true), ["view", "deploy-uat", "deploy-prod", "admin"]);
});

test("signs in with the Workbench session and refuses users outside the deploy Groups", async () => {
  const { request } = setup();
  assert.equal((await request("/api/me")).status, 401);
  assert.equal((await request("/api/me", { as: "stranger" })).status, 401);
  assert.equal((await request("/api/me", { as: "nobody" })).status, 403);
  const me = await (await request("/api/me", { as: "uat" })).json();
  assert.equal(me.principal.id, "u@x");
  assert.deepEqual(me.principal.permissions, ["view", "deploy-uat"]);
  assert.equal(me.environment, "uat");
});

test("a user removed from the Group loses access on the next request", async () => {
  const { request, users } = setup();
  assert.equal((await request("/api/apps", { as: "viewer" })).status, 200);
  users.get("viewer")!.groups = [];
  assert.equal((await request("/api/apps", { as: "viewer" })).status, 403);
  users.get("viewer")!.enabled = false;
  assert.equal((await request("/api/apps", { as: "viewer" })).status, 401);
});

test("only administrators change the registry, and only with the CSRF token", async () => {
  const { request, store } = setup();
  const put = (as: string, csrf?: string) => request("/api/apps/shop/manifests", { method: "PUT", as, headers: { "content-type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) }, body: JSON.stringify({ manifest: shop, name: "Shop" }) });
  assert.equal((await put("uat", "csrf-uat")).status, 403);
  assert.equal((await put("admin")).status, 403);
  const saved = await put("admin", "csrf-admin");
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { app: "shop", appliesFrom: "1.0.0", revision: 1 });
  assert.equal(store.listAudit()[0]!.actor, "a@x");
  const bad = await request("/api/apps/shop/manifests", { method: "PUT", as: "admin", headers: { "x-csrf-token": "csrf-admin", "content-type": "application/json" }, body: JSON.stringify({ manifest: { ...shop, components: [] } }) });
  assert.equal(bad.status, 400);
  assert.ok((await bad.json()).details.length > 0);
  const exported = await request("/api/apps/shop/manifests/1.0.0/1?download", { as: "viewer" });
  assert.match(exported.headers.get("content-disposition") ?? "", /shop-1\.0\.0\.deploy\.json/);
});

test("while Workbench is down, a recently confirmed session holds for fifteen minutes", async () => {
  const { request, workbench, advance } = setup();
  assert.equal((await request("/api/me", { as: "viewer" })).status, 200);
  workbench.up = false;
  const me = await (await request("/api/me", { as: "viewer" })).json();
  assert.equal(me.principal.stale, true);
  advance(16 * 60_000);
  assert.equal((await request("/api/me", { as: "viewer" })).status, 503);
});

test("the emergency account works only while Workbench is unreachable, and is audited", async () => {
  const password = "correct horse battery staple";
  const { request, store, workbench, advance } = setup({ emergency: password });
  const login = (pw: string) => request("/api/emergency/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: pw }) });
  assert.equal((await login(password)).status, 409);

  workbench.up = false;
  advance(20_000);
  const signedOut = await (await request("/api/me")).json();
  assert.equal(signedOut.emergencyAvailable, true);
  assert.equal((await login("wrong")).status, 401);
  const ok = await login(password);
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get("set-cookie")!.split(";")[0]!;
  const me = await (await request("/api/me", { cookie })).json();
  assert.equal(me.principal.via, "emergency");
  assert.deepEqual(me.principal.permissions, ["view", "deploy-uat", "deploy-prod", "admin"]);
  assert.deepEqual(store.listAudit().map((e) => e.action), ["emergency.login", "emergency.login-failed"]);

  workbench.up = true;
  advance(20_000);
  assert.equal((await request("/api/me", { cookie })).status, 401);
});

test("emergency logins are throttled after five failures", async () => {
  const { request, workbench } = setup({ emergency: "correct horse battery staple" });
  workbench.up = false;
  const login = (pw: string) => request("/api/emergency/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: pw }) });
  for (let i = 0; i < 5; i++) assert.equal((await login("wrong")).status, 401);
  assert.equal((await login("correct horse battery staple")).status, 429);
});

test("status lists registered apps against the environment's desired versions", async () => {
  const { request, store } = setup();
  store.saveManifest(shop, { id: "t", via: "cli" });
  const status = await (await request("/api/status", { as: "viewer" })).json();
  assert.equal(status.environment, "uat");
  assert.equal(status.apps[0].desired, "1.2.0");
  assert.equal(status.apps[0].manifest, "1.0.0");
  assert.equal(status.apps[0].components[0].verdict, "unknown");
});

// Phase 2: plans, builds and deploys through the handoff directory.

const built = { v: 1, app: "shop", appliesFrom: "1.0.0", release: { repo: "acme/shop", tag: "shop-{version}", manifest: "release.json" },
  components: [
    { id: "web", type: "compose-service", service: "shop", source: { kind: "company-registry", registry: "ghcr", image: "open-atlas-shop",
      build: { repo: "acme/shop", tag: "shop-{version}", script: "build-images.sh" } },
      ports: [{ container: 80, host: 18080 }], volumes: [{ target: "/data", path: "data" }, { target: "/etc/shop.conf", file: "deploy/shop.conf" }] },
    { id: "setup", type: "manual", steps: ["create the admin"], when: "install" },
  ] };

function withBuiltApp() {
  const t = setup();
  writeFileSync(join(t.dir, "environment.json"), JSON.stringify({ name: "uat", project: "open-atlas", bindIp: "127.0.0.1", registries: { ghcr: "ghcr.io/acme" }, apps: { shop: { version: "1.2.0" } } }));
  t.store.saveManifest(built, { id: "t", via: "cli" });
  return t;
}
const post = (t: ReturnType<typeof setup>, path: string, as: string, body: unknown) =>
  t.request(path, { method: "POST", as, headers: { "content-type": "application/json", "x-csrf-token": `csrf-${as}` }, body: JSON.stringify(body) });
const finish = (t: ReturnType<typeof setup>, id: string, state: string, result: Record<string, unknown> = {}) => {
  mkdirSync(join(t.dir, "handoff", "jobs", id), { recursive: true });
  writeFileSync(join(t.dir, "handoff", "jobs", id, "status.json"), JSON.stringify({ id, state, steps: [], result, message: state, finishedAt: "2026-10-30T10:00:00Z" }));
};
/** Ticks every item of the manual step a deploy waits at (phase 5), as the given user. */
const tickAll = async (t: ReturnType<typeof setup>, id: string, as = "uat") => {
  const { job } = await (await t.request(`/api/jobs/${id}`, { as: "viewer" })).json();
  for (const s of job.rollout?.steps ?? []) {
    if (s.state !== "waiting") continue;
    for (let i = 0; i < s.checks.length; i++) assert.equal((await post(t, `/api/jobs/${id}/checks`, as, { component: s.component, index: i })).status, 200);
  }
};
/** The executor's part succeeded, and people did the manual steps. */
const finishDeploy = async (t: ReturnType<typeof setup>, id: string, result: Record<string, unknown>, as = "uat") => {
  finish(t, id, "succeeded", result);
  await t.request("/api/jobs", { as: "viewer" });
  await tickAll(t, id, as);
};

test("lists versions from the release repo's tags, newest first", async () => {
  const t = withBuiltApp();
  const body = await (await t.request("/api/apps/shop/versions", { as: "viewer" })).json();
  assert.deepEqual(body.versions, ["1.10.0", "1.2.0"]);
});

test("a plan blocks on permission, an offline executor and a missing build", async () => {
  const t = withBuiltApp();
  const asViewer = await (await post(t, "/api/apps/shop/plan", "viewer", { version: "1.2.0" })).json();
  const codes = asViewer.findings.map((f: { code: string }) => f.code);
  assert.ok(codes.includes("deploy/forbidden"));
  assert.ok(codes.includes("deploy/executor-offline"));
  assert.ok(codes.includes("deploy/not-built"));
  assert.ok(codes.includes("deploy/manual"), "first install lists the manual step");
  assert.equal(asViewer.request, null);
});

test("builds, then deploys with the exact request the executor gets", async () => {
  const t = withBuiltApp();
  t.beat();
  const buildResponse = await (await post(t, "/api/apps/shop/build", "uat", { version: "1.2.0" })).json();
  const buildId = buildResponse.jobs[0].id;
  const buildRequest = JSON.parse(readFileSync(join(t.dir, "handoff", "requests", `${buildId}.json`), "utf8"));
  assert.deepEqual(buildRequest.build, { repo: "acme/shop", tag: "shop-1.2.0", script: "build-images.sh", platform: "linux/amd64" });
  assert.equal(buildRequest.registry, "ghcr.io/acme");
  assert.equal(buildRequest.protocol, 1);
  assert.equal((await post(t, "/api/apps/shop/build", "uat", { version: "1.2.0" })).status, 409, "one job per app at a time");
  finish(t, buildId, "succeeded", { digest: "sha256:b" });
  await t.request("/api/jobs", { as: "viewer" });

  const p = await (await post(t, "/api/apps/shop/plan", "uat", { version: "1.2.0" })).json();
  assert.deepEqual(p.findings.filter((f: { blocking: boolean }) => f.blocking), []);
  assert.equal(p.changes[0].after, "ghcr.io/acme/shop:1.2.0".replace("shop:", "open-atlas-shop:"));
  const deployed = await (await post(t, "/api/apps/shop/deploy", "uat", { version: "1.2.0" })).json();
  const request = JSON.parse(readFileSync(join(t.dir, "handoff", "requests", `${deployed.job.id}.json`), "utf8"));
  assert.deepEqual(request.services, ["shop"]);
  assert.deepEqual(request.images, [{ service: "shop", ref: "ghcr.io/acme/open-atlas-shop:1.2.0", build: true }]);
  assert.deepEqual(request.files, { repo: "acme/shop", tag: "shop-1.2.0", paths: ["deploy/shop.conf"] });
  assert.deepEqual(request.dataDirs, [{ path: "data", service: "shop" }]);
  assert.match(request.root, /path: "shop\/compose.yaml"/);
  assert.match(request.fragment, /image: "ghcr.io\/acme\/open-atlas-shop:1.2.0"/);
  assert.equal(request.steps, undefined, "the executor gets its part only");

  // The containers are up; the deploy waits at the install-only manual step until people tick it.
  finish(t, deployed.job.id, "succeeded", { digests: { shop: "sha256:d1" }, builds: { shop: { version: "1.2.0", commit: "c0ffee" } } });
  const waiting = await (await t.request(`/api/jobs/${deployed.job.id}`, { as: "viewer" })).json();
  assert.equal(waiting.job.state, "running");
  assert.deepEqual(waiting.job.rollout.steps.map((s: { component: string; state: string }) => `${s.component} ${s.state}`), ["web succeeded", "setup waiting"]);
  assert.equal((await post(t, `/api/jobs/${deployed.job.id}/checks`, "viewer", { component: "setup", index: 0 })).status, 403);
  assert.equal((await post(t, `/api/apps/shop/deploy`, "uat", { version: "1.2.0" })).status, 409, "still busy while it waits");
  await tickAll(t, deployed.job.id);
  const job = await (await t.request(`/api/jobs/${deployed.job.id}`, { as: "viewer" })).json();
  assert.equal(job.job.state, "succeeded");
  assert.equal(job.job.rollout.steps[1].checks[0].by, "u@x");
  assert.equal(job.record.commit_sha, "c0ffee");
  assert.deepEqual(job.record.artifact_digest, { shop: "sha256:d1" });
  const status = await (await t.request("/api/status", { as: "viewer" })).json();
  assert.equal(status.apps[0].desired, "1.2.0");
  assert.deepEqual(t.store.listAudit().map((e) => e.action).filter((a) => a.startsWith("deploy")), ["deploy.succeeded", "deploy.manual-check", "deploy.request"]);
});

test("going back to a deploy pins its digests, and a failed deploy leaves the version that ran", async () => {
  const t = withBuiltApp();
  t.beat();
  const ack = { acknowledgeManual: true };
  const b1 = (await (await post(t, "/api/apps/shop/build", "uat", { version: "1.2.0" })).json()).jobs[0].id;
  finish(t, b1, "succeeded");
  await t.request("/api/jobs", { as: "viewer" });
  const d1 = (await (await post(t, "/api/apps/shop/deploy", "uat", { version: "1.2.0", ...ack })).json()).job.id;
  await finishDeploy(t, d1, { digests: { shop: "sha256:one" } });

  const b2 = (await (await post(t, "/api/apps/shop/build", "uat", { version: "1.3.0" })).json()).jobs[0].id;
  finish(t, b2, "succeeded");
  await t.request("/api/jobs", { as: "viewer" });
  const d2 = (await (await post(t, "/api/apps/shop/deploy", "uat", { version: "1.3.0", ...ack })).json()).job.id;
  finish(t, d2, "rolled-back", { digests: { shop: "sha256:two" } });
  await t.request("/api/jobs", { as: "viewer" });
  assert.equal((await (await t.request("/api/status", { as: "viewer" })).json()).apps[0].desired, "1.2.0");

  const back = await (await post(t, "/api/apps/shop/plan", "uat", { version: "1.2.0", pinFrom: d1 })).json();
  assert.equal(back.changes[0].pin, "sha256:one");
  assert.equal(back.manual.length, 0, "install-only manual steps are not repeated");
  assert.equal((await post(t, "/api/apps/shop/plan", "uat", { version: "1.3.0", pinFrom: d1 })).status, 400);
  const d3 = (await (await post(t, "/api/apps/shop/deploy", "uat", { version: "1.2.0", pinFrom: d1 })).json()).job.id;
  const request = JSON.parse(readFileSync(join(t.dir, "handoff", "requests", `${d3}.json`), "utf8"));
  assert.equal(request.images[0].pin, "sha256:one");
  assert.deepEqual(readdirSync(join(t.dir, "handoff", "requests")).length, 5);
});

test("PROD does not build", async () => {
  const t = withBuiltApp();
  t.beat();
  writeFileSync(join(t.dir, "environment.json"), JSON.stringify({ name: "prod", project: "open-atlas", bindIp: "127.0.0.1", registries: { ghcr: "ghcr.io/acme" }, apps: {} }));
  const r = await post(t, "/api/apps/shop/build", "admin", { version: "1.2.0" });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, "build/prod");
});

// Phase 3: environment variables.

const withEnv = { ...built, env: { file: "shop.env", schema: ".env.example", secrets: ["API_TOKEN"] },
  components: [{ ...built.components[0], envFile: true, environment: { GREETING: "${GREETING}" } }] };

function withEnvApp() {
  const t = withBuiltApp();
  t.store.saveManifest(withEnv, { id: "t", via: "cli" });
  t.example.text = "GREETING=hello\nAPI_TOKEN=\n#DB_PASSWORD=\n";
  t.beat();
  return t;
}
const put = (t: ReturnType<typeof setup>, path: string, as: string, body: unknown) =>
  t.request(path, { method: "PUT", as, headers: { "content-type": "application/json", "x-csrf-token": `csrf-${as}` }, body: JSON.stringify(body) });

/** Plays the executor's part of an env-read job. */
async function importFile(t: ReturnType<typeof setup>, content: string | null) {
  const { job } = await (await post(t, "/api/apps/shop/env/import", "uat", {})).json();
  const dir = join(t.dir, "handoff", "jobs", job.id);
  mkdirSync(dir, { recursive: true });
  if (content !== null) writeFileSync(join(dir, "env.content"), content);
  const sha256 = content === null ? undefined : createHash("sha256").update(content).digest("hex");
  finish(t, job.id, "succeeded", { env: content === null ? { exists: false } : { exists: true, sha256, bytes: content.length } });
  await t.request("/api/jobs", { as: "viewer" });
  return job.id as string;
}

test("imports the server's env file; secrets are sealed, masked, and only an administrator reveals one", async () => {
  const t = withEnvApp();
  assert.equal((await post(t, "/api/apps/shop/env/import", "viewer", {})).status, 403);
  await importFile(t, "GREETING=hi\nAPI_TOKEN='tok en'\nDB_PASSWD=pw\n");
  const view = await (await t.request("/api/apps/shop/env", { as: "viewer" })).json();
  assert.equal(view.revision.revision, 1);
  assert.equal(view.revision.source, "import");
  assert.equal(view.applied, 1);
  assert.deepEqual(view.values, [{ key: "GREETING", value: "hi", secret: false }, { key: "API_TOKEN", secret: true }, { key: "DB_PASSWD", secret: true }]);
  assert.deepEqual(view.findings.map((f: { code: string; key: string }) => `${f.code} ${f.key}`), ["env/renamed DB_PASSWD"]);
  const stored = t.store.envRevision("shop", 1)!.values;
  assert.ok("s" in stored.API_TOKEN! && !JSON.stringify(stored).includes("tok en"), "sealed at rest");
  assert.equal((await post(t, "/api/apps/shop/env/reveal", "uat", { revision: 1, key: "API_TOKEN" })).status, 403);
  assert.equal((await (await post(t, "/api/apps/shop/env/reveal", "admin", { revision: 1, key: "API_TOKEN" })).json()).value, "tok en");
  assert.equal(t.store.listAudit()[0]!.action, "env.reveal");
});

test("each save is a revision naming the changed keys; secrets kept unseen; stale edits are refused", async () => {
  const t = withEnvApp();
  await importFile(t, "GREETING=hi\nAPI_TOKEN=old\n");
  const values = [{ key: "GREETING", value: "hello world" }, { key: "API_TOKEN", keep: true }, { key: "NEW_ONE", value: "1" }];
  assert.equal((await put(t, "/api/apps/shop/env", "viewer", { base: 1, values })).status, 403);
  const saved = await (await put(t, "/api/apps/shop/env", "uat", { base: 1, values, note: "greet" })).json();
  assert.equal(saved.revision, 2);
  assert.equal((await put(t, "/api/apps/shop/env", "uat", { base: 1, values })).status, 409, "based on an old revision");
  assert.equal((await put(t, "/api/apps/shop/env", "uat", { base: 2, values })).status, 400, "nothing changed");
  await put(t, "/api/apps/shop/env", "uat", { base: 2, values: [{ key: "GREETING", value: "hello world" }, { key: "API_TOKEN", value: "new secret" }] });
  const view = await (await t.request("/api/apps/shop/env", { as: "viewer" })).json();
  assert.deepEqual(view.revisions.map((r: { revision: number }) => r.revision), [3, 2, 1]);
  assert.deepEqual(view.revisions[0].changes, [{ key: "API_TOKEN", change: "changed", secret: true }, { key: "NEW_ONE", change: "removed", secret: false }]);
  assert.ok(!JSON.stringify(t.store.listAudit()).includes("new secret"), "the audit log names secrets, never their values");

  const reverted = await (await post(t, "/api/apps/shop/env/revert", "uat", { revision: 1, base: 3 })).json();
  assert.equal(reverted.revision, 4);
  assert.equal((await (await post(t, "/api/apps/shop/env/reveal", "admin", { revision: 4, key: "API_TOKEN" })).json()).value, "old");
});

test("writing goes through a plan; the request carries the file, the job record only its hash", async () => {
  const t = withEnvApp();
  const planFirst = await (await post(t, "/api/apps/shop/env/plan", "uat", {})).json();
  assert.equal(planFirst.error, "env/revision", "nothing to write before an import or an edit");
  await importFile(t, null);
  assert.equal(t.store.appliedEnv("shop")!.meta.note, "服务器上没有 shop.env");
  await put(t, "/api/apps/shop/env", "uat", { base: 1, values: [{ key: "API_TOKEN", value: "s3cret" }] });
  const p = await (await post(t, "/api/apps/shop/env/plan", "uat", { revision: 2 })).json();
  assert.deepEqual(p.findings.map((f: { code: string }) => f.code), ["env/referenced-missing", "env/write-only"]);
  assert.equal((await post(t, "/api/apps/shop/env/apply", "uat", { revision: 2 })).status, 409);

  await put(t, "/api/apps/shop/env", "uat", { base: 2, values: [{ key: "API_TOKEN", keep: true }, { key: "GREETING", value: "hi there" }] });
  const ok = await (await post(t, "/api/apps/shop/env/plan", "uat", { revision: 3 })).json();
  assert.deepEqual(ok.findings.filter((f: { blocking: boolean }) => f.blocking), []);
  assert.deepEqual(ok.changes.map((c: { key: string }) => c.key), ["API_TOKEN", "GREETING"]);
  assert.equal(ok.restart, false);
  const { job } = await (await post(t, "/api/apps/shop/env/apply", "uat", { revision: 3 })).json();
  const request = JSON.parse(readFileSync(join(t.dir, "handoff", "requests", `${job.id}.json`), "utf8"));
  assert.equal(request.content, "# Written by Open Atlas Deployer: shop env revision 3.\n# Edit it in the Deployer; changes made here are overwritten.\nAPI_TOKEN=s3cret\nGREETING='hi there'\n");
  assert.equal(request.sha256, createHash("sha256").update(request.content).digest("hex"));
  assert.deepEqual(request.services, []);
  assert.ok(!JSON.stringify(t.store.job(job.id)).includes("s3cret"));
  finish(t, job.id, "succeeded");
  await t.request("/api/jobs", { as: "viewer" });
  assert.equal(t.store.appliedEnv("shop")!.meta.revision, 3);
});

test("a deploy needs every ${KEY} its fragment uses in the server's env file, and records the env revision", async () => {
  const t = withEnvApp();
  const b = (await (await post(t, "/api/apps/shop/build", "uat", { version: "1.2.0" })).json()).jobs[0].id;
  finish(t, b, "succeeded");
  await t.request("/api/jobs", { as: "viewer" });
  const unmanaged = await (await post(t, "/api/apps/shop/plan", "uat", { version: "1.2.0" })).json();
  assert.ok(unmanaged.findings.some((f: { code: string; blocking: boolean }) => f.code === "env/unmanaged" && !f.blocking));
  await importFile(t, "API_TOKEN=x\n");
  const blocked = await (await post(t, "/api/apps/shop/plan", "uat", { version: "1.2.0" })).json();
  assert.ok(blocked.findings.some((f: { code: string; blocking: boolean }) => f.code === "env/referenced-missing" && f.blocking));
  await importFile(t, "API_TOKEN=x\nGREETING=hi\n");
  const d = (await (await post(t, "/api/apps/shop/deploy", "uat", { version: "1.2.0", acknowledgeManual: true })).json()).job.id;
  await finishDeploy(t, d, { digests: { shop: "sha256:d" } });
  const job = await (await t.request(`/api/jobs/${d}`, { as: "viewer" })).json();
  assert.equal(job.record.config_revision, "shop.env#2");

  await put(t, "/api/apps/shop/env", "uat", { base: 2, values: [{ key: "API_TOKEN", keep: true }, { key: "GREETING", value: "yo" }] });
  const p = await (await post(t, "/api/apps/shop/env/plan", "uat", {})).json();
  assert.equal(p.restart, true);
  assert.deepEqual(p.restarts, ["shop"]);
  const { job: envJob } = await (await post(t, "/api/apps/shop/env/apply", "uat", { revision: 3 })).json();
  const request = JSON.parse(readFileSync(join(t.dir, "handoff", "requests", `${envJob.id}.json`), "utf8"));
  assert.deepEqual([request.restart, request.services], [true, ["shop"]]);
  finish(t, envJob.id, "succeeded");
  await t.request("/api/jobs", { as: "viewer" });
  const again = await (await post(t, "/api/apps/shop/env/plan", "uat", { revision: 3 })).json();
  assert.deepEqual([again.changes, again.restarts], [[], []], "rewriting the same values restarts nothing");
});

test("the fingerprint for comparing environments hides secrets behind the shared key", async () => {
  const t = withEnvApp();
  await importFile(t, "GREETING=hi\nAPI_TOKEN=tok\n");
  const fp = await (await t.request("/api/apps/shop/env/fingerprint", { as: "viewer" })).json();
  assert.equal(fp.environment, "uat");
  assert.deepEqual(fp.keys.GREETING, { value: "hi" });
  assert.match(fp.keys.API_TOKEN.secret, /^[\w-]{22}$/);
  assert.ok(!JSON.stringify(fp).includes("tok\""));
});

// Phase 4: artifacts, promotion to PROD, the two Deployers.

const PEER_KEY = "dpr_test-key";
const peerKeySha = createHash("sha256").update(PEER_KEY).digest("hex");

/** UAT has built and deployed shop 1.2.0 (digest sha256:uat1); PROD knows the same manifest. */
async function uatAndProd(options: { soakHours?: number; key?: string } = {}) {
  const uat = setup({ peerKeys: [peerKeySha] });
  writeFileSync(join(uat.dir, "environment.json"), JSON.stringify({ name: "uat", project: "open-atlas", bindIp: "127.0.0.1", registries: { ghcr: "ghcr.io/acme" }, apps: { shop: { version: "1.2.0" } } }));
  uat.store.saveManifest(built, { id: "t", via: "cli" });
  uat.beat();
  const b = (await (await post(uat, "/api/apps/shop/build", "uat", { version: "1.2.0" })).json()).jobs[0].id;
  finish(uat, b, "succeeded", { image: "ghcr.io/acme/open-atlas-shop:1.2.0", digest: "sha256:uat1", build: { version: "1.2.0", commit: "c0ffee", dirty: false } });
  await uat.request("/api/jobs", { as: "viewer" });
  const d = (await (await post(uat, "/api/apps/shop/deploy", "uat", { version: "1.2.0", acknowledgeManual: true })).json()).job.id;
  await finishDeploy(uat, d, { digests: { shop: "sha256:uat1" }, builds: { shop: { version: "1.2.0", commit: "c0ffee" } } });

  const prod = setup({ uat: { app: uat.app, key: options.key ?? PEER_KEY } });
  writeFileSync(join(prod.dir, "environment.json"), JSON.stringify({ name: "prod", project: "open-atlas", bindIp: "127.0.0.1", registries: { ghcr: "ghcr.io/acme" },
    apps: { shop: { version: "1.2.0", ...(options.soakHours ? { uatSoakHours: options.soakHours } : {}) } } }));
  prod.store.saveManifest(built, { id: "t", via: "cli" });
  prod.beat();
  return { uat, prod, uatDeploy: d as string };
}

test("UAT keeps every built and deployed image as an artifact, with where it ran", async () => {
  const { uat, uatDeploy } = await uatAndProd();
  const { artifacts } = await (await uat.request("/api/artifacts", { as: "viewer" })).json();
  assert.equal(artifacts.length, 1);
  assert.deepEqual([artifacts[0].service, artifacts[0].digest, artifacts[0].ref, artifacts[0].origin, artifacts[0].build.commit], ["shop", "sha256:uat1", "ghcr.io/acme/open-atlas-shop", "build", "c0ffee"]);
  assert.deepEqual(artifacts[0].deployments.map((d: { id: string; state: string }) => [d.id, d.state]), [[uatDeploy, "succeeded"]]);
});

test("the peer API answers only the read-only key", async () => {
  const { uat, uatDeploy } = await uatAndProd();
  assert.equal((await uat.request("/api/peer/status")).status, 401);
  assert.equal((await uat.request("/api/peer/status", { headers: { authorization: "Bearer dpr_wrong" } })).status, 401);
  assert.equal((await uat.request("/api/peer/status", { as: "admin" })).status, 401, "a Workbench session is not the key");
  const status = await (await uat.request("/api/peer/status", { headers: { authorization: `Bearer ${PEER_KEY}` } })).json();
  assert.deepEqual(status, { environment: "uat", apps: { shop: { version: "1.2.0", deployment: uatDeploy, deployedAt: "2026-10-30T10:00:00.000Z", digests: { shop: "sha256:uat1" } } } });
  const plain = setup();
  assert.equal((await plain.request("/api/peer/status", { headers: { authorization: `Bearer ${PEER_KEY}` } })).status, 404, "no key configured, no peer API");
});

test("PROD deploys exactly the digests UAT ran, and says so", async () => {
  const { prod, uatDeploy } = await uatAndProd();
  const p = await (await post(prod, "/api/apps/shop/plan", "prod", { version: "1.2.0" })).json();
  assert.deepEqual(p.findings.filter((f: { blocking: boolean }) => f.blocking), [], "PROD does not need its own build");
  assert.equal(p.promotion.basis, "uat");
  assert.equal(p.promotion.uatDeployment, uatDeploy);
  assert.equal(p.changes[0].pin, "sha256:uat1");
  const { job } = await (await post(prod, "/api/apps/shop/deploy", "prod", { version: "1.2.0", acknowledgeManual: true })).json();
  const request = JSON.parse(readFileSync(join(prod.dir, "handoff", "requests", `${job.id}.json`), "utf8"));
  assert.equal(request.images[0].pin, "sha256:uat1");
  assert.equal(request.promotion.basis, "uat");
  await finishDeploy(prod, job.id, { digests: { shop: "sha256:uat1" } }, "prod");
  const view = await (await prod.request(`/api/jobs/${job.id}`, { as: "viewer" })).json();
  assert.equal(view.promotion.uatDeployment, uatDeploy);
  const { artifacts } = await (await prod.request("/api/artifacts", { as: "viewer" })).json();
  assert.deepEqual([artifacts[0].origin, artifacts[0].deployments[0].promotion], ["uat", "uat"]);
  const status = await (await prod.request("/api/status", { as: "viewer" })).json();
  assert.equal(status.peer.apps.shop.version, "1.2.0");
});

test("PROD refuses what UAT has not run and is not released; a release or an administrator's reason lets it through", async () => {
  const { prod } = await uatAndProd();
  const p = await (await post(prod, "/api/apps/shop/plan", "prod", { version: "1.3.0" })).json();
  const refusal = p.findings.find((f: { code: string }) => f.code === "deploy/not-promoted");
  assert.ok(refusal?.blocking);
  assert.match(refusal.message, /1\.3\.0 没有在 UAT 部署成功过；acme\/shop 的 shop-1\.3\.0 没有 GitHub Release/);

  assert.equal((await post(prod, "/api/apps/shop/plan", "prod", { version: "1.3.0", override: { reason: "hotfix" } })).status, 403, "only an administrator overrides");
  assert.equal((await post(prod, "/api/apps/shop/plan", "admin", { version: "1.3.0", override: { reason: " " } })).status, 400, "with a reason");
  const overridden = await (await post(prod, "/api/apps/shop/plan", "admin", { version: "1.3.0", override: { reason: "紧急修复 INC-42" } })).json();
  assert.deepEqual(overridden.findings.filter((f: { blocking: boolean }) => f.blocking), []);
  assert.equal(overridden.promotion.basis, "override");
  const { job } = await (await post(prod, "/api/apps/shop/deploy", "admin", { version: "1.3.0", acknowledgeManual: true, override: { reason: "紧急修复 INC-42" } })).json();
  assert.ok(prod.store.listAudit().some((e) => e.action === "deploy.promotion-override" && (e.detail as { reason: string }).reason === "紧急修复 INC-42"));
  finish(prod, job.id, "failed");
  await prod.request("/api/jobs", { as: "viewer" });

  prod.released.value = true;
  const released = await (await post(prod, "/api/apps/shop/plan", "prod", { version: "1.3.0" })).json();
  assert.equal(released.promotion.basis, "release");
  assert.equal(released.changes[0].pin, undefined, "a release is pulled by its tag");
});

test("an unreachable UAT is named; the soak time counts until UAT replaced the version", async () => {
  const wrongKey = await uatAndProd({ key: "dpr_wrong" });
  const p = await (await post(wrongKey.prod, "/api/apps/shop/plan", "prod", { version: "1.2.0" })).json();
  assert.match(p.findings.find((f: { code: string }) => f.code === "deploy/not-promoted").message, /无法确认 UAT 记录（UAT 的 Deployer 返回 HTTP 401/);

  const { prod } = await uatAndProd({ soakHours: 4 });
  prod.advance(2 * 3_600_000);
  const early = await (await post(prod, "/api/apps/shop/plan", "prod", { version: "1.2.0" })).json();
  assert.match(early.findings.find((f: { code: string }) => f.code === "deploy/not-promoted").message, /只运行了 2\.0 小时，要求 4 小时/);
  prod.advance(3 * 3_600_000);
  const later = await (await post(prod, "/api/apps/shop/plan", "prod", { version: "1.2.0" })).json();
  assert.equal(later.promotion.basis, "uat");
});

test("PROD compares env with UAT through the peer API", async () => {
  const { uat, prod } = await uatAndProd();
  uat.store.saveManifest(withEnv, { id: "t", via: "cli" });
  await importFile(uat, "GREETING=hi\nAPI_TOKEN=tok\n");
  const fp = await (await prod.request("/api/apps/shop/env/peer-fingerprint", { as: "viewer" })).json();
  assert.equal(fp.environment, "uat");
  assert.deepEqual(fp.keys.GREETING, { value: "hi" });
  assert.ok(fp.keys.API_TOKEN.secret);
});

// Phase 5: a Logbook-shaped app, every component type, against faked GitHub, Workbench, Studio and OMA.

const bookFiles = {
  "app/app.json": JSON.stringify({ id: "book", version: "1.0.0", agentSlots: { assistant: { name: "Book Assistant" } } }),
  "pkg/db/01-init.sql": "create schema api;",
  "pkg/migrations/001-add.sql": "alter table x add column y int;",
  "graph/saved-queries.json": JSON.stringify([{ name: "overview", description: "the portfolio", eql: "[:x]" }, { name: "detail", description: "one item", params: [{ name: "id", type: "string" }], eql: "{:entity {:x/id ?id}}" }]),
  "agents/assistant.md": "You are the assistant of Book.\n",
};
const bookRelease = { repo: "acme/book", tag: "v{version}", manifest: "package.json" as const };
const bookBundle = { kind: "release-asset" as const, repo: "acme/book", asset: "book-{version}.tar.gz" };
const ui = { id: "ui", type: "workbench-app", dependsOn: ["db"] };
const assistant = { id: "assistant", type: "oma-agent", file: "agents/assistant.md", bind: "book", package: "book-assistant.oma.json", dependsOn: ["ui", "graph"] };
const book = { v: 1, app: "book", appliesFrom: "1.0.0", release: bookRelease, bundle: bookBundle,
  components: [
    { id: "db", type: "compose-service", service: "book-db", source: { kind: "public-registry", image: "postgres:16.4" }, volumes: [{ target: "/docker-entrypoint-initdb.d", file: "pkg/db" }] },
    { id: "migrate", type: "db-migration", target: "db", migrations: "pkg/migrations", dependsOn: ["db"] },
    { id: "graph", type: "studio-graph", dir: "graph", savedQueries: "graph/saved-queries.json", contract: "book.graph.edn", dependsOn: ["db"] },
    ui, assistant,
    { id: "first", type: "manual", steps: ["import the data export"], when: "install", dependsOn: ["assistant"] },
  ] };
const wbManifest = { v: 1, app: "workbench", appliesFrom: "1.0.0", release: { repo: "acme/workbench", tag: "workbench-{version}", manifest: "release.json" },
  components: [{ id: "web", type: "compose-service", service: "workbench", source: { kind: "public-registry", image: "nginx:1.27.0" } }] };

function withBook(manifest: Record<string, unknown> = book) {
  const s = fakeState();
  s.assets["acme/book@v1.0.0/book-1.0.0.tar.gz"] = tarGz({ ...bookFiles, SHA256SUMS: Object.entries(bookFiles).map(([p, c]) => `${sha256(c)}  ${p}`).join("\n") + "\n" }, "book-1.0.0");
  s.manifests["acme/book@v1.0.0"] = { provides: { book: "1" }, requires: { "workbench-app": "^1.3" } };
  s.manifests["acme/workbench@workbench-1.24.0"] = { provides: { "workbench-app": "1.5" } };
  s.manifests["acme/workbench@workbench-1.2.0"] = { provides: { "workbench-app": "1.2" } };
  s.workbench.apps.push({ id: "book", version: "0.9.0", agentSlots: { assistant: { name: "Book Assistant", businessAgentId: "ba1" } } });
  s.workbench.agents.push({ id: "ba1", name: "Book Assistant", agentId: "agent_old", enabled: true });
  const t = setup({ services: s });
  const environment = (workbench: string) => writeFileSync(join(t.dir, "environment.json"), JSON.stringify({ name: "uat", project: "open-atlas", bindIp: "127.0.0.1", registries: {},
    apps: { workbench: { version: workbench }, book: { version: "1.0.0", settings: { graph: { graph: "acme/book" }, assistant: { model: "claude-x", mcpUrl: "https://dp:9632/mcp/g-uat" } } } } }));
  environment("1.24.0");
  mkdirSync(join(t.dir, "templates"), { recursive: true });
  writeFileSync(join(t.dir, "templates", "book.graph.edn"), "{:contract {:contract/family \"atlas-semantic\"}\n :workspace {:workspace/id \"ws-dev\"}\n :graph {:graph/id \"g-dev\" :graph/label \"Book\"}\n :entities []\n :ownership {:entities {\"book.item\" \"g-dev\"}}}");
  writeFileSync(join(t.dir, "templates", "book-assistant.oma.json"), JSON.stringify({ name: "book", display_name: "Book Assistant",
    agents: [{ key: "assistant", name: "Book Assistant", model: "{{model}}", system: "{{system}}", mcp_servers: [{ name: "book", url: "{{mcpUrl}}" }] }] }));
  t.store.saveManifest(wbManifest, { id: "t", via: "cli" });
  t.store.saveManifest(manifest, { id: "t", via: "cli" });
  return { ...t, s, environment };
}

async function settle(t: ReturnType<typeof setup>, id: string) {
  for (let i = 0; i < 50; i++) {
    const { job } = await (await t.request(`/api/jobs/${id}`, { as: "viewer" })).json();
    if (!["queued", "running"].includes(job.state) || job.rollout?.steps.some((s: { state: string }) => s.state === "waiting")) return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("the deploy did not settle");
}

test("a plan lists every component in order, with the bundle and the contract check", async () => {
  const t = withBook();
  t.beat();
  const p = await (await post(t, "/api/apps/book/plan", "uat", { version: "1.0.0" })).json();
  assert.deepEqual(p.findings.filter((f: { blocking: boolean }) => f.blocking), []);
  assert.deepEqual(p.steps.map((s: { component: string; where: string }) => `${s.component}/${s.where}`), ["db/host", "migrate/host", "graph/deployer", "ui/deployer", "assistant/deployer", "first/person"]);
  const step = (id: string) => p.steps.find((s: { component: string }) => s.component === id);
  assert.equal(step("ui").before, "book 0.9.0");
  assert.match(step("ui").after, /^book 1\.0\.0（book-1\.0\.0\.tar\.gz，sha256:/);
  assert.equal(step("graph").before, "acme/book 草稿第 3 版");
  assert.match(step("migrate").after, /pkg\/migrations 里还没执行过的迁移（共 1 个）/);
  assert.deepEqual(step("first").checks, ["import the data export"]);
  assert.equal(p.bundle.checked, 5);
  assert.ok(p.findings.some((f: { code: string }) => f.code === "deploy/bundle-checked"));

  t.environment("1.2.0");
  const old = await (await post(t, "/api/apps/book/plan", "uat", { version: "1.0.0" })).json();
  assert.deepEqual(old.findings.filter((f: { blocking: boolean }) => f.blocking).map((f: { message: string }) => f.message), ["book 1.0.0 要求 workbench-app ^1.3，workbench 1.2.0 提供的是 1.2。"]);
});

test("a deploy runs the executor's part, then Studio, Workbench and OMA, then waits for people", async () => {
  const t = withBook();
  t.beat();
  const { job } = await (await post(t, "/api/apps/book/deploy", "uat", { version: "1.0.0" })).json();
  const request = JSON.parse(readFileSync(join(t.dir, "handoff", "requests", `${job.id}.json`), "utf8"));
  const digest = sha256(t.s.assets["acme/book@v1.0.0/book-1.0.0.tar.gz"]!);
  assert.deepEqual(request.files, { bundle: { repo: "acme/book", tag: "v1.0.0", asset: "book-1.0.0.tar.gz", sha256: digest }, paths: ["pkg/db", "pkg/migrations"] });
  assert.deepEqual(request.migrations, [{ component: "migrate", service: "book-db", install: null, migrations: "pkg/migrations", backup: true }]);
  assert.deepEqual(request.services, ["book-db"]);
  assert.equal(t.s.workbench.apps[0]!.version, "0.9.0", "nothing of the Deployer's part before the containers are up");

  finish(t, job.id, "succeeded", { digests: { "book-db": "sha256:pg" }, migrations: ["pkg/migrations/001-add.sql"] });
  const waiting = await settle(t, job.id);
  assert.deepEqual(waiting.rollout.steps.map((s: { component: string; state: string }) => `${s.component} ${s.state}`),
    ["db succeeded", "migrate succeeded", "graph succeeded", "ui succeeded", "assistant succeeded", "first waiting"]);
  assert.match(t.s.studio.uploaded!, /:workspace\/id "ws-uat"/);
  assert.match(t.s.studio.uploaded!, /:graph\/id "g-uat"/);
  assert.ok(!t.s.studio.uploaded!.includes("ws-dev") && !t.s.studio.uploaded!.includes("g-dev"), "the source ids are gone everywhere, :ownership included");
  assert.match(t.s.studio.uploaded!, /"book.item" "g-uat"/);
  assert.deepEqual([t.s.studio.queries, t.s.studio.published], [["overview", "detail"], 1]);
  assert.deepEqual([t.s.workbench.apps[0]!.version, t.s.workbench.apps[0]!.previousVersion], ["1.0.0", "0.9.0"]);
  const sent = (t.s as unknown as { lastManifest: { agents: { model: string; system: string; mcp_servers: { url: string }[] }[] } }).lastManifest;
  assert.deepEqual([sent.agents[0]!.model, sent.agents[0]!.system, sent.agents[0]!.mcp_servers[0]!.url], ["claude-x", "You are the assistant of Book.\n", "https://dp:9632/mcp/g-uat"]);
  assert.equal(t.s.workbench.agents[0]!.agentId, "agent_1", "the Business Agent points at the new agent");
  assert.ok(waiting.rollout.log.some((l: string) => l.includes("Business Agent Book Assistant now points at agent_1")));

  await tickAll(t, job.id);
  const done = (await (await t.request(`/api/jobs/${job.id}`, { as: "viewer" })).json());
  assert.equal(done.job.state, "succeeded");
  assert.deepEqual(done.record.artifact_digest, { "book-db": "sha256:pg", bundle: `sha256:${digest}` });
  const { artifacts } = await (await t.request("/api/artifacts", { as: "viewer" })).json();
  assert.ok(artifacts.some((a: { service: string; digest: string }) => a.service === "bundle" && a.digest === `sha256:${digest}`));
  assert.equal(t.store.componentState("book", "assistant").get("agentId"), "agent_1");

  // The next deploy of the assistant publishes a new revision of the same package.
  const again = await (await post(t, "/api/apps/book/plan", "uat", { version: "1.0.0" })).json();
  assert.equal(again.steps.find((s: { component: string }) => s.component === "assistant").before, "agent agent_1");
  assert.equal(again.steps.some((s: { component: string }) => s.component === "first"), false, "install-only steps are not repeated");
});

test("a failing Deployer step rolls back the ones before it; with no containers the executor is not needed", async () => {
  const t = withBook({ ...book, components: [{ ...ui, dependsOn: [] }, { ...assistant, dependsOn: ["ui"] }] });
  t.s.oma.failPublish = true;
  const p = await (await post(t, "/api/apps/book/plan", "uat", { version: "1.0.0" })).json();
  assert.deepEqual(p.findings.filter((f: { blocking: boolean }) => f.blocking), [], "no executor needed");
  const { job } = await (await post(t, "/api/apps/book/deploy", "uat", { version: "1.0.0" })).json();
  const done = await settle(t, job.id);
  assert.equal(done.state, "failed");
  assert.match(done.message, /组件 assistant 失败：publish_package: model not available。已撤回：Workbench 的 book 切回 0\.9\.0/);
  assert.deepEqual(done.rollout.steps.map((s: { state: string }) => s.state), ["rolled-back", "failed"]);
  assert.equal(t.s.workbench.apps[0]!.version, "0.9.0");
  assert.equal(t.s.workbench.agents[0]!.agentId, "agent_old");
  assert.ok(!readdirSync(join(t.dir, "handoff")).includes("requests"), "nothing went to the executor");
});

test("missing settings and credentials block the plan and say where to set them", async () => {
  const t = withBook();
  t.beat();
  writeFileSync(join(t.dir, "environment.json"), JSON.stringify({ name: "uat", project: "open-atlas", bindIp: "127.0.0.1", registries: {}, apps: { workbench: { version: "1.24.0" }, book: { version: "1.0.0" } } }));
  t.s.workbench.key = "rotated";
  const p = await (await post(t, "/api/apps/book/plan", "uat", { version: "1.0.0" })).json();
  const blocking = p.findings.filter((f: { blocking: boolean }) => f.blocking).map((f: { code: string; message: string }) => `${f.code} ${f.message}`);
  assert.ok(blocking.some((m: string) => m.startsWith("studio-graph/graph") && m.includes("apps.book.settings.graph.graph")));
  assert.ok(blocking.some((m: string) => m.startsWith("oma-agent/settings") && m.includes("{{model}}、{{mcpUrl}}")));
  assert.ok(blocking.some((m: string) => m.startsWith("workbench-app/unreachable") && m.includes("HTTP 401")));
});

// Phase 6: API keys, /mcp, failure diagnosis through OMA.

const bearer = (t: ReturnType<typeof setup>, path: string, key: string, init: RequestInit = {}) =>
  t.request(path, { ...init, headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(init.headers ?? {}) } });
let rpcId = 0;
async function mcp(t: ReturnType<typeof setup>, key: string, method: string, params?: unknown) {
  const r = await bearer(t, "/mcp", key, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, ...(params ? { params } : {}) }) });
  return { status: r.status, body: await r.json() };
}
async function tool(t: ReturnType<typeof setup>, key: string, name: string, args: Record<string, unknown> = {}) {
  const { body } = await mcp(t, key, "tools/call", { name, arguments: args });
  return { isError: Boolean(body.result?.isError), value: JSON.parse(body.result.content[0].text) };
}
const makeKey = async (t: ReturnType<typeof setup>, as: string, body: Record<string, unknown>) => {
  const r = await post(t, "/api/keys", as, body);
  return { status: r.status, body: await r.json() };
};

test("a personal key acts as its owner as Workbench has them now; a key never makes a key", async () => {
  const t = withBook();
  const made = await makeKey(t, "uat", { name: "my laptop", days: 30 });
  assert.equal(made.status, 201);
  assert.match(made.body.key, /^dpk_/);
  assert.equal(made.body.record.prefix, made.body.key.slice(0, 12));
  assert.ok(!JSON.stringify(t.store.listKeys()).includes(made.body.key), "only the SHA-256 is kept");
  assert.equal((await makeKey(t, "uat", { kind: "service", name: "assistant", days: 30 })).status, 403, "service keys are for administrators");
  assert.equal((await makeKey(t, "uat", { name: "x", days: 400 })).status, 400);

  const key = made.body.key as string;
  const status = await bearer(t, "/api/status", key);
  assert.equal(status.status, 200);
  const viaKey = await bearer(t, "/api/keys", key, { method: "POST", body: JSON.stringify({ name: "another", days: 1 }) });
  assert.equal(viaKey.status, 403, "a key never makes a key");

  t.s.workbench.users[0]!.roleIds = [];
  assert.equal((await bearer(t, "/api/status", key)).status, 403, "out of the Groups: refused on the next call");
  t.s.workbench.users[0]!.roleIds = ["r_uat"];
  t.s.workbench.users[0]!.enabled = false;
  assert.equal((await bearer(t, "/api/status", key)).status, 401);
  t.s.workbench.users[0]!.enabled = true;
  const { keys } = await (await t.request("/api/keys", { as: "uat" })).json();
  assert.equal((await t.request(`/api/keys/${keys[0].id}`, { method: "DELETE", as: "uat", headers: { "x-csrf-token": "csrf-uat" } })).status, 200);
  assert.equal((await bearer(t, "/api/status", key)).status, 401, "revoked");
  t.advance(0);
  assert.deepEqual(t.store.listAudit().filter((e) => e.action.startsWith("key.")).map((e) => e.action), ["key.revoke", "key.create"]);
});

test("/mcp: tools are the page's calls; a service key sees only the read-only ones", async () => {
  const t = withBook();
  t.beat();
  const service = (await makeKey(t, "admin", { kind: "service", name: "deploy-assistant", days: 365 })).body.key as string;
  const personal = (await makeKey(t, "uat", { name: "cli", days: 30 })).body.key as string;
  assert.equal((await mcp(t, "dpk_wrong", "tools/list")).status, 401);
  const init = await mcp(t, service, "initialize", { protocolVersion: "2025-03-26" });
  assert.equal(init.body.result.serverInfo.name, "open-atlas-deployer");
  const serviceTools = (await mcp(t, service, "tools/list")).body.result.tools as { name: string; annotations: { readOnlyHint: boolean } }[];
  assert.ok(serviceTools.every((x) => x.annotations.readOnlyHint || /draft_/.test(x.name)), "read-only tools, and draft tools that need a task token");
  assert.ok(serviceTools.some((x) => x.name === "plan_deploy") && !serviceTools.some((x) => x.name === "deploy"));
  const personalTools = (await mcp(t, personal, "tools/list")).body.result.tools as { name: string }[];
  assert.ok(personalTools.some((x) => x.name === "deploy"));

  const plan = await tool(t, service, "plan_deploy", { app: "book", version: "1.0.0" });
  assert.equal(plan.isError, false);
  assert.equal(plan.value.steps.length, 6);
  assert.equal((await tool(t, service, "deploy", { app: "book", version: "1.0.0", request_id: "r1" })).value.finding.code, "mcp/unknown-tool", "no write tools for the service key");
  assert.equal((await tool(t, service, "plan_deploy", { app: "book", version: "1.0.0", force: true })).value.finding.expected, "plan_deploy 没有参数 force");
  assert.equal((await tool(t, service, "get_env", { app: "book" })).value.finding.code, "env/none", "a refusal is the route's own finding");

  // A command with request_id: the retry returns the first answer, one job only.
  const first = await tool(t, personal, "deploy", { app: "book", version: "1.0.0", request_id: "deploy-1" });
  const again = await tool(t, personal, "deploy", { app: "book", version: "1.0.0", request_id: "deploy-1" });
  assert.equal(first.isError, false);
  assert.equal(again.value.job.id, first.value.job.id);
  assert.equal(t.store.listJobs({ kind: "deploy" }).length, 1);
  assert.equal((await tool(t, personal, "deploy", { app: "book", version: "1.0.0" })).value.finding.expected, "deploy 缺参数 request_id");
  assert.ok(t.store.listAudit().some((e) => e.action === "mcp.deploy" && e.via === "key" && e.actor === "u@x"));
});

test("PROD execution, overriding promotion and revealing secrets take a browser session", async () => {
  const t = withBook();
  t.beat();
  writeFileSync(join(t.dir, "environment.json"), JSON.stringify({ name: "prod", project: "open-atlas", bindIp: "127.0.0.1", registries: {}, apps: { workbench: { version: "1.24.0" }, book: { version: "1.0.0", settings: { graph: { graph: "acme/book" }, assistant: { model: "m", mcpUrl: "u" } } } } }));
  const admin = (await makeKey(t, "admin", { name: "admin cli", days: 1 })).body.key as string;
  const deploy = await tool(t, admin, "deploy", { app: "book", version: "1.0.0", request_id: "p1" });
  assert.equal(deploy.value.finding.code, "auth/browser-only");
  const override = await bearer(t, "/api/apps/book/plan", admin, { method: "POST", body: JSON.stringify({ version: "1.0.0", override: { reason: "hotfix now" } }) });
  assert.equal((await override.json()).error, "auth/browser-only");
  const reveal = await bearer(t, "/api/apps/book/env/reveal", admin, { method: "POST", body: JSON.stringify({ revision: 1, key: "X" }) });
  assert.deepEqual([reveal.status, (await reveal.json()).error], [403, "auth/browser-only"]);
  assert.equal((await tool(t, admin, "plan_deploy", { app: "book", version: "1.0.0" })).isError, false, "a key may still plan in PROD");
});

test("a failed deploy is diagnosed by the Deploy Assistant through OMA, and the record shows it", async () => {
  const t = withBook();
  t.beat();
  writeFileSync(join(t.dir, "oma.key"), "oma_test");
  const diagnoser = new Diagnoser(t.store, { url: "http://oma.test", keyFile: join(t.dir, "oma.key"), agent: "agent_assistant", environment: "env_1", vaults: ["vlt_1"], application: "app_deployer" },
    () => "pulling\nlogbook-api: FATAL: password authentication failed for user \"authenticator\"\n", fakeServices(t.s), () => Date.parse("2026-10-30T10:00:00Z"));
  t.deployments.onFailure = (job) => diagnoser.start(job);
  const { job } = await (await post(t, "/api/apps/book/deploy", "uat", { version: "1.0.0" })).json();
  finish(t, job.id, "rolled-back", { digests: {} });
  await t.request("/api/jobs", { as: "viewer" });
  const session = t.s.oma.sessions[0]!;
  assert.deepEqual([session.body.agent, session.body.environment_id, session.body.vault_ids, session.body.app_id, session.body.correlation_id], ["agent_assistant", "env_1", ["vlt_1"], "app_deployer", job.id]);
  assert.match(session.messages[0]!, /password authentication failed/);
  assert.match(session.messages[0]!, /"state": "rolled-back"/);
  assert.equal(t.store.job(job.id)!.diagnosis!.state, "running");

  await diagnoser.poll();
  assert.equal(t.store.job(job.id)!.diagnosis!.state, "running", "no answer yet");
  t.s.oma.reply = "看了日志。\n```json\n{\"cause\": \"authenticator 的密码与库里不一致\", \"evidence\": [\"FATAL: password authentication failed\"], \"suggestion\": \"核对 AUTHENTICATOR_PASSWORD\", \"confidence\": \"high\"}\n```";
  await diagnoser.poll();
  const view = await (await t.request(`/api/jobs/${job.id}`, { as: "viewer" })).json();
  assert.equal(view.job.diagnosis.state, "done");
  assert.equal(view.job.diagnosis.cause, "authenticator 的密码与库里不一致");
  assert.equal(view.record.diagnosis.confidence, "high");
});

// Phase 7: assessments (§10.5) and version assessments (D27).

const tokenOf = (message: string) => /任务令牌[^：]*：(dtt_[\w-]+)/.exec(message)![1]!;
let draftReq = 0;
const agentTool = (t: ReturnType<typeof setup>, key: string, name: string, id: string, token: string, args: Record<string, unknown>) =>
  tool(t, key, name, { id, task_token: token, request_id: `r${++draftReq}`, reason: "看了 Dockerfile 和 compose.yaml", ...args });

test("an assessment: scan, the Agent fills the draft with its task token, validation, trial in UAT, registration", async () => {
  const t = withBook();
  t.beat();
  t.s.tags["acme/hello"] = ["v1.0.0", "v0.9.0"];
  t.s.releases["acme/hello"] = [{ tag_name: "v1.0.0", name: "1.0.0", draft: false, prerelease: false, published_at: "2026-10-01T00:00:00Z", assets: [] }];
  const service = (await makeKey(t, "admin", { kind: "service", name: "assessor", days: 30 })).body.key as string;
  assert.equal((await post(t, "/api/assessments", "viewer", { repo: "https://github.com/acme/hello" })).status, 403);
  const started = await post(t, "/api/assessments", "uat", { repo: "https://github.com/acme/hello", version: "1.0.0" });
  assert.equal(started.status, 201);
  const a = (await started.json()).assessment;
  assert.equal(a.tokenSha256, undefined, "the token is never shown");
  assert.deepEqual(a.facts.tags, ["v1.0.0", "v0.9.0"]);
  assert.equal(a.facts.releases[0].tag, "v1.0.0");
  assert.ok(a.facts.environment.apps.some((x: { app: string }) => x.app === "book"));
  const session = t.s.oma.sessions[0]!;
  assert.deepEqual([session.body.agent, session.body.environment_id], ["agent_assessor", "env_isolated"], "the isolated Environment");
  const token = tokenOf(session.messages[0]!);
  assert.match(session.messages[0]!, /不执行仓库里的任何脚本/);

  // The Agent configures the draft; a wrong token or another assessment's is refused.
  assert.equal((await agentTool(t, service, "draft_app", a.id, "dtt_wrong", { app: "hello" })).value.finding.code, "assessment/token");
  assert.equal((await tool(t, service, "draft_app", { id: a.id, task_token: token, request_id: "x1", app: "hello" })).value.finding.expected, "draft_app 缺参数 reason");
  await agentTool(t, service, "draft_app", a.id, token, { app: "hello", name: "Hello", applies_from: "1.0.0" });
  const early = await tool(t, service, "validate_draft", { id: a.id });
  assert.ok(early.value.findings.some((f: { code: string }) => f.code === "draft/release" || f.code === "draft/schema"));
  await agentTool(t, service, "draft_app", a.id, token, { app: "hello", name: "Hello", applies_from: "1.0.0", release_repo: "acme/hello", tag_pattern: "v{version}", release_manifest: "package.json" });
  await agentTool(t, service, "draft_component", a.id, token, { component: "web", type: "compose-service" });
  await agentTool(t, service, "draft_source", a.id, token, { component: "web", source: { kind: "public-registry", image: "nginx:latest" } });
  await agentTool(t, service, "draft_runtime", a.id, token, { component: "web", service: "hello-web", ports: [{ container: 80, host: 18080 }], environment: { GREETING: "${GREETING}" } });
  const forbidden = await agentTool(t, service, "draft_compose_extra", a.id, token, { component: "web", fields: { privileged: true } });
  assert.equal(forbidden.value.finding.code, "draft/compose-forbidden");
  await agentTool(t, service, "draft_env_key", a.id, token, { key: "GREETING", description: "greeting text", secret: false, default: "hi" });
  assert.equal((await agentTool(t, service, "draft_env_key", a.id, token, { key: "API_TOKEN", description: "x", secret: true, default: "s3" })).value.finding.code, "draft/env-secret");
  const latest = await tool(t, service, "validate_draft", { id: a.id });
  assert.deepEqual(latest.value.findings.map((f: { code: string }) => f.code), ["draft/schema"]);
  assert.match(latest.value.findings[0].expected, /latest/, "a public image needs a fixed version");
  // A person continues on the page, with their own reason.
  const fixed = await post(t, `/api/assessments/${a.id}/draft/source`, "uat", { component: "web", source: { kind: "public-registry", image: "nginx:1.27.0" }, reason: "固定版本号" });
  assert.equal(fixed.status, 200);
  assert.deepEqual((await tool(t, service, "validate_draft", { id: a.id })).value.findings, []);
  await agentTool(t, service, "draft_report", a.id, token, { level: "B", report: "能部署：一个容器，补了 env 模板" });

  t.s.oma.reply = "评估完成，B 级。";
  const ready = await (await t.request(`/api/assessments/${a.id}`, { as: "viewer" })).json();
  assert.equal(ready.state, "ready");
  assert.deepEqual(ready.changes.map((c: { by: string; operation: string }) => `${c.by.startsWith("agent:") ? "agent" : c.by} ${c.operation}`).slice(-3), ["agent env-key", "u@x source", "agent report"]);
  assert.equal(ready.manifest.env.template, "templates/hello.env.example");

  // Trial in UAT by a deploy-uat person; registration by an administrator once the trial succeeded.
  assert.equal((await post(t, `/api/assessments/${a.id}/register`, "admin", {})).status, 409, "no trial yet");
  const trial = await (await post(t, `/api/assessments/${a.id}/trial`, "uat", {})).json();
  assert.equal(t.store.app("hello")!.trial, a.id);
  assert.equal(readFileSync(join(t.dir, "kept", "hello.env.example"), "utf8").includes("GREETING=hi"), true);
  const request = JSON.parse(readFileSync(join(t.dir, "handoff", "requests", `${trial.job.id}.json`), "utf8"));
  assert.deepEqual(request.images, [{ service: "hello-web", ref: "nginx:1.27.0", build: false }]);
  assert.equal((await post(t, `/api/assessments/${a.id}/register`, "uat", {})).status, 403, "registration is for administrators");
  finish(t, trial.job.id, "succeeded", { digests: { "hello-web": "sha256:h" } });
  await t.request("/api/jobs", { as: "viewer" });
  const registered = await (await post(t, `/api/assessments/${a.id}/register`, "admin", {})).json();
  assert.equal(registered.state, "registered");
  assert.equal(t.store.app("hello")!.trial, null);
  assert.equal((await agentTool(t, service, "draft_app", a.id, token, { app: "hello" })).value.finding.code, "assessment/closed", "the token dies with the assessment");
});

test("level C drafts an issue for the Deployer's own repository; a person opens it", async () => {
  const t = withBook();
  const service = (await makeKey(t, "admin", { kind: "service", name: "assessor", days: 30 })).body.key as string;
  const a = (await (await post(t, "/api/assessments", "uat", { repo: "https://github.com/acme/desktop" })).json()).assessment;
  const token = tokenOf(t.s.oma.sessions[0]!.messages[0]!);
  await agentTool(t, service, "draft_issue", a.id, token, { kind: "onboarding", title: "acme/desktop 缺 Dockerfile", body: "只能本地 npm start；建议加 Dockerfile 并读环境变量" });
  await agentTool(t, service, "draft_report", a.id, token, { level: "C", report: "需要改仓库" });
  assert.equal(t.s.issues.length, 0, "the Agent cannot open it");
  assert.equal((await post(t, `/api/assessments/${a.id}/trial`, "uat", {})).status, 409, "C is not trial-deployed");
  const opened = await (await post(t, `/api/assessments/${a.id}/issue`, "uat", {})).json();
  assert.equal(opened.issue.url, "https://github.com/acme/deployer/issues/1");
  assert.deepEqual([t.s.issues[0]!.repo, t.s.issues[0]!.labels, t.s.issues[0]!.token], ["acme/deployer", ["onboarding"], "Bearer ghi_test"]);
  assert.match(t.s.issues[0]!.body, new RegExp(`评估 ${a.id}`));
});

test("D27: where the environment requires it, a new version deploys after its assessment is adopted", async () => {
  const t = withBook();
  t.beat();
  const env = JSON.parse(readFileSync(join(t.dir, "environment.json"), "utf8"));
  writeFileSync(join(t.dir, "environment.json"), JSON.stringify({ ...env, requireEvaluation: true }));
  t.s.assets["acme/book@v1.1.0/book-1.1.0.tar.gz"] = t.s.assets["acme/book@v1.0.0/book-1.0.0.tar.gz"]!;
  t.s.manifests["acme/book@v1.1.0"] = t.s.manifests["acme/book@v1.0.0"]!;
  t.s.compares["acme/book v1.0.0...v1.1.0"] = { files: [{ filename: "src/app.ts", status: "modified" }, { filename: ".env.example", status: "modified", patch: "+NEW_FLAG=" }], commits: [{ commit: { message: "1.1.0: a new flag" } }] };
  const blocked = await (await post(t, "/api/apps/book/plan", "uat", { version: "1.1.0" })).json();
  assert.ok(blocked.findings.some((f: { code: string; blocking: boolean }) => f.code === "deploy/not-evaluated" && f.blocking));
  const plain = await (await post(t, "/api/apps/book/plan", "uat", { version: "1.0.0" })).json();
  assert.ok(!plain.findings.some((f: { code: string }) => f.code === "deploy/not-evaluated"), "the version the manifest starts at needs none");

  const service = (await makeKey(t, "admin", { kind: "service", name: "assessor", days: 30 })).body.key as string;
  const a = (await (await post(t, "/api/assessments", "uat", { app: "book", version: "1.1.0" })).json()).assessment;
  assert.equal(a.kind, "version");
  assert.deepEqual(a.facts.changedDeployFiles.map((f: { file: string }) => f.file), [".env.example"], "only the files that matter for the manifest");
  assert.equal(a.draft.manifest.appliesFrom, "1.1.0", "the draft starts as the current manifest, from the new version");
  const token = tokenOf(t.s.oma.sessions[0]!.messages[0]!);
  await agentTool(t, service, "draft_report", a.id, token, { level: "unchanged", report: "只多了一个可选变量 NEW_FLAG，清单不用改" });
  t.s.oma.reply = "清单不用改。";
  await t.request(`/api/assessments/${a.id}`, { as: "viewer" });
  assert.equal((await post(t, `/api/assessments/${a.id}/register`, "uat", {})).status, 403);
  const adopted = await (await post(t, `/api/assessments/${a.id}/register`, "admin", {})).json();
  assert.equal(adopted.state, "adopted");
  const allowed = await (await post(t, "/api/apps/book/plan", "uat", { version: "1.1.0" })).json();
  assert.ok(!allowed.findings.some((f: { code: string }) => f.code === "deploy/not-evaluated"));
});

// Phase 8: the maintenance notice before a deploy (W3), drift, the daily brief.

test("a deploy announced in Workbench waits for its time, then goes out; the notice is cleared when it ends", async () => {
  const t = withBook();
  t.beat();
  const r = await post(t, "/api/apps/book/deploy", "uat", { version: "1.0.0", notice: { minutes: 10 } });
  assert.equal(r.status, 200);
  const { job } = await r.json();
  assert.match(t.s.workbench.maintenance!.message, /^Book 将在 \d\d:\d\d 更新到 1\.0\.0，届时约 1–2 分钟不可用$|^book 将在/);
  assert.equal(Date.parse(t.s.workbench.maintenance!.endsAt) - Date.parse(job.rollout.scheduled.at), 15 * 60_000);
  await t.request("/api/jobs", { as: "viewer" });
  assert.ok(!readdirSync(join(t.dir, "handoff")).includes("requests") || readdirSync(join(t.dir, "handoff", "requests")).length === 0, "nothing goes to the executor before the time");
  t.advance(10 * 60_000);
  await t.request("/api/jobs", { as: "viewer" });
  assert.equal(readdirSync(join(t.dir, "handoff", "requests")).length, 1, "at the time it goes out");
  finish(t, job.id, "rolled-back", { digests: {} });
  await t.request("/api/jobs", { as: "viewer" });
  assert.deepEqual(t.s.workbench.maintenanceLog.map((l) => l.split(" ")[0]), ["set", "cleared"]);

  t.beat();
  const secondBody = await (await post(t, "/api/apps/book/deploy", "uat", { version: "1.0.0", notice: { minutes: 5 } })).json();
  assert.ok(secondBody.job, JSON.stringify(secondBody));
  const second = secondBody.job;
  const cancelled = await (await post(t, `/api/jobs/${second.id}/stop`, "uat", {})).json();
  assert.equal(cancelled.job.state, "failed");
  assert.match(cancelled.job.message, /取消，没有开始/);
  assert.equal(t.s.workbench.maintenance, null, "a cancelled deploy clears its notice");
  assert.equal((await post(t, "/api/apps/book/deploy", "uat", { version: "1.0.0", notice: { minutes: 0 } })).status, 400);
});

test("drift: a container on another version, a fragment or env file edited by hand; shown and audited, never changed back", async () => {
  const t = withEnvApp();
  await importFile(t, "GREETING=hi\nAPI_TOKEN=x\n");
  const b = (await (await post(t, "/api/apps/shop/build", "uat", { version: "1.2.0" })).json()).jobs[0].id;
  finish(t, b, "succeeded");
  await t.request("/api/jobs", { as: "viewer" });
  const d = (await (await post(t, "/api/apps/shop/deploy", "uat", { version: "1.2.0" })).json()).job.id;
  finish(t, d, "succeeded", { digests: { shop: "sha256:d" }, fragmentSha256: "f1" });
  await t.request("/api/jobs", { as: "viewer" });
  const envSha = createHash("sha256").update("GREETING=hi\nAPI_TOKEN=x\n").digest("hex");
  let files: Record<string, string> = { "shop/compose.yaml": "f1", "shop.env": envSha };
  let verdict = "ok";
  const drift = new Drift(t.store, t.deployments, () => files, async () => ({ environment: "uat", unmanaged: [],
    apps: [{ app: "shop", name: "Shop", desired: "1.2.0", verdict, components: [{ id: "web", type: "compose-service", service: "shop", verdict, container: { name: "shop", image: "ghcr.io/acme/open-atlas-shop:1.1.0", state: "running", health: "", status: "Up", version: "1.1.0" } }] }] }) as never);
  assert.deepEqual(await drift.check(), [], "the server matches what the Deployer wrote");

  files = { "shop/compose.yaml": "edited", "shop.env": "edited" };
  verdict = "drift";
  const found = await drift.check();
  assert.deepEqual(found.map((x) => x.kind).sort(), ["env", "fragment", "version"]);
  assert.match(found.find((x) => x.kind === "version")!.detail, /期望 1\.2\.0，实际：shop 运行 1\.1\.0/);
  assert.match(found.find((x) => x.kind === "env")!.detail, /shop\.env 与 Deployer 最后一次导入/);
  await drift.check();
  assert.equal(t.store.listAudit().filter((e) => e.action === "drift.detected").length, 3, "each difference audited once");

  files = { "shop/compose.yaml": "f1", "shop.env": envSha };
  verdict = "ok";
  assert.deepEqual(await drift.check(), []);
  assert.equal(t.store.listAudit().filter((e) => e.action === "drift.resolved").length, 3);
});

test("the daily brief: the facts once a day after its hour, written up by the Deploy Assistant when OMA is there", async () => {
  const t = withBook();
  const facts: BriefFacts = { environment: "uat", apps: [{ app: "book", desired: "1.0.0", verdict: "ok", newer: ["1.1.0"] }], promotable: [], drift: [], failed: [], waiting: [] };
  let clock = Date.parse("2026-10-31T07:30:00");
  const oma = new OmaSessions({ url: "http://oma.test", keyFile: join(t.dir, "oma.key"), agent: "agent_assistant" }, fakeServices(t.s));
  const briefs = new Briefs(t.store, async () => facts, oma, { now: () => clock, hour: 8 });
  await briefs.tick();
  assert.equal(briefs.latest(), undefined, "not before its hour");
  clock = Date.parse("2026-10-31T08:05:00");
  await briefs.tick();
  assert.equal(briefs.latest()!.state, "writing");
  assert.match(t.s.oma.sessions[0]!.messages[0]!, /"newer": \[\s*"1\.1\.0"/);
  t.s.oma.reply = "今天 UAT 一切正常；book 有新版本 1.1.0。\n建议：先评估 1.1.0。";
  await briefs.tick();
  assert.deepEqual([briefs.latest()!.state, briefs.latest()!.text], ["done", t.s.oma.reply]);
  await briefs.tick();
  assert.equal(t.s.oma.sessions.length, 1, "once a day");
  const view = await (await t.request("/api/brief", { as: "viewer" })).json();
  assert.equal(view.brief, null, "this test's Briefs is not the app's; the app's has none yet");
  const plain = new Briefs(t.store, async () => facts, undefined, { now: () => clock });
  assert.equal((await plain.generate("u@x")).state, "facts-only", "without OMA the facts are the brief");
});

test("the brief's facts come from what the Deployer already knows", async () => {
  const t = withBook();
  t.beat();
  const facts = await collectFacts({
    store: t.store, deployments: t.deployments,
    status: async () => ({ environment: "uat", unmanaged: [], apps: [{ app: "book", name: "Book", desired: "1.0.0", verdict: "ok", components: [] }] }) as never,
    versions: { list: async () => ({ versions: ["1.2.0", "1.1.0", "1.0.0", "0.9.0"] }) },
    peer: async () => ({ environment: "uat", apps: { book: { version: "1.1.0", deployment: "d", deployedAt: "x", digests: {} } } }),
    drift: async () => [{ key: "env:book", app: "book", kind: "env", detail: "book.env 被改过", firstSeen: "2026-10-30T00:00:00Z", lastSeen: "x" }],
  });
  assert.deepEqual(facts.apps, [{ app: "book", desired: "1.0.0", verdict: "ok", newer: ["1.2.0", "1.1.0"] }]);
  assert.deepEqual(facts.promotable, [{ app: "book", uat: "1.1.0", here: null }]);
  assert.equal(facts.drift[0]!.detail, "book.env 被改过");
});
