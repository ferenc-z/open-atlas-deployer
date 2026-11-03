// The Deployer's own settings on the page (D45). deployer.env keeps what the Deployer needs before it can open its state
// database or trust a session (keys, the emergency password hash, where it listens and keeps data); those are only
// shown. The rest (addresses, OMA's ids, the daily brief's hour, tokens) can be set on the Environment variables page:
// kept in the state database, tokens sealed with DEPLOYER_CREDENTIAL_ENCRYPTION_KEY, read when the Deployer starts. A
// value in deployer.env wins and the page cannot change it. The Deployer is wired once at start, so a change takes
// effect at the next start; the page can restart it (the container's restart policy brings it back).

import { releaseSource } from "./config.ts";
import type { SecretBox } from "./secretbox.ts";
import type { Actor, Store } from "./store.ts";
import { readToken } from "./versions.ts";

export type SettingKind = "url" | "url-or-path" | "text" | "tag" | "ids" | "hour" | "release" | "repo" | "secret" | "fixed";

export interface SettingDef {
  key: string;
  kind: SettingKind;
  group: "Workbench" | "Releases and GitHub" | "OMA" | "Studio" | "Promotion" | "Daily brief" | "Fixed in deployer.env";
  help: string;
  /** Shown instead of the value for a fixed one: it is a key or a hash. */
  hidden?: boolean;
  default?: string;
}

/** Everything config.ts reads, in the order the page shows it. */
export const SETTINGS: SettingDef[] = [
  { key: "DEPLOYER_WORKBENCH_URL", kind: "url", group: "Workbench", help: "Workbench as the Deployer reaches it, e.g. http://workbench:8090 on the apps' network." },
  { key: "DEPLOYER_WORKBENCH_PUBLIC_URL", kind: "url-or-path", group: "Workbench", help: "Where the browser signs in to Workbench.", default: "/" },
  { key: "DEPLOYER_RELEASE_REPO", kind: "release", group: "Releases and GitHub", help: "Where the Deployer's own versions are listed: github:owner/name." },
  { key: "DEPLOYER_RELEASE_TAG", kind: "tag", group: "Releases and GitHub", help: "The tag of a Deployer version.", default: "v{version}" },
  { key: "DEPLOYER_GITHUB_TOKEN_FILE", kind: "secret", group: "Releases and GitHub", help: "GitHub token for private release repositories (read-only)." },
  { key: "DEPLOYER_ISSUE_REPO", kind: "repo", group: "Releases and GitHub", help: "Where assessments open issues: owner/name." },
  { key: "DEPLOYER_ISSUE_TOKEN_FILE", kind: "secret", group: "Releases and GitHub", help: "GitHub token that may open issues there." },
  { key: "DEPLOYER_OMA_URL", kind: "url", group: "OMA", help: "OMA's API, e.g. http://oma-server:8080." },
  { key: "DEPLOYER_OMA_API_KEY_FILE", kind: "secret", group: "OMA", help: "The Deployer's OMA key." },
  { key: "DEPLOYER_OMA_APPLICATION_ID", kind: "text", group: "OMA", help: "The Deployer's OMA Application." },
  { key: "DEPLOYER_OMA_AGENT", kind: "text", group: "OMA", help: "The Deploy Assistant agent (failure diagnosis, daily brief)." },
  { key: "DEPLOYER_OMA_ENVIRONMENT", kind: "text", group: "OMA", help: "The Environment its sessions run in." },
  { key: "DEPLOYER_OMA_VAULTS", kind: "ids", group: "OMA", help: "Vaults its sessions use, separated by commas." },
  { key: "DEPLOYER_OMA_ASSESSOR_AGENT", kind: "text", group: "OMA", help: "The Onboarding Assessor agent." },
  { key: "DEPLOYER_OMA_ASSESSOR_ENVIRONMENT", kind: "text", group: "OMA", help: "The Assessor's isolated Environment." },
  { key: "DEPLOYER_OMA_ASSESSOR_VAULTS", kind: "ids", group: "OMA", help: "Vaults the Assessor's sessions use, separated by commas." },
  { key: "DEPLOYER_OMA_BUILDER_URL", kind: "url", group: "OMA", help: "OMA's Builder MCP, for deploying OMA agents." },
  { key: "DEPLOYER_OMA_BUILDER_KEY_FILE", kind: "secret", group: "OMA", help: "The key for OMA's Builder MCP." },
  { key: "DEPLOYER_STUDIO_BUILDER_URL", kind: "url", group: "Studio", help: "Studio's Builder MCP, for deploying Studio graphs." },
  { key: "DEPLOYER_STUDIO_TOKEN_FILE", kind: "secret", group: "Studio", help: "Studio workspace token (oaw_v1., read and write)." },
  { key: "DEPLOYER_UAT_URL", kind: "url", group: "Promotion", help: "PROD only: UAT's Deployer as this one reaches it." },
  { key: "DEPLOYER_UAT_KEY_FILE", kind: "secret", group: "Promotion", help: "PROD only: the read-only key UAT's Deployer gave this one." },
  { key: "DEPLOYER_BRIEF_HOUR", kind: "hour", group: "Daily brief", help: "The daily brief is made after this hour, server time (0-23).", default: "8" },
  { key: "DEPLOYER_CREDENTIAL_ENCRYPTION_KEY", kind: "fixed", group: "Fixed in deployer.env", help: "Seals secrets in the state database; changing it makes them unreadable.", hidden: true },
  { key: "DEPLOYER_COMPARE_KEY", kind: "fixed", group: "Fixed in deployer.env", help: "Shared with the other environment's Deployer to compare secrets.", hidden: true },
  { key: "DEPLOYER_EMERGENCY_PASSWORD_HASH", kind: "fixed", group: "Fixed in deployer.env", help: "The emergency account, for when Workbench is down.", hidden: true },
  { key: "DEPLOYER_PEER_KEY_SHA256", kind: "fixed", group: "Fixed in deployer.env", help: "UAT only: hashes of the keys PROD's Deployer may use." },
  { key: "DEPLOYER_SECURE_COOKIES", kind: "fixed", group: "Fixed in deployer.env", help: "Cookies only over https.", default: "true" },
  { key: "DEPLOYER_BIND", kind: "fixed", group: "Fixed in deployer.env", help: "The address it listens on." },
  { key: "DEPLOYER_PORT", kind: "fixed", group: "Fixed in deployer.env", help: "The port it listens on." },
  { key: "DEPLOYER_BASE_PATH", kind: "fixed", group: "Fixed in deployer.env", help: "The path nginx serves it under; the image's page is built for it." },
  { key: "DEPLOYER_DATA", kind: "fixed", group: "Fixed in deployer.env", help: "The state directory." },
  { key: "DEPLOYER_ENVIRONMENT_FILE", kind: "fixed", group: "Fixed in deployer.env", help: "environment.json, imported once as revision 1." },
];

/** When this process started: the page sees a restart by it changing. */
export const STARTED_AT = new Date().toISOString();

const DEF = new Map(SETTINGS.map((d) => [d.key, d]));
const PREFIX = "deployer-setting:";

export interface SettingRow {
  key: string;
  kind: SettingKind;
  group: string;
  help: string;
  /** Where the value in effect now comes from. */
  source: "file" | "page" | "default" | null;
  /** The value in effect now; never for secrets and hidden ones. */
  value?: string;
  /** For secrets and hidden ones: whether one is set. */
  set?: boolean;
  /** What the page holds, when it differs from what is in effect (applies at the next start). */
  pending?: { value?: string; set?: boolean; cleared?: boolean };
  /** Why the page cannot change it. */
  locked?: string;
  updatedBy?: string;
}

export class SettingsError extends Error {
  details: string[];
  constructor(message: string, details: string[] = []) { super(message); this.details = details; }
}

export class DeployerSettings {
  private store: Store;
  private box: SecretBox | undefined;
  private file: NodeJS.ProcessEnv;
  /** What the page held when the Deployer started, i.e. what is in effect. */
  private atStart: Map<string, string>;

  constructor(store: Store, box: SecretBox | undefined, file: NodeJS.ProcessEnv) {
    this.store = store;
    this.box = box;
    this.file = file;
    this.atStart = this.held();
  }

  /** The environment config.ts reads: deployer.env, then the page's plain values for keys the file leaves unset. */
  env(): NodeJS.ProcessEnv {
    const out: NodeJS.ProcessEnv = { ...this.file };
    for (const [key, value] of this.atStart) if (DEF.get(key)!.kind !== "secret" && !this.inFile(key)) out[key] = value;
    return out;
  }

  /** Tokens pasted on the page, for the *_FILE settings the file leaves unset; read on every use. */
  tokens(): Record<string, () => string> {
    const out: Record<string, () => string> = {};
    for (const [key, sealed] of this.atStart) if (DEF.get(key)!.kind === "secret" && !this.inFile(key)) out[key] = () => this.open(sealed);
    return out;
  }

  rows(): SettingRow[] {
    const now = this.held();
    return SETTINGS.map((d) => {
      const row: SettingRow = { key: d.key, kind: d.kind, group: d.group, help: d.help, source: null };
      const secret = d.kind === "secret" || d.hidden;
      const show = (v: string | undefined) => (secret ? { set: !!v } : v !== undefined ? { value: v } : {});
      if (this.inFile(d.key)) {
        const v = d.kind === "secret" ? (readToken(this.file[d.key]) ? this.file[d.key] : undefined) : this.file[d.key];
        Object.assign(row, { source: "file" }, d.kind === "secret" ? { set: !!v, value: this.file[d.key] } : show(v));
        if (d.kind !== "fixed") row.locked = `Set in deployer.env, which wins over the page: change it there, or remove it there to set it here.`;
      } else if (this.atStart.has(d.key)) {
        Object.assign(row, { source: "page" }, show(d.kind === "secret" ? "set" : this.atStart.get(d.key)));
      } else if (d.default !== undefined) {
        Object.assign(row, { source: "default" }, show(d.default));
      } else if (secret) row.set = false;
      if (d.kind === "fixed") row.locked ??= "Kept in deployer.env: the Deployer needs it before it opens its state database.";
      else if (d.kind === "secret" && !this.box && !row.locked) row.locked = "DEPLOYER_CREDENTIAL_ENCRYPTION_KEY is not configured, so a token cannot be kept sealed.";
      if (d.kind !== "fixed" && !this.inFile(d.key) && now.get(d.key) !== this.atStart.get(d.key)) {
        const v = now.get(d.key);
        row.pending = v === undefined ? { cleared: true } : d.kind === "secret" ? { set: true } : { value: v };
      }
      const by = this.store.settingMeta(PREFIX + d.key)?.updatedBy;
      if (by) row.updatedBy = by;
      return row;
    });
  }

  /** Whether something saved on the page waits for the next start. */
  pending(): boolean { return this.rows().some((r) => r.pending); }

  /** Each change: a value, or null (or "") to remove the page's value. All are checked before any is kept. */
  save(changes: { key: string; value: string | null }[], actor: Actor): string[] {
    const problems: string[] = [];
    const ready: [string, string | null][] = [];
    for (const { key, value } of changes) {
      const d = DEF.get(key);
      if (!d) { problems.push(`${key}: not a setting of the Deployer`); continue; }
      if (d.kind === "fixed") { problems.push(`${key}: kept in deployer.env, not on the page`); continue; }
      if (this.inFile(key)) { problems.push(`${key}: set in deployer.env, which wins over the page`); continue; }
      const text = (value ?? "").trim();
      if (!text) { ready.push([key, null]); continue; }
      const problem = check(d, text);
      if (problem) { problems.push(`${key}: ${problem}`); continue; }
      if (d.kind === "secret" && !this.box) { problems.push(`${key}: DEPLOYER_CREDENTIAL_ENCRYPTION_KEY is not configured, so a token cannot be kept sealed`); continue; }
      ready.push([key, d.kind === "ids" ? text.split(/[\s,]+/).filter(Boolean).join(",") : text]);
    }
    if (problems.length) throw new SettingsError("The settings are not valid.", problems);
    const changed: string[] = [];
    for (const [key, value] of ready) {
      const current = this.store.setting(PREFIX + key);
      if (value === null ? current === undefined : DEF.get(key)!.kind !== "secret" && current === value) continue;
      this.store.setSetting(PREFIX + key, value === null ? null : DEF.get(key)!.kind === "secret" ? this.box!.seal(value) : value, actor);
      changed.push(key);
    }
    return changed;
  }

  private inFile(key: string): boolean { return this.file[key] !== undefined && this.file[key] !== ""; }

  private held(): Map<string, string> {
    const out = new Map<string, string>();
    for (const d of SETTINGS) {
      if (d.kind === "fixed") continue;
      const v = this.store.setting(PREFIX + d.key);
      if (v !== undefined) out.set(d.key, v);
    }
    return out;
  }

  private open(sealed: string): string {
    if (!this.box) return "";
    try { return this.box.open(sealed); } catch { return ""; }
  }
}

function check(d: SettingDef, v: string): string | undefined {
  if (v.length > 4096) return "too long";
  const url = (s: string) => { try { return ["http:", "https:"].includes(new URL(s).protocol); } catch { return false; } };
  switch (d.kind) {
    case "url": return url(v) ? undefined : "an http or https address";
    case "url-or-path": return url(v) || /^\/\S*$/.test(v) ? undefined : "an http or https address, or a path starting with /";
    case "text": return /^\S+$/.test(v) ? undefined : "one word, no spaces";
    case "tag": return /^\S*\{version\}\S*$/.test(v) ? undefined : "a tag with {version} in it, e.g. v{version}";
    case "ids": return v.split(/[\s,]+/).filter(Boolean).every((s) => /^\S+$/.test(s)) ? undefined : "ids separated by commas";
    case "hour": return /^\d{1,2}$/.test(v) && Number(v) <= 23 ? undefined : "a whole hour from 0 to 23";
    case "release": { const r = releaseSource(v); return "error" in r ? r.error : undefined; }
    case "repo": return /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(v) ? undefined : "owner/name";
    case "secret": return /\s/.test(v) ? "paste the token alone, without spaces" : undefined;
    default: return "not settable";
  }
}
