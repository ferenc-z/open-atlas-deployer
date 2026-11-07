// The Deploy Assistant's Skills (agents/skills/*.md) kept in OMA as Skills of their own (service ops §15.5, owner
// 2026-11-07): bin/publish-assistant.ts creates each one, or adds a version when its text changed, through OMA's Skills
// API (POST /v1/skills, POST /v1/skills/:id/versions; OMA's Builder MCP can create a Skill but not add a version), then
// the package references the concrete versions instead of pasting the text into `system`.
//
// A Skill file is one SKILL.md with frontmatter `name` (lowercase, OMA's name rule) and `description`; OMA refuses an
// upload without them. Unchanged text makes no new version: the latest version's SKILL.md is read back and compared.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SkillSource { name: string; file: string; content: string }
export interface PublishedSkill { name: string; skill_id: string; version: string; action: "created" | "updated" | "unchanged" }
export interface SkillReference { skill_id: string; type: "custom"; version: string }

const NAME = /^[a-z0-9-]{1,64}$/;

/** The frontmatter's name and description, as OMA reads them (simple `key: value` lines between two `---`). */
export function skillFrontmatter(content: string): { name?: string; description?: string } {
  const block = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  if (!block) return {};
  const out: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const kv = line.match(/^\s*([\w-]+)\s*:\s*(.+?)\s*$/);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return { name: out.name, description: out.description };
}

/** agents/skills/*.md in name order; each must carry a valid name and a description. */
export function readSkillSources(dir: string): SkillSource[] {
  let files: string[];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort(); } catch { return []; }
  return files.map((file) => {
    const content = readFileSync(join(dir, file), "utf8");
    const { name, description } = skillFrontmatter(content);
    if (!name || !NAME.test(name)) throw new Error(`${file}: the frontmatter needs a name of lowercase letters, digits and hyphens`);
    if (!description) throw new Error(`${file}: the frontmatter needs a description`);
    return { name, file, content };
  });
}

export class OmaSkills {
  private url: string;
  private key: string;
  private fetcher: typeof fetch;

  constructor(url: string, key: string, fetcher: typeof fetch = fetch) {
    this.url = url.replace(/\/+$/, "");
    this.key = key;
    this.fetcher = fetcher;
  }

  private async call(method: string, path: string, body?: unknown): Promise<any> {
    const response = await this.fetcher(`${this.url}${path}`, {
      method,
      headers: { "x-api-key": this.key, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok) {
      let detail = "";
      try { const parsed = JSON.parse(text); detail = typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? ""; } catch { /* not JSON */ }
      throw new Error(`OMA ${method} ${path.split("?")[0]} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    return text ? JSON.parse(text) : {};
  }

  /** The workspace's custom Skill with this name; `known` (an id from the state file) is tried first. */
  private async find(name: string, known?: string): Promise<{ id: string; latest_version: string } | null> {
    if (known) {
      try {
        const skill = await this.call("GET", `/v1/skills/${encodeURIComponent(known)}`);
        if (skill?.name === name && skill.source === "custom") return skill;
      } catch { /* deleted or another workspace: look it up by name */ }
    }
    const list = await this.call("GET", "/v1/skills?source=custom");
    const matches = (list?.data ?? []).filter((s: any) => s?.name === name && s.source === "custom");
    // Several with the same name (made by hand): the most recently updated one.
    matches.sort((a: any, b: any) => String(b.updated_at ?? b.created_at ?? "").localeCompare(String(a.updated_at ?? a.created_at ?? "")));
    return matches[0] ?? null;
  }

  /** Creates the Skill, adds a version when SKILL.md changed, or leaves it; returns the version to reference. */
  async ensure(source: SkillSource, known?: string): Promise<PublishedSkill> {
    const files = [{ filename: "SKILL.md", content: source.content, encoding: "utf8" }];
    const existing = await this.find(source.name, known);
    if (!existing) {
      const created = await this.call("POST", "/v1/skills", { files, name: source.name });
      return { name: source.name, skill_id: String(created.id), version: String(created.latest_version), action: "created" };
    }
    const latest = await this.call("GET", `/v1/skills/${encodeURIComponent(existing.id)}/versions/${encodeURIComponent(existing.latest_version)}`);
    const current = (latest?.files ?? []).find((f: any) => f?.filename === "SKILL.md");
    const same = (latest?.files ?? []).length === 1 && current?.encoding !== "base64" && current?.content === source.content;
    if (same) return { name: source.name, skill_id: existing.id, version: existing.latest_version, action: "unchanged" };
    const version = await this.call("POST", `/v1/skills/${encodeURIComponent(existing.id)}/versions`, { files });
    return { name: source.name, skill_id: existing.id, version: String(version.version), action: "updated" };
  }
}

/** The package's references: concrete versions, so a later Skill change needs a new agent version (OMA's rule). */
export function skillReferences(published: PublishedSkill[]): SkillReference[] {
  return published.map((s) => ({ skill_id: s.skill_id, type: "custom", version: s.version }));
}

/**
 * Puts the references on the agent. OMA gives the model only a summary of a custom Skill and the path of its SKILL.md
 * in the sandbox (unless OMA runs with OMA_SKILL_EAGER_PROMPT=1), so the agent, whose sandbox tools are off, gets the
 * `read` tool alone to open it.
 */
export function attachSkills(agent: { skills?: SkillReference[]; tools?: any[] }, refs: SkillReference[]): void {
  if (!refs.length) return;
  agent.skills = [...(agent.skills ?? []), ...refs];
  const toolset = agent.tools?.find((t) => t?.type === "agent_toolset_20260401");
  if (toolset && toolset.default_config?.enabled === false) {
    const configs = (toolset.configs ?? []).filter((c: any) => c?.name !== "read");
    toolset.configs = [...configs, { name: "read", enabled: true }];
  }
}
