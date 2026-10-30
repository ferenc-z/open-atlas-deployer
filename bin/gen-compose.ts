// node bin/gen-compose.ts <manifests dir> <environment.json> <out dir>
// Writes the deploy root's compose.yaml and one <app>/compose.yaml per app.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { generate, type Environment, type Manifest } from "../src/compose/generate.ts";

const [manifestDir, envFile, outDir] = process.argv.slice(2);
if (!manifestDir || !envFile || !outDir) {
  console.error("usage: node bin/gen-compose.ts <manifests dir> <environment.json> <out dir>");
  process.exit(2);
}
const manifests = readdirSync(manifestDir).filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(manifestDir, f), "utf8")) as Manifest);
const env = JSON.parse(readFileSync(envFile, "utf8")) as Environment;
for (const [path, content] of Object.entries(generate(manifests, env))) {
  mkdirSync(dirname(join(outDir, path)), { recursive: true });
  writeFileSync(join(outDir, path), content);
  console.log(path);
}
