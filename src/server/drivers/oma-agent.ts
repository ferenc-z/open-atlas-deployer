// oma-agent (§4.2): publish the next revision of the app's OMA Agent Package through OMA's Builder MCP, then point
// the Business Agents bound to the app's slots at the new agent id (Workbench API key). The package definition is
// kept by the Deployer (manifest field `package`, templates directory; owner 2026-10-30) because apps keep it in
// their publish scripts; its strings may name {{system}} (the prompt file from the bundle) and this environment's
// settings ({{model}}, the data-plane MCP URL, …). Each publish leaves a new agent id; older ones are archived
// through OMA's API when its key is configured, keeping the one before for a rollback.

import { readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import type { Component } from "../../compose/generate.ts";
import { bundleText } from "../bundle.ts";
import type { McpClient } from "../mcp-client.ts";
import { readToken, type TokenSource } from "../versions.ts";
import { block, fill, note, type DeployDriver, type StepContext, type StepResult, type Undo } from "./types.ts";
import type { WorkbenchAdmin } from "./workbench.ts";

function fillDeep(value: unknown, values: Record<string, string>, missing: Set<string>): unknown {
  if (typeof value === "string") { const r = fill(value, values); r.missing.forEach((m) => missing.add(m)); return r.text; }
  if (Array.isArray(value)) return value.map((v) => fillDeep(v, values, missing));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillDeep(v, values, missing)]));
  return value;
}

export interface OmaApi { url: string; keyFile: TokenSource }

export class OmaAgentDriver implements DeployDriver {
  readonly type = "oma-agent";
  private builder: McpClient | undefined;
  private workbench: WorkbenchAdmin;
  private templatesDir: string;
  private api: OmaApi | undefined;
  private fetcher: typeof fetch;

  constructor(builder: McpClient | undefined, workbench: WorkbenchAdmin, templatesDir: string, api?: OmaApi, fetcher: typeof fetch = fetch) {
    this.builder = builder;
    this.workbench = workbench;
    this.templatesDir = templatesDir;
    this.api = api;
    this.fetcher = fetcher;
  }

  private manifest(ctx: StepContext): { manifest: Record<string, any>; missing: string[] } {
    const path = ctx.component.package as string | undefined;
    if (!path) throw new Error(`Component ${ctx.component.id} has no package: the Deployer keeps agent package definitions (JSON in templates/)`);
    const rel = normalize(path.replace(/^templates\//, ""));
    if (rel.startsWith("..")) throw new Error(`package ${path} is outside templates/`);
    const template = JSON.parse(readFileSync(join(this.templatesDir, rel), "utf8"));
    const system = bundleText(ctx.bundle, String(ctx.component.file));
    const missing = new Set<string>();
    const manifest = fillDeep(template, { ...ctx.settings, system, app: ctx.app, version: ctx.version }, missing) as Record<string, any>;
    if (!Array.isArray(manifest.agents) || manifest.agents.length !== 1) throw new Error(`${path} must define exactly one agent`);
    return { manifest, missing: [...missing] };
  }

  /** The Business Agents bound to the slots of the Workbench app the agent belongs to. */
  private async bound(ctx: StepContext): Promise<string[]> {
    const appId = String(ctx.component.bind ?? ctx.app);
    const app = (await this.workbench.apps()).find((a) => a.id === appId);
    return [...new Set(Object.values(app?.agentSlots ?? {}).flatMap((s) => (s.businessAgentId ? [s.businessAgentId] : [])))];
  }

  async plan(ctx: StepContext) {
    const findings = [];
    let name = "—";
    try {
      const m = this.manifest(ctx);
      name = String(m.manifest.agents[0].name);
      if (m.missing.length) findings.push(block("oma-agent/settings", `The agent package uses ${m.missing.map((x) => `{{${x}}}`).join(", ")}: set them in apps.${ctx.app}.settings.${ctx.component.id} in environment.json.`));
    } catch (error) { findings.push(block("oma-agent/package", (error as Error).message)); }
    if (!this.builder) findings.push(block("oma-agent/builder", "The OMA Builder MCP is not configured (DEPLOYER_OMA_BUILDER_URL, DEPLOYER_OMA_BUILDER_KEY_FILE)."));
    if (!this.workbench.configured) findings.push(block("oma-agent/workbench-key", "No Workbench API key is configured, so after publishing the Business Agent cannot be pointed at the new agent."));
    const last = ctx.state.get<string>("agentId");
    const after = `Publish a new revision of ${name} (model ${ctx.settings.model ?? "—"}) and point the Business Agent at the new agent`;
    if (this.workbench.configured) {
      try {
        if (!(await this.bound(ctx)).length) findings.push(note("oma-agent/unbound", `The agent slot of Workbench app ${ctx.component.bind ?? ctx.app} has no Business Agent bound yet: after publishing, create and bind a Business Agent as in the first-install steps.`));
      } catch (error) { findings.push(block("oma-agent/unreachable", (error as Error).message)); }
    }
    return { ...(last ? { before: `agent ${last}` } : {}), after, findings };
  }

  async apply(ctx: StepContext): Promise<StepResult> {
    const builder = this.builder!;
    const { manifest } = this.manifest(ctx);
    let packageId = ctx.state.get<string>("packageId");
    if (!packageId) {
      const draft = await builder.call("create_package_draft", manifest);
      packageId = String(draft.package_id ?? draft.id);
      ctx.state.set("packageId", packageId);
      ctx.log(`OMA: package draft ${packageId} created`);
    }
    await builder.call("update_package_manifest", { package_id: packageId, ...manifest });
    const validation = await builder.call("validate_package", { package_id: packageId });
    if (validation?.valid === false) throw new Error(`OMA rejected the agent package: ${JSON.stringify(validation).slice(0, 400)}`);
    const published = await builder.call("publish_package", { package_id: packageId });
    const agentId = String(published?.agents?.[0]?.agent_id ?? "");
    if (!agentId) throw new Error(`OMA returned no agent id after publishing: ${JSON.stringify(published).slice(0, 300)}`);
    const previous = ctx.state.get<string>("agentId") ?? null;
    ctx.state.set("agentId", agentId);
    ctx.log(`OMA: package ${packageId} revision ${published.revision ?? "?"} published as agent ${agentId}`);
    const agents = await this.workbench.businessAgents();
    const moved: { id: string; previousAgentId: string }[] = [];
    for (const id of await this.bound(ctx)) {
      const ba = agents.find((a) => a.id === id);
      if (!ba || ba.agentId === agentId) continue;
      await this.workbench.pointAgent(id, agentId);
      moved.push({ id, previousAgentId: ba.agentId });
      ctx.log(`Workbench: Business Agent ${ba.name} now points at ${agentId} (was ${ba.agentId})`);
    }
    const archived = await this.archive(String(manifest.agents[0].name), new Set([agentId, previous ?? "", ...moved.map((m) => m.previousAgentId)]), ctx);
    return {
      message: `OMA published new agent ${agentId}${moved.length ? `; ${moved.length} Business Agents now point at it` : "; no Business Agent is bound yet, create one as in the first-install steps"}${archived ? `; archived ${archived} older agents` : ""}`,
      detail: { packageId, agentId, previous, moved },
    };
  }

  /** Older agents of the same name, except the new one and the ones Business Agents pointed at until now. */
  private async archive(name: string, keep: Set<string>, ctx: StepContext): Promise<number> {
    const key = readToken(this.api?.keyFile);
    if (!this.api || !key) { ctx.log("OMA: no OMA API key configured, older agents were not archived"); return 0; }
    const headers = { "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-beta": "managed-agents-2026-04-01", "content-type": "application/json" };
    const base = this.api.url.replace(/\/+$/, "");
    try {
      const list = (await (await this.fetcher(`${base}/v1/agents?limit=100`, { headers, signal: AbortSignal.timeout(30_000) })).json()) as { data: { id: string; name?: string; archived_at?: string | null }[] };
      let n = 0;
      for (const a of list.data ?? []) {
        if (a.name !== name || a.archived_at || keep.has(a.id)) continue;
        await this.fetcher(`${base}/v1/agents/${encodeURIComponent(a.id)}/archive`, { method: "POST", headers, body: "{}", signal: AbortSignal.timeout(30_000) });
        n++;
      }
      return n;
    } catch (error) { ctx.log(`OMA: archiving older agents failed: ${(error as Error).message}`); return 0; }
  }

  async verify(_ctx: StepContext, result: StepResult): Promise<string | null> {
    const moved = (result.detail.moved ?? []) as { id: string }[];
    if (!moved.length) return null;
    const agents = await this.workbench.businessAgents();
    const wrong = moved.filter((m) => agents.find((a) => a.id === m.id)?.agentId !== result.detail.agentId);
    return wrong.length ? `Business Agents ${wrong.map((w) => w.id).join(", ")} do not point at ${result.detail.agentId}` : null;
  }

  async rollback(ctx: StepContext, result: StepResult): Promise<Undo> {
    const moved = (result.detail.moved ?? []) as { id: string; previousAgentId: string }[];
    for (const m of moved) await this.workbench.pointAgent(m.id, m.previousAgentId);
    if (result.detail.previous) ctx.state.set("agentId", result.detail.previous);
    return moved.length ? { message: `${moved.length} Business Agents point back at the previous agent (new agent ${result.detail.agentId} stays in OMA)`, undone: true }
      : { message: `New agent ${result.detail.agentId} stays in OMA; no Business Agent points at it`, undone: true };
  }

  impact(_component: Component): string { return "No interruption: new conversations use the new agent"; }
}
