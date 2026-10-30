// The Deployer's state (design §12: one SQLite file). Phase 1 keeps the app registry with each
// app's deploy manifests and their history (§4.3, §4.4, D27), the audit log, and emergency sessions.
// Rows are never rewritten: saving a manifest adds a revision, removing an app marks it removed.

import { DatabaseSync } from "node:sqlite";
import type { Rollout } from "./rollout.ts";
import type { Manifest } from "../compose/generate.ts";
import { crossAppConflicts, validateManifest } from "../manifest/validate.ts";
import { compareVersions } from "../manifest/version.ts";

export interface Actor { id: string; via: "workbench" | "emergency" | "cli" }

export interface ManifestRevision { appliesFrom: string; revision: number; savedAt: string; savedBy: string; note: string | null }
export interface RegisteredApp { id: string; name: string; repo: string; addedAt: string; addedBy: string; manifests: ManifestRevision[] }
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
CREATE TABLE IF NOT EXISTS component_state (
  app TEXT NOT NULL, component TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (app, component, key));
`;

/** queued: written to the handoff directory; the rest are the executor's states. */
export type JobState = "queued" | "running" | "succeeded" | "failed" | "rolled-back" | "refused";
export const FINAL_STATES: JobState[] = ["succeeded", "failed", "rolled-back", "refused"];

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

export type JobKind = "build" | "deploy" | "env" | "env-read";

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
export interface DeployRecord { id: string; version: string; digests: Record<string, string>; deployedAt: string; replacedAt: string | null; envRevision: number | null }

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
  /** The deploy whose digests this one restores ("回到这一版"). */
  pinFrom: string | null;
  request: Record<string, unknown>;
  status: ExecutorStatus | null;
  /** What the app reported after a deploy (§8.5 observation). */
  observation: unknown;
  message: string | null;
  /** A deploy's steps in dependsOn order (phase 5): the executor's part, then the Deployer's and people's. */
  rollout: Rollout | null;
}

type Row = Record<string, any>;

const toEnvRevision = (r: Row): EnvRevision => ({
  app: r.app, revision: r.revision, source: r.source, changes: JSON.parse(r.changes), savedAt: r.saved_at, savedBy: r.saved_by,
  via: r.via, note: r.note ?? null, appliedAt: r.applied_at ?? null, appliedJob: r.applied_job ?? null,
});

const parse = (s: string | null) => (s ? JSON.parse(s) : null);
const toJob = (r: Row): Job => ({
  id: r.id, kind: r.kind, app: r.app, version: r.version, environment: r.environment, state: r.state,
  requestedBy: r.requested_by, via: r.via, requestedAt: r.requested_at, finishedAt: r.finished_at ?? null,
  fromVersion: r.from_version ?? null, manifest: r.manifest ?? null, pinFrom: r.pin_from ?? null,
  request: JSON.parse(r.request), status: parse(r.status), observation: parse(r.observation), message: r.message ?? null,
  rollout: parse(r.rollout ?? null),
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
    if (!(this.db.prepare("PRAGMA table_info(jobs)").all() as Row[]).some((c) => c.name === "rollout")) this.db.exec("ALTER TABLE jobs ADD COLUMN rollout TEXT");
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
    return { id: a.id, name: a.name, repo: a.repo, addedAt: a.added_at, addedBy: a.added_by, manifests };
  }

  /** The current revision of each of an app's manifests, oldest appliesFrom first. */
  manifests(app: string): Manifest[] {
    const rows = this.db.prepare(`
      SELECT m.body FROM manifests m
      WHERE m.app = ? AND m.revision = (SELECT MAX(revision) FROM manifests x WHERE x.app = m.app AND x.applies_from = m.applies_from)`).all(app) as Row[];
    return rows.map((r) => JSON.parse(r.body) as Manifest).sort((a, b) => compareVersions(a.appliesFrom, b.appliesFrom));
  }

  manifestRevision(app: string, appliesFrom: string, revision: number): Manifest | undefined {
    const r = this.db.prepare("SELECT body FROM manifests WHERE app = ? AND applies_from = ? AND revision = ?").get(app, appliesFrom, revision) as Row | undefined;
    return r && JSON.parse(r.body);
  }

  /**
   * Validates and saves a manifest as a new revision. The first manifest registers the app (§4.4);
   * later ones must keep its release repo, which is what the registry whitelists.
   */
  saveManifest(value: unknown, actor: Actor, options: { name?: string; note?: string } = {}): { app: string; appliesFrom: string; revision: number } {
    const errors = validateManifest(value);
    if (errors.length) throw new StoreError("manifest/invalid", "The manifest is not a valid deploy manifest v1.", errors);
    const manifest = value as Manifest;
    const existing = this.app(manifest.app);
    if (existing && existing.repo !== manifest.release!.repo) {
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

  listAudit(limit = 100): AuditEntry[] {
    const rows = this.db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?").all(limit) as Row[];
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
      // Secrets appear by name only (§7.2: 已修改), as in the revision's own change list.
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
}
