// Publishes the next revision of the Deploy Assistant (design §10.4), or with a 6th argument onboarding-assessor the
// Onboarding Assessor (§10.5), to one environment's OMA through its Builder MCP, as Logbook's publish-oma.py does:
// the package definition is templates/<agent>.oma.json, the prompt agents/<agent>.md. The state file keeps the
// package id and the agents published so far; each publish makes a new agent id, which the next step points at.
//
// Usage: node bin/publish-assistant.ts <builder MCP url> <builder key file> <model> <Deployer MCP url> <state file> [deploy-assistant | onboarding-assessor]
//   e.g. node bin/publish-assistant.ts https://oma:3008/mcp /etc/oa/oma-builder.key claude-x https://wb.example/deploy/mcp ./assistant-uat.json

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fill } from "../src/server/drivers/types.ts";
import { McpClient } from "../src/server/mcp-client.ts";
import { readToken } from "../src/server/versions.ts";

const [builderUrl, keyFile, model, mcpUrl, stateFile, agentName = "deploy-assistant"] = process.argv.slice(2);
if (!["deploy-assistant", "onboarding-assessor"].includes(agentName)) { console.error(`unknown agent ${agentName}`); process.exit(2); }
if (!builderUrl || !keyFile || !model || !mcpUrl || !stateFile) {
  console.error("usage: node bin/publish-assistant.ts <builder MCP url> <builder key file> <model> <Deployer MCP url> <state file>");
  process.exit(2);
}
const root = join(import.meta.dirname, "..");
const values = { model, mcpUrl, system: readFileSync(join(root, "agents", `${agentName}.md`), "utf8") };
const missing = new Set<string>();
const filled = JSON.parse(readFileSync(join(root, "templates", `${agentName}.oma.json`), "utf8"), (_k, v) => {
  if (typeof v !== "string") return v;
  const r = fill(v, values);
  r.missing.forEach((m) => missing.add(m));
  return r.text;
});
if (missing.size) { console.error(`the package names ${[...missing].join(", ")} with no value`); process.exit(2); }

const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) as { packageId?: string; agents?: string[] } : {};
const builder = new McpClient(builderUrl, () => ({ authorization: `Bearer ${readToken(keyFile)}` }));
if (!state.packageId) {
  const draft = await builder.call("create_package_draft", filled);
  state.packageId = String(draft.package_id ?? draft.id);
}
await builder.call("update_package_manifest", { package_id: state.packageId, ...filled });
const validation = await builder.call("validate_package", { package_id: state.packageId });
if (validation?.valid === false) { console.error(JSON.stringify(validation)); process.exit(1); }
const published = await builder.call("publish_package", { package_id: state.packageId });
const agent = String(published.agents[0].agent_id);
state.agents = [...(state.agents ?? []), agent];
writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
console.log(`package ${state.packageId} revision ${published.revision ?? "?"} agent ${agent}`);
console.log(agentName === "deploy-assistant"
  ? "Next: point the Business Agent \"Deploy Assistant\" at this agent (Workbench update_business_agent), and set DEPLOYER_OMA_AGENT to it."
  : "Next: set DEPLOYER_OMA_ASSESSOR_AGENT to this agent; its sessions run in DEPLOYER_OMA_ASSESSOR_ENVIRONMENT (isolated).");
