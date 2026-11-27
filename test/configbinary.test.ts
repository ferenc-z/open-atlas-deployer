// S41 step 4: a key or trust store in a draft. Kept sealed, replaced whole on one node, shown by hash and size only;
// applied to a standalone and a cluster's layers, compared, checked, rolled back (a draft back to the old bytes), and
// named to the executor as needing svc-read@3 / svc-write@2.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { kindsNeeded } from "../src/server/handoff.ts";
import { SecretBox } from "../src/server/secretbox.ts";
import { openFile, sealFile, withoutSealed, type ConfigMember, type ServiceConfigBody } from "../src/server/services/config.ts";
import { acceptChanges, applyChanges, changeSummary, changeView, fileDiffs, outcomeOf, secretSubmitted, type DraftChange } from "../src/server/services/configedit.ts";
import { ConfigDocError } from "../src/server/services/configdoc.ts";
import { installKey } from "../src/server/services/draft.ts";
import { profile } from "../src/server/services/profiles.ts";

const box = new SecretBox(Buffer.alloc(32, 7).toString("base64"));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
// Bytes that are no UTF-8 (a JKS starts FE ED FE ED), so nothing may read them as text.
const store = (seed: number) => Buffer.concat([Buffer.from([0xfe, 0xed, 0xfe, 0xed, 0x00, 0xff, seed]), randomBytes(600)]);
const props = Buffer.from("nifi.security.keystore=./conf/keystore.jks\nnifi.security.keystorePasswd=s3cret\n");

const member = (host: string, keystore: Buffer): ConfigMember => ({
  host, installDir: "/opt/nifi", confDir: "/opt/nifi/conf", missing: [],
  files: [
    sealFile({ name: "nifi.properties", path: "/opt/nifi/conf/nifi.properties", modifiedAt: "" }, props, box),
    sealFile({ name: "keystore", path: "/opt/nifi/conf/keystore.jks", modifiedAt: "" }, keystore, box),
  ],
});
const fileOf = (body: ServiceConfigBody, host: string, name: string) => body.members.find((m) => m.host === host)!.files.find((f) => f.name === name)!;
const bytesOf = (body: ServiceConfigBody, host: string, name: string) => { const o = openFile(fileOf(body, host, name), box); assert.ok(o.ok); return o.bytes; };

test("a store is kept as binary: sealed whole, no redacted text, shown by hash and size", () => {
  const ks = store(1);
  const rec = sealFile({ name: "keystore", path: "/opt/nifi/conf/keystore.jks", modifiedAt: "" }, ks, box);
  assert.equal(rec.format, "binary");
  assert.equal(rec.redacted, "");
  assert.deepEqual(rec.secrets, []);
  assert.equal(rec.sha256, sha(ks));
  const o = openFile(rec, box);
  assert.ok(o.ok && o.bytes.equals(ks), "the bytes come back as they were");
  assert.ok(!JSON.stringify(withoutSealed({ members: [member("a", ks)] })).includes(ks.subarray(7, 40).toString("base64")), "the page's view holds no bytes");
});

test("a standalone: the store is replaced whole, the diff names hashes and sizes, the summary no bytes; back again is a rollback", () => {
  const old = store(1), next = store(2);
  const base: ServiceConfigBody = { members: [member("a", old)] };
  const m = installKey(base.members[0]!);
  const changes = acceptChanges([{ file: "keystore", member: m, base64: next.toString("base64") }], base, "standalone", box);
  assert.equal(changes.length, 1);
  const c = changes[0]! as Extract<DraftChange, { binary: string }>;
  assert.equal(c.sha256, sha(next));
  assert.equal(c.size, next.length);
  assert.ok(!c.binary.includes(next.toString("base64").slice(0, 40)), "sealed in the draft");
  assert.deepEqual(changeView(c, box), { file: "keystore", member: m, binary: { sha256: sha(next), size: next.length } });
  assert.deepEqual(changeSummary(c), { file: "keystore", member: m, op: "binary", sha256: sha(next), size: next.length });

  const { body } = applyChanges(base, "standalone", changes, box);
  assert.ok(bytesOf(body, "a", "keystore").equals(next));
  assert.equal(fileOf(body, "a", "nifi.properties").sha256, fileOf(base, "a", "nifi.properties").sha256, "the other files stay");

  const diffs = fileDiffs(base.members, body.members, box);
  assert.equal(diffs.length, 1);
  const d = diffs[0]!.files[0]!;
  assert.equal(d.name, "keystore");
  assert.equal(d.change, "content");
  assert.deepEqual(d.secretsChanged, []);
  assert.match(d.diff, new RegExp(`^- \\(binary, ${old.length} bytes, sha256 ${sha(old)}\\)\\n\\+ \\(binary, ${next.length} bytes, sha256 ${sha(next)}\\)$`));

  // Sent back as the page got it, the change is kept without its bytes.
  const again = acceptChanges([changeView(c, box)], base, "standalone", box, changes);
  assert.deepEqual(again, changes);

  // Rolled back: a draft on the new revision with the old bytes gives the old file again.
  const back = applyChanges(body, "standalone", acceptChanges([{ file: "keystore", member: m, base64: old.toString("base64") }], body, "standalone", box), box).body;
  assert.equal(fileOf(back, "a", "keystore").sha256, sha(old));
  assert.ok(bytesOf(back, "a", "keystore").equals(old));
});

test("what cannot be made is refused: no member, a store as text or key, bad base64, a text file as binary; the AI cannot bring one", () => {
  const base: ServiceConfigBody = { members: [member("a", store(1))] };
  const m = installKey(base.members[0]!);
  const refused = (raw: unknown, code: string) => assert.throws(() => acceptChanges([raw], base, "standalone", box), (e: ConfigDocError) => e.code === code);
  refused({ file: "keystore", member: null, base64: store(2).toString("base64") }, "config/bad-change");
  refused({ file: "keystore", member: m, text: "x" }, "config/bad-change");
  refused({ file: "keystore", member: m, key: "a", value: "b" }, "config/bad-change");
  refused({ file: "keystore", member: m, base64: "not base64!" }, "config/bad-change");
  refused({ file: "keystore", member: m, base64: "" }, "config/bad-change");
  refused({ file: "keystore", member: m, sha256: "0".repeat(64) }, "config/bad-change");
  refused({ file: "nifi.properties", member: m, base64: "AAAA" }, "config/not-editable");
  assert.equal(secretSubmitted([{ file: "keystore", member: m, base64: "AAAA" }]), "keystore");
});

test("a cluster: each node's store is its own; a node's new one replaces only its copy, and the check says restart", () => {
  const a = store(1), b = store(3), next = store(4);
  const base: ServiceConfigBody = { members: [member("a", a), member("b", b)] };
  const mb = installKey(base.members[1]!);
  const changes = acceptChanges([{ file: "keystore", member: mb, base64: next.toString("base64") }], base, "cluster", box);
  const out = outcomeOf(base, changes, box, { profile: profile("nifi-2.x"), version: "2.5.0", kind: "cluster" });
  assert.ok(out.split, "the first edit splits the revision");
  assert.ok(bytesOf(out.body, "a", "keystore").equals(a), "node a keeps its store");
  assert.ok(bytesOf(out.body, "b", "keystore").equals(next));
  assert.ok("replace" in out.body.layers!.nodes[mb]!.keystore!);
  const files = out.change!.members.flatMap((x) => x.files.map((f) => ({ member: x.member, ...f })));
  assert.deepEqual(files.map((f) => [f.member, f.name, f.restart]), [[mb, "keystore", true]]);
  assert.equal(out.change!.mode, "rolling");
  assert.ok(!out.findings.some((f) => f.severity === "error"), JSON.stringify(out.findings));

  // The same store on both nodes sits in the common layer; replacing it on one node gives that node its own.
  const same: ServiceConfigBody = { members: [member("a", a), member("b", a)] };
  const one = applyChanges(same, "cluster", acceptChanges([{ file: "keystore", member: mb, base64: next.toString("base64") }], same, "cluster", box), box);
  assert.ok(one.body.layers!.common.keystore, "kept in common");
  assert.ok(bytesOf(one.body, "a", "keystore").equals(a));
  assert.ok(bytesOf(one.body, "b", "keystore").equals(next));
  // Back to the common bytes: the node's own copy goes away again.
  const back = applyChanges(one.body, "cluster", acceptChanges([{ file: "keystore", member: mb, base64: a.toString("base64") }], one.body, "cluster", box), box);
  assert.equal(back.body.layers!.nodes[mb]?.keystore, undefined);
  assert.ok(bytesOf(back.body, "b", "keystore").equals(a));
});

test("the executor is asked for svc-read@3 and svc-write@2 only when a store is among the files", () => {
  assert.deepEqual(kindsNeeded({ kind: "svc-read", installDir: "/opt/nifi", files: ["nifi.properties"] }), ["svc-read"]);
  assert.deepEqual(kindsNeeded({ kind: "svc-read", installDir: "/opt/nifi", files: ["nifi.properties", "truststore"] }), ["svc-read", "svc-read@3"]);
  assert.deepEqual(kindsNeeded({ kind: "svc-write", action: "apply", files: [{ name: "nifi.properties" }] }), ["svc-write", "svc-write@1"]);
  assert.deepEqual(kindsNeeded({ kind: "svc-write", action: "apply", files: [{ name: "keystore" }] }), ["svc-write", "svc-write@1", "svc-write@2"]);
});
