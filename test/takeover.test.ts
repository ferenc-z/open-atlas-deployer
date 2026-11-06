// Service ops §6 steps 3 and 5 (step 5 of §15.1): grouping and assessing discoveries by rules (P1), the takeover draft's
// confirmation that imports each installation's configuration as revision 1, and the optional AI review.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { Handoff } from "../src/server/handoff.ts";
import type { OmaSessions } from "../src/server/oma.ts";
import { SecretBox } from "../src/server/secretbox.ts";
import { assessItems, groupDiscoveries, portConflicts, reviewPrompt, zookeeperServers, type Discovered, type Finding } from "../src/server/services/assess.ts";
import { importFile, redactProperties, redactXml, withoutSealed } from "../src/server/services/config.ts";
import type { DraftCluster, DraftItem, DraftStandalone } from "../src/server/services/draft.ts";
import { catalogEntry, catalogFor, profile } from "../src/server/services/profiles.ts";
import { FINGERPRINT_KEY, Takeover, TakeoverError } from "../src/server/services/takeover.ts";
import { Store, StoreError } from "../src/server/store.ts";

const admin = { id: "admin", via: "cli" } as const;
const LAB = "/home/ferenc/nifi-lab/instances";

/** A discovered NiFi as svc-discover reports one of the lab's (§15.1 step 0). */
function nifi(name: string, version: string, over: { props?: Record<string, string>; boot?: Record<string, string>; fp?: Record<string, string>; ports?: Record<string, number | null>; running?: boolean; autostart?: string[]; device?: number } = {}): Record<string, any> {
  const node = over.props?.["nifi.cluster.is.node"] === "true";
  const props: Record<string, string> = { "nifi.sensitive.props.key": "(hidden)", "nifi.zookeeper.root.node": "/nifi", ...over.props };
  const dir = `${LAB}/${name}`;
  const dev = over.device ?? 2080;
  return {
    service: "nifi", installDir: dir, source: "process", running: over.running ?? true, version, owner: "ferenc", serviceUser: "ferenc",
    startEnvironment: { JAVA_HOME: "/jdk", PATH: "/usr/bin" }, ports: { https: 18443, ...over.ports },
    webUrl: `https://localhost:${over.ports?.https ?? 18443}/nifi`,
    cluster: { isNode: node, nodeAddress: props["nifi.cluster.node.address"] ?? null, zookeeper: props["nifi.zookeeper.connect.string"] ?? null, zookeeperRoot: props["nifi.zookeeper.root.node"] },
    properties: props, bootstrap: { "java.arg.2": "-Xms1g", "java.arg.3": "-Xmx1g", ...over.boot },
    fingerprints: { "nifi.properties": { "nifi.sensitive.props.key": "fp-same", ...over.fp }, "bootstrap.conf": {} },
    storage: { content: { path: `${dir}/content_repository`, device: dev }, flowfile: { path: `${dir}/flowfile_repository`, device: dev }, provenance: { path: `${dir}/provenance_repository`, device: dev }, database: { path: `${dir}/database_repository`, device: dev }, logs: { path: `${dir}/logs`, device: dev } },
    autostart: over.autostart ?? [], files: [{ name: "nifi.properties", path: `${dir}/conf/nifi.properties`, sha256: "a".repeat(64), size: 10, modifiedAt: "2026-11-04T00:00:00Z" }], problems: [],
  };
}
const clusterProps = (n: number, more: Record<string, string> = {}) => ({
  "nifi.cluster.is.node": "true", "nifi.cluster.node.address": `node${n}.lab`, "nifi.zookeeper.connect.string": "127.0.0.1:12181", "nifi.zookeeper.root.node": "/nifi-lab-c250", ...more,
});
/** The lab: 1.12.1 and 2.0.0 standalone, 2.5.0 two nodes. */
function lab(change: { node2?: Parameters<typeof nifi>[2] } = {}): Discovered[] {
  return [
    { job: "svc-discover-1", host: "local", instance: nifi("n112", "1.12.1", { props: { "nifi.cluster.is.node": "false" }, boot: { "java.arg.2": "-Xms1024m", "java.arg.3": "-Xmx1024m" } }) },
    { job: "svc-discover-1", host: "local", instance: nifi("n200", "2.0.0", { ports: { https: 18444, management: 52444 } }) },
    { job: "svc-discover-1", host: "local", instance: nifi("c250-1", "2.5.0", { props: clusterProps(1), ports: { https: 18445, clusterProtocol: 11445, loadBalance: 16345, management: 52445 } }) },
    { job: "svc-discover-1", host: "local", instance: nifi("c250-2", "2.5.0", { props: clusterProps(2, change.node2?.props), boot: change.node2?.boot, fp: change.node2?.fp, ports: { https: 18446, clusterProtocol: 11446, loadBalance: 16346, management: 52446, ...change.node2?.ports } }) },
  ];
}
const findingsOf = (items: DraftItem[], id: string) => (items.find((i) => i.id === id)!.findings ?? []) as Finding[];

test("the catalog's defaults are what NiFi ships (checked against the 1.12.1, 2.0.0 and 2.5.0 archives)", () => {
  const one = profile("nifi-1.x")!, two = profile("nifi-2.x")!;
  const d = (p: typeof one, key: string, file?: "bootstrap.conf") => catalogEntry(p, key, file)?.default;
  assert.equal(d(one, "nifi.cluster.protocol.is.secure"), "false");
  assert.equal(d(two, "nifi.cluster.protocol.is.secure"), "false", "2.x ships it too");
  assert.equal(d(two, "nifi.cluster.load.balance.comms.timeout"), "30 sec");
  assert.deepEqual([d(one, "nifi.web.http.port"), d(two, "nifi.web.http.port")], ["8080", ""]);
  assert.deepEqual([d(one, "nifi.web.https.port"), d(two, "nifi.web.https.port"), d(two, "nifi.web.https.host")], ["", "8443", "localhost"]);
  assert.deepEqual([d(one, "nifi.remote.input.secure"), d(two, "nifi.remote.input.secure")], ["false", "true"]);
  assert.equal(d(one, "nifi.sensitive.props.algorithm"), "PBEWITHMD5AND256BITAES-CBC-OPENSSL");
  assert.equal(d(two, "nifi.sensitive.props.algorithm"), "NIFI_PBKDF2_AES_GCM_256");
  assert.deepEqual([d(one, "java.arg.3", "bootstrap.conf"), d(two, "java.arg.3", "bootstrap.conf")], ["-Xmx512m", "-Xmx1g"]);
  assert.equal(d(two, "nifi.python.command"), null, "shipped commented out");
  assert.equal(d(two, "nifi.python.extensions.source.directory.default"), "./python/extensions");
  assert.equal(catalogEntry(one, "java", "bootstrap.conf")?.default, "java");
  assert.equal(catalogEntry(two, "java", "bootstrap.conf"), undefined, "2.x bootstrap.conf has no java=");
  assert.equal(new Set(two.catalog.map((e) => `${e.file}:${e.key}`)).size, two.catalog.length);
});

test("discoveries are grouped by rules: the 2.5.0 nodes are one cluster, the others standalone", () => {
  const { items, skipped } = groupDiscoveries(lab());
  assert.deepEqual(skipped, []);
  assert.deepEqual(items.map((i) => [i.kind, i.id, i.version]), [["cluster", "nifi-lab-c250", "2.5.0"], ["standalone", "n112", "1.12.1"], ["standalone", "n200", "2.0.0"]]);
  const c = items[0] as DraftCluster;
  assert.deepEqual(c.nodes.map((n) => [n.installDir.split("/").pop(), n.nodeAddress]), [["c250-1", "node1.lab"], ["c250-2", "node2.lab"]]);
  assert.deepEqual([c.zookeeper, c.zookeeperRoot, c.profile, c.webUrl], ["127.0.0.1:12181", "/nifi-lab-c250", "nifi-2.x", "https://localhost:18445/nifi"]);
  assert.equal((items[1] as DraftStandalone).member.discovery?.job, "svc-discover-1");

  // Another root node is another cluster; ZooKeeper servers in common join nodes written differently.
  assert.deepEqual(zookeeperServers("zk2:2181, ZK1:2181/chroot"), ["zk1:2181", "zk2:2181"]);
  const split = groupDiscoveries(lab({ node2: { props: { "nifi.zookeeper.root.node": "/other" } } })).items;
  assert.deepEqual(split.filter((i) => i.kind === "cluster").map((i) => [i.id, (i as DraftCluster).nodes.length]), [["nifi-lab-c250", 1], ["other", 1]]);
  const joined = groupDiscoveries(lab({ node2: { props: { "nifi.zookeeper.connect.string": "127.0.0.1:12181,zk9:2181" } } })).items;
  assert.equal((joined[0] as DraftCluster).nodes.length, 2);

  // Already registered, or a version without a profile: left out, with the reason; ids in use are not reused.
  const found = [...lab(), { job: "svc-discover-1", host: "local", instance: nifi("n300", "3.0.0") }];
  const again = groupDiscoveries(found, { registered: (_h, dir) => (dir.endsWith("/n112") ? "n112" : undefined), takenIds: ["n200"] });
  assert.deepEqual(again.skipped.map((s) => [s.installDir.split("/").pop(), s.reason]), [["n112", "already registered as n112"], ["n300", "no profile for NiFi 3.0.0"]]);
  assert.deepEqual(again.items.map((i) => i.id), ["nifi-lab-c250", "local-n200"]);
});

test("the assessment finds a difference between nodes by the catalog, and never shows a secret", () => {
  const clean = assessItems(groupDiscoveries(lab()).items, lab());
  const codes = (items: DraftItem[], id: string) => findingsOf(items, id).map((f) => f.code);
  assert.deepEqual(codes(clean, "nifi-lab-c250").filter((c) => c.startsWith("cluster/")), [], "the lab's nodes agree");
  assert.ok(codes(clean, "n112").includes("version/unmaintained"));
  assert.ok(!codes(clean, "n200").includes("version/unmaintained"));

  // A heap changed on one node: a warning naming the key and each node's value.
  const heap = lab({ node2: { boot: { "java.arg.3": "-Xmx2g" } } });
  const f = findingsOf(assessItems(groupDiscoveries(heap).items, heap), "nifi-lab-c250").find((x) => x.code === "cluster/differs")!;
  assert.deepEqual([f.severity, f.key, f.file], ["warning", "java.arg.3", "bootstrap.conf"]);
  assert.deepEqual(f.values!.map((v) => v.value), ["-Xmx1g", "-Xmx2g"]);

  // A key the file leaves out counts as its default: absent on one node, "false" on the other, is no difference.
  const absent = lab({ node2: { props: { "nifi.cluster.protocol.is.secure": "false" } } });
  assert.ok(!findingsOf(assessItems(groupDiscoveries(absent).items, absent), "nifi-lab-c250").some((x) => x.code === "cluster/differs"));

  // Different sensitive keys: an error, the nodes told apart by labels; neither the value nor the fingerprint appears.
  const keys = lab({ node2: { fp: { "nifi.sensitive.props.key": "fp-other" } } });
  const k = findingsOf(assessItems(groupDiscoveries(keys).items, keys), "nifi-lab-c250").find((x) => x.key === "nifi.sensitive.props.key")!;
  assert.equal(k.severity, "error");
  assert.deepEqual(k.values!.map((v) => v.value), ["value A", "value B"]);
  assert.ok(!JSON.stringify(k).includes("fp-"));

  // Without fingerprints (an older executor) the secret is not compared, and the assessment says so.
  const old = lab();
  for (const d of old) delete d.instance.fingerprints;
  const n = findingsOf(assessItems(groupDiscoveries(old).items, old), "nifi-lab-c250");
  assert.match(n.find((x) => x.code === "cluster/not-compared")!.message, /nifi\.sensitive\.props\.key/);

  // A different ZooKeeper connect string that still shares a server: grouped, and an error.
  const zk = lab({ node2: { props: { "nifi.zookeeper.connect.string": "127.0.0.1:12181,zk9:2181" } } });
  assert.equal(findingsOf(assessItems(groupDiscoveries(zk).items, zk), "nifi-lab-c250").find((x) => x.key === "nifi.zookeeper.connect.string")?.severity, "error");
});

test("ports are checked per machine, in the draft and against what is registered", () => {
  // 2.x without management.server.address listens on 52020: two such on one host conflict.
  const found = lab();
  delete found[1]!.instance.ports.management;
  delete found[3]!.instance.ports.management;
  const items = assessItems(groupDiscoveries(found).items, found);
  const conflict = findingsOf(items, "n200").find((f) => f.code === "ports/conflict")!;
  assert.match(conflict.message, /Port 52020 on local/);
  assert.ok(findingsOf(items, "nifi-lab-c250").some((f) => f.code === "ports/conflict"));
  assert.ok(!findingsOf(items, "n112").some((f) => f.code === "ports/conflict"), "1.x picks a random management port");
  // Another host is another machine.
  const n200 = items.find((i) => i.id === "n200") as DraftStandalone;
  assert.equal(portConflicts([{ ...n200, member: { ...n200.member, host: "other" } }, items[0]!]).size, 0);
  // Against a registered installation (not the same one again).
  const registered = [{ service: "nifi", profile: "nifi-1.x", member: { host: "local", installDir: "/srv/old", ports: { https: 18443 } } }];
  assert.match(portConflicts(items, registered).get("n112")![0]!.message, /Port 18443/);
  assert.equal(portConflicts(items, [{ ...registered[0]!, member: { ...registered[0]!.member, installDir: `${LAB}/n112` } }]).get("n112"), undefined);
});

test("S26: a host that would have more than one NiFi registered gets a warning, not an error", () => {
  const items = assessItems(groupDiscoveries(lab()).items, lab());
  const f = findingsOf(items, "n112").find((x) => x.code === "host/multiple-nifi")!;
  assert.equal(f.severity, "warning");
  assert.match(f.message, /local would have 4 NiFi installations registered/);
  assert.equal(f.values!.length, 4);
  assert.ok(findingsOf(items, "nifi-lab-c250").some((x) => x.code === "host/multiple-nifi"), "the cluster's two nodes share the host too");

  // One per machine: nothing; one more already registered there: the warning again.
  const one = lab().slice(0, 1);
  assert.ok(!findingsOf(assessItems(groupDiscoveries(one).items, one), "n112").some((x) => x.code === "host/multiple-nifi"));
  const registered = [{ service: "nifi", profile: "nifi-2.x", member: { host: "local", installDir: "/srv/other", ports: { https: 9443 } } }];
  assert.match(findingsOf(assessItems(groupDiscoveries(one).items, one, registered), "n112").find((x) => x.code === "host/multiple-nifi")!.message, /would have 2/);
  assert.ok(!findingsOf(assessItems(groupDiscoveries(one).items, one, [{ ...registered[0]!, member: { ...registered[0]!.member, host: "other" } }]), "n112").some((x) => x.code === "host/multiple-nifi"));
});

test("the risks the design lists are found by rules", () => {
  const found = lab();
  found[0]!.instance.properties["nifi.sensitive.props.key"] = "";
  found[1]!.instance.autostart = ["/etc/systemd/system/nifi.service"];
  found[1]!.instance.storage.logs.device = 99;
  found[1]!.instance.running = false;
  const items = assessItems(groupDiscoveries(found).items, found);
  const n112 = findingsOf(items, "n112").map((f) => f.code);
  assert.ok(n112.includes("sensitive-key/empty") && n112.includes("storage/shared-disk") && n112.includes("autostart/none"));
  assert.equal(findingsOf(items, "n112")[0]!.severity, "error", "errors first: 1.x with an empty key uses the built-in one");
  const n200 = findingsOf(items, "n200").map((f) => f.code);
  assert.ok(!n200.includes("storage/shared-disk") && !n200.includes("autostart/none") && n200.includes("not-running"));
  const prompt = reviewPrompt("draft-1", "UAT", items);
  assert.match(prompt, /do not regroup/);
  assert.ok(prompt.includes("sensitive-key/empty") && !prompt.includes("fp-same"), "the findings go in, never a fingerprint");
});

test("configuration files are kept sealed whole, with a redacted copy", () => {
  const props = "# c\nnifi.sensitive.props.key=s3cret\nnifi.security.keystorePasswd = kspw\nnifi.security.truststorePasswd=\nnifi.web.https.port=8443\r\n";
  const r = redactProperties(props);
  assert.equal(r.text, "# c\nnifi.sensitive.props.key=(hidden)\nnifi.security.keystorePasswd = (hidden)\nnifi.security.truststorePasswd=\nnifi.web.https.port=8443\r\n");
  assert.deepEqual(r.secrets, ["nifi.sensitive.props.key", "nifi.security.keystorePasswd"]);
  const xml = '<property name="Manager Password">pw</property><property name="Url">ldap://x</property><user password="p1"/>';
  assert.equal(redactXml(xml).text, '<property name="Manager Password">(hidden)</property><property name="Url">ldap://x</property><user password="(hidden)"/>');
  const box = new SecretBox(randomBytes(32).toString("base64"));
  const raw = Buffer.from(props);
  const f = importFile({ name: "nifi.properties", path: "/x/conf/nifi.properties", sha256: createHash("sha256").update(raw).digest("hex"), size: raw.length, modifiedAt: "t", content: raw.toString("base64") }, box);
  assert.equal(box.open(f.sealed), props);
  assert.ok(!f.redacted.includes("s3cret") && !JSON.stringify(withoutSealed({ members: [{ host: "h", installDir: "/x", files: [f], missing: [] }] })).includes("v1:"));
  assert.throws(() => importFile({ name: "nifi.properties", path: "/x", sha256: "0".repeat(64), size: 1, modifiedAt: "t", content: raw.toString("base64") }, box), /sha256/);
});

test("confirming registers every item and its revision 1 in one transaction (transactions do not nest)", () => {
  const store = new Store(":memory:");
  const items = assessItems(groupDiscoveries(lab()).items, lab());
  const draft = store.createServiceDraft("UAT", [{ job: "svc-discover-1", host: "local" }], items, admin);
  const body = (dir: string) => ({ members: [{ host: "local", installDir: dir, files: [], missing: [] }] });
  const configs = Object.fromEntries(items.map((i) => [i.id, body(i.kind === "cluster" ? i.nodes[0]!.installDir : i.member.installDir)]));
  // One item's installation registered meanwhile: nothing is registered, the draft stays open.
  store.addStandalone({ ...(items[1] as DraftStandalone), id: "taken" }, "UAT", admin);
  assert.throws(() => store.confirmServiceDraft(draft.id, configs, admin), (e: StoreError) => e.code === "service/install-used");
  assert.deepEqual([store.clusters().length, store.serviceConfig("nifi-lab-c250"), store.serviceDraft(draft.id)!.state], [0, undefined, "open"]);
  const fresh = new Store(":memory:");
  const d2 = fresh.createServiceDraft("UAT", [], items, admin);
  assert.throws(() => fresh.confirmServiceDraft(d2.id, configs, admin, "an older updatedAt"), (e: StoreError) => e.code === "draft/changed");
  assert.throws(() => fresh.confirmServiceDraft(d2.id, { n112: configs.n112! }, admin), (e: StoreError) => e.code === "draft/config-missing");
  assert.deepEqual(fresh.confirmServiceDraft(d2.id, configs, admin, fresh.serviceDraft(d2.id)!.updatedAt), ["nifi-lab-c250", "n112", "n200"]);
  assert.equal(fresh.serviceDraft(d2.id)!.state, "confirmed");
  assert.deepEqual([fresh.standalones().map((s) => s.id), fresh.clusters()[0]!.nodes.length], [["n112", "n200"], 2]);
  assert.deepEqual([fresh.serviceConfig("n112")!.revision, fresh.serviceConfig("n112")!.source], [1, "import"]);
  assert.deepEqual(fresh.serviceConfigRevisions("nifi-lab-c250").map((r) => r.revision), [1]);
  assert.throws(() => fresh.confirmServiceDraft(d2.id, configs, admin), (e: StoreError) => e.code === "draft/closed");
  assert.ok(fresh.listAudit(30, { action: "service." }).some((a) => a.action === "service.config-imported"));
  store.close(); fresh.close();
});

/** A Takeover over a real store and handoff; the "executor" answers svc-read jobs whenever the confirmation waits. */
function harness(o: { box?: boolean; oma?: OmaSessions; alter?: (path: string, text: string) => string; kinds?: string[]; found?: Discovered[]; ignoreConf?: boolean } = {}) {
  const store = new Store(":memory:");
  const handoff = new Handoff(store);
  const box = o.box === false ? undefined : new SecretBox(randomBytes(32).toString("base64"));
  store.setHeartbeat("local", { executor: "service", version: "0.7.3", protocols: [2], kinds: o.kinds ?? ["svc-discover", "svc-read", "executor-upgrade", "svc-discover@2", "svc-read@2"] }, "service");
  const found = o.found ?? lab();
  // The discovery as the executor would have stored it, with each nifi.properties hash matching what the read sends.
  const text = (conf: string) => `nifi.sensitive.props.key=s3cret-${conf.length}\nnifi.web.https.port=1\n`;
  const confOf = (i: Record<string, any>) => String(i.confDir ?? `${i.installDir}/conf`);
  for (const d of found) d.instance.files = [{ name: "nifi.properties", path: `${confOf(d.instance)}/nifi.properties`, sha256: createHash("sha256").update(text(confOf(d.instance))).digest("hex"), size: 1, modifiedAt: "t" }];
  store.queueExecutorJob("svc-discover-1", "local", { protocol: 2, id: "svc-discover-1", kind: "svc-discover" }, undefined, "service");
  store.claimExecutorJob("local", "service");
  store.setExecutorStatus("svc-discover-1", { state: "succeeded", steps: [], result: { instances: found.map((d) => d.instance) } as never });
  const requests: Record<string, unknown>[] = [];
  const answer = async () => {
    for (let job = store.claimExecutorJob("local", "service"); job; job = store.claimExecutorJob("local", "service")) {
      requests.push(job);
      const dir = String(job.installDir);
      // An older service executor knows no confDir: it reads <installDir>/conf.
      const conf = !o.ignoreConf && typeof job.confDir === "string" ? job.confDir : `${dir}/conf`;
      const content = (o.alter ?? ((_p, t) => t))(dir, text(conf));
      const meta = { name: "nifi.properties", path: `${conf}/nifi.properties`, sha256: createHash("sha256").update(content).digest("hex"), size: content.length, modifiedAt: "t" };
      handoff.putEnvContent(String(job.id), JSON.stringify({ installDir: dir, files: [{ ...meta, content: Buffer.from(content).toString("base64") }] }));
      handoff.putStatus(String(job.id), { state: "succeeded", steps: [], result: { installDir: dir, files: [meta], missing: ["authorizers.xml"] } as never });
    }
  };
  const takeover = new Takeover({ store, handoff, ...(box ? { box } : {}), ...(o.oma ? { oma: o.oma } : {}), environment: () => "UAT", hosts: () => ["local"], sleep: answer, readTimeoutMs: 2000, pollMs: 1 });
  return { store, handoff, takeover, box, requests };
}

/** The owner's layout: one NiFi unpacked in /webapp/install, run twice with conf directories under /webapp/deploy. */
function split(): Discovered[] {
  const one = (conf: string, https: number) => {
    const i = nifi("x", "2.5.0", { ports: { https, management: https + 34000 } });
    Object.assign(i, { installDir: "/webapp/install", confDir: conf });
    return { job: "svc-discover-1", host: "local", instance: i };
  };
  return [one("/webapp/deploy/nifi/conf", 18447), one("/webapp/deploy/other/conf", 18448)];
}

test("an installation with its conf directory elsewhere: drafted, read where discovered, registered by host, installation and conf", async () => {
  // §15.2: a service executor that does not name svc-read@2 would read <install>/conf; refused before any read is queued.
  const before = harness({ found: split(), kinds: ["svc-discover", "svc-read", "executor-upgrade"] });
  const early = before.takeover.createDraft(admin).draft;
  await assert.rejects(before.takeover.confirm(early.id, admin), (e: TakeoverError) => e.code === "confirm/executor" && /svc-read@2/.test(e.details.join()));
  assert.deepEqual([before.requests.length, before.store.executorJobs().filter((j) => j.id.startsWith("svc-read")).length], [0, 0], "nothing queued");
  before.store.close();

  const { store, takeover, requests } = harness({ found: split() });
  const { draft } = takeover.createDraft(admin);
  assert.deepEqual(draft.items.map((i) => [i.id, (i as DraftStandalone).member.confDir]), [["nifi", "/webapp/deploy/nifi/conf"], ["other", "/webapp/deploy/other/conf"]],
    "two instances of one installation; named after what holds the conf directory");
  assert.ok(!draft.items.some((i) => (i.findings as Finding[]).some((f) => f.code === "discovery/missing")), "each found its discovery by its conf directory");
  const done = await takeover.confirm(draft.id, admin);
  assert.deepEqual(done.registered, ["nifi", "other"]);
  assert.deepEqual(requests.map((r) => [r.installDir, r.confDir]), [["/webapp/install", "/webapp/deploy/nifi/conf"], ["/webapp/install", "/webapp/deploy/other/conf"]]);
  assert.deepEqual(store.standalones().map((s) => [s.id, s.member.installDir, s.member.confDir]), [["nifi", "/webapp/install", "/webapp/deploy/nifi/conf"], ["other", "/webapp/install", "/webapp/deploy/other/conf"]]);
  assert.equal(store.serviceConfig("other")!.body.members[0]!.confDir, "/webapp/deploy/other/conf");
  assert.deepEqual([store.serviceUsing("local", "/webapp/install/", "/webapp/deploy/nifi/conf/"), store.serviceUsing("local", "/webapp/install"), store.serviceUsing("local", "/webapp/install", "/elsewhere")],
    ["nifi", undefined, undefined]);
  // An installation registered before conf directories were kept counts as <install>/conf.
  store.addStandalone({ kind: "standalone", id: "old", service: "nifi", profile: "nifi-2.x", version: "2.5.0", webUrl: null, member: { host: "local", installDir: "/opt/nifi", serviceUser: null, startEnvironment: null, ports: {} } }, "UAT", admin);
  assert.deepEqual([store.serviceUsing("local", "/opt/nifi"), store.serviceUsing("local", "/opt/nifi", "/opt/nifi/conf"), store.standalones().find((s) => s.id === "old")!.member.confDir], ["old", "old", "/opt/nifi/conf"]);
  store.close();

  // A service executor that ignores confDir reads <installDir>/conf: not what discovery fingerprinted, nothing registered.
  const old = harness({ found: split(), ignoreConf: true });
  await assert.rejects(old.takeover.confirm(old.takeover.createDraft(admin).draft.id, admin), (e: TakeoverError) => e.code === "confirm/read" && /elsewhere than discovery/.test(e.details.join()));
  assert.equal(old.store.standalones().length, 0);
});

test("a draft is made from the newest discoveries, and confirming imports the files read on the hosts", async () => {
  const { store, takeover, box } = harness();
  const key = takeover.fingerprintKey();
  assert.equal(takeover.fingerprintKey(), key, "made once, then kept");
  assert.equal(store.setting(FINGERPRINT_KEY), key);
  const { draft, skipped, missing } = takeover.createDraft(admin);
  assert.deepEqual([draft.items.map((i) => i.id), skipped, missing], [["nifi-lab-c250", "n112", "n200"], [], []]);
  assert.ok((draft.items[1]!.findings as Finding[]).some((f) => f.code === "version/unmaintained"));
  assert.throws(() => takeover.createDraft(admin, ["elsewhere"]), (e: TakeoverError) => e.code === "host/unknown");

  // An edit is assessed again.
  const n200 = draft.items.find((i) => i.id === "n200")! as DraftStandalone;
  const edited = takeover.putItem(draft.id, { ...n200, member: { ...n200.member, ports: { ...n200.member.ports, https: 18445 } } }, admin);
  assert.ok((edited.draft.items.find((i) => i.id === "n200")!.findings as Finding[]).some((f) => f.code === "ports/conflict"));
  takeover.putItem(draft.id, n200, admin);

  const done = await takeover.confirm(draft.id, admin);
  assert.deepEqual([done.draft.state, done.registered, done.reads.length], ["confirmed", ["nifi-lab-c250", "n112", "n200"], 4]);
  const cfg = store.serviceConfig("nifi-lab-c250")!;
  assert.equal(cfg.revision, 1);
  assert.deepEqual(cfg.body.members.map((m) => [m.installDir.split("/").pop(), m.files.map((f) => f.name), m.missing]), [["c250-1", ["nifi.properties"], ["authorizers.xml"]], ["c250-2", ["nifi.properties"], ["authorizers.xml"]]]);
  const file = cfg.body.members[0]!.files[0]!;
  assert.match(box!.open(file.sealed), /s3cret/);
  assert.ok(!file.redacted.includes("s3cret"));
  // The content went over the one-time channel: it is gone from the job afterwards.
  assert.equal(store.takeExecutorEnvContent(done.reads[0]!), undefined);
  assert.throws(() => takeover.createDraft(admin), (e: TakeoverError) => e.code === "draft/nothing-new", "everything is registered now");
  store.close();
});

test("confirming refuses files changed since discovery, a missing key, or an executor that cannot read", async () => {
  const changed = harness({ alter: (dir, t) => (dir.endsWith("c250-2") ? `${t}nifi.web.http.port=9\n` : t) });
  const { draft } = changed.takeover.createDraft(admin);
  await assert.rejects(changed.takeover.confirm(draft.id, admin), (e: TakeoverError) => e.code === "confirm/read" && /c250-2: changed since discovery: nifi\.properties/.test(e.details.join()));
  assert.deepEqual([changed.store.serviceDraft(draft.id)!.state, changed.store.clusters().length, changed.store.serviceConfig("n112")], ["open", 0, undefined]);

  const nokey = harness({ box: false });
  await assert.rejects(nokey.takeover.confirm(nokey.takeover.createDraft(admin).draft.id, admin), (e: TakeoverError) => e.status === 503 && e.code === "confirm/no-key");
  const old = harness({ kinds: ["svc-discover"] });
  await assert.rejects(old.takeover.confirm(old.takeover.createDraft(admin).draft.id, admin), (e: TakeoverError) => e.code === "confirm/executor");
});

test("the AI review is optional: without OMA it is refused, with OMA it explains on top of the rules", async () => {
  const none = harness();
  const d = none.takeover.createDraft(admin).draft;
  await assert.rejects(none.takeover.review(d.id, admin), (e: TakeoverError) => e.status === 503 && e.code === "review/unavailable");
  assert.equal((await none.takeover.confirm(d.id, admin)).draft.state, "confirmed", "taking over works without it");

  let sent = "";
  let events: unknown[] = [];
  const oma = { open: async (_t: string, _c: string, text: string) => { sent = text; return "sess-1"; }, events: async () => events } as unknown as OmaSessions;
  const { takeover } = harness({ oma });
  const draft = takeover.createDraft(admin).draft;
  const asked = await takeover.review(draft.id, admin);
  assert.deepEqual([asked.review?.state, asked.review?.session], ["running", "sess-1"]);
  assert.match(sent, /nifi-lab-c250/);
  assert.ok(!sent.includes("fp-same"), "no fingerprints, no secrets");
  assert.equal((await takeover.withReview(draft.id)).review?.state, "running");
  events = [{ type: "agent.message", content: [{ type: "text", text: "n112：1.x 已停止维护，建议升级。" }] }, { type: "session.status_idle" }];
  const read = await takeover.withReview(draft.id);
  assert.deepEqual([read.review?.state, read.review?.text], ["done", "n112：1.x 已停止维护，建议升级。"]);
});

test("catalogFor still filters by version", () => {
  assert.ok(catalogFor(profile("nifi-2.x")!, "2.5.0").some((e) => e.key === "nifi.cluster.protocol.is.secure"));
});
