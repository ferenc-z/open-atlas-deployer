// Imports deploy manifests into the registry (phase 1 brings in the four initial ones from
// open-atlas-docs docs/proposals/deploy-manifests/). Each file becomes a new revision; the first
// one for an app registers it. Usage: node bin/import-manifests.ts <data dir> <manifests dir or file>...

import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Store, StoreError } from "../src/server/store.ts";

const [dataDir, ...sources] = process.argv.slice(2);
if (!dataDir || !sources.length) {
  console.error("usage: node bin/import-manifests.ts <data dir> <manifests dir or file>...");
  process.exit(2);
}
mkdirSync(dataDir, { recursive: true });
const store = new Store(join(dataDir, "deployer.db"));
const files = sources.flatMap((s) => statSync(s).isDirectory() ? readdirSync(s).filter((f) => f.endsWith(".json")).sort().map((f) => join(s, f)) : [s]);
let failed = false;
for (const file of files) {
  try {
    const saved = store.saveManifest(JSON.parse(readFileSync(file, "utf8")), { id: process.env.USER ?? process.env.USERNAME ?? "cli", via: "cli" }, { note: `imported from ${file}` });
    console.log(`ok   ${saved.app}@${saved.appliesFrom} revision ${saved.revision}`);
  } catch (error) {
    failed = true;
    console.log(`FAIL ${file}: ${(error as Error).message}${error instanceof StoreError && error.details.length ? "\n  " + error.details.join("\n  ") : ""}`);
  }
}
store.close();
process.exit(failed ? 1 : 0);
