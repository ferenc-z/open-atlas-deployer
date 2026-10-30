// Who is asking and what they may do (design §9, D2). The Deployer keeps no users: it asks
// Workbench for the session behind the browser's Workbench cookies and authorizes by Group name
// (W1). The emergency account exists only for when Workbench is down (§9.3).

import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const GROUPS = { viewer: "deploy-viewer", uat: "deploy-uat", prod: "deploy-prod" } as const;
const WORKBENCH_COOKIES = ["open_atlas_workbench_session", "open_atlas_workbench_csrf"];

export type Permission = "view" | "deploy-uat" | "deploy-prod" | "admin";

export interface Principal {
  id: string;
  displayName: string;
  via: "workbench" | "emergency";
  groups: string[];
  isAdmin: boolean;
  permissions: Permission[];
  /** Echoed back in x-csrf-token on every change. */
  csrfToken: string;
  /** An administrator acting as this user in Workbench. */
  actAs?: { administrator: string };
  /** Workbench did not answer; this is the result it gave within the grace period (§9.3). */
  stale?: boolean;
}

/** "In this Group you may do this" is the Deployer's call (§9.2); Workbench only names the Groups. */
export function permissionsFor(groups: string[], isAdmin: boolean): Permission[] {
  if (isAdmin) return ["view", "deploy-uat", "deploy-prod", "admin"];
  const has = (g: string) => groups.includes(g);
  const out: Permission[] = [];
  if (has(GROUPS.viewer) || has(GROUPS.uat) || has(GROUPS.prod)) out.push("view");
  if (has(GROUPS.uat)) out.push("deploy-uat");
  if (has(GROUPS.prod)) out.push("deploy-prod");
  return out;
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

interface WorkbenchUser { id: string; email: string; displayName: string; enabled: boolean; isAdmin: boolean }
interface WorkbenchSession { user: WorkbenchUser; csrfToken: string; groups?: string[]; actAs?: { administrator: WorkbenchUser } }

export type SessionResult =
  | { kind: "principal"; principal: Principal }
  | { kind: "anonymous" }
  /** Workbench could not be asked and nothing recent is cached. */
  | { kind: "unavailable" };

export class WorkbenchSessions {
  private cache = new Map<string, { principal: Principal; at: number }>();
  private health: { reachable: boolean; at: number } | undefined;
  private baseUrl: string;
  private fetcher: typeof fetch;
  private now: () => number;
  private graceMs: number;

  constructor(baseUrl: string, fetcher: typeof fetch = fetch, now: () => number = Date.now, graceMs = 15 * 60_000) {
    this.baseUrl = baseUrl;
    this.fetcher = fetcher;
    this.now = now;
    this.graceMs = graceMs;
  }

  /** Always asks Workbench, so a disabled user or a removed Group takes effect at once (§9.1). */
  async resolve(cookieHeader: string | undefined): Promise<SessionResult> {
    const cookies = parseCookies(cookieHeader);
    const forwarded = WORKBENCH_COOKIES.filter((n) => cookies.has(n)).map((n) => `${n}=${cookies.get(n)}`).join("; ");
    if (!cookies.has(WORKBENCH_COOKIES[0]!)) return { kind: "anonymous" };
    const key = sha256(forwarded);
    let response: Response;
    try {
      response = await this.fetcher(new URL("/api/workbench/session", this.baseUrl), { headers: { cookie: forwarded }, signal: AbortSignal.timeout(3_000) });
    } catch {
      return this.fromCache(key);
    }
    if (response.status === 401 || response.status === 403) {
      this.cache.delete(key);
      return { kind: "anonymous" };
    }
    if (!response.ok) return this.fromCache(key);
    const session = (await response.json()) as WorkbenchSession;
    if (!session.user?.enabled) {
      this.cache.delete(key);
      return { kind: "anonymous" };
    }
    const groups = session.groups ?? [];
    const principal: Principal = {
      id: session.user.email,
      displayName: session.user.displayName || session.user.email,
      via: "workbench",
      groups,
      isAdmin: session.user.isAdmin,
      permissions: permissionsFor(groups, session.user.isAdmin),
      csrfToken: session.csrfToken,
      ...(session.actAs ? { actAs: { administrator: session.actAs.administrator.email } } : {}),
    };
    this.remember(key, principal);
    return { kind: "principal", principal };
  }

  private remember(key: string, principal: Principal) {
    const now = this.now();
    for (const [k, v] of this.cache) if (now - v.at > this.graceMs) this.cache.delete(k);
    this.cache.set(key, { principal, at: now });
  }

  private fromCache(key: string): SessionResult {
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at <= this.graceMs) return { kind: "principal", principal: { ...hit.principal, stale: true } };
    return { kind: "unavailable" };
  }

  /** Whether Workbench answers at all; the emergency account works only while it does not. */
  async reachable(): Promise<boolean> {
    if (this.health && this.now() - this.health.at < 15_000) return this.health.reachable;
    let reachable = false;
    try {
      const response = await this.fetcher(new URL("/health", this.baseUrl), { signal: AbortSignal.timeout(2_000) });
      reachable = response.ok;
    } catch {
      reachable = false;
    }
    this.health = { reachable, at: this.now() };
    return reachable;
  }
}

// Emergency account (§9.3): one local administrator whose password hash lives only in the host's
// env file (DEPLOYER_EMERGENCY_PASSWORD_HASH), usable only while Workbench cannot be reached.

export const EMERGENCY_COOKIE = "open_atlas_deployer_emergency";
export const EMERGENCY_TTL_MS = 60 * 60_000;

export function hashPassword(password: string, salt = randomBytes(16)): string {
  return `scrypt$${salt.toString("hex")}$${scryptSync(password, salt, 32).toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = scryptSync(password, Buffer.from(salt, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}

export function emergencyPrincipal(csrfToken: string): Principal {
  return { id: "emergency", displayName: "紧急管理员", via: "emergency", groups: [], isAdmin: true, permissions: permissionsFor([], true), csrfToken };
}

export function newToken(): { token: string; sha256: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, sha256: sha256(token) };
}

export { sha256 };

/** Failed emergency logins: at most five per fifteen minutes, then refuse until the window passes. */
export class LoginThrottle {
  private failures: number[] = [];
  private now: () => number;
  private limit: number;
  private windowMs: number;
  constructor(now: () => number = Date.now, limit = 5, windowMs = 15 * 60_000) {
    this.now = now;
    this.limit = limit;
    this.windowMs = windowMs;
  }
  blocked(): boolean { this.prune(); return this.failures.length >= this.limit; }
  fail() { this.prune(); this.failures.push(this.now()); }
  private prune() { const since = this.now() - this.windowMs; this.failures = this.failures.filter((t) => t > since); }
}
