// Phase 2 step 6 (§9.4, §9.5, §15.3): the nifi-ops Studio graph. What the generator writes (one source pair per
// service at <nginxUrl>/nifi-api, per-service entities, the bounds), that every JSON path it maps exists in the
// responses recorded through the lab's nginx from NiFi 1.12.1 and the 2.5.0 cluster (testdata/nifi-graph, recorded
// with Studio's connector-api-kit), the publication through the Builder MCP and its record, and the nginx check.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { McpClient } from "../src/server/mcp-client.ts";
import { apiRoot, checkNginxUrl, generateGraph, slug, sourceIds, SOURCE_RESILIENCE } from "../src/server/services/graph.ts";
import { checkNginx, graphServices, NifiOpsGraph } from "../src/server/services/graph-publish.ts";
import { edn, kw, map, set } from "../src/server/services/edn.ts";
import { Store } from "../src/server/store.ts";

const admin = { id: "admin", via: "cli" } as const;
const LAB = [
  { id: "n112", kind: "standalone" as const, version: "1.12.1", nginxUrl: "http://127.0.0.1:18543" },
  { id: "nifi-lab-c250", kind: "cluster" as const, version: "2.5.0", nginxUrl: "http://127.0.0.1:18545/" },
];

// A small EDN reader for the contract and the kit's fixtures: maps, vectors, lists, sets, strings, numbers, keywords
// (as ":ns/name"), nil, booleans; comments and commas are whitespace.
function readEdn(text: string): unknown {
  let i = 0;
  const ws = () => { for (;;) { while (i < text.length && /[\s,]/.test(text[i]!)) i++; if (text[i] === ";") { while (i < text.length && text[i] !== "\n") i++; } else return; } };
  const value = (): unknown => {
    ws();
    const c = text[i]!;
    if (c === "{" || c === "[" || c === "(" || (c === "#" && text[i + 1] === "{")) {
      const close = c === "{" || c === "#" ? "}" : c === "[" ? "]" : ")";
      i += c === "#" ? 2 : 1;
      const items: unknown[] = [];
      for (;;) { ws(); if (text[i] === close) { i++; break; } items.push(value()); }
      if (c !== "{") return items;
      const m = new Map<unknown, unknown>();
      for (let k = 0; k < items.length; k += 2) m.set(typeof items[k] === "object" ? JSON.stringify(items[k]) : items[k], items[k + 1]);
      return m;
    }
    if (c === "\"") {
      let s = ""; i++;
      while (text[i] !== "\"") { if (text[i] === "\\") { i++; s += { n: "\n", t: "\t", r: "\r" }[text[i]!] ?? text[i]; } else s += text[i]; i++; }
      i++; return s;
    }
    const m = /^[^\s,\]\})]+/.exec(text.slice(i))![0];
    i += m.length;
    if (m === "nil") return null;
    if (m === "true" || m === "false") return m === "true";
    if (/^-?\d+(\.\d+)?$/.test(m)) return Number(m);
    return m; // keyword or symbol, as written
  };
  return value();
}
const get = (m: unknown, ...keys: string[]): any => keys.reduce((v: any, k) => (v instanceof Map ? v.get(k) : undefined), m);

/** The value at a JSONPath of the kind the graph writes ($.a.b, $.a[*] is not used inside a record). */
function at(body: unknown, path: string): unknown {
  return path.replace(/^\$\.?/, "").split(".").filter(Boolean).reduce((v: any, k) => (v instanceof Map ? v.get(`:${k}`) : undefined), body);
}

test("EDN: keywords, sets, maps with any keys, strings escaped, long values broken onto lines", () => {
  assert.equal(edn({ ":a/b": [1, "x\"y", null, true], s: set([kw("k")]), m: map([[[kw("resolver"), "r"], "b"]]) }, 0, 1000),
    '{:a/b [1 "x\\"y" nil true] "s" #{:k} "m" {[:resolver "r"] "b"}}');
  const long = edn({ ":k": Array.from({ length: 30 }, (_, n) => `item-${n}`) });
  assert.ok(long.includes("\n"), "past the width it breaks");
  assert.deepEqual(readEdn(long) instanceof Map ? (readEdn(long) as Map<string, unknown[]>).get(":k")!.length : 0, 30);
  assert.throws(() => edn(Number.NaN));
});

test("nginx addresses: checked and cleaned; the API root is <address>/nifi-api; ids become names", () => {
  assert.deepEqual(checkNginxUrl("https://ops.example:8443/nifi/"), { url: "https://ops.example:8443/nifi" });
  assert.deepEqual(checkNginxUrl("http://127.0.0.1:18543/nifi-api"), { url: "http://127.0.0.1:18543" });
  for (const bad of ["", "ftp://x", "https://u:p@x", "https://x/?a=1", "nope", 7]) assert.ok("error" in checkNginxUrl(bad), String(bad));
  assert.equal(apiRoot("http://h:1/"), "http://h:1/nifi-api");
  assert.equal(apiRoot("http://h:1/nifi-api"), "http://h:1/nifi-api");
  assert.deepEqual([slug("NiFi_Prod.C1"), slug("112"), sourceIds("n112")], ["nifi-prod-c1", "s112", { api: "nifi-ops-n112" }]);
  assert.throws(() => slug("__"));
  assert.throws(() => generateGraph([LAB[0]!, { ...LAB[0]!, id: "N112" }]), /same graph name/);
});

test("§15.5 company nginx: one nginx, a path prefix per NiFi — nginxUrl keeps the prefix, /nifi-api goes after it", async () => {
  assert.deepEqual(checkNginxUrl("https://nginx.corp/nifi-prod-a"), { url: "https://nginx.corp/nifi-prod-a" });
  assert.deepEqual(checkNginxUrl("http://127.0.0.1:18546/c250/nifi-api/"), { url: "http://127.0.0.1:18546/c250" });
  assert.equal(apiRoot("https://nginx.corp/nifi-prod-a/"), "https://nginx.corp/nifi-prod-a/nifi-api");
  assert.equal(apiRoot("https://nginx.corp/a/b/nifi-api"), "https://nginx.corp/a/b/nifi-api");
  const g = generateGraph([{ ...LAB[1]!, nginxUrl: "http://127.0.0.1:18546/c250" }], { workspace: "ws", graph: "nifi-ops-dev" });
  assert.deepEqual(g.sources.map((s) => s.entry.base_url), ["http://127.0.0.1:18546/c250/nifi-api"]);
  const asked: string[] = [];
  const fetcher = (async (url: string) => { asked.push(url); return url.endsWith("/c250/nifi-api/flow/about") ? new Response(JSON.stringify({ about: { version: "2.5.0" } })) : new Response("no", { status: 404 }); }) as unknown as typeof fetch;
  const ok = await checkNginx("http://127.0.0.1:18546/c250", fetcher);
  assert.deepEqual([ok.ok, ok.version], [true, "2.5.0"]);
  const missing = await checkNginx("http://127.0.0.1:18546/nope", fetcher);
  assert.equal(missing.error, "HTTP 404: not found (does nginx pass /nope/nifi-api/ to NiFi?)");
  assert.deepEqual(asked, ["http://127.0.0.1:18546/c250/nifi-api/flow/about", "http://127.0.0.1:18546/nope/nifi-api/flow/about"]);
});

test("the generated contract: per service one api source at the nginx address (no nifi source, S28) (2 at a time, 5 s, no retries), its entities and resolvers", () => {
  const g = generateGraph(LAB, { workspace: "ws", graph: "nifi-ops-dev" });
  assert.deepEqual(g.services, ["n112", "nifi-lab-c250"]);
  assert.deepEqual(g.sources.map((s) => [s.id, s.entry.type, s.entry.base_url]), [
    ["nifi-ops-n112", "api", "http://127.0.0.1:18543/nifi-api"], ["nifi-ops-nifi-lab-c250", "api", "http://127.0.0.1:18545/nifi-api"],
  ]);
  assert.deepEqual(g.sources[0]!.entry.resilience, SOURCE_RESILIENCE);
  assert.deepEqual([SOURCE_RESILIENCE.timeout_ms, SOURCE_RESILIENCE.max_retries, SOURCE_RESILIENCE.bulkhead.concurrency], [5000, 0, 2]);
  const doc = readEdn(g.text);
  assert.equal(get(doc, ":graph", ":graph/id"), "nifi-ops-dev");
  const entities = get(doc, ":graph", ":graph/entities") as string[];
  assert.deepEqual(entities.filter((e) => e.startsWith("nifi.n112.")), ["nifi.n112.controller", "nifi.n112.pg", "nifi.n112.processor", "nifi.n112.connection", "nifi.n112.bulletin"]);
  assert.ok(!g.text.includes(":connector/nifi") && !g.text.includes(":operation :provenance") && !g.text.includes("provenance-api") && !g.text.includes("nifi.n112.event"), "no provenance in the graph (S28)");
  assert.ok(entities.includes("nifi.nifi-lab-c250.node") && entities.includes("nifi.nifi-lab-c250.jvm"), "a cluster has nodes and per-node JVMs");
  assert.equal(entities.length, g.entities);
  const bindings = get(doc, ":execution", ":bindings") as Map<string, Map<string, unknown>>;
  const impls = [...bindings.values()].map((b) => b.get(":binding/implementation") as Map<string, unknown>);
  assert.ok(impls.filter((m) => m.has(":method")).every((m) => m.get(":method") === "GET"), "monitoring only GETs");
  assert.ok(!g.text.includes("recursive"), "process groups one level at a time");
  const pg = bindings.get("n112-pg-status-api")!;
  assert.equal((pg.get(":binding/implementation") as Map<string, unknown>).get(":endpoint"), "/flow/process-groups/{nifi.n112.pg/id}/status");
  assert.equal(pg.get(":binding/source"), "nifi-ops-n112");
  const sources = get(doc, ":execution", ":sources") as Map<string, Map<string, unknown>>;
  assert.deepEqual([...sources.keys()], g.sources.map((s) => s.id), "the source slots are the declared sources' ids");
  assert.equal(get(doc, ":ownership", ":resolvers").size, g.resolvers);
  assert.equal(generateGraph([...LAB].reverse(), { workspace: "ws", graph: "nifi-ops-dev" }).text, g.text, "the same services make the same text");
});

test("the field mappings against the responses recorded through the lab's nginx (1.12.1 and the 2.5.0 cluster): every mapped path is there", () => {
  const g = generateGraph(LAB, { workspace: "ws", graph: "nifi-ops-dev" });
  const bindings = get(readEdn(g.text), ":execution", ":bindings") as Map<string, Map<string, any>>;
  const dir = join(import.meta.dirname, "..", "testdata", "nifi-graph");
  let checked = 0;
  const missing: string[] = [];
  for (const source of readdirSync(dir)) for (const file of readdirSync(join(dir, source))) {
    const fixture = readEdn(readFileSync(join(dir, source, file), "utf8"));
    const operation = get(fixture, ":api-kit/provenance", ":operation") as string;
    const impl = bindings.get(`${operation}-api`)!.get(":binding/implementation") as Map<string, any>;
    for (const exchange of get(fixture, ":api-kit/exchanges") as Map<string, unknown>[]) {
      assert.equal(exchange.get(":status"), 200, `${file}: recorded a success`);
      const data = at(exchange.get(":body"), impl.get(":data_path") ?? "$");
      const records = Array.isArray(data) ? data : [data];
      const walk = (mapping: Map<string, any>, record: unknown, where: string) => {
        for (const [attr, path] of mapping) {
          if (attr === ":_from") continue;
          if (path instanceof Map) {
            const rows = at(record, (path.get(":_from") as string).replace(/\[\*\]$/, "")) as unknown[];
            assert.ok(Array.isArray(rows), `${where} ${attr}: an array`);
            for (const row of rows) walk(path, row, `${where} ${attr}[]`);
            continue;
          }
          checked++;
          // Fields only 2.x has, and those NiFi leaves out when empty, are nullable in the graph.
          if (at(record, path) === undefined && !/availability|nodeAddress|sourceId|sourceName|sourceType|groupId|heartbeat|nodeStartTime/i.test(path)) missing.push(`${file} ${where} ${attr} ${path}`);
        }
      };
      for (const r of records) walk(impl.get(":field_mapping"), r, operation);
    }
  }
  assert.deepEqual(missing, []);
  assert.ok(checked > 150, `${checked} values checked`);
  const files = readdirSync(dir).flatMap((d) => readdirSync(join(dir, d)).map((f) => readFileSync(join(dir, d, f), "utf8"))).join("\n");
  assert.ok(files.includes("1.12.1") && files.includes("2.5.0") && files.includes("CONNECTED") && files.includes("LogAttribute"), "both version lines, the cluster's nodes, the lab's processors");
  assert.ok(!/oaw_v1|oat_v1|BEGIN [A-Z ]*PRIVATE KEY|password/i.test(files.replace(/:private-key|:secret-paths/g, "")), "nothing secret recorded");
});

/** A Builder MCP that remembers the calls and answers like Studio 2.8. */
function fakeStudio(opts: { graphExists?: boolean; refuse?: string } = {}) {
  const calls: [string, Record<string, any>][] = [];
  let sources: { id: string; revision: number }[] = [];
  let graphs = opts.graphExists ? [{ "graph/name": "nifi-ops-dev", "graph/qualified-name": "ws/nifi-ops-dev" }] : [];
  const draft = `{:contract {:contract/family "atlas-semantic" :contract/version "2.0.0"} :graph {:graph/id "uuid-1"} :workspace {:workspace/id "ws"}}`;
  const studio = {
    async call(name: string, args: Record<string, any>) {
      calls.push([name, args]);
      if (name === opts.refuse) return { findings: [{ code: "x/refused", severity: "error", message: "no" }] };
      switch (name) {
        case "declare_source": {
          const had = sources.find((s) => s.id === args.id);
          // Studio 2.8: no upsert; a taken id is refused (an MCP error, EDN) with its revision.
          if (had && args.expected_revision === undefined) throw new Error(`declare_source: {:error {:source "${args.id}" :findings [{:code :pool.action/id-taken, :severity :error, :message "an object with this id already exists", :got {:revision ${had.revision}}}]}}`);
          sources = [...sources.filter((s) => s.id !== args.id), { id: args.id, revision: (args.expected_revision ?? 0) + 1 }];
          return { "written?": true, findings: [] };
        }
        case "list_graphs": return { graphs };
        case "create_graph": graphs = [{ "graph/name": args.name, "graph/qualified-name": `ws/${args.name}` }]; return { graph: graphs[0], findings: [] };
        case "get_graph": return { revision: 3, text: draft, findings: [] };
        case "upload_graph": return { revision: 4, findings: [] };
        case "publish_graph": return { version: 2, findings: [] };
        default: throw new Error(`unexpected ${name}`);
      }
    },
  };
  return { studio: studio as unknown as McpClient, calls };
}

test("publishing: sources declared, the graph made the first time, the contract uploaded with Studio's ids at the draft's revision, published, recorded", async () => {
  const store = new Store(":memory:");
  const g0 = new NifiOpsGraph(store, { studio: undefined, graph: "nifi-ops-dev" });
  assert.equal((await g0.publish("test", admin)).state, "skipped", "no Studio configured");
  const { studio, calls } = fakeStudio();
  const g = new NifiOpsGraph(store, { studio, graph: "nifi-ops-dev" });
  assert.deepEqual([(await g.publish("test", admin)).state, calls.length], ["skipped", 0], "no service has an nginx address: Studio is not called");
  store.addStandalone({ kind: "standalone", id: "n112", service: "nifi", profile: "nifi-1.x", version: "1.12.1", webUrl: null, member: { host: "local", installDir: "/lab/n112", serviceUser: "ferenc", startEnvironment: null, ports: { https: 18443 }, discovery: null } }, "uat", admin);
  store.setServiceNginxUrl("n112", "http://127.0.0.1:18543", admin);
  assert.deepEqual(graphServices(store), [{ id: "n112", kind: "standalone", version: "1.12.1", nginxUrl: "http://127.0.0.1:18543" }]);
  const run = await g.publish("nginx address of n112 set", admin);
  assert.equal(run.state, "published", run.message);
  assert.deepEqual(calls.map(([n]) => n), ["declare_source", "list_graphs", "create_graph", "get_graph", "upload_graph", "publish_graph"]);
  assert.deepEqual(calls[0]![1], { id: "nifi-ops-n112", entry: generateGraph(graphServices(store)).sources[0]!.entry, verify: false, apply: true });
  const upload = calls.find(([n]) => n === "upload_graph")![1];
  assert.deepEqual([upload.graph, upload.expected_revision], ["ws/nifi-ops-dev", 3]);
  assert.ok(upload.text.includes(':graph/id "uuid-1"') && upload.text.includes(':workspace/id "ws"') && !upload.text.includes('"nifi-ops"'), "Studio's own ids");
  assert.deepEqual([run.graph, run.services, run.detail.version], ["ws/nifi-ops-dev", ["n112"], 2]);
  assert.deepEqual(run.detail.sources, ["nifi-ops-n112"]);
  // Again: each source is refused as taken and replaced at its revision; the graph is not made twice.
  calls.length = 0;
  assert.equal((await g.publish("again", admin)).state, "published");
  assert.deepEqual(calls.filter(([n]) => n === "declare_source").map(([, a]) => [a.id, a.expected_revision]), [["nifi-ops-n112", undefined], ["nifi-ops-n112", 1]]);
  assert.ok(!calls.some(([n]) => n === "create_graph"));
  assert.deepEqual(store.graphRuns().map((r) => r.state), ["published", "published", "skipped", "skipped"]);
  // A refusal is recorded as failed with what was done before it.
  const refusing = fakeStudio({ graphExists: true, refuse: "upload_graph" });
  const failed = await new NifiOpsGraph(store, { studio: refusing.studio, graph: "nifi-ops-dev" }).publish("x", admin);
  assert.equal(failed.state, "failed");
  assert.match(failed.message, /refused the contract/);
  assert.equal((failed.detail.log as string[]).length, 1, "the source was declared");
  // schedule(): a request while one runs makes one more run afterwards, not one each.
  const before = store.graphRuns(50).length;
  g.schedule("a", admin); g.schedule("b", admin); g.schedule("c", admin);
  await g.idle();
  assert.equal(store.graphRuns(50).length - before, 2);
});

test("checking an nginx address: /flow/about through it, NiFi's version, or why not", async () => {
  const answer = (status: number, body: string): typeof fetch => async (url) => { assert.equal(String(url), "http://n:1/nifi-api/flow/about"); return new Response(body, { status }); };
  const ok = await checkNginx("http://n:1", answer(200, JSON.stringify({ about: { version: "1.12.1" } })));
  assert.deepEqual([ok.ok, ok.version, ok.status, ok.error], [true, "1.12.1", 200, null]);
  assert.match((await checkNginx("http://n:1", answer(403, "no"))).error!, /HTTP 403: refused/);
  assert.match((await checkNginx("http://n:1", answer(200, "<html>"))).error!, /not NiFi's/);
  const down = await checkNginx("http://n:1", async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED", message: "connect ECONNREFUSED" } }); });
  assert.deepEqual([down.ok, down.status, down.error], [false, null, "ECONNREFUSED: connect ECONNREFUSED"]);
});
