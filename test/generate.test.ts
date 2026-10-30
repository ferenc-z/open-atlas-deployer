import assert from "node:assert/strict";
import { test } from "node:test";
import { generate, ManifestError, type Environment, type Manifest } from "../src/compose/generate.ts";
import { toYaml } from "../src/compose/yaml.ts";

const env: Environment = {
  name: "uat", project: "open-atlas", bindIp: "127.0.0.1",
  registries: { ghcr: "ghcr.io/acme" },
  apps: { shop: { version: "1.2.0" }, blog: { version: "3.0.0" } },
};

const shop: Manifest = {
  v: 1, app: "shop", appliesFrom: "1.0.0",
  components: [
    { id: "db", type: "compose-service", service: "shop-db", source: { kind: "public-registry", image: "postgres:16.4" },
      volumes: [{ target: "/var/lib/postgresql/data", path: "data/pg" }, { target: "/docker-entrypoint-initdb.d", file: "db/init" }],
      environment: { POSTGRES_PASSWORD: "${PG_PASSWORD}" }, health: ["CMD-SHELL", "pg_isready"] },
    { id: "cache", type: "compose-service", service: "shop-cache", source: { kind: "public-registry", image: "valkey/valkey:9-alpine" }, health: "none" },
    { id: "web", type: "compose-service", service: "shop", dependsOn: ["db", "cache", "ui"],
      source: { kind: "company-registry", registry: "ghcr", image: "shop" },
      ports: [{ container: 8080, host: 18080 }, { container: 9000 }], envFile: true, init: true,
      compose: { deploy: { resources: { limits: { memory: "1g" } } } } },
    { id: "ui", type: "workbench-app" },
  ],
  env: { file: "shop.env", secrets: ["PG_PASSWORD"] },
};

test("writes one fragment per app and a root that only includes them", () => {
  const files = generate([shop], env);
  assert.deepEqual(Object.keys(files).sort(), ["compose.yaml", "shop/compose.yaml"]);
  assert.match(files["compose.yaml"], /^name: "open-atlas"$/m);
  assert.match(files["compose.yaml"], /- path: "shop\/compose.yaml"\n {4}env_file: "shop.env"/);
});

test("pins the image to the deployed version and binds ports to the environment's address", () => {
  const out = generate([shop], env)["shop/compose.yaml"];
  assert.match(out, /image: "ghcr.io\/acme\/shop:1.2.0"/);
  assert.match(out, /- "127.0.0.1:18080:8080"/);
  assert.doesNotMatch(out, /9000/, "a port without a host port is not published");
  assert.match(out, /org.open-atlas.version: "1.2.0"/);
});

test("waits for healthy dependencies, only started ones without a health check, and skips non-compose components", () => {
  const out = generate([shop], env)["shop/compose.yaml"];
  assert.match(out, /depends_on:\n {6}shop-db:\n {8}condition: "service_healthy"\n {6}shop-cache:\n {8}condition: "service_started"/);
  assert.doesNotMatch(out, /ui/);
});

test("mounts data under the app directory, release files read-only, and the env file from the deploy root", () => {
  const out = generate([shop], env)["shop/compose.yaml"];
  assert.match(out, /- ".\/data\/pg:\/var\/lib\/postgresql\/data"/);
  assert.match(out, /- ".\/files\/db\/init:\/docker-entrypoint-initdb.d:ro"/);
  assert.match(out, /env_file:\n {6}- "..\/shop.env"/);
  assert.match(out, /POSTGRES_PASSWORD: "\$\{PG_PASSWORD\}"/);
});

test("applies the environment's overrides and merges extra compose fields", () => {
  const out = generate([shop], { ...env, apps: { shop: { version: "1.2.0", overrides: { web: { ports: { "8080": 28080 } }, db: { volumes: { "/var/lib/postgresql/data": "/srv/pg" } } } } } })["shop/compose.yaml"];
  assert.match(out, /- "127.0.0.1:28080:8080"/);
  assert.match(out, /- "\/srv\/pg:\/var\/lib\/postgresql\/data"/);
  assert.match(out, /deploy:\n {6}resources:\n {8}limits:\n {10}memory: "1g"/);
  assert.match(out, /logging:\n {6}driver: "local"/);
});

test("refuses a service name or host port two apps both claim, and an unregistered registry", () => {
  const blog: Manifest = { v: 1, app: "blog", appliesFrom: "3.0.0", components: [
    { id: "web", type: "compose-service", service: "blog", source: { kind: "public-registry", image: "ghost:5.0" }, ports: [{ container: 2368, host: 18080 }] }] };
  assert.throws(() => generate([shop, blog], env), (e) => e instanceof ManifestError && /host port 18080/.test(e.message));
  assert.throws(() => generate([shop, { ...blog, components: [{ ...blog.components[0], service: "shop", ports: [] }] }], env), /service shop/);
  assert.throws(() => generate([shop], { ...env, registries: {} }), /registry ghcr is not registered/);
});

test("only generates apps the environment deploys", () => {
  assert.deepEqual(Object.keys(generate([shop], { ...env, apps: {} })), ["compose.yaml"]);
});

test("quotes every string so nothing is read as a number, boolean or anchor", () => {
  assert.equal(toYaml({ a: "yes", b: "1.10", c: "*x", d: [], e: { f: 1, g: true } }), 'a: "yes"\nb: "1.10"\nc: "*x"\nd: []\ne:\n  f: 1\n  g: true\n');
});
