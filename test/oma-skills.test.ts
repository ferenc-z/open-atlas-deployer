// Service ops §15.5 (owner 2026-11-07): the Deploy Assistant's Skills are OMA Skills of their own — bin/publish-assistant.ts
// creates or versions them through OMA's Skills API (stubbed here) and the package references the concrete version.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { attachSkills, OmaSkills, readSkillSources, skillFrontmatter, skillReferences } from "../src/server/oma-skills.ts";

/** A small stand-in for OMA's /v1/skills routes (main-node routes/skills.ts): custom Skills, versions with files. */
function fakeOma() {
  const skills = new Map<string, { id: string; name: string; source: string; latest_version: string; updated_at: string; versions: Map<string, { filename: string; content: string; encoding: string }[]> }>();
  const calls: string[] = [];
  let n = 0;
  const fetcher = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    calls.push(`${method} ${u.pathname}${u.search}`);
    assert.equal((init.headers as Record<string, string>)["x-api-key"], "oma-key");
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    const parts = u.pathname.split("/").filter(Boolean).slice(2); // after /v1/skills
    if (method === "GET" && parts.length === 0) {
      return json(200, { data: [...skills.values()].filter((s) => u.searchParams.get("source") !== "custom" || s.source === "custom").map(({ versions, ...s }) => s) });
    }
    if (method === "POST" && parts.length === 0) {
      const version = String(++n);
      const id = `skill_${n}`;
      skills.set(id, { id, name: body.name, source: "custom", latest_version: version, updated_at: `2026-11-07T00:00:0${n}Z`, versions: new Map([[version, body.files]]) });
      return json(201, { id, name: body.name, source: "custom", latest_version: version });
    }
    const skill = skills.get(decodeURIComponent(parts[0]));
    if (!skill) return json(404, { error: "Skill not found" });
    if (method === "GET" && parts.length === 1) { const { versions, ...s } = skill; return json(200, s); }
    if (method === "GET" && parts[1] === "versions" && parts.length === 3) {
      const files = skill.versions.get(decodeURIComponent(parts[2]));
      return files ? json(200, { version: parts[2], files }) : json(404, { error: "Version not found" });
    }
    if (method === "POST" && parts[1] === "versions") {
      if (/password:\s*\S+/.test(body.files[0].content)) return json(422, { error: "Skill upload blocked by 1 BLOCK finding(s)." });
      const version = String(++n);
      skill.versions.set(version, body.files);
      skill.latest_version = version;
      return json(201, { version, files: [] });
    }
    return json(400, { error: "unexpected" });
  }) as unknown as typeof fetch;
  return { skills, calls, fetcher };
}

const SKILL = "---\nname: nifi-ops\ndescription: Looking into NiFi.\n---\n\n# Skill: NiFi operations\n";

test("§15.5: a Skill is created once, an unchanged one makes no new version, a changed one makes one", async () => {
  const oma = fakeOma();
  const client = new OmaSkills("http://oma.test/", "oma-key", oma.fetcher);
  const first = await client.ensure({ name: "nifi-ops", file: "nifi-ops.md", content: SKILL });
  assert.equal(first.action, "created");
  assert.deepEqual(oma.calls, ["GET /v1/skills?source=custom", "POST /v1/skills"]);
  const files = oma.skills.get(first.skill_id)!.versions.get(first.version)!;
  assert.deepEqual(files, [{ filename: "SKILL.md", content: SKILL, encoding: "utf8" }]);

  oma.calls.length = 0;
  const again = await client.ensure({ name: "nifi-ops", file: "nifi-ops.md", content: SKILL }, first.skill_id);
  assert.deepEqual(again, { ...first, action: "unchanged" });
  assert.deepEqual(oma.calls, [`GET /v1/skills/${first.skill_id}`, `GET /v1/skills/${first.skill_id}/versions/${first.version}`]);
  assert.equal(oma.skills.get(first.skill_id)!.versions.size, 1);

  const changed = await client.ensure({ name: "nifi-ops", file: "nifi-ops.md", content: SKILL + "More.\n" }, first.skill_id);
  assert.equal(changed.action, "updated");
  assert.equal(changed.skill_id, first.skill_id);
  assert.notEqual(changed.version, first.version);
  assert.equal(oma.skills.get(first.skill_id)!.latest_version, changed.version);
  assert.equal(oma.skills.size, 1);
});

test("§15.5: without a known id (new state file) the Skill is found by name; a stale id falls back to the name", async () => {
  const oma = fakeOma();
  const client = new OmaSkills("http://oma.test", "oma-key", oma.fetcher);
  const first = await client.ensure({ name: "nifi-ops", file: "nifi-ops.md", content: SKILL });
  await client.ensure({ name: "other", file: "other.md", content: SKILL.replace("nifi-ops", "other") });
  const byName = await client.ensure({ name: "nifi-ops", file: "nifi-ops.md", content: SKILL });
  assert.equal(byName.action, "unchanged");
  assert.equal(byName.skill_id, first.skill_id);
  const stale = await client.ensure({ name: "nifi-ops", file: "nifi-ops.md", content: SKILL }, "skill_gone");
  assert.equal(stale.skill_id, first.skill_id);
  assert.equal(oma.skills.size, 2);
});

test("§15.5: OMA's refusal comes back with its reason", async () => {
  const oma = fakeOma();
  const client = new OmaSkills("http://oma.test", "oma-key", oma.fetcher);
  const first = await client.ensure({ name: "nifi-ops", file: "nifi-ops.md", content: SKILL });
  await assert.rejects(client.ensure({ name: "nifi-ops", file: "nifi-ops.md", content: SKILL + "password: hunter2\n" }, first.skill_id),
    /OMA POST \/v1\/skills\/skill_1\/versions returned HTTP 422: Skill upload blocked/);
});

test("§15.5: the package references the version; the agent gets read alone to open SKILL.md; nothing goes into system", () => {
  const agent = {
    system: "prompt",
    tools: [
      { type: "agent_toolset_20260401", default_config: { enabled: false } },
      { type: "mcp_toolset", mcp_server_name: "open-atlas-deployer" },
    ],
  } as { system: string; tools: any[]; skills?: any[] };
  const refs = skillReferences([{ name: "nifi-ops", skill_id: "skill_9", version: "1762-abc", action: "unchanged" }]);
  attachSkills(agent, refs);
  attachSkills(agent, []);
  assert.deepEqual(agent.skills, [{ skill_id: "skill_9", type: "custom", version: "1762-abc" }]);
  assert.deepEqual(agent.tools[0], { type: "agent_toolset_20260401", default_config: { enabled: false }, configs: [{ name: "read", enabled: true }] });
  assert.equal(agent.system, "prompt");
});

test("§15.5: Skill files need OMA's frontmatter; the repository's Skills have it", () => {
  assert.deepEqual(skillFrontmatter(SKILL), { name: "nifi-ops", description: "Looking into NiFi." });
  const dir = mkdtempSync(join(tmpdir(), "skills-"));
  writeFileSync(join(dir, "a.md"), "# no frontmatter\n");
  assert.throws(() => readSkillSources(dir), /a\.md: the frontmatter needs a name/);
  writeFileSync(join(dir, "a.md"), "---\nname: A_B\ndescription: x\n---\n");
  assert.throws(() => readSkillSources(dir), /lowercase/);
  writeFileSync(join(dir, "a.md"), "---\nname: a\n---\n");
  assert.throws(() => readSkillSources(dir), /needs a description/);
  assert.deepEqual(readSkillSources(join(dir, "missing")), []);
  const repo = readSkillSources(join(import.meta.dirname, "..", "agents", "skills"));
  assert.deepEqual(repo.map((s) => s.name), ["nifi-ops"]);
  assert.ok(!/(?:password|secret|token)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']?[^\s,\]"'[(]/i.test(repo[0].content), "no text OMA's governance reads as a credential");
});
