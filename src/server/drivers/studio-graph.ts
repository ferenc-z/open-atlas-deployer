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

/**
 * What studio-graph does to a graph that exists in Studio: read its draft for the workspace and graph ids, put them in
 * the contract in place of the contract's own, upload it at the draft's revision, save the saved queries, publish.
 * Also used for the generated nifi-ops graph (services/graph.ts).
 */
export async function publishContract(studio: McpClient, graph: string, contractText: string, log: (line: string) => void, queries: SavedQuery[] = []): Promise<{ revision: number | null; version: number | null }> {
  const own = { workspace: contractText.match(WORKSPACE)?.[2], graph: contractText.match(GRAPH)?.[2] };
  if (!own.workspace || !own.graph) throw new Error("The contract has no :workspace/id or :graph/id");
  const draft = await studio.call("get_graph", { graph });
  const current = String(draft.text ?? "");
  const ws = current.match(WORKSPACE)?.[2];
  const gid = current.match(GRAPH)?.[2];
  if (!ws || !gid) throw new Error(`Cannot read the workspace id or graph id from the draft of graph ${graph}`);
  const text = contractText.split(`"${own.workspace}"`).join(`"${ws}"`).split(`"${own.graph}"`).join(`"${gid}"`);
  const saved = await studio.call("upload_graph", { graph, text, expected_revision: Number(draft.revision ?? 0) });
  if (saved?.findings?.length) throw new Error(`Studio refused the contract: ${JSON.stringify(saved.findings).slice(0, 600)}`);
  log(`Studio: ${graph} draft saved (revision ${saved?.revision ?? "?"})`);
  for (const q of queries) await studio.call("save_saved_query", { graph, name: q.name, description: q.description, eql: q.eql, ...(q.params ? { params: q.params } : {}) });
  if (queries.length) log(`Studio: ${queries.length} saved queries saved`);
  const published = await studio.call("publish_graph", { graph, apply: true });
  if (published?.findings?.some((f: { severity?: string }) => f.severity !== "info" && f.severity !== "warning")) throw new Error(`Studio did not publish ${graph}: ${JSON.stringify(published.findings).slice(0, 600)}`);
  const version = published?.version ?? published?.["to-version"] ?? published?.to_version ?? null;
  log(`Studio: ${graph} published${version != null ? ` as version ${version}` : ""}`);
  return { revision: saved?.revision ?? null, version };
}

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
    if (!path) throw new Error(`Component ${ctx.component.id} has no contract: the Deployer keeps graph definitions (EDN in templates/)`);
    const rel = normalize(path.replace(/^templates\//, ""));
    if (rel.startsWith("..")) throw new Error(`contract ${path} is outside templates/`);
    const text = readFileSync(join(this.templatesDir, rel), "utf8");
    const workspace = text.match(WORKSPACE)?.[2];
    const graph = text.match(GRAPH)?.[2];
    if (!workspace || !graph) throw new Error(`${path} has no :workspace/id or :graph/id`);
    return { text, workspace, graph };
  }

  private queries(ctx: StepContext): SavedQuery[] {
    const path = ctx.component.savedQueries as string | undefined;
    if (!path) return [];
    const list = JSON.parse(bundleText(ctx.bundle, path)) as SavedQuery[];
    if (!Array.isArray(list) || list.some((q) => !q?.name || !q.eql)) throw new Error(`${path} is not a list of saved queries`);
    return list;
  }

  async plan(ctx: StepContext) {
    const findings = [];
    const graph = ctx.settings.graph;
    if (!graph) findings.push(block("studio-graph/graph", `environment.json has no apps.${ctx.app}.settings.${ctx.component.id}.graph (the Studio graph name in this environment).`));
    let queries: SavedQuery[] = [];
    try { this.contract(ctx); queries = this.queries(ctx); } catch (error) { findings.push(block("studio-graph/contract", (error as Error).message)); }
    const after = `Upload ${ctx.component.contract ?? "—"}, save ${queries.length} saved queries, publish`;
    if (!this.studio) return { after, findings: [...findings, block("studio-graph/token", "The Studio Builder MCP is not configured (DEPLOYER_STUDIO_BUILDER_URL, DEPLOYER_STUDIO_TOKEN_FILE).")] };
    if (!graph) return { after, findings };
    try {
      const draft = await this.studio.call("get_graph", { graph });
      return { before: `${graph} draft revision ${draft.revision ?? 0}`, after, findings };
    } catch (error) {
      return { after, findings: [...findings, block("studio-graph/unreachable", `Cannot read Studio graph ${graph}: ${(error as Error).message}. Create the graph in this environment's Studio first.`)] };
    }
  }

  async apply(ctx: StepContext): Promise<StepResult> {
    const graph = ctx.settings.graph!;
    const contract = this.contract(ctx);
    const queries = this.queries(ctx);
    const { revision, version } = await publishContract(this.studio!, graph, contract.text, ctx.log, queries);
    return { message: `Studio graph ${graph} uploaded, ${queries.length} saved queries saved, and published${version != null ? ` (version ${version})` : ""}`, detail: { graph, revision, version } };
  }

  async verify(): Promise<string | null> { return null; }

  async rollback(_ctx: StepContext, result: StepResult): Promise<Undo> {
    return { message: `Studio graph ${result.detail.graph} keeps the newly published version (publish the old version again in Studio if needed)`, undone: false };
  }

  impact(_component: Component): string { return "No interruption: new queries take effect once published"; }
}
