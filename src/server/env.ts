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
import { newJobId } from "./handoff.ts";
import { isKey } from "./keys.ts";
import { deployPermission, isProd } from "./plan.ts";
import { fingerprint, type SecretBox } from "./secretbox.ts";
import type { Actor, EnvRevision, ExecutorStatus, Job, Store, StoredEnv } from "./store.ts";
import { readToken } from "./versions.ts";

/** Keys treated as secrets even when the manifest does not list them: better masked once too often. */
const LOOKS_SECRET = /(PASSWORD|PASSWD|PASS|SECRET|TOKEN|PRIVATE_KEY|API_KEY|_KEY)$/;

export interface Schema { version: string; source: string; keys: ExampleKey[] }

/** An app's expected keys at a version: its .env.example at the release tag, or the Deployer's template. */
export class Schemas {
  private cache = new Map<string, { at: number; text: string }>();
  private tokenFile: string | undefined;
  private templatesDir: string;
  private fetcher: typeof fetch;

  /** Templates the Deployer wrote for apps registered from an assessment (phase 7); looked at before templatesDir. */
  private keptDir: string | undefined;

  constructor(tokenFile: string | undefined, templatesDir: string, fetcher: typeof fetch = fetch, keptDir?: string) {
    this.tokenFile = tokenFile;
    this.templatesDir = templatesDir;
    this.fetcher = fetcher;
    this.keptDir = keptDir;
  }

  async get(manifest: Manifest, version: string): Promise<Schema | { error: string }> {
    const env = manifest.env;
    if (env?.template) {
      const rel = normalize(env.template.replace(/^templates\//, ""));
      if (rel.startsWith("..")) return { error: `模板路径 ${env.template} 不在 templates/ 里` };
      const dir = this.keptDir && existsSync(join(this.keptDir, rel)) ? this.keptDir : this.templatesDir;
      try { return { version, source: `Deployer ${env.template}`, keys: parseExample(readFileSync(join(dir, rel), "utf8")) }; } catch (error) { return { error: `读不到模板 ${env.template}：${(error as Error).message}` }; }
    }
    if (!env?.schema) return { error: "清单没有 env.schema 或 env.template" };
    if (!manifest.release) return { error: "清单没有 release，取不到 .env.example" };
    const tag = manifest.release.tag.replaceAll("{version}", version);
    const key = `${manifest.release.repo}@${tag}:${env.schema}`;
    const hit = this.cache.get(key);
    // A tag does not move; an hour keeps a re-pushed tag from sticking forever.
    if (hit && Date.now() - hit.at < 3600_000) return { version, source: `${manifest.release.repo} ${tag} ${env.schema}`, keys: parseExample(hit.text) };
    const token = readToken(this.tokenFile);
    try {
      const response = await this.fetcher(`https://api.github.com/repos/${manifest.release.repo}/contents/${env.schema.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(tag)}`, {
        headers: { accept: "application/vnd.github.raw", "user-agent": "open-atlas-deployer", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) return { error: `取 ${tag} 的 ${env.schema} 时 GitHub 返回 HTTP ${response.status}${response.status === 404 && !token ? "（私有仓库需要 DEPLOYER_GITHUB_TOKEN_FILE）" : ""}` };
      const text = await response.text();
      this.cache.set(key, { at: Date.now(), text });
      return { version, source: `${manifest.release.repo} ${tag} ${env.schema}`, keys: parseExample(text) };
    } catch (error) {
      return { error: `连不上 GitHub：${(error as Error).message}` };
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
  /** Services that read a changed key (§7.2: 会重启哪些服务). */
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
    if (!this.box) throw new DeployError(409, "env/disabled", "没有配置 DEPLOYER_CREDENTIAL_ENCRYPTION_KEY，环境变量管理没有启用。");
    if (what === "admin" && !principal.permissions.includes("admin")) throw new DeployError(403, "env/forbidden", "只有 Workbench 管理员能查看密钥原值。");
    if (what === "change") {
      const need = deployPermission(this.deployments.environment().env);
      if (!principal.permissions.includes(need)) throw new DeployError(403, "env/forbidden", `修改环境变量需要在 ${need} 组里。`);
    }
  }

  /** The manifest for the version running here (or about to: the desired version), and the app's env settings. */
  private context(appId: string, version?: string) {
    const app = this.store.app(appId);
    if (!app) throw new DeployError(404, "app/unknown", "注册表里没有这个应用。");
    const manifests = this.store.manifests(appId);
    const { env, deployed } = this.deployments.environment();
    const at = version ?? deployed[appId] ?? env.apps[appId]?.version ?? manifests.at(-1)?.appliesFrom;
    const manifest = (at && covering(manifests, at)) || manifests.at(-1);
    if (!manifest?.env) throw new DeployError(404, "env/none", `${appId} 的清单没有 env 文件。`);
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
    if (options.revision !== undefined && !shown) throw new DeployError(404, "env/revision", `没有第 ${options.revision} 版。`);
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
    if (isKey(principal)) throw new DeployError(403, "auth/browser-only", "查看密钥原值只认浏览器会话，API key 不行（§9.4）。");
    const r = this.store.envRevision(appId, revision);
    const v = r?.values[key];
    if (!v) throw new DeployError(404, "env/key", `第 ${revision} 版没有 ${key}。`);
    this.store.audit({ id: principal.id, via: principal.via }, "env.reveal", `${appId}#${revision}`, { key });
    return "v" in v ? v.v : this.box!.open(v.s);
  }

  /** Saves a new revision. Secrets the page did not change come back as { keep: true }, since it never had them. */
  save(principal: Principal, appId: string, body: { base: number | null; values: { key: string; value?: string; keep?: boolean }[]; note?: string }): number {
    this.need(principal, "change");
    const { manifest } = this.context(appId);
    const latest = this.store.envRevision(appId);
    if ((latest?.meta.revision ?? null) !== body.base) throw new DeployError(409, "env/conflict", `别人刚保存了第 ${latest?.meta.revision} 版，请刷新后再改。`);
    const before = latest ? this.plain(latest.values) : {};
    const next: Record<string, string> = {};
    const errors: string[] = [];
    for (const item of body.values ?? []) {
      if (typeof item?.key !== "string" || !KEY.test(item.key)) { errors.push(`${String(item?.key)} 不是合法的键名`); continue; }
      if (item.key in next) { errors.push(`${item.key} 出现了两次`); continue; }
      if (item.keep) {
        if (!(item.key in before)) { errors.push(`${item.key} 之前没有值，不能保留`); continue; }
        next[item.key] = before[item.key]!;
      } else if (typeof item.value !== "string" || item.value.includes("\0")) {
        errors.push(`${item.key} 的值不是文本`);
      } else next[item.key] = item.value;
    }
    if (errors.length) throw new DeployError(400, "env/invalid", "环境变量有问题。", errors);
    const changes = changedKeys(before, next, this.secretKeys(manifest, [...Object.keys(before), ...Object.keys(next)]));
    if (!changes.length) throw new DeployError(400, "env/unchanged", "没有改动。");
    return this.store.saveEnv(appId, this.seal(manifest, next), changes, "edit", { id: principal.id, via: principal.via }, body.note ? { note: body.note } : {});
  }

  /** "回到之前的版本": a new revision with an earlier one's values. */
  revert(principal: Principal, appId: string, revision: number, base: number | null): number {
    this.need(principal, "change");
    const { manifest } = this.context(appId);
    const latest = this.store.envRevision(appId);
    if ((latest?.meta.revision ?? null) !== base) throw new DeployError(409, "env/conflict", `别人刚保存了第 ${latest?.meta.revision} 版，请刷新后再改。`);
    const target = this.store.envRevision(appId, revision);
    if (!target) throw new DeployError(404, "env/revision", `没有第 ${revision} 版。`);
    const before = latest ? this.plain(latest.values) : {};
    const next = this.plain(target.values);
    const changes = changedKeys(before, next, this.secretKeys(manifest, [...Object.keys(before), ...Object.keys(next)]));
    if (!changes.length) throw new DeployError(400, "env/unchanged", `第 ${revision} 版和当前版本一样。`);
    return this.store.saveEnv(appId, this.seal(manifest, next), changes, "revert", { id: principal.id, via: principal.via }, { note: `回到第 ${revision} 版`, detail: { from: revision } });
  }

  plan(principal: Principal, appId: string, revision?: number): EnvPlan {
    this.need(principal, "view");
    const { manifest, deployed, envFile } = this.context(appId);
    const target = this.store.envRevision(appId, revision);
    if (!target) throw new DeployError(404, "env/revision", revision === undefined ? "还没有任何版本：先导入服务器上的 env 文件。" : `没有第 ${revision} 版。`);
    const applied = this.store.appliedEnv(appId);
    const findings: EnvPlan["findings"] = [];
    const block = (code: string, message: string) => findings.push({ code, message, blocking: true });
    const need = deployPermission(this.deployments.environment().env);
    if (!principal.permissions.includes(need)) block("env/forbidden", `修改环境变量需要在 ${need} 组里。`);
    if (!applied) block("env/not-imported", "服务器上的 env 文件还没导入过：先导入，写入前才能看出会覆盖什么。");
    const executor = this.deployments.handoff.executor();
    if (!executor.online) block("deploy/executor-offline", executor.reason ?? "执行器不在线。");
    else if (!executor.heartbeat?.kinds?.includes("env")) block("env/executor-old", `执行器 ${executor.heartbeat?.version} 不会写 env 文件，请先升级执行器。`);
    const busy = this.store.activeJobs().find((j) => j.app === appId);
    if (busy) block("deploy/busy", `${appId} 已有一个任务在进行（${busy.id}）。`);
    const next = this.plain(target.values);
    const before = applied ? this.plain(applied.values) : {};
    findings.push(...checkEnv(Object.keys(next), null, referencedKeys(manifest)));
    const changes = changedKeys(before, next, this.secretKeys(manifest, [...Object.keys(before), ...Object.keys(next)]));
    if (applied && !changes.length) findings.push({ code: "env/same", message: `服务器上已经是这些值（第 ${applied.meta.revision} 版），这次只是重写文件。`, blocking: false });
    if (!deployed) findings.push({ code: "env/write-only", message: `${appId} 还没有经 Deployer 部署过：只写文件，不重启；下次部署（或手工重启）时生效。`, blocking: false });
    // Compose recreates a container only when its configuration changed, so an unchanged file restarts nothing.
    const restarts = deployed && changes.length ? affectedServices(manifest, changes.map((c) => c.key)) : [];
    if (deployed && changes.length && !restarts.length) findings.push({ code: "env/no-restart", message: "没有服务读这些键：只写文件。", blocking: false });
    return { app: appId, revision: target.meta.revision, applied: applied?.meta.revision ?? null, file: envFile.file, changes, restarts, restart: deployed, findings };
  }

  apply(principal: Principal, appId: string, revision: number): Job {
    if (isKey(principal) && isProd(this.deployments.environment().env)) throw new DeployError(403, "auth/browser-only", "PROD 的写入只认浏览器会话，API key 不行（§9.4）。");
    const p = this.plan(principal, appId, revision);
    const blocking = p.findings.filter((f) => f.blocking);
    if (blocking.length) throw new DeployError(409, "env/blocked", "计划里有阻止写入的问题。", blocking.map((f) => f.message));
    const { manifest } = this.context(appId);
    const values = this.plain(this.store.envRevision(appId, revision)!.values);
    const content = serializeEnv(values, `Written by Open Atlas Deployer: ${appId} env revision ${revision}.\nEdit it in the Deployer; changes made here are overwritten.`);
    const sha256 = createHash("sha256").update(content).digest("hex");
    const services = manifest.components.filter((c) => c.type === "compose-service" && c.service).map((c) => c.service!);
    const request = { kind: "env", app: appId, revision, file: p.file, sha256, restart: p.restart, services: p.restarts.length ? services : [] };
    const id = newJobId("env");
    const { env } = this.deployments.environment();
    // The job record keeps the hash; only the request file carries the content, and the executor removes it on pickup.
    this.store.addJob({ id, kind: "env", app: appId, version: `env#${revision}`, environment: env.name, fromVersion: p.applied === null ? null : `env#${p.applied}`, manifest: null, pinFrom: null, request }, actorOf(principal));
    this.deployments.handoff.submit(id, { ...request, content, requestedBy: principal.id });
    return this.store.job(id)!;
  }

  importFromServer(principal: Principal, appId: string): Job {
    this.need(principal, "change");
    const { envFile } = this.context(appId);
    const executor = this.deployments.handoff.executor();
    if (!executor.online) throw new DeployError(409, "deploy/executor-offline", executor.reason ?? "执行器不在线。");
    if (!executor.heartbeat?.kinds?.includes("env-read")) throw new DeployError(409, "env/executor-old", `执行器 ${executor.heartbeat?.version} 不会读 env 文件，请先升级执行器。`);
    if (this.store.activeJobs().some((j) => j.app === appId)) throw new DeployError(409, "deploy/busy", `${appId} 已有一个任务在进行。`);
    const request = { kind: "env-read", app: appId, file: envFile.file };
    const id = newJobId("env-read");
    this.store.addJob({ id, kind: "env-read", app: appId, version: "env", environment: this.deployments.environment().env.name, fromVersion: null, manifest: null, pinFrom: null, request }, actorOf(principal));
    this.deployments.handoff.submit(id, { ...request, requestedBy: principal.id });
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
    const note = [found?.exists ? `从服务器的 ${job.request.file} 导入` : `服务器上没有 ${job.request.file}`, ...parsed.errors].join("；");
    this.store.saveEnv(job.app, this.seal(manifest, parsed.values), changes, "import", { id: job.requestedBy, via: job.via as Actor["via"] }, { note, appliedJob: job.id });
  }

  /** For comparing UAT and PROD (§7.2): values as they are on the server; secrets only as an HMAC under the shared compare key. */
  fingerprint(principal: Principal, appId: string) {
    this.need(principal, "view");
    return this.fingerprintOf(appId);
  }

  /** The same for the other Deployer's read-only key (§6.3). */
  fingerprintOf(appId: string) {
    if (!this.box) throw new DeployError(409, "env/disabled", "没有配置 DEPLOYER_CREDENTIAL_ENCRYPTION_KEY，环境变量管理没有启用。");
    const { manifest, version } = this.context(appId);
    const applied = this.store.appliedEnv(appId);
    if (!applied) throw new DeployError(404, "env/not-imported", "服务器上的 env 文件还没导入过。");
    const secrets = this.secretKeys(manifest, Object.keys(applied.values));
    const plain = this.plain(applied.values);
    const keys = Object.fromEntries(Object.entries(plain).map(([k, v]) => [k, secrets.includes(k)
      ? (this.compareKey ? { secret: fingerprint(this.compareKey, appId, k, v) } : { secret: null })
      : { value: v }]));
    return { format: "open-atlas-deployer.env-fingerprint/1", environment: this.deployments.environment().env.name, app: appId, version, revision: applied.meta.revision, keys };
  }
}

const actorOf = (p: Principal): Actor => ({ id: p.id, via: p.via });
