// Publishes the next revision of the Deploy Assistant (design §10.4), or with a 6th argument onboarding-assessor the
// Onboarding Assessor (§10.5), to one environment's OMA through its Builder MCP, as Logbook's publish-oma.py does:
// the package definition is templates/<agent>.oma.json, the prompt agents/<agent>.md. The state file keeps the
// package id and the agents published so far; each publish makes a new agent id, which the next step points at.
//
// Usage: [NIFI_OPS_MCP_URL=<Studio data plane MCP of the nifi-ops graph>] node bin/publish-assistant.ts <builder MCP url> <builder key file> <model> <Deployer MCP url> <state file> [deploy-assistant | onboarding-assessor]
//   e.g. node bin/publish-assistant.ts https://oma:3008/mcp /etc/oa/oma-builder.key claude-x https://wb.example/deploy/mcp ./assistant-uat.json

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
// The Deploy Assistant's skills (agents/skills/*.md, e.g. NiFi operations) go into its system prompt: an OMA package carries
// only references to Skills published on their own, and OMA injects a Skill into the prompt anyway.
const skillsDir = join(root, "agents", "skills");
const skills = agentName === "deploy-assistant" && existsSync(skillsDir) ? readdirSync(skillsDir).filter((f) => f.endsWith(".md")).sort().map((f) => readFileSync(join(skillsDir, f), "utf8")) : [];
const values = { model, mcpUrl, system: [readFileSync(join(root, "agents", `${agentName}.md`), "utf8"), ...skills].join("\n\n") };
const missing = new Set<string>();
const filled = JSON.parse(readFileSync(join(root, "templates", `${agentName}.oma.json`), "utf8"), (_k, v) => {
  if (typeof v !== "string") return v;
  const r = fill(v, values);
  r.missing.forEach((m) => missing.add(m));
  return r.text;
});
if (missing.size) { console.error(`the package names ${[...missing].join(", ")} with no value`); process.exit(2); }
// Service ops §9.4 (phase 2 step 6): with NIFI_OPS_MCP_URL (Studio's data plane MCP of the nifi-ops graph, e.g.
// https://studio:9632/mcp/<graph uuid>) the Deploy Assistant also gets that graph's read tools, for drilling down to one
// queue, processor or process group; its graph token (oat_v1.) is a second credential, kept in OMA's Vault.
const NIFI_OPS_TOOLS = ["list_entities", "list_attributes", "search_attributes", "execute_eql", "list_saved_queries", "run_saved_query"];
const nifiOps = process.env.NIFI_OPS_MCP_URL;
if (nifiOps && agentName === "deploy-assistant") {
  const agent = filled.agents[0];
  agent.mcp_servers.push({ name: "open-atlas-nifi-ops", type: "http", url: nifiOps, allowed_tools: NIFI_OPS_TOOLS });
  agent.tools.push({ type: "mcp_toolset", mcp_server_name: "open-atlas-nifi-ops", default_config: { permission_policy: { type: "always_allow" } } });
  filled.credential_requirements.push({ key: "nifi-ops-graph-token", description: "A read-only Studio graph token (oat_v1.) of the nifi-ops graph, stored for the URL above.", required_scopes: ["read"] });
}

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
