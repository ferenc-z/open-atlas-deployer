import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { importFile, type ServiceConfigBody } from "../src/server/services/config.ts";
import { configView, parseProperties } from "../src/server/services/configview.ts";
import type { DraftStandalone } from "../src/server/services/draft.ts";
import { catalogEntry, profile, sectionOf } from "../src/server/services/profiles.ts";
import { serviceStatus } from "../src/server/services/status.ts";
import { SecretBox } from "../src/server/secretbox.ts";
import { Store } from "../src/server/store.ts";

const box = new SecretBox(randomBytes(32).toString("base64"));
const file = (name: string, text: string) =>
  importFile({ name, path: `/opt/x/conf/${name}`, sha256: createHash("sha256").update(text).digest("hex"), size: text.length, modifiedAt: "2026-11-05T00:00:00Z", content: Buffer.from(text).toString("base64") }, box);
const member = (host: string, props: string, more: ReturnType<typeof file>[] = []) => ({ host, installDir: "/opt/x", files: [file("nifi.properties", props), ...more], missing: [] });

test("properties files parse into key, value and line; comments and blank lines are not keys", () => {
  assert.deepEqual(parseProperties("# web properties #\nnifi.web.https.port=8443\r\n\n! old\nnifi.a : b c \nnifi.empty=\n"), [
    { key: "nifi.web.https.port", value: "8443", line: 2 }, { key: "nifi.a", value: "b c", line: 5 }, { key: "nifi.empty", value: "", line: 6 },
  ]);
});

test("catalog keys have a section and a description; a key the catalog lacks goes under Other", () => {
  const prof = profile("nifi-2.x")!;
  assert.equal(catalogEntry(prof, "nifi.web.https.port")!.section, "Web and HTTPS");
  assert.equal(catalogEntry(prof, "nifi.zookeeper.connect.string")!.section, "ZooKeeper and state");
  assert.equal(catalogEntry(prof, "java.arg.3", "bootstrap.conf")!.section, "JVM and bootstrap");
  assert.ok(prof.catalog.every((e) => e.description), "every catalog key is described");
  assert.equal(sectionOf("nifi.flowfile.repository.directory", "nifi.properties"), "Repositories");
  const body: ServiceConfigBody = { members: [member("h", "nifi.web.https.port=8443\nnifi.web.https.host=nifi1\nnifi.sensitive.props.key=s3cret\nnifi.ui.banner.text=\nnifi.python.command=python3\n")] };
  const view = configView(body, "nifi-2.x", "2.5.0", "standalone");
  assert.equal(view.compare, null, "a standalone instance has no node comparison");
  assert.deepEqual(view.rows[0]!.files["nifi.properties"]!.map((r) => [r.key, r.section, r.status]), [
    ["nifi.web.https.port", "Web and HTTPS", "default"],
    ["nifi.web.https.host", "Web and HTTPS", "changed"],
    ["nifi.sensitive.props.key", "Security", "hidden"],
    ["nifi.ui.banner.text", "Other", "unknown"],
    ["nifi.python.command", "Python", "changed"],
  ]);
  assert.ok(view.catalog.some((e) => e.key === "nifi.web.https.port" && e.default === "8443" && e.description));
  assert.equal(view.sections.at(-1), "Other");
});

test("a cluster's files are compared node by node: differences first by severity, secrets only as labels", () => {
  const xml = (t: string) => file("state-management.xml", `<stateManagement>${t}</stateManagement>`);
  const body: ServiceConfigBody = { members: [
    member("h1", "nifi.cluster.is.node=true\nnifi.cluster.node.address=node1\nnifi.sensitive.props.key=aaa\nnifi.web.https.port=8443\nnifi.extra=1\n", [xml("a")]),
    member("h2", "nifi.cluster.is.node=true\nnifi.cluster.node.address=node2\nnifi.sensitive.props.key=bbb\nnifi.web.https.port=8443\nnifi.zookeeper.root.node=/nifi\n", [xml("b")]),
  ] };
  const view = configView(body, "nifi-2.x", "2.5.0", "cluster", (s) => box.open(s));
  const props = view.compare!.find((f) => f.name === "nifi.properties")!;
  assert.deepEqual(props.rows.map((r) => [r.key, r.severity]), [
    ["nifi.sensitive.props.key", "error"],
    ["nifi.extra", "warning"],
    ["nifi.cluster.node.address", "info"],
    ["nifi.cluster.is.node", null],
    ["nifi.web.https.port", null],
    ["nifi.zookeeper.root.node", null],
  ]);
  assert.equal(props.differing, 3);
  assert.deepEqual(props.rows[0]!.values.map((v) => v.value), ["value A", "value B"], "never the secret");
  assert.ok(!JSON.stringify(view).includes("aaa") && !JSON.stringify(view).includes("bbb"));
  assert.deepEqual(props.rows.find((r) => r.key === "nifi.zookeeper.root.node")!.values, [{ value: "/nifi", from: "default" }, { value: "/nifi", from: "file" }], "left out = the default, the same");
  assert.deepEqual(props.rows.find((r) => r.key === "nifi.extra")!.values.map((v) => v.from), ["file", "unset"]);
  const sm = view.compare!.find((f) => f.name === "state-management.xml")!;
  assert.deepEqual([sm.format, sm.identical, sm.rows.length], ["xml", false, 0]);

  // Without the key to open the sealed copies, equal-looking secrets are not called different.
  const blind = configView(body, "nifi-2.x", "2.5.0", "cluster").compare!.find((f) => f.name === "nifi.properties")!;
  assert.equal(blind.rows.find((r) => r.key === "nifi.sensitive.props.key")!.severity, null);
});

test("a registered service's status carries its takeover findings and a timeline", () => {
  const store = new Store(":memory:");
  const actor = { id: "admin", via: "cli" } as const;
  const item: DraftStandalone = { kind: "standalone", id: "n112", service: "nifi", profile: "nifi-1.x", version: "1.12.1", webUrl: null,
    member: { host: "local", installDir: "/opt/n112", serviceUser: "nifi", startEnvironment: null, ports: { https: 8443 }, discovery: null },
    findings: [{ severity: "warning", code: "autostart/none", message: "no unit" }, { severity: "info", code: "not-running", message: "stopped" }] };
  const draft = store.createServiceDraft("uat", [], [item], actor);
  store.addStandalone(item, "uat", actor, draft.id);
  const s = serviceStatus(store, () => ({ online: false }) as never, "n112")!;
  assert.deepEqual(s.findings.map((f) => f.code), ["autostart/none", "not-running"]);
  assert.deepEqual(s.summary.findings, { error: 0, warning: 1, info: 1 });
  assert.equal(s.summary.differences, 0);
  assert.deepEqual(s.events.map((e) => e.kind), ["taken-over"]);
  store.close();
});
