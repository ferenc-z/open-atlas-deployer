// Env files (phase 3): reading and writing them as compose does, .env.example as the expected keys,
// the checks, and sealing secrets.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Manifest } from "../src/compose/generate.ts";
import { affectedServices, changedKeys, checkEnv, parseEnv, parseExample, quote, referencedKeys, serializeEnv } from "../src/env/dotenv.ts";
import { fingerprint, SecretBox } from "../src/server/secretbox.ts";

test("parses env files the way compose reads them", () => {
  const { values, errors } = parseEnv([
    "# comment",
    "PLAIN=abc",
    "SPACED = hello world   # trailing comment",
    "HASH=a#b",
    "export EXPORTED=1",
    "SINGLE='a $literal # not a comment'",
    'DOUBLE="line\\none \\"q\\" \\$HOME"',
    'MULTI="first',
    'second"',
    "EMPTY=",
    "LOGBOOK_ADMIN_NAME=\"Jack Gao\"",
    "not a line",
  ].join("\r\n"));
  assert.deepEqual(values, {
    PLAIN: "abc", SPACED: "hello world", HASH: "a#b", EXPORTED: "1", SINGLE: "a $literal # not a comment",
    DOUBLE: 'line\none "q" $HOME', MULTI: "first\nsecond", EMPTY: "", LOGBOOK_ADMIN_NAME: "Jack Gao",
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /第 12 行/);
});

test("writes values back so they read the same", () => {
  const values = { A: "plain-1.2:3/x@y", B: "with space", C: "it's $5 \"quoted\"\nnext", D: "", E: "a#b", F: "${NOT_INTERPOLATED}" };
  const text = serializeEnv(values, "Written by test\nsecond line", ["E", "A"]);
  assert.match(text, /^# Written by test\n# second line\nE='a#b'\nA=plain-1.2:3\/x@y\n/);
  assert.equal(quote("x y"), "'x y'");
  assert.deepEqual(parseEnv(text).values, values);
});

test("reads .env.example: set keys are expected, commented keys are known optional ones", () => {
  const keys = parseExample([
    "# Paperless",
    "PAPERLESS_URL=https://dossier.example.com",
    "#PAPERLESS_MEDIA_PATH=        # the documents themselves",
    "LOGBOOK_ADMIN_NAME=\"Jack Gao\"",
    "",
    "# Fixed in the image, do not set: OPEN_ATLAS_STUDIO_HOME",
    "# SSO",
    "#OIDC_CLIENT_ID=",
  ].join("\n"));
  assert.deepEqual(keys, [
    { key: "PAPERLESS_URL", required: true, example: "https://dossier.example.com", comment: "Paperless" },
    { key: "PAPERLESS_MEDIA_PATH", required: false, example: "", comment: "the documents themselves" },
    { key: "LOGBOOK_ADMIN_NAME", required: true, example: "Jack Gao", comment: "Paperless" },
    { key: "OIDC_CLIENT_ID", required: false, example: "", comment: "Fixed in the image, do not set: OPEN_ATLAS_STUDIO_HOME SSO" },
  ]);
});

const manifest = {
  v: 1, app: "shop", appliesFrom: "1.0.0", env: { file: "shop.env", secrets: ["DB_PASSWORD"] },
  components: [
    { id: "web", type: "compose-service", service: "shop", source: { kind: "public-registry", image: "nginx:1.27.0" }, envFile: true },
    { id: "worker", type: "compose-service", service: "shop-worker", source: { kind: "public-registry", image: "nginx:1.27.0" },
      environment: { GREETING: "${GREETING}", LEVEL: "${LOG_LEVEL:-info}", DB: "postgres://app:${DB_PASSWORD:?set it}@db/app" } },
    { id: "cache", type: "compose-service", service: "shop-cache", source: { kind: "public-registry", image: "redis:7.4.1" } },
  ],
} as unknown as Manifest;

test("finds the keys a fragment needs and the services a change restarts", () => {
  assert.deepEqual(referencedKeys(manifest), { required: ["DB_PASSWORD", "GREETING"], optional: ["LOG_LEVEL"] });
  assert.deepEqual(affectedServices(manifest, ["GREETING"]), ["shop", "shop-worker"]);
  assert.deepEqual(affectedServices(manifest, ["UNRELATED"]), ["shop"]);
  assert.deepEqual(affectedServices(manifest, ["GREET"]), ["shop"], "a key that is a prefix of another does not match");
});

test("checks values: an unset referenced key blocks, the rest are shown, a likely rename is named", () => {
  const example = parseExample("GREETING=hi\nDB_PASSWORD=\nPAPERLESS_DBPASS=\n#OPTIONAL_THING=\n");
  const findings = checkEnv(["DB_PASSWORD", "PAPERLESS_DB_PASS", "EXTRA"], example, referencedKeys(manifest));
  assert.deepEqual(findings.map((f) => [f.code, f.key, f.blocking]), [
    ["env/referenced-missing", "GREETING", true],
    ["env/missing", "PAPERLESS_DBPASS", false],
    ["env/renamed", "PAPERLESS_DB_PASS", false],
    ["env/unknown", "EXTRA", false],
  ]);
  assert.equal(findings[2]!.suggestion, "PAPERLESS_DBPASS");
  assert.deepEqual(checkEnv(["GREETING", "DB_PASSWORD"], null, referencedKeys(manifest)), []);
});

test("names changed keys without their values", () => {
  assert.deepEqual(changedKeys({ A: "1", S: "x", GONE: "g" }, { A: "2", S: "y", NEW: "n" }, ["S"]), [
    { key: "A", change: "changed", secret: false },
    { key: "GONE", change: "removed", secret: false },
    { key: "NEW", change: "added", secret: false },
    { key: "S", change: "changed", secret: true },
  ]);
});

test("seals secrets with AES-256-GCM and refuses tampered or foreign values", () => {
  const box = new SecretBox(Buffer.alloc(32, 1).toString("base64"));
  const sealed = box.seal("p@ss wörd");
  assert.notEqual(box.seal("p@ss wörd"), sealed, "a fresh IV each time");
  assert.equal(box.open(sealed), "p@ss wörd");
  const raw = Buffer.from(sealed.slice(3), "base64");
  raw[raw.length - 1]! ^= 1;
  assert.throws(() => box.open(`v1:${raw.toString("base64")}`));
  assert.throws(() => new SecretBox(Buffer.alloc(32, 2).toString("base64")).open(sealed));
  assert.throws(() => new SecretBox("short"), /32 bytes/);
  assert.equal(fingerprint("k", "shop", "S", "v"), fingerprint("k", "shop", "S", "v"));
  assert.notEqual(fingerprint("k", "shop", "S", "v"), fingerprint("other", "shop", "S", "v"));
});
