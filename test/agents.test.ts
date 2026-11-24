// The agents' definitions agree with each other: every Deployer tool a prompt or Skill names is in that agent's
// allowed_tools, and every allowed tool is one its key sees. A tool named in the prompt but missing from the
// whitelist is refused by OMA, and the model then improvises (found by the golden cases, 2026-11-16).

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { TOOLS, visibleTools, type Tier } from "../src/server/mcp.ts";

const root = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");
const allTools = new Set(TOOLS.map((t) => t.name));
const skills = readdirSync(join(root, "agents", "skills")).map((d) => read("agents", "skills", d, "SKILL.md"));

function named(text: string) {
  // `tool` or `tool {args}` in backticks.
  return new Set([...text.matchAll(/`([a-z][a-z_]+)(?:\s*\{[^`]*\})?`/g)].map((m) => m[1]!).filter((n) => allTools.has(n)));
}
function allowed(template: string) {
  const t = JSON.parse(read("templates", template));
  return new Set<string>(t.agents[0].mcp_servers[0].allowed_tools);
}

// The check-up shares the nifi-ops Skill, which also describes draft_change for the Assistant: only its own prompt is held to its list.
for (const [agent, template, tier, extra] of [
  ["deploy-assistant", "deploy-assistant.oma.json", "assistant", skills],
  ["onboarding-assessor", "onboarding-assessor.oma.json", "assistant", []],
  ["service-checkup", "service-checkup.oma.json", "checkup", []],
] as const) {
  test(`${agent}: the tools its prompt and Skills name are allowed, and the allowed ones exist for its key`, () => {
    const list = allowed(template);
    const sees = new Set(visibleTools(tier as Tier, false).map((t) => t.name));
    for (const name of list) assert.ok(sees.has(name), `${name} is allowed but the ${tier} key does not see it`);
    const texts = [read("agents", `${agent}.md`), ...extra];
    for (const name of new Set(texts.flatMap((t) => [...named(t)]))) assert.ok(list.has(name), `${agent} names ${name}, which its allowed_tools lack`);
  });
}

test("the Assistant and the check-up have the seven verbs (the check-up without draft_change); the old service tools are gone", () => {
  const verbs = ["describe", "look", "trace", "run_model", "publish_model", "record", "draft_change"];
  const assistant = [...verbs.filter((v) => v !== "publish_model"), "register"];
  assert.deepEqual(assistant.filter((v) => allowed("deploy-assistant.oma.json").has(v)), assistant, "S39 step 6: register, publish_model internal");
  assert.deepEqual([...allowed("service-checkup.oma.json")].sort(), verbs.filter((v) => v !== "draft_change").sort());
  for (const old of ["list_service_clusters", "get_cluster_status", "get_service_health", "trace_business_data", "draft_service_config"]) assert.ok(!allTools.has(old), old);
});

test("the draft tools of the Assessor are exactly the assessment draft tools", () => {
  const drafts = TOOLS.filter((t) => t.draft && t.name !== "draft_change").map((t) => t.name).sort();
  const list = [...allowed("onboarding-assessor.oma.json")].filter((n) => TOOLS.find((t) => t.name === n)?.draft).sort();
  assert.deepEqual(list, drafts);
});
