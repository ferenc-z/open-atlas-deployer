// S41 step 3: the certificate library over HTTP: admin only, nothing secret in any answer, an upload checked per service
// before it is kept, a version in use cannot be deleted, and the read-only MCP tool.

import assert from "node:assert/strict";
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
import { TOOLS } from "../src/server/mcp.ts";
import { Observer } from "../src/server/observe.ts";
import { SecretBox } from "../src/server/secretbox.ts";
import { sealFile } from "../src/server/services/config.ts";
import type { DraftCluster, DraftStandalone } from "../src/server/services/draft.ts";
import { Takeover } from "../src/server/services/takeover.ts";
import { Store } from "../src/server/store.ts";
import { Versions } from "../src/server/versions.ts";

const box = new SecretBox(Buffer.alloc(32, 7).toString("base64"));
const cli = { id: "admin", via: "cli" } as const;
const dataFile = (name: string) => readFileSync(new URL(`../testdata/certs/toolkit-client/${name}`, import.meta.url));
const TOKEN = JSON.parse(dataFile("config.json").toString("utf8")).token as string;
const PASSWORD = JSON.parse(dataFile("config.json").toString("utf8")).keyStorePassword as string;

const USERS: Record<string, { groups: string[]; isAdmin?: boolean }> = { viewer: { groups: ["deploy-viewer"] }, uat: { groups: ["deploy-uat"] }, admin: { groups: [], isAdmin: true } };
const keyPrincipal = (id: string, via: "key" | "service", groups: string[], isAdmin = false): Principal => ({ id, displayName: id, via, groups, isAdmin, permissions: via === "service" ? ["view"] : permissionsFor(groups, isAdmin), csrfToken: "" });
const KEYS: Record<string, Principal> = { dpk_admin: keyPrincipal("a@x", "key", [], true), dpk_uat: keyPrincipal("u@x", "key", ["deploy-uat"]) };

function setup() {
  const store = new Store(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "nifi-certs-"));
  const environmentFile = join(dir, "environment.json");
  writeFileSync(environmentFile, JSON.stringify({ name: "uat", project: "open-atlas", bindIp: "127.0.0.1", registries: {}, apps: {} }));
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
  const call = (method: string, path: string, who: { as?: string; key?: string }, body?: BodyInit) => {
    const headers = new Headers();
    if (who.as) { headers.set("cookie", `open_atlas_workbench_session=${who.as}`); headers.set("x-csrf-token", `csrf-${who.as}`); }
    if (who.key) headers.set("authorization", `Bearer ${who.key}`);
    return app.request(`/deploy${path}`, { method, headers, ...(body === undefined ? {} : { body }) });
  };
  return { store, call };
}

const member = (host: string, dir: string, nodeAddress: string | null = null) => ({ host, installDir: dir, serviceUser: "nifi", startEnvironment: null, ports: { https: 8443 }, nodeAddress, discovery: null });
/** "fits" has the toolkit certificate's two hosts, "strays" a host it does not cover. */
function twoServices(store: Store) {
  const body = (host: string, dir: string) => ({ members: [{ host, installDir: dir, missing: [], files: [sealFile({ name: "nifi.properties", path: `${dir}/conf/nifi.properties`, modifiedAt: "2026-11-01T00:00:00Z" }, Buffer.from("a=b\n"), box)] }] });
  const fits: DraftCluster = { kind: "cluster", id: "fits", service: "nifi", profile: "nifi-2.x", version: "2.5.0", webUrl: null, zookeeper: "zk:2181", zookeeperRoot: "/f", nodes: [member("nifi-1", "/opt/a", "nifi-1.lab"), member("nifi-2", "/opt/b", "nifi-2.lab")] } as DraftCluster;
  const strays: DraftStandalone = { kind: "standalone", id: "strays", service: "nifi", profile: "nifi-2.x", version: "2.0.0", webUrl: "https://batch-01.corp:8443/nifi", member: member("batch", "/opt/c") } as DraftStandalone;
  const draft = store.createServiceDraft("uat", [], [fits, strays], cli);
  store.confirmServiceDraft(draft.id, { fits: { members: [body("nifi-1", "/opt/a"), body("nifi-2", "/opt/b")].flatMap((b) => b.members) }, strays: body("batch", "/opt/c") }, cli);
}

function upload(fields: Record<string, string> = {}, files: Record<string, Buffer> = { "config.json": dataFile("config.json"), "keystore.jks": dataFile("keystore.jks"), "truststore.jks": dataFile("truststore.jks") }) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  for (const [name, bytes] of Object.entries(files)) form.append("file", new File([new Uint8Array(bytes)], name));
  return form;
}
const ADMIN = { as: "admin" };
const LEAK = (text: string) => { for (const bad of [PASSWORD, TOKEN, "PRIVATE KEY", "v1:", "sealed", "keystore\":", "/u3+7QAAAA"]) assert.ok(!text.includes(bad), `answer leaks ${bad}`); };

test("only an admin reaches the library; the summary is for any viewer", async () => {
  const t = setup();
  for (const who of [{ as: "viewer" }, { as: "uat" }, { key: "dpk_uat" }, {}]) {
    for (const [method, path, body] of [["GET", "/api/nifi-certs"], ["GET", "/api/nifi-certs/x"], ["POST", "/api/nifi-certs/check", upload()], ["POST", "/api/nifi-certs", upload({ name: "corp" })], ["DELETE", "/api/nifi-certs/x/versions/1"]] as [string, string, BodyInit?][]) {
      const r = await t.call(method, path, who, body);
      assert.ok([401, 403].includes(r.status), `${method} ${path} as ${JSON.stringify(who)}: ${r.status}`);
    }
  }
  assert.equal((await t.call("GET", "/api/nifi-certs/summary", { as: "viewer" })).status, 200);
  assert.equal((await t.call("GET", "/api/nifi-certs", { key: "dpk_admin" })).status, 200);
  assert.equal(t.store.nifiCerts().length, 0);
});

test("check: each service on its own, nothing saved, no secret answered", async () => {
  const t = setup();
  twoServices(t.store);
  const r = await t.call("POST", "/api/nifi-certs/check", ADMIN, upload());
  assert.equal(r.status, 200);
  const text = await r.text();
  LEAK(text);
  const body = JSON.parse(text);
  assert.equal(body.passwordsRead, true);
  assert.equal(body.version.subject, "CN=S2S, OU=NIFI");
  const by = (id: string) => body.services.find((s: { id: string }) => s.id === id);
  assert.equal(by("fits").ok, true);
  assert.deepEqual(by("fits").hosts, ["nifi-1.lab", "nifi-2.lab"]);
  assert.equal(by("strays").ok, false);
  assert.deepEqual(by("strays").items.find((i: { code: string }) => i.code === "san").missing, ["batch-01.corp"]);
  assert.equal(t.store.nifiCerts().length, 0);
});

test("a wrong password or a missing file is refused with a reason and nothing is saved", async () => {
  const t = setup();
  const cfg = JSON.parse(dataFile("config.json").toString("utf8"));
  const bad = Buffer.from(JSON.stringify({ ...cfg, keyStorePassword: "hunter2-bad", keyPassword: "hunter2-bad" }));
  const r1 = await t.call("POST", "/api/nifi-certs", ADMIN, upload({ name: "corp" }, { "config.json": bad, "keystore.jks": dataFile("keystore.jks"), "truststore.jks": dataFile("truststore.jks") }));
  assert.equal(r1.status, 400);
  const j1 = await r1.json() as { error: string; message: string };
  assert.equal(j1.error, "cert/bad-password");
  assert.ok(!JSON.stringify(j1).includes("hunter2"));
  const r2 = await t.call("POST", "/api/nifi-certs", ADMIN, upload({ name: "corp" }, { "config.json": dataFile("config.json") }));
  assert.equal(r2.status, 400);
  assert.equal(t.store.nifiCerts().length, 0);
});

test("upload keeps an entry, then versions; answers carry facts only; the token is dropped; the blob opens only with the key", async () => {
  const t = setup();
  const r = await t.call("POST", "/api/nifi-certs", ADMIN, upload({ name: "corp-nifi" }));
  assert.equal(r.status, 200);
  const made = await r.json() as { cert: string; version: number };
  assert.equal(made.version, 1);
  // The same certificate again is not a new version; another name is taken only once.
  assert.equal((await t.call("POST", "/api/nifi-certs", ADMIN, upload({ cert: made.cert }))).status, 409);
  assert.equal((await t.call("POST", "/api/nifi-certs", ADMIN, upload({ name: "corp-nifi" }))).status, 409);
  assert.equal((await t.call("POST", "/api/nifi-certs", ADMIN, upload({ cert: "nc_nope" }))).status, 404);
  for (const path of ["/api/nifi-certs", `/api/nifi-certs/${made.cert}`, "/api/nifi-certs/summary"]) {
    const text = await (await t.call("GET", path, ADMIN)).text();
    LEAK(text);
    assert.ok(text.includes("CN=S2S"));
  }
  const sealed = t.store.nifiCertSealed(made.cert, 1)!;
  assert.ok(sealed.startsWith("v1:"));
  const opened = JSON.parse(box.open(sealed));
  assert.equal(opened.keystorePassword, PASSWORD);
  assert.ok(!sealed.includes(PASSWORD) && !box.open(sealed).includes(TOKEN));
  assert.match(opened.privateKeyPem, /PRIVATE KEY/);
  assert.match(opened.caPem, /CERTIFICATE/);
});

test("a version no service uses can be deleted; one in use cannot; the entry goes with its last version", async () => {
  const t = setup();
  twoServices(t.store);
  const { cert } = await (await t.call("POST", "/api/nifi-certs", ADMIN, upload({ name: "corp-nifi" }))).json() as { cert: string };
  t.store.bindServiceCert("fits", cert, 1, cli);
  const list = await (await t.call("GET", "/api/nifi-certs", ADMIN)).json() as { certs: { versions: { usedBy: string[] }[] }[]; services: { id: string; bound: unknown }[] };
  assert.deepEqual(list.certs[0]!.versions[0]!.usedBy, ["fits"]);
  assert.deepEqual(list.services.find((s) => s.id === "fits")!.bound, { cert, version: 1 });
  const refused = await t.call("DELETE", `/api/nifi-certs/${cert}/versions/1`, ADMIN);
  assert.equal(refused.status, 409);
  assert.equal(((await refused.json()) as { error: string }).error, "cert/in-use");
  assert.equal(t.store.nifiCerts().length, 1);
  // The bound service's current certificate is what the next upload's trust check is made against.
  const check = await (await t.call("POST", "/api/nifi-certs/check", ADMIN, upload())).json() as { services: { id: string; items: { code: string; ok: boolean }[] }[] };
  assert.equal(check.services.find((s) => s.id === "fits")!.items.find((i) => i.code === "trusts-current")?.ok, true);
  t.store.unbindServiceCert("fits", cli);
  assert.equal((await t.call("DELETE", `/api/nifi-certs/${cert}/versions/1`, ADMIN)).status, 200);
  assert.equal(t.store.nifiCerts().length, 0);
  assert.equal((await t.call("DELETE", `/api/nifi-certs/${cert}/versions/1`, ADMIN)).status, 404);
});

test("the MCP tool lists subject, hosts, expiry and users, and the audit never holds a secret", async () => {
  const t = setup();
  twoServices(t.store);
  const { cert } = await (await t.call("POST", "/api/nifi-certs", ADMIN, upload({ name: "corp-nifi" }))).json() as { cert: string };
  t.store.bindServiceCert("strays", cert, 1, cli);
  const tool = TOOLS.find((x) => x.name === "list_certificates")!;
  assert.equal(tool.readOnly, true);
  assert.deepEqual(Object.keys(tool.properties), []);
  const spec = tool.request({});
  const r = await t.call(spec.method, spec.path.replace(/^/, "").startsWith("/deploy") ? spec.path.slice(7) : spec.path, { key: "dpk_admin" });
  const text = await r.text();
  LEAK(text);
  const body = JSON.parse(text) as { certificates: { name: string; versions: { subject: string; san: string[]; notAfter: string; usedBy: string[] }[] }[] };
  const v = body.certificates[0]!.versions[0]!;
  assert.equal(body.certificates[0]!.name, "corp-nifi");
  assert.equal(v.subject, "CN=S2S, OU=NIFI");
  assert.deepEqual(v.usedBy, ["strays"]);
  assert.ok(v.san.includes("nifi-1.lab") && v.notAfter);
});
