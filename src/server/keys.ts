// API keys (§9.4, §10.3, phase 6). A personal key (dpk_) is made by a signed-in person on the page, belongs to
// their Workbench account, and every call asks Workbench again whether that account is still enabled and in which
// Groups; it may do what its owner does on the page, minus PROD execution, overriding promotion and revealing
// secrets, which take a browser session. A service key (dps_) is made by an administrator for the Deploy Assistant
// in OMA's Vault: read-only, no person behind it. Only the SHA-256 is kept; a key never makes a key.

import { randomBytes } from "node:crypto";
import { permissionsFor, sha256, type Principal } from "./auth.ts";
import type { WorkbenchAdmin } from "./drivers/workbench.ts";
import type { Store } from "./store.ts";

export type KeyKind = "personal" | "service";

export interface ApiKey {
  id: string;
  kind: KeyKind;
  name: string;
  prefix: string;
  /** The owner's Workbench email for a personal key; the administrator who made it for a service key. */
  owner: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export class KeyError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 503;
  readonly code: string;
  constructor(status: 400 | 401 | 403 | 404 | 503, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

/** Calls that take a browser session (§9.4): a key, personal or service, is refused. */
export const isKey = (p: Principal) => p.via === "key" || p.via === "service";

export class Keys {
  private store: Store;
  private workbench: WorkbenchAdmin;
  private now: () => number;

  constructor(store: Store, workbench: WorkbenchAdmin, now: () => number = Date.now) {
    this.store = store;
    this.workbench = workbench;
    this.now = now;
  }

  create(p: Principal, kind: KeyKind, name: string, days: number): { key: string; record: ApiKey } {
    if (p.via !== "workbench") throw new KeyError(403, "key/browser-only", "API keys can only be created on the page while signed in with Workbench, not with another key.");
    if (kind === "service" && !p.isAdmin) throw new KeyError(403, "key/forbidden", "Only Workbench admins can create service keys.");
    if (kind === "personal" && !p.permissions.includes("view")) throw new KeyError(403, "key/forbidden", "You are not in any deploy group, so you cannot create a key.");
    const label = name.trim();
    if (!label || label.length > 80) throw new KeyError(400, "key/name", "A key name is 1 to 80 characters.");
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new KeyError(400, "key/expiry", "Expiry is 1 to 365 days.");
    const key = `${kind === "personal" ? "dpk" : "dps"}_${randomBytes(32).toString("base64url")}`;
    const id = `key_${randomBytes(8).toString("hex")}`;
    const record = this.store.addKey({ id, kind, name: label, prefix: key.slice(0, 12), sha256: sha256(key), owner: p.id, expiresAt: new Date(this.now() + days * 86_400_000).toISOString() }, { id: p.id, via: "workbench" });
    return { key, record };
  }

  list(p: Principal): ApiKey[] {
    const all = this.store.listKeys();
    return p.isAdmin ? all : all.filter((k) => k.kind === "personal" && k.owner === p.id);
  }

  revoke(p: Principal, id: string) {
    if (p.via !== "workbench") throw new KeyError(403, "key/browser-only", "Keys are revoked on the page.");
    const k = this.store.listKeys().find((x) => x.id === id);
    if (!k || (!p.isAdmin && k.owner !== p.id) || (k.kind === "service" && !p.isAdmin)) throw new KeyError(404, "key/unknown", "No such key.");
    this.store.revokeKey(id, { id: p.id, via: "workbench" });
  }

  /** The principal behind a bearer key: a service key as is; a personal key as its owner is in Workbench right now. */
  async resolve(bearer: string): Promise<Principal> {
    const k = this.store.keyBySha(sha256(bearer));
    if (!k || k.revokedAt) throw new KeyError(401, "key/invalid", "The API key is wrong or revoked.");
    if (Date.parse(k.expiresAt) <= this.now()) throw new KeyError(401, "key/expired", "The API key has expired.");
    this.store.touchKey(k.id);
    if (k.kind === "service") {
      return { id: `service:${k.name}`, displayName: `Service key ${k.name}`, via: "service", groups: [], isAdmin: false, permissions: ["view"], csrfToken: "", keyId: k.id };
    }
    let owner: Awaited<ReturnType<WorkbenchAdmin["person"]>>;
    try { owner = await this.workbench.person(k.owner); } catch (error) { throw new KeyError(503, "key/workbench-unavailable", `Cannot confirm the key's owner with Workbench: ${(error as Error).message}`); }
    if (!owner?.enabled) throw new KeyError(401, "key/owner-disabled", "The key's owner is disabled or missing in Workbench.");
    const permissions = permissionsFor(owner.groups, owner.isAdmin);
    if (!permissions.includes("view")) throw new KeyError(403, "auth/forbidden", "The key's owner is no longer in any deploy group.");
    return { id: owner.email, displayName: owner.displayName || owner.email, via: "key", groups: owner.groups, isAdmin: owner.isAdmin, permissions, csrfToken: "", keyId: k.id };
  }
}
