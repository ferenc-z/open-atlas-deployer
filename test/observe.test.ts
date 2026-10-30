import assert from "node:assert/strict";
import { test } from "node:test";
import type { Environment, Manifest } from "../src/compose/generate.ts";
import { environmentStatus, Observer, parseDockerPs, type HostState } from "../src/server/observe.ts";

const env: Environment = { name: "uat", project: "open-atlas", bindIp: "127.0.0.1", registries: { ghcr: "ghcr.io/acme" }, apps: { shop: { version: "1.2.0" } } };

const shop: Manifest = {
  v: 1, app: "shop", appliesFrom: "1.0.0",
  components: [
    { id: "db", type: "compose-service", service: "shop-db", source: { kind: "public-registry", image: "postgres:16.4" }, ports: [{ container: 5432 }] },
    { id: "web", type: "compose-service", service: "shop", dependsOn: ["db"], source: { kind: "company-registry", registry: "ghcr", image: "shop" }, ports: [{ container: 9631 }, { container: 9632 }] },
    { id: "ui", type: "workbench-app" },
  ],
};

const line = (service: string, state: string, status: string, labels: Record<string, string> = {}) => JSON.stringify({
  Names: `open-atlas-${service}-1`, Image: `img/${service}`, State: state, Status: status,
  Labels: Object.entries({ "com.docker.compose.project": "open-atlas", "com.docker.compose.service": service, ...labels }).map(([k, v]) => `${k}=${v}`).join(","),
});

test("parses docker ps JSON lines, labels and health", () => {
  const [c] = parseDockerPs(line("shop", "running", "Up 2 hours (healthy)", { "org.open-atlas.version": "1.2.0" }) + "\n");
  assert.equal(c!.service, "shop");
  assert.equal(c!.health, "healthy");
  assert.equal(c!.labels["org.open-atlas.version"], "1.2.0");
  assert.equal(parseDockerPs(line("x", "running", "Up 1 minute (health: starting)"))[0]!.health, "starting");
  assert.equal(parseDockerPs(line("x", "running", "Up 1 minute"))[0]!.health, undefined);
});

test("asks only own-built services for BUILD.json, trying each port", async () => {
  const asked: string[] = [];
  const fetcher = (async (input: URL | string) => {
    asked.push(String(input));
    if (String(input).includes(":9631")) return new Response("<html>", { status: 200 });
    return Response.json({ version: "1.1.0", commit: "abc", provides: { "data-plane": "1.4" } });
  }) as typeof fetch;
  const observer = new Observer({}, fetcher);
  assert.equal(await observer.observe(shop.components[0]!), undefined);
  assert.deepEqual(await observer.observe(shop.components[1]!), { kind: "build", version: "1.1.0", commit: "abc", provides: { "data-plane": "1.4" } });
  assert.deepEqual(asked, ["http://shop:9631/meta/contracts", "http://shop:9632/meta/contracts"]);
  await observer.observe(shop.components[1]!);
  assert.equal(asked.length, 2, "cached");
});

test("judges each component against the desired version", async () => {
  const unreachable = new Observer({}, (async () => { throw new TypeError("no"); }) as typeof fetch);
  const host: HostState = { at: "2026-10-30T00:00:00Z", stale: false, containers: parseDockerPs([
    line("shop-db", "running", "Up 1 hour"),
    line("shop", "running", "Up 1 hour (healthy)", { "org.open-atlas.version": "1.1.0" }),
    line("legacy", "running", "Up 9 days"),
  ].join("\n")) };
  const status = await environmentStatus(env, [{ id: "shop", name: "Shop", manifests: [shop] }], host, unreachable);
  const [app] = status.apps;
  assert.deepEqual(app!.components.map((c) => [c.id, c.verdict]), [["db", "ok"], ["web", "drift"], ["ui", "not-a-service"]]);
  assert.equal(app!.verdict, "drift");
  assert.deepEqual(status.unmanaged.map((c) => c.service), ["legacy"]);

  const down = { ...host, containers: parseDockerPs(line("shop-db", "exited", "Exited (1) 2 minutes ago")) };
  const second = await environmentStatus(env, [{ id: "shop", name: "Shop", manifests: [shop] }], down, unreachable);
  assert.deepEqual(second.apps[0]!.components.map((c) => c.verdict), ["down", "missing", "not-a-service"]);
  assert.equal(second.apps[0]!.verdict, "down");
});

test("without host state, a self-reported version still shows drift", async () => {
  const observer = new Observer({}, (async () => Response.json({ version: "1.0.0" })) as typeof fetch);
  const status = await environmentStatus(env, [{ id: "shop", name: "Shop", manifests: [shop] }], undefined, observer);
  assert.equal(status.host, undefined);
  assert.deepEqual(status.apps[0]!.components.map((c) => c.verdict), ["unknown", "drift", "not-a-service"]);
});
