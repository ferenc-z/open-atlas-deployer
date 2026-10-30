// Builds and deploys through the host executor (phase 2): desired state, plans, jobs, and keeping the
// job records in step with what the executor reports. Every deploy leaves a record shaped after OMA's
// deployment-receipt:1 (§8.5), and every image it ran is kept as an artifact (§6.1). In PROD a plan first
// asks UAT's Deployer and GitHub whether the version may be promoted (§6.2, phase 4). Phase 5: a deploy runs every
// component in dependsOn order (rollout.ts): the executor's part first, then the Deployer's drivers and manual steps;
// the release bundle and the contract check (§6.4) are part of the plan.

import { readFileSync } from "node:fs";
import type { Component, Environment, Manifest } from "../compose/generate.ts";
import { covering } from "../manifest/version.ts";
import type { Principal } from "./auth.ts";
import type { Bundle, Bundles } from "./bundle.ts";
import { checkContracts, type ContractDocs, type Running } from "./contracts.ts";
import type { DeployDriver, StepContext } from "./drivers/types.ts";
import { Handoff, newJobId } from "./handoff.ts";
import type { Observer } from "./observe.ts";
import type { Peer } from "./peer.ts";
import { buildRequests, deployPermission, isProd, manifestRef, plan, type BundleInfo, type Plan, type PlanContext, type PromotionInput } from "./plan.ts";
import { isKey } from "./keys.ts";
import { DEPLOYER_TYPES, RolloutError, Runner, type Rollout, type RolloutStep } from "./rollout.ts";
import type { Versions } from "./versions.ts";
import { FINAL_STATES, type Actor, type ExecutorStatus, type Job, type Store } from "./store.ts";

export type EnvState = { managed: boolean; keys: string[]; revision: number | null; pending: boolean };

export class DeployError extends Error {
  readonly status: 400 | 403 | 404 | 409;
  readonly code: string;
  readonly details: string[];
  constructor(status: 400 | 403 | 404 | 409, code: string, message: string, details: string[] = []) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** §8.5: the fields of a deployment record, from one deploy job. */
export function deploymentRecord(job: Job, repo: string | undefined) {
  const result = job.status?.result ?? {};
  const builds = Object.values(result.builds ?? {});
  return {
    project_ref: job.app,
    repo_ref: repo ?? null,
    commit_sha: builds[0]?.commit ?? null,
    target_ref: `${job.environment}/${job.app}`,
    deployment_id: job.id,
    artifact_digest: result.digests ?? null,
    // The env revision on the server when the deploy was planned (phase 3).
    config_revision: typeof job.request.envRevision === "number" ? `${job.app}.env#${job.request.envRevision}` : null,
    deployed_at: job.state === "succeeded" ? job.finishedAt : null,
    observation: job.observation ?? null,
    ...(job.diagnosis ? { diagnosis: job.diagnosis } : {}),
  };
}

/** ghcr.io/acme/shop:1.2.0@sha256:… → ghcr.io/acme/shop (as the executor's repository()). */
export function repository(ref: string): string {
  const name = ref.split("@")[0]!;
  const last = name.split("/").at(-1)!;
  return last.includes(":") ? name.slice(0, name.lastIndexOf(":")) : name;
}

/** A public image with a fixed version (D14): a digest, or a tag that is not latest. */
export function pinnedTag(image: string): boolean {
  if (image.includes("@sha256:")) return true;
  const last = image.split("/").at(-1)!;
  const tag = last.includes(":") ? last.slice(last.indexOf(":") + 1) : "";
  return Boolean(tag) && tag !== "latest";
}

export class Deployments {
  private store: Store;
  readonly handoff: Handoff;
  private observer: Observer;
  private environmentFile: string;
  /** Set by the env manager (phase 3): what the server's env file holds, and what to do when its jobs finish. */
  envState?: (app: string) => EnvState | undefined;
  afterJob?: (job: Job, status: ExecutorStatus) => Promise<void>;

  /** The app's env file as last written to the server, decrypted (env manager), for ${KEY} in component settings. */
  envValues?: (app: string) => Record<string, string> | undefined;
  /** Set when OMA is configured (phase 6, D24): a failed or rolled-back deploy is diagnosed. */
  onFailure?: (job: Job) => Promise<void>;

  private peer: Peer | undefined;
  private releases: Pick<Versions, "release"> | undefined;
  private bundles: Bundles | undefined;
  private contracts: ContractDocs | undefined;
  private drivers: Record<string, DeployDriver>;
  readonly runner: Runner;
  private now: () => number;

  constructor(store: Store, handoff: Handoff, observer: Observer, environmentFile: string,
    options: { peer?: Peer; releases?: Pick<Versions, "release">; bundles?: Bundles; contracts?: ContractDocs; drivers?: DeployDriver[]; now?: () => number } = {}) {
    this.store = store;
    this.handoff = handoff;
    this.observer = observer;
    this.environmentFile = environmentFile;
    this.peer = options.peer;
    this.releases = options.releases;
    this.bundles = options.bundles;
    this.contracts = options.contracts;
    this.drivers = Object.fromEntries((options.drivers ?? []).map((d) => [d.type, d]));
    this.now = options.now ?? Date.now;
    this.runner = new Runner(store, {
      drivers: this.drivers,
      context: (job, step) => this.jobStepContext(job, step),
      finish: (job, state, message) => this.finishRollout(job, state, message),
    }, () => new Date(this.now()));
  }

  /** The environment file's settings, with each app at the version the Deployer last deployed (§7.1). */
  environment(): { env: Environment; deployed: Record<string, string> } {
    const file = JSON.parse(readFileSync(this.environmentFile, "utf8")) as Environment;
    const deployed: Record<string, string> = {};
    const apps = { ...file.apps };
    for (const app of this.store.listApps()) {
      const last = this.store.deployedVersion(app.id);
      if (!last) continue;
      deployed[app.id] = last.version;
      apps[app.id] = { ...apps[app.id], version: last.version };
    }
    return { env: { ...file, apps }, deployed };
  }

  private manifests(): Record<string, Manifest[]> {
    return Object.fromEntries(this.store.listApps().map((a) => [a.id, this.store.manifests(a.id)]));
  }

  /** What decides promotion to PROD (§6.2): UAT's newest successful deploy of this version, and the release. */
  private async promotionInput(env: Environment, appId: string, version: string, override?: { reason: string; by: string }): Promise<PromotionInput | undefined> {
    if (!isProd(env)) return undefined;
    const manifest = covering(this.store.manifests(appId), version);
    const uat: PromotionInput["uat"] = { configured: Boolean(this.peer?.configured) };
    if (this.peer?.configured) {
      try {
        const r = await this.peer.deployments(appId, version);
        uat.environment = r.environment;
        const record = r.records.find((x) => Object.keys(x.digests).length);
        if (record) uat.record = record;
      } catch (error) { uat.error = (error as Error).message; }
    }
    let release = { released: false, detail: "清单没有 release，无法确认是否已发布" };
    const services = manifest?.components.filter((c) => c.type === "compose-service" && c.source) ?? [];
    const own = services.filter((c) => c.source!.kind === "company-registry");
    const floating = services.flatMap((c) => (c.source!.kind === "public-registry" && !pinnedTag(c.source!.image) ? [c.source!.image] : []));
    if (floating.length) release = { released: false, detail: `公共镜像 ${floating.join("、")} 没有固定版本号` };
    else if (!own.length) release = { released: true, detail: "只用固定版本号的公共镜像" };
    else if (manifest?.release) {
      release = this.releases ? await this.releases.release(manifest.release.repo, manifest.release.tag.replaceAll("{version}", version)) : { released: false, detail: "无法查询 GitHub Release" };
    }
    return { soakHours: env.apps[appId]?.uatSoakHours ?? 0, uat, release, ...(override ? { override } : {}), now: this.now() };
  }

  /** The release bundle a manifest names at a version (§5.1 release-asset): downloaded once, then from disk. */
  private async bundleFor(manifest: Manifest, version: string): Promise<Bundle> {
    if (!manifest.bundle) throw new Error("清单没有 bundle");
    if (!this.bundles) throw new Error("没有配置发布包下载");
    if (!manifest.release) throw new Error("清单有 bundle 但没有 release，不知道用哪个 tag");
    const tag = manifest.release.tag.replaceAll("{version}", version);
    return this.bundles.get(manifest.bundle.repo, tag, manifest.bundle.asset.replaceAll("{version}", version), manifest.bundle.checksums ?? "SHA256SUMS");
  }

  private async stepContext(appId: string, version: string, fromVersion: string | null, component: Component, manifest: Manifest, env: Environment): Promise<StepContext> {
    const bundle = manifest.bundle ? await this.bundleFor(manifest, version) : undefined;
    return {
      app: appId, version, fromVersion, environment: env.name, component: component as StepContext["component"], manifest, bundle,
      settings: env.apps[appId]?.settings?.[component.id] ?? {},
      state: this.store.componentState(appId, component.id),
      envValue: (key) => this.envValues?.(appId)?.[key],
      log: () => {},
    };
  }

  /** For a running deploy: the exact manifest revision its plan used. */
  private async jobStepContext(job: Job, step: RolloutStep): Promise<StepContext> {
    const m = /^(.+)@(.+)#(\d+)$/.exec(job.manifest ?? "");
    const manifest = m ? this.store.manifestRevision(m[1]!, m[2]!, Number(m[3])) : covering(this.store.manifests(job.app), job.version);
    if (!manifest) throw new Error(`找不到部署用的清单 ${job.manifest}`);
    const component = manifest.components.find((c) => c.id === step.component);
    if (!component) throw new Error(`清单里没有组件 ${step.component}`);
    return this.stepContext(job.app, job.version, job.fromVersion, component, manifest, this.environment().env);
  }

  /** What the plan needs from outside: the bundle, the Deployer drivers' plans, the other apps' contracts. */
  private async outside(env: Environment, appId: string, version: string, fromVersion: string | null): Promise<Pick<PlanContext, "bundle" | "steps" | "contracts">> {
    const manifest = covering(this.store.manifests(appId), version);
    if (!manifest) return {};
    const out: Pick<PlanContext, "bundle" | "steps" | "contracts"> = {};
    if (manifest.bundle) {
      try {
        const b = await this.bundleFor(manifest, version);
        const info: BundleInfo = { repo: b.repo, tag: b.tag, asset: b.asset, digest: b.digest, checked: b.checked, files: [...b.files.keys()] };
        out.bundle = { info };
      } catch (error) { out.bundle = { error: (error as Error).message }; }
    }
    out.steps = {};
    for (const c of manifest.components.filter((x) => DEPLOYER_TYPES.has(x.type))) {
      const driver = this.drivers[c.type];
      if (!driver) continue;
      try {
        const ctx = await this.stepContext(appId, version, fromVersion, c, manifest, env);
        out.steps[c.id] = { ...(await driver.plan(ctx)), impact: driver.impact(c) };
      } catch (error) {
        out.steps[c.id] = { after: "—", findings: [{ code: `${c.type}/unavailable`, message: (error as Error).message, blocking: true }], impact: driver.impact(c) };
      }
    }
    if (this.contracts && manifest.release) {
      try {
        const doc = await this.contracts.get(manifest.release.repo, manifest.release.tag.replaceAll("{version}", version), manifest.release.manifest);
        const others: Running[] = [];
        for (const other of this.store.listApps().filter((a) => a.id !== appId)) {
          const v = env.apps[other.id]?.version;
          const m = v ? covering(this.store.manifests(other.id), v) : undefined;
          if (!v || !m?.release) continue;
          try { others.push({ app: other.id, version: v, doc: await this.contracts.get(m.release.repo, m.release.tag.replaceAll("{version}", v), m.release.manifest) }); }
          catch (error) { others.push({ app: other.id, version: v, doc: null, error: (error as Error).message }); }
        }
        out.contracts = { result: checkContracts(appId, version, doc, others) };
        const unread = others.filter((o) => o.error);
        if (unread.length) out.contracts.result!.unknown.push(...unread.map((o) => `读不到 ${o.app} ${o.version} 的契约（${o.error}）`));
      } catch (error) { out.contracts = { error: (error as Error).message }; }
    }
    return out;
  }

  async plan(principal: Principal, appId: string, version: string, pinFrom?: string, override?: { reason: string }): Promise<Plan> {
    const app = this.store.app(appId);
    if (!app) throw new DeployError(404, "app/unknown", "注册表里没有这个应用。");
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new DeployError(400, "deploy/version", `${version} 不是版本号。`);
    const { env, deployed } = this.environment();
    let pins: { from: string; digests: Record<string, string> } | undefined;
    if (pinFrom) {
      const from = this.store.job(pinFrom);
      if (!from || from.kind !== "deploy" || from.app !== appId || from.state !== "succeeded") throw new DeployError(400, "deploy/pin-from", "只能回到这个应用一次成功的部署。");
      if (from.version !== version) throw new DeployError(400, "deploy/pin-version", `部署记录 ${pinFrom} 是 ${from.version}，不是 ${version}。`);
      pins = { from: from.id, digests: from.status?.result.digests ?? {} };
    }
    if (override) {
      if (isKey(principal)) throw new DeployError(403, "auth/browser-only", "跳过晋级规则只认浏览器会话，API key 不行（§9.4）。");
      if (!principal.permissions.includes("admin")) throw new DeployError(403, "deploy/override-forbidden", "只有 Workbench 管理员能跳过晋级规则。");
      if (override.reason.trim().length < 4) throw new DeployError(400, "deploy/override-reason", "跳过晋级规则必须写明原因。");
    }
    const promotion = await this.promotionInput(env, appId, version, override ? { reason: override.reason.trim(), by: principal.id } : undefined);
    const outside = await this.outside(env, appId, version, deployed[appId] ?? null);
    return plan({
      env, app, manifests: this.manifests(), deployed, principal, executor: this.handoff.executor(),
      active: this.store.activeJobs(), built: (v) => this.store.successfulBuild(appId, v), ...(pins ? { pins } : {}),
      ...(this.envState ? { envState: this.envState(appId) } : {}), ...(promotion ? { promotion } : {}), ...outside,
    }, version);
  }

  async deploy(principal: Principal, appId: string, version: string, options: { pinFrom?: string; acknowledgeManual?: boolean; override?: { reason: string } }): Promise<Job> {
    if (isKey(principal) && isProd(this.environment().env)) throw new DeployError(403, "auth/browser-only", "PROD 的部署只认浏览器会话，API key 只能生成计划（§9.4）。");
    const p = await this.plan(principal, appId, version, options.pinFrom, options.override);
    const blocking = p.findings.filter((f) => f.blocking);
    if (blocking.length || !p.request) throw new DeployError(409, "deploy/blocked", "计划里有阻止部署的问题。", blocking.map((f) => f.message));
    const { env } = this.environment();
    const id = newJobId("deploy");
    const actor: Actor = { id: principal.id, via: principal.via };
    const host = p.request.host === true;
    const rollout: Rollout = {
      host: host ? "pending" : "none",
      steps: p.steps.map((s) => ({ component: s.component, type: s.type, where: s.where, state: "pending", ...(s.checks ? { checks: s.checks.map((text) => ({ text })) } : {}) })),
      log: [],
    };
    this.store.addJob({ id, kind: "deploy", app: appId, version, environment: env.name, fromVersion: p.fromVersion, manifest: p.manifest, pinFrom: options.pinFrom ?? null, request: p.request }, actor);
    this.store.setRollout(id, rollout);
    if (p.promotion?.basis === "override") this.store.audit(actor, "deploy.promotion-override", `${appId}@${version}`, { job: id, reason: p.promotion.reason, unmet: p.promotion.detail });
    if (host) {
      const { steps: _steps, ...request } = p.request;
      this.handoff.submit(id, { ...request, requestedBy: principal.id });
    } else {
      this.runner.advance(id).catch((error) => console.error(`rollout ${id}:`, error));
    }
    return this.store.job(id)!;
  }

  build(principal: Principal, appId: string, version: string): Job[] {
    const app = this.store.app(appId);
    if (!app) throw new DeployError(404, "app/unknown", "注册表里没有这个应用。");
    const { env } = this.environment();
    if (isProd(env)) throw new DeployError(409, "build/prod", "PROD 不构建：只部署 UAT 验证过或已正式发布的制品（§6.1）。");
    if (!principal.permissions.includes("deploy-uat")) throw new DeployError(403, "build/forbidden", "构建需要在 deploy-uat 组里。");
    const manifest = covering(this.store.manifests(appId), version);
    if (!manifest) throw new DeployError(404, "build/no-manifest", `没有适用于 ${version} 的清单。`);
    const executor = this.handoff.executor();
    if (!executor.online) throw new DeployError(409, "build/executor-offline", executor.reason ?? "执行器不在线。");
    if (this.store.activeJobs().some((j) => j.app === appId)) throw new DeployError(409, "build/busy", `${appId} 已有一个任务在进行。`);
    const requests = buildRequests(env, manifest, version);
    if (!requests.length) throw new DeployError(400, "build/nothing", "这个应用没有要由 Deployer 构建的镜像。");
    const actor: Actor = { id: principal.id, via: principal.via };
    return requests.map(({ request }) => {
      const id = newJobId("build");
      this.store.addJob({ id, kind: "build", app: appId, version, environment: env.name, fromVersion: null, manifest: manifestRef(app, manifest), pinFrom: null, request }, actor);
      this.handoff.submit(id, { ...request, requestedBy: principal.id });
      return this.store.job(id)!;
    });
  }

  /** Copies the executor's status into the job records, runs the Deployer's steps after it, and when a job ends
   *  records its artifacts and what the app reports. */
  async sync(): Promise<void> {
    for (const job of this.store.activeJobs()) {
      const rollout = job.kind === "deploy" ? job.rollout : null;
      if (rollout && rollout.host !== "pending") { await this.runner.advance(job.id); continue; }
      const status = this.handoff.status(job.id);
      if (!status) continue;
      const bundle = job.request.bundle as { digest?: string } | undefined;
      if (bundle?.digest && status.state === "succeeded") status.result = { ...status.result, digests: { ...(status.result?.digests ?? {}), bundle: bundle.digest } };
      if (rollout) {
        const final = FINAL_STATES.includes(status.state);
        for (const s of rollout.steps) {
          if (s.where === "host") s.state = !final ? "running" : status.state === "succeeded" ? "succeeded" : "failed";
          else if (final && status.state !== "succeeded") s.state = "skipped";
        }
        if (final && status.state === "succeeded" && rollout.steps.some((s) => s.where !== "host")) {
          // The containers are up; the Deployer's own steps follow (the job stays running until they end).
          rollout.host = "done";
          this.store.updateJob(job.id, { ...status, state: "running" });
          this.store.setRollout(job.id, rollout);
          await this.runner.advance(job.id);
          continue;
        }
        if (final) rollout.host = "done";
        this.store.setRollout(job.id, rollout);
      }
      if (this.store.updateJob(job.id, status)) await this.ended(this.store.job(job.id)!, status);
    }
  }

  private async ended(job: Job, status: ExecutorStatus) {
    this.recordArtifacts(job, status);
    if (job.kind === "deploy" && status.state === "succeeded") await this.observe(job);
    if (this.afterJob) await this.afterJob(job, status);
    if (job.kind === "deploy" && (status.state === "failed" || status.state === "rolled-back") && this.onFailure) await this.onFailure(job);
  }

  /** The runner ends a deploy whose last steps were the Deployer's (or people's). */
  private async finishRollout(job: Job, state: "succeeded" | "failed", message: string) {
    const status: ExecutorStatus = job.status ?? { state, steps: [], result: {} };
    const bundle = job.request.bundle as { digest?: string } | undefined;
    const digests = { ...(status.result?.digests ?? {}), ...(bundle?.digest ? { bundle: bundle.digest } : {}) };
    if (!this.store.finishJob(job.id, state, message, { ...status, result: { ...status.result, ...(Object.keys(digests).length ? { digests } : {}) } })) return;
    const done = this.store.job(job.id)!;
    await this.ended(done, done.status!);
  }

  private checkPermission(principal: Principal, job: Job | undefined): Job {
    if (!job || job.kind !== "deploy") throw new DeployError(404, "job/unknown", "没有这个部署。");
    if (!this.canDeploy(principal)) throw new DeployError(403, "deploy/forbidden", "需要有部署这个环境的权限。");
    if (isKey(principal) && isProd(this.environment().env)) throw new DeployError(403, "auth/browser-only", "PROD 的部署步骤只认浏览器会话（§9.4）。");
    return job;
  }

  /** A person ticks one item of a manual step (§4.2 manual). */
  async check(principal: Principal, jobId: string, component: string, index: number, checked: boolean): Promise<Job> {
    const job = this.checkPermission(principal, this.store.job(jobId));
    try { return await this.runner.check(job.id, component, index, checked, { id: principal.id, via: principal.via }); }
    catch (error) { if (error instanceof RolloutError) throw new DeployError(error.status, "deploy/manual", error.message); throw error; }
  }

  async stop(principal: Principal, jobId: string): Promise<Job> {
    const job = this.checkPermission(principal, this.store.job(jobId));
    try { return await this.runner.stop(job.id, { id: principal.id, via: principal.via }); }
    catch (error) { if (error instanceof RolloutError) throw new DeployError(error.status, "deploy/stop", error.message); throw error; }
  }

  /** §6.1: what a build pushed, and every image a deploy pulled, by digest. */
  private recordArtifacts(job: Job, status: ExecutorStatus) {
    const r = status.result ?? {};
    if (job.kind === "build" && status.state === "succeeded" && r.image && r.digest) {
      this.store.recordArtifact({ app: job.app, service: String(job.request.service ?? job.request.image), digest: r.digest, version: job.version, ref: repository(r.image), origin: "build", build: r.build ?? null, job: job.id });
    }
    if (job.kind !== "deploy") return;
    const images = (job.request.images ?? []) as { service: string; ref: string; pin?: string }[];
    const promotion = job.request.promotion as { basis?: string } | undefined;
    for (const im of images) {
      const digest = r.digests?.[im.service];
      if (!digest) continue;
      const origin = !im.pin ? "pulled" : promotion?.basis === "uat" ? "uat" : "pinned";
      this.store.recordArtifact({ app: job.app, service: im.service, digest, version: job.version, ref: repository(im.ref), origin, build: r.builds?.[im.service] ?? null, job: job.id });
    }
    // The release bundle is an artifact too: its sha256 is what PROD must match (§6.1).
    const bundle = job.request.bundle as { repo: string; tag: string; asset: string; digest: string } | undefined;
    if (bundle?.digest && (r.digests?.bundle || job.status?.state === "succeeded")) {
      this.store.recordArtifact({ app: job.app, service: "bundle", digest: bundle.digest, version: job.version, ref: `${bundle.repo}/releases/${bundle.tag}/${bundle.asset}`, origin: promotion?.basis === "uat" ? "uat" : job.pinFrom ? "pinned" : "pulled", build: null, job: job.id });
    }
  }

  private async observe(job: Job) {
    const manifest = covering(this.store.manifests(job.app), job.version);
    const observations: Record<string, unknown> = {};
    for (const c of manifest?.components ?? []) {
      this.observer.forget(c.service ?? "");
      const o = await this.observer.observe(c);
      if (o) observations[c.service!] = o;
    }
    this.store.setObservation(job.id, Object.keys(observations).length ? observations : { unconfirmed: "no service reports a BUILD.json" });
  }

  canDeploy(principal: Principal): boolean {
    try { return principal.permissions.includes(deployPermission(this.environment().env)); } catch { return false; }
  }
}
