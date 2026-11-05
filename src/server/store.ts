// The Deployer's state (design §12: one SQLite file). Phase 1 keeps the app registry with each
// app's deploy manifests and their history (§4.3, §4.4, D27), the audit log, and emergency sessions.
// Rows are never rewritten: saving a manifest adds a revision, removing an app marks it removed.

import { DatabaseSync } from "node:sqlite";
import type { Diagnosis } from "./diagnose.ts";
import type { DriftItem } from "./drift.ts";
import type { ApiKey } from "./keys.ts";
import type { Rollout } from "./rollout.ts";
import type { Environment, Manifest } from "../compose/generate.ts";
import { changedPaths } from "./jsonpatch.ts";
import { crossAppConflicts, validateManifest } from "../manifest/validate.ts";
import { compareVersions } from "../manifest/version.ts";
import { checkDraftItem, type DraftCluster, type DraftItem, type DraftReview, type DraftStandalone, type DraftState, type ServiceDraft, type ServiceMember } from "./services/draft.ts";
import type { ServiceConfigBody } from "./services/config.ts";
import { randomBytes } from "node:crypto";

export interface Actor { id: string; via: "workbench" | "emergency" | "cli" | "key" | "service" }

export interface ManifestRevision { appliesFrom: string; revision: number; savedAt: string; savedBy: string; note: string | null }
/** trial: in UAT for a trial deploy from an assessment (§10.5.1 ⑤), not yet registered by an administrator (⑥). */
export interface RegisteredApp { id: string; name: string; repo: string; addedAt: string; addedBy: string; manifests: ManifestRevision[]; trial: string | null }
export interface AuditEntry { id: number; at: string; actor: string; via: string; action: string; target: string; detail: unknown }

export class StoreError extends Error {
  readonly code: string;
  readonly details: string[];
  constructor(code: string, message: string, details: string[] = []) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS apps (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, repo TEXT NOT NULL,
  added_at TEXT NOT NULL, added_by TEXT NOT NULL, removed_at TEXT, removed_by TEXT);
CREATE TABLE IF NOT EXISTS manifests (
  app TEXT NOT NULL REFERENCES apps(id), applies_from TEXT NOT NULL, revision INTEGER NOT NULL,
  body TEXT NOT NULL, saved_at TEXT NOT NULL, saved_by TEXT NOT NULL, note TEXT,
  PRIMARY KEY (app, applies_from, revision));
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, via TEXT NOT NULL,
  action TEXT NOT NULL, target TEXT NOT NULL, detail TEXT);
CREATE TABLE IF NOT EXISTS emergency_sessions (
  token_sha256 TEXT PRIMARY KEY, csrf TEXT NOT NULL, created_at TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, app TEXT NOT NULL, version TEXT NOT NULL, environment TEXT NOT NULL,
  state TEXT NOT NULL, requested_by TEXT NOT NULL, via TEXT NOT NULL, requested_at TEXT NOT NULL, finished_at TEXT,
  from_version TEXT, manifest TEXT, pin_from TEXT, request TEXT NOT NULL, status TEXT, observation TEXT, message TEXT);
CREATE INDEX IF NOT EXISTS jobs_app ON jobs (app, requested_at);
CREATE TABLE IF NOT EXISTS env_revisions (
  app TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, changes TEXT NOT NULL, source TEXT NOT NULL,
  saved_at TEXT NOT NULL, saved_by TEXT NOT NULL, via TEXT NOT NULL, note TEXT, applied_at TEXT, applied_job TEXT,
  PRIMARY KEY (app, revision));
CREATE TABLE IF NOT EXISTS artifacts (
  app TEXT NOT NULL, service TEXT NOT NULL, digest TEXT NOT NULL, version TEXT NOT NULL, ref TEXT NOT NULL,
  origin TEXT NOT NULL, build TEXT, job TEXT NOT NULL, seen_at TEXT NOT NULL,
  PRIMARY KEY (app, service, digest));
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, prefix TEXT NOT NULL, sha256 TEXT NOT NULL UNIQUE, owner TEXT NOT NULL,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT);
CREATE TABLE IF NOT EXISTS mcp_requests (
  key_id TEXT NOT NULL, request_id TEXT NOT NULL, tool TEXT NOT NULL, response TEXT NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (key_id, request_id));
CREATE TABLE IF NOT EXISTS assessments (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, repo TEXT NOT NULL, app TEXT, version TEXT, state TEXT NOT NULL, requested_by TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS drift (
  key TEXT PRIMARY KEY, app TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS briefs (date TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS component_state (
  app TEXT NOT NULL, component TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (app, component, key));
CREATE TABLE IF NOT EXISTS executor_tokens (
  sha256 TEXT PRIMARY KEY, host TEXT NOT NULL, prefix TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL, revoked_at TEXT);
CREATE TABLE IF NOT EXISTS executor_jobs (
  id TEXT PRIMARY KEY, host TEXT NOT NULL, request TEXT NOT NULL, content TEXT, queued_at TEXT NOT NULL, picked_at TEXT,
  status TEXT, log TEXT NOT NULL DEFAULT '', env_content TEXT, env_content_at TEXT);
CREATE INDEX IF NOT EXISTS executor_jobs_host ON executor_jobs (host, picked_at, queued_at);
CREATE TABLE IF NOT EXISTS executor_hosts (
  host TEXT PRIMARY KEY, heartbeat TEXT, beat_at TEXT, containers TEXT, files TEXT, state_at TEXT);
CREATE TABLE IF NOT EXISTS executor_beats (
  host TEXT NOT NULL, executor TEXT NOT NULL, heartbeat TEXT NOT NULL, beat_at TEXT NOT NULL, PRIMARY KEY (host, executor));
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS environment_revisions (
  revision INTEGER PRIMARY KEY, body TEXT NOT NULL, changes TEXT NOT NULL, source TEXT NOT NULL, saved_at TEXT NOT NULL,
  saved_by TEXT NOT NULL, via TEXT NOT NULL, note TEXT);
CREATE TABLE IF NOT EXISTS nginx_revisions (
  revision INTEGER PRIMARY KEY, body TEXT NOT NULL, sha256 TEXT NOT NULL, saved_at TEXT NOT NULL, saved_by TEXT NOT NULL, note TEXT);
CREATE TABLE IF NOT EXISTS service_standalones (
  id TEXT PRIMARY KEY, service TEXT NOT NULL, profile TEXT NOT NULL, version TEXT NOT NULL, environment TEXT NOT NULL,
  host TEXT NOT NULL, install_dir TEXT NOT NULL, service_user TEXT, start_env TEXT, ports TEXT NOT NULL, web_url TEXT,
  thresholds TEXT, draft TEXT, discovery TEXT, created_at TEXT NOT NULL, created_by TEXT NOT NULL, removed_at TEXT, removed_by TEXT);
CREATE TABLE IF NOT EXISTS service_clusters (
  id TEXT PRIMARY KEY, service TEXT NOT NULL, profile TEXT NOT NULL, version TEXT NOT NULL, environment TEXT NOT NULL,
  zookeeper TEXT, zookeeper_root TEXT, web_url TEXT, thresholds TEXT, draft TEXT,
  created_at TEXT NOT NULL, created_by TEXT NOT NULL, removed_at TEXT, removed_by TEXT);
CREATE TABLE IF NOT EXISTS service_nodes (
  cluster TEXT NOT NULL REFERENCES service_clusters(id), host TEXT NOT NULL, install_dir TEXT NOT NULL, service_user TEXT,
  start_env TEXT, control TEXT NOT NULL, ports TEXT NOT NULL, node_address TEXT, discovery TEXT,
  added_at TEXT NOT NULL, removed_at TEXT, PRIMARY KEY (cluster, host, install_dir));
CREATE TABLE IF NOT EXISTS service_drafts (
  id TEXT PRIMARY KEY, state TEXT NOT NULL, environment TEXT NOT NULL, sources TEXT NOT NULL,
  created_at TEXT NOT NULL, created_by TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL, review TEXT);
CREATE TABLE IF NOT EXISTS service_draft_items (
  draft TEXT NOT NULL REFERENCES service_drafts(id), id TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL,
  updated_at TEXT NOT NULL, updated_by TEXT NOT NULL, PRIMARY KEY (draft, id));
CREATE TABLE IF NOT EXISTS service_configs (
  service TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, source TEXT NOT NULL, saved_at TEXT NOT NULL,
  saved_by TEXT NOT NULL, via TEXT NOT NULL, note TEXT, PRIMARY KEY (service, revision));
`;

/** queued: waiting for the host's executor to claim it; the rest are the executor's states. */
export type JobState = "queued" | "running" | "succeeded" | "failed" | "rolled-back" | "refused";
export const FINAL_STATES: JobState[] = ["succeeded", "failed", "rolled-back", "refused"];

/** S18: the executors a host may run: deploy (builds, compose, env; needs Docker) and service (managed services such as NiFi). */
export type ExecutorKind = "deploy" | "service";
export const EXECUTOR_KINDS: readonly ExecutorKind[] = ["deploy", "service"];

export interface ExecutorStatus {
  state: JobState;
  step?: string;
  steps: { name: string; state: string; at: string; message?: string }[];
  result: { digests?: Record<string, string>; commit?: string; image?: string; digest?: string; builds?: Record<string, { version: string; commit: string }>; build?: Record<string, unknown>; backups?: string[]; env?: { exists: boolean; sha256?: string; bytes?: number }; restarted?: string[] };
  message?: string;
  startedAt?: string;
  finishedAt?: string;
}

/** One version of an app's env file (§7.2): plain values as {v}, secrets sealed as {s}. */
export type StoredEnv = Record<string, { v: string } | { s: string }>;
export interface EnvRevision {
  app: string;
  revision: number;
  /** edit: saved on the page; import: read from the server; revert: a copy of an earlier revision. */
  source: "edit" | "import" | "revert";
  changes: { key: string; change: "added" | "removed" | "changed"; secret: boolean }[];
  savedAt: string;
  savedBy: string;
  via: string;
  note: string | null;
  /** When this revision was last written to the server (an import is, by definition). */
  appliedAt: string | null;
  appliedJob: string | null;
}

/** D38: one saved version of the environment settings; source import: environment.json read on first start. */
export interface EnvironmentRevision {
  revision: number;
  environment: Environment;
  /** Paths that changed against the revision before, e.g. apps.shop.version. */
  changes: string[];
  source: "import" | "edit";
  savedAt: string;
  savedBy: string;
  via: string;
  note: string | null;
}

export type JobKind = "build" | "deploy" | "env" | "env-read" | "executor-upgrade" | "deployer-upgrade";

/**
 * An immutable artifact (§6.1): app@version + component + digest. origin says how it first came here:
 * built by this Deployer, pulled by tag at a deploy, pinned to the digest UAT ran (promotion), or pinned to an earlier deploy.
 */
export interface Artifact {
  app: string;
  service: string;
  digest: string;
  version: string;
  /** The image repository, without tag or digest. */
  ref: string;
  origin: "build" | "pulled" | "uat" | "pinned";
  build: Record<string, unknown> | null;
  job: string;
  seenAt: string;
}

/** A successful deploy as the other Deployer sees it (§6.3): what ran, from when, until when. */
export interface DeployRecord { id: string; version: string; digests: Record<string, string>; deployedAt: string; replacedAt: string | null; envRevision: number | null; manifest?: string | null }

export interface Job {
  id: string;
  kind: JobKind;
  app: string;
  version: string;
  environment: string;
  state: JobState;
  requestedBy: string;
  via: string;
  requestedAt: string;
  finishedAt: string | null;
  fromVersion: string | null;
  /** app@appliesFrom#revision of the manifest the plan used. */
  manifest: string | null;
  /** The deploy whose digests this one restores ("go back to this version"). */
  pinFrom: string | null;
  request: Record<string, unknown>;
  status: ExecutorStatus | null;
  /** What the app reported after a deploy (§8.5 observation). */
  observation: unknown;
  message: string | null;
  /** A deploy's steps in dependsOn order (phase 5): the executor's part, then the Deployer's and people's. */
  rollout: Rollout | null;
  /** After a failed or rolled-back deploy: the Deploy Assistant's diagnosis (phase 6, D24). */
  diagnosis: Diagnosis | null;
}

type Row = Record<string, any>;

const toEnvRevision = (r: Row): EnvRevision => ({
  app: r.app, revision: r.revision, source: r.source, changes: JSON.parse(r.changes), savedAt: r.saved_at, savedBy: r.saved_by,
  via: r.via, note: r.note ?? null, appliedAt: r.applied_at ?? null, appliedJob: r.applied_job ?? null,
});

const parse = (s: string | null) => (s ? JSON.parse(s) : null);
const toKey = (r: Row): ApiKey => ({
  id: r.id, kind: r.kind, name: r.name, prefix: r.prefix, owner: r.owner, createdAt: r.created_at, expiresAt: r.expires_at,
  lastUsedAt: r.last_used_at ?? null, revokedAt: r.revoked_at ?? null,
});
const toJob = (r: Row): Job => ({
  id: r.id, kind: r.kind, app: r.app, version: r.version, environment: r.environment, state: r.state,
  requestedBy: r.requested_by, via: r.via, requestedAt: r.requested_at, finishedAt: r.finished_at ?? null,
  fromVersion: r.from_version ?? null, manifest: r.manifest ?? null, pinFrom: r.pin_from ?? null,
  request: JSON.parse(r.request), status: parse(r.status), observation: parse(r.observation), message: r.message ?? null,
  rollout: parse(r.rollout ?? null),
  diagnosis: parse(r.diagnosis ?? null),
});

export class Store {
  private db: DatabaseSync;
  private now: () => Date;

  constructor(file: string, now: () => Date = () => new Date()) {
    this.now = now;
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    // Phase 5 added the rollout column; a state database from before gets it here.
    // Columns added after phase 1; a state database from before gets them here.
    const columns = (this.db.prepare("PRAGMA table_info(jobs)").all() as Row[]).map((c) => c.name);
    for (const column of ["rollout", "diagnosis"]) if (!columns.includes(column)) this.db.exec(`ALTER TABLE jobs ADD COLUMN ${column} TEXT`);
    if (!(this.db.prepare("PRAGMA table_info(apps)").all() as Row[]).some((c) => c.name === "trial")) this.db.exec("ALTER TABLE apps ADD COLUMN trial TEXT");
    // S18: which executor of a host a token and a job belong to (NULL, as before: the deploy executor).
    for (const table of ["executor_tokens", "executor_jobs"]) {
      if (!(this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).some((c) => c.name === "executor")) this.db.exec(`ALTER TABLE ${table} ADD COLUMN executor TEXT`);
    }
    // Service ops step 5: a takeover draft's AI review (step 4's tables had no such column).
    if (!(this.db.prepare("PRAGMA table_info(service_drafts)").all() as Row[]).some((c) => c.name === "review")) this.db.exec("ALTER TABLE service_drafts ADD COLUMN review TEXT");
  }

  close() { this.db.close(); }

  private stamp() { return this.now().toISOString(); }

  listApps(): RegisteredApp[] {
    const apps = this.db.prepare("SELECT * FROM apps WHERE removed_at IS NULL ORDER BY id").all() as Row[];
    return apps.map((a) => this.toApp(a));
  }

  app(id: string): RegisteredApp | undefined {
    const a = this.db.prepare("SELECT * FROM apps WHERE id = ? AND removed_at IS NULL").get(id) as Row | undefined;
    return a && this.toApp(a);
  }

  private toApp(a: Row): RegisteredApp {
    const rows = this.db.prepare("SELECT applies_from, revision, saved_at, saved_by, note FROM manifests WHERE app = ? ORDER BY saved_at DESC, revision DESC").all(a.id) as Row[];
    const manifests = rows.map((r) => ({ appliesFrom: r.applies_from, revision: r.revision, savedAt: r.saved_at, savedBy: r.saved_by, note: r.note ?? null }));
    return { id: a.id, name: a.name, repo: a.repo, addedAt: a.added_at, addedBy: a.added_by, manifests, trial: a.trial ?? null };
  }

  /** The current revision of each of an app's manifests, oldest appliesFrom first. */
  manifests(app: string): Manifest[] {
    const rows = this.db.prepare(`
      SELECT m.body FROM manifests m
      WHERE m.app = ? AND m.revision = (SELECT MAX(revision) FROM manifests x WHERE x.app = m.app AND x.applies_from = m.applies_from)`).all(app) as Row[];
    return rows.map((r) => JSON.parse(r.body) as Manifest).sort((a, b) => compareVersions(a.appliesFrom, b.appliesFrom));
  }

  /** Each manifest range's newest revision number, oldest appliesFrom first. */
  manifestSegments(app: string): { appliesFrom: string; revision: number }[] {
    const rows = this.db.prepare("SELECT applies_from, MAX(revision) AS revision FROM manifests WHERE app = ? GROUP BY applies_from").all(app) as Row[];
    return rows.map((r) => ({ appliesFrom: r.applies_from, revision: r.revision })).sort((a, b) => compareVersions(a.appliesFrom, b.appliesFrom));
  }

  manifestRevision(app: string, appliesFrom: string, revision: number): Manifest | undefined {
    const r = this.db.prepare("SELECT body FROM manifests WHERE app = ? AND applies_from = ? AND revision = ?").get(app, appliesFrom, revision) as Row | undefined;
    return r && JSON.parse(r.body);
  }

  /**
   * Validates and saves a manifest as a new revision. The first manifest registers the app (§4.4);
   * later ones must keep its release repo, which is what the registry whitelists.
   */
  saveManifest(value: unknown, actor: Actor, options: { name?: string; note?: string; base?: number | null; repoChange?: boolean } = {}): { app: string; appliesFrom: string; revision: number } {
    const errors = validateManifest(value);
    if (errors.length) throw new StoreError("manifest/invalid", "The manifest is not a valid deploy manifest v1.", errors);
    const manifest = value as Manifest;
    const existing = this.app(manifest.app);
    if (existing && existing.repo !== manifest.release!.repo && !options.repoChange) {
      throw new StoreError("manifest/repo-changed", `${manifest.app} is registered for ${existing.repo}; a manifest for ${manifest.release!.repo} needs a new registration.`);
    }
    const others = this.listApps().filter((a) => a.id !== manifest.app).flatMap((a) => this.manifests(a.id));
    const conflicts = crossAppConflicts([...others, manifest]);
    if (conflicts.length) throw new StoreError("manifest/conflict", "The manifest clashes with another registered app.", conflicts);

    const at = this.stamp();
    this.db.exec("BEGIN");
    try {
      if (!existing) {
        // A removed app comes back as a new registration; its manifest history stays.
        this.db.prepare(`INSERT INTO apps (id, name, repo, added_at, added_by) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET name = excluded.name, repo = excluded.repo, added_at = excluded.added_at,
            added_by = excluded.added_by, removed_at = NULL, removed_by = NULL`)
          .run(manifest.app, options.name ?? manifest.app, manifest.release!.repo, at, actor.id);
      } else if (options.name && options.name !== existing.name) {
        this.db.prepare("UPDATE apps SET name = ? WHERE id = ?").run(options.name, manifest.app);
      }
      const last = this.db.prepare("SELECT MAX(revision) AS r FROM manifests WHERE app = ? AND applies_from = ?").get(manifest.app, manifest.appliesFrom) as Row;
      // D38: a change names the revision it was made on; an older one would overwrite a change nobody saw.
      if (options.base !== undefined && (last.r ?? null) !== options.base) {
        throw new StoreError("manifest/stale", `${manifest.app} from ${manifest.appliesFrom} is at revision ${last.r ?? "none"}, not ${options.base ?? "none"}: read it again and make the change on that.`);
      }
      if (existing && existing.repo !== manifest.release!.repo) {
        this.db.prepare("UPDATE apps SET repo = ? WHERE id = ?").run(manifest.release!.repo, manifest.app);
        this.insertAudit(actor, "app.repo-change", manifest.app, { from: existing.repo, to: manifest.release!.repo });
      }
      const revision = (last.r ?? 0) + 1;
      this.db.prepare("INSERT INTO manifests (app, applies_from, revision, body, saved_at, saved_by, note) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(manifest.app, manifest.appliesFrom, revision, JSON.stringify(manifest), at, actor.id, options.note ?? null);
      this.insertAudit(actor, existing ? "manifest.save" : "app.register", `${manifest.app}@${manifest.appliesFrom}`, { revision });
      this.db.exec("COMMIT");
      return { app: manifest.app, appliesFrom: manifest.appliesFrom, revision };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** D38: the environment settings at a revision; the newest when none is given. */
  environmentRevision(revision?: number): EnvironmentRevision | undefined {
    const r = (revision === undefined
      ? this.db.prepare("SELECT * FROM environment_revisions ORDER BY revision DESC LIMIT 1").get()
      : this.db.prepare("SELECT * FROM environment_revisions WHERE revision = ?").get(revision)) as Row | undefined;
    return r && { revision: r.revision, environment: JSON.parse(r.body), changes: JSON.parse(r.changes), source: r.source, savedAt: r.saved_at, savedBy: r.saved_by, via: r.via, note: r.note ?? null };
  }

  environmentRevisions(): Omit<EnvironmentRevision, "environment">[] {
    return (this.db.prepare("SELECT revision, changes, source, saved_at, saved_by, via, note FROM environment_revisions ORDER BY revision DESC").all() as Row[])
      .map((r) => ({ revision: r.revision, changes: JSON.parse(r.changes), source: r.source, savedAt: r.saved_at, savedBy: r.saved_by, via: r.via, note: r.note ?? null }));
  }

  /** Saves a new revision of the environment settings. base: the revision the change was made on (null for the first);
   *  an older one is refused, so nobody overwrites a change they did not see. The caller checks it (validateEnvironment). */
  saveEnvironment(environment: Environment, base: number | null, actor: Actor, options: { note?: string; source?: "import" | "edit" } = {}): EnvironmentRevision {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const latest = this.environmentRevision();
      if ((latest?.revision ?? null) !== base) {
        throw new StoreError("environment/stale", latest ? `The environment settings are at revision ${latest.revision}, not ${base ?? "none"}: read them again and make the change on that.` : "There are no environment settings yet: save without a base.");
      }
      const revision = (latest?.revision ?? 0) + 1;
      const changes = latest ? changedPaths(latest.environment, environment) : ["(imported)"];
      const source = options.source ?? "edit";
      this.db.prepare("INSERT INTO environment_revisions (revision, body, changes, source, saved_at, saved_by, via, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(revision, JSON.stringify(environment), JSON.stringify(changes), source, this.stamp(), actor.id, actor.via, options.note ?? null);
      this.insertAudit(actor, source === "import" ? "environment.import" : "environment.save", `environment#${revision}`, { changes, ...(options.note ? { note: options.note } : {}) });
      this.db.exec("COMMIT");
      return this.environmentRevision(revision)!;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** D38 ⑤: PROD keeps UAT's manifest revisions under UAT's numbers. One already here must be the same, or PROD and UAT
   *  would deploy different manifests under one name. Registers the app on its first manifest. */
  mirrorManifest(manifest: Manifest, revision: number, actor: Actor, name?: string): "added" | "unchanged" {
    const kept = this.manifestRevision(manifest.app, manifest.appliesFrom, revision);
    if (kept) {
      if (JSON.stringify(kept) !== JSON.stringify(manifest)) throw new StoreError("manifest/uat-mismatch", `${manifest.app}@${manifest.appliesFrom}#${revision} here differs from UAT's: PROD's copy was changed here. Compare the two and take UAT's.`);
      return "unchanged";
    }
    const existing = this.app(manifest.app);
    const at = this.stamp();
    this.db.exec("BEGIN");
    try {
      if (!existing || existing.repo !== manifest.release?.repo) {
        this.db.prepare(`INSERT INTO apps (id, name, repo, added_at, added_by) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET repo = excluded.repo, removed_at = NULL, removed_by = NULL`)
          .run(manifest.app, name ?? existing?.name ?? manifest.app, manifest.release?.repo ?? "", at, actor.id);
      }
      this.db.prepare("INSERT INTO manifests (app, applies_from, revision, body, saved_at, saved_by, note) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(manifest.app, manifest.appliesFrom, revision, JSON.stringify(manifest), at, actor.id, "Taken from UAT");
      this.insertAudit(actor, existing ? "manifest.from-uat" : "app.register-from-uat", `${manifest.app}@${manifest.appliesFrom}`, { revision });
      this.db.exec("COMMIT");
      return "added";
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  removeApp(id: string, actor: Actor) {
    if (!this.app(id)) throw new StoreError("app/unknown", `${id} is not registered.`);
    this.db.prepare("UPDATE apps SET removed_at = ?, removed_by = ? WHERE id = ?").run(this.stamp(), actor.id, id);
    this.insertAudit(actor, "app.remove", id, null);
  }

  audit(actor: Actor, action: string, target: string, detail: unknown = null) { this.insertAudit(actor, action, target, detail); }

  private insertAudit(actor: Actor, action: string, target: string, detail: unknown) {
    this.db.prepare("INSERT INTO audit (at, actor, via, action, target, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .run(this.stamp(), actor.id, actor.via, action, target, detail === null ? null : JSON.stringify(detail));
  }

  listAudit(limit = 100, filter: { actor?: string; action?: string; target?: string; since?: string } = {}): AuditEntry[] {
    const rows = this.db.prepare(`SELECT * FROM audit WHERE (?1 IS NULL OR actor = ?1) AND (?2 IS NULL OR action LIKE ?2 || '%') AND (?3 IS NULL OR target LIKE ?3 || '%')
      AND (?4 IS NULL OR at >= ?4) ORDER BY id DESC LIMIT ?5`).all(filter.actor ?? null, filter.action ?? null, filter.target ?? null, filter.since ?? null, limit) as Row[];
    return rows.map((r) => ({ id: r.id, at: r.at, actor: r.actor, via: r.via, action: r.action, target: r.target, detail: r.detail ? JSON.parse(r.detail) : null }));
  }

  addJob(job: Pick<Job, "id" | "kind" | "app" | "version" | "environment" | "fromVersion" | "manifest" | "pinFrom" | "request">, actor: Actor) {
    this.db.prepare(`INSERT INTO jobs (id, kind, app, version, environment, state, requested_by, via, requested_at, from_version, manifest, pin_from, request)
      VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`)
      .run(job.id, job.kind, job.app, job.version, job.environment, actor.id, actor.via, this.stamp(), job.fromVersion, job.manifest, job.pinFrom, JSON.stringify(job.request));
    this.insertAudit(actor, `${job.kind}.request`, `${job.app}@${job.version}`, { job: job.id, ...(job.pinFrom ? { pinFrom: job.pinFrom } : {}) });
  }

  /** Records what the executor reports; returns true when the job just reached a final state. */
  updateJob(id: string, status: ExecutorStatus): boolean {
    const before = this.job(id);
    if (!before || FINAL_STATES.includes(before.state)) return false;
    const final = FINAL_STATES.includes(status.state);
    this.db.prepare("UPDATE jobs SET state = ?, status = ?, message = ?, finished_at = ? WHERE id = ?")
      .run(status.state, JSON.stringify(status), status.message ?? null, final ? status.finishedAt ?? this.stamp() : null, id);
    if (final) this.insertAudit({ id: "executor", via: "cli" }, `${before.kind}.${status.state}`, `${before.app}@${before.version}`, { job: id, message: status.message ?? null });
    return final;
  }

  setRollout(id: string, rollout: Rollout, state?: "running") {
    this.db.prepare(`UPDATE jobs SET rollout = ?${state ? ", state = 'running'" : ""} WHERE id = ?`).run(JSON.stringify(rollout), id);
  }

  /** Ends a job the Deployer itself finished (its own steps after the executor's part, or a deploy with no executor part). */
  finishJob(id: string, state: "succeeded" | "failed", message: string, status: ExecutorStatus): boolean {
    const before = this.job(id);
    if (!before || FINAL_STATES.includes(before.state)) return false;
    const at = this.stamp();
    this.db.prepare("UPDATE jobs SET state = ?, status = ?, message = ?, finished_at = ? WHERE id = ?")
      .run(state, JSON.stringify({ ...status, state, message, finishedAt: at }), message, at, id);
    this.insertAudit({ id: "deployer", via: "cli" }, `${before.kind}.${state}`, `${before.app}@${before.version}`, { job: id, message });
    return true;
  }

  componentState(app: string, component: string): { get<T>(key: string): T | undefined; set(key: string, value: unknown): void } {
    return {
      get: <T>(key: string) => {
        const r = this.db.prepare("SELECT value FROM component_state WHERE app = ? AND component = ? AND key = ?").get(app, component, key) as Row | undefined;
        return r ? (JSON.parse(r.value) as T) : undefined;
      },
      set: (key: string, value: unknown) => {
        this.db.prepare(`INSERT INTO component_state (app, component, key, value, updated_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (app, component, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(app, component, key, JSON.stringify(value), this.stamp());
      },
    };
  }

  addKey(k: Omit<ApiKey, "createdAt" | "lastUsedAt" | "revokedAt"> & { sha256: string }, actor: Actor): ApiKey {
    this.db.prepare("INSERT INTO api_keys (id, kind, name, prefix, sha256, owner, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(k.id, k.kind, k.name, k.prefix, k.sha256, k.owner, this.stamp(), k.expiresAt);
    this.insertAudit(actor, "key.create", k.id, { kind: k.kind, name: k.name, prefix: k.prefix, expiresAt: k.expiresAt });
    return this.listKeys().find((x) => x.id === k.id)!;
  }

  listKeys(): ApiKey[] {
    return (this.db.prepare("SELECT * FROM api_keys ORDER BY created_at DESC").all() as Row[]).map(toKey);
  }

  keyBySha(sha: string): ApiKey | undefined {
    const r = this.db.prepare("SELECT * FROM api_keys WHERE sha256 = ?").get(sha) as Row | undefined;
    return r && toKey(r);
  }

  touchKey(id: string) { this.db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(this.stamp(), id); }

  revokeKey(id: string, actor: Actor) {
    this.db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(this.stamp(), id);
    this.insertAudit(actor, "key.revoke", id, null);
  }

  /** An MCP command's answer by request_id, so a retry does not do it twice (§10.4). */
  mcpAnswer(keyId: string, requestId: string): { tool: string; response: unknown } | undefined {
    const r = this.db.prepare("SELECT tool, response FROM mcp_requests WHERE key_id = ? AND request_id = ?").get(keyId, requestId) as Row | undefined;
    return r && { tool: r.tool, response: JSON.parse(r.response) };
  }

  saveMcpAnswer(keyId: string, requestId: string, tool: string, response: unknown) {
    this.db.prepare("INSERT OR IGNORE INTO mcp_requests (key_id, request_id, tool, response, at) VALUES (?, ?, ?, ?, ?)").run(keyId, requestId, tool, JSON.stringify(response), this.stamp());
  }

  setDiagnosis(id: string, diagnosis: Diagnosis) {
    this.db.prepare("UPDATE jobs SET diagnosis = ? WHERE id = ?").run(JSON.stringify(diagnosis), id);
  }

  runningDiagnoses(): { job: string; diagnosis: Diagnosis }[] {
    return (this.db.prepare("SELECT id, diagnosis FROM jobs WHERE diagnosis LIKE '%\"state\":\"running\"%'").all() as Row[]).map((r) => ({ job: r.id, diagnosis: JSON.parse(r.diagnosis) }));
  }

  /** Marks an app as in trial from an assessment, or (null) registered for good. */
  setTrial(app: string, assessment: string | null, actor: Actor) {
    this.db.prepare("UPDATE apps SET trial = ? WHERE id = ?").run(assessment, app);
    this.insertAudit(actor, assessment ? "app.trial" : "app.register-trial", app, assessment ? { assessment } : null);
  }

  // Assessments (§10.5, phase 7): the record, its draft, facts, report and progress live in one JSON body.
  saveAssessment<T extends { id: string; kind: string; repo: string; app: string | null; version: string | null; state: string; requestedBy: string; createdAt: string }>(a: T): T {
    const at = this.stamp();
    this.db.prepare(`INSERT INTO assessments (id, kind, repo, app, version, state, requested_by, created_at, updated_at, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET app = excluded.app, version = excluded.version, state = excluded.state, updated_at = excluded.updated_at, body = excluded.body`)
      .run(a.id, a.kind, a.repo, a.app, a.version, a.state, a.requestedBy, a.createdAt, at, JSON.stringify({ ...a, updatedAt: at }));
    return { ...a, updatedAt: at };
  }

  assessment<T>(id: string): T | undefined {
    const r = this.db.prepare("SELECT body FROM assessments WHERE id = ?").get(id) as Row | undefined;
    return r ? (JSON.parse(r.body) as T) : undefined;
  }

  listAssessments<T>(limit = 100): T[] {
    return (this.db.prepare("SELECT body FROM assessments ORDER BY created_at DESC LIMIT ?").all(limit) as Row[]).map((r) => JSON.parse(r.body) as T);
  }

  // Drift (phase 8): what differs now, since when.
  listDrift(): DriftItem[] {
    return (this.db.prepare("SELECT * FROM drift ORDER BY first_seen").all() as Row[]).map((r) => ({ key: r.key, app: r.app, kind: r.kind, detail: r.detail, firstSeen: r.first_seen, lastSeen: r.last_seen }));
  }
  saveDrift(d: Pick<DriftItem, "key" | "app" | "kind" | "detail">) {
    const at = this.stamp();
    this.db.prepare("INSERT INTO drift (key, app, kind, detail, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET detail = excluded.detail, last_seen = excluded.last_seen").run(d.key, d.app, d.kind, d.detail, at, at);
  }
  resolveDrift(key: string) { this.db.prepare("DELETE FROM drift WHERE key = ?").run(key); }

  // Daily briefs (phase 8): one per day.
  saveBrief(date: string, brief: unknown) { this.db.prepare("INSERT INTO briefs (date, body) VALUES (?, ?) ON CONFLICT (date) DO UPDATE SET body = excluded.body").run(date, JSON.stringify(brief)); }
  latestBrief<T>(): T | undefined {
    const r = this.db.prepare("SELECT body FROM briefs ORDER BY date DESC LIMIT 1").get() as Row | undefined;
    return r ? (JSON.parse(r.body) as T) : undefined;
  }

  setObservation(id: string, observation: unknown) {
    this.db.prepare("UPDATE jobs SET observation = ? WHERE id = ?").run(JSON.stringify(observation), id);
  }

  job(id: string): Job | undefined {
    const r = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
    return r && toJob(r);
  }

  listJobs(filter: { app?: string; kind?: string; limit?: number } = {}): Job[] {
    const rows = this.db.prepare(`SELECT * FROM jobs WHERE (?1 IS NULL OR app = ?1) AND (?2 IS NULL OR kind = ?2) ORDER BY requested_at DESC, rowid DESC LIMIT ?3`)
      .all(filter.app ?? null, filter.kind ?? null, filter.limit ?? 50) as Row[];
    return rows.map(toJob);
  }

  activeJobs(): Job[] {
    return (this.db.prepare("SELECT * FROM jobs WHERE state IN ('queued', 'running') ORDER BY requested_at").all() as Row[]).map(toJob);
  }

  /** The version the last successful deploy put in place; a rolled-back deploy left the one before running. */
  deployedVersion(app: string): Job | undefined {
    const r = this.db.prepare("SELECT * FROM jobs WHERE app = ? AND kind = 'deploy' AND state = 'succeeded' ORDER BY finished_at DESC, rowid DESC LIMIT 1").get(app) as Row | undefined;
    return r && toJob(r);
  }

  successfulBuild(app: string, version: string): Job | undefined {
    const r = this.db.prepare("SELECT * FROM jobs WHERE app = ? AND version = ? AND kind = 'build' AND state = 'succeeded' ORDER BY finished_at DESC LIMIT 1").get(app, version) as Row | undefined;
    return r && toJob(r);
  }

  envRevisions(app: string): EnvRevision[] {
    return (this.db.prepare("SELECT * FROM env_revisions WHERE app = ? ORDER BY revision DESC").all(app) as Row[]).map(toEnvRevision);
  }

  envRevision(app: string, revision?: number): { meta: EnvRevision; values: StoredEnv } | undefined {
    const r = (revision === undefined
      ? this.db.prepare("SELECT * FROM env_revisions WHERE app = ? ORDER BY revision DESC LIMIT 1").get(app)
      : this.db.prepare("SELECT * FROM env_revisions WHERE app = ? AND revision = ?").get(app, revision)) as Row | undefined;
    return r && { meta: toEnvRevision(r), values: JSON.parse(r.body) };
  }

  /** The revision now on the server: the one most recently written there or imported from there. */
  appliedEnv(app: string): { meta: EnvRevision; values: StoredEnv } | undefined {
    const r = this.db.prepare("SELECT revision FROM env_revisions WHERE app = ? AND applied_at IS NOT NULL ORDER BY applied_at DESC, revision DESC LIMIT 1").get(app) as Row | undefined;
    return r ? this.envRevision(app, r.revision) : undefined;
  }

  saveEnv(app: string, values: StoredEnv, changes: EnvRevision["changes"], source: EnvRevision["source"], actor: Actor, options: { note?: string; appliedJob?: string; detail?: Record<string, unknown> } = {}): number {
    const at = this.stamp();
    this.db.exec("BEGIN");
    try {
      const last = this.db.prepare("SELECT MAX(revision) AS r FROM env_revisions WHERE app = ?").get(app) as Row;
      const revision = (last.r ?? 0) + 1;
      this.db.prepare(`INSERT INTO env_revisions (app, revision, body, changes, source, saved_at, saved_by, via, note, applied_at, applied_job)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(app, revision, JSON.stringify(values), JSON.stringify(changes), source, at, actor.id, actor.via, options.note ?? null,
          options.appliedJob ? at : null, options.appliedJob ?? null);
      // Secrets appear by name only (§7.2: "changed"), as in the revision's own change list.
      this.insertAudit(actor, `env.${source}`, `${app}#${revision}`, { changes, ...options.detail });
      this.db.exec("COMMIT");
      return revision;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  markEnvApplied(app: string, revision: number, job: string) {
    this.db.prepare("UPDATE env_revisions SET applied_at = ?, applied_job = ? WHERE app = ? AND revision = ?").run(this.stamp(), job, app, revision);
  }

  /** Records an artifact the first time it is seen; later sightings keep the first origin. */
  recordArtifact(a: Omit<Artifact, "seenAt">) {
    this.db.prepare(`INSERT INTO artifacts (app, service, digest, version, ref, origin, build, job, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (app, service, digest) DO UPDATE SET build = COALESCE(artifacts.build, excluded.build)`)
      .run(a.app, a.service, a.digest, a.version, a.ref, a.origin, a.build ? JSON.stringify(a.build) : null, a.job, this.stamp());
  }

  artifacts(app?: string, limit = 200): Artifact[] {
    const rows = this.db.prepare("SELECT * FROM artifacts WHERE (?1 IS NULL OR app = ?1) ORDER BY seen_at DESC, rowid DESC LIMIT ?2").all(app ?? null, limit) as Row[];
    return rows.map((r) => ({ app: r.app, service: r.service, digest: r.digest, version: r.version, ref: r.ref, origin: r.origin, build: parse(r.build), job: r.job, seenAt: r.seen_at }));
  }

  /** Successful deploys of an app, newest first, each with when the next successful deploy replaced it. */
  deployRecords(app: string, version?: string): DeployRecord[] {
    const rows = (this.db.prepare("SELECT * FROM jobs WHERE app = ? AND kind = 'deploy' AND state = 'succeeded' ORDER BY finished_at, rowid").all(app) as Row[]).map(toJob);
    const records = rows.map((j, i) => ({
      id: j.id, version: j.version, digests: j.status?.result.digests ?? {}, deployedAt: j.finishedAt!, replacedAt: rows[i + 1]?.finishedAt ?? null,
      envRevision: typeof j.request.envRevision === "number" ? j.request.envRevision : null,
      // D38 ⑤: PROD deploys with the manifest revision UAT deployed with.
      manifest: j.manifest,
    }));
    return records.filter((r) => !version || r.version === version).reverse();
  }

  addEmergencySession(tokenSha256: string, csrf: string, ttlMs: number) {
    this.db.prepare("DELETE FROM emergency_sessions WHERE expires_at < ?").run(this.now().getTime());
    this.db.prepare("INSERT INTO emergency_sessions (token_sha256, csrf, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(tokenSha256, csrf, this.stamp(), this.now().getTime() + ttlMs);
  }

  emergencySession(tokenSha256: string): { csrf: string } | undefined {
    const r = this.db.prepare("SELECT csrf FROM emergency_sessions WHERE token_sha256 = ? AND expires_at >= ?").get(tokenSha256, this.now().getTime()) as Row | undefined;
    return r && { csrf: r.csrf };
  }

  endEmergencySession(tokenSha256: string) {
    this.db.prepare("DELETE FROM emergency_sessions WHERE token_sha256 = ?").run(tokenSha256);
  }

  // D35: executors on each host reach the Deployer over HTTPS; their jobs, heartbeats and host state live here.
  // S18: a host may run a deploy executor and a service executor, each with its own tokens, heartbeat and jobs.
  // The deploy executor's rows keep executor NULL (as before S18) and its heartbeat stays in executor_hosts.

  addExecutorToken(host: string, sha256: string, prefix: string, actor: Actor, executor: ExecutorKind = "deploy") {
    this.db.prepare("INSERT INTO executor_tokens (sha256, host, prefix, created_at, created_by, executor) VALUES (?, ?, ?, ?, ?, ?)").run(sha256, host, prefix, this.stamp(), actor.id, executor === "deploy" ? null : executor);
    this.audit(actor, "host.token-created", host, { prefix, executor });
  }

  /** Revokes the host's tokens: one executor's, or (none named) every executor's. */
  revokeExecutorTokens(host: string, actor: Actor, executor?: ExecutorKind): number {
    const n = Number(this.db.prepare("UPDATE executor_tokens SET revoked_at = ?1 WHERE host = ?2 AND revoked_at IS NULL AND (?3 IS NULL OR COALESCE(executor, 'deploy') = ?3)").run(this.stamp(), host, executor ?? null).changes);
    this.audit(actor, "host.token-revoked", host, { tokens: n, ...(executor ? { executor } : {}) });
    return n;
  }

  /** The host a live executor token belongs to, and which of its executors. */
  executorOf(sha256: string): { host: string; executor: ExecutorKind } | undefined {
    const r = this.db.prepare("SELECT host, executor FROM executor_tokens WHERE sha256 = ? AND revoked_at IS NULL").get(sha256) as Row | undefined;
    return r && { host: r.host, executor: (r.executor ?? "deploy") as ExecutorKind };
  }

  /** The host a live executor token belongs to. */
  executorHost(sha256: string): string | undefined {
    return this.executorOf(sha256)?.host;
  }

  executorTokens(): { host: string; executor: ExecutorKind; prefix: string; createdAt: string; createdBy: string; revokedAt: string | null }[] {
    return (this.db.prepare("SELECT * FROM executor_tokens ORDER BY created_at").all() as Row[]).map((r) => ({ host: r.host, executor: (r.executor ?? "deploy") as ExecutorKind, prefix: r.prefix, createdAt: r.created_at, createdBy: r.created_by, revokedAt: r.revoked_at ?? null }));
  }

  queueExecutorJob(id: string, host: string, request: Record<string, unknown>, content?: string, executor: ExecutorKind = "deploy") {
    this.db.prepare("INSERT INTO executor_jobs (id, host, request, content, queued_at, executor) VALUES (?, ?, ?, ?, ?, ?)").run(id, host, JSON.stringify(request), content ?? null, this.stamp(), executor === "deploy" ? null : executor);
  }

  /** Claims the oldest job queued for one executor of a host; an env job's content leaves the queue with it. */
  claimExecutorJob(host: string, executor: ExecutorKind = "deploy"): Record<string, unknown> | undefined {
    const r = this.db.prepare("SELECT id, request, content FROM executor_jobs WHERE host = ? AND COALESCE(executor, 'deploy') = ? AND picked_at IS NULL ORDER BY queued_at, rowid LIMIT 1").get(host, executor) as Row | undefined;
    if (!r) return undefined;
    this.db.prepare("UPDATE executor_jobs SET picked_at = ?, content = NULL WHERE id = ?").run(this.stamp(), r.id);
    const request = JSON.parse(r.request) as Record<string, unknown>;
    return r.content === null ? request : { ...request, content: r.content };
  }

  executorJob(id: string): { host: string; executor: ExecutorKind; request: Record<string, unknown>; pickedAt: string | null; status: ExecutorStatus | null; log: string } | undefined {
    const r = this.db.prepare("SELECT host, executor, request, picked_at, status, log FROM executor_jobs WHERE id = ?").get(id) as Row | undefined;
    return r && { host: r.host, executor: (r.executor ?? "deploy") as ExecutorKind, request: JSON.parse(r.request), pickedAt: r.picked_at ?? null, status: parse(r.status), log: r.log };
  }

  executorJobs(host?: string): { id: string; host: string; pickedAt: string | null }[] {
    return (this.db.prepare("SELECT id, host, picked_at FROM executor_jobs WHERE (?1 IS NULL OR host = ?1) ORDER BY queued_at, rowid").all(host ?? null) as Row[]).map((r) => ({ id: r.id, host: r.host, pickedAt: r.picked_at ?? null }));
  }

  /** The newest job of one kind queued for one executor of a host (job ids start with their kind, newJobId). */
  latestExecutorJob(host: string, executor: ExecutorKind, kind: string, succeeded = false): string | undefined {
    const r = this.db.prepare(`SELECT id FROM executor_jobs WHERE host = ? AND COALESCE(executor, 'deploy') = ? AND substr(id, 1, ?) = ?${succeeded ? " AND json_extract(status, '$.state') = 'succeeded'" : ""} ORDER BY queued_at DESC, rowid DESC LIMIT 1`)
      .get(host, executor, kind.length + 1, `${kind}-`) as Row | undefined;
    return r?.id;
  }

  setExecutorStatus(id: string, status: ExecutorStatus) {
    this.db.prepare("UPDATE executor_jobs SET status = ? WHERE id = ?").run(JSON.stringify(status), id);
  }

  /** Appends to a job's log, keeping its last 2 MB. */
  appendExecutorLog(id: string, text: string) {
    this.db.prepare("UPDATE executor_jobs SET log = substr(log || ?, -2097152) WHERE id = ?").run(text, id);
  }

  setExecutorEnvContent(id: string, content: string) {
    this.db.prepare("UPDATE executor_jobs SET env_content = ?, env_content_at = ? WHERE id = ?").run(content, this.stamp(), id);
  }

  /** An env-read copy is for the import within seconds: it is handed over once, and dropped after 10 minutes anyway. */
  takeExecutorEnvContent(id: string): string | undefined {
    this.db.prepare("UPDATE executor_jobs SET env_content = NULL WHERE env_content_at < ?").run(new Date(this.now().getTime() - 600_000).toISOString());
    const r = this.db.prepare("SELECT env_content FROM executor_jobs WHERE id = ?").get(id) as Row | undefined;
    if (r?.env_content == null) return undefined;
    this.db.prepare("UPDATE executor_jobs SET env_content = NULL WHERE id = ?").run(id);
    return r.env_content;
  }

  setHeartbeat(host: string, heartbeat: unknown, executor: ExecutorKind = "deploy") {
    if (executor !== "deploy") {
      this.db.prepare("INSERT INTO executor_beats (host, executor, heartbeat, beat_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (host, executor) DO UPDATE SET heartbeat = ?3, beat_at = ?4").run(host, executor, JSON.stringify(heartbeat), this.stamp());
      return;
    }
    this.db.prepare("INSERT INTO executor_hosts (host, heartbeat, beat_at) VALUES (?1, ?2, ?3) ON CONFLICT (host) DO UPDATE SET heartbeat = ?2, beat_at = ?3").run(host, JSON.stringify(heartbeat), this.stamp());
  }

  setHostState(host: string, containers: unknown[], files: Record<string, string>) {
    this.db.prepare("INSERT INTO executor_hosts (host, containers, files, state_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (host) DO UPDATE SET containers = ?2, files = ?3, state_at = ?4").run(host, JSON.stringify(containers), JSON.stringify(files), this.stamp());
  }

  /** The last heartbeat of a host's service executor (S18); the deploy executor's is in executorHosts(). */
  executorBeat(host: string, executor: ExecutorKind): { heartbeat: unknown; beatAt: string } | undefined {
    const r = this.db.prepare("SELECT heartbeat, beat_at FROM executor_beats WHERE host = ? AND executor = ?").get(host, executor) as Row | undefined;
    return r && { heartbeat: parse(r.heartbeat), beatAt: r.beat_at };
  }

  executorHosts(): { host: string; heartbeat: unknown; beatAt: string | null; containers: unknown[] | null; files: Record<string, string> | null; stateAt: string | null }[] {
    return (this.db.prepare("SELECT * FROM executor_hosts ORDER BY host").all() as Row[]).map((r) => ({ host: r.host, heartbeat: parse(r.heartbeat), beatAt: r.beat_at ?? null, containers: parse(r.containers), files: parse(r.files), stateAt: r.state_at ?? null }));
  }

  // D36: environment-wide settings an administrator keeps on the page (the internal CA certificate).

  setting(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as Row | undefined)?.value;
  }

  settingMeta(key: string): { updatedAt: string; updatedBy: string } | undefined {
    const r = this.db.prepare("SELECT updated_at, updated_by FROM settings WHERE key = ?").get(key) as Row | undefined;
    return r ? { updatedAt: r.updated_at, updatedBy: r.updated_by } : undefined;
  }

  setSetting(key: string, value: string | null, actor: Actor) {
    if (value === null) this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
    else this.db.prepare("INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (key) DO UPDATE SET value = ?2, updated_at = ?3, updated_by = ?4").run(key, value, this.stamp(), actor.id);
    this.audit(actor, "setting.changed", key, { cleared: value === null });
  }

  // D36: the recommended nginx configuration, kept as revisions for operations to apply.

  saveNginx(body: string, sha256: string, actor: Actor, note?: string): number {
    const next = Number((this.db.prepare("SELECT COALESCE(MAX(revision), 0) + 1 AS n FROM nginx_revisions").get() as Row).n);
    this.db.prepare("INSERT INTO nginx_revisions (revision, body, sha256, saved_at, saved_by, note) VALUES (?, ?, ?, ?, ?, ?)").run(next, body, sha256, this.stamp(), actor.id, note ?? null);
    this.audit(actor, "nginx.revision", String(next), { sha256, note: note ?? null });
    return next;
  }

  nginxRevisions(): { revision: number; sha256: string; savedAt: string; savedBy: string; note: string | null }[] {
    return (this.db.prepare("SELECT revision, sha256, saved_at, saved_by, note FROM nginx_revisions ORDER BY revision DESC").all() as Row[]).map((r) => ({ revision: r.revision, sha256: r.sha256, savedAt: r.saved_at, savedBy: r.saved_by, note: r.note ?? null }));
  }

  nginxRevision(revision?: number): { revision: number; body: string; sha256: string; savedAt: string; savedBy: string; note: string | null } | undefined {
    const r = (revision === undefined ? this.db.prepare("SELECT * FROM nginx_revisions ORDER BY revision DESC LIMIT 1").get() : this.db.prepare("SELECT * FROM nginx_revisions WHERE revision = ?").get(revision)) as Row | undefined;
    return r && { revision: r.revision, body: r.body, sha256: r.sha256, savedAt: r.saved_at, savedBy: r.saved_by, note: r.note ?? null };
  }

  // Service ops §5.2, §6 (S4): takeover drafts, and the standalone instances and clusters they become when confirmed.
  // A draft is edited item by item while open; confirming (step 5) registers its items and closes it.

  private inTransaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private draftItems(draft: string): DraftItem[] {
    return (this.db.prepare("SELECT body FROM service_draft_items WHERE draft = ? ORDER BY rowid").all(draft) as Row[]).map((r) => JSON.parse(r.body));
  }

  private openDraft(id: string): Row {
    const d = this.db.prepare("SELECT * FROM service_drafts WHERE id = ?").get(id) as Row | undefined;
    if (!d) throw new StoreError("draft/unknown", `No takeover draft ${id}.`);
    if (d.state !== "open") throw new StoreError("draft/closed", `Takeover draft ${id} is ${d.state}.`);
    return d;
  }

  private checkItem(item: DraftItem, others: DraftItem[]) {
    const errors = checkDraftItem(item, others);
    if (errors.length) throw new StoreError("draft/item-invalid", `Draft item ${item?.id ?? "?"} is not valid.`, errors);
  }

  /** A new open draft from discoveries (sources: one job per host), with the items proposed from them. */
  createServiceDraft(environment: string, sources: { job: string; host: string }[], items: DraftItem[], actor: Actor): ServiceDraft {
    const id = `draft-${randomBytes(6).toString("hex")}`;
    items.forEach((item, i) => this.checkItem(item, items.filter((_, j) => j !== i)));
    if (new Set(items.map((x) => x.id)).size !== items.length) throw new StoreError("draft/item-invalid", "Two draft items have the same id.");
    const at = this.stamp();
    this.inTransaction(() => {
      this.db.prepare("INSERT INTO service_drafts (id, state, environment, sources, created_at, created_by, updated_at, updated_by) VALUES (?, 'open', ?, ?, ?, ?, ?, ?)")
        .run(id, environment, JSON.stringify(sources), at, actor.id, at, actor.id);
      for (const item of items) this.db.prepare("INSERT INTO service_draft_items (draft, id, kind, body, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)").run(id, item.id, item.kind, JSON.stringify(item), at, actor.id);
      this.insertAudit(actor, "service.draft-created", id, { sources, items: items.map((x) => x.id) });
    });
    return this.serviceDraft(id)!;
  }

  serviceDraft(id: string): ServiceDraft | undefined {
    const d = this.db.prepare("SELECT * FROM service_drafts WHERE id = ?").get(id) as Row | undefined;
    if (!d) return undefined;
    const items = (this.db.prepare("SELECT body, updated_at, updated_by FROM service_draft_items WHERE draft = ? ORDER BY rowid").all(id) as Row[])
      .map((r) => ({ ...JSON.parse(r.body), updatedAt: r.updated_at, updatedBy: r.updated_by }));
    return { id: d.id, state: d.state, environment: d.environment, sources: JSON.parse(d.sources), items, review: parse(d.review ?? null), createdAt: d.created_at, createdBy: d.created_by, updatedAt: d.updated_at, updatedBy: d.updated_by };
  }

  /** Drafts newest first, without their items. */
  serviceDrafts(state?: DraftState): Omit<ServiceDraft, "items" | "review">[] {
    return (this.db.prepare("SELECT * FROM service_drafts WHERE (?1 IS NULL OR state = ?1) ORDER BY created_at DESC, rowid DESC").all(state ?? null) as Row[])
      .map((d) => ({ id: d.id, state: d.state, environment: d.environment, sources: JSON.parse(d.sources), createdAt: d.created_at, createdBy: d.created_by, updatedAt: d.updated_at, updatedBy: d.updated_by }));
  }

  /** Adds an item to an open draft, or replaces the one with its id. */
  putServiceDraftItem(draft: string, given: DraftItem, actor: Actor): "added" | "changed" {
    // An item read back from serviceDraft() carries its updatedAt/updatedBy; they are the row's, not the item's.
    const { updatedAt: _a, updatedBy: _b, ...item } = given as DraftItem & { updatedAt?: string; updatedBy?: string };
    return this.inTransaction(() => {
      this.openDraft(draft);
      const others = this.draftItems(draft);
      this.checkItem(item as DraftItem, others);
      const exists = others.some((o) => o.id === item.id);
      const at = this.stamp();
      if (exists) this.db.prepare("UPDATE service_draft_items SET kind = ?, body = ?, updated_at = ?, updated_by = ? WHERE draft = ? AND id = ?").run(item.kind, JSON.stringify(item), at, actor.id, draft, item.id);
      else this.db.prepare("INSERT INTO service_draft_items (draft, id, kind, body, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)").run(draft, item.id, item.kind, JSON.stringify(item), at, actor.id);
      this.db.prepare("UPDATE service_drafts SET updated_at = ?, updated_by = ? WHERE id = ?").run(at, actor.id, draft);
      this.insertAudit(actor, exists ? "service.draft-item-changed" : "service.draft-item-added", `${draft}/${item.id}`, { kind: item.kind });
      return exists ? "changed" : "added";
    });
  }

  removeServiceDraftItem(draft: string, itemId: string, actor: Actor) {
    this.inTransaction(() => {
      this.openDraft(draft);
      if (!Number(this.db.prepare("DELETE FROM service_draft_items WHERE draft = ? AND id = ?").run(draft, itemId).changes)) throw new StoreError("draft/item-unknown", `Draft ${draft} has no item ${itemId}.`);
      this.db.prepare("UPDATE service_drafts SET updated_at = ?, updated_by = ? WHERE id = ?").run(this.stamp(), actor.id, draft);
      this.insertAudit(actor, "service.draft-item-removed", `${draft}/${itemId}`, null);
    });
  }

  /** The assessment again (step 5): every item's body replaced at once, the items themselves unchanged. */
  reassessServiceDraft(draft: string, items: DraftItem[], actor: Actor) {
    this.inTransaction(() => {
      this.openDraft(draft);
      const ids = new Set(this.draftItems(draft).map((i) => i.id));
      if (items.length !== ids.size || items.some((i) => !ids.has(i.id))) throw new StoreError("draft/item-invalid", "A reassessment keeps the draft's items.");
      const at = this.stamp();
      for (const item of items) this.db.prepare("UPDATE service_draft_items SET body = ?, updated_at = ?, updated_by = ? WHERE draft = ? AND id = ?").run(JSON.stringify(item), at, actor.id, draft, item.id);
      this.db.prepare("UPDATE service_drafts SET updated_at = ?, updated_by = ? WHERE id = ?").run(at, actor.id, draft);
      this.insertAudit(actor, "service.draft-assessed", draft, { findings: Object.fromEntries(items.map((i) => [i.id, (i.findings ?? []).length])) });
    });
  }

  /** The AI review's state (P1); written by the request and when the session ends, not an edit of the draft. */
  setServiceDraftReview(draft: string, review: DraftReview | null) {
    this.db.prepare("UPDATE service_drafts SET review = ? WHERE id = ?").run(review && JSON.stringify(review), draft);
  }

  /**
   * Confirms an open draft (§6 step 5): registers every item, keeps each one's imported configuration as its revision 1,
   * and closes the draft, all in one transaction. expected: the draft's updatedAt the confirmation was prepared on (the
   * files were read for that version of it); a draft changed meanwhile is refused.
   */
  confirmServiceDraft(draft: string, configs: Record<string, ServiceConfigBody>, actor: Actor, expected?: string): string[] {
    return this.inTransaction(() => {
      const d = this.openDraft(draft);
      if (expected !== undefined && d.updated_at !== expected) throw new StoreError("draft/changed", `Takeover draft ${draft} changed while it was being confirmed; confirm it again.`);
      const items = this.draftItems(draft);
      if (!items.length) throw new StoreError("draft/empty", `Takeover draft ${draft} has no items.`);
      const missing = items.filter((i) => !configs[i.id]);
      if (missing.length) throw new StoreError("draft/config-missing", "Every item needs its configuration imported.", missing.map((i) => i.id));
      const at = this.stamp();
      for (const item of items) {
        if (item.kind === "standalone") this.insertStandalone(item, d.environment, actor, draft);
        else this.insertCluster(item, d.environment, actor, draft);
        this.db.prepare("INSERT INTO service_configs (service, revision, body, source, saved_at, saved_by, via, note) VALUES (?, 1, ?, 'import', ?, ?, ?, ?)")
          .run(item.id, JSON.stringify(configs[item.id]), at, actor.id, actor.via, `Imported when takeover draft ${draft} was confirmed`);
        this.insertAudit(actor, "service.config-imported", `${item.id}#1`, { files: configs[item.id]!.members.map((m) => ({ installation: `${m.host}:${m.installDir}`, files: m.files.map((f) => `${f.name} ${f.sha256.slice(0, 12)}`) })) });
      }
      this.db.prepare("UPDATE service_drafts SET state = 'confirmed', updated_at = ?, updated_by = ? WHERE id = ?").run(at, actor.id, draft);
      this.insertAudit(actor, "service.draft-confirmed", draft, { items: items.map((i) => i.id) });
      return items.map((i) => i.id);
    });
  }

  /** A service's configuration at a revision (the newest when none is given), sealed copies included. */
  serviceConfig(service: string, revision?: number): { service: string; revision: number; body: ServiceConfigBody; source: string; savedAt: string; savedBy: string; via: string; note: string | null } | undefined {
    const r = (revision === undefined
      ? this.db.prepare("SELECT * FROM service_configs WHERE service = ? ORDER BY revision DESC LIMIT 1").get(service)
      : this.db.prepare("SELECT * FROM service_configs WHERE service = ? AND revision = ?").get(service, revision)) as Row | undefined;
    return r && { service: r.service, revision: r.revision, body: JSON.parse(r.body), source: r.source, savedAt: r.saved_at, savedBy: r.saved_by, via: r.via, note: r.note ?? null };
  }

  serviceConfigRevisions(service: string): { revision: number; source: string; savedAt: string; savedBy: string; note: string | null }[] {
    return (this.db.prepare("SELECT revision, source, saved_at, saved_by, note FROM service_configs WHERE service = ? ORDER BY revision DESC").all(service) as Row[])
      .map((r) => ({ revision: r.revision, source: r.source, savedAt: r.saved_at, savedBy: r.saved_by, note: r.note ?? null }));
  }

  /** Closes an open draft without registering anything; its items stay for the record. */
  discardServiceDraft(draft: string, actor: Actor) {
    this.inTransaction(() => {
      this.openDraft(draft);
      this.db.prepare("UPDATE service_drafts SET state = 'discarded', updated_at = ?, updated_by = ? WHERE id = ?").run(this.stamp(), actor.id, draft);
      this.insertAudit(actor, "service.draft-discarded", draft, null);
    });
  }

  /** The registered standalone instance or cluster node using an installation, if any. */
  serviceUsing(host: string, installDir: string): string | undefined {
    const dir = installDir.replace(/\/+$/, "");
    const s = this.db.prepare("SELECT id FROM service_standalones WHERE host = ? AND install_dir = ? AND removed_at IS NULL").get(host, dir) as Row | undefined;
    if (s) return s.id;
    const n = this.db.prepare("SELECT n.cluster FROM service_nodes n JOIN service_clusters c ON c.id = n.cluster WHERE n.host = ? AND n.install_dir = ? AND n.removed_at IS NULL AND c.removed_at IS NULL").get(host, dir) as Row | undefined;
    return n?.cluster;
  }

  private checkRegistration(item: DraftItem, members: ServiceMember[]) {
    this.checkItem(item, []);
    if (this.db.prepare("SELECT 1 FROM service_standalones WHERE id = ?1 UNION SELECT 1 FROM service_clusters WHERE id = ?1").get(item.id))
      throw new StoreError("service/exists", `A service ${item.id} is already registered.`);
    const used = members.map((m) => [m, this.serviceUsing(m.host, m.installDir)] as const).filter(([, s]) => s);
    if (used.length) throw new StoreError("service/install-used", "An installation is already registered.", used.map(([m, s]) => `${m.host}:${m.installDir} is in ${s}`));
  }

  /** Registers a standalone instance (step 5 does it when a draft is confirmed). */
  addStandalone(s: DraftStandalone, environment: string, actor: Actor, draft: string | null = null) {
    this.inTransaction(() => this.insertStandalone(s, environment, actor, draft));
  }

  /** Registers a cluster with its nodes. */
  addCluster(c: DraftCluster, environment: string, actor: Actor, draft: string | null = null) {
    this.inTransaction(() => this.insertCluster(c, environment, actor, draft));
  }

  // The registrations themselves, inside the caller's transaction (transactions do not nest).
  private insertStandalone(s: DraftStandalone, environment: string, actor: Actor, draft: string | null) {
    this.checkRegistration(s, [s.member]);
    const m = s.member;
    this.db.prepare(`INSERT INTO service_standalones (id, service, profile, version, environment, host, install_dir, service_user, start_env, ports, web_url, draft, discovery, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(s.id, s.service, s.profile, s.version, environment, m.host, m.installDir.replace(/\/+$/, ""), m.serviceUser,
      m.startEnvironment && JSON.stringify(m.startEnvironment), JSON.stringify(m.ports), s.webUrl, draft, m.discovery ? JSON.stringify(m.discovery) : null, this.stamp(), actor.id);
    this.insertAudit(actor, "service.standalone-added", s.id, { host: m.host, installDir: m.installDir, version: s.version, draft });
  }

  private insertCluster(c: DraftCluster, environment: string, actor: Actor, draft: string | null) {
    this.checkRegistration(c, c.nodes);
    const at = this.stamp();
    this.db.prepare(`INSERT INTO service_clusters (id, service, profile, version, environment, zookeeper, zookeeper_root, web_url, draft, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(c.id, c.service, c.profile, c.version, environment, c.zookeeper, c.zookeeperRoot, c.webUrl, draft, at, actor.id);
    for (const n of c.nodes) {
      this.db.prepare(`INSERT INTO service_nodes (cluster, host, install_dir, service_user, start_env, control, ports, node_address, discovery, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(c.id, n.host, n.installDir.replace(/\/+$/, ""), n.serviceUser, n.startEnvironment && JSON.stringify(n.startEnvironment), "nifi.sh", JSON.stringify(n.ports), n.nodeAddress ?? null, n.discovery ? JSON.stringify(n.discovery) : null, at);
    }
    this.insertAudit(actor, "service.cluster-added", c.id, { nodes: c.nodes.map((n) => `${n.host}:${n.installDir}`), version: c.version, draft });
  }

  private toMember(r: Row): ServiceMember & { control?: string } {
    return { host: r.host, installDir: r.install_dir, serviceUser: r.service_user ?? null, startEnvironment: parse(r.start_env), ports: JSON.parse(r.ports), ...(r.node_address !== undefined ? { nodeAddress: r.node_address ?? null } : {}), discovery: parse(r.discovery), ...(r.control ? { control: r.control } : {}) };
  }

  standalones(): (DraftStandalone & { environment: string; draft: string | null; createdAt: string; createdBy: string })[] {
    return (this.db.prepare("SELECT * FROM service_standalones WHERE removed_at IS NULL ORDER BY id").all() as Row[]).map((r) => ({
      kind: "standalone", id: r.id, service: r.service, profile: r.profile, version: r.version, webUrl: r.web_url ?? null, member: this.toMember(r),
      environment: r.environment, draft: r.draft ?? null, createdAt: r.created_at, createdBy: r.created_by,
    }));
  }

  clusters(): (DraftCluster & { environment: string; draft: string | null; createdAt: string; createdBy: string })[] {
    return (this.db.prepare("SELECT * FROM service_clusters WHERE removed_at IS NULL ORDER BY id").all() as Row[]).map((r) => ({
      kind: "cluster", id: r.id, service: r.service, profile: r.profile, version: r.version, webUrl: r.web_url ?? null, zookeeper: r.zookeeper ?? null, zookeeperRoot: r.zookeeper_root ?? null,
      nodes: (this.db.prepare("SELECT * FROM service_nodes WHERE cluster = ? AND removed_at IS NULL ORDER BY host, install_dir").all(r.id) as Row[]).map((n) => this.toMember(n)),
      environment: r.environment, draft: r.draft ?? null, createdAt: r.created_at, createdBy: r.created_by,
    }));
  }
}
