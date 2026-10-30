// studio-graph (§4.2): upload the graph's Semantic Contract, save the saved queries, publish — through Studio's
// Builder MCP with a workspace token (oaw_v1., read + write). The contract EDN is kept by the Deployer (manifest
// field `contract`, templates directory; owner 2026-10-30), because an app may ship only a generator for it. Its own
// workspace and graph ids (from :workspace/id and :graph/id) are replaced everywhere they occur — the graph id also
// keys :ownership — by the target graph's, read from that graph's draft. The graph itself
// (create_graph, its Source) is made once per environment by a person, as the first-install steps say.

import { readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import type { Component } from "../../compose/generate.ts";
import { bundleText } from "../bundle.ts";
import type { McpClient } from "../mcp-client.ts";
import { block, type DeployDriver, type StepContext, type StepResult, type Undo } from "./types.ts";

const WORKSPACE = /(:workspace\/id\s+)"((?:[^"\\]|\\.)*)"/;
const GRAPH = /(:graph\/id\s+)"((?:[^"\\]|\\.)*)"/;

interface SavedQuery { name: string; description: string; params?: unknown[]; eql: string }

export class StudioGraphDriver implements DeployDriver {
  readonly type = "studio-graph";
  private studio: McpClient | undefined;
  private templatesDir: string;

  constructor(studio: McpClient | undefined, templatesDir: string) {
    this.studio = studio;
    this.templatesDir = templatesDir;
  }

  private contract(ctx: StepContext): { text: string; workspace: string; graph: string } {
    const path = ctx.component.contract as string | undefined;
    if (!path) throw new Error(`组件 ${ctx.component.id} 没有 contract：图的定义由 Deployer 保存（templates/ 里的 EDN）`);
    const rel = normalize(path.replace(/^templates\//, ""));
    if (rel.startsWith("..")) throw new Error(`contract ${path} 不在 templates/ 里`);
    const text = readFileSync(join(this.templatesDir, rel), "utf8");
    const workspace = text.match(WORKSPACE)?.[2];
    const graph = text.match(GRAPH)?.[2];
    if (!workspace || !graph) throw new Error(`${path} 里没有 :workspace/id 或 :graph/id`);
    return { text, workspace, graph };
  }

  private queries(ctx: StepContext): SavedQuery[] {
    const path = ctx.component.savedQueries as string | undefined;
    if (!path) return [];
    const list = JSON.parse(bundleText(ctx.bundle, path)) as SavedQuery[];
    if (!Array.isArray(list) || list.some((q) => !q?.name || !q.eql)) throw new Error(`${path} 不是 saved query 列表`);
    return list;
  }

  async plan(ctx: StepContext) {
    const findings = [];
    const graph = ctx.settings.graph;
    if (!graph) findings.push(block("studio-graph/graph", `environment.json 里没有 apps.${ctx.app}.settings.${ctx.component.id}.graph（这个环境的 Studio 图名）。`));
    let queries: SavedQuery[] = [];
    try { this.contract(ctx); queries = this.queries(ctx); } catch (error) { findings.push(block("studio-graph/contract", (error as Error).message)); }
    const after = `上传 ${ctx.component.contract ?? "—"}，存 ${queries.length} 条 saved queries，发布`;
    if (!this.studio) return { after, findings: [...findings, block("studio-graph/token", "没有配置 Studio Builder MCP（DEPLOYER_STUDIO_BUILDER_URL、DEPLOYER_STUDIO_TOKEN_FILE）。")] };
    if (!graph) return { after, findings };
    try {
      const draft = await this.studio.call("get_graph", { graph });
      return { before: `${graph} 草稿第 ${draft.revision ?? 0} 版`, after, findings };
    } catch (error) {
      return { after, findings: [...findings, block("studio-graph/unreachable", `读不到 Studio 图 ${graph}：${(error as Error).message}。图要先在这个环境的 Studio 里建好。`)] };
    }
  }

  async apply(ctx: StepContext): Promise<StepResult> {
    const graph = ctx.settings.graph!;
    const studio = this.studio!;
    const draft = await studio.call("get_graph", { graph });
    const current = String(draft.text ?? "");
    const ws = current.match(WORKSPACE)?.[2];
    const gid = current.match(GRAPH)?.[2];
    if (!ws || !gid) throw new Error(`图 ${graph} 的草稿里读不到 workspace id 或 graph id`);
    const contract = this.contract(ctx);
    const text = contract.text.split(`"${contract.workspace}"`).join(`"${ws}"`).split(`"${contract.graph}"`).join(`"${gid}"`);
    const saved = await studio.call("upload_graph", { graph, text, expected_revision: Number(draft.revision ?? 0) });
    ctx.log(`Studio: ${graph} draft saved (revision ${saved?.revision ?? "?"})`);
    const queries = this.queries(ctx);
    for (const q of queries) await studio.call("save_saved_query", { graph, name: q.name, description: q.description, eql: q.eql, ...(q.params ? { params: q.params } : {}) });
    if (queries.length) ctx.log(`Studio: ${queries.length} saved queries saved`);
    const published = await studio.call("publish_graph", { graph, apply: true });
    const version = published?.version ?? published?.["to-version"] ?? published?.to_version ?? null;
    ctx.log(`Studio: ${graph} published${version != null ? ` as version ${version}` : ""}`);
    return { message: `Studio 图 ${graph} 已上传、存了 ${queries.length} 条 saved queries 并发布${version != null ? `（第 ${version} 版）` : ""}`, detail: { graph, revision: saved?.revision ?? null, version } };
  }

  async verify(): Promise<string | null> { return null; }

  async rollback(_ctx: StepContext, result: StepResult): Promise<Undo> {
    return { message: `Studio 图 ${result.detail.graph} 保持新发布的版本（需要时在 Studio 里发布回旧版本）`, undone: false };
  }

  impact(_component: Component): string { return "不中断：发布后新的查询立即生效"; }
}
