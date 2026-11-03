// Environment variables (design §7.2, phase 3): the Deployer keeps every version of each app's env file,
// with the manifest's env.secrets sealed, checks them against the app's .env.example (or the Deployer's
// template) and the compose fragment, and writes them to the server through the executor — as a plan
// first: which keys change and which services restart. Importing reads the file already on the server.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import type { Manifest } from "../compose/generate.ts";
import {
  affectedServices, changedKeys, checkEnv, KEY, parseEnv, parseExample, referencedKeys, serializeEnv,
  type EnvFinding, type ExampleKey,
} from "../env/dotenv.ts";
import { covering } from "../manifest/version.ts";
import type { Principal } from "./auth.ts";
import { DeployError, type Deployments } from "./deploy.ts";
import { hostOf, newJobId } from "./handoff.ts";
import { resolveReferences } from "./ingress.ts";
import { isKey } from "./keys.ts";
import { deployPermission, isProd } from "./plan.ts";
import { fingerprint, type SecretBox } from "./secretbox.ts";
import type { Actor, EnvRevision, ExecutorStatus, Job, Store, StoredEnv } from "./store.ts";
import { readToken, type TokenSource } from "./versions.ts";

/** Keys treated as secrets even when the manifest does not list them: better masked once too often. */
const LOOKS_SECRET = /(PASSWORD|PASSWD|PASS|SECRET|TOKEN|PRIVATE_KEY|API_KEY|_KEY)$/;

export interface Schema { version: string; source: string; keys: ExampleKey[] }

/** An app's expected keys at a version: its .env.example at the release tag, or the Deployer's template. */
export class Schemas {
  private cache = new Map<string, { at: number; text: string }>();
  private tokenFile: TokenSource;
  private templatesDir: string;
  private fetcher: typeof fetch;

  /** Templates the Deployer wrote for apps registered from an assessment (phase 7); looked at before templatesDir. */
  private keptDir: string | undefined;
  private api: string;

  constructor(tokenFile: TokenSource, templatesDir: string, fetcher: typeof fetch = fetch, keptDir?: string, api = "https://api.github.com") {
    this.tokenFile = tokenFile;
    this.templatesDir = templatesDir;
    this.fetcher = fetcher;
    this.keptDir = keptDir;
    this.api = api.replace(/\/+$/, "");
  }

  async get(manifest: Manifest, version: string): Promise<Schema | { error: string }> {
    const env = manifest.env;
    if (env?.template) {
      const rel = normalize(env.template.replace(/^templates\//, ""));
      if (rel.startsWith("..")) return { error: `Template path ${env.template} is outside templates/` };
      const dir = this.keptDir && existsSync(join(this.keptDir, rel)) ? this.keptDir : this.templatesDir;
      try { return { version, source: `Deployer ${env.template}`, keys: parseExample(readFileSync(join(dir, rel), "utf8")) }; } catch (error) { return { error: `Cannot read template ${env.template}: ${(error as Error).message}` }; }
    }
    if (!env?.schema) return { error: "The manifest has no env.schema or env.template" };
    if (!manifest.release) return { error: "The manifest has no release, so .env.example cannot be fetched" };
    const tag = manifest.release.tag.replaceAll("{version}", version);
    const key = `${manifest.release.repo}@${tag}:${env.schema}`;
    const hit = this.cache.get(key);
    // A tag does not move; an hour keeps a re-pushed tag from sticking forever.
    if (hit && Date.now() - hit.at < 3600_000) return { version, source: `${manifest.release.repo} ${tag} ${env.schema}`, keys: parseExample(hit.text) };
    const token = readToken(this.tokenFile);
    try {
      const response = await this.fetcher(`${this.api}/repos/${manifest.release.repo}/contents/${env.schema.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(tag)}`, {
        headers: { accept: "application/vnd.github.raw", "user-agent": "open-atlas-deployer", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) return { error: `GitHub returned HTTP ${response.status} for ${env.schema} at ${tag}${response.status === 404 && !token ? " (private repositories need DEPLOYER_GITHUB_TOKEN_FILE)" : ""}` };
      const text = await response.text();
      this.cache.set(key, { at: Date.now(), text });
      return { version, source: `${manifest.release.repo} ${tag} ${env.schema}`, keys: parseExample(text) };
    } catch (error) {
      return { error: `Cannot reach GitHub: ${(error as Error).message}` };
    }
  }
}

export interface EnvValue { key: string; value?: string; secret: boolean }
export interface EnvPlan {
  app: string;
  revision: number;
  applied: number | null;
  file: string;
  changes: EnvRevision["changes"];
  /** Services that read a changed key (§7.2: which services restart). */
  restarts: string[];
  /** Whether the Deployer runs this app: otherwise the file is only written, nothing restarts. */
  restart: boolean;
  findings: (EnvFinding | { code: string; message: string; blocking: boolean; key?: undefined })[];
}

export class EnvManager {
  private store: Store;
  private deployments: Deployments;
  private box: SecretBox | undefined;
  private compareKey: string | undefined;
  readonly schemas: Schemas;

  constructor(store: Store, deployments: Deployments, schemas: Schemas, box: SecretBox | undefined, compareKey?: string) {
    this.store = store;
    this.deployments = deployments;
    this.schemas = schemas;
    this.box = box;
    this.compareKey = compareKey;
    deployments.envState = (app) => this.state(app);
    deployments.afterJob = (job, status) => this.afterJob(job, status);
    deployments.envValues = (app) => this.appliedValues(app);
  }

  get enabled() { return Boolean(this.box); }

  private need(principal: Principal, what: "view" | "change" | "admin") {
    if (!this.box) throw new DeployError(409, "env/disabled", "DEPLOYER_CREDENTIAL_ENCRYPTION_KEY is not configured, so environment variable management is off.");
    if (what === "admin" && !principal.permissions.includes("admin")) throw new DeployError(403, "env/forbidden", "Only Workbench admins can see secret values.");
    if (what === "change") {
      const need = deployPermission(this.deployments.environment().env);
      if (!principal.permissions.includes(need)) throw new DeployError(403, "env/forbidden", `Changing environment variables needs the ${need} group.`);
    }
  }

  /** The manifest for the version running here (or about to: the desired version), and the app's env settings. */
  private context(appId: string, version?: string) {
    const app = this.store.app(appId);
    if (!app) throw new DeployError(404, "app/unknown", "This app is not in the registry.");
    const manifests = this.store.manifests(appId);
    const { env, deployed } = this.deployments.environment();
    const at = version ?? deployed[appId] ?? env.apps[appId]?.version ?? manifests.at(-1)?.appliesFrom;
    const manifest = (at && covering(manifests, at)) || manifests.at(-1);
    if (!manifest?.env) throw new DeployError(404, "env/none", `The ${appId} manifest has no env file.`);
    return { app, manifest, version: at ?? manifest.appliesFrom, deployed: appId in deployed, envFile: manifest.env };
  }

  private secretKeys(manifest: Manifest, keys: string[]): string[] {
    const listed = manifest.env?.secrets ?? [];
    return [...new Set([...listed, ...keys.filter((k) => LOOKS_SECRET.test(k))])];
  }

  private plain(values: StoredEnv): Record<string, string> {
    return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, "v" in v ? v.v : this.box!.open(v.s)]));
  }

  private seal(manifest: Manifest, values: Record<string, string>): StoredEnv {
    const secrets = this.secretKeys(manifest, Object.keys(values));
    return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, secrets.includes(k) ? { s: this.box!.seal(v) } : { v }]));
  }

  /** The env file as last written to the server, decrypted: component settings may name ${KEY} (phase 5). */
  appliedValues(appId: string): Record<string, string> | undefined {
    const applied = this.box ? this.store.appliedEnv(appId) : undefined;
    return applied ? this.plain(applied.values) : undefined;
  }

  /** §15: the newest saved values, decrypted, and the revision the server has; undefined before the first revision. */
  latestValues(appId: string): { revision: number; applied: number | null; values: Record<string, string> } | undefined {
    const latest = this.box ? this.store.envRevision(appId) : undefined;
    return latest ? { revision: latest.meta.revision, applied: this.store.appliedEnv(appId)?.meta.revision ?? null, values: this.plain(latest.values) } : undefined;
  }

  /** What deploy plans need: whether the Deployer keeps this env file, which keys the server's copy sets. */
  state(appId: string): { managed: boolean; keys: string[]; revision: number | null; pending: boolean } | undefined {
    if (!this.box) return undefined;
    const applied = this.store.appliedEnv(appId);
    const latest = this.store.envRevision(appId);
    return { managed: Boolean(applied), keys: applied ? Object.keys(applied.values) : [], revision: applied?.meta.revision ?? null, pending: Boolean(latest && latest.meta.revision !== applied?.meta.revision) };
  }

  async view(principal: Principal, appId: string, options: { revision?: number; version?: string } = {}) {
    this.need(principal, "view");
    const { manifest, version, deployed, envFile } = this.context(appId, options.version);
    const shown = this.store.envRevision(appId, options.revision);
    if (options.revision !== undefined && !shown) throw new DeployError(404, "env/revision", `No revision ${options.revision}.`);
    const applied = this.store.appliedEnv(appId);
    const keys = shown ? Object.keys(shown.values) : [];
    const secrets = this.secretKeys(manifest, keys);
    const values: EnvValue[] = shown ? Object.entries(shown.values).map(([key, v]) => (secrets.includes(key) || "s" in v ? { key, secret: true } : { key, value: v.v, secret: false })) : [];
    const schema = await this.schemas.get(manifest, version);
    const findings = checkEnv(keys, "keys" in schema ? schema.keys : null, referencedKeys(manifest));
    return {
      app: appId, file: envFile.file, version, deployed, secrets,
      revision: shown?.meta ?? null, values,
      applied: applied?.meta.revision ?? null,
      revisions: this.store.envRevisions(appId),
      schema, referenced: referencedKeys(manifest), findings,
      canChange: principal.permissions.includes(deployPermission(this.deployments.environment().env)),
      canReveal: principal.permissions.includes("admin"),
    };
  }

  reveal(principal: Principal, appId: string, revision: number, key: string): string {
    this.need(principal, "admin");
    if (isKey(principal)) throw new DeployError(403, "auth/browser-only", "Secret values are shown only to browser sessions, not API keys (§9.4).");
    const r = this.store.envRevision(appId, revision);
    const v = r?.values[key];
    if (!v) throw new DeployError(404, "env/key", `Revision ${revision} has no ${key}.`);
    this.store.audit({ id: principal.id, via: principal.via }, "env.reveal", `${appId}#${revision}`, { key });
    return "v" in v ? v.v : this.box!.open(v.s);
  }

  /** Saves a new revision. Secrets the page did not change come back as { keep: true }, since it never had them. */
  save(principal: Principal, appId: string, body: { base: number | null; values: { key: string; value?: string; keep?: boolean }[]; note?: string }): number {
    this.need(principal, "change");
    const { manifest } = this.context(appId);
    const latest = this.store.envRevision(appId);
    if ((latest?.meta.revision ?? null) !== body.base) throw new DeployError(409, "env/conflict", `Someone just saved revision ${latest?.meta.revision}; reload and try again.`);
    const before = latest ? this.plain(latest.values) : {};
    const next: Record<string, string> = {};
    const errors: string[] = [];
    for (const item of body.values ?? []) {
      if (typeof item?.key !== "string" || !KEY.test(item.key)) { errors.push(`${String(item?.key)} is not a valid key name`); continue; }
      if (item.key in next) { errors.push(`${item.key} appears twice`); continue; }
      if (item.keep) {
        if (!(item.key in before)) { errors.push(`${item.key} had no value before, so it cannot be kept`); continue; }
        next[item.key] = before[item.key]!;
      } else if (typeof item.value !== "string" || item.value.includes("\0")) {
        errors.push(`The value of ${item.key} is not text`);
      } else next[item.key] = item.value;
    }
    if (errors.length) throw new DeployError(400, "env/invalid", "Some environment variables are invalid.", errors);
    const changes = changedKeys(before, next, this.secretKeys(manifest, [...Object.keys(before), ...Object.keys(next)]));
    if (!changes.length) throw new DeployError(400, "env/unchanged", "Nothing changed.");
    return this.store.saveEnv(appId, this.seal(manifest, next), changes, "edit", { id: principal.id, via: principal.via }, body.note ? { note: body.note } : {});
  }

  /** "Go back to this revision": a new revision with an earlier one's values. */
  revert(principal: Principal, appId: string, revision: number, base: number | null): number {
    this.need(principal, "change");
    const { manifest } = this.context(appId);
    const latest = this.store.envRevision(appId);
    if ((latest?.meta.revision ?? null) !== base) throw new DeployError(409, "env/conflict", `Someone just saved revision ${latest?.meta.revision}; reload and try again.`);
    const target = this.store.envRevision(appId, revision);
    if (!target) throw new DeployError(404, "env/revision", `No revision ${revision}.`);
    const before = latest ? this.plain(latest.values) : {};
    const next = this.plain(target.values);
    const changes = changedKeys(before, next, this.secretKeys(manifest, [...Object.keys(before), ...Object.keys(next)]));
    if (!changes.length) throw new DeployError(400, "env/unchanged", `Revision ${revision} is the same as the current one.`);
    return this.store.saveEnv(appId, this.seal(manifest, next), changes, "revert", { id: principal.id, via: principal.via }, { note: `Back to revision ${revision}`, detail: { from: revision } });
  }

  plan(principal: Principal, appId: string, revision?: number): EnvPlan {
    this.need(principal, "view");
    const { manifest, deployed, envFile } = this.context(appId);
    const target = this.store.envRevision(appId, revision);
    if (!target) throw new DeployError(404, "env/revision", revision === undefined ? "No revisions yet: import the env file from the server first." : `No revision ${revision}.`);
    const applied = this.store.appliedEnv(appId);
    const findings: EnvPlan["findings"] = [];
    const block = (code: string, message: string) => findings.push({ code, message, blocking: true });
    const need = deployPermission(this.deployments.environment().env);
    if (!principal.permissions.includes(need)) block("env/forbidden", `Changing environment variables needs the ${need} group.`);
    if (!applied) block("env/not-imported", "The env file on the server has not been imported yet: import it first, so the plan can show what a write would overwrite.");
    const executor = this.deployments.handoff.executor(hostOf(this.deployments.environment().env, appId));
    if (!executor.online) block("deploy/executor-offline", executor.reason ?? "The executor is offline.");
    else if (!executor.heartbeat?.kinds?.includes("env")) block("env/executor-old", `Executor ${executor.heartbeat?.version} cannot write env files; upgrade the executor first.`);
    const busy = this.store.activeJobs().find((j) => j.app === appId);
    if (busy) block("deploy/busy", `${appId} already has a job running (${busy.id}).`);
    const next = this.plain(target.values);
    const before = applied ? this.plain(applied.values) : {};
    findings.push(...checkEnv(Object.keys(next), null, referencedKeys(manifest)));
    // D36: {{app:<id>.url}} in a value is written as that app's address in this environment.
    for (const [key, value] of Object.entries(next)) for (const u of resolveReferences(value, (id) => this.deployments.endpointOf(id)).unresolved) block("env/app-ref", `${key} refers to an address that cannot be worked out: ${u}.`);
    const changes = changedKeys(before, next, this.secretKeys(manifest, [...Object.keys(before), ...Object.keys(next)]));
    if (applied && !changes.length) findings.push({ code: "env/same", message: `The server already has these values (revision ${applied.meta.revision}); this only rewrites the file.`, blocking: false });
    if (!deployed) findings.push({ code: "env/write-only", message: `${appId} has not been deployed by the Deployer yet: the file is written without a restart and takes effect on the next deploy (or a manual restart).`, blocking: false });
    // Compose recreates a container only when its configuration changed, so an unchanged file restarts nothing.
    const restarts = deployed && changes.length ? affectedServices(manifest, changes.map((c) => c.key)) : [];
    if (deployed && changes.length && !restarts.length) findings.push({ code: "env/no-restart", message: "No service reads these keys: the file is written only.", blocking: false });
    return { app: appId, revision: target.meta.revision, applied: applied?.meta.revision ?? null, file: envFile.file, changes, restarts, restart: deployed, findings };
  }

  apply(principal: Principal, appId: string, revision: number): Job {
    if (isKey(principal) && isProd(this.deployments.environment().env)) throw new DeployError(403, "auth/browser-only", "Writes to PROD accept only browser sessions, not API keys (§9.4).");
    const p = this.plan(principal, appId, revision);
    const blocking = p.findings.filter((f) => f.blocking);
    if (blocking.length) throw new DeployError(409, "env/blocked", "The plan has problems that block the write.", blocking.map((f) => f.message));
    const { manifest } = this.context(appId);
    const values = Object.fromEntries(Object.entries(this.plain(this.store.envRevision(appId, revision)!.values)).map(([k, v]) => [k, resolveReferences(v, (id) => this.deployments.endpointOf(id)).text]));
    const content = serializeEnv(values, `Written by Open Atlas Deployer: ${appId} env revision ${revision}.\nEdit it in the Deployer; changes made here are overwritten.`);
    const sha256 = createHash("sha256").update(content).digest("hex");
    const services = manifest.components.filter((c) => c.type === "compose-service" && c.service).map((c) => c.service!);
    const request = { kind: "env", app: appId, revision, file: p.file, sha256, restart: p.restart, services: p.restarts.length ? services : [] };
    const id = newJobId("env");
    const { env } = this.deployments.environment();
    // The job record keeps the hash; only the request file carries the content, and the executor removes it on pickup.
    this.store.addJob({ id, kind: "env", app: appId, version: `env#${revision}`, environment: env.name, fromVersion: p.applied === null ? null : `env#${p.applied}`, manifest: null, pinFrom: null, request }, actorOf(principal));
    this.deployments.handoff.submit(id, { ...request, content, requestedBy: principal.id }, hostOf(this.deployments.environment().env, appId));
    return this.store.job(id)!;
  }

  importFromServer(principal: Principal, appId: string): Job {
    this.need(principal, "change");
    const { envFile } = this.context(appId);
    const executor = this.deployments.handoff.executor(hostOf(this.deployments.environment().env, appId));
    if (!executor.online) throw new DeployError(409, "deploy/executor-offline", executor.reason ?? "The executor is offline.");
    if (!executor.heartbeat?.kinds?.includes("env-read")) throw new DeployError(409, "env/executor-old", `Executor ${executor.heartbeat?.version} cannot read env files; upgrade the executor first.`);
    if (this.store.activeJobs().some((j) => j.app === appId)) throw new DeployError(409, "deploy/busy", `${appId} already has a job running.`);
    const request = { kind: "env-read", app: appId, file: envFile.file };
    const id = newJobId("env-read");
    this.store.addJob({ id, kind: "env-read", app: appId, version: "env", environment: this.deployments.environment().env.name, fromVersion: null, manifest: null, pinFrom: null, request }, actorOf(principal));
    this.deployments.handoff.submit(id, { ...request, requestedBy: principal.id }, hostOf(this.deployments.environment().env, appId));
    return this.store.job(id)!;
  }

  /** After the executor finishes: a written revision is now the server's; an imported file becomes a revision. */
  async afterJob(job: Job, status: ExecutorStatus) {
    if (job.kind === "env" && status.state === "succeeded") this.store.markEnvApplied(job.app, Number(job.request.revision), job.id);
    if (job.kind !== "env-read" || status.state !== "succeeded" || !this.box) return;
    const found = status.result.env;
    let text = "";
    if (found?.exists) {
      text = this.deployments.handoff.envContent(job.id) ?? "";
      if (createHash("sha256").update(text).digest("hex") !== found.sha256) {
        this.store.audit({ id: "deployer", via: "cli" }, "env.import-failed", job.app, { job: job.id, reason: "content does not match the executor's hash" });
        return;
      }
    }
    const parsed = parseEnv(text);
    const latest = this.store.envRevision(job.app);
    const before = latest ? this.plain(latest.values) : {};
    const { manifest } = this.context(job.app);
    const secrets = this.secretKeys(manifest, [...Object.keys(before), ...Object.keys(parsed.values)]);
    const changes = changedKeys(before, parsed.values, secrets);
    if (latest && !changes.length) {
      this.store.markEnvApplied(job.app, latest.meta.revision, job.id);
      return;
    }
    // The server still has what the Deployer last wrote or imported: nothing new to import.
    const applied = this.store.appliedEnv(job.app);
    if (applied && !changedKeys(this.plain(applied.values), parsed.values, secrets).length) {
      this.store.markEnvApplied(job.app, applied.meta.revision, job.id);
      return;
    }
    const note = [found?.exists ? `Imported from ${job.request.file} on the server` : `${job.request.file} does not exist on the server`, ...parsed.errors].join("; ");
    const actor = { id: job.requestedBy, via: job.via as Actor["via"] };
    this.store.saveEnv(job.app, this.seal(manifest, parsed.values), changes, "import", actor, { note, appliedJob: job.id });
    // Edits saved before this import and never written stay the newest revision, so the next write still carries them
    // and nobody edits on top of the imported file by mistake (a first install saves values, then has to import).
    if (latest && !latest.meta.appliedAt) {
      const kept = before;
      const again = changedKeys(parsed.values, kept, this.secretKeys(manifest, [...Object.keys(parsed.values), ...Object.keys(kept)]));
      if (again.length) this.store.saveEnv(job.app, latest.values, again, "revert", actor, { note: `Back to revision ${latest.meta.revision}: saved before the import and not written yet`, detail: { from: latest.meta.revision } });
    }
  }

  /** For comparing UAT and PROD (§7.2): values as they are on the server; secrets only as an HMAC under the shared compare key. */
  fingerprint(principal: Principal, appId: string) {
    this.need(principal, "view");
    return this.fingerprintOf(appId);
  }

  /** The same for the other Deployer's read-only key (§6.3). */
  fingerprintOf(appId: string) {
    if (!this.box) throw new DeployError(409, "env/disabled", "DEPLOYER_CREDENTIAL_ENCRYPTION_KEY is not configured, so environment variable management is off.");
    const { manifest, version } = this.context(appId);
    const applied = this.store.appliedEnv(appId);
    if (!applied) throw new DeployError(404, "env/not-imported", "The env file on the server has not been imported yet.");
    const secrets = this.secretKeys(manifest, Object.keys(applied.values));
    const plain = this.plain(applied.values);
    const keys = Object.fromEntries(Object.entries(plain).map(([k, v]) => [k, secrets.includes(k)
      ? (this.compareKey ? { secret: fingerprint(this.compareKey, appId, k, v) } : { secret: null })
      : { value: v }]));
    return { format: "open-atlas-deployer.env-fingerprint/1", environment: this.deployments.environment().env.name, app: appId, version, revision: applied.meta.revision, keys };
  }
}

const actorOf = (p: Principal): Actor => ({ id: p.id, via: p.via });
