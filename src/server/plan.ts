// A deploy plan (design §8.1): what deploying one app at one version would change, what stands in the
// way, and the exact request the executor would get. The page shows it, the person confirms it, and
// the deploy endpoint builds it again rather than trusting a plan the browser sends back.

import { generate, imageRef, ManifestError, type Environment, type Manifest } from "../compose/generate.ts";
import { referencedKeys } from "../env/dotenv.ts";
import { covering } from "../manifest/version.ts";
import type { Permission, Principal } from "./auth.ts";
import type { ContractResult } from "./contracts.ts";
import type { StepPlan } from "./drivers/types.ts";
import { DEPLOYER_TYPES, HOST_TYPES, hostAfterOthers, order, whereOf } from "./rollout.ts";
import type { ExecutorInfo } from "./handoff.ts";
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
  /** "在 UAT 运行满 N 小时", per app in the environment file; 0 by default (D15). */
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
  /** Digests to deploy instead of pulling by tag: an earlier deploy here ("回到这一版"). */
  pins?: { from: string; digests: Record<string, string> };
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
  if (!principal.permissions.includes(need)) block("deploy/forbidden", `部署 ${env.name.toUpperCase()} 需要在 ${need} 组里。`);
  const manifest = covering(ctx.manifests[app.id] ?? [], version);
  if (!manifest) {
    block("deploy/no-manifest", `没有适用于 ${version} 的清单：最早的清单从 ${ctx.manifests[app.id]?.[0]?.appliesFrom ?? "—"} 起。`);
    return empty;
  }
  const bundle = manifest.bundle ? ctx.bundle?.info : undefined;
  if (manifest.bundle && !bundle) block("deploy/bundle", `取不到发布包 ${manifest.bundle.asset.replaceAll("{version}", version)}：${ctx.bundle?.error ?? "没有下载"}`);
  if (bundle) note("deploy/bundle-checked", bundle.checked === null ? `发布包 ${bundle.asset} 里没有 SHA256SUMS，只记下整个包的 digest。` : `发布包 ${bundle.asset} 的 ${bundle.checked} 个文件与 SHA256SUMS 一致。`);
  const ordered = order(manifest.components);
  const late = hostAfterOthers(manifest.components);
  if (late.length) block("deploy/order", `${late.join("、")} 在宿主机上执行，但依赖 Deployer 或人工的步骤；宿主机的部分要排在最前面。`);
  const manual = ordered
    .filter((c) => c.type === "manual" && ((c as { when?: string }).when !== "install" || !fromVersion))
    .map((c) => ({ id: c.id, steps: (c as unknown as { steps: string[] }).steps }));
  if (manual.length) note("deploy/manual", "有人工步骤：部署到这一步时暂停，逐项勾选后才继续。");
  if (fromVersion === version) note("deploy/same-version", `${version} 已经在运行，这次是重新部署。`);
  const host = manifest.components.some((c) => HOST_TYPES.has(c.type));
  if (host && !executor.online) block("deploy/executor-offline", executor.reason ?? "执行器不在线。");
  for (const c of manifest.components) {
    if (!HOST_TYPES.has(c.type) && !DEPLOYER_TYPES.has(c.type) && c.type !== "manual") block("deploy/driver", `组件 ${c.id} 的类型 ${c.type} 没有驱动。`);
    for (const f of ctx.steps?.[c.id]?.findings ?? []) findings.push(f);
  }
  // §6.4: what this version requires must be provided here, and what the others require must still be.
  if (ctx.contracts?.error) note("deploy/contract-unknown", `无法核对契约：${ctx.contracts.error}`);
  for (const u of ctx.contracts?.result?.unmet ?? []) block("deploy/contract", `${u}。`);
  for (const u of ctx.contracts?.result?.unknown ?? []) note("deploy/contract-unknown", `${u}。`);
  const busy = ctx.active.find((j) => j.app === app.id);
  if (busy) block("deploy/busy", `${app.id} 已有一个${busy.kind === "build" ? "构建" : "部署"}在进行（${busy.id}）。`);

  // The env file (§7.2): every ${KEY} the new fragment needs must be set in the copy on the server.
  const envState = ctx.envState;
  if (manifest.env && envState) {
    if (!envState.managed) note("env/unmanaged", `Deployer 还没有导入 ${manifest.env.file}：部署用服务器上现有的文件，缺变量时执行器会拒绝。`);
    else {
      const missing = referencedKeys(manifest).required.filter((k) => !envState.keys.includes(k));
      if (missing.length) block("env/referenced-missing", `${version} 的 compose 片段要用 ${missing.join("、")}，服务器上的 env 文件（第 ${envState.revision} 版）没有。先在环境变量里加上并写入。`);
      if (envState.pending) note("env/pending", "环境变量有还没写入服务器的修改；这次部署用服务器上的版本（第 " + envState.revision + " 版）。");
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
      promotion = { basis: "prod-history", detail: `回到本环境部署成功过的 ${pins.from}：这些 digest 当时已经满足晋级规则。` };
    } else if (rec && ranHours >= pr.soakHours) {
      promotion = { basis: "uat", detail: `${uatName} 部署 ${rec.id} 于 ${rec.deployedAt} 成功${pr.soakHours ? `，运行了 ${Math.floor(ranHours)} 小时（要求 ${pr.soakHours}）` : ""}；按它的 digest 部署。`, uatDeployment: rec.id };
      pins = { from: `${uatName} ${rec.id}`, digests: rec.digests };
      if (bundle && rec.digests.bundle && rec.digests.bundle !== bundle.digest) block("deploy/bundle-changed", `${uatName} 部署的发布包是 ${rec.digests.bundle}，现在取到的 ${bundle.asset} 是 ${bundle.digest}：Release 附件被换过，不能当作 UAT 验证过的版本。`);
    } else if (pr.release.released) {
      promotion = { basis: "release", detail: pr.release.detail };
    } else {
      const uatWhy = !pr.uat.configured ? "没有配置 UAT 的 Deployer" : pr.uat.error ? `无法确认 ${uatName} 记录（${pr.uat.error}）`
        : rec ? `${uatName} 部署 ${rec.id} 只运行了 ${ranHours.toFixed(1)} 小时，要求 ${pr.soakHours} 小时` : `${version} 没有在 ${uatName} 部署成功过`;
      const why = `${uatWhy}；${pr.release.detail}。`;
      if (pr.override) {
        promotion = { basis: "override", detail: why, reason: pr.override.reason, by: pr.override.by };
        note("deploy/promotion-overridden", `不满足晋级规则，由 ${pr.override.by} 跳过：${pr.override.reason}（${why}）`);
      } else {
        block("deploy/not-promoted", `PROD 只部署在 UAT 部署成功过、或已正式发布的版本：${why}管理员可以填写原因跳过。`);
      }
    }
  }

  // The environment as it would be after this deploy.
  const next: Environment = { ...env, apps: { ...env.apps, [app.id]: { ...env.apps[app.id], version } } };
  const services = manifest.components.filter((c) => c.type === "compose-service");
  if (pins?.digests.bundle && bundle && pins.digests.bundle !== bundle.digest && !findings.some((f) => f.code === "deploy/bundle-changed")) block("deploy/bundle-changed", `部署记录 ${pins.from} 的发布包是 ${pins.digests.bundle}，现在取到的是 ${bundle.digest}。`);

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
    if (build && !pin && !pr && !ctx.built(version)) block("deploy/not-built", `${c.service} 的镜像要由 Deployer 构建，${version} 还没有构建成功过。先构建。`);
  }
  if (pins) {
    const missing = changes.filter((x) => !x.pin).map((x) => x.service);
    if (missing.length) block("deploy/pin-missing", `部署记录 ${pins.from} 没有 ${missing.join("、")} 的 digest，无法原样部署那一版的镜像。`);
  }

  // Root: the apps already deployed through the Deployer, plus this one when it has containers (§7.3; migration goes app by app).
  const rootApps = new Set([...Object.keys(ctx.deployed).filter((id) => id !== app.id || services.length), ...(services.length ? [app.id] : [])]);
  const forRoot = [...rootApps].flatMap((id) => {
    const v = id === app.id ? version : ctx.deployed[id]!;
    const m = covering(ctx.manifests[id] ?? [], v);
    return m ? [m] : [];
  });
  const rootEnv: Environment = { ...next, apps: Object.fromEntries([...rootApps].filter((id) => next.apps[id] || id === app.id).map((id) => [id, { ...next.apps[id], version: id === app.id ? version : ctx.deployed[id]! }])) };
  let files: Record<string, string> = {};
  try { files = generate(forRoot, rootEnv); } catch (error) {
    if (error instanceof ManifestError) block("deploy/conflict", error.message);
    else throw error;
  }
  const fragment = files[`${app.id}/compose.yaml`] ?? "";
  let previousFragment: string | null = null;
  if (fromVersion) {
    const prior = covering(ctx.manifests[app.id] ?? [], fromVersion);
    try { previousFragment = prior ? generate([prior], env)[`${app.id}/compose.yaml`] ?? null : null; } catch { previousFragment = null; }
  }

  // db-migration (§8.3): scripts from the bundle or the tag, run by the executor in the database container.
  const migrations = manifest.components.filter((c) => c.type === "db-migration").flatMap((c) => {
    const m = c as unknown as { id: string; target: string; install?: string; migrations?: string; backup?: boolean };
    const target = services.find((s) => s.id === m.target);
    if (!target) { block("deploy/migration-target", `迁移 ${m.id} 的 target ${m.target} 不是这个应用的容器组件。`); return []; }
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
      return [{ component: c.id, type: c.type, where: "host", ...(ch?.before ? { before: ch.before } : {}), after: ch ? (ch.pin ? `${ch.after} @ ${ch.pin.slice(0, 19)}…` : ch.after) : "—", impact: `${c.service} 重启，用户断开一两分钟` }];
    }
    if (c.type === "db-migration") {
      const m = migrations.find((x) => x.component === c.id);
      const n = countIn(m?.migrations ?? null);
      const i = countIn(m?.install ?? null);
      const parts = [m?.install ? `空库时执行 ${m.install}${i !== null ? `（${i} 个脚本）` : ""}` : "", m?.migrations ? `执行 ${m.migrations} 里还没执行过的迁移${n !== null ? `（共 ${n} 个）` : ""}` : ""];
      return [{ component: c.id, type: c.type, where: "host", after: parts.filter(Boolean).join("；") || "—", impact: "在数据库容器里执行，执行前备份" }];
    }
    if (c.type === "manual") {
      const m = manual.find((x) => x.id === c.id);
      return m ? [{ component: c.id, type: c.type, where: "person", after: `${m.steps.length} 项，逐项勾选后继续`, impact: "等人完成", checks: m.steps }] : [];
    }
    const sp = ctx.steps?.[c.id];
    return [{ component: c.id, type: c.type, where: whereOf(c.type), ...(sp?.before ? { before: sp.before } : {}), after: sp?.after ?? "—", impact: sp?.impact ?? "" }];
  });

  const dataDirs = services.flatMap((c) => (c.volumes ?? []).filter((v) => v.path).map((v) => ({
    path: env.apps[app.id]?.overrides?.[c.id]?.volumes?.[v.target] ?? v.path!, service: c.service!,
  })));
  const release = manifest.release;
  if (fileVolumes.length && !bundle && !release) block("deploy/files", "清单要挂载发布文件，但既没有 bundle 也没有 release。");
  const kinds = executor.heartbeat?.kinds ?? [];
  if (executor.online && fileVolumes.length && bundle && !kinds.includes("bundle")) block("deploy/executor-old", `执行器 ${executor.heartbeat?.version} 不会从发布包取文件，请先升级执行器。`);
  if (executor.online && migrations.length && !kinds.includes("db-migration")) block("deploy/executor-old", `执行器 ${executor.heartbeat?.version} 不会执行数据库迁移，请先升级执行器。`);
  const filesFrom = bundle ? { bundle: { repo: bundle.repo, tag: bundle.tag, asset: bundle.asset, sha256: bundle.digest.slice(7) } }
    : release ? { repo: release.repo, tag: release.tag.replaceAll("{version}", version) } : {};
  const request = findings.some((f) => f.blocking) ? null : {
    kind: "deploy", app: app.id, version, fromVersion, project: env.project, host,
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
  };
  return { app: app.id, version, fromVersion, manifest: manifestRef(app, manifest), changes, steps, bundle: bundle ? { asset: bundle.asset, digest: bundle.digest, checked: bundle.checked } : null, manual, findings, fragment, previousFragment, promotion, request };
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
