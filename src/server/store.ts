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
import { checkDraftItem, confDirOf, installKey, type DraftCluster, type DraftItem, type DraftReview, type DraftStandalone, type DraftState, type ServiceDraft, type ServiceMember } from "./services/draft.ts";
import type { ServiceConfigBody } from "./services/config.ts";
import type { ConfigFinding } from "./services/configcheck.ts";
import type { DraftChange } from "./services/configedit.ts";
import type { ConfigReview } from "./services/configreview.ts";
import { randomBytes } from "node:crypto";

export interface Actor { id: string; via: "workbench" | "emergency" | "cli" | "key" | "service" }

export interface ManifestRevision { appliesFrom: string; revision: number; savedAt: string; savedBy: string; note: string | null }
/** trial: in UAT for a trial deploy from an assessment (§10.5.1 ⑤), not yet registered by an administrator (⑥). */
export interface RegisteredApp { id: string; name: string; repo: string; addedAt: string; addedBy: string; manifests: ManifestRevision[]; trial: string | null }
export interface AuditEntry { id: number; at: string; actor: string; via: string; action: string; target: string; detail: unknown }

/** A configuration draft (§16.3): changes on a revision; saving makes it the next revision. */
export interface ServiceConfigDraft {
  id: string; service: string; base: number; state: "open" | "saved" | "discarded"; changes: DraftChange[]; note: string | null; findings: ConfigFinding[];
  createdAt: string; createdBy: string; via: string; updatedAt: string; updatedBy: string; savedRevision: number | null;
}
/** What one member's file should be: written by a change (or the import), so it can lag the newest revision. */
export interface ServiceMemberFile {
  member: string; file: string; path: string; expectedSha256: string; revision: number; appliedAt: string; change: string | null; actualSha256: string | null; actualAt: string | null;
}

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
  thresholds TEXT, draft TEXT, discovery TEXT, created_at TEXT NOT NULL, created_by TEXT NOT NULL, removed_at TEXT, removed_by TEXT, conf_dir TEXT);
CREATE TABLE IF NOT EXISTS service_clusters (
  id TEXT PRIMARY KEY, service TEXT NOT NULL, profile TEXT NOT NULL, version TEXT NOT NULL, environment TEXT NOT NULL,
  zookeeper TEXT, zookeeper_root TEXT, web_url TEXT, thresholds TEXT, draft TEXT,
  created_at TEXT NOT NULL, created_by TEXT NOT NULL, removed_at TEXT, removed_by TEXT);
CREATE TABLE IF NOT EXISTS service_nodes (
  cluster TEXT NOT NULL REFERENCES service_clusters(id), host TEXT NOT NULL, install_dir TEXT NOT NULL, service_user TEXT,
  start_env TEXT, control TEXT NOT NULL, ports TEXT NOT NULL, node_address TEXT, discovery TEXT,
  added_at TEXT NOT NULL, removed_at TEXT, conf_dir TEXT, PRIMARY KEY (cluster, host, install_dir));
CREATE TABLE IF NOT EXISTS service_drafts (
  id TEXT PRIMARY KEY, state TEXT NOT NULL, environment TEXT NOT NULL, sources TEXT NOT NULL,
  created_at TEXT NOT NULL, created_by TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL, review TEXT);
CREATE TABLE IF NOT EXISTS service_draft_items (
  draft TEXT NOT NULL REFERENCES service_drafts(id), id TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL,
  updated_at TEXT NOT NULL, updated_by TEXT NOT NULL, PRIMARY KEY (draft, id));
CREATE TABLE IF NOT EXISTS service_configs (
  service TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, source TEXT NOT NULL, saved_at TEXT NOT NULL,
  saved_by TEXT NOT NULL, via TEXT NOT NULL, note TEXT, base INTEGER, findings TEXT, review TEXT, PRIMARY KEY (service, revision));
CREATE TABLE IF NOT EXISTS service_config_drafts (
  id TEXT PRIMARY KEY, service TEXT NOT NULL, base_revision INTEGER NOT NULL, state TEXT NOT NULL, changes TEXT NOT NULL, note TEXT, findings TEXT,
  created_at TEXT NOT NULL, created_by TEXT NOT NULL, via TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL, saved_revision INTEGER);
CREATE INDEX IF NOT EXISTS service_config_drafts_service ON service_config_drafts (service, state);
CREATE TABLE IF NOT EXISTS service_member_files (
  service TEXT NOT NULL, member TEXT NOT NULL, file TEXT NOT NULL, path TEXT NOT NULL, expected_sha256 TEXT NOT NULL, revision INTEGER NOT NULL,
  applied_at TEXT NOT NULL, change TEXT, actual_sha256 TEXT, actual_at TEXT, PRIMARY KEY (service, member, file));
CREATE TABLE IF NOT EXISTS service_samples (
  service TEXT NOT NULL, member TEXT NOT NULL, at TEXT NOT NULL, body TEXT NOT NULL, received_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS service_samples_at ON service_samples (service, member, at);
CREATE TABLE IF NOT EXISTS service_rollups (
  service TEXT NOT NULL, member TEXT NOT NULL, bucket TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (service, member, bucket));
CREATE TABLE IF NOT EXISTS service_bulletins (
  service TEXT NOT NULL, member TEXT NOT NULL, node TEXT NOT NULL, bulletin_id INTEGER NOT NULL, at TEXT NOT NULL, level TEXT,
  category TEXT, source TEXT, source_type TEXT, message TEXT, received_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS service_bulletins_key ON service_bulletins (service, node, bulletin_id, at);
CREATE INDEX IF NOT EXISTS service_bulletins_at ON service_bulletins (service, at);
CREATE TABLE IF NOT EXISTS service_certs (
  service TEXT NOT NULL, member TEXT NOT NULL, store TEXT NOT NULL, path TEXT, type TEXT, alias TEXT, chain INTEGER,
  subject TEXT, issuer TEXT, not_before TEXT, not_after TEXT, read_at TEXT NOT NULL, error TEXT);
CREATE INDEX IF NOT EXISTS service_certs_member ON service_certs (service, member);
CREATE TABLE IF NOT EXISTS service_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, service TEXT NOT NULL, member TEXT NOT NULL, rule TEXT NOT NULL, level TEXT NOT NULL,
  state TEXT NOT NULL, opened_at TEXT NOT NULL, resolved_at TEXT, detail TEXT, updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS service_alerts_open ON service_alerts (service, member, rule) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS service_alerts_at ON service_alerts (service, opened_at);
CREATE TABLE IF NOT EXISTS service_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, service TEXT NOT NULL, member TEXT, at TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT);
CREATE INDEX IF NOT EXISTS service_events_at ON service_events (service, at);
CREATE TABLE IF NOT EXISTS service_facts (
  service TEXT NOT NULL, member TEXT NOT NULL, key TEXT NOT NULL, value TEXT, at TEXT NOT NULL, PRIMARY KEY (service, member, key));
CREATE TABLE IF NOT EXISTS service_log_patterns (
  service TEXT NOT NULL, member TEXT NOT NULL, pattern TEXT NOT NULL, level TEXT NOT NULL, logger TEXT, template TEXT NOT NULL,
  exception TEXT, first_at TEXT NOT NULL, last_at TEXT NOT NULL, count INTEGER NOT NULL, first_sample TEXT, last_sample TEXT,
  PRIMARY KEY (service, member, pattern));
CREATE INDEX IF NOT EXISTS service_log_patterns_at ON service_log_patterns (service, last_at);
CREATE TABLE IF NOT EXISTS service_log_counts (
  service TEXT NOT NULL, member TEXT NOT NULL, pattern TEXT NOT NULL, bucket TEXT NOT NULL, count INTEGER NOT NULL,
  PRIMARY KEY (service, member, pattern, bucket));
CREATE INDEX IF NOT EXISTS service_log_counts_at ON service_log_counts (service, bucket);
CREATE TABLE IF NOT EXISTS service_graph_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, by TEXT NOT NULL, reason TEXT NOT NULL, graph TEXT, services TEXT NOT NULL,
  state TEXT NOT NULL, message TEXT NOT NULL, detail TEXT);
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
    // An installation's conf directory when bootstrap.conf's conf.dir moves it (NULL, as before: <install_dir>/conf).
    for (const table of ["service_standalones", "service_nodes"]) {
      if (!(this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).some((c) => c.name === "conf_dir")) this.db.exec(`ALTER TABLE ${table} ADD COLUMN conf_dir TEXT`);
    }
    // Phase 2 step 2: each sample's flat numbers (the Metrics tab, the rollups), next to step 1's raw body.
    if (!(this.db.prepare("PRAGMA table_info(service_samples)").all() as Row[]).some((c) => c.name === "point")) this.db.exec("ALTER TABLE service_samples ADD COLUMN point TEXT");
    // Phase 2 step 6: the nginx address operations put a service behind (Studio's nifi-ops graph) and its last check.
    for (const table of ["service_standalones", "service_clusters"]) {
      const have = (this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((c) => c.name);
      for (const column of ["nginx_url", "nginx_check"]) if (!have.includes(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
    }
    // Phase 3 step 2: the revision an edit started from, its findings and its AI review (revisions before them: NULL).
    {
      const have = (this.db.prepare("PRAGMA table_info(service_configs)").all() as Row[]).map((c) => c.name);
      for (const [column, type] of [["base", "INTEGER"], ["findings", "TEXT"], ["review", "TEXT"]]) if (!have.includes(column)) this.db.exec(`ALTER TABLE service_configs ADD COLUMN ${column} ${type}`);
    }
    // Phase 3 step 4: what each member's files should be, for services taken over before it was kept: their revision 1.
    for (const r of this.db.prepare("SELECT * FROM service_configs c WHERE revision = 1 AND NOT EXISTS (SELECT 1 FROM service_member_files f WHERE f.service = c.service)").all() as Row[]) {
      this.insertMemberFiles(r.service, JSON.parse(r.body), 1, r.saved_at);
    }
    // Phase 2 step 3: services registered before the timeline get their takeover and imported configurations on it.
    this.db.exec(`INSERT INTO service_events (service, member, at, kind, detail)
      SELECT id, NULL, created_at, 'taken-over', json_object('text', 'Taken over' || CASE WHEN draft IS NULL THEN '' ELSE ' from draft ' || draft END, 'by', created_by)
      FROM (SELECT id, created_at, draft, created_by FROM service_standalones UNION ALL SELECT id, created_at, draft, created_by FROM service_clusters) r
      WHERE NOT EXISTS (SELECT 1 FROM service_events e WHERE e.service = r.id AND e.kind = 'taken-over')`);
    this.db.exec(`INSERT INTO service_events (service, member, at, kind, detail)
      SELECT service, NULL, saved_at, 'config-imported', json_object('text', 'Configuration revision ' || revision || ' imported from the hosts', 'by', saved_by, 'revision', revision)
      FROM service_configs c WHERE source = 'import'
      AND NOT EXISTS (SELECT 1 FROM service_events e WHERE e.service = c.service AND e.kind = 'config-imported' AND json_extract(e.detail, '$.revision') = c.revision)`);
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

  /** Claims the oldest job queued for one executor of a host (only: of these job kinds); an env job's content leaves the queue with it. */
  claimExecutorJob(host: string, executor: ExecutorKind = "deploy", only?: string[]): Record<string, unknown> | undefined {
    const r = this.db.prepare(`SELECT id, request, content FROM executor_jobs WHERE host = ? AND COALESCE(executor, 'deploy') = ? AND picked_at IS NULL${only ? " AND json_extract(request, '$.kind') IN (SELECT value FROM json_each(?))" : ""} ORDER BY queued_at, rowid LIMIT 1`)
      .get(host, executor, ...(only ? [JSON.stringify(only)] : [])) as Row | undefined;
    if (!r) return undefined;
    this.takeQueuedExecutorJob(r.id);
    const request = JSON.parse(r.request) as Record<string, unknown>;
    return r.content === null ? request : { ...request, content: r.content };
  }

  /** A job leaves the queue, and its content with it. */
  takeQueuedExecutorJob(id: string) {
    this.db.prepare("UPDATE executor_jobs SET picked_at = ?, content = NULL WHERE id = ?").run(this.stamp(), id);
  }

  /** The jobs still queued whose request says when they expire. */
  queuedExecutorJobsWithExpiry(): { id: string; expiresAt: unknown }[] {
    return (this.db.prepare("SELECT id, json_extract(request, '$.expiresAt') AS expires_at FROM executor_jobs WHERE picked_at IS NULL AND json_extract(request, '$.expiresAt') IS NOT NULL").all() as Row[])
      .map((r) => ({ id: r.id, expiresAt: r.expires_at }));
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
    this.dropOldExecutorContent();
    const r = this.db.prepare("SELECT env_content FROM executor_jobs WHERE id = ?").get(id) as Row | undefined;
    if (r?.env_content == null) return undefined;
    this.db.prepare("UPDATE executor_jobs SET env_content = NULL WHERE id = ?").run(id);
    return r.env_content;
  }

  /** Also once a minute: a read that came after its reader gave up is never taken. */
  dropOldExecutorContent() {
    this.db.prepare("UPDATE executor_jobs SET env_content = NULL WHERE env_content_at < ?").run(new Date(this.now().getTime() - 600_000).toISOString());
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
        this.insertMemberFiles(item.id, configs[item.id]!, 1, at);
        this.insertServiceEvent({ service: item.id, member: null, at, kind: "config-imported", detail: { text: "Configuration revision 1 imported from the hosts", by: actor.id, revision: 1 } });
        this.insertAudit(actor, "service.config-imported", `${item.id}#1`, { files: configs[item.id]!.members.map((m) => ({ installation: `${m.host}:${m.installDir}`, files: m.files.map((f) => `${f.name} ${f.sha256.slice(0, 12)}`) })) });
      }
      this.db.prepare("UPDATE service_drafts SET state = 'confirmed', updated_at = ?, updated_by = ? WHERE id = ?").run(at, actor.id, draft);
      this.insertAudit(actor, "service.draft-confirmed", draft, { items: items.map((i) => i.id) });
      return items.map((i) => i.id);
    });
  }

  /** A service's configuration at a revision (the newest when none is given), sealed copies included. */
  serviceConfig(service: string, revision?: number): { service: string; revision: number; body: ServiceConfigBody; source: string; savedAt: string; savedBy: string; via: string; note: string | null; base: number | null; findings: ConfigFinding[] | null; review: unknown } | undefined {
    const r = (revision === undefined
      ? this.db.prepare("SELECT * FROM service_configs WHERE service = ? ORDER BY revision DESC LIMIT 1").get(service)
      : this.db.prepare("SELECT * FROM service_configs WHERE service = ? AND revision = ?").get(service, revision)) as Row | undefined;
    return r && { service: r.service, revision: r.revision, body: JSON.parse(r.body), source: r.source, savedAt: r.saved_at, savedBy: r.saved_by, via: r.via, note: r.note ?? null, base: r.base ?? null, findings: r.findings ? JSON.parse(r.findings) : null, review: r.review ? JSON.parse(r.review) : null };
  }

  serviceConfigRevisions(service: string): { revision: number; source: string; savedAt: string; savedBy: string; via: string; note: string | null; base: number | null }[] {
    return (this.db.prepare("SELECT revision, source, saved_at, saved_by, via, note, base FROM service_configs WHERE service = ? ORDER BY revision DESC").all(service) as Row[])
      .map((r) => ({ revision: r.revision, source: r.source, savedAt: r.saved_at, savedBy: r.saved_by, via: r.via, note: r.note ?? null, base: r.base ?? null }));
  }

  private insertMemberFiles(service: string, body: ServiceConfigBody, revision: number, at: string) {
    const insert = this.db.prepare("INSERT OR IGNORE INTO service_member_files (service, member, file, path, expected_sha256, revision, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const m of body.members) for (const f of m.files) insert.run(service, installKey(m), f.name, f.path, f.sha256, revision, at);
  }

  /** What each member's files should be now (§16.3): by member, since during a rolling change they are on different revisions. */
  serviceMemberFiles(service: string): ServiceMemberFile[] {
    return (this.db.prepare("SELECT * FROM service_member_files WHERE service = ? ORDER BY member, file").all(service) as Row[])
      .map((r) => ({ member: r.member, file: r.file, path: r.path, expectedSha256: r.expected_sha256, revision: r.revision, appliedAt: r.applied_at, change: r.change ?? null, actualSha256: r.actual_sha256 ?? null, actualAt: r.actual_at ?? null }));
  }

  /** What a sample saw of a member's files (§16.3): fingerprints by name; null, or a file left out, is not known. A sample older than what is recorded changes nothing. */
  setServiceMemberActuals(service: string, member: string, seen: ReadonlyMap<string, string | null> | null, at: string) {
    const rows = this.db.prepare("SELECT file FROM service_member_files WHERE service = ? AND member = ?").all(service, member) as Row[];
    const update = this.db.prepare("UPDATE service_member_files SET actual_sha256 = ?, actual_at = ? WHERE service = ? AND member = ? AND file = ? AND (actual_at IS NULL OR actual_at <= ?)");
    this.inTransaction(() => { for (const r of rows) update.run(seen?.get(r.file) ?? null, at, service, member, r.file, at); });
  }

  /**
   * Keeps one member's file as the host has it (§16.3): what it should be from now on, in a new revision unless the newest
   * already has it. Nothing on the host changes. It must still be the drift that was looked at: expected and the base.
   */
  adoptServiceFile(service: string, a: { member: string; file: string; base: number; expected: string; sha256: string; split: ServiceConfigBody | null; body: ServiceConfigBody | null; findings: ConfigFinding[]; note: string | null }, actor: Actor): number {
    return this.inTransaction(() => {
      const latest = (this.db.prepare("SELECT MAX(revision) AS n FROM service_configs WHERE service = ?").get(service) as Row).n as number | null;
      if (latest !== a.base) throw new StoreError("drift/stale", `The configuration of ${service} is at revision ${latest} now: look at the differences again.`);
      const row = this.db.prepare("SELECT expected_sha256 FROM service_member_files WHERE service = ? AND member = ? AND file = ?").get(service, a.member, a.file) as Row | undefined;
      if (row?.expected_sha256 !== a.expected) throw new StoreError("drift/stale", `${a.file} of ${a.member} should be something else now: look at the differences again.`);
      const at = this.stamp();
      let revision = latest;
      if (a.body) {
        const insert = this.db.prepare("INSERT INTO service_configs (service, revision, body, source, saved_at, saved_by, via, note, base, findings) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
        if (a.split) {
          revision++;
          insert.run(service, revision, JSON.stringify(a.split), "split", at, actor.id, actor.via, "Split into a common layer and node overrides for the first edit", revision - 1, null);
          this.insertServiceEvent({ service, member: null, at, kind: "config-saved", detail: { text: `Configuration revision ${revision} saved: split into layers for the first edit`, by: actor.id, revision } });
          this.insertAudit(actor, "service.config-split", `${service}#${revision}`, { base: revision - 1 });
        }
        revision++;
        insert.run(service, revision, JSON.stringify(a.body), "adopt", at, actor.id, actor.via, a.note, revision - 1, JSON.stringify(a.findings));
        this.insertServiceEvent({ service, member: a.member, at, kind: "config-saved", detail: { text: `Configuration revision ${revision} saved: ${a.file} adopted from the host${a.note ? `: ${a.note}` : ""}`, by: actor.id, revision } });
      }
      this.db.prepare("UPDATE service_member_files SET expected_sha256 = ?, revision = ?, applied_at = ?, change = NULL WHERE service = ? AND member = ? AND file = ?").run(a.sha256, revision, at, service, a.member, a.file);
      this.insertAudit(actor, "service.config-adopted", `${service}#${revision}`, { member: a.member, file: a.file, base: a.base, newRevision: Boolean(a.body) });
      return revision;
    });
  }

  private toConfigDraft(r: Row): ServiceConfigDraft {
    return {
      id: r.id, service: r.service, base: r.base_revision, state: r.state, changes: JSON.parse(r.changes), note: r.note ?? null, findings: r.findings ? JSON.parse(r.findings) : [],
      createdAt: r.created_at, createdBy: r.created_by, via: r.via, updatedAt: r.updated_at, updatedBy: r.updated_by, savedRevision: r.saved_revision ?? null,
    };
  }

  /** A configuration draft, its sealed values included (services/configedit.ts makes what the pages get). */
  serviceConfigDraft(service: string, id: string): ServiceConfigDraft | undefined {
    const r = this.db.prepare("SELECT * FROM service_config_drafts WHERE service = ? AND id = ?").get(service, id) as Row | undefined;
    return r && this.toConfigDraft(r);
  }

  serviceConfigDrafts(service: string, state?: ServiceConfigDraft["state"]): ServiceConfigDraft[] {
    const rows = state
      ? this.db.prepare("SELECT * FROM service_config_drafts WHERE service = ? AND state = ? ORDER BY created_at DESC, id").all(service, state)
      : this.db.prepare("SELECT * FROM service_config_drafts WHERE service = ? ORDER BY created_at DESC, id").all(service);
    return (rows as Row[]).map((r) => this.toConfigDraft(r));
  }

  createServiceConfigDraft(d: { service: string; base: number; changes: DraftChange[]; note: string | null; findings: ConfigFinding[]; audit: unknown }, actor: Actor): ServiceConfigDraft {
    const id = `cfg-${randomBytes(6).toString("hex")}`;
    const at = this.stamp();
    this.inTransaction(() => {
      this.db.prepare("INSERT INTO service_config_drafts (id, service, base_revision, state, changes, note, findings, created_at, created_by, via, updated_at, updated_by) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, d.service, d.base, JSON.stringify(d.changes), d.note, JSON.stringify(d.findings), at, actor.id, actor.via, at, actor.id);
      this.insertAudit(actor, "service.config-draft-created", `${d.service}/${id}`, { base: d.base, changes: d.audit });
    });
    return this.serviceConfigDraft(d.service, id)!;
  }

  private openConfigDraft(service: string, id: string): ServiceConfigDraft {
    const d = this.serviceConfigDraft(service, id);
    if (!d) throw new StoreError("config-draft/unknown", `No configuration draft ${id} of ${service}.`);
    if (d.state !== "open") throw new StoreError("config-draft/closed", `Configuration draft ${id} is ${d.state}.`);
    return d;
  }

  updateServiceConfigDraft(service: string, id: string, d: { base: number; changes: DraftChange[]; note: string | null; findings: ConfigFinding[]; audit: unknown }, actor: Actor): ServiceConfigDraft {
    this.inTransaction(() => {
      this.openConfigDraft(service, id);
      this.db.prepare("UPDATE service_config_drafts SET base_revision = ?, changes = ?, note = ?, findings = ?, updated_at = ?, updated_by = ? WHERE id = ?")
        .run(d.base, JSON.stringify(d.changes), d.note, JSON.stringify(d.findings), this.stamp(), actor.id, id);
      this.insertAudit(actor, "service.config-draft-updated", `${service}/${id}`, { base: d.base, changes: d.audit });
    });
    return this.serviceConfigDraft(service, id)!;
  }

  discardServiceConfigDraft(service: string, id: string, actor: Actor): ServiceConfigDraft {
    this.inTransaction(() => {
      this.openConfigDraft(service, id);
      this.db.prepare("UPDATE service_config_drafts SET state = 'discarded', updated_at = ?, updated_by = ? WHERE id = ?").run(this.stamp(), actor.id, id);
      this.insertAudit(actor, "service.config-draft-discarded", `${service}/${id}`, null);
    });
    return this.serviceConfigDraft(service, id)!;
  }

  /**
   * A draft becomes a revision (nothing on the hosts changes). It must have been made on the newest revision. split: a
   * cluster's first edit keeps its files in layers as a revision of its own first. Answers the draft's revision.
   */
  saveServiceConfigDraft(service: string, id: string, out: { split: ServiceConfigBody | null; body: ServiceConfigBody; findings: ConfigFinding[]; note: string | null; audit: unknown }, actor: Actor): number {
    return this.inTransaction(() => {
      const d = this.openConfigDraft(service, id);
      const latest = (this.db.prepare("SELECT MAX(revision) AS n FROM service_configs WHERE service = ?").get(service) as Row).n as number | null;
      if (latest !== d.base) throw new StoreError("config-draft/stale", `The configuration of ${service} is at revision ${latest}, this draft was made on ${d.base}: move it to the newest revision first.`);
      const at = this.stamp();
      const insert = this.db.prepare("INSERT INTO service_configs (service, revision, body, source, saved_at, saved_by, via, note, base, findings) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      let revision = latest;
      if (out.split) {
        revision++;
        insert.run(service, revision, JSON.stringify(out.split), "split", at, actor.id, actor.via, "Split into a common layer and node overrides for the first edit", revision - 1, null);
        this.insertServiceEvent({ service, member: null, at, kind: "config-saved", detail: { text: `Configuration revision ${revision} saved: split into layers for the first edit`, by: actor.id, revision } });
        this.insertAudit(actor, "service.config-split", `${service}#${revision}`, { base: revision - 1, draft: id });
      }
      revision++;
      insert.run(service, revision, JSON.stringify(out.body), "edit", at, actor.id, actor.via, out.note, revision - 1, JSON.stringify(out.findings));
      this.insertServiceEvent({ service, member: null, at, kind: "config-saved", detail: { text: `Configuration revision ${revision} saved${out.note ? `: ${out.note}` : ""}`, by: actor.id, revision, draft: id } });
      this.insertAudit(actor, "service.config-saved", `${service}#${revision}`, { base: revision - 1, draft: id, draftedVia: d.via, changes: out.audit });
      this.db.prepare("UPDATE service_config_drafts SET state = 'saved', saved_revision = ?, findings = ?, note = ?, updated_at = ?, updated_by = ? WHERE id = ?").run(revision, JSON.stringify(out.findings), out.note, at, actor.id, id);
      return revision;
    });
  }

  /** The AI review of a revision (§16.3): written when it starts and when its session ends, not an edit of the revision. */
  setServiceConfigReview(service: string, revision: number, review: ConfigReview) {
    this.db.prepare("UPDATE service_configs SET review = ? WHERE service = ? AND revision = ?").run(JSON.stringify(review), service, revision);
  }

  runningConfigReviews(): { service: string; revision: number; review: ConfigReview }[] {
    return (this.db.prepare("SELECT service, revision, review FROM service_configs WHERE review LIKE '%\"state\":\"running\"%'").all() as Row[]).map((r) => ({ service: r.service, revision: r.revision, review: JSON.parse(r.review) }));
  }

  /** Closes an open draft without registering anything; its items stay for the record. */
  discardServiceDraft(draft: string, actor: Actor) {
    this.inTransaction(() => {
      this.openDraft(draft);
      this.db.prepare("UPDATE service_drafts SET state = 'discarded', updated_at = ?, updated_by = ? WHERE id = ?").run(this.stamp(), actor.id, draft);
      this.insertAudit(actor, "service.draft-discarded", draft, null);
    });
  }

  /**
   * The registered standalone instance or cluster node using an installation (host, installation, conf directory:
   * one unpacked NiFi may run several instances, each with its own conf directory), if any.
   */
  serviceUsing(host: string, installDir: string, confDir?: string | null): string | undefined {
    const dir = installDir.replace(/\/+$/, "");
    const conf = confDirOf({ installDir: dir, confDir });
    const same = "host = ? AND install_dir = ? AND COALESCE(conf_dir, install_dir || '/conf') = ?";
    const s = this.db.prepare(`SELECT id FROM service_standalones WHERE ${same} AND removed_at IS NULL`).get(host, dir, conf) as Row | undefined;
    if (s) return s.id;
    const n = this.db.prepare(`SELECT n.cluster FROM service_nodes n JOIN service_clusters c ON c.id = n.cluster WHERE ${same.replace(/(host|install_dir|conf_dir)\b/g, "n.$1")} AND n.removed_at IS NULL AND c.removed_at IS NULL`).get(host, dir, conf) as Row | undefined;
    return n?.cluster;
  }

  private checkRegistration(item: DraftItem, members: ServiceMember[]) {
    this.checkItem(item, []);
    if (this.db.prepare("SELECT 1 FROM service_standalones WHERE id = ?1 UNION SELECT 1 FROM service_clusters WHERE id = ?1").get(item.id))
      throw new StoreError("service/exists", `A service ${item.id} is already registered.`);
    const used = members.map((m) => [m, this.serviceUsing(m.host, m.installDir, m.confDir)] as const).filter(([, s]) => s);
    if (used.length) throw new StoreError("service/install-used", "An installation is already registered.", used.map(([m, s]) => `${installKey(m)} is in ${s}`));
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
    this.db.prepare(`INSERT INTO service_standalones (id, service, profile, version, environment, host, install_dir, conf_dir, service_user, start_env, ports, web_url, draft, discovery, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(s.id, s.service, s.profile, s.version, environment, m.host, m.installDir.replace(/\/+$/, ""), confDirOf(m), m.serviceUser,
      m.startEnvironment && JSON.stringify(m.startEnvironment), JSON.stringify(m.ports), s.webUrl, draft, m.discovery ? JSON.stringify(m.discovery) : null, this.stamp(), actor.id);
    this.insertAudit(actor, "service.standalone-added", s.id, { host: m.host, installDir: m.installDir, confDir: confDirOf(m), version: s.version, draft });
    this.insertServiceEvent({ service: s.id, member: null, at: this.stamp(), kind: "taken-over", detail: { text: `Taken over${draft ? ` from draft ${draft}` : ""}`, by: actor.id } });
  }

  private insertCluster(c: DraftCluster, environment: string, actor: Actor, draft: string | null) {
    this.checkRegistration(c, c.nodes);
    const at = this.stamp();
    this.db.prepare(`INSERT INTO service_clusters (id, service, profile, version, environment, zookeeper, zookeeper_root, web_url, draft, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(c.id, c.service, c.profile, c.version, environment, c.zookeeper, c.zookeeperRoot, c.webUrl, draft, at, actor.id);
    for (const n of c.nodes) {
      this.db.prepare(`INSERT INTO service_nodes (cluster, host, install_dir, conf_dir, service_user, start_env, control, ports, node_address, discovery, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(c.id, n.host, n.installDir.replace(/\/+$/, ""), confDirOf(n), n.serviceUser, n.startEnvironment && JSON.stringify(n.startEnvironment), "nifi.sh", JSON.stringify(n.ports), n.nodeAddress ?? null, n.discovery ? JSON.stringify(n.discovery) : null, at);
    }
    this.insertAudit(actor, "service.cluster-added", c.id, { nodes: c.nodes.map(installKey), version: c.version, draft });
    this.insertServiceEvent({ service: c.id, member: null, at, kind: "taken-over", detail: { text: `Taken over${draft ? ` from draft ${draft}` : ""}`, by: actor.id } });
  }

  private toMember(r: Row): ServiceMember & { control?: string } {
    return { host: r.host, installDir: r.install_dir, confDir: r.conf_dir ?? confDirOf({ installDir: r.install_dir }), serviceUser: r.service_user ?? null, startEnvironment: parse(r.start_env), ports: JSON.parse(r.ports), ...(r.node_address !== undefined ? { nodeAddress: r.node_address ?? null } : {}), discovery: parse(r.discovery), ...(r.control ? { control: r.control } : {}) };
  }

  standalones(): (DraftStandalone & Registered)[] {
    return (this.db.prepare("SELECT * FROM service_standalones WHERE removed_at IS NULL ORDER BY id").all() as Row[]).map((r) => ({
      kind: "standalone", id: r.id, service: r.service, profile: r.profile, version: r.version, webUrl: r.web_url ?? null, member: this.toMember(r),
      nginxUrl: r.nginx_url ?? null, nginxCheck: parse(r.nginx_check ?? null),
      environment: r.environment, draft: r.draft ?? null, createdAt: r.created_at, createdBy: r.created_by,
    }));
  }

  clusters(): (DraftCluster & Registered)[] {
    return (this.db.prepare("SELECT * FROM service_clusters WHERE removed_at IS NULL ORDER BY id").all() as Row[]).map((r) => ({
      kind: "cluster", id: r.id, service: r.service, profile: r.profile, version: r.version, webUrl: r.web_url ?? null, zookeeper: r.zookeeper ?? null, zookeeperRoot: r.zookeeper_root ?? null,
      nginxUrl: r.nginx_url ?? null, nginxCheck: parse(r.nginx_check ?? null),
      nodes: (this.db.prepare("SELECT * FROM service_nodes WHERE cluster = ? AND removed_at IS NULL ORDER BY host, install_dir").all(r.id) as Row[]).map((n) => this.toMember(n)),
      environment: r.environment, draft: r.draft ?? null, createdAt: r.created_at, createdBy: r.created_by,
    }));
  }

  // §15.3: the collector's samples as the service executors send them. Step 2 keeps each with its flat numbers
  // (point: the Metrics tab and the rollups); bulletins and certificates go to their own tables (services/metrics.ts).
  addServiceSamples(samples: { service: string; member: string; at: string; point?: Point | null }[]) {
    if (!samples.length) return;
    const at = this.stamp();
    const insert = this.db.prepare("INSERT INTO service_samples (service, member, at, body, received_at, point) VALUES (?, ?, ?, ?, ?, ?)");
    this.inTransaction(() => { for (const { point, ...s } of samples) insert.run(s.service, s.member, s.at, JSON.stringify(s), at, point ? JSON.stringify(point) : null); });
  }

  /** The newest sample of each member of a service. */
  latestServiceSamples(service: string): { member: string; at: string; receivedAt: string; body: Record<string, unknown>; point: Point | null }[] {
    return (this.db.prepare(`SELECT member, at, body, received_at, point FROM service_samples s WHERE service = ?1
      AND rowid = (SELECT rowid FROM service_samples WHERE service = ?1 AND member = s.member ORDER BY at DESC, rowid DESC LIMIT 1) ORDER BY member`).all(service) as Row[])
      .map((r) => ({ member: r.member, at: r.at, receivedAt: r.received_at, body: JSON.parse(r.body), point: parse(r.point ?? null) }));
  }

  /** A member's newest sample before a time (the previous one, for the rates). */
  serviceSampleBefore(service: string, member: string, before: string): { at: string; body: Record<string, unknown>; point: Point | null } | undefined {
    const r = this.db.prepare("SELECT at, body, point FROM service_samples WHERE service = ? AND member = ? AND at < ? ORDER BY at DESC, rowid DESC LIMIT 1").get(service, member, before) as Row | undefined;
    return r ? { at: r.at, body: JSON.parse(r.body), point: parse(r.point ?? null) } : undefined;
  }

  /** The flat numbers of a service's samples in [from, to), oldest first. */
  servicePoints(service: string, from: string, to: string): { member: string; at: string; point: Point }[] {
    return (this.db.prepare("SELECT member, at, point FROM service_samples WHERE service = ? AND at >= ? AND at < ? AND point IS NOT NULL ORDER BY at").all(service, from, to) as Row[])
      .map((r) => ({ member: r.member, at: r.at, point: JSON.parse(r.point) }));
  }

  /** Owner 2026-11-07: the newest back pressure summary of a service's samples at or after a time (the executor reads
   *  it every few minutes, so most samples carry none). */
  latestServiceBackpressure(service: string, since: string): { member: string; at: string; backpressure: Record<string, unknown> } | undefined {
    const r = this.db.prepare(`SELECT member, at, json_extract(body, '$.nifi.backpressure') AS bp FROM service_samples
      WHERE service = ? AND at >= ? AND json_extract(body, '$.nifi.backpressure') IS NOT NULL ORDER BY at DESC, rowid DESC LIMIT 1`).get(service, since) as Row | undefined;
    return r ? { member: r.member, at: r.at, backpressure: JSON.parse(r.bp) } : undefined;
  }

  /** The members with samples at or after a time, with their oldest such sample. */
  sampledMembers(since: string): { service: string; member: string; first: string }[] {
    return (this.db.prepare("SELECT service, member, MIN(at) AS first FROM service_samples WHERE at >= ? AND point IS NOT NULL GROUP BY service, member").all(since) as Row[])
      .map((r) => ({ service: r.service, member: r.member, first: r.first }));
  }

  /** The newest 5-minute bucket rolled up for a member. */
  lastServiceRollup(service: string, member: string): string | undefined {
    return ((this.db.prepare("SELECT MAX(bucket) AS b FROM service_rollups WHERE service = ? AND member = ?").get(service, member) as Row | undefined)?.b as string | null) ?? undefined;
  }

  memberPoints(service: string, member: string, from: string, to: string): { at: string; point: Point }[] {
    return (this.db.prepare("SELECT at, point FROM service_samples WHERE service = ? AND member = ? AND at >= ? AND at < ? AND point IS NOT NULL ORDER BY at").all(service, member, from, to) as Row[])
      .map((r) => ({ at: r.at, point: JSON.parse(r.point) }));
  }

  putServiceRollups(rows: { service: string; member: string; bucket: string; body: unknown }[]) {
    if (!rows.length) return;
    const put = this.db.prepare("INSERT OR REPLACE INTO service_rollups (service, member, bucket, body) VALUES (?, ?, ?, ?)");
    this.inTransaction(() => { for (const r of rows) put.run(r.service, r.member, r.bucket, JSON.stringify(r.body)); });
  }

  serviceRollups(service: string, from: string, to: string): { member: string; bucket: string; body: any }[] {
    return (this.db.prepare("SELECT member, bucket, body FROM service_rollups WHERE service = ? AND bucket >= ? AND bucket < ? ORDER BY bucket").all(service, from, to) as Row[])
      .map((r) => ({ member: r.member, bucket: r.bucket, body: JSON.parse(r.body) }));
  }

  /** Bulletins, each once (by node, id and time: after a restart the ids start from 0 again, at other times). */
  addServiceBulletins(rows: ServiceBulletin[]): number {
    if (!rows.length) return 0;
    const received = this.stamp();
    const insert = this.db.prepare(`INSERT OR IGNORE INTO service_bulletins (service, member, node, bulletin_id, at, level, category, source, source_type, message, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let added = 0;
    this.inTransaction(() => { for (const b of rows) added += Number(insert.run(b.service, b.member, b.node, b.id, b.at, b.level, b.category, b.source, b.sourceType, b.message, received).changes); });
    return added;
  }

  serviceBulletins(service: string, options: { from?: string; to?: string; level?: string; limit?: number } = {}): ServiceBulletin[] {
    const where = ["service = ?"], args: (string | number)[] = [service];
    if (options.from) { where.push("at >= ?"); args.push(options.from); }
    if (options.to) { where.push("at < ?"); args.push(options.to); }
    if (options.level) { where.push("level = ?"); args.push(options.level); }
    args.push(Math.min(1000, Math.max(1, options.limit ?? 200)));
    return (this.db.prepare(`SELECT * FROM service_bulletins WHERE ${where.join(" AND ")} ORDER BY at DESC, bulletin_id DESC LIMIT ?`).all(...args) as Row[])
      .map((r) => ({ service: r.service, member: r.member, node: r.node, id: r.bulletin_id, at: r.at, level: r.level ?? null, category: r.category ?? null, source: r.source ?? null, sourceType: r.source_type ?? null, message: r.message ?? null }));
  }

  /** S27: a member's certificates as of one reading, kept only when newer (by readAt) than what is there; only the newest reading stays. */
  putServiceCerts(service: string, member: string, readAt: string, rows: Omit<ServiceCert, "member" | "readAt">[]): boolean {
    const had = (this.db.prepare("SELECT MAX(read_at) AS r FROM service_certs WHERE service = ? AND member = ?").get(service, member) as Row | undefined)?.r as string | null | undefined;
    if (had && had >= readAt) return false;
    const insert = this.db.prepare("INSERT INTO service_certs (service, member, store, path, type, alias, chain, subject, issuer, not_before, not_after, read_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    this.inTransaction(() => {
      this.db.prepare("DELETE FROM service_certs WHERE service = ? AND member = ?").run(service, member);
      for (const c of rows) insert.run(service, member, c.store, c.path, c.type, c.alias, c.chain, c.subject, c.issuer, c.notBefore, c.notAfter, readAt, c.error);
    });
    return true;
  }

  serviceCerts(service: string): ServiceCert[] {
    return (this.db.prepare("SELECT * FROM service_certs WHERE service = ? ORDER BY member, store, alias, chain").all(service) as Row[]).map((r) => ({
      member: r.member, store: r.store, path: r.path ?? null, type: r.type ?? null, alias: r.alias ?? null, chain: r.chain ?? null, subject: r.subject ?? null, issuer: r.issuer ?? null,
      notBefore: r.not_before ?? null, notAfter: r.not_after ?? null, readAt: r.read_at, error: r.error ?? null,
    }));
  }

  /** §15.3 retention: raw samples and bulletins before one time, rollups before another. */
  pruneServiceData(samplesBefore: string, rollupsBefore: string): { samples: number; bulletins: number; rollups: number; logCounts: number; logPatterns: number } {
    const out = { samples: 0, bulletins: 0, rollups: 0, logCounts: 0, logPatterns: 0 };
    this.inTransaction(() => {
      out.samples = Number(this.db.prepare("DELETE FROM service_samples WHERE at < ?").run(samplesBefore).changes);
      out.bulletins = Number(this.db.prepare("DELETE FROM service_bulletins WHERE at < ?").run(samplesBefore).changes);
      out.rollups = Number(this.db.prepare("DELETE FROM service_rollups WHERE bucket < ?").run(rollupsBefore).changes);
      // Phase 2 step 4: the log summary's 5-minute counts as long as the raw samples, its patterns as long as the rollups.
      out.logCounts = Number(this.db.prepare("DELETE FROM service_log_counts WHERE bucket < ?").run(samplesBefore).changes);
      out.logPatterns = Number(this.db.prepare("DELETE FROM service_log_patterns WHERE last_at < ?").run(rollupsBefore).changes);
    });
    return out;
  }

  // Phase 2 step 4 (§15.3): the WARN/ERROR summary of each member's nifi-app.log, by pattern (level, logger, message
  // template, exception), with the first and the newest sample (cut and with secrets hidden by the executor), and
  // the counts per 5-minute bucket for the rules.

  /** Adds one sample's patterns: counts summed, the first sample kept, the newest replaced. */
  addLogPatterns(service: string, member: string, rows: LogPatternIn[]) {
    if (!rows.length) return;
    const upsert = this.db.prepare(`INSERT INTO service_log_patterns (service, member, pattern, level, logger, template, exception, first_at, last_at, count, first_sample, last_sample)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
      ON CONFLICT (service, member, pattern) DO UPDATE SET count = count + ?10, last_at = MAX(last_at, ?9), last_sample = CASE WHEN ?9 >= last_at THEN ?12 ELSE last_sample END,
        first_at = MIN(first_at, ?8)`);
    const count = this.db.prepare(`INSERT INTO service_log_counts (service, member, pattern, bucket, count) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (service, member, pattern, bucket) DO UPDATE SET count = count + excluded.count`);
    this.inTransaction(() => {
      for (const r of rows) {
        upsert.run(service, member, r.pattern, r.level, r.logger, r.template, r.exception, r.firstAt, r.lastAt, r.count, r.first, r.last);
        count.run(service, member, r.pattern, r.bucket, r.count);
      }
    });
  }

  /** A service's patterns seen since a time, the most frequent in that period first (count: since then, total: ever). */
  serviceLogPatterns(service: string, options: { since?: string; member?: string; limit?: number } = {}): LogPattern[] {
    const since = options.since ?? "";
    return (this.db.prepare(`SELECT p.*, COALESCE((SELECT SUM(c.count) FROM service_log_counts c WHERE c.service = p.service AND c.member = p.member AND c.pattern = p.pattern AND c.bucket >= ?2), 0) AS recent
      FROM service_log_patterns p WHERE p.service = ?1 AND p.last_at >= ?2 AND (?3 IS NULL OR p.member = ?3) ORDER BY recent DESC, p.last_at DESC LIMIT ?4`)
      .all(service, since, options.member ?? null, Math.min(1000, Math.max(1, options.limit ?? 200))) as Row[]).map((r) => ({
      member: r.member, pattern: r.pattern, level: r.level, logger: r.logger ?? null, template: r.template, exception: r.exception ?? null,
      firstAt: r.first_at, lastAt: r.last_at, total: r.count, count: Number(r.recent), firstSample: r.first_sample ?? null, lastSample: r.last_sample ?? null,
    }));
  }

  /** The 5-minute counts of a service's patterns from a bucket on, with what each pattern is (for the rules). */
  serviceLogCounts(service: string, fromBucket: string): { member: string; pattern: string; bucket: string; count: number; level: string; logger: string | null; template: string; exception: string | null }[] {
    return (this.db.prepare(`SELECT c.member, c.pattern, c.bucket, c.count, p.level, p.logger, p.template, p.exception FROM service_log_counts c
      JOIN service_log_patterns p ON p.service = c.service AND p.member = c.member AND p.pattern = c.pattern WHERE c.service = ? AND c.bucket >= ? ORDER BY c.bucket`)
      .all(service, fromBucket) as Row[]).map((r) => ({ member: r.member, pattern: r.pattern, bucket: r.bucket, count: Number(r.count), level: r.level, logger: r.logger ?? null, template: r.template, exception: r.exception ?? null }));
  }

  // Phase 2 step 3 (§15.3): alerts (one open per service, member and rule; resolved when the rule no longer holds), the
  // event timeline, the facts the timeline compares with (start time, version, connection), the threshold overrides.
  // A service-wide alert has the member "*"; its events have no member.

  /** Alerts newest first (open ones before resolved ones): of one service or all, open, resolved or both. */
  serviceAlerts(options: { service?: string; state?: "open" | "resolved"; since?: string; limit?: number } = {}): ServiceAlert[] {
    const where = ["1 = 1"], args: (string | number)[] = [];
    if (options.service) { where.push("service = ?"); args.push(options.service); }
    if (options.state) { where.push("state = ?"); args.push(options.state); }
    if (options.since) { where.push("(state = 'open' OR resolved_at >= ?)"); args.push(options.since); }
    args.push(Math.min(1000, Math.max(1, options.limit ?? 200)));
    return (this.db.prepare(`SELECT * FROM service_alerts WHERE ${where.join(" AND ")} ORDER BY state = 'open' DESC, COALESCE(resolved_at, opened_at) DESC, id DESC LIMIT ?`).all(...args) as Row[]).map(toAlert);
  }

  /** Opens an alert with its timeline event; none when one is open already for the same service, member and rule. */
  openServiceAlert(a: { service: string; member: string; rule: string; level: AlertLevel; detail: Record<string, unknown> }, at: string, event: Record<string, unknown>, kind = "alert-opened"): number | undefined {
    return this.inTransaction(() => {
      const r = this.db.prepare("INSERT OR IGNORE INTO service_alerts (service, member, rule, level, state, opened_at, detail, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?)")
        .run(a.service, a.member, a.rule, a.level, at, JSON.stringify(a.detail), at);
      if (!Number(r.changes)) return undefined;
      const id = Number(r.lastInsertRowid);
      this.insertServiceEvent({ service: a.service, member: a.member === "*" ? null : a.member, at, kind, detail: { ...event, alert: id, rule: a.rule, level: a.level } });
      return id;
    });
  }

  /** An open alert's new level and detail; a new level also goes on the timeline. */
  updateServiceAlert(id: number, level: AlertLevel, detail: Record<string, unknown>, at: string, event: Record<string, unknown>) {
    this.inTransaction(() => {
      const was = this.db.prepare("SELECT * FROM service_alerts WHERE id = ? AND state = 'open'").get(id) as Row | undefined;
      if (!was) return;
      this.db.prepare("UPDATE service_alerts SET level = ?, detail = ?, updated_at = ? WHERE id = ?").run(level, JSON.stringify(detail), at, id);
      if (was.level !== level) this.insertServiceEvent({ service: was.service, member: was.member === "*" ? null : was.member, at, kind: "alert-changed", detail: { ...event, alert: id, rule: was.rule, level, was: was.level } });
    });
  }

  resolveServiceAlert(id: number, at: string, event: Record<string, unknown>, kind = "alert-resolved") {
    this.inTransaction(() => {
      const was = this.db.prepare("SELECT * FROM service_alerts WHERE id = ? AND state = 'open'").get(id) as Row | undefined;
      if (!was) return;
      this.db.prepare("UPDATE service_alerts SET state = 'resolved', resolved_at = ?, updated_at = ? WHERE id = ?").run(at, at, id);
      this.insertServiceEvent({ service: was.service, member: was.member === "*" ? null : was.member, at, kind, detail: { ...event, alert: id, rule: was.rule, level: was.level } });
    });
  }

  addServiceEvent(e: Omit<ServiceEvent, "id">) { this.insertServiceEvent(e); }

  private insertServiceEvent(e: Omit<ServiceEvent, "id">) {
    this.db.prepare("INSERT INTO service_events (service, member, at, kind, detail) VALUES (?, ?, ?, ?, ?)").run(e.service, e.member, e.at, e.kind, JSON.stringify(e.detail ?? {}));
  }

  /** A service's timeline, newest first. */
  serviceEvents(service: string, options: { from?: string; to?: string; kind?: string; limit?: number } = {}): ServiceEvent[] {
    const where = ["service = ?"], args: (string | number)[] = [service];
    if (options.from) { where.push("at >= ?"); args.push(options.from); }
    if (options.to) { where.push("at < ?"); args.push(options.to); }
    if (options.kind) { where.push("kind = ?"); args.push(options.kind); }
    args.push(Math.min(1000, Math.max(1, options.limit ?? 200)));
    return (this.db.prepare(`SELECT * FROM service_events WHERE ${where.join(" AND ")} ORDER BY at DESC, id DESC LIMIT ?`).all(...args) as Row[])
      .map((r) => ({ id: r.id, service: r.service, member: r.member ?? null, at: r.at, kind: r.kind, detail: parse(r.detail) ?? {} }));
  }

  /** What the rules saw last of each member (start time, version, connection), by "member\0key": to tell what changed. */
  serviceFacts(service: string): Map<string, string | null> {
    return new Map((this.db.prepare("SELECT member, key, value FROM service_facts WHERE service = ?").all(service) as Row[]).map((r) => [`${r.member}\0${r.key}`, r.value ?? null]));
  }

  setServiceFact(service: string, member: string, key: string, value: string | null) {
    this.db.prepare("INSERT OR REPLACE INTO service_facts (service, member, key, value, at) VALUES (?, ?, ?, ?, ?)").run(service, member, key, value, this.stamp());
  }

  /** Sets (or with null clears) the nginx address of a standalone instance or cluster: audited, on the timeline. */
  setServiceNginxUrl(service: string, url: string | null, actor: Actor) {
    this.inTransaction(() => {
      const was = (this.db.prepare("SELECT nginx_url FROM service_standalones WHERE id = ?1 AND removed_at IS NULL UNION ALL SELECT nginx_url FROM service_clusters WHERE id = ?1 AND removed_at IS NULL").get(service) as Row | undefined);
      if (!was) throw new StoreError("service/unknown", `No standalone instance or cluster ${service}.`);
      for (const table of ["service_standalones", "service_clusters"]) this.db.prepare(`UPDATE ${table} SET nginx_url = ?, nginx_check = NULL WHERE id = ? AND removed_at IS NULL`).run(url, service);
      this.insertAudit(actor, "service.nginx-url", service, { from: was.nginx_url ?? null, to: url });
      this.insertServiceEvent({ service, member: null, at: this.stamp(), kind: "nginx-url", detail: { text: url ? `nginx address set to ${url}` : "nginx address removed", by: actor.id } });
    });
  }

  /** The last check of a service's nginx address (GET /flow/about through it). */
  setServiceNginxCheck(service: string, check: NginxCheck) {
    for (const table of ["service_standalones", "service_clusters"]) this.db.prepare(`UPDATE ${table} SET nginx_check = ? WHERE id = ? AND removed_at IS NULL`).run(JSON.stringify(check), service);
  }

  /** Records one generation and publication of the nifi-ops graph (services/graph.ts). */
  addGraphRun(run: Omit<GraphRun, "id">): number {
    return Number(this.db.prepare("INSERT INTO service_graph_runs (at, by, reason, graph, services, state, message, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(run.at, run.by, run.reason, run.graph, JSON.stringify(run.services), run.state, run.message, JSON.stringify(run.detail)).lastInsertRowid);
  }

  graphRuns(limit = 20): GraphRun[] {
    return (this.db.prepare("SELECT * FROM service_graph_runs ORDER BY id DESC LIMIT ?").all(limit) as Row[])
      .map((r) => ({ id: r.id, at: r.at, by: r.by, reason: r.reason, graph: r.graph ?? null, services: JSON.parse(r.services), state: r.state, message: r.message, detail: parse(r.detail) ?? {} }));
  }

  /** A service's threshold overrides (the profile's defaults apply to the rest). */
  serviceThresholds(service: string): Record<string, number> {
    const r = this.db.prepare("SELECT thresholds FROM service_standalones WHERE id = ?1 AND removed_at IS NULL UNION ALL SELECT thresholds FROM service_clusters WHERE id = ?1 AND removed_at IS NULL").get(service) as Row | undefined;
    return parse(r?.thresholds ?? null) ?? {};
  }

  /** Replaces a service's threshold overrides (none: the defaults), audited and on the timeline. */
  setServiceThresholds(service: string, overrides: Record<string, number>, actor: Actor) {
    this.inTransaction(() => {
      const was = this.serviceThresholds(service);
      const value = Object.keys(overrides).length ? JSON.stringify(overrides) : null;
      const changed = Number(this.db.prepare("UPDATE service_standalones SET thresholds = ? WHERE id = ? AND removed_at IS NULL").run(value, service).changes)
        + Number(this.db.prepare("UPDATE service_clusters SET thresholds = ? WHERE id = ? AND removed_at IS NULL").run(value, service).changes);
      if (!changed) throw new StoreError("service/unknown", `No standalone instance or cluster ${service}.`);
      this.insertAudit(actor, "service.thresholds", service, { from: was, to: overrides });
      const text = Object.keys(overrides).length ? `Alert thresholds set: ${Object.entries(overrides).map(([k, v]) => `${k} ${v}`).join(", ")}` : "Alert thresholds back to the profile's defaults";
      this.insertServiceEvent({ service, member: null, at: this.stamp(), kind: "thresholds", detail: { text, by: actor.id } });
    });
  }
}

/** What a registered standalone instance or cluster carries besides its draft shape. */
export interface Registered { environment: string; draft: string | null; createdAt: string; createdBy: string; nginxUrl: string | null; nginxCheck: NginxCheck | null }
/** GET /flow/about through a service's nginx address, as the Deployer last tried it. */
export interface NginxCheck { url: string; at: string; ok: boolean; status: number | null; version: string | null; ms: number | null; error: string | null }
export interface GraphRun { id: number; at: string; by: string; reason: string; graph: string | null; services: string[]; state: "published" | "failed" | "skipped"; message: string; detail: Record<string, unknown> }

export type AlertLevel = "WARN" | "CRIT";
export interface ServiceAlert { id: number; service: string; member: string; rule: string; level: AlertLevel; state: "open" | "resolved"; openedAt: string; resolvedAt: string | null; updatedAt: string; detail: Record<string, unknown> }
export interface ServiceEvent { id: number; service: string; member: string | null; at: string; kind: string; detail: Record<string, unknown> }
const toAlert = (r: Row): ServiceAlert => ({ id: r.id, service: r.service, member: r.member, rule: r.rule, level: r.level, state: r.state, openedAt: r.opened_at, resolvedAt: r.resolved_at ?? null, updatedAt: r.updated_at, detail: parse(r.detail) ?? {} });

/** One pattern of a sample's log summary as it is stored (services/logs.ts). */
export interface LogPatternIn { pattern: string; level: string; logger: string | null; template: string; exception: string | null; firstAt: string; lastAt: string; count: number; first: string | null; last: string | null; bucket: string }
export interface LogPattern { member: string; pattern: string; level: string; logger: string | null; template: string; exception: string | null; firstAt: string; lastAt: string; total: number; count: number; firstSample: string | null; lastSample: string | null }

/** A sample's flat numbers (services/metrics.ts). */
export type Point = Record<string, number | null>;
export interface ServiceBulletin { service: string; member: string; node: string; id: number; at: string; level: string | null; category: string | null; source: string | null; sourceType: string | null; message: string | null }
export interface ServiceCert { member: string; store: string; path: string | null; type: string | null; alias: string | null; chain: number | null; subject: string | null; issuer: string | null; notBefore: string | null; notAfter: string | null; readAt: string; error: string | null }
