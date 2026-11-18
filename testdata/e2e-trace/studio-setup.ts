// S37 step 7: puts the e2e_trace graph into a Studio for tests — the ClickHouse `sql` source, the graph (created the
// first time), the contract and its saved queries (published), and a graph token for the data plane.
//   node testdata/e2e-trace/studio-setup.ts <builder MCP url> <workspace token file> <graph name> <graph token out file>
// ClickHouse as Studio's container reaches it: E2E_JDBC_URL (default jdbc:clickhouse://oa-e2e-clickhouse:8123/e2e_trace),
// E2E_DB_USER / E2E_DB_PASSWORD (default the test container's e2e / e2e-test).

import { readFileSync, writeFileSync } from "node:fs";
import { publishContract } from "../../src/server/drivers/studio-graph.ts";
import { McpClient } from "../../src/server/mcp-client.ts";
import { E2E_SAVED_QUERIES, E2E_SOURCE_ID, e2eTraceContract } from "../../src/server/services/trace/e2e-graph.ts";

const [url, tokenFile, graphName, out] = process.argv.slice(2);
if (!url || !tokenFile || !graphName || !out) { console.error("usage: studio-setup.ts <builder url> <workspace token file> <graph name> <graph token out file>"); process.exit(2); }
const token = readFileSync(tokenFile, "utf8").trim();
const studio = new McpClient(url, () => ({ authorization: `Bearer ${token}` }));
const failed = (a: any) => Array.isArray(a?.findings) && a.findings.some((f: any) => f.severity === "error" || f.severity === ":error");

// Studio takes credentials only as ${VAR} references, set with save_credential.
await studio.call("save_credential", { name: "E2E_TRACE_DB_USER", value: process.env.E2E_DB_USER ?? "e2e" });
await studio.call("save_credential", { name: "E2E_TRACE_DB_PASSWORD", value: process.env.E2E_DB_PASSWORD ?? "e2e-test" });
const entry = {
  type: "sql", label: "ClickHouse e2e_trace (test)",
  jdbc_url: process.env.E2E_JDBC_URL ?? "jdbc:clickhouse://oa-e2e-clickhouse:8123/e2e_trace",
  username: "${E2E_TRACE_DB_USER}", password: "${E2E_TRACE_DB_PASSWORD}",
};
let answer: any;
try { answer = await studio.call("declare_source", { id: E2E_SOURCE_ID, entry, verify: true, apply: true }); } catch (error) {
  const taken = /:pool\.action\/id-taken[\s\S]*?:got \{:revision (\d+)\}/.exec((error as Error).message);
  if (!taken) throw error;
  answer = await studio.call("declare_source", { id: E2E_SOURCE_ID, entry, verify: true, apply: true, expected_revision: Number(taken[1]) });
}
if (failed(answer)) throw new Error(`declare_source: ${JSON.stringify(answer).slice(0, 800)}`);
console.log(`source ${E2E_SOURCE_ID} declared`);

const graphs = await studio.call("list_graphs", {});
let found = ((graphs?.graphs ?? []) as Record<string, string>[]).find((g) => g["graph/name"] === graphName);
let graph = found?.["graph/qualified-name"] ?? graphName;
if (!found) {
  const made = await studio.call("create_graph", { name: graphName });
  if (failed(made)) throw new Error(`create_graph: ${JSON.stringify(made).slice(0, 600)}`);
  graph = made?.graph?.["graph/qualified-name"] ?? graphName;
  console.log(`graph ${graph} created`);
}
const published = await publishContract(studio, graph, e2eTraceContract(), (l) => console.log(l), E2E_SAVED_QUERIES);
console.log(`published ${JSON.stringify(published)}`);
const issued = await studio.call("issue_graph_token", { graph, label: "deployer e2e_trace (test)" });
const secret = JSON.stringify(issued).match(/oat_v1\.[A-Za-z0-9._~+/=-]+/)?.[0];
if (!secret) throw new Error(`issue_graph_token gave no token: ${JSON.stringify(issued).replace(/oat_v1\.[^"]+/g, "<token>").slice(0, 400)}`);
writeFileSync(out, `${secret}\n`, { mode: 0o600 });
console.log(`graph token written to ${out}; the rest of the answer: ${JSON.stringify(issued).replace(/oat_v1\.[^"]+/g, "<token>").slice(0, 600)}`);
