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
import { readToken } from "../versions.ts";
import { block, fill, note, type DeployDriver, type StepContext, type StepResult, type Undo } from "./types.ts";
import type { WorkbenchAdmin } from "./workbench.ts";

function fillDeep(value: unknown, values: Record<string, string>, missing: Set<string>): unknown {
  if (typeof value === "string") { const r = fill(value, values); r.missing.forEach((m) => missing.add(m)); return r.text; }
  if (Array.isArray(value)) return value.map((v) => fillDeep(v, values, missing));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillDeep(v, values, missing)]));
  return value;
}

export interface OmaApi { url: string; keyFile: string | undefined }

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
    if (!path) throw new Error(`组件 ${ctx.component.id} 没有 package：Agent 包的定义由 Deployer 保存（templates/ 里的 JSON）`);
    const rel = normalize(path.replace(/^templates\//, ""));
    if (rel.startsWith("..")) throw new Error(`package ${path} 不在 templates/ 里`);
    const template = JSON.parse(readFileSync(join(this.templatesDir, rel), "utf8"));
    const system = bundleText(ctx.bundle, String(ctx.component.file));
    const missing = new Set<string>();
    const manifest = fillDeep(template, { ...ctx.settings, system, app: ctx.app, version: ctx.version }, missing) as Record<string, any>;
    if (!Array.isArray(manifest.agents) || manifest.agents.length !== 1) throw new Error(`${path} 要正好定义一个 Agent`);
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
      if (m.missing.length) findings.push(block("oma-agent/settings", `Agent 包要用 ${m.missing.map((x) => `{{${x}}}`).join("、")}：在 environment.json 的 apps.${ctx.app}.settings.${ctx.component.id} 里设置。`));
    } catch (error) { findings.push(block("oma-agent/package", (error as Error).message)); }
    if (!this.builder) findings.push(block("oma-agent/builder", "没有配置 OMA Builder MCP（DEPLOYER_OMA_BUILDER_URL、DEPLOYER_OMA_BUILDER_KEY_FILE）。"));
    if (!this.workbench.configured) findings.push(block("oma-agent/workbench-key", "没有配置 Workbench API key，发布后无法把 Business Agent 指向新 agent。"));
    const last = ctx.state.get<string>("agentId");
    const after = `发布 ${name} 的新修订（模型 ${ctx.settings.model ?? "—"}），Business Agent 指向新 agent`;
    if (this.workbench.configured) {
      try {
        if (!(await this.bound(ctx)).length) findings.push(note("oma-agent/unbound", `Workbench 应用 ${ctx.component.bind ?? ctx.app} 的 Agent slot 还没有绑定 Business Agent：发布后要按首次安装步骤建 Business Agent 并绑定。`));
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
    if (validation?.valid === false) throw new Error(`OMA 校验 Agent 包不通过：${JSON.stringify(validation).slice(0, 400)}`);
    const published = await builder.call("publish_package", { package_id: packageId });
    const agentId = String(published?.agents?.[0]?.agent_id ?? "");
    if (!agentId) throw new Error(`OMA 发布后没有返回 agent id：${JSON.stringify(published).slice(0, 300)}`);
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
      message: `OMA 发布了新 agent ${agentId}${moved.length ? `，${moved.length} 个 Business Agent 已指向它` : "；还没有绑定的 Business Agent，请按首次安装步骤建好"}${archived ? `，归档了 ${archived} 个更早的 agent` : ""}`,
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
    return wrong.length ? `Business Agent ${wrong.map((w) => w.id).join("、")} 没有指向 ${result.detail.agentId}` : null;
  }

  async rollback(ctx: StepContext, result: StepResult): Promise<Undo> {
    const moved = (result.detail.moved ?? []) as { id: string; previousAgentId: string }[];
    for (const m of moved) await this.workbench.pointAgent(m.id, m.previousAgentId);
    if (result.detail.previous) ctx.state.set("agentId", result.detail.previous);
    return moved.length ? { message: `${moved.length} 个 Business Agent 指回原来的 agent（新 agent ${result.detail.agentId} 留在 OMA 里）`, undone: true }
      : { message: `新 agent ${result.detail.agentId} 留在 OMA 里，没有 Business Agent 指向它`, undone: true };
  }

  impact(_component: Component): string { return "不中断：之后新开的对话用新的 Agent"; }
}
