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
import { Handoff, hostIds, hostOf, newJobId } from "./handoff.ts";
import { checkUrl, endpoint, nginxConfig, references } from "./ingress.ts";
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
  /** W3 (phase 8): Workbench's maintenance notice, set before a deploy that interrupts people (§8.4). */
  maintenance?: { setMaintenance: (message: string, startsAt: number, endsAt: number) => Promise<unknown>; clearMaintenance: () => Promise<unknown> };
  /** D27 (phase 7): whether a version's assessment was adopted, or it already ran here. */
  evaluated?: (app: string, version: string) => boolean;
  /** Set when OMA is configured (phase 6, D24): a failed or rolled-back deploy is diagnosed. */
  onFailure?: (job: Job) => Promise<void>;

  private peer: Peer | undefined;
  private releases: Pick<Versions, "release"> | undefined;
  private bundles: Bundles | undefined;
  private contracts: ContractDocs | undefined;
  private drivers: Record<string, DeployDriver>;
  readonly runner: Runner;
  private now: () => number;
  private checkUrl: typeof checkUrl;

  constructor(store: Store, handoff: Handoff, observer: Observer, environmentFile: string,
    options: { peer?: Peer; releases?: Pick<Versions, "release">; bundles?: Bundles; contracts?: ContractDocs; drivers?: DeployDriver[]; now?: () => number; checkUrl?: typeof checkUrl } = {}) {
    this.store = store;
    this.checkUrl = options.checkUrl ?? checkUrl;
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
    let release = { released: false, detail: "The manifest has no release, so release status cannot be checked" };
    const services = manifest?.components.filter((c) => c.type === "compose-service" && c.source) ?? [];
    const own = services.filter((c) => c.source!.kind === "company-registry");
    const floating = services.flatMap((c) => (c.source!.kind === "public-registry" && !pinnedTag(c.source!.image) ? [c.source!.image] : []));
    if (floating.length) release = { released: false, detail: `Public images ${floating.join(", ")} have no fixed version` };
    else if (!own.length) release = { released: true, detail: "Uses only public images with fixed versions" };
    else if (manifest?.release) {
      release = this.releases ? await this.releases.release(manifest.release.repo, manifest.release.tag.replaceAll("{version}", version)) : { released: false, detail: "Cannot query GitHub Releases" };
    }
    return { soakHours: env.apps[appId]?.uatSoakHours ?? 0, uat, release, ...(override ? { override } : {}), now: this.now() };
  }

  /** The release bundle a manifest names at a version (§5.1 release-asset): downloaded once, then from disk. */
  private async bundleFor(manifest: Manifest, version: string): Promise<Bundle> {
    if (!manifest.bundle) throw new Error("The manifest has no bundle");
    if (!this.bundles) throw new Error("Release bundle downloads are not configured");
    if (!manifest.release) throw new Error("The manifest has a bundle but no release, so the tag is unknown");
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
    const manifest = this.jobManifest(job);
    if (!manifest) throw new Error(`Cannot find the manifest for the deploy: ${job.manifest}`);
    const component = manifest.components.find((c) => c.id === step.component);
    if (!component) throw new Error(`The manifest has no component ${step.component}`);
    return this.stepContext(job.app, job.version, job.fromVersion, component, manifest, this.environment().env);
  }

  /** The manifest revision a job recorded (app@appliesFrom#revision); revisions are never deleted (D31). */
  private jobManifest(job: Job): Manifest | undefined {
    const m = /^(.+)@(.+)#(\d+)$/.exec(job.manifest ?? "");
    return m ? this.store.manifestRevision(m[1]!, m[2]!, Number(m[3])) : covering(this.store.manifests(job.app), job.version);
  }

  /** What the plan needs from outside: the bundle, the Deployer drivers' plans, the other apps' contracts. */
  private async outside(env: Environment, appId: string, version: string, fromVersion: string | null, pinned?: Manifest): Promise<Pick<PlanContext, "bundle" | "steps" | "contracts">> {
    const manifest = pinned ?? covering(this.store.manifests(appId), version);
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
        if (unread.length) out.contracts.result!.unknown.push(...unread.map((o) => `Cannot read the contracts of ${o.app} ${o.version} (${o.error})`));
      } catch (error) { out.contracts = { error: (error as Error).message }; }
    }
    return out;
  }

  async plan(principal: Principal, appId: string, version: string, pinFrom?: string, override?: { reason: string }): Promise<Plan> {
    const app = this.store.app(appId);
    if (!app) throw new DeployError(404, "app/unknown", "This app is not in the registry.");
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new DeployError(400, "deploy/version", `${version} is not a version.`);
    const { env, deployed } = this.environment();
    let pins: PlanContext["pins"];
    if (pinFrom) {
      const from = this.store.job(pinFrom);
      if (!from || from.kind !== "deploy" || from.app !== appId || from.state !== "succeeded") throw new DeployError(400, "deploy/pin-from", "You can only go back to a successful deploy of this app.");
      if (from.version !== version) throw new DeployError(400, "deploy/pin-version", `Deploy ${pinFrom} is ${from.version}, not ${version}.`);
      // D31: going back uses the manifest revision that deploy ran with, not whatever the manifest says now.
      const body = from.manifest ? this.jobManifest(from) : undefined;
      pins = { from: from.id, digests: from.status?.result.digests ?? {}, ...(body ? { manifest: { body, ref: from.manifest! } } : {}) };
    }
    if (override) {
      if (isKey(principal)) throw new DeployError(403, "auth/browser-only", "Skipping the promotion rule accepts only browser sessions, not API keys (§9.4).");
      if (!principal.permissions.includes("admin")) throw new DeployError(403, "deploy/override-forbidden", "Only Workbench admins can skip the promotion rule.");
      if (override.reason.trim().length < 4) throw new DeployError(400, "deploy/override-reason", "Skipping the promotion rule needs a reason.");
    }
    const promotion = await this.promotionInput(env, appId, version, override ? { reason: override.reason.trim(), by: principal.id } : undefined);
    const outside = await this.outside(env, appId, version, deployed[appId] ?? null, pins?.manifest?.body);
    return plan({
      env, app, manifests: this.manifests(), deployed, principal, executor: this.handoff.executor(hostOf(env, appId)),
      active: this.store.activeJobs(), built: (v) => this.store.successfulBuild(appId, v), ...(pins ? { pins } : {}),
      ...(this.envState ? { envState: this.envState(appId) } : {}), ...(promotion ? { promotion } : {}), ...outside,
      ...(env.requireEvaluation ? { evaluated: Boolean(this.evaluated?.(appId, version)) || this.store.deployRecords(appId, version).length > 0 } : {}),
      ...this.ingressContext(env, appId, version),
    }, version);
  }

  async deploy(principal: Principal, appId: string, version: string, options: { pinFrom?: string; acknowledgeManual?: boolean; override?: { reason: string }; notice?: { minutes: number } }): Promise<Job> {
    if (isKey(principal) && isProd(this.environment().env)) throw new DeployError(403, "auth/browser-only", "PROD deploys accept only browser sessions; API keys can only create plans (§9.4).");
    const p = await this.plan(principal, appId, version, options.pinFrom, options.override);
    const blocking = p.findings.filter((f) => f.blocking);
    if (blocking.length || !p.request) throw new DeployError(409, "deploy/blocked", "The plan has problems that block the deploy.", blocking.map((f) => f.message));
    const { env } = this.environment();
    const id = newJobId("deploy");
    const actor: Actor = { id: principal.id, via: principal.via };
    const host = p.request.host === true;
    const rollout: Rollout = {
      host: host ? "pending" : "none",
      steps: p.steps.map((s) => ({ component: s.component, type: s.type, where: s.where, state: "pending", ...(s.checks ? { checks: s.checks.map((text) => ({ text })) } : {}) })),
      log: [],
    };
    if (options.notice) {
      const minutes = options.notice.minutes;
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) throw new DeployError(400, "deploy/notice", "Advance notice is 1 to 60 minutes.");
      if (!host) throw new DeployError(409, "deploy/notice-needless", "This deploy restarts no containers, so no advance notice is needed.");
      if (!this.maintenance) throw new DeployError(409, "deploy/notice-unavailable", "No Workbench API key is configured, so the maintenance notice cannot be sent.");
      const at = this.now() + minutes * 60_000;
      const hhmm = new Date(at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
      try { await this.maintenance.setMaintenance(`${this.store.app(appId)?.name ?? appId} will update to ${version} at ${hhmm} and be unavailable for about 1–2 minutes`, this.now(), at + 15 * 60_000); }
      catch (error) { throw new DeployError(409, "deploy/notice-failed", `The maintenance notice was not sent, so the deploy did not start: ${(error as Error).message}`); }
      rollout.scheduled = { at: new Date(at).toISOString(), submitted: false };
      rollout.notice = true;
    }
    this.store.addJob({ id, kind: "deploy", app: appId, version, environment: env.name, fromVersion: p.fromVersion, manifest: p.manifest, pinFrom: options.pinFrom ?? null, request: p.request }, actor);
    this.store.setRollout(id, rollout);
    if (rollout.scheduled) {
      this.store.audit(actor, "deploy.scheduled", `${appId}@${version}`, { job: id, at: rollout.scheduled.at });
      return this.store.job(id)!;
    }
    if (p.promotion?.basis === "override") this.store.audit(actor, "deploy.promotion-override", `${appId}@${version}`, { job: id, reason: p.promotion.reason, unmet: p.promotion.detail });
    if (host) {
      const { steps: _steps, ...request } = p.request;
      this.handoff.submit(id, { ...request, requestedBy: principal.id }, hostOf(env, appId));
    } else {
      this.runner.advance(id).catch((error) => console.error(`rollout ${id}:`, error));
    }
    return this.store.job(id)!;
  }

  build(principal: Principal, appId: string, version: string): Job[] {
    const app = this.store.app(appId);
    if (!app) throw new DeployError(404, "app/unknown", "This app is not in the registry.");
    const { env } = this.environment();
    if (isProd(env)) throw new DeployError(409, "build/prod", "PROD does not build: it only deploys artifacts verified in UAT or officially released (§6.1).");
    if (!principal.permissions.includes("deploy-uat")) throw new DeployError(403, "build/forbidden", "Building needs the deploy-uat group.");
    const manifest = covering(this.store.manifests(appId), version);
    if (!manifest) throw new DeployError(404, "build/no-manifest", `No manifest applies to ${version}.`);
    const executor = this.handoff.executor(hostOf(env, appId));
    if (!executor.online) throw new DeployError(409, "build/executor-offline", executor.reason ?? "The executor is offline.");
    if (this.store.activeJobs().some((j) => j.app === appId)) throw new DeployError(409, "build/busy", `${appId} already has a job running.`);
    const requests = buildRequests(env, manifest, version);
    if (!requests.length) throw new DeployError(400, "build/nothing", "This app has no images built by the Deployer.");
    const actor: Actor = { id: principal.id, via: principal.via };
    return requests.map(({ request }) => {
      const id = newJobId("build");
      this.store.addJob({ id, kind: "build", app: appId, version, environment: env.name, fromVersion: null, manifest: manifestRef(app, manifest), pinFrom: null, request }, actor);
      this.handoff.submit(id, { ...request, requestedBy: principal.id }, hostOf(env, appId));
      return this.store.job(id)!;
    });
  }

  /** Copies the executor's status into the job records, runs the Deployer's steps after it, and when a job ends
   *  records its artifacts and what the app reports. */
  async sync(): Promise<void> {
    for (const job of this.store.activeJobs()) {
      const rollout = job.kind === "deploy" ? job.rollout : null;
      // An announced deploy waits for its time, then goes out as any other (§8.4).
      if (rollout?.scheduled && !rollout.scheduled.submitted) {
        if (this.now() < Date.parse(rollout.scheduled.at)) continue;
        rollout.scheduled.submitted = true;
        this.store.setRollout(job.id, rollout);
        if (rollout.host === "pending") {
          const { steps: _steps, ...request } = job.request;
          this.handoff.submit(job.id, { ...request, requestedBy: job.requestedBy }, hostOf(this.environment().env, job.app));
        } else await this.runner.advance(job.id);
        continue;
      }
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
    if (job.rollout?.notice && this.maintenance) await this.maintenance.clearMaintenance().catch((error) => console.error(`maintenance notice of ${job.id}:`, error));
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
    if (!job || job.kind !== "deploy") throw new DeployError(404, "job/unknown", "No such deploy.");
    if (!this.canDeploy(principal)) throw new DeployError(403, "deploy/forbidden", "Needs permission to deploy to this environment.");
    if (isKey(principal) && isProd(this.environment().env)) throw new DeployError(403, "auth/browser-only", "PROD deploy steps accept only browser sessions (§9.4).");
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
    // An announced deploy not started yet is cancelled, and its notice cleared.
    if (job.rollout?.scheduled && !job.rollout.scheduled.submitted && FINAL_STATES.every((s) => s !== job.state)) {
      for (const s of job.rollout.steps) s.state = "skipped";
      this.store.setRollout(job.id, job.rollout);
      this.store.audit({ id: principal.id, via: principal.via }, "deploy.cancel", `${job.app}@${job.version}`, { job: job.id });
      await this.finishRollout(this.store.job(job.id)!, "failed", `The deploy scheduled for ${job.rollout.scheduled.at} was cancelled by ${principal.id} before it started`);
      return this.store.job(job.id)!;
    }
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
    const manifest = this.jobManifest(job);
    const observations: Record<string, unknown> = {};
    for (const c of manifest?.components ?? []) {
      this.observer.forget(c.service ?? "");
      const o = await this.observer.observe(c);
      if (o) observations[c.service!] = o;
    }
    // D36: reach the app once at its address, through nginx when it has one; a failure only warns (owner 2026-10-31).
    const url = typeof job.request.url === "string" ? job.request.url : undefined;
    const ingress = url ? { ...(await this.checkUrl(url, this.store.setting("ca.pem"))), at: new Date(this.now()).toISOString() } : undefined;
    this.store.setObservation(job.id, { ...(Object.keys(observations).length ? observations : { unconfirmed: "no service reports a BUILD.json" }), ...(ingress ? { ingress } : {}) });
    if (ingress && !ingress.ok) this.store.audit({ id: "deployer", via: "cli" }, "deploy.ingress-unreachable", `${job.app}@${job.version}`, { job: job.id, url, ...(ingress.status ? { status: ingress.status } : {}), ...(ingress.error ? { error: ingress.error } : {}) });
  }

  /** D36: the recommended nginx configuration, each app at the version given (the version deployed otherwise). */
  nginx(at: Record<string, string> = {}): ReturnType<typeof nginxConfig> {
    const { env } = this.environment();
    const apps = Object.fromEntries(Object.entries(env.apps).map(([id, a]) => [id, { ...a, version: at[id] ?? a.version }]));
    return nginxConfig({ ...env, apps }, Object.fromEntries(Object.keys(apps).map((id) => [id, covering(this.store.manifests(id), apps[id]!.version)])));
  }

  /** D36: where an app is reached in this environment (at the version it is deployed). */
  endpointOf(appId: string) {
    const { env } = this.environment();
    return endpoint(env, appId, covering(this.store.manifests(appId), env.apps[appId]?.version ?? ""));
  }

  /** D36: other apps whose compose environment or env file refers to this app's address. */
  dependents(appId: string): string[] {
    const { env } = this.environment();
    const needle = (text: string) => references(text).some((r) => r.app === appId);
    return Object.keys(env.apps).filter((id) => id !== appId).filter((id) => {
      const m = covering(this.store.manifests(id), env.apps[id]!.version);
      if (m?.components.some((c) => Object.values(c.environment ?? {}).some(needle))) return true;
      const revision = this.store.envRevision(id);
      return Object.values(revision?.values ?? {}).some((v) => "v" in v && needle(v.v));
    });
  }

  private ingressContext(env: Environment, appId: string, version: string): Pick<PlanContext, "ca" | "lastUrl" | "dependents" | "nginx" | "lastHost"> {
    const ca = this.store.setting("ca.pem");
    const lastJob = this.store.deployedVersion(appId);
    const last = lastJob?.request.url;
    const lastHost = lastJob?.request.machine;
    const latest = this.store.nginxRevision();
    return {
      ...(ca ? { ca } : {}),
      ...(typeof last === "string" ? { lastUrl: last, dependents: this.dependents(appId) } : {}),
      // Deploys from before D35 ran on the one host there was: the first.
      ...(lastJob ? { lastHost: typeof lastHost === "string" ? lastHost : hostIds(env)[0]! } : {}),
      ...(env.apps[appId]?.ingress?.kind === "nginx" ? { nginx: { sha256: this.nginx({ [appId]: version }).sha256, ...(latest ? { latest: { revision: latest.revision, sha256: latest.sha256 } } : {}) } } : {}),
    };
  }

  canDeploy(principal: Principal): boolean {
    try { return principal.permissions.includes(deployPermission(this.environment().env)); } catch { return false; }
  }
}
