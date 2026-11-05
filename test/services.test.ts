import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { checkDraftItem, filterStartEnvironment, memberFromDiscovery, type DraftCluster, type DraftStandalone } from "../src/server/services/draft.ts";
import { catalogEntry, catalogFor, profile, profileFor } from "../src/server/services/profiles.ts";
import { Store, StoreError } from "../src/server/store.ts";

const admin = { id: "admin", via: "cli" } as const;

const member = (host: string, installDir: string, more: Record<string, unknown> = {}) =>
  ({ host, installDir, serviceUser: "nifi", startEnvironment: { JAVA_HOME: "/opt/jdk" }, ports: { https: 8443 }, ...more });
const standalone = (id: string, over: Partial<DraftStandalone> = {}): DraftStandalone =>
  ({ kind: "standalone", id, service: "nifi", profile: "nifi-1.x", version: "1.12.1", webUrl: "https://n112:8443/nifi", member: member("local", `/srv/${id}`), ...over });
const cluster = (id: string, over: Partial<DraftCluster> = {}): DraftCluster => ({
  kind: "cluster", id, service: "nifi", profile: "nifi-2.x", version: "2.5.0", webUrl: null, zookeeper: "zk:2181", zookeeperRoot: "/nifi",
  nodes: [member("n1", "/opt/nifi", { nodeAddress: "node1" }), member("n2", "/opt/nifi", { nodeAddress: "node2" })], ...over,
});

test("a version matches the profile of its line, tested or not", () => {
  assert.deepEqual([profileFor("nifi", "1.12.1")?.profile.id, profileFor("nifi", "1.12.1")?.tested], ["nifi-1.x", true]);
  assert.deepEqual([profileFor("nifi", "1.28.1")?.profile.id, profileFor("nifi", "1.28.1")?.tested], ["nifi-1.x", false]);
  for (const v of ["2.0.0", "2.5.0"]) assert.deepEqual([profileFor("nifi", v)?.profile.id, profileFor("nifi", v)?.tested], ["nifi-2.x", true]);
  assert.equal(profileFor("nifi", "2.0.0-M4")?.profile.id, "nifi-2.x"); // a 2.0 milestone is 2.x, not 1.x
  assert.equal(profileFor("nifi", "2.7.2")?.tested, false);
  for (const v of ["3.0.0", "0.7.4", "1.12", "nifi", ""]) assert.equal(profileFor("nifi", v), undefined, v);
  assert.equal(profileFor("zookeeper", "3.8.4"), undefined); // S22: no ZooKeeper profile
  assert.equal(profile("nifi-2.x")?.major, 2);
});

test("the catalog has the keys taking over needs, by version", () => {
  const one = profile("nifi-1.x")!, two = profile("nifi-2.x")!;
  for (const p of [one, two]) {
    assert.deepEqual(p.catalog.filter((e) => e.grouping).map((e) => e.key).sort(), ["nifi.cluster.is.node", "nifi.zookeeper.connect.string", "nifi.zookeeper.root.node"]);
    const key = catalogEntry(p, "nifi.sensitive.props.key")!;
    assert.equal(key.sensitive, true);
    assert.equal(key.scope, "cluster");
    assert.equal(catalogEntry(p, "nifi.web.https.port")?.scope, "node");
    assert.equal(catalogEntry(p, "java.arg.3", "bootstrap.conf")?.scope, "cluster");
    assert.equal(new Set(p.catalog.map((e) => `${e.file}:${e.key}`)).size, p.catalog.length, `${p.id} lists a key twice`);
  }
  assert.equal(catalogEntry(one, "nifi.flow.configuration.file")?.default, "./conf/flow.xml.gz");
  assert.equal(catalogEntry(two, "nifi.flow.configuration.file")?.default, "./conf/flow.json.gz");
  const keys = (p: typeof one, v: string) => catalogFor(p, v).map((e) => e.key);
  assert.ok(!keys(one, "1.12.1").includes("nifi.flow.configuration.json.file"));
  assert.ok(keys(one, "1.16.0").includes("nifi.flow.configuration.json.file"));
  assert.ok(!keys(one, "1.12.1").includes("nifi.python.command"));
  assert.ok(keys(two, "2.0.0").includes("nifi.python.command"));
  assert.ok(!keys(two, "2.5.0").includes("nifi.variable.registry.properties"));
});

test("the start environment keeps what starting NiFi needs and nothing secret", () => {
  const { kept, dropped } = filterStartEnvironment({
    PATH: "/usr/bin", HOME: "/home/nifi", JAVA_HOME: "/opt/jdk", LC_ALL: "C.UTF-8", NIFI_HOME: "/opt/nifi", TZ: "Asia/Shanghai",
    WSL_INTEROP: "/run/WSL/1_interop", DISPLAY: ":0", XDG_RUNTIME_DIR: "/run/user/1000", SSH_AUTH_SOCK: "/tmp/x", SHLVL: "1",
    NIFI_SENSITIVE_PROPS_KEY: "abc", NIFI_TOKEN: "(hidden)", JAVA_OPTS: "-Djavax.net.ssl.keyStorePassword=s3cret", NIFI_PID_DIR: "(hidden)",
  });
  assert.deepEqual(kept, { PATH: "/usr/bin", HOME: "/home/nifi", JAVA_HOME: "/opt/jdk", LC_ALL: "C.UTF-8", NIFI_HOME: "/opt/nifi", TZ: "Asia/Shanghai" });
  assert.deepEqual(dropped, ["DISPLAY", "JAVA_OPTS", "NIFI_PID_DIR", "NIFI_SENSITIVE_PROPS_KEY", "NIFI_TOKEN", "SHLVL", "SSH_AUTH_SOCK", "WSL_INTEROP", "XDG_RUNTIME_DIR"]);
  assert.deepEqual(filterStartEnvironment(null), { kept: null, dropped: [] });
});

test("a discovered instance becomes a draft member with its profile", () => {
  const node = memberFromDiscovery("svc-discover-1", "local", {
    service: "nifi", installDir: "/home/ferenc/nifi-lab/instances/c250-1", version: "2.5.0", serviceUser: "ferenc", owner: "ferenc",
    startEnvironment: { JAVA_HOME: "/jdk/21", WSL_INTEROP: "x" }, ports: { https: 18445, http: null, clusterProtocol: 11445, loadBalance: 16345 },
    webUrl: "https://localhost:18445/nifi", cluster: { isNode: true, nodeAddress: "localhost", zookeeper: "127.0.0.1:12181", zookeeperRoot: "/nifi-lab-c250" },
  });
  assert.equal(node.profile, "nifi-2.x");
  assert.equal(node.version, "2.5.0");
  assert.deepEqual(node.dropped, ["WSL_INTEROP"]);
  assert.deepEqual(node.member, {
    host: "local", installDir: "/home/ferenc/nifi-lab/instances/c250-1", serviceUser: "ferenc", startEnvironment: { JAVA_HOME: "/jdk/21" },
    ports: { https: 18445, clusterProtocol: 11445, loadBalance: 16345 }, nodeAddress: "localhost",
    discovery: { job: "svc-discover-1", host: "local", installDir: "/home/ferenc/nifi-lab/instances/c250-1" },
  });
  const stopped = memberFromDiscovery("svc-discover-1", "local", { service: "nifi", installDir: "/x/n200", version: "2.0.0", startEnvironment: null, ports: {}, cluster: { isNode: false } });
  assert.equal(stopped.member.startEnvironment, null);
  assert.equal("nodeAddress" in stopped.member, false);
  assert.deepEqual(checkDraftItem(standalone("n200", { profile: "nifi-2.x", version: stopped.version!, member: stopped.member })), []);
});

test("draft items are checked", () => {
  assert.deepEqual(checkDraftItem(standalone("n112")), []);
  assert.deepEqual(checkDraftItem(cluster("c250")), []);
  assert.match(checkDraftItem(standalone("n112", { profile: "nifi-2.x" })).join(), /1\.12\.1 is nifi-1\.x/);
  assert.match(checkDraftItem(standalone("n112", { version: "3.0.0" })).join(), /no profile/);
  assert.match(checkDraftItem(standalone("Bad Id")).join(), /^id:/);
  assert.match(checkDraftItem(standalone("n112", { member: member("local", "relative/dir") })).join(), /absolute path/);
  assert.match(checkDraftItem(standalone("n112", { member: member("local", "/x", { ports: { https: 70000 } }) })).join(), /ports/);
  assert.match(checkDraftItem(cluster("c250", { nodes: [] })).join(), /at least one/);
  assert.match(checkDraftItem(cluster("c250", { nodes: [member("n1", "/opt/nifi"), member("n1", "/opt/nifi/")] })).join(), /appears twice/);
  assert.match(checkDraftItem(standalone("dup", { member: member("n1", "/opt/nifi") }), [cluster("c250")]).join(), /n1:\/opt\/nifi is already in c250/);
  // The conf directory: <install>/conf when absent; one installation with another conf directory is another instance.
  assert.match(checkDraftItem(standalone("n112", { member: member("local", "/x", { confDir: "conf" }) })).join(), /confDir: an absolute path/);
  assert.deepEqual(checkDraftItem(standalone("dup", { member: member("n1", "/opt/nifi", { confDir: "/opt/nifi/conf/" }) }), [cluster("c250")]).length, 1, "the default spelled out is the same installation");
  assert.deepEqual(checkDraftItem(standalone("two", { member: member("n1", "/opt/nifi", { confDir: "/etc/nifi-two" }) }), [cluster("c250")]), []);
  assert.match(checkDraftItem(cluster("c250", { nodes: [member("n1", "/opt/nifi"), member("n1", "/opt/nifi", { confDir: "/etc/nifi-two" })] })).join(), /one installation on one host/);
});

test("a draft is created, edited item by item, and discarded", () => {
  const store = new Store(":memory:");
  const draft = store.createServiceDraft("UAT", [{ job: "svc-discover-1", host: "local" }], [standalone("n112"), cluster("c250")], admin);
  assert.equal(draft.state, "open");
  assert.deepEqual(draft.items.map((i) => i.id), ["n112", "c250"]);
  assert.equal(draft.items[0]!.updatedBy, "admin");

  // add
  assert.equal(store.putServiceDraftItem(draft.id, standalone("n200", { profile: "nifi-2.x", version: "2.0.0" }), admin), "added");
  // change: what was read back goes back in, with its row fields dropped
  const read = store.serviceDraft(draft.id)!.items.find((i) => i.id === "c250")! as DraftCluster & { updatedAt: string };
  assert.equal(store.putServiceDraftItem(draft.id, { ...read, zookeeper: "zk1:2181,zk2:2181" }, admin), "changed");
  const c = store.serviceDraft(draft.id)!.items.find((i) => i.id === "c250") as DraftCluster;
  assert.equal(c.zookeeper, "zk1:2181,zk2:2181");
  assert.equal(store.serviceDraft(draft.id)!.items.length, 3);
  // an installation already in another item, or a wrong profile, is refused and changes nothing
  assert.throws(() => store.putServiceDraftItem(draft.id, standalone("again", { member: member("n2", "/opt/nifi") }), admin), (e: StoreError) => e.code === "draft/item-invalid" && /already in c250/.test(e.details.join()));
  assert.throws(() => store.putServiceDraftItem(draft.id, standalone("n112", { version: "2.5.0" }), admin), (e: StoreError) => e.code === "draft/item-invalid");
  assert.equal((store.serviceDraft(draft.id)!.items.find((i) => i.id === "n112") as DraftStandalone).version, "1.12.1");
  // remove
  store.removeServiceDraftItem(draft.id, "n200", admin);
  assert.deepEqual(store.serviceDraft(draft.id)!.items.map((i) => i.id), ["n112", "c250"]);
  assert.throws(() => store.removeServiceDraftItem(draft.id, "n200", admin), (e: StoreError) => e.code === "draft/item-unknown");
  assert.throws(() => store.putServiceDraftItem("draft-none", standalone("x"), admin), (e: StoreError) => e.code === "draft/unknown");

  assert.deepEqual(store.serviceDrafts("open").map((d) => d.id), [draft.id]);
  store.discardServiceDraft(draft.id, admin);
  assert.equal(store.serviceDraft(draft.id)!.state, "discarded");
  assert.deepEqual(store.serviceDrafts("open"), []);
  assert.throws(() => store.putServiceDraftItem(draft.id, standalone("late"), admin), (e: StoreError) => e.code === "draft/closed");
  assert.throws(() => store.removeServiceDraftItem(draft.id, "n112", admin), (e: StoreError) => e.code === "draft/closed");

  assert.deepEqual(store.listAudit(20, { action: "service.draft" }).map((a) => a.action).reverse(),
    ["service.draft-created", "service.draft-item-added", "service.draft-item-changed", "service.draft-item-removed", "service.draft-discarded"]);
  assert.throws(() => store.createServiceDraft("UAT", [], [standalone("a", { member: member("h", "/x") }), standalone("b", { member: member("h", "/x/") })], admin), (e: StoreError) => e.code === "draft/item-invalid");
  assert.throws(() => store.createServiceDraft("UAT", [], [standalone("a"), standalone("a")], admin), (e: StoreError) => e.code === "draft/item-invalid");
  store.close();
});

test("standalone instances and clusters are registered once per installation", () => {
  const store = new Store(":memory:");
  store.addStandalone(standalone("n112"), "UAT", admin, "draft-1");
  store.addCluster(cluster("c250"), "UAT", admin);
  assert.deepEqual(store.standalones().map((s) => [s.id, s.member.installDir, s.environment, s.draft]), [["n112", "/srv/n112", "UAT", "draft-1"]]);
  const [c] = store.clusters();
  assert.deepEqual(c!.nodes.map((n) => [n.host, n.nodeAddress]), [["n1", "node1"], ["n2", "node2"]]);
  assert.equal(c!.zookeeper, "zk:2181");
  assert.equal(store.serviceUsing("n2", "/opt/nifi/"), "c250");
  assert.equal(store.serviceUsing("local", "/srv/n112"), "n112");
  assert.equal(store.serviceUsing("local", "/srv/other"), undefined);
  assert.throws(() => store.addStandalone(standalone("other", { member: member("n1", "/opt/nifi") }), "UAT", admin), (e: StoreError) => e.code === "service/install-used");
  assert.throws(() => store.addStandalone(standalone("c250", { member: member("h", "/y") }), "UAT", admin), (e: StoreError) => e.code === "service/exists");
  assert.equal(store.standalones().length, 1);
  store.close();
});

test("an older state database gets the service tables, and opening again changes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "deployer-services-"));
  try {
    const file = join(dir, "state.db");
    const old = new DatabaseSync(file);
    old.exec("CREATE TABLE apps (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo TEXT NOT NULL, added_at TEXT NOT NULL, added_by TEXT NOT NULL, removed_at TEXT, removed_by TEXT)");
    old.close();
    let store = new Store(file);
    store.addStandalone(standalone("n112"), "UAT", admin);
    store.close();
    store = new Store(file);
    assert.deepEqual(store.standalones().map((s) => s.id), ["n112"]);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a state database from before conf directories gets the column, its installations counting as <install>/conf", () => {
  const dir = mkdtempSync(join(tmpdir(), "deployer-services-"));
  try {
    const file = join(dir, "state.db");
    let store = new Store(file);
    store.addStandalone(standalone("n112"), "UAT", admin);
    store.close();
    // As the first phase left it: no conf_dir columns, the row without one.
    const old = new DatabaseSync(file);
    for (const t of ["service_standalones", "service_nodes"]) old.exec(`ALTER TABLE ${t} DROP COLUMN conf_dir`);
    old.close();
    store = new Store(file);
    assert.deepEqual(store.standalones().map((s) => [s.id, s.member.confDir]), [["n112", "/srv/n112/conf"]]);
    assert.equal(store.serviceUsing("local", "/srv/n112", "/srv/n112/conf"), "n112");
    store.addCluster(cluster("c250", { nodes: [member("n1", "/opt/nifi", { nodeAddress: "node1", confDir: "/etc/nifi" })] }), "UAT", admin);
    assert.deepEqual([store.clusters()[0]!.nodes[0]!.confDir, store.serviceUsing("n1", "/opt/nifi"), store.serviceUsing("n1", "/opt/nifi", "/etc/nifi")], ["/etc/nifi", undefined, "c250"]);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
