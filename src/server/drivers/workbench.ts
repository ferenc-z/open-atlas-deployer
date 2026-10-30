// Workbench's Administration API as the Deployer uses it (phase 5). The key is an API key from Workbench's
// Administration → API keys (owner 2026-10-30: used instead of W2 for now): it counts as an administrator on
// /api/workbench/admin/*. Workbench's own audit names the key; the Deployer's audit names the person who deployed.

import { readToken } from "../versions.ts";

export class WorkbenchError extends Error {}

export interface WorkbenchApp {
  id: string;
  version: string;
  previousVersion?: string;
  agentSlots?: Record<string, { name?: string; businessAgentId: string | null }>;
}

export interface BusinessAgent { id: string; name: string; agentId: string; enabled: boolean }

export class WorkbenchAdmin {
  private url: string;
  private keyFile: string | undefined;
  private fetcher: typeof fetch;

  constructor(url: string, keyFile: string | undefined, fetcher: typeof fetch = fetch) {
    this.url = url.replace(/\/+$/, "");
    this.keyFile = keyFile;
    this.fetcher = fetcher;
  }

  get configured(): boolean { return Boolean(readToken(this.keyFile)); }

  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const key = readToken(this.keyFile);
    if (!key) throw new WorkbenchError("没有配置 Workbench API key（DEPLOYER_WORKBENCH_API_KEY_FILE）");
    let response: Response;
    try {
      response = await this.fetcher(`${this.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${key}`, accept: "application/json", ...(body !== undefined && !(body instanceof FormData) ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (error) { throw new WorkbenchError(`连不上 Workbench：${(error as Error).message}`); }
    const text = await response.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!response.ok) {
      const f = json?.finding;
      throw new WorkbenchError(`Workbench 拒绝了 ${method} ${path}：HTTP ${response.status}${f ? ` ${f.code}（${f.expected ?? ""}）` : ""}`);
    }
    return json;
  }

  async apps(): Promise<WorkbenchApp[]> { return ((await this.request("GET", "/api/workbench/admin/apps")) as { apps: WorkbenchApp[] }).apps; }

  async install(bytes: Buffer, filename: string): Promise<{ app: { id: string; version: string }; bound: Record<string, string> }> {
    const form = new FormData();
    form.append("package", new Blob([new Uint8Array(bytes)], { type: "application/gzip" }), filename);
    return this.request("POST", "/api/workbench/admin/apps/upload", form);
  }

  async switchVersion(id: string): Promise<{ version: string }> { return this.request("POST", `/api/workbench/admin/apps/${encodeURIComponent(id)}/switch-version`); }
  async setSettings(id: string, settings: Record<string, string>) { return this.request("PUT", `/api/workbench/admin/apps/${encodeURIComponent(id)}/settings`, settings); }
  async businessAgents(): Promise<BusinessAgent[]> { return ((await this.request("GET", "/api/workbench/admin/business-agents")) as { agents: BusinessAgent[] }).agents; }
  async pointAgent(id: string, agentId: string) { return this.request("PATCH", `/api/workbench/admin/business-agents/${encodeURIComponent(id)}`, { agentId }); }
}
