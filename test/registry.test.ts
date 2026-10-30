import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateManifest } from "../src/manifest/validate.ts";
import { compareVersions, covering } from "../src/manifest/version.ts";
import { Store, StoreError } from "../src/server/store.ts";

const INITIAL = fileURLToPath(new URL("../../open-atlas-docs/docs/proposals/deploy-manifests/", import.meta.url));
const cli = { id: "test", via: "cli" } as const;

const shop = (over: Record<string, unknown> = {}) => ({
  v: 1, app: "shop", appliesFrom: "1.0.0",
  release: { repo: "acme/shop", tag: "v{version}", manifest: "package.json" },
  components: [{ id: "web", type: "compose-service", service: "shop", source: { kind: "public-registry", image: "nginx:1.27.0" }, ports: [{ container: 80, host: 18080 }] }],
  ...over,
});

test("the four initial manifests are valid v1", () => {
  let dir: string[];
  try { dir = readdirSync(INITIAL); } catch { return; } // open-atlas-docs is not checked out beside this repository
  for (const f of dir.filter((x) => x.endsWith(".json"))) assert.deepEqual(validateManifest(JSON.parse(readFileSync(join(INITIAL, f), "utf8"))), [], f);
});

test("rejects what the schema and the cross-component rules forbid", () => {
  assert.match(validateManifest(shop({ components: [{ id: "web", type: "compose-service", service: "shop", source: { kind: "public-registry", image: "nginx:latest" } }] })).join(), /does not match/);
  assert.match(validateManifest(shop({ extra: true })).join(), /unknown key extra/);
  assert.match(validateManifest(shop({ appliesFrom: undefined })).join(), /appliesFrom/);
  const cycle = shop({ components: [
    { id: "a", type: "manual", steps: ["x"], dependsOn: ["b"] },
    { id: "b", type: "manual", steps: ["y"], dependsOn: ["a"] },
  ] });
  assert.match(validateManifest(cycle).join(), /cycle/);
});

test("versions compare as semver and a manifest covers up to the next appliesFrom", () => {
  assert.ok(compareVersions("1.10.0", "1.9.9") > 0);
  assert.ok(compareVersions("2.0.0-beta.2", "2.0.0") < 0);
  assert.ok(compareVersions("2.0.0-beta.10", "2.0.0-beta.9") > 0);
  const ms = [{ appliesFrom: "1.0.0" }, { appliesFrom: "1.5.0" }, { appliesFrom: "2.0.0" }];
  assert.equal(covering(ms, "1.4.9")?.appliesFrom, "1.0.0");
  assert.equal(covering(ms, "1.5.0")?.appliesFrom, "1.5.0");
  assert.equal(covering(ms, "3.1.0")?.appliesFrom, "2.0.0");
  assert.equal(covering(ms, "0.9.0"), undefined);
});

test("the first manifest registers the app; later saves add revisions and ranges", () => {
  const store = new Store(":memory:");
  assert.deepEqual(store.saveManifest(shop(), cli, { name: "Shop" }), { app: "shop", appliesFrom: "1.0.0", revision: 1 });
  assert.equal(store.saveManifest(shop(), cli).revision, 2);
  store.saveManifest(shop({ appliesFrom: "2.0.0" }), cli);
  const app = store.app("shop")!;
  assert.equal(app.name, "Shop");
  assert.equal(app.repo, "acme/shop");
  assert.equal(app.manifests.length, 3);
  assert.deepEqual(store.manifests("shop").map((m) => m.appliesFrom), ["1.0.0", "2.0.0"]);
  assert.deepEqual(store.listAudit().map((e) => e.action), ["manifest.save", "manifest.save", "app.register"]);
});

test("refuses invalid manifests, a changed repo, and clashes with other apps", () => {
  const store = new Store(":memory:");
  store.saveManifest(shop(), cli);
  const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as StoreError).code; } return "saved"; };
  assert.equal(code(() => store.saveManifest({ v: 1 }, cli)), "manifest/invalid");
  assert.equal(code(() => store.saveManifest(shop({ release: { repo: "evil/shop", tag: "v{version}", manifest: "package.json" } }), cli)), "manifest/repo-changed");
  const blog = shop({ app: "blog", release: { repo: "acme/blog", tag: "v{version}", manifest: "package.json" } });
  assert.equal(code(() => store.saveManifest(blog, cli)), "manifest/conflict");
  assert.equal(store.app("blog"), undefined);
});

test("a removed app leaves the registry and can be registered again", () => {
  const store = new Store(":memory:");
  store.saveManifest(shop(), cli);
  store.removeApp("shop", cli);
  assert.equal(store.app("shop"), undefined);
  assert.deepEqual(store.listApps(), []);
  assert.equal(store.saveManifest(shop(), cli).revision, 2);
});
