// Between the two Deployers (design §6.3, D12). PROD's Deployer holds a read-only key for UAT's and uses
// it only to read UAT's deploy records (promotion), its versions and its env fingerprints. UAT keeps the
// key's SHA-256; the key opens nothing but /api/peer/*.

import { randomBytes } from "node:crypto";
import type { DeployRecord } from "./store.ts";
import { readToken } from "./versions.ts";

export const PEER_KEY_PREFIX = "dpr_";

export function newPeerKey(): string {
  return PEER_KEY_PREFIX + randomBytes(32).toString("base64url");
}

export class PeerError extends Error {}

export interface PeerStatus {
  environment: string;
  apps: Record<string, { version: string; deployment: string; deployedAt: string; digests: Record<string, string> }>;
}

export class Peer {
  readonly url: string | undefined;
  private keyFile: string | undefined;
  private fetcher: typeof fetch;
  private cache = new Map<string, { at: number; value: unknown }>();
  private now: () => number;

  constructor(url: string | undefined, keyFile: string | undefined, fetcher: typeof fetch = fetch, now: () => number = Date.now) {
    this.url = url?.replace(/\/+$/, "");
    this.keyFile = keyFile;
    this.fetcher = fetcher;
    this.now = now;
  }

  get configured() { return Boolean(this.url); }

  /** GET on the other Deployer's peer API; cached for 30 seconds so a page refresh does not ask again. */
  private async get<T>(path: string): Promise<T> {
    if (!this.url) throw new PeerError("没有配置 UAT 的 Deployer（DEPLOYER_UAT_URL）");
    const hit = this.cache.get(path);
    if (hit && this.now() - hit.at < 30_000) return hit.value as T;
    const key = readToken(this.keyFile);
    let response: Response;
    try {
      response = await this.fetcher(`${this.url}/api/peer/${path}`, { headers: { accept: "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, signal: AbortSignal.timeout(5_000) });
    } catch (error) {
      throw new PeerError(`连不上 UAT 的 Deployer：${(error as Error).message}`);
    }
    const body = await response.json().catch(() => ({})) as { message?: string };
    if (!response.ok) throw new PeerError(`UAT 的 Deployer 返回 HTTP ${response.status}${body.message ? `：${body.message}` : ""}`);
    this.cache.set(path, { at: this.now(), value: body });
    return body as T;
  }

  status() { return this.get<PeerStatus>("status"); }

  deployments(app: string, version: string) {
    return this.get<{ environment: string; records: DeployRecord[] }>(`apps/${encodeURIComponent(app)}/deployments?version=${encodeURIComponent(version)}`);
  }

  fingerprint(app: string) { return this.get<Record<string, unknown>>(`apps/${encodeURIComponent(app)}/env/fingerprint`); }
}
