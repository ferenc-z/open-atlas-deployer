// Writes the e2e_trace graph's contract and saved queries (services/trace/e2e-graph.ts) into a folder, for building
// that graph in a Studio by hand or through its Builder MCP (docs/e2e-trace-graph/README.md).
//   node bin/export-e2e-graph.ts [out dir, default docs/e2e-trace-graph]

import { writeFileSync } from "node:fs";
import { E2E_SAVED_QUERIES, e2eTraceContract } from "../src/server/services/trace/e2e-graph.ts";

const out = process.argv[2] ?? "docs/e2e-trace-graph";
writeFileSync(`${out}/contract.edn`, e2eTraceContract());
writeFileSync(`${out}/saved-queries.json`, `${JSON.stringify(E2E_SAVED_QUERIES, null, 2)}\n`);
console.log(`wrote ${out}/contract.edn and ${out}/saved-queries.json`);
