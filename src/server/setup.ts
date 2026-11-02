// The first setup (§15, D41): which of the steps up to L2 are done, worked out on every call from what is actually
// there (no progress is stored), so each step can be redone and steps done by hand are recognised. Workbench is the
// first app; setup is complete once Workbench answers and the Deployer has its Workbench API key.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Environment } from "../compose/generate.ts";
import { validateManifest } from "../manifest/validate.ts";
import type { Principal } from "./auth.ts";
import type { Deployments } from "./deploy.ts";
import { validateEnvironment, type EnvironmentFinding } from "./environment.ts";
import { hostIds } from "./handoff.ts";
import { isProd } from "./plan.ts";
import type { Store } from "./store.ts";
import { readToken } from "./versions.ts";

export const WORKBENCH = "workbench";
/** The oldest Workbench a new installation starts with: 1.25.1 starts on an empty database (§15.6 ⑥). */
export const WORKBENCH_MIN_VERSION = "1.25.1";

export type StepState = "done" | "next" | "waiting" | "blocked";
export interface SetupStep { id: string; state: StepState; title: string; detail: string; hosts?: { id: string; online: boolean; reason?: string; tokens: number }[] }
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
  workbenchUrl: string;
  workbenchApiKeyFile?: string;
  workbenchReachable: () => Promise<boolean>;
  initialManifestsDir: string;
}

const settingsOf = (d: Deployments): { env?: Environment; revision?: number; error?: string } => {
  try { const s = d.settings(); return { env: s.environment, revision: s.revision }; } catch (error) {
    return { error: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : (error as Error).message };
  }
};

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
  steps.push(registered
    ? { id: "workbench-manifest", state: "done", title: "Workbench manifest", detail: `Workbench is in the registry (${store.manifests(WORKBENCH).length} range${store.manifests(WORKBENCH).length > 1 ? "s" : ""}).` }
    : !env
      ? { id: "workbench-manifest", state: "waiting", title: "Workbench manifest", detail: "Waits for the environment settings." }
      : prod
        ? { id: "workbench-manifest", state: "next", title: "Workbench manifest", detail: "PROD takes its manifests from UAT: set DEPLOYER_UAT_URL and DEPLOYER_UAT_KEY_FILE, then take the registry from UAT." }
        : { id: "workbench-manifest", state: "next", title: "Workbench manifest", detail: `Import the Workbench manifest this Deployer ships (from ${WORKBENCH_MIN_VERSION}, image from the ghcr registry). Other apps are registered later.` });

  const reachable = await ctx.workbenchReachable();
  const deployed = store.deployedVersion(WORKBENCH)?.version;
  steps.push(reachable
    ? { id: "workbench-deploy", state: "done", title: "Deploy Workbench", detail: `Workbench answers at ${ctx.workbenchUrl}${deployed ? ` (the Deployer deployed ${deployed})` : " (not deployed by this Deployer)"}.` }
    : deployed
      ? { id: "workbench-deploy", state: "blocked", title: "Deploy Workbench", detail: `Workbench ${deployed} was deployed but ${ctx.workbenchUrl}/health does not answer: check the container and DEPLOYER_WORKBENCH_URL.` }
      : !registered || offline.length
        ? { id: "workbench-deploy", state: "waiting", title: "Deploy Workbench", detail: "Waits for the executors and the Workbench manifest." }
        : { id: "workbench-deploy", state: "next", title: "Deploy Workbench", detail: `Fill in Workbench's environment variables (an initial admin in WORKBENCH_BOOTSTRAP_EMAIL / WORKBENCH_BOOTSTRAP_PASSWORD), check the nginx configuration and deploy ${WORKBENCH_MIN_VERSION} or newer. Once Workbench answers, this emergency sign-in stops working: keep the initial admin's password at hand.` });

  const admin = principal.via === "workbench" && principal.permissions.includes("admin");
  steps.push(admin
    ? { id: "workbench-signin", state: "done", title: "Sign in with Workbench", detail: `${principal.id} is a Workbench admin.` }
    : reachable
      ? { id: "workbench-signin", state: "next", title: "Sign in with Workbench", detail: "Sign in to Workbench as an admin, create the groups deploy-viewer, deploy-uat and deploy-prod, add the Deployer to appLinks, then open the Deployer again." }
      : { id: "workbench-signin", state: "waiting", title: "Sign in with Workbench", detail: "Waits for Workbench." });

  const key = Boolean(ctx.workbenchApiKeyFile && readToken(ctx.workbenchApiKeyFile));
  steps.push(key
    ? { id: "workbench-key", state: "done", title: "Workbench API key", detail: "The Deployer has its Workbench API key." }
    : reachable
      ? { id: "workbench-key", state: "next", title: "Workbench API key", detail: ctx.workbenchApiKeyFile
        ? `${ctx.workbenchApiKeyFile} is missing or empty: create a key in Workbench Administration → API keys and write it there (readable by uid 1000), then restart the Deployer.`
        : "Create a key in Workbench Administration → API keys, write it to a file under secrets/ (readable by uid 1000), set DEPLOYER_WORKBENCH_API_KEY_FILE to it in deployer.env and restart the Deployer." }
      : { id: "workbench-key", state: "waiting", title: "Workbench API key", detail: "Waits for Workbench." });

  // The highest level reached: once Workbench and its key are there, an executor that is offline for a while is a
  // problem of its own (Hosts, Overview), not a reason to go back to setup.
  const level = env && reachable && key ? "L2" : env && !offline.length ? "L1" : "L0";
  return {
    complete: level === "L2",
    level,
    environment: env ? { name: env.name, prod } : null,
    steps,
    canAct: principal.permissions.includes("admin"),
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
