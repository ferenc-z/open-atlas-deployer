// The first setup (§15, D41): which of the steps up to L2 are done, worked out on every call from what is actually
// there (no progress is stored), so each step can be redone and steps done by hand are recognised. Workbench is the
// first app; setup is complete once the Deployer runs Workbench, Workbench answers, the Deployer's Workbench API key
// works and the deploy Groups exist.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Environment } from "../compose/generate.ts";
import { compareVersions } from "../manifest/version.ts";
import { validateManifest } from "../manifest/validate.ts";
import type { Principal } from "./auth.ts";
import type { Deployments } from "./deploy.ts";
import type { WorkbenchAdmin, WorkbenchGroup } from "./drivers/workbench.ts";
import type { EnvManager } from "./env.ts";
import { validateEnvironment, type EnvironmentFinding } from "./environment.ts";
import { hostIds } from "./handoff.ts";
import { isProd } from "./plan.ts";
import type { Store } from "./store.ts";
import type { WorkbenchKey } from "./workbench-key.ts";

export const WORKBENCH = "workbench";
/** The oldest Workbench a new installation starts with: 1.25.1 starts on an empty database (§15.6 ⑥). */
export const WORKBENCH_MIN_VERSION = "1.25.1";
/** The oldest Workbench the Deployer takes over (§15.6 ⑤): W1 (groups in the session) came with 1.24.0. */
export const TAKEOVER_MIN_VERSION = "1.24.0";
export const DEPLOY_GROUPS: [string, string][] = [
  ["deploy-viewer", "Sees the Open Atlas Deployer"],
  ["deploy-uat", "Deploys to UAT with the Open Atlas Deployer"],
  ["deploy-prod", "Deploys to PROD with the Open Atlas Deployer"],
];

export type StepState = "done" | "next" | "waiting" | "blocked";
export interface SetupStep {
  id: string; state: StepState; title: string; detail: string;
  /** Not needed for setup to be complete (shown, counted apart). */
  optional?: boolean;
  hosts?: { id: string; online: boolean; reason?: string; tokens: number }[];
  /** workbench-deploy: a new Workbench (env to generate) or one to take over (env to import first). */
  workbench?: { takeover: boolean; running?: string; version: string; envRevisions: number; envWritten: boolean; job?: { id: string; kind: string; state: string }; nginx?: { saved: number | null; changed: boolean } };
  key?: { source: "file" | "page" | null; canSet: boolean; reason?: string };
  missingGroups?: string[];
}
export interface SetupStatus {
  complete: boolean;
  /** §15.2: L0 the page opens, L1 apps can be deployed, L2 people sign in with Workbench. */
  level: "L0" | "L1" | "L2";
  environment: { name: string; prod: boolean } | null;
  steps: SetupStep[];
  canAct: boolean;
}

export interface SetupContext {
  store: Store;
  deployments: Deployments;
  env: EnvManager;
  workbench: WorkbenchAdmin;
  workbenchKey: WorkbenchKey;
  workbenchUrl: string;
  workbenchReachable: () => Promise<boolean>;
  basePath: string;
  initialManifestsDir: string;
}

const settingsOf = (d: Deployments): { env?: Environment; revision?: number; error?: string } => {
  try { const s = d.settings(); return { env: s.environment, revision: s.revision }; } catch (error) {
    return { error: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : (error as Error).message };
  }
};

const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export async function setupStatus(ctx: SetupContext, principal: Principal): Promise<SetupStatus> {
  const { store, deployments } = ctx;
  const steps: SetupStep[] = [];
  const settings = settingsOf(deployments);
  const env = settings.env;
  const prod = env ? isProd(env) : false;

  steps.push(env
    ? { id: "environment", state: "done", title: "Environment settings", detail: `Revision ${settings.revision}: ${env.name}, project ${env.project}${env.domain ? `, ${env.domain}` : ""}.` }
    : settings.error === "missing"
      ? { id: "environment", state: "next", title: "Environment settings", detail: "Name this environment, its compose project, domain, image registry and hosts. Saving makes revision 1." }
      : { id: "environment", state: "blocked", title: "Environment settings", detail: `The environment file cannot be read: ${settings.error}. Fix or remove it on the server.` });

  const hosts = env ? hostIds(env).map((id) => {
    const e = deployments.handoff.executor(id);
    return { id, online: e.online, ...(e.reason ? { reason: e.reason } : {}), tokens: store.executorTokens().filter((t) => t.host === id && !t.revokedAt).length };
  }) : [];
  const offline = hosts.filter((h) => !h.online);
  steps.push(!env
    ? { id: "executor", state: "waiting", title: "Executors", detail: "Waits for the environment settings, which name the hosts." }
    : !offline.length
      ? { id: "executor", state: "done", title: "Executors", detail: `${hosts.map((h) => h.id).join(", ")} ${hosts.length > 1 ? "are" : "is"} online.`, hosts }
      : { id: "executor", state: "next", title: "Executors", detail: `Issue a token for ${offline.map((h) => h.id).join(", ")}, put it in the executor's EXECUTOR_TOKEN_FILE and restart the executor. On the host that runs the Deployer also set EXECUTOR_DEPLOYER_DIR and EXECUTOR_DEPLOYER_IMAGE.`, hosts });

  const registered = Boolean(store.app(WORKBENCH));
  const ranges = store.manifests(WORKBENCH).length;
  steps.push(registered
    ? { id: "workbench-manifest", state: "done", title: "Workbench manifest", detail: `Workbench is in the registry (${ranges} range${ranges > 1 ? "s" : ""}).` }
    : !env
      ? { id: "workbench-manifest", state: "waiting", title: "Workbench manifest", detail: "Waits for the environment settings." }
      : prod
        ? { id: "workbench-manifest", state: "next", title: "Workbench manifest", detail: "PROD takes its manifests from UAT: set DEPLOYER_UAT_URL and DEPLOYER_UAT_KEY_FILE, then take the registry from UAT." }
        : { id: "workbench-manifest", state: "next", title: "Workbench manifest", detail: `Import the Workbench manifest this Deployer ships (from ${WORKBENCH_MIN_VERSION}, image from the ghcr registry). Other apps are registered later.` });

  // Step 4: a new Workbench is deployed; one that runs already is taken over by deploying it once (§15.6 ⑤).
  const reachable = await ctx.workbenchReachable();
  const deployed = store.deployedVersion(WORKBENCH)?.version;
  const wbEnv = registered ? ctx.env.latestValues(WORKBENCH) : undefined;
  // A job of Workbench still queued or running (the env read queued with the generated env, a write, a deploy) stays on the page after a reload.
  const active = store.activeJobs().find((j) => j.app === WORKBENCH);
  // Workbench behind nginx: people reach it only once operations apply the recommended configuration, saved here as a
  // revision (D36); the Ingress page is not open until setup is complete.
  const behindNginx = registered && env?.apps[WORKBENCH]?.ingress?.kind === "nginx";
  const latestNginx = behindNginx ? store.nginxRevision() : undefined;
  const nginx = behindNginx ? { saved: latestNginx?.revision ?? null, changed: latestNginx?.sha256 !== deployments.nginx().sha256 } : undefined;
  const envInfo = {
    envRevisions: wbEnv?.revision ?? 0, envWritten: Boolean(wbEnv && wbEnv.applied === wbEnv.revision),
    ...(active ? { job: { id: active.id, kind: active.kind, state: active.state } } : {}), ...(nginx ? { nginx } : {}),
  };
  const planned = env?.apps[WORKBENCH]?.version ?? WORKBENCH_MIN_VERSION;
  const nginxNote = nginx?.changed ? " Save the recommended nginx configuration too and hand it to operations: people reach Workbench through nginx." : "";
  const ready = registered && !offline.length && Boolean(env);
  if (reachable && deployed) {
    steps.push({ id: "workbench-deploy", state: "done", title: "Deploy Workbench", detail: `Workbench ${deployed} runs, deployed by this Deployer, and answers at ${ctx.workbenchUrl}.` });
  } else if (reachable) {
    const running = await ctx.workbench.version();
    const version = running && VERSION.test(running) && compareVersions(running, WORKBENCH_MIN_VERSION) >= 0 ? running : WORKBENCH_MIN_VERSION;
    const workbench = { takeover: true, ...(running ? { running } : {}), version, ...envInfo };
    const old = !running || !VERSION.test(running) || compareVersions(running, TAKEOVER_MIN_VERSION) < 0;
    steps.push(old
      ? { id: "workbench-deploy", state: "blocked", title: "Take over Workbench", detail: `Workbench answers at ${ctx.workbenchUrl} but ${running ? `runs ${running}` : "does not say its version"}; the Deployer takes over ${TAKEOVER_MIN_VERSION} or newer. Upgrade it by hand first.`, workbench }
      : !ready
        ? { id: "workbench-deploy", state: "waiting", title: "Take over Workbench", detail: `Workbench ${running} runs but was not deployed by this Deployer. Taking it over waits for the executors and the Workbench manifest.`, workbench }
        : { id: "workbench-deploy", state: "next", title: "Take over Workbench", detail: `Workbench ${running} runs but was not deployed by this Deployer. Import its env file from the server, then deploy ${compareVersions(running, WORKBENCH_MIN_VERSION) < 0 ? WORKBENCH_MIN_VERSION : running} or newer: Workbench restarts once, and the old compose root is kept as compose.yaml.before-deployer.${nginxNote}`, workbench });
  } else if (deployed) {
    steps.push({ id: "workbench-deploy", state: "blocked", title: "Deploy Workbench", detail: `Workbench ${deployed} was deployed but ${ctx.workbenchUrl}/health does not answer: check the container and DEPLOYER_WORKBENCH_URL.` });
  } else {
    const workbench = { takeover: false, version: planned, ...envInfo };
    steps.push(!ready
      ? { id: "workbench-deploy", state: "waiting", title: "Deploy Workbench", detail: "Waits for the executors and the Workbench manifest.", workbench }
      : { id: "workbench-deploy", state: "next", title: "Deploy Workbench", detail: `${envInfo.envRevisions ? "Write Workbench's environment variables to the server" : "Generate Workbench's environment variables (the initial admin's password is shown once)"}, then deploy ${WORKBENCH_MIN_VERSION} or newer. Once Workbench answers, this emergency sign-in stops working: keep the initial admin's password at hand.${nginxNote}`, workbench });
  }

  const admin = principal.via === "workbench" && principal.permissions.includes("admin");
  steps.push(admin
    ? { id: "workbench-signin", state: "done", title: "Sign in with Workbench", detail: `${principal.id} is a Workbench admin.` }
    : reachable
      ? { id: "workbench-signin", state: "next", title: "Sign in with Workbench", detail: "Sign in to Workbench as an admin (the initial admin on a new Workbench), then open the Deployer again." }
      : { id: "workbench-signin", state: "waiting", title: "Sign in with Workbench", detail: "Waits for Workbench." });

  // Step 6–7: the key is checked by using it; the same call lists the Groups.
  const source = ctx.workbenchKey.source();
  const canSet = ctx.workbenchKey.canSet();
  const key = { source, canSet: canSet.ok, ...(!canSet.ok ? { reason: canSet.reason } : {}) };
  let groups: WorkbenchGroup[] | undefined;
  let refused = "";
  if (source && reachable) { try { groups = await ctx.workbench.groups(); } catch (error) { refused = (error as Error).message; } }
  steps.push(!reachable
    ? { id: "workbench-key", state: "waiting", title: "Workbench API key", detail: "Waits for Workbench.", key }
    : !source
      ? { id: "workbench-key", state: "next", title: "Workbench API key", detail: canSet.ok ? "Create a key in Workbench Administration → API keys and paste it here; it is kept sealed and used at once." : canSet.reason, key }
      : refused
        ? { id: "workbench-key", state: "blocked", title: "Workbench API key", detail: `The key ${source === "file" ? "in DEPLOYER_WORKBENCH_API_KEY_FILE" : "pasted here"} does not work: ${refused}`, key }
        : { id: "workbench-key", state: "done", title: "Workbench API key", detail: `The Deployer's key works (${source === "file" ? "from DEPLOYER_WORKBENCH_API_KEY_FILE" : "pasted on this page, kept sealed"}).`, key });

  const missingGroups = groups ? DEPLOY_GROUPS.map(([g]) => g).filter((g) => !groups!.some((x) => x.name === g && x.enabled !== false)) : undefined;
  steps.push(!groups
    ? { id: "workbench-groups", state: "waiting", title: "Deploy groups", detail: "Waits for a working Workbench API key." }
    : missingGroups!.length
      ? { id: "workbench-groups", state: "next", title: "Deploy groups", detail: `Workbench has no ${missingGroups!.join(", ")} group. Create ${missingGroups!.length > 1 ? "them" : "it"} here, then add people in Workbench Administration → Groups.`, missingGroups }
      : { id: "workbench-groups", state: "done", title: "Deploy groups", detail: "deploy-viewer, deploy-uat and deploy-prod exist in Workbench; members are managed there." });

  // Step 8 (optional): the Deployer in Workbench's app menu, which Workbench reads from WORKBENCH_APP_LINKS in its env.
  const links = wbEnv ? appLinks(wbEnv.values.WORKBENCH_APP_LINKS) : undefined;
  const linked = links?.some((l) => { try { return new URL(l.url, "https://x").pathname.replace(/\/+$/, "") === (ctx.basePath || "/").replace(/\/+$/, ""); } catch { return false; } });
  steps.push(!wbEnv
    ? { id: "workbench-applinks", state: "waiting", optional: true, title: "Deployer in Workbench's app menu", detail: "Waits until the Deployer keeps Workbench's environment variables." }
    : !linked
      ? { id: "workbench-applinks", state: "next", optional: true, title: "Deployer in Workbench's app menu", detail: "WORKBENCH_APP_LINKS in Workbench's environment variables has no link to the Deployer. Add it here, then write the variables to the server (Workbench restarts)." }
      : wbEnv.applied !== wbEnv.revision
        ? { id: "workbench-applinks", state: "next", optional: true, title: "Deployer in Workbench's app menu", detail: `WORKBENCH_APP_LINKS links the Deployer in revision ${wbEnv.revision}, which is not on the server yet: write Workbench's environment variables.` }
        : { id: "workbench-applinks", state: "done", optional: true, title: "Deployer in Workbench's app menu", detail: "WORKBENCH_APP_LINKS links the Deployer." });

  // The highest level reached: once Workbench and its key are there, an executor that is offline for a while is a
  // problem of its own (Hosts, Overview), not a reason to go back to setup.
  const l2 = Boolean(env) && reachable && Boolean(deployed) && Boolean(groups) && missingGroups?.length === 0;
  const level = l2 ? "L2" : env && !offline.length ? "L1" : "L0";
  return { complete: l2, level, environment: env ? { name: env.name, prod } : null, steps, canAct: principal.permissions.includes("admin") };
}

/** WORKBENCH_APP_LINKS as Workbench reads it: a JSON array of {id,label,url}, or "Label=url,Label=url". */
export function appLinks(raw: string | undefined): { id: string; label: string; url: string }[] {
  const text = raw?.trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    try { const list = JSON.parse(text) as unknown; return Array.isArray(list) ? list.filter((l) => l && typeof l === "object" && typeof l.url === "string") : []; } catch { return []; }
  }
  return text.split(",").flatMap((part) => {
    const at = part.indexOf("=");
    if (at <= 0) return [];
    const label = part.slice(0, at).trim();
    return [{ id: label.toLowerCase(), label, url: part.slice(at + 1).trim() }];
  });
}

/** WORKBENCH_APP_LINKS with the Deployer added (kept in the JSON form, other links untouched). */
export function withDeployerLink(raw: string | undefined, url: string): string {
  const links = appLinks(raw).filter((l) => l.id !== "deployer");
  return JSON.stringify([...links, { id: "deployer", label: "Deployer", url }]);
}

/** §15.4 step 4: a new Workbench's environment variables. The initial admin's password is generated here and returned
 *  once; the Deployer keeps it sealed like every secret. WORKBENCH_PUBLIC_URL follows Workbench's address (D36). */
export function newWorkbenchEnv(adminEmail: string, deployerUrl: string | undefined, https: boolean): { values: Record<string, string>; password: string } {
  const password = randomBytes(18).toString("base64url");
  return {
    password,
    values: {
      WORKBENCH_PUBLIC_URL: "{{app:workbench.url}}",
      WORKBENCH_SECURE_COOKIES: https ? "true" : "false",
      WORKBENCH_HTTPS: "off",
      WORKBENCH_PLUGINS_FILE: "/data/workbench/plugins.json",
      WORKBENCH_ENTERPRISE: "on",
      WORKBENCH_AUTH_MODE: "local",
      WORKBENCH_BOOTSTRAP_EMAIL: adminEmail,
      WORKBENCH_BOOTSTRAP_PASSWORD: password,
      ...(deployerUrl ? { WORKBENCH_APP_LINKS: withDeployerLink(undefined, deployerUrl) } : {}),
    },
  };
}

/** The first environment settings, made from the Setup page's form (§15.4 step 1) instead of a hand-written file. */
export interface SetupEnvironmentForm {
  name?: unknown; project?: unknown; domain?: unknown; bindIp?: unknown;
  registry?: unknown; workbenchPort?: unknown; certificate?: unknown; certificateKey?: unknown;
  hosts?: unknown;
}

export function environmentFromForm(form: SetupEnvironmentForm): { environment: Environment; findings: EnvironmentFinding[] } {
  const text = (v: unknown) => typeof v === "string" ? v.trim() : "";
  const domain = text(form.domain);
  const port = form.workbenchPort === undefined || form.workbenchPort === "" ? 8443 : Number(form.workbenchPort);
  const hosts = Array.isArray(form.hosts)
    ? Object.fromEntries((form.hosts as { id?: unknown; address?: unknown }[]).filter((h) => text(h?.id)).map((h) => [text(h.id), { address: text(h.address) }]))
    : {};
  const environment = {
    name: text(form.name),
    project: text(form.project),
    bindIp: text(form.bindIp) || "127.0.0.1",
    registries: { ghcr: text(form.registry) || "ghcr.io/ferenc-z" },
    ...(domain ? { domain } : {}),
    ...(text(form.certificate) || text(form.certificateKey) ? { nginx: { certificate: text(form.certificate), certificateKey: text(form.certificateKey) } } : {}),
    ...(Object.keys(hosts).length ? { hosts } : {}),
    apps: { [WORKBENCH]: { version: WORKBENCH_MIN_VERSION, ingress: domain ? { kind: "nginx", port } : { kind: "direct" } } },
  } as unknown as Environment;
  return { environment, findings: validateEnvironment(environment) };
}

/** The Workbench manifest this Deployer ships (§15.6 ②), imported only while the registry has no Workbench. */
export function initialWorkbenchManifest(dir: string): unknown {
  const file = join(dir, `${WORKBENCH}.json`);
  if (!existsSync(file)) throw new Error(`This Deployer ships no Workbench manifest (${file}).`);
  const manifest = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const errors = validateManifest(manifest);
  if (errors.length) throw new Error(`The shipped Workbench manifest is not valid: ${errors.join("; ")}`);
  return manifest;
}
