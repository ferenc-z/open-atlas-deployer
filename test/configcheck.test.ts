// Service ops §7, §16.3: checking a configuration, and what a change means (services/configcheck.ts).

import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { SecretBox } from "../src/server/secretbox.ts";
import { sealFile, type ConfigMember } from "../src/server/services/config.ts";
import { assessChange, blockingFindings, checkConfig, openBody, type CheckInput, type CheckMember } from "../src/server/services/configcheck.ts";
import { editProperties } from "../src/server/services/configdoc.ts";
import { catalogEntry, profile, PROFILES } from "../src/server/services/profiles.ts";

const ONE = profile("nifi-1.x")!, TWO = profile("nifi-2.x")!;
const SAMPLE = (version: string, name: string) => readFileSync(new URL(`../testdata/nifi-conf/${version}/${name}`, import.meta.url));
const SAMPLE_FILES = ["nifi.properties", "bootstrap.conf", "state-management.xml", "logback.xml", "authorizers.xml", "login-identity-providers.xml"];

type Files = Record<string, Buffer | string | null>;
const member = (dir: string, files: Files, host = "h"): CheckMember => ({
  host, installDir: `/opt/${dir}`,
  files: Object.entries(files).map(([name, raw]) => {
    if (raw === null) return { name, sha256: `opaque-${dir}`, bytes: null };
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "latin1");
    return { name, sha256: createHash("sha256").update(bytes).digest("hex"), bytes };
  }),
});
const props = (...lines: string[]) => lines.map((l) => `${l}\n`).join("");
const input = (more: Partial<CheckInput> & { members: CheckMember[] }): CheckInput => ({ profile: TWO, version: "2.5.0", kind: "cluster", ...more });
const codes = (r: { findings: { code: string }[] }) => r.findings.map((f) => f.code);
const one = <T extends { code: string; key?: string }>(r: { findings: T[] }, code: string, key?: string) => r.findings.filter((f) => f.code === code && (!key || f.key === key));

/** A 2-node cluster from the 2.5.0 samples, with the ports and the like a real pair differs in. */
function sampleCluster(): CheckMember[] {
  const files = (n: number) => {
    const out: Files = Object.fromEntries(SAMPLE_FILES.map((f) => [f, SAMPLE("2.5.0", f)]));
    out["nifi.properties"] = editProperties(SAMPLE("2.5.0", "nifi.properties"), [
      { key: "nifi.web.https.port", value: String(18445 + n) }, { key: "nifi.cluster.node.protocol.port", value: String(11445 + n) }, { key: "nifi.cluster.load.balance.port", value: String(16345 + n) },
    ]);
    out["bootstrap.conf"] = editProperties(SAMPLE("2.5.0", "bootstrap.conf"), [{ key: "management.server.address", value: `http://127.0.0.1:${52445 + n}` }]);
    return out;
  };
  return [member("c1", files(0)), member("c2", files(1))];
}
const editNifi = (m: CheckMember, ...changes: Parameters<typeof editProperties>[1]): CheckMember => ({
  ...m,
  files: m.files.map((f) => {
    if (f.name !== "nifi.properties") return f;
    const bytes = editProperties(f.bytes!, changes);
    return { ...f, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  }),
});

test("the catalog says what cannot roll; both lines, and 1.x's provider key", () => {
  const notRolling = (p: typeof ONE) => p.catalog.filter((e) => e.rolling === false).map((e) => e.key).sort();
  const shared = ["nifi.cluster.protocol.is.secure", "nifi.sensitive.props.algorithm", "nifi.sensitive.props.key", "nifi.zookeeper.auth.type", "nifi.zookeeper.client.secure", "nifi.zookeeper.connect.string", "nifi.zookeeper.root.node"];
  assert.deepEqual(notRolling(TWO), shared);
  assert.deepEqual(notRolling(ONE), [...shared, "nifi.sensitive.props.provider"].sort());
  for (const p of PROFILES) assert.deepEqual(p.notRollingXml["state-management.xml"], ["Connect String", "Root Node"]);
  assert.equal(catalogEntry(TWO, "nifi.web.https.port")?.rolling, undefined);
});

test("the samples as shipped have nothing wrong; a cluster that matches has no differences", () => {
  for (const [p, version] of [[ONE, "1.12.1"], [TWO, "2.5.0"]] as const) {
    const m = member("a", Object.fromEntries(SAMPLE_FILES.map((f) => [f, SAMPLE(version, f)])));
    const r = checkConfig({ profile: p, version, kind: "standalone", members: [m] });
    assert.deepEqual(r.findings.filter((f) => f.severity !== "info"), [], `${version}: ${JSON.stringify(r.findings)}`);
    assert.equal(r.change, null);
  }
  const r = checkConfig(input({ members: sampleCluster() }));
  assert.deepEqual(r.findings.filter((f) => f.severity !== "info"), []);
});

test("a key this version does not have, by since/until and by the other line", () => {
  const r = checkConfig({ profile: ONE, version: "1.12.1", kind: "standalone", members: [member("a", { "nifi.properties": props("nifi.flow.configuration.json.file=./conf/flow.json.gz", "nifi.python.command=python3") })] });
  assert.equal(one(r, "config/not-in-version", "nifi.flow.configuration.json.file")[0]!.severity, "warning");
  assert.equal(one(r, "config/not-in-version", "nifi.python.command").length, 1);
  const later = checkConfig({ profile: ONE, version: "1.16.0", kind: "standalone", members: [member("a", { "nifi.properties": props("nifi.flow.configuration.json.file=./conf/flow.json.gz") })] });
  assert.deepEqual(codes(later), []);
  assert.deepEqual(codes(checkConfig({ profile: TWO, version: "2.0.0", kind: "standalone", members: [member("a", { "nifi.properties": props("nifi.templates.directory=./conf/templates") })] })), ["config/not-in-version"]);
});

test("2.x with nifi.flow.configuration.file on flow.xml.gz is reported; 1.x is not", () => {
  const file = { "nifi.properties": props("nifi.flow.configuration.file=./conf/flow.xml.gz") };
  const two = checkConfig({ profile: TWO, version: "2.5.0", kind: "standalone", members: [member("a", file)] });
  assert.equal(one(two, "config/not-in-version", "nifi.flow.configuration.file")[0]!.severity, "error");
  assert.deepEqual(codes(checkConfig({ profile: ONE, version: "1.12.1", kind: "standalone", members: [member("a", file)] })), []);
});

test("types and ranges; an empty value is not set, and messages never repeat a value", () => {
  const bad: [string, string][] = [
    ["nifi.web.https.port", "70000"], ["nifi.web.http.port", "http"], ["nifi.cluster.is.node", "yes"], ["nifi.cluster.flow.election.max.candidates", "two"],
    ["nifi.zookeeper.connect.timeout", "soon"], ["nifi.web.https.host", "a b"],
  ];
  const r = checkConfig({ profile: TWO, version: "2.5.0", kind: "standalone", members: [member("a", { "nifi.properties": props(...bad.map(([k, v]) => `${k}=${v}`)) })] });
  for (const [key, value] of bad) {
    const f = one(r, "config/bad-value", key);
    assert.equal(f[0]?.severity, "error", key);
    assert.ok(!f[0]!.message.includes(`=${value}`) && !f[0]!.message.includes(` ${value} `));
  }
  const url = checkConfig({ profile: TWO, version: "2.5.0", kind: "standalone", members: [member("a", { "bootstrap.conf": props("management.server.address=not a url") })] });
  assert.equal(one(url, "config/bad-value", "management.server.address").length, 1);
  const fine = props("nifi.web.http.port=", "nifi.web.https.port=8443", "nifi.cluster.is.node=TRUE", "nifi.zookeeper.connect.timeout=10 secs", "nifi.cluster.flow.election.max.wait.time=1.5 mins", "nifi.cluster.flow.election.max.candidates=", "nifi.web.https.host=::1");
  assert.deepEqual(codes(checkConfig({ profile: TWO, version: "2.5.0", kind: "standalone", members: [member("a", { "nifi.properties": fine })] })), []);
});

test("cluster consistency: scope cluster keys, the default for a key left out, secrets by label only", () => {
  const SECRET = "s3cret-value", OTHER = "other-secret";
  const r = checkConfig(input({ members: [
    member("a", { "nifi.properties": props(`nifi.sensitive.props.key=${SECRET}`, "nifi.cluster.node.read.timeout=5 sec", "nifi.zookeeper.root.node=/a", "nifi.remote.input.secure=true", "nifi.web.https.port=1001") }),
    member("b", { "nifi.properties": props(`nifi.sensitive.props.key=${OTHER}`, "nifi.cluster.node.read.timeout=9 sec", "nifi.zookeeper.root.node=/b", "nifi.web.https.port=1002") }),
  ] }));
  const secret = one(r, "config/cluster-differs", "nifi.sensitive.props.key")[0]!;
  assert.equal(secret.severity, "error");
  assert.deepEqual(secret.values!.map((v) => v.value), ["value A", "value B"]);
  assert.ok(!JSON.stringify(r).includes(SECRET) && !JSON.stringify(r).includes(OTHER));
  assert.equal(one(r, "config/cluster-differs", "nifi.zookeeper.root.node")[0]!.severity, "error", "a grouping key");
  const plain = one(r, "config/cluster-differs", "nifi.cluster.node.read.timeout")[0]!;
  assert.equal(plain.severity, "warning");
  assert.deepEqual(plain.values!.map((v) => v.value), ["5 sec", "9 sec"]);
  assert.equal(one(r, "config/cluster-differs", "nifi.remote.input.secure").length, 0, "left out reads as the default, which is the same");
  assert.equal(one(r, "config/cluster-differs", "nifi.web.https.port").length, 0, "a node key may differ");
  assert.deepEqual(codes(checkConfig({ profile: TWO, version: "2.5.0", kind: "standalone", members: [member("a", { "nifi.properties": props("nifi.zookeeper.root.node=/a") })] })), [], "a standalone has no nodes to compare");
});

test("cluster consistency covers state-management.xml's Connect String and Root Node, comments aside", () => {
  const xml = (root: string, comment = "") => `<stateManagement><cluster-provider>${comment}<property name="Connect String">zk:1</property><property name='Root Node'>${root}</property></cluster-provider></stateManagement>`;
  const r = checkConfig(input({ members: [member("a", { "state-management.xml": xml("/a") }), member("b", { "state-management.xml": xml("/b") })] }));
  assert.equal(one(r, "config/cluster-differs", "Root Node")[0]!.severity, "error");
  assert.equal(one(r, "config/cluster-differs", "Connect String").length, 0);
  const commented = checkConfig(input({ members: [member("a", { "state-management.xml": xml("/a", '<!-- <property name="Root Node">/old</property> -->') }), member("b", { "state-management.xml": xml("/a") })] }));
  assert.deepEqual(codes(commented), []);
});

test("port conflicts: across nodes on one machine, against other services, and within one installation", () => {
  const nifi = (p: number, more: string[] = []) => ({ "nifi.properties": props(`nifi.web.https.port=${p}`, ...more) });
  const between = checkConfig(input({ members: [member("a", nifi(8443)), member("b", nifi(8443))] }));
  assert.equal(one(between, "ports/conflict")[0]!.severity, "error");
  assert.deepEqual(codes(checkConfig(input({ members: [member("a", nifi(8443), "h1"), member("b", nifi(8443), "h2")] }))), [], "different machines");
  const others = [{ service: "other", profile: "nifi-2.x", member: { host: "h", installDir: "/opt/x", ports: { https: 8443, management: 52999 } } }];
  assert.equal(one(checkConfig({ profile: TWO, version: "2.5.0", kind: "standalone", members: [member("a", nifi(8443))], others }), "ports/conflict").length, 1);
  const own = checkConfig({ profile: TWO, version: "2.5.0", kind: "standalone", members: [member("a", nifi(8443, ["nifi.cluster.is.node=true", "nifi.cluster.node.protocol.port=8443"]))] });
  assert.match(one(own, "ports/conflict")[0]!.message, /both https and clusterProtocol/);
  assert.deepEqual(codes(checkConfig({ profile: TWO, version: "2.5.0", kind: "standalone", members: [member("a", nifi(8443, ["nifi.cluster.node.protocol.port=8443"]))] })), [], "cluster ports only count on a node");
  const management = checkConfig(input({ members: [member("a", { "bootstrap.conf": props("management.server.address=http://127.0.0.1:52020"), "nifi.properties": "" }), member("b", { "nifi.properties": "" })] }));
  assert.equal(one(management, "ports/conflict").length, 1, "2.x without the key listens on 52020");
});

test("the heap against the machine: 80% by default, no sample is said, -Xmx wherever it is", () => {
  const GB = 1024 ** 3;
  const boot = (...lines: string[]) => ({ "bootstrap.conf": props(...lines) });
  const run = (lines: string[], memory?: CheckInput["memory"], heapMaxPct?: number) => checkConfig({ profile: TWO, version: "2.5.0", kind: "standalone", members: [member("a", boot(...lines))], ...(memory ? { memory } : {}), ...(heapMaxPct ? { heapMaxPct } : {}) });
  const x = ["java.arg.2=-Xms1g", "java.arg.3=-Xmx8g"];
  assert.deepEqual(codes(run(x, { h: 16 * GB })), []);
  assert.equal(one(run(x, { h: 8.5 * GB }), "config/heap-too-large")[0]!.severity, "warning");
  assert.equal(one(run(x, { h: 4 * GB }), "config/heap-too-large")[0]!.severity, "error");
  assert.deepEqual(codes(run(x, { h: 8.5 * GB }, 95)), []);
  const none = run(x, {});
  assert.deepEqual(codes(none), ["config/heap-not-checked"]);
  assert.equal(none.findings[0]!.severity, "info");
  assert.equal(one(run(["java.arg.7=-Xmx32768m"], { h: 16 * GB }), "config/heap-too-large")[0]!.severity, "error", "another java.arg, in megabytes");
  assert.deepEqual(codes(run(["java.arg.2=-Xms8g", "java.arg.3=-Xmx4g"], { h: 16 * GB })), ["config/heap-order"]);
  assert.equal(one(run(["java.arg.3=-Xmxlots"], { h: 16 * GB }), "config/bad-value", "java.arg.3").length, 1);
  assert.deepEqual(codes(run(["java.arg.1=-Dx=y"])), [], "no heap flag, nothing to check");
});

test("XML must be well-formed; the line is said", () => {
  const r = checkConfig({ profile: TWO, version: "2.5.0", kind: "standalone", members: [member("a", { "authorizers.xml": "<a>\n<b></a>", "logback.xml": "<configuration/>" })] });
  assert.deepEqual(codes(r), ["config/xml-malformed"]);
  assert.equal(r.findings[0]!.file, "authorizers.xml");
  assert.match(r.findings[0]!.message, /line 2/);
});

test("a file that cannot be opened is reported, and openBody says so from the kept copy", () => {
  const box = new SecretBox(randomBytes(32).toString("base64"));
  const raw = Buffer.from("nifi.web.https.port=8443\n");
  const kept: ConfigMember = { host: "h", installDir: "/opt/a", missing: [], files: [sealFile({ name: "nifi.properties", path: "/p", modifiedAt: "t" }, raw, box), { ...sealFile({ name: "bootstrap.conf", path: "/q", modifiedAt: "t" }, raw, box), sha256: "lost-bytes" }] };
  const opened = openBody({ members: [kept] }, box);
  assert.deepEqual(opened[0]!.files.map((f) => f.bytes !== null), [true, false]);
  const r = checkConfig({ profile: TWO, version: "2.5.0", kind: "standalone", members: opened });
  assert.deepEqual(codes(r).filter((c) => c === "config/reimport"), ["config/reimport"]);
  assert.equal(one(r, "config/reimport")[0]!.file, "bootstrap.conf");
});

test("what is already there shows and does not block; what the change brings blocks", () => {
  const before = [member("a", { "nifi.properties": props("nifi.web.https.port=70000", "nifi.zookeeper.root.node=/a") }, "h1"), member("b", { "nifi.properties": props("nifi.web.https.port=8443", "nifi.zookeeper.root.node=/b") }, "h2")];
  const same = checkConfig(input({ base: before, members: [editNifi(before[0]!, { key: "nifi.ui.banner.text", value: "x" }), before[1]!] }));
  assert.equal(one(same, "config/bad-value")[0]!.introduced, false);
  assert.equal(one(same, "config/cluster-differs", "nifi.zookeeper.root.node")[0]!.introduced, false);
  assert.deepEqual(blockingFindings(same.findings), []);
  const worse = checkConfig(input({ base: before, members: [before[0]!, editNifi(before[1]!, { key: "nifi.web.https.port", value: "99999" })] }));
  assert.deepEqual(blockingFindings(worse.findings).map((f) => [f.code, f.member]), [["config/bad-value", "h2:/opt/b"]]);
  const fresh = checkConfig(input({ members: before }));
  assert.ok(blockingFindings(fresh.findings).length >= 2, "without a base everything counts as new");
  assert.deepEqual(blockingFindings([{ severity: "warning", code: "x", message: "m", introduced: true }]), []);
});

test("restart: a key that needs one, a key the catalog lacks, a key that does not, and comments only", () => {
  const was = member("a", { "nifi.properties": props("# one", "nifi.web.https.port=1", "nifi.ui.banner.text=a") });
  const assess = (now: string, p = TWO) => assessChange({ profile: p, kind: "standalone", base: [was], members: [member("a", { "nifi.properties": now })] });
  const known = assess(props("# one", "nifi.web.https.port=2", "nifi.ui.banner.text=a"));
  assert.equal(known.restart, true);
  assert.deepEqual(known.members[0]!.files[0]!.keys, ["nifi.web.https.port"]);
  assert.match(known.members[0]!.files[0]!.reasons[0]!, /needs a restart/);
  const unknown = assess(props("# one", "nifi.web.https.port=1", "nifi.ui.banner.text=b"));
  assert.equal(unknown.restart, true);
  assert.match(unknown.members[0]!.files[0]!.reasons[0]!, /not in the catalog/);
  const comment = assess(props("# two", "nifi.web.https.port=1", "nifi.ui.banner.text=a"));
  assert.deepEqual(comment.members[0]!.files[0], { name: "nifi.properties", change: "format", restart: false, reasons: [], keys: [] });
  assert.equal(comment.restart, false);
  const moved = assess(props("nifi.ui.banner.text=a", "nifi.web.https.port=1", "# one"));
  assert.equal(moved.members[0]!.files[0]!.change, "format", "order only");
  const live = { ...TWO, catalog: TWO.catalog.map((e) => (e.key === "nifi.web.https.port" ? { ...e, restart: false } : e)) };
  assert.equal(assess(props("# one", "nifi.web.https.port=2", "nifi.ui.banner.text=a"), live).restart, false, "the catalog's restart: false");
  assert.deepEqual(assess(props("# one", "nifi.web.https.port=1", "nifi.ui.banner.text=a")).members, [], "same bytes: nothing");
});

test("restart: XML needs one unless only comments change, or logback.xml with scan on as it stands", () => {
  const assess = (name: string, before: string, after: string) => assessChange({ profile: TWO, kind: "standalone", base: [member("a", { [name]: before })], members: [member("a", { [name]: after })] });
  assert.equal(assess("authorizers.xml", "<a><b>1</b></a>", "<a><b>2</b></a>").restart, true);
  const comment = assess("authorizers.xml", "<a>\n<!-- x -->\n<b>1</b></a>", "<a>\n<!-- y --><b>1</b></a>");
  assert.equal(comment.restart, false);
  assert.equal(comment.members[0]!.files[0]!.change, "format");
  assert.equal(assess("authorizers.xml", "<a><![CDATA[<!-- x -->]]></a>", "<a><![CDATA[<!-- y -->]]></a>").restart, true, "CDATA is content, whatever it looks like");
  assert.equal(assess("logback.xml", '<configuration scan="true"><a/></configuration>', '<configuration scan="true"><b/></configuration>').restart, false);
  assert.equal(assess("logback.xml", '<configuration><a/></configuration>', '<configuration><b/></configuration>').restart, true);
  assert.equal(assess("logback.xml", '<configuration scan="false"><a/></configuration>', '<configuration scan="true"><a/></configuration>').restart, true, "what runs now does not scan yet");
  assert.equal(assess("logback.xml", '<!-- <configuration scan="true"> --><configuration><a/></configuration>', '<configuration><b/></configuration>').restart, true, "a commented-out scan does not count");
  assert.equal(assess("authorizers.xml", '<a/>', '<a/>').members.length, 0);
  const added = assessChange({ profile: TWO, kind: "standalone", base: [member("a", {})], members: [member("a", { "logback.xml": '<configuration scan="true"/>' })] });
  assert.equal(added.restart, true);
  assert.equal(added.members[0]!.files[0]!.change, "added");
  const gone = assessChange({ profile: TWO, kind: "standalone", base: [member("a", { "authorizers.xml": "<a/>" })], members: [member("a", {})] });
  assert.equal(gone.members[0]!.files[0]!.change, "removed");
  assert.equal(gone.restart, true);
});

test("the samples unchanged, and the real logback.xml with a level changed: no restart", () => {
  const log = SAMPLE("2.5.0", "logback.xml");
  const base = [member("a", { "logback.xml": log })];
  assert.deepEqual(assessChange({ profile: TWO, kind: "standalone", base, members: base }).members, []);
  const now = Buffer.from(log.toString("latin1").replace('level="INFO"', 'level="DEBUG"'), "latin1");
  assert.notDeepEqual(now, log);
  assert.equal(assessChange({ profile: TWO, kind: "standalone", base, members: [member("a", { "logback.xml": now })] }).restart, false);
});

test("full: any key that cannot roll, on any node, takes ordinary keys with it", () => {
  const base = sampleCluster();
  const rolling = checkConfig(input({ base, members: base.map((m) => editNifi(m, { key: "nifi.ui.banner.text", value: "x" })) }));
  assert.equal(rolling.change!.mode, "rolling");
  assert.deepEqual(rolling.change!.fullBecause, []);
  assert.equal(codes(rolling).includes("config/not-rolling-safe"), false);
  for (const key of ["nifi.zookeeper.connect.string", "nifi.zookeeper.root.node", "nifi.sensitive.props.algorithm", "nifi.cluster.protocol.is.secure", "nifi.zookeeper.client.secure", "nifi.zookeeper.auth.type"]) {
    const r = assessChange({ profile: TWO, kind: "cluster", base, members: base.map((m) => editNifi(m, { key, value: "changed" })) });
    assert.equal(r.mode, "full", key);
    assert.deepEqual(r.fullBecause, [{ file: "nifi.properties", key }]);
  }
  const mixed = checkConfig(input({ base, members: base.map((m) => editNifi(m, { key: "nifi.ui.banner.text", value: "x" }, { key: "nifi.zookeeper.root.node", value: "/other" })) }));
  assert.equal(mixed.change!.mode, "full");
  assert.deepEqual(mixed.change!.members[0]!.files[0]!.keys.sort(), ["nifi.ui.banner.text", "nifi.zookeeper.root.node"], "ordinary keys go along, not split off");
  const safe = one(mixed, "config/not-rolling-safe");
  assert.equal(safe.length, 1, "one finding however many nodes");
  assert.equal(safe[0]!.severity, "warning");
  assert.equal(safe[0]!.key, "nifi.zookeeper.root.node");
  assert.deepEqual(blockingFindings(mixed.findings), [], "not refused");
  assert.equal(one(mixed, "config/zookeeper-state", "nifi.zookeeper.root.node").length, 1);
  const oneNode = assessChange({ profile: TWO, kind: "cluster", base, members: [editNifi(base[0]!, { key: "nifi.zookeeper.root.node", value: "/other" }), base[1]!] });
  assert.equal(oneNode.mode, "full", "one node is enough");
  assert.deepEqual(oneNode.members.map((m) => m.member), ["h:/opt/c1"]);
  const provider = assessChange({ profile: ONE, kind: "cluster", base: [member("a", { "nifi.properties": props("nifi.sensitive.props.provider=BC") })], members: [member("a", { "nifi.properties": props("nifi.sensitive.props.provider=SUN") })] });
  assert.equal(provider.mode, "full", "1.x's provider key");
});

test("full: state-management.xml's ZooKeeper properties count; other changes to it do not, nor comments", () => {
  const xml = (connect: string, root: string, more = "") => `<stateManagement>${more}<cluster-provider><property name="Connect String">${connect}</property><property name="Root Node">${root}</property></cluster-provider></stateManagement>`;
  const run = (after: string) => assessChange({ profile: TWO, kind: "cluster", base: [member("a", { "state-management.xml": xml("zk:1", "/a") })], members: [member("a", { "state-management.xml": after })] });
  assert.deepEqual(run(xml("zk:2", "/a")).fullBecause, [{ file: "state-management.xml", key: "Connect String" }]);
  assert.deepEqual(run(xml("zk:1", "/b")).fullBecause, [{ file: "state-management.xml", key: "Root Node" }]);
  const other = run(xml("zk:1", "/a", '<local-provider><property name="Directory">/x</property></local-provider>'));
  assert.equal(other.mode, "rolling");
  assert.equal(other.restart, true);
  const comment = run(xml("zk:1", "/a", '<!-- <property name="Root Node">/zzz</property> -->'));
  assert.equal(comment.mode, "rolling");
  assert.equal(comment.restart, false);
  const mixed = assessChange({ profile: TWO, kind: "cluster", base: sampleCluster(), members: sampleCluster().map((m) => ({ ...m, files: m.files.map((f) => {
    if (f.name !== "state-management.xml") return f;
    const bytes = Buffer.from(f.bytes!.toString("latin1").replace("/nifi-lab-c250/state", "/moved"), "latin1");
    return { ...f, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  }) })) });
  assert.deepEqual(mixed.fullBecause, [{ file: "state-management.xml", key: "Root Node" }]);
});

test("full: a file that cannot be compared counts, to be safe; the same hash does not", () => {
  const base = [member("a", { "nifi.properties": null })];
  assert.deepEqual(assessChange({ profile: TWO, kind: "cluster", base, members: [member("a", { "nifi.properties": "x=1\n" })] }).fullBecause, [{ file: "nifi.properties" }]);
  assert.deepEqual(assessChange({ profile: TWO, kind: "cluster", base, members: base }).members, []);
});

test("a standalone is never full, but still gets the flow's warning", () => {
  const base = [member("a", { "nifi.properties": props("nifi.sensitive.props.key=old-one", "nifi.zookeeper.root.node=/a") })];
  const r = checkConfig({ profile: TWO, version: "2.5.0", kind: "standalone", base, members: [member("a", { "nifi.properties": props("nifi.sensitive.props.key=new-one", "nifi.zookeeper.root.node=/b") })] });
  assert.equal(r.change!.mode, "rolling");
  assert.deepEqual(r.change!.fullBecause, []);
  assert.deepEqual(codes(r).sort(), ["config/sensitive-key-migration"]);
});

test("changing the flow's key or algorithm warns, without showing either value; the key is compared on the bytes", () => {
  const OLD = "old-secret-key", NEW = "new-secret-key";
  const base = [member("a", { "nifi.properties": props(`nifi.sensitive.props.key=${OLD}`, "nifi.sensitive.props.algorithm=A") }), member("b", { "nifi.properties": props(`nifi.sensitive.props.key=${OLD}`, "nifi.sensitive.props.algorithm=A") })];
  const r = checkConfig(input({ base, members: base.map((m) => editNifi(m, { key: "nifi.sensitive.props.key", value: NEW }, { key: "nifi.sensitive.props.algorithm", value: "B" })) }));
  assert.equal(r.change!.mode, "full");
  const migration = one(r, "config/sensitive-key-migration");
  assert.deepEqual(migration.map((f) => f.key).sort(), ["nifi.sensitive.props.algorithm", "nifi.sensitive.props.key"]);
  assert.ok(migration.every((f) => f.severity === "warning"));
  assert.deepEqual(blockingFindings(r.findings), []);
  const all = JSON.stringify(r);
  assert.ok(!all.includes(OLD) && !all.includes(NEW));
});

test("P15: the flow's encrypted values as the executor counts them: none and nothing is said, some and it says what happens and how by hand, not known and it says may", () => {
  const base = [member("a", { "nifi.properties": props("nifi.sensitive.props.key=old-one") }), member("b", { "nifi.properties": props("nifi.sensitive.props.key=old-one") })];
  const members = base.map((m) => editNifi(m, { key: "nifi.sensitive.props.key", value: "new-one" }));
  const warn = (encrypted?: CheckInput["encrypted"], version = "2.5.0") => one(checkConfig(input({ base, members, encrypted, version })), "config/sensitive-key-migration");
  assert.deepEqual(warn({ "h:/opt/a": 0, "h:/opt/b": 0 }), [], "no enc{ in either flow: it just works");
  const some = warn({ "h:/opt/a": 3, "h:/opt/b": 3 });
  assert.equal(some.length, 1);
  assert.match(some[0]!.message, /holds 3 encrypted values/);
  assert.match(some[0]!.message, /will not start/);
  assert.match(some[0]!.message, /nifi\.sh set-sensitive-properties-key/);
  for (const unknown of [undefined, { "h:/opt/a": 0 }, { "h:/opt/a": 0, "h:/opt/b": null }]) {
    const may = warn(unknown);
    assert.equal(may.length, 1, "an older executor, or no sample yet: may have");
    assert.match(may[0]!.message, /not known/);
  }
  assert.match(warn(undefined, "1.12.1")[0]!.message, /encrypt-config\.sh/, "1.x: the toolkit");
  assert.equal(warn({ "h:/opt/a": 1, "h:/opt/b": 0 })[0]!.severity, "warning", "never an error: it rolls back by itself");
});

test("nifi.cluster.is.node changing is an error; left to the default is not a change of meaning", () => {
  const base = [member("a", { "nifi.properties": props("nifi.cluster.is.node=true") })];
  const r = checkConfig(input({ base, members: [member("a", { "nifi.properties": props("nifi.cluster.is.node=false") })] }));
  assert.equal(one(r, "config/no-conversion")[0]!.severity, "error");
  assert.deepEqual(blockingFindings(r.findings).map((f) => f.code), ["config/no-conversion"]);
  const standalone = checkConfig({ profile: TWO, version: "2.5.0", kind: "standalone", base: [member("a", { "nifi.properties": props("nifi.cluster.is.node=false") })], members: [member("a", { "nifi.properties": props("nifi.cluster.is.node=true") })] });
  assert.equal(one(standalone, "config/no-conversion").length, 1);
  const defaulted = checkConfig({ profile: TWO, version: "2.5.0", kind: "standalone", base: [member("a", { "nifi.properties": props("nifi.cluster.is.node=false", "x=1") })], members: [member("a", { "nifi.properties": props("x=1") })] });
  assert.equal(one(defaulted, "config/no-conversion").length, 0);
});

test("a key the catalog lacks is only an info, and only when this change touches it", () => {
  const base = [member("a", { "nifi.properties": props("nifi.ui.banner.text=a", "nifi.other.thing=b") })];
  assert.deepEqual(codes(checkConfig({ profile: TWO, version: "2.5.0", kind: "standalone", members: base })), []);
  const r = checkConfig({ profile: TWO, version: "2.5.0", kind: "standalone", base, members: [member("a", { "nifi.properties": props("nifi.ui.banner.text=z", "nifi.other.thing=b") })] });
  const unknown = one(r, "config/unknown-key");
  assert.deepEqual(unknown.map((f) => [f.key, f.severity]), [["nifi.ui.banner.text", "info"]]);
});

test("findings come worst first", () => {
  const r = checkConfig({ profile: TWO, version: "2.5.0", kind: "standalone", base: [member("a", { "nifi.properties": props("nifi.templates.directory=x") })], members: [member("a", { "nifi.properties": props("nifi.templates.directory=x", "nifi.web.https.port=0", "nifi.other=1") })] });
  assert.deepEqual(r.findings.map((f) => f.severity), ["error", "warning", "info"]);
});

test("a change on the whole 1.12.1 sample: secrets unseen, the format of the rest kept out", () => {
  const base = [member("a", Object.fromEntries(SAMPLE_FILES.map((f) => [f, SAMPLE("1.12.1", f)])))];
  const now = editNifi(base[0]!, { key: "nifi.web.https.port", value: "28443" });
  const r = checkConfig({ profile: ONE, version: "1.12.1", kind: "standalone", base, members: [now] });
  assert.deepEqual(r.change!.members[0]!.files.map((f) => f.name), ["nifi.properties"]);
  assert.deepEqual(r.change!.members[0]!.files[0]!.keys, ["nifi.web.https.port"]);
  assert.deepEqual(blockingFindings(r.findings), []);
  assert.ok(!JSON.stringify(r).includes("fake-"));
});
