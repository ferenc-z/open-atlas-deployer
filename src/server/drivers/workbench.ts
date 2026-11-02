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

export interface WorkbenchPlugin {
  id: string; kind?: string; name?: string; url?: string; enabled?: boolean;
  chat?: Record<string, unknown> & { embed?: boolean };
  visibility?: { mode: string; groupIds?: string[] } | null;
  linkedAgents?: { id: string; name: string; state: string; uses: string[] }[];
}
export interface WorkbenchGroup { id: string; name: string; enabled: boolean; memberCount?: number }

export class WorkbenchAdmin {
  private url: string;
  private key: () => string;
  private fetcher: typeof fetch;

  /** key: the file holding it, or (§15.6 ③) a function giving the key in use, the file's or the one pasted on the page. */
  constructor(url: string, key: string | undefined | (() => string), fetcher: typeof fetch = fetch) {
    this.url = url.replace(/\/+$/, "");
    this.key = typeof key === "function" ? key : () => readToken(key);
    this.fetcher = fetcher;
  }

  get configured(): boolean { return Boolean(this.key()); }

  private async request(method: string, path: string, body?: unknown, key = this.key()): Promise<any> {
    if (!key) throw new WorkbenchError("No Workbench API key is configured (paste one on the Setup page, or DEPLOYER_WORKBENCH_API_KEY_FILE)");
    let response: Response;
    try {
      response = await this.fetcher(`${this.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${key}`, accept: "application/json", ...(body !== undefined && !(body instanceof FormData) ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (error) { throw new WorkbenchError(`Cannot reach Workbench: ${(error as Error).message}`); }
    const text = await response.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!response.ok) {
      const f = json?.finding;
      throw new WorkbenchError(`Workbench refused ${method} ${path}: HTTP ${response.status}${f ? ` ${f.code} (${f.expected ?? ""})` : ""}`);
    }
    return json;
  }

  /** §15: the version Workbench runs (no sign-in needed), or undefined when it does not say. */
  async version(): Promise<string | undefined> {
    try {
      const response = await this.fetcher(`${this.url}/api/workbench/version`, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) return undefined;
      const v = ((await response.json()) as { version?: unknown }).version;
      return typeof v === "string" ? v : undefined;
    } catch { return undefined; }
  }

  /** Groups (roles in Workbench's API). With key, checks a key before it is kept. */
  async groups(key?: string): Promise<WorkbenchGroup[]> { return ((await this.request("GET", "/api/workbench/admin/roles", undefined, key)) as { roles: WorkbenchGroup[] }).roles; }
  async createGroup(name: string, description: string): Promise<WorkbenchGroup> { return ((await this.request("POST", "/api/workbench/admin/roles", { name, description })) as { role: WorkbenchGroup }).role; }

  async apps(): Promise<WorkbenchApp[]> { return ((await this.request("GET", "/api/workbench/admin/apps")) as { apps: WorkbenchApp[] }).apps; }
  /** §15.4 step 6: the plug-in manifest's entries (with visibility and linked agents), and the Deployer's own entry. */
  async plugins(): Promise<WorkbenchPlugin[]> { return ((await this.request("GET", "/api/workbench/admin/plugins")) as { plugins: WorkbenchPlugin[] }).plugins; }
  async putPlugin(id: string, entry: Record<string, unknown>) { return this.request("PUT", `/api/workbench/admin/plugins/${encodeURIComponent(id)}`, entry); }
  async setVisibility(id: string, groupIds: string[]) { return this.request("PUT", `/api/workbench/admin/plugins/${encodeURIComponent(id)}/visibility`, { mode: "granted", groupIds }); }

  async install(bytes: Buffer, filename: string): Promise<{ app: { id: string; version: string }; bound: Record<string, string> }> {
    const form = new FormData();
    form.append("package", new Blob([new Uint8Array(bytes)], { type: "application/gzip" }), filename);
    return this.request("POST", "/api/workbench/admin/apps/upload", form);
  }

  async switchVersion(id: string): Promise<{ version: string }> { return this.request("POST", `/api/workbench/admin/apps/${encodeURIComponent(id)}/switch-version`); }
  async setSettings(id: string, settings: Record<string, string>) { return this.request("PUT", `/api/workbench/admin/apps/${encodeURIComponent(id)}/settings`, settings); }
  /** A person as Workbench has them now (personal API keys, §9.4): enabled, administrator, the names of their enabled Groups. */
  async person(email: string): Promise<{ email: string; displayName: string; enabled: boolean; isAdmin: boolean; groups: string[] } | undefined> {
    const [users, roles] = await Promise.all([
      this.request("GET", "/api/workbench/admin/users") as Promise<{ users: { email: string; displayName?: string; enabled: boolean; isAdmin: boolean; roleIds?: string[] }[] }>,
      this.request("GET", "/api/workbench/admin/roles") as Promise<{ roles: { id: string; name: string; enabled: boolean }[] }>,
    ]);
    const u = users.users.find((x) => x.email.toLowerCase() === email.toLowerCase());
    if (!u) return undefined;
    const names = new Map(roles.roles.filter((r) => r.enabled).map((r) => [r.id, r.name]));
    return { email: u.email, displayName: u.displayName ?? u.email, enabled: u.enabled, isAdmin: u.isAdmin, groups: (u.roleIds ?? []).flatMap((id) => (names.has(id) ? [names.get(id)!] : [])) };
  }

  /** W3 (Workbench 1.25): the notice everyone signed in sees, e.g. before a deploy interrupts an app (§8.4). */
  async setMaintenance(message: string, startsAt: number, endsAt: number) { return this.request("PUT", "/api/workbench/admin/maintenance", { message, startsAt: new Date(startsAt).toISOString(), endsAt: new Date(endsAt).toISOString() }); }
  async clearMaintenance() { return this.request("DELETE", "/api/workbench/admin/maintenance"); }

  async businessAgents(): Promise<BusinessAgent[]> { return ((await this.request("GET", "/api/workbench/admin/business-agents")) as { agents: BusinessAgent[] }).agents; }
  async pointAgent(id: string, agentId: string) { return this.request("PATCH", `/api/workbench/admin/business-agents/${encodeURIComponent(id)}`, { agentId }); }
}
