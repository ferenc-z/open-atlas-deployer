// Phase 5 pieces on their own: reading a bundle, contract ranges, and the order a deploy runs its components in.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { Bundles } from "../src/server/bundle.ts";
import { checkContracts, satisfies } from "../src/server/contracts.ts";
import { fill } from "../src/server/drivers/types.ts";
import { hostAfterOthers, order } from "../src/server/rollout.ts";
import { readTarGz, stripTop, TarError } from "../src/server/tar.ts";
import { fakeServices, fakeState, sha256, tarGz } from "./fakes.ts";

test("a bundle is read without its top directory and checked against its SHA256SUMS", async () => {
  const s = fakeState();
  const files = { "app/app.json": "{}", "pkg/db/01.sql": "select 1;" };
  // A SHA256SUMS written while it was being generated lists itself; that line is skipped.
  s.assets["acme/book@v1.0.0/book-1.0.0.tar.gz"] = tarGz({ ...files, SHA256SUMS: Object.entries(files).map(([p, c]) => `${sha256(c)}  ${p}`).join("\n") + `\n${sha256("")}  SHA256SUMS\n` });
  s.assets["acme/book@v1.0.1/book-1.0.1.tar.gz"] = tarGz({ ...files, SHA256SUMS: `${sha256("other")}  app/app.json\n` });
  const bundles = new Bundles(mkdtempSync(join(tmpdir(), "bundles-")), undefined, fakeServices(s), "https://api.github.test");
  const b = await bundles.get("acme/book", "v1.0.0", "book-1.0.0.tar.gz");
  assert.equal(b.checked, 2);
  assert.deepEqual([...b.files.keys()].sort(), ["SHA256SUMS", "app/app.json", "pkg/db/01.sql"]);
  assert.equal(b.digest, `sha256:${sha256(s.assets["acme/book@v1.0.0/book-1.0.0.tar.gz"]!)}`);
  await assert.rejects(bundles.get("acme/book", "v1.0.1", "book-1.0.1.tar.gz"), /app\/app.json 与 SHA256SUMS 不符/);
  await assert.rejects(bundles.get("acme/book", "v2.0.0", "book-2.0.0.tar.gz"), /没有 v2.0.0 的 Release/);
  const calls = s.calls.length;
  await bundles.get("acme/book", "v1.0.0", "book-1.0.0.tar.gz");
  assert.equal(s.calls.length, calls, "downloaded once");
});

test("a bundle may not hold links or paths that climb out", () => {
  const header = Buffer.alloc(512);
  header.write("../evil", 0);
  header.write("00000000000\0", 124);
  header.write("0", 156);
  assert.throws(() => readTarGz(gzipSync(Buffer.concat([header, Buffer.alloc(1024)]))), TarError);
  const link = Buffer.alloc(512);
  link.write("pkg/link", 0);
  link.write("00000000000\0", 124);
  link.write("2", 156);
  assert.throws(() => readTarGz(gzipSync(Buffer.concat([link, Buffer.alloc(1024)]))), /不是普通文件/);
  assert.deepEqual([...stripTop(new Map([["a.txt", Buffer.from("")], ["b/c", Buffer.from("")]])).keys()], ["a.txt", "b/c"], "no single top directory, nothing stripped");
});

test("contract ranges as release.json writes them", () => {
  assert.ok(satisfies("1.5", "^1.3"));
  assert.ok(!satisfies("1.2", "^1.3"));
  assert.ok(!satisfies("2.0", "^1.3"));
  assert.ok(satisfies("2.0.0", "^2.0"));
  assert.ok(satisfies("1.7", "^1.0"));
  assert.ok(satisfies("1.3.4", "~1.3"));
  assert.ok(!satisfies("1.4", "~1.3"));
  assert.ok(satisfies("1", "1"));
  assert.ok(satisfies("1.5", "1"));
  assert.ok(!satisfies("1.5", "1.4"));
  assert.ok(satisfies("3.1", ">=2.9"));
});

test("the contract check names both apps and the contract, both ways", () => {
  const book = { provides: { book: "1" }, requires: { "workbench-app": "^1.3", "data-plane-api": "^1.0" } };
  const ok = checkContracts("book", "1.0.0", book, [
    { app: "workbench", version: "1.24.0", doc: { provides: { "workbench-app": "1.5" }, requires: { "data-plane-api": "^1.0" } } },
    { app: "studio", version: "2.8.0", doc: { provides: { "data-plane-api": "1.7" }, requires: {} } },
  ]);
  assert.deepEqual(ok, { unmet: [], unknown: [] });
  const old = checkContracts("book", "1.0.0", book, [{ app: "workbench", version: "1.2.0", doc: { provides: { "workbench-app": "1.2" }, requires: {} } }]);
  assert.deepEqual(old.unmet, ["book 1.0.0 要求 workbench-app ^1.3，workbench 1.2.0 提供的是 1.2"]);
  assert.match(old.unknown[0]!, /要求 data-plane-api \^1.0，这个环境里没有登记提供它的应用/);
  const studio = checkContracts("studio", "3.0.0", { provides: { "data-plane-api": "2.0" }, requires: {} }, [{ app: "book", version: "1.0.0", doc: book }]);
  assert.deepEqual(studio.unmet, ["book 1.0.0 要求 data-plane-api ^1.0，studio 3.0.0 提供的是 2.0"]);
});

test("components run in dependsOn order; executor parts cannot wait for the Deployer's", () => {
  const c = [
    { id: "assistant", type: "oma-agent", dependsOn: ["ui", "graph"] },
    { id: "ui", type: "workbench-app", dependsOn: ["api"] },
    { id: "graph", type: "studio-graph", dependsOn: ["api"] },
    { id: "api", type: "compose-service", dependsOn: ["db"] },
    { id: "db", type: "compose-service" },
  ];
  assert.deepEqual(order(c).map((x) => x.id), ["db", "api", "ui", "graph", "assistant"]);
  assert.deepEqual(hostAfterOthers(c), []);
  assert.deepEqual(hostAfterOthers([...c, { id: "late", type: "compose-service", dependsOn: ["ui"] }]), ["late"]);
});

test("placeholders are filled, and the missing ones named", () => {
  assert.deepEqual(fill("{{model}} at {{ url }}", { model: "m1", url: "https://x" }), { text: "m1 at https://x", missing: [] });
  assert.deepEqual(fill("{{model}} {{graph}}", { model: "m" }).missing, ["graph"]);
});
