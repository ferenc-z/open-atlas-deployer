// A deploy plan (design §8.1): what deploying one app at one version would change, what stands in the
// way, and the exact request the executor would get. The page shows it, the person confirms it, and
// the deploy endpoint builds it again rather than trusting a plan the browser sends back.

import { generate, imageRef, ManifestError, type Environment, type Manifest } from "../compose/generate.ts";
import { referencedKeys } from "../env/dotenv.ts";
import { compareVersions, covering } from "../manifest/version.ts";
import type { Permission, Principal } from "./auth.ts";
import type { ContractResult } from "./contracts.ts";
import type { StepPlan } from "./drivers/types.ts";
import { DEPLOYER_TYPES, HOST_TYPES, hostAfterOthers, order, whereOf } from "./rollout.ts";
import { hostOf, type ExecutorInfo } from "./handoff.ts";
import { endpoint, resolveReferences } from "./ingress.ts";
import type { EnvState } from "./deploy.ts";
import type { DeployRecord, Job, RegisteredApp } from "./store.ts";

export interface Finding {
  code: string;
  message: string;
  /** Blocking findings refuse the deploy; the others are shown, and manual steps must be acknowledged. */
  blocking: boolean;
}

export interface ServiceChange { component: string; service: string; before?: string; after: string; pin?: string; build: boolean }

/** Why this deploy may go to PROD (§6.2); null outside PROD. */
export interface Promotion {
  basis: "uat" | "release" | "prod-history" | "override";
  detail: string;
  uatDeployment?: string;
  reason?: string;
  by?: string;
}

/** What the PROD Deployer found out before planning: UAT's record of this version, the release, an override. */
export interface PromotionInput {
  /** "Running in UAT for N hours", per app in the environment file; 0 by default (D15). */
  soakHours: number;
  uat: { configured: boolean; environment?: string; error?: string; record?: DeployRecord };
  release: { released: boolean; detail: string };
  override?: { reason: string; by: string };
  now: number;
}

/** One component's step, in the order the deploy runs them (§8.1): where it runs and what it changes. */
export interface PlanStep {
  component: string;
  type: string;
  where: "host" | "deployer" | "person";
  before?: string;
  after: string;
  impact: string;
  checks?: string[];
}

export interface BundleInfo { repo: string; tag: string; asset: string; digest: string; checked: number | null; files: string[] }

export interface Plan {
  app: string;
  version: string;
  fromVersion: string | null;
  manifest: string | null;
  changes: ServiceChange[];
  steps: PlanStep[];
  bundle: { asset: string; digest: string; checked: number | null } | null;
  manual: { id: string; steps: string[] }[];
  findings: Finding[];
  fragment: string;
  previousFragment: string | null;
  promotion: Promotion | null;
  request: Record<string, unknown> | null;
}

export interface PlanContext {
  /** The environment with each app's version as the Deployer last deployed it. */
  env: Environment;
  app: RegisteredApp;
  /** Current manifests per registered app. */
  manifests: Record<string, Manifest[]>;
  /** Apps the Deployer has deployed here: only their fragments are in the root file. */
  deployed: Record<string, string>;
  principal: Principal;
  executor: ExecutorInfo;
  active: Job[];
  built: (version: string) => Job | undefined;
  /** Digests to deploy instead of pulling by tag: an earlier deploy here ("go back to this version"),
   *  with the manifest revision that deploy used (D31), so later edits to the manifest do not change it. */
  pins?: { from: string; digests: Record<string, string>; manifest?: { body: Manifest; ref: string } };
  /** Set in PROD only: the promotion rule applies (§6.2). */
  promotion?: PromotionInput;
  /** Undefined while env management is off; then the env file stays as it is on the server. */
  envState?: EnvState | undefined;
  /** The release bundle (§5.1 release-asset), when the manifest has one. */
  bundle?: { info?: BundleInfo; error?: string };
  /** The Deployer drivers' own plans (workbench-app, studio-graph, oma-agent), by component id. */
  steps?: Record<string, StepPlan & { impact?: string }>;
  /** §6.4: this version's provides / requires against what the other apps run here. */
  contracts?: { result?: ContractResult; error?: string };
  /** D27: whether this version's assessment was adopted (asked only when the environment requires it). */
  evaluated?: boolean;
  /** D36: the internal CA (PEM) an administrator configured; mounted into the containers. */
  ca?: string;
  /** D36: the address this app had at its last successful deploy here, and the apps that refer to it. */
  lastUrl?: string;
  dependents?: string[];
  /** D35: the host this app ran on at its last successful deploy here. */
  lastHost?: string;
  /** D36: the recommended nginx configuration now, and the last revision saved for operations. */
  nginx?: { sha256: string; latest?: { revision: number; sha256: string } };
}

export const isProd = (env: Environment) => env.name.toLowerCase() === "prod";
export const deployPermission = (env: Environment): Permission => (isProd(env) ? "deploy-prod" : "deploy-uat");

export function manifestRef(app: RegisteredApp, m: Manifest): string {
  const revision = app.manifests.find((r) => r.appliesFrom === m.appliesFrom)?.revision ?? 0;
  return `${app.id}@${m.appliesFrom}#${revision}`;
}

export function plan(ctx: PlanContext, version: string): Plan {
  const { env, app, principal, executor } = ctx;
  const findings: Finding[] = [];
  const block = (code: string, message: string) => findings.push({ code, message, blocking: true });
  const note = (code: string, message: string) => findings.push({ code, message, blocking: false });
  const fromVersion = ctx.deployed[app.id] ?? null;
  const empty: Plan = { app: app.id, version, fromVersion, manifest: null, changes: [], steps: [], bundle: null, manual: [], findings, fragment: "", previousFragment: null, promotion: null, request: null };

  const need = deployPermission(env);
  if (!principal.permissions.includes(need)) block("deploy/forbidden", `Deploying to ${env.name.toUpperCase()} needs the ${need} group.`);
  const current = covering(ctx.manifests[app.id] ?? [], version);
  const pinned = ctx.pins?.manifest;
  const manifest = pinned?.body ?? current;
  if (!manifest) {
    block("deploy/no-manifest", `No manifest applies to ${version}: the earliest manifest starts at ${ctx.manifests[app.id]?.[0]?.appliesFrom ?? "—"}. Assess ${version} to extend the manifest to it (D32).`);
    return empty;
  }
  const ref = pinned?.ref ?? manifestRef(app, manifest);
  if (pinned && current && pinned.ref !== manifestRef(app, current)) note("deploy/pinned-manifest", `Uses manifest ${pinned.ref}, as deploy ${ctx.pins!.from} did; the current manifest for ${version} is ${manifestRef(app, current)}.`);
  const bundle = manifest.bundle ? ctx.bundle?.info : undefined;
  if (manifest.bundle && !bundle) block("deploy/bundle", `Cannot get the release bundle ${manifest.bundle.asset.replaceAll("{version}", version)}: ${ctx.bundle?.error ?? "not downloaded"}`);
  if (bundle) note("deploy/bundle-checked", bundle.checked === null ? `The release bundle ${bundle.asset} has no SHA256SUMS; only the digest of the whole bundle is recorded.` : `${bundle.checked} files in the release bundle ${bundle.asset} match SHA256SUMS.`);
  const ordered = order(manifest.components);
  const late = hostAfterOthers(manifest.components);
  if (late.length) block("deploy/order", `${late.join(", ")} run on the host but come after Deployer or manual steps; host steps must come first.`);
  const manual = ordered
    .filter((c) => c.type === "manual" && ((c as { when?: string }).when !== "install" || !fromVersion))
    .map((c) => ({ id: c.id, steps: (c as unknown as { steps: string[] }).steps }));
  if (manual.length) note("deploy/manual", "There are manual steps: the deploy pauses there and continues once every item is checked.");
  if (fromVersion === version) note("deploy/same-version", `${version} is already running; this is a redeploy.`);
  if (fromVersion && compareVersions(version, fromVersion) < 0) {
    const data = manifest.components.some((c) => c.type === "db-migration" || (c.volumes ?? []).some((v) => v.path));
    note("deploy/downgrade", `Going back from ${fromVersion} to ${version}.${data ? ` Data written by ${fromVersion} (database schema, data directories) may not work with ${version}; the data directories are backed up before the deploy.` : ""}`);
  }
  if (env.requireEvaluation && version !== manifest.appliesFrom && ctx.evaluated === false) block("deploy/not-evaluated", `${version} is newer than the manifest's starting version ${manifest.appliesFrom}, and this environment requires a version assessment first (D27): deploy once the assessment is finished and confirmed by an admin.`);
  if (app.trial) note("deploy/trial", `${app.id} is a trial deploy of onboarding assessment ${app.trial} and has not been registered by an admin yet.`);
  const host = manifest.components.some((c) => HOST_TYPES.has(c.type));
  if (host && !executor.online) block("deploy/executor-offline", executor.reason ?? "The executor is offline.");
  for (const c of manifest.components) {
    if (!HOST_TYPES.has(c.type) && !DEPLOYER_TYPES.has(c.type) && c.type !== "manual") block("deploy/driver", `Component ${c.id} has type ${c.type}, which has no driver.`);
    for (const f of ctx.steps?.[c.id]?.findings ?? []) findings.push(f);
  }
  // §6.4: what this version requires must be provided here, and what the others require must still be.
  if (ctx.contracts?.error) note("deploy/contract-unknown", `Cannot check contracts: ${ctx.contracts.error}`);
  for (const u of ctx.contracts?.result?.unmet ?? []) block("deploy/contract", `${u}.`);
  for (const u of ctx.contracts?.result?.unknown ?? []) note("deploy/contract-unknown", `${u}.`);
  const busy = ctx.active.find((j) => j.app === app.id);
  if (busy) block("deploy/busy", `${app.id} already has a ${busy.kind === "build" ? "build" : "deploy"} running (${busy.id}).`);

  // The env file (§7.2): every ${KEY} the new fragment needs must be set in the copy on the server.
  const envState = ctx.envState;
  if (manifest.env && envState) {
    if (!envState.managed) note("env/unmanaged", `The Deployer has not imported ${manifest.env.file} yet: the deploy uses the file on the server, and the executor refuses if variables are missing.`);
    else {
      const missing = referencedKeys(manifest).required.filter((k) => !envState.keys.includes(k));
      if (missing.length) block("env/referenced-missing", `The ${version} compose fragment uses ${missing.join(", ")}, which the env file on the server (revision ${envState.revision}) does not have. Add them in Environment variables and write them first.`);
      if (envState.pending) note("env/pending", "Environment variables have changes not yet written to the server; this deploy uses the version on the server (revision " + envState.revision + ").");
    }
  }

  // PROD takes only what UAT ran or what is formally released (§6.2); what UAT ran goes in by its digests.
  let pins = ctx.pins;
  let promotion: Promotion | null = null;
  const pr = ctx.promotion;
  if (pr) {
    const rec = pr.uat.record;
    const ranHours = rec ? ((rec.replacedAt ? Date.parse(rec.replacedAt) : pr.now) - Date.parse(rec.deployedAt)) / 3_600_000 : 0;
    const uatName = (pr.uat.environment ?? "uat").toUpperCase();
    if (pins) {
      promotion = { basis: "prod-history", detail: `Going back to ${pins.from}, which deployed successfully here: these digests met the promotion rule at the time.` };
    } else if (rec && ranHours >= pr.soakHours) {
      promotion = { basis: "uat", detail: `${uatName} deploy ${rec.id} succeeded at ${rec.deployedAt}${pr.soakHours ? ` and ran for ${Math.floor(ranHours)} hours (${pr.soakHours} required)` : ""}; deploying its digests.`, uatDeployment: rec.id };
      pins = { from: `${uatName} ${rec.id}`, digests: rec.digests };
      if (bundle && rec.digests.bundle && rec.digests.bundle !== bundle.digest) block("deploy/bundle-changed", `The release bundle deployed in ${uatName} was ${rec.digests.bundle}, but ${bundle.asset} is now ${bundle.digest}: the release asset was replaced, so it cannot count as the version UAT verified.`);
    } else if (pr.release.released) {
      promotion = { basis: "release", detail: pr.release.detail };
    } else {
      const uatWhy = !pr.uat.configured ? "No UAT Deployer is configured" : pr.uat.error ? `Cannot check the ${uatName} records (${pr.uat.error})`
        : rec ? `${uatName} deploy ${rec.id} ran for only ${ranHours.toFixed(1)} hours; ${pr.soakHours} hours required` : `${version} has never deployed successfully in ${uatName}`;
      const why = `${uatWhy}; ${pr.release.detail}.`;
      if (pr.override) {
        promotion = { basis: "override", detail: why, reason: pr.override.reason, by: pr.override.by };
        note("deploy/promotion-overridden", `The promotion rule is not met; skipped by ${pr.override.by}: ${pr.override.reason} (${why})`);
      } else {
        block("deploy/not-promoted", `PROD only deploys versions that deployed successfully in UAT or are officially released: ${why} An admin can skip this with a reason.`);
      }
    }
  }

  // The environment as it would be after this deploy.
  // D35: each host has its own compose project, with only the apps placed on it, its ports bound where that host says.
  const machine = hostOf(env, app.id);
  const onHost: Environment = { ...env, bindIp: env.hosts?.[machine]?.bindIp ?? env.bindIp, project: env.hosts?.[machine]?.project ?? env.project };
  const next: Environment = { ...onHost, apps: { ...env.apps, [app.id]: { ...env.apps[app.id], version } } };
  const services = manifest.components.filter((c) => c.type === "compose-service");
  if (pins?.digests.bundle && bundle && pins.digests.bundle !== bundle.digest && !findings.some((f) => f.code === "deploy/bundle-changed")) block("deploy/bundle-changed", `The release bundle of deploy ${pins.from} was ${pins.digests.bundle}, but it is now ${bundle.digest}.`);

  const changes: ServiceChange[] = [];
  for (const c of services) {
    let after: string;
    try { after = imageRef(c.source!, version, next); } catch (error) { block("deploy/registry", (error as Error).message); continue; }
    const prior = fromVersion ? covering(ctx.manifests[app.id] ?? [], fromVersion)?.components.find((x) => x.service === c.service) : undefined;
    let before: string | undefined;
    try { before = prior?.source ? imageRef(prior.source, fromVersion!, env) : undefined; } catch { before = undefined; }
    const build = c.source?.kind === "company-registry" && Boolean(c.source.build);
    const pin = pins?.digests[c.service!];
    changes.push({ component: c.id, service: c.service!, ...(before ? { before } : {}), after, ...(pin ? { pin } : {}), build });
    // PROD does not build (§6.1): its images come from UAT's digests or from the release, checked above.
    if (build && !pin && !pr && !ctx.built(version)) block("deploy/not-built", `The ${c.service} image is built by the Deployer, and ${version} has not been built successfully yet. Build it first.`);
  }
  if (pins) {
    const missing = changes.filter((x) => !x.pin).map((x) => x.service);
    if (missing.length) block("deploy/pin-missing", `Deploy ${pins.from} has no digest for ${missing.join(", ")}, so its images cannot be deployed as they were.`);
  }

  // Root: the apps already deployed through the Deployer, plus this one when it has containers (§7.3; migration goes app by app).
  const rootApps = new Set([...Object.keys(ctx.deployed).filter((id) => (id !== app.id || services.length) && hostOf(env, id) === machine), ...(services.length ? [app.id] : [])]);
  const forRoot = [...rootApps].flatMap((id) => {
    const v = id === app.id ? version : ctx.deployed[id]!;
    const m = id === app.id ? manifest : covering(ctx.manifests[id] ?? [], v);
    return m ? [m] : [];
  });
  const rootEnv: Environment = { ...next, apps: Object.fromEntries([...rootApps].filter((id) => next.apps[id] || id === app.id).map((id) => [id, { ...next.apps[id], version: id === app.id ? version : ctx.deployed[id]! }])) };
  // D36: {{app:<id>.url}} resolves to where that app is reached in this environment, whichever host it runs on.
  const lookup = (id: string) => endpoint(next, id, id === app.id ? manifest : covering(ctx.manifests[id] ?? [], next.apps[id]?.version ?? ""));
  const unresolved = new Set<string>();
  const resolve = (text: string) => { const r = resolveReferences(text, lookup); r.unresolved.forEach((u) => unresolved.add(u)); return r.text; };
  let files: Record<string, string> = {};
  try { files = generate(forRoot, rootEnv, { resolve, ca: Boolean(ctx.ca) }); } catch (error) {
    if (error instanceof ManifestError) block("deploy/conflict", error.message);
    else throw error;
  }
  const fragment = files[`${app.id}/compose.yaml`] ?? "";
  for (const u of unresolved) block("deploy/app-ref", `The compose fragment refers to another app's address that cannot be worked out: ${u}.`);
  if (ctx.lastHost && ctx.lastHost !== machine) note("deploy/host-changed", `${app.id} moves from host ${ctx.lastHost} to ${machine}. The Deployer starts it on ${machine} and leaves the containers on ${ctx.lastHost} as they are: once ${machine} is verified, stop them there by hand (docker compose down in ${app.id}/ of that host's deploy root), and copy its data directories over first if it keeps data.`);
  const own = endpoint(next, app.id, manifest);
  if (own?.problem) note("ingress/problem", `${app.id} has ingress ${own.kind}, but its address cannot be worked out: ${own.problem}.`);
  if (own?.url && ctx.lastUrl && own.url !== ctx.lastUrl) {
    note("ingress/url-changed", `${app.id} moves from ${ctx.lastUrl} to ${own.url}.${ctx.dependents?.length ? ` Apps that refer to it (${ctx.dependents.join(", ")}) need their env files rewritten and a restart after this deploy.` : ""} Addresses kept inside apps are not changed by the Deployer: update them by hand (Workbench → Administration → OMA Integration when OMA moves; the agents' MCP address and the Vault credential in OMA when the Deployer moves).`);
  }
  if (env.apps[app.id]?.ingress?.kind === "nginx" && ctx.nginx && ctx.nginx.sha256 !== ctx.nginx.latest?.sha256) {
    note("ingress/nginx-update", `The recommended nginx configuration differs from ${ctx.nginx.latest ? `revision ${ctx.nginx.latest.revision}` : "anything saved so far"}: save it as a new revision on the Ingress page and have operations apply it, or ${app.id} may not be reachable at its address.`);
  }
  let previousFragment: string | null = null;
  if (fromVersion) {
    const prior = covering(ctx.manifests[app.id] ?? [], fromVersion);
    try { previousFragment = prior ? generate([prior], onHost)[`${app.id}/compose.yaml`] ?? null : null; } catch { previousFragment = null; }
  }

  // db-migration (§8.3): scripts from the bundle or the tag, run by the executor in the database container.
  const migrations = manifest.components.filter((c) => c.type === "db-migration").flatMap((c) => {
    const m = c as unknown as { id: string; target: string; install?: string; migrations?: string; backup?: boolean };
    const target = services.find((s) => s.id === m.target);
    if (!target) { block("deploy/migration-target", `The target ${m.target} of migration ${m.id} is not a container component of this app.`); return []; }
    return [{ component: m.id, service: target.service!, install: m.install ?? null, migrations: m.migrations ?? null, backup: m.backup !== false }];
  });
  const fileVolumes = [...services.flatMap((c) => (c.volumes ?? []).filter((v) => v.file).map((v) => v.file!)),
    ...migrations.flatMap((m) => [m.install, m.migrations].filter((x): x is string => Boolean(x)))];

  // The steps in the order they run, with what each changes (§4.2 plan()).
  const countIn = (dir: string | null) => {
    if (!dir || !bundle) return null;
    const prefix = `${dir.replace(/\/+$/, "")}/`;
    return bundle.files.filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/")).length;
  };
  const steps: PlanStep[] = ordered.flatMap((c): PlanStep[] => {
    if (c.type === "compose-service") {
      const ch = changes.find((x) => x.service === c.service);
      return [{ component: c.id, type: c.type, where: "host", ...(ch?.before ? { before: ch.before } : {}), after: ch ? (ch.pin ? `${ch.after} @ ${ch.pin.slice(0, 19)}…` : ch.after) : "—", impact: `${c.service} restarts; users are disconnected for a minute or two` }];
    }
    if (c.type === "db-migration") {
      const m = migrations.find((x) => x.component === c.id);
      const n = countIn(m?.migrations ?? null);
      const i = countIn(m?.install ?? null);
      const parts = [m?.install ? `Run ${m.install} on an empty database${i !== null ? ` (${i} scripts)` : ""}` : "", m?.migrations ? `Run migrations in ${m.migrations} not yet applied${n !== null ? ` (${n} in total)` : ""}` : ""];
      return [{ component: c.id, type: c.type, where: "host", after: parts.filter(Boolean).join("; ") || "—", impact: "Runs inside the database container, after a backup" }];
    }
    if (c.type === "manual") {
      const m = manual.find((x) => x.id === c.id);
      return m ? [{ component: c.id, type: c.type, where: "person", after: `${m.steps.length} items, continue once each is checked`, impact: "Waits for a person", checks: m.steps }] : [];
    }
    const sp = ctx.steps?.[c.id];
    return [{ component: c.id, type: c.type, where: whereOf(c.type), ...(sp?.before ? { before: sp.before } : {}), after: sp?.after ?? "—", impact: sp?.impact ?? "" }];
  });

  const dataDirs = services.flatMap((c) => (c.volumes ?? []).filter((v) => v.path).map((v) => ({
    path: env.apps[app.id]?.overrides?.[c.id]?.volumes?.[v.target] ?? v.path!, service: c.service!,
  })));
  const release = manifest.release;
  if (fileVolumes.length && !bundle && !release) block("deploy/files", "The manifest mounts release files but has neither a bundle nor a release.");
  const kinds = executor.heartbeat?.kinds ?? [];
  if (executor.online && fileVolumes.length && bundle && !kinds.includes("bundle")) block("deploy/executor-old", `Executor ${executor.heartbeat?.version} cannot take files from a release bundle; upgrade the executor first.`);
  if (executor.online && migrations.length && !kinds.includes("db-migration")) block("deploy/executor-old", `Executor ${executor.heartbeat?.version} cannot run database migrations; upgrade the executor first.`);
  const filesFrom = bundle ? { bundle: { repo: bundle.repo, tag: bundle.tag, asset: bundle.asset, sha256: bundle.digest.slice(7) } }
    : release ? { repo: release.repo, tag: release.tag.replaceAll("{version}", version) } : {};
  const request = findings.some((f) => f.blocking) ? null : {
    kind: "deploy", app: app.id, version, fromVersion, project: onHost.project, host,
    ...(host ? {
      root: files["compose.yaml"], fragment,
      services: services.map((c) => c.service!),
      images: changes.map((x) => ({ service: x.service, ref: x.after, ...(x.pin ? { pin: x.pin } : {}), build: x.build })),
      files: fileVolumes.length ? { ...filesFrom, paths: [...new Set(fileVolumes)] } : null,
      dataDirs,
      ...(migrations.length ? { migrations } : {}),
    } : {}),
    ...(bundle ? { bundle: { repo: bundle.repo, tag: bundle.tag, asset: bundle.asset, digest: bundle.digest } } : {}),
    steps,
    ...(envState?.revision != null ? { envRevision: envState.revision } : {}),
    ...(promotion ? { promotion } : {}),
    ...(own?.url ? { url: own.url } : {}),
    machine,
    // The executor writes it to <app>/ca/ca.pem, which the fragment mounts.
    ...(host && ctx.ca && env.apps[app.id]?.ca !== false && services.length ? { ca: ctx.ca } : {}),
  };
  return { app: app.id, version, fromVersion, manifest: ref, changes, steps, bundle: bundle ? { asset: bundle.asset, digest: bundle.digest, checked: bundle.checked } : null, manual, findings, fragment, previousFragment, promotion, request };
}

/** The build jobs a version needs: one per own-built image (§5.2). */
export function buildRequests(env: Environment, manifest: Manifest, version: string): { service: string; request: Record<string, unknown> }[] {
  return manifest.components.flatMap((c) => {
    if (c.type !== "compose-service" || c.source?.kind !== "company-registry" || !c.source.build) return [];
    const registry = env.registries[c.source.registry];
    if (!registry) throw new ManifestError(`registry ${c.source.registry} is not registered`);
    const b = c.source.build;
    return [{ service: c.service!, request: {
      kind: "build", app: manifest.app, version, service: c.service!, registry, image: c.source.image,
      build: { repo: b.repo, tag: b.tag.replaceAll("{version}", version), script: b.script, platform: b.platform ?? "linux/amd64" },
    } }];
  });
}
