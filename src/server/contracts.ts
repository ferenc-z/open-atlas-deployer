// Contract check before a deploy (§6.4): the version's provides / requires (from the app's release.json or
// package.json at its tag) against the versions the other apps actually run here. Both ways: what this version
// requires must be provided, and what the others require must still be provided after it.

import { readToken } from "./versions.ts";

export interface ContractDoc { provides: Record<string, string>; requires: Record<string, string> }
export interface Running { app: string; version: string; doc: ContractDoc | null; error?: string }

const parts = (v: string) => v.replace(/^[^\d]*/, "").split(/[.-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
const cmp = (a: number[], b: number[]) => { for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0); return 0; };

/** "^1.3", "~1.3", ">=1.2", "1.5", "1", "*" against a provided contract version such as "1.5" or "2.0.0". */
export function satisfies(provided: string, range: string): boolean {
  const r = range.trim();
  if (r === "*" || r === "") return true;
  const p = parts(provided);
  if (r.startsWith(">=")) return cmp(p, parts(r.slice(2))) >= 0;
  const want = parts(r);
  if (r.startsWith("^")) return p[0] === want[0] && cmp(p, want) >= 0;
  if (r.startsWith("~")) return p[0] === want[0] && p[1] === want[1] && cmp(p, want) >= 0;
  // A bare version names that line: "1" is any 1.x, "1.5" any 1.5.x.
  const given = r.split(".").length;
  return want.slice(0, given).every((x, i) => p[i] === x);
}

export interface ContractResult { unmet: string[]; unknown: string[] }

export function checkContracts(app: string, version: string, doc: ContractDoc, others: Running[]): ContractResult {
  const unmet: string[] = [];
  const unknown: string[] = [];
  const known = others.filter((o) => o.doc);
  for (const [name, range] of Object.entries(doc.requires)) {
    const providers = known.filter((o) => o.doc!.provides[name] !== undefined);
    if (!providers.length) { unknown.push(`${app} ${version} requires ${name} ${range}, but no registered app in this environment provides it${others.some((o) => !o.doc) ? " (some apps' contracts could not be read)" : ""}`); continue; }
    for (const o of providers) {
      if (!satisfies(o.doc!.provides[name]!, range)) unmet.push(`${app} ${version} requires ${name} ${range}, but ${o.app} ${o.version} provides ${o.doc!.provides[name]}`);
    }
  }
  for (const o of known) {
    for (const [name, range] of Object.entries(o.doc!.requires)) {
      const provided = doc.provides[name];
      if (provided === undefined) continue;
      if (!satisfies(provided, range)) unmet.push(`${o.app} ${o.version} requires ${name} ${range}, but ${app} ${version} provides ${provided}`);
    }
  }
  return { unmet, unknown };
}

/** release.json / package.json at a tag; tags do not move, so an answer is kept for good. */
export class ContractDocs {
  private cache = new Map<string, ContractDoc>();
  private tokenFile: string | undefined;
  private fetcher: typeof fetch;
  private api: string;

  constructor(tokenFile: string | undefined, fetcher: typeof fetch = fetch, api = "https://api.github.com") {
    this.tokenFile = tokenFile;
    this.fetcher = fetcher;
    this.api = api.replace(/\/+$/, "");
  }

  async get(repo: string, tag: string, path: string): Promise<ContractDoc> {
    const key = `${repo}@${tag}:${path}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const token = readToken(this.tokenFile);
    let response: Response;
    try {
      response = await this.fetcher(`${this.api}/repos/${repo}/contents/${path}?ref=${encodeURIComponent(tag)}`, {
        headers: { accept: "application/vnd.github.raw", "user-agent": "open-atlas-deployer", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(8_000),
      });
    } catch (error) { throw new Error(`Cannot reach GitHub: ${(error as Error).message}`); }
    if (!response.ok) throw new Error(`Cannot read ${path} of ${repo}@${tag} (HTTP ${response.status})`);
    const body = JSON.parse(await response.text()) as Partial<ContractDoc>;
    const doc = { provides: body.provides ?? {}, requires: body.requires ?? {} };
    this.cache.set(key, doc);
    return doc;
  }
}
