// S40: a service executor gets the NiFi certificate of a service on its own host from the certificate library: the
// heartbeat's watch entries name the version (never a key), GET /executor/v1/nifi-certs/<service> gives the PEM only
// with that host's service executor token, and a running change that puts another library version on the nodes adds
// its CA to the bundle. The takeover binds the certificate chosen for each item.

import assert from "node:assert/strict";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/server/app.ts";
import { WorkbenchSessions } from "../src/server/auth.ts";
import { certRef, executorCert, joinPem, UNBOUND_MESSAGE } from "../src/server/certs/issue.ts";
import { readUpload, sealVersion } from "../src/server/certs/library.ts";
import type { Config } from "../src/server/config.ts";
import { Deployments } from "../src/server/deploy.ts";
import { WorkbenchAdmin } from "../src/server/drivers/workbench.ts";
import { EnvManager, Schemas } from "../src/server/env.ts";
import { Handoff, hostIds, tokenSha256 } from "../src/server/handoff.ts";
import type { Keys } from "../src/server/keys.ts";
import { Observer } from "../src/server/observe.ts";
import { SecretBox } from "../src/server/secretbox.ts";
import { sealFile } from "../src/server/services/config.ts";
import type { DraftCluster, DraftStandalone } from "../src/server/services/draft.ts";
import { Takeover } from "../src/server/services/takeover.ts";
import { Store } from "../src/server/store.ts";
import { Versions } from "../src/server/versions.ts";

const box = new SecretBox(Buffer.alloc(32, 7).toString("base64"));
const cli = { id: "admin", via: "cli" } as const;
const toolkit = (name: string) => readFileSync(new URL(`../testdata/certs/toolkit-client/${name}`, import.meta.url));
const files = () => ["config.json", "keystore.jks", "truststore.jks"].map((name) => ({ name, bytes: toolkit(name) }));

function setup() {
  const store = new Store(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "executor-certs-"));
  const environmentFile = join(dir, "environment.json");
  writeFileSync(environmentFile, JSON.stringify({ name: "uat", project: "open-atlas", bindIp: "127.0.0.1", registries: {}, apps: {} }));
  const fetcher = (async () => Response.json({ status: "ok" })) as unknown as typeof fetch;
  const config = { bind: "127.0.0.1", port: 0, basePath: "/deploy", dataDir: dir, workbenchUrl: "http://workbench:8090", workbenchPublicUrl: "/", environmentFile, observeUrls: {}, secureCookies: false, webDir: join(dir, "web"), templatesDir: join(dir, "templates"), initialManifestsDir: join(dir, "manifests"), peerKeySha256: [], githubApi: "https://api.github.com", omaVaults: [], omaAssessorVaults: [], briefHour: 8, deployerReleaseTag: "v{version}" } as unknown as Config;
  const handoff = new Handoff(store);
  const observer = new Observer({}, fetcher);
  const deployments = new Deployments(store, handoff, observer, environmentFile, {});
  const takeover = new Takeover({ store, handoff, box, environment: () => "uat", hosts: () => hostIds(deployments.environment().env) });
  const env = new EnvManager(store, deployments, new Schemas(undefined, join(dir, "templates"), fetcher), box, "compare");
  const app = createApp({ config, store, takeover, keys: { resolve: async () => undefined } as unknown as Keys, sessions: new WorkbenchSessions(config.workbenchUrl, fetcher), observer, deployments, versions: new Versions(undefined, fetcher), env, workbench: new WorkbenchAdmin(config.workbenchUrl, () => "", fetcher) });
  const token = (host: string, executor: "service" | "deploy") => {
    const t = `dpe_${host}_${executor}`;
    store.addExecutorToken(host, tokenSha256(t), t.slice(0, 8), cli, executor);
    return t;
  };
  const call = (method: string, path: string, bearer: string, body?: unknown) =>
    app.request(`/deploy${path}`, { method, headers: { authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { store, takeover, token, call };
}

const member = (host: string, dir: string, nodeAddress: string | null = null) => ({ host, installDir: dir, serviceUser: "nifi", startEnvironment: null, ports: { https: 8443 }, nodeAddress, discovery: null });
const fileOf = (name: string, path: string, bytes: Buffer) => sealFile({ name, path, modifiedAt: "2026-11-01T00:00:00Z" }, bytes, box);
/** "flow", a cluster on nifi-1 and nifi-2, and "solo", a standalone on batch. */
function services(store: Store) {
  const body = (host: string, dir: string) => ({ host, installDir: dir, missing: [], files: [fileOf("nifi.properties", `${dir}/conf/nifi.properties`, Buffer.from("a=b\n"))] });
  const flow: DraftCluster = { kind: "cluster", id: "flow", service: "nifi", profile: "nifi-2.x", version: "2.5.0", webUrl: null, zookeeper: "zk:2181", zookeeperRoot: "/f", nodes: [member("nifi-1", "/opt/a", "nifi-1.lab"), member("nifi-2", "/opt/b", "nifi-2.lab")] } as DraftCluster;
  const solo: DraftStandalone = { kind: "standalone", id: "solo", service: "nifi", profile: "nifi-2.x", version: "2.0.0", webUrl: null, member: member("batch", "/opt/c") } as DraftStandalone;
  const draft = store.createServiceDraft("uat", [], [flow, solo], cli);
  store.confirmServiceDraft(draft.id, { flow: { members: [body("nifi-1", "/opt/a"), body("nifi-2", "/opt/b")] }, solo: { members: [body("batch", "/opt/c")] } }, cli);
}
function library(store: Store) {
  const v = sealVersion(readUpload(files()), box);
  const { cert, version } = store.addNifiCert("corp-nifi", null, v, cli);
  return { cert, version, sha256: v.sha256 };
}

test("the watch names the bound version only; the PEM goes to the service executor of a host the service is on", async () => {
  const { store, token, call } = setup();
  services(store);
  const lib = library(store);
  const node1 = token("nifi-1", "service"), batch = token("batch", "service"), deploy = token("nifi-1", "deploy");
  const beat = async (bearer: string) => (await (await call("POST", "/executor/v1/heartbeat", bearer, { executor: "service", version: "0.9.10", protocols: [2], kinds: [], busy: null })).json()).watch;

  // Unbound: the watch says null, the certificate answer says what to do.
  assert.deepEqual((await beat(node1)).map((w: { cert: unknown }) => w.cert), [null]);
  let r = await call("GET", "/executor/v1/nifi-certs/flow", node1);
  assert.deepEqual([r.status, (await r.json()).error], [409, "cert/unbound"]);
  assert.equal(executorCert(store, box, "nifi-1", "flow").ok, false);
  assert.match(UNBOUND_MESSAGE, /cannot connect to this NiFi/);

  store.bindServiceCert("flow", lib.cert, lib.version, cli);
  const watch = await beat(node1);
  assert.deepEqual(watch[0].cert, { cert: lib.cert, version: lib.version, sha256: lib.sha256, pending: null });
  assert.doesNotMatch(JSON.stringify(watch), /PRIVATE KEY|BEGIN CERTIFICATE/, "a reference, never a key");

  r = await call("GET", "/executor/v1/nifi-certs/flow", node1);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const got = await r.json();
  assert.deepEqual([got.service, got.cert, got.version, got.pending], ["flow", lib.cert, lib.version, null]);
  assert.match(got.privateKeyPem, /-----BEGIN PRIVATE KEY-----/);
  const leaf = new X509Certificate(got.certificatePem);
  assert.equal(leaf.fingerprint256, lib.sha256, "the leaf first");
  assert.equal(got.subject, store.nifiCert(lib.cert)!.versions[0]!.subject);
  assert.ok(leaf.checkPrivateKey(createPrivateKey(got.privateKeyPem)), "the key of that certificate");
  assert.ok(leaf.verify(new X509Certificate(got.caPem).publicKey), "the CA that signed it");

  // Not another host's service, not an unknown one (the same answer), not with a deploy token, not without one.
  for (const [bearer, path, status] of [[batch, "flow", 404], [node1, "solo", 404], [node1, "nope", 404], [deploy, "flow", 409], ["dpe_unknown", "flow", 401]] as const) {
    r = await call("GET", `/executor/v1/nifi-certs/${path}`, bearer);
    assert.equal(r.status, status, `${bearer} ${path}`);
    assert.doesNotMatch(await r.text(), /PRIVATE KEY/);
  }
  assert.equal((await call("GET", "/executor/v1/nifi-certs/flow", token("nifi-2", "service"))).status, 200, "every node's executor of the cluster");
  store.close();
});

test("while a change puts another library version on the nodes, its CA joins the bundle; the client certificate stays", () => {
  const { store } = setup();
  services(store);
  const old = library(store);
  store.bindServiceCert("flow", old.cert, old.version, cli);
  // The second version: the same files with a different CA in its bundle stands in for a renewal by another CA.
  const otherCa = readFileSync(new URL("../testdata/certs/openssl/ca.pem", import.meta.url), "utf8");
  const next = sealVersion(readUpload(files()), box);
  const sealed = JSON.parse(box.open(next.sealed)) as Record<string, string>;
  const renewed = { ...next, sha256: "f".repeat(64), sealed: box.seal(JSON.stringify({ ...sealed, keystore: Buffer.from("next keystore").toString("base64"), caPem: otherCa })) };
  const v2 = store.addNifiCertVersion(old.cert, renewed, cli);

  assert.equal(certRef(store, box, "flow")!.pending, null, "no change running");
  // A change running towards a revision whose nodes hold v2's key store.
  const cfg = store.serviceConfig("flow")!;
  const members = cfg.body.members.map((m) => ({ ...m, files: [...m.files, fileOf("keystore", `${m.installDir}/conf/keystore.jks`, Buffer.from("next keystore"))] }));
  const revision = store.saveServiceConfigRollback("flow", { from: cfg.revision, base: cfg.revision, body: { members }, findings: [], note: null }, cli);
  store.createServiceChange({ id: "chg_test", service: "flow", kind: "config", revision, mode: "rolling", phase: "plan", plan: {}, options: {}, reason: null, progress: {}, text: "test" }, cli);
  assert.deepEqual(certRef(store, box, "flow")!.pending, { cert: old.cert, version: v2 });
  const got = executorCert(store, box, "nifi-1", "flow");
  assert.ok(got.ok);
  assert.equal(got.cert.version, old.version, "the client certificate is still the bound one");
  assert.equal(got.cert.caPem.match(/BEGIN CERTIFICATE/g)!.length, 2, "both CAs");
  assert.ok(got.cert.caPem.includes(otherCa.trim()));
  assert.equal(joinPem([otherCa, otherCa, ""]).match(/BEGIN CERTIFICATE/g)!.length, 1, "each CA once");
  store.close();
});

test("the takeover binds the certificate chosen for each item, and refuses one not in the library", async () => {
  const { store, takeover } = setup();
  const lib = library(store);
  const solo: DraftStandalone = { kind: "standalone", id: "solo", service: "nifi", profile: "nifi-2.x", version: "2.0.0", webUrl: null, member: member("batch", "/opt/c") } as DraftStandalone;
  const draft = store.createServiceDraft("uat", [], [solo], cli);
  await assert.rejects(takeover.confirm(draft.id, cli, { solo: { cert: lib.cert, version: 9 } }), (e: Error & { code?: string }) => e.code === "cert/unknown");
  await assert.rejects(takeover.confirm(draft.id, cli, { other: { cert: lib.cert, version: lib.version } }), (e: Error & { code?: string }) => e.code === "confirm/certs");
  await assert.rejects(takeover.confirm(draft.id, cli, "solo"), (e: Error & { code?: string }) => e.code === "confirm/certs");
  store.close();
});
