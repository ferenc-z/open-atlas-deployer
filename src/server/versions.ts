// Versions an app can be deployed at: the release repo's tags that match the manifest's tag pattern
// (e.g. studio-{version}), newest first. Read-only GitHub API; a token is needed for private repos.

import { readFileSync } from "node:fs";
import { compareVersions } from "../manifest/version.ts";

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function versionsFromTags(tags: string[], pattern: string): string[] {
  const [prefix, suffix] = pattern.split("{version}") as [string, string];
  const out = tags
    .filter((t) => t.startsWith(prefix) && t.endsWith(suffix ?? ""))
    .map((t) => t.slice(prefix.length, t.length - (suffix ?? "").length))
    .filter((v) => VERSION.test(v));
  return [...new Set(out)].sort((a, b) => compareVersions(b, a));
}

export function readToken(file: string | undefined): string {
  try { return file ? readFileSync(file, "utf8").trim() : ""; } catch { return ""; }
}

export class Versions {
  private cache = new Map<string, { at: number; versions: string[] }>();
  private tokenFile: string | undefined;
  private fetcher: typeof fetch;
  private now: () => number;

  constructor(tokenFile: string | undefined, fetcher: typeof fetch = fetch, now: () => number = Date.now) {
    this.tokenFile = tokenFile;
    this.fetcher = fetcher;
    this.now = now;
  }

  async list(repo: string, pattern: string): Promise<{ versions: string[]; error?: string }> {
    const key = `${repo} ${pattern}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < 5 * 60_000) return { versions: hit.versions };
    const token = readToken(this.tokenFile);
    const tags: string[] = [];
    try {
      for (let page = 1; page <= 5; page++) {
        const response = await this.fetcher(`https://api.github.com/repos/${repo}/tags?per_page=100&page=${page}`, {
          headers: { accept: "application/vnd.github+json", "user-agent": "open-atlas-deployer", ...(token ? { authorization: `Bearer ${token}` } : {}) },
          signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok) return { versions: [], error: `GitHub 返回 HTTP ${response.status}${response.status === 404 && !token ? "（私有仓库需要 DEPLOYER_GITHUB_TOKEN_FILE）" : ""}` };
        const batch = (await response.json()) as { name: string }[];
        tags.push(...batch.map((t) => t.name));
        if (batch.length < 100) break;
      }
    } catch (error) {
      return { versions: [], error: `连不上 GitHub：${(error as Error).message}` };
    }
    const versions = versionsFromTags(tags, pattern);
    this.cache.set(key, { at: this.now(), versions });
    return { versions };
  }

  private releases = new Map<string, { at: number; result: { released: boolean; detail: string } }>();

  /** "已正式发布" (§6.2, D14): the tag has a published GitHub Release that is neither a draft nor a prerelease. */
  async release(repo: string, tag: string): Promise<{ released: boolean; detail: string }> {
    const key = `${repo}@${tag}`;
    const hit = this.releases.get(key);
    if (hit && this.now() - hit.at < (hit.result.released ? 600_000 : 60_000)) return hit.result;
    const token = readToken(this.tokenFile);
    let result: { released: boolean; detail: string };
    try {
      const response = await this.fetcher(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, {
        headers: { accept: "application/vnd.github+json", "user-agent": "open-atlas-deployer", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(8_000),
      });
      if (response.status === 404) result = { released: false, detail: `${repo} 的 ${tag} 没有 GitHub Release${token ? "" : "（私有仓库需要 DEPLOYER_GITHUB_TOKEN_FILE）"}` };
      else if (!response.ok) return { released: false, detail: `查 ${tag} 的 Release 时 GitHub 返回 HTTP ${response.status}` };
      else {
        const r = (await response.json()) as { draft?: boolean; prerelease?: boolean; html_url?: string };
        result = r.draft || r.prerelease
          ? { released: false, detail: `${repo} 的 ${tag} 是${r.draft ? "草稿" : "预发布"}，不算正式发布` }
          : { released: true, detail: `${repo} 的 ${tag} 已正式发布${r.html_url ? `（${r.html_url}）` : ""}` };
      }
    } catch (error) {
      return { released: false, detail: `连不上 GitHub，无法确认 ${tag} 是否已发布：${(error as Error).message}` };
    }
    this.releases.set(key, { at: this.now(), result });
    return result;
  }
}
