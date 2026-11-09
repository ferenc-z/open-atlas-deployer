// Service ops §16.3: a cluster's configuration in layers (services/layers.ts).

import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SecretBox } from "../src/server/secretbox.ts";
import { Store } from "../src/server/store.ts";
import { openFile, sealFile, withoutSealed, type ConfigFileRecord, type ConfigLayers, type ConfigMember, type ServiceConfigBody } from "../src/server/services/config.ts";
import { ConfigDocError, editProperties, encodeValue, writeProperties } from "../src/server/services/configdoc.ts";
import { renderBody, renderFile, sameProperties, splitBody } from "../src/server/services/layers.ts";

const box = new SecretBox(randomBytes(32).toString("base64"));
const A = "h:/opt/a", B = "h:/opt/b";
const SAMPLE = (version: string, name: string) => readFileSync(new URL(`../testdata/nifi-conf/${version}/${name}`, import.meta.url));

const member = (dir: string, files: Record<string, Buffer | string>, missing: string[] = []): ConfigMember => ({
  host: "h", installDir: `/opt/${dir}`, missing,
  files: Object.entries(files).map(([name, raw]) => sealFile({ name, path: `/opt/${dir}/conf/${name}`, modifiedAt: "t" }, Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "latin1"), box)),
});
const cluster = (a: Record<string, Buffer | string>, b: Record<string, Buffer | string>): ServiceConfigBody => ({ members: [member("a", a), member("b", b)] });
const bytes = (body: ServiceConfigBody, m: number, name: string) => {
  const opened = openFile(body.members[m]!.files.find((f) => f.name === name)!, box);
  assert.ok(opened.ok);
  return opened.bytes;
};
const template = (body: ServiceConfigBody, name: string) => {
  const opened = openFile(body.layers!.common[name] as ConfigFileRecord, box);
  assert.ok(opened.ok);
  return opened.bytes.toString("latin1");
};
const refused = (code: string) => (e: unknown) => e instanceof ConfigDocError && e.code === code;

test("the same files on every node all go to the common layer, and render as the same bytes", () => {
  for (const version of ["1.12.1", "2.5.0"]) {
    const files = Object.fromEntries(readdirSync(new URL(`../testdata/nifi-conf/${version}/`, import.meta.url)).map((n) => [n, SAMPLE(version, n)]));
    const body = cluster(files, files);
    const split = splitBody(body, box);
    assert.deepEqual(Object.keys(split.layers!.common).sort(), Object.keys(files).sort());
    assert.deepEqual(split.layers!.nodes, { [A]: {}, [B]: {} });
    // Nothing changed: the records are the ones it had, the same seal and all.
    assert.deepEqual(split.members, body.members);
  }
});

test("the lab's files with node values: those go to the nodes, and each node's file comes back byte for byte", () => {
  for (const version of ["1.12.1", "2.5.0"]) {
    const base = SAMPLE(version, "nifi.properties");
    const node = (host: string, port: string, pass: string) => editProperties(base, [
      { key: "nifi.web.https.host", value: host }, { key: "nifi.web.https.port", value: port }, { key: "nifi.cluster.node.address", value: host }, { key: "nifi.security.keystorePasswd", value: pass },
    ]);
    const body = cluster({ "nifi.properties": node("n1", "8443", "pass-of-a"), "logback.xml": SAMPLE(version, "logback.xml") }, { "nifi.properties": node("n2", "9443", "pass-of-b"), "logback.xml": SAMPLE(version, "logback.xml") });
    const split = splitBody(body, box);
    assert.deepEqual(split.members, body.members, "no bytes changed, so no record did");
    assert.equal(renderFile(split.layers!, A, "nifi.properties", box)!.toString("latin1"), node("n1", "8443", "pass-of-a").toString("latin1"));
    assert.equal(renderFile(split.layers!, B, "nifi.properties", box)!.toString("latin1"), node("n2", "9443", "pass-of-b").toString("latin1"));
    const own = split.layers!.nodes[A]!["nifi.properties"]! as { set: { key: string }[]; unset: string[] };
    assert.deepEqual(own.set.map((v) => v.key).sort(), ["nifi.cluster.node.address", "nifi.security.keystorePasswd", "nifi.web.https.host", "nifi.web.https.port"]);
    const common = template(split, "nifi.properties");
    assert.match(common, /^nifi\.web\.https\.host=$/m, "a key that differs stays at its place, with no node's value");
    assert.match(common, /^nifi\.security\.keystorePasswd=$/m);
    for (const value of ["pass-of-a", "pass-of-b", "n1", "9443"]) assert.ok(!common.split("\n").some((l) => l.endsWith(`=${value}`)));
  }
});

test("a secret that differs is sealed on its own, and the pages get neither it nor a sealed copy", () => {
  const body = cluster({ "nifi.properties": "nifi.security.keystorePasswd=one-s3cret\nnifi.web.https.port=1\nnifi.sensitive.props.key=shared-s3cret\nnifi.security.keyPasswd=\n" }, { "nifi.properties": "nifi.security.keystorePasswd=two-s3cret\nnifi.web.https.port=2\nnifi.sensitive.props.key=shared-s3cret\nnifi.security.keyPasswd=\n" });
  const split = splitBody(body, box);
  const kept = JSON.stringify(split);
  assert.ok(!kept.includes("s3cret"), "kept sealed only, in the members, the template and the node values");
  const set = (split.layers!.nodes[A]!["nifi.properties"]! as { set: Record<string, string>[] }).set;
  assert.equal(box.open(set.find((v) => v.key === "nifi.security.keystorePasswd")!.sealed!), "one-s3cret");
  assert.equal(set.find((v) => v.key === "nifi.web.https.port")!.value, "1");

  const view = withoutSealed(split);
  const shown = JSON.stringify(view);
  assert.ok(!shown.includes("s3cret") && !shown.includes("v1:") && !shown.includes("sealed"), "no value, no seal, no field");
  assert.deepEqual((view.layers!.nodes[A]!["nifi.properties"]! as { set: unknown[] }).set, [{ key: "nifi.security.keystorePasswd", hidden: true }, { key: "nifi.web.https.port", value: "1" }]);
  assert.match(view.layers!.common["nifi.properties"]!.redacted, /nifi\.sensitive\.props\.key=\(hidden\)/);
  assert.equal(bytes(split, 1, "nifi.properties").toString(), "nifi.security.keystorePasswd=two-s3cret\nnifi.web.https.port=2\nnifi.sensitive.props.key=shared-s3cret\nnifi.security.keyPasswd=\n");
});

test("a replace is kept whole and sealed: the pages get its redacted copy only", () => {
  const split = splitBody(cluster({ "authorizers.xml": `<a><property name="Password">one-s3cret</property></a>` }, { "authorizers.xml": `<a><property name="Password">two-s3cret</property></a>` }), box);
  assert.ok(!JSON.stringify(split).includes("s3cret"));
  const view = JSON.stringify(withoutSealed(split));
  assert.ok(view.includes("(hidden)") && !view.includes("s3cret") && !view.includes("v1:") && !view.includes("sealed"));
});

test("XML differing between nodes is a whole-file replace on each; the same XML is common", () => {
  const one = `<a>\n  <b>one</b>\n</a>\n`, two = `<a>\n  <b>two</b>\n</a>\n`, same = "<same/>\n";
  const body = cluster({ "state-management.xml": one, "logback.xml": same }, { "state-management.xml": two, "logback.xml": same });
  const split = splitBody(body, box);
  assert.deepEqual(Object.keys(split.layers!.common), ["logback.xml"]);
  assert.ok("replace" in split.layers!.nodes[A]!["state-management.xml"]! && "replace" in split.layers!.nodes[B]!["state-management.xml"]!);
  assert.deepEqual(split.members, body.members);
});

test("a file only some nodes have is that node's own; the other stays without it", () => {
  const body: ServiceConfigBody = { members: [member("a", { "zookeeper.properties": "a=1\n", "nifi.properties": "x=1\n" }), member("b", { "nifi.properties": "x=1\n" }, ["zookeeper.properties"])] };
  const split = splitBody(body, box);
  assert.deepEqual(Object.keys(split.layers!.common), ["nifi.properties"]);
  assert.ok("replace" in split.layers!.nodes[A]!["zookeeper.properties"]!);
  assert.equal(renderFile(split.layers!, B, "zookeeper.properties", box), null);
  assert.deepEqual(split.members, body.members);
  assert.deepEqual(split.members[1]!.missing, ["zookeeper.properties"]);
});

test("a key some nodes lack: set where it is, removed where the template has it and the node does not", () => {
  const a = "only.a=1\nboth=same\n", b = "both=same\nonly.b=2\n";
  const split = splitBody(cluster({ "nifi.properties": a }, { "nifi.properties": b }), box);
  assert.deepEqual(split.layers!.nodes[A]!["nifi.properties"], { set: [{ key: "only.a", value: "1" }], unset: [] });
  assert.deepEqual(split.layers!.nodes[B]!["nifi.properties"], { set: [{ key: "only.b", value: "2" }], unset: ["only.a"] });
  assert.ok(sameProperties(bytes(split, 0, "nifi.properties"), Buffer.from(a)));
  assert.ok(sameProperties(bytes(split, 1, "nifi.properties"), Buffer.from(b)));
  assert.equal(bytes(split, 0, "nifi.properties").toString(), a, "the first node's file is the template");
});

test("comments and order differing: every node gets the first node's, and NiFi sees the same", () => {
  const a = "# from a\nx=1\ny=2\n", b = "y=2\n# from b\nx=1\n";
  const body = cluster({ "nifi.properties": a }, { "nifi.properties": b });
  const split = splitBody(body, box);
  assert.deepEqual(split.layers!.nodes, { [A]: {}, [B]: {} });
  assert.equal(bytes(split, 1, "nifi.properties").toString(), a);
  assert.notEqual(split.members[1]!.files[0]!.sha256, body.members[1]!.files[0]!.sha256, "this is what a plan shows as differences of format only");
  assert.ok(sameProperties(bytes(split, 1, "nifi.properties"), Buffer.from(b)));
  assert.equal(split.members[1]!.files[0]!.path, "/opt/b/conf/nifi.properties", "it keeps its own path");
});

test("how the value is written is kept: CRLF, ISO-8859-1, UTF-8, escapes, a key with an escape, trailing space", () => {
  const a = "# caf\xe9\r\nlatin=caf\xe9\r\nutf=\xc3\xa9\r\nesc=a\\u00e9\\tb\r\nmy\\ key=one\r\nspace=x \r\n";
  const b = "# caf\xe9\r\nlatin=th\xe9\r\nutf=\xc3\xa8\r\nesc=z\\u00e9\\tb\r\nmy\\ key=two\r\nspace=x\r\n";
  const body = cluster({ "nifi.properties": a }, { "nifi.properties": b });
  const split = splitBody(body, box);
  assert.deepEqual(split.members, body.members, "byte for byte");
  const view = withoutSealed(split).layers!.nodes[A]!["nifi.properties"]! as { set: { key: string; value: string }[] };
  assert.deepEqual(view.set.find((v) => v.key === "utf"), { key: "utf", value: "\u00e9" }, "the page reads it decoded");
  assert.deepEqual(view.set.find((v) => v.key === "latin"), { key: "latin", value: "caf\u00e9" });
});

test("a continued value and a repeated key mean the same after rendering", () => {
  const a = "long=one\\\n   two\nrep=1\nrep=2\nsame=x\\\n  y\n", b = "long=three\nrep=9\nsame=x\\\n  y\n";
  const split = splitBody(cluster({ "nifi.properties": a }, { "nifi.properties": b }), box);
  assert.ok(sameProperties(bytes(split, 0, "nifi.properties"), Buffer.from(a)));
  assert.ok(sameProperties(bytes(split, 1, "nifi.properties"), Buffer.from(b)));
  assert.match(template(split, "nifi.properties"), /same=x\\\n {2}y\n/, "a value all nodes share keeps its lines");
});

test("nodes with different line endings: only format, the template's", () => {
  const a = "x=1\r\ny=a\r\n", b = "x=1\ny=b\n";
  const split = splitBody(cluster({ "nifi.properties": a }, { "nifi.properties": b }), box);
  assert.equal(bytes(split, 1, "nifi.properties").toString(), "x=1\r\ny=b\r\n");
  assert.ok(sameProperties(bytes(split, 1, "nifi.properties"), Buffer.from(b)));
});

test("rendering again from the same layers gives the same files; a split body is not split again", () => {
  const body = cluster({ "nifi.properties": "x=1\ny=a\n" }, { "nifi.properties": "y=b\nx=1\n" });
  const split = splitBody(body, box);
  assert.deepEqual(renderBody(split.members, split.layers!, box).members, split.members);
  assert.equal(splitBody(split, box), split);
  // A kept body survives the database.
  const stored: ServiceConfigBody = JSON.parse(JSON.stringify(split));
  assert.deepEqual(renderBody(stored.members, stored.layers!, box).members, split.members);
});

test("changing the common layer reaches every node, except where a node has its own", () => {
  const split = splitBody(cluster({ "nifi.properties": "# keep\nshared=1\nown=a\n" }, { "nifi.properties": "# keep\nshared=1\nown=b\n" }), box);
  const layers: ConfigLayers = structuredClone(split.layers!);
  const changed = (changes: Parameters<typeof editProperties>[1]) => {
    const opened = openFile(layers.common["nifi.properties"] as ConfigFileRecord, box);
    assert.ok(opened.ok);
    return sealFile({ name: "nifi.properties", path: "", modifiedAt: "" }, editProperties(opened.bytes, changes), box);
  };
  layers.common["nifi.properties"] = changed([{ key: "shared", value: "2" }, { key: "new", value: "n" }]);
  layers.nodes[B]!["nifi.properties"] = { set: [{ key: "own", value: "b" }, { key: "shared", value: "only-b" }], unset: ["new"] };
  const out = renderBody(split.members, layers, box);
  assert.equal(bytes(out, 0, "nifi.properties").toString(), "# keep\nshared=2\nown=a\nnew=n\n");
  assert.equal(bytes(out, 1, "nifi.properties").toString(), "# keep\nshared=only-b\nown=b\n");
  assert.notEqual(out.members[0]!.files[0]!.sha256, split.members[0]!.files[0]!.sha256);
  assert.equal(out.members[0]!.files[0]!.path, "/opt/a/conf/nifi.properties");
  assert.equal(out.members[0]!.files[0]!.modifiedAt, "t");
  // A new value is written the way an edit encodes it.
  assert.equal(encodeValue("k", "caf\u00e9"), "caf\\u00e9");
  assert.equal(writeProperties(Buffer.from("k=1\n"), [{ key: "k", value: encodeValue("k", "caf\u00e9") }]).toString(), "k=caf\\u00e9\n");
});

test("what would not stay one key on one line is refused when rendering", () => {
  const t = Buffer.from("k=1\n");
  assert.throws(() => writeProperties(t, [{ key: "k", value: "1\nother=2" }]), refused("config/bad-value"));
  assert.throws(() => writeProperties(t, [{ key: "k", value: "1\\" }]), refused("config/bad-value"));
  for (const key of ["a b", "a=b", "#a", "a\nb"]) assert.throws(() => writeProperties(t, [{ key, value: "1" }]), refused("config/bad-key"), key);
});

test("layers and members that do not match are refused, not papered over", () => {
  const split = splitBody(cluster({ "nifi.properties": "x=1\ny=a\n", "a.xml": "<a/>" }, { "nifi.properties": "x=1\ny=b\n", "a.xml": "<a/>" }), box);
  const mismatch = (change: (l: ConfigLayers) => void) => {
    const layers: ConfigLayers = structuredClone(split.layers!);
    change(layers);
    assert.throws(() => renderBody(split.members, layers, box), refused("config/layer-mismatch"));
  };
  mismatch((l) => { delete l.common["a.xml"]; });
  mismatch((l) => { l.common["b.xml"] = l.common["a.xml"]!; });
  mismatch((l) => { l.nodes["h:/opt/gone"] = {}; });
  mismatch((l) => { delete l.common["nifi.properties"]; });
});

test("a file that cannot be opened as kept refuses the split: it could not be written back", () => {
  const latin = Buffer.from("x=caf\xe9\n", "latin1");
  const good = sealFile({ name: "nifi.properties", path: "/p", modifiedAt: "t" }, latin, box);
  // As an older version kept it: read as UTF-8 and sealed, which lost the byte.
  const old: ConfigFileRecord = { ...good, sealed: box.seal(latin.toString("utf8")), sealedAs: undefined };
  const body: ServiceConfigBody = { members: [{ host: "h", installDir: "/opt/a", missing: [], files: [old] }, member("b", { "nifi.properties": "x=1\n" })] };
  assert.throws(() => splitBody(body, box), refused("config/reimport"));
  // One kept as UTF-8 before raw bytes were sealed is fine.
  const utf8 = Buffer.from("x=1\ny=a\n");
  const fine: ConfigFileRecord = { ...sealFile({ name: "nifi.properties", path: "/p", modifiedAt: "t" }, utf8, box), sealed: box.seal(utf8.toString("utf8")), sealedAs: undefined };
  const split = splitBody({ members: [{ host: "h", installDir: "/opt/a", missing: [], files: [fine] }, member("b", { "nifi.properties": "x=1\ny=b\n" })] }, box);
  assert.equal(split.members[0]!.files[0], fine);
});

test("a state database from before gets the revision columns, and its revisions still read", () => {
  const dir = mkdtempSync(join(tmpdir(), "layers-"));
  try {
    const path = join(dir, "state.db");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE service_configs (service TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, source TEXT NOT NULL, saved_at TEXT NOT NULL, saved_by TEXT NOT NULL, via TEXT NOT NULL, note TEXT, PRIMARY KEY (service, revision))");
    db.prepare("INSERT INTO service_configs VALUES ('s', 1, ?, 'import', 't', 'a', 'cli', NULL)").run(JSON.stringify({ members: [] }));
    db.close();
    for (let open = 0; open < 2; open++) {
      const store = new Store(path);
      const columns = ((store as any).db.prepare("PRAGMA table_info(service_configs)").all() as { name: string }[]).map((c) => c.name);
      assert.ok(["base", "findings", "review"].every((c) => columns.includes(c)));
      assert.equal(store.serviceConfig("s")!.source, "import");
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
