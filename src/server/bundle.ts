// Release bundles (§5.1 release-asset, phase 5): the GitHub Release asset an app ships its non-image parts in
// (Logbook: the Workbench package, database scripts, saved queries, the assistant's prompt). Downloaded once per
// release, kept under the data directory, checked against the SHA256SUMS inside it, and identified by its own
// sha256 — the digest UAT records and PROD must match (§6.1).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readTarGz, stripTop } from "./tar.ts";
import { readToken } from "./versions.ts";

export class BundleError extends Error {}

export interface Bundle {
  repo: string;
  tag: string;
  asset: string;
  /** sha256:<hex> of the asset as downloaded. */
  digest: string;
  bytes: Buffer;
  /** Paths inside the bundle, without its top directory. */
  files: Map<string, Buffer>;
  /** How many files SHA256SUMS listed and matched; null when the bundle has none. */
  checked: number | null;
}

export class Bundles {
  private dir: string;
  private tokenFile: string | undefined;
  private fetcher: typeof fetch;
  private api: string;
  private cache = new Map<string, Bundle>();

  constructor(dir: string, tokenFile: string | undefined, fetcher: typeof fetch = fetch, api = "https://api.github.com") {
    this.dir = dir;
    this.tokenFile = tokenFile;
    this.fetcher = fetcher;
    this.api = api.replace(/\/+$/, "");
  }

  private headers(accept: string): Record<string, string> {
    const token = readToken(this.tokenFile);
    return { accept, "user-agent": "open-atlas-deployer", ...(token ? { authorization: `Bearer ${token}` } : {}) };
  }

  async get(repo: string, tag: string, asset: string, checksums = "SHA256SUMS"): Promise<Bundle> {
    const key = `${repo}@${tag}/${asset}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const file = join(this.dir, repo.replace("/", "_"), tag, asset);
    let bytes: Buffer;
    if (existsSync(file)) bytes = readFileSync(file);
    else {
      bytes = await this.download(repo, tag, asset);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.part`, bytes);
      renameSync(`${file}.part`, file);
    }
    let files: Map<string, Buffer>;
    try { files = stripTop(readTarGz(bytes)); } catch (error) { throw new BundleError(`${asset}: ${(error as Error).message}`); }
    const sums = files.get(checksums);
    let checked: number | null = null;
    if (sums) {
      checked = 0;
      for (const line of sums.toString("utf8").split(/\r?\n/)) {
        const m = line.match(/^([0-9a-f]{64})\s+\*?(?:\.\/)?(.+)$/);
        // A checksum file that lists itself (written while it was being generated) cannot match; skip that line.
        if (!m || m[2] === checksums) continue;
        const body = files.get(m[2]!);
        if (!body) throw new BundleError(`${checksums} in ${asset} lists ${m[2]}, which is not in the bundle`);
        if (createHash("sha256").update(body).digest("hex") !== m[1]) throw new BundleError(`${m[2]} in ${asset} does not match ${checksums}`);
        checked++;
      }
    }
    const bundle = { repo, tag, asset, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, bytes, files, checked };
    this.cache.set(key, bundle);
    return bundle;
  }

  private async download(repo: string, tag: string, asset: string): Promise<Buffer> {
    let release: Response;
    try {
      release = await this.fetcher(`${this.api}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, { headers: this.headers("application/vnd.github+json"), signal: AbortSignal.timeout(10_000) });
    } catch (error) { throw new BundleError(`Cannot reach GitHub: ${(error as Error).message}`); }
    if (release.status === 404) throw new BundleError(`${repo} has no release for ${tag}${readToken(this.tokenFile) ? "" : " (private repositories need DEPLOYER_GITHUB_TOKEN_FILE)"}`);
    if (!release.ok) throw new BundleError(`GitHub returned HTTP ${release.status}`);
    const found = ((await release.json()) as { assets?: { name: string; url: string }[] }).assets?.find((a) => a.name === asset);
    if (!found) throw new BundleError(`The ${tag} release of ${repo} has no asset ${asset}`);
    const response = await this.fetcher(found.url, { headers: this.headers("application/octet-stream"), signal: AbortSignal.timeout(300_000) });
    if (!response.ok) throw new BundleError(`Downloading ${asset} failed: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
}

export function bundleText(bundle: Bundle | undefined, path: string): string {
  const body = bundle?.files.get(path.replace(/^\.\//, ""));
  if (!body) throw new BundleError(`The release bundle has no ${path}`);
  return body.toString("utf8");
}

/** Files under a directory of the bundle, by name order (db-migration install / migrations). */
export function bundleDir(bundle: Bundle, dir: string): string[] {
  const prefix = `${dir.replace(/^\.\/|\/+$/g, "")}/`;
  return [...bundle.files.keys()].filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/")).sort();
}
