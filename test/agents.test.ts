// The agents' definitions agree with each other: every Deployer tool a prompt or Skill names is in that agent's
// allowed_tools, and every allowed tool is one the service key sees. A tool named in the prompt but missing from the
// whitelist is refused by OMA, and the model then improvises (found by the golden cases, 2026-11-16).

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { TOOLS } from "../src/server/mcp.ts";

const root = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");
const serviceTools = new Set(TOOLS.filter((t) => !t.admin && (t.readOnly || t.draft)).map((t) => t.name));
const allTools = new Set(TOOLS.map((t) => t.name));

function named(text: string) {
  // `tool` or `tool {args}` in backticks.
  return new Set([...text.matchAll(/`([a-z][a-z_]+)(?:\s*\{[^`]*\})?`/g)].map((m) => m[1]!).filter((n) => allTools.has(n)));
}
function allowed(template: string) {
  const t = JSON.parse(read("templates", template));
  return new Set<string>(t.agents[0].mcp_servers[0].allowed_tools);
}

for (const [agent, template, extra] of [
  ["deploy-assistant", "deploy-assistant.oma.json", readdirSync(join(root, "agents", "skills")).map((f) => read("agents", "skills", f))],
  ["onboarding-assessor", "onboarding-assessor.oma.json", []],
] as const) {
  test(`${agent}: the tools its prompt and Skills name are allowed, and the allowed ones exist for the service key`, () => {
    const list = allowed(template);
    for (const name of list) assert.ok(serviceTools.has(name), `${name} is allowed but the service key does not see it`);
    const texts = [read("agents", `${agent}.md`), ...extra];
    for (const name of new Set(texts.flatMap((t) => [...named(t)]))) assert.ok(list.has(name), `${agent} names ${name}, which its allowed_tools lack`);
  });
}

test("the draft tools of the Assessor are exactly the assessment draft tools", () => {
  const drafts = TOOLS.filter((t) => t.draft && t.name !== "draft_service_config").map((t) => t.name).sort();
  const list = [...allowed("onboarding-assessor.oma.json")].filter((n) => TOOLS.find((t) => t.name === n)?.draft).sort();
  assert.deepEqual(list, drafts);
});
