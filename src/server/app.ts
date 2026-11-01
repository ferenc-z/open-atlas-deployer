// HTTP surface of the Deployer, phase 1: who am I, the emergency login, the read-only status of
// this environment, and the app registry (admins change it). Everything sits under the base path
// the reverse proxy serves the Deployer at (§9.1).

import { randomBytes, X509Certificate } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { Hono, type Context } from "hono";
import type { Environment, Manifest } from "../compose/generate.ts";
import { compareVersions, covering } from "../manifest/version.ts";
import { crossAppConflicts, validateManifest } from "../manifest/validate.ts";
import { isProd } from "./plan.ts";
import {
  EMERGENCY_COOKIE, EMERGENCY_TTL_MS, LoginThrottle, emergencyPrincipal, newToken, parseCookies, sha256, verifyPassword,
  type Permission, type Principal, type WorkbenchSessions,
} from "./auth.ts";
import type { Config } from "./config.ts";
import { DeployError, deploymentRecord, type Deployments } from "./deploy.ts";
import type { EnvManager } from "./env.ts";
import { KeyError, isKey, type Keys } from "./keys.ts";
import { handleMcp } from "./mcp.ts";
import { OnboardingError, type Onboarding } from "./onboarding.ts";
import type { Briefs } from "./brief.ts";
import type { Drift } from "./drift.ts";
import { PeerError, type Peer, type PeerStatus } from "./peer.ts";
import { EXECUTOR_VERSION, hostIds, hostOf, newJobId, tokenSha256 } from "./handoff.ts";
import { lineDiff } from "./ingress.ts";
import { environmentStatus, hostStateOf, parseDockerPs, type Observer } from "./observe.ts";
import { StoreError, type Actor, type Store } from "./store.ts";
import { DEPLOYER_VERSION } from "./version.ts";
import { validateEnvironment } from "./environment.ts";
import { applyPatch, changedPaths, PatchError } from "./jsonpatch.ts";
import type { Versions } from "./versions.ts";

export interface Dependencies {
  config: Config;
  store: Store;
  sessions: WorkbenchSessions;
  observer: Observer;
  deployments: Deployments;
  versions: Versions;
  env: EnvManager;
  /** PROD: UAT's Deployer (§6.3). */
  peer?: Peer;
  /** Personal and service API keys (§9.4, phase 6); without them /mcp and bearer keys are off. */
  keys?: Keys;
  /** Assessments (§10.5, phase 7). */
  onboarding?: Onboarding;
  /** Phase 8: drift between what should be and what is, and the daily brief. */
  drift?: Drift;
  briefs?: Briefs;
}

const reject = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 429 | 503, code: string, message: string, details: string[] = []) =>
  c.json({ error: code, message, ...(details.length ? { details } : {}) }, status);

const actorOf = (p: Principal): Actor => ({ id: p.id, via: p.via });

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".ico": "image/x-icon" };

export function createApp({ config, store, sessions, observer, deployments, versions, env: envVars, peer, keys, onboarding, drift, briefs }: Dependencies): Hono {
  const throttle = new LoginThrottle();
  const api = new Hono();
  // /mcp calls the API in-process as the key's principal: a one-time nonce with this process's secret, never from outside.
  const internalSecret = randomBytes(24).toString("hex");
  const internal = new Map<string, Principal>();

  async function emergency(c: Context): Promise<Principal | undefined> {
    const token = parseCookies(c.req.header("cookie")).get(EMERGENCY_COOKIE);
    if (!token || !config.emergencyPasswordHash) return undefined;
    const session = store.emergencySession(sha256(token));
    if (!session) return undefined;
    // Only while Workbench is down (§9.3): once it is back, people sign in there again.
    return (await sessions.reachable()) ? undefined : emergencyPrincipal(session.csrf);
  }

  /** The principal, or the response that refuses the request. */
  async function authenticate(c: Context, need: Permission): Promise<Principal | Response> {
    let principal: Principal | undefined;
    const marker = c.req.header("x-deployer-internal");
    if (marker) {
      const [secret, nonce] = marker.split(".");
      principal = secret === internalSecret && nonce ? internal.get(nonce) : undefined;
      if (nonce) internal.delete(nonce);
      if (!principal) return reject(c, 401, "auth/unauthenticated", "Sign in to Workbench first.");
    }
    // A personal or service API key (§9.4): no cookie, no CSRF token.
    const bearer = /^Bearer (\S+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    if (!principal && bearer && keys && /^dp[ks]_/.test(bearer)) {
      try { principal = await keys.resolve(bearer); } catch (error) {
        if (error instanceof KeyError) return reject(c, error.status, error.code, error.message);
        throw error;
      }
    }
    if (!principal) principal = await emergency(c);
    if (!principal) {
      const result = await sessions.resolve(c.req.header("cookie"));
      if (result.kind === "unavailable") return reject(c, 503, "auth/workbench-unavailable", "Workbench is unreachable, so the sign-in cannot be confirmed.", config.emergencyPasswordHash ? ["emergency-available"] : []);
      if (result.kind === "anonymous") return reject(c, 401, "auth/unauthenticated", "Sign in to Workbench first.");
      principal = result.principal;
    }
    if (!principal.permissions.includes(need)) return reject(c, 403, "auth/forbidden", need === "admin" ? "Only Workbench admins can do this." : "You are not in any of the deploy-viewer, deploy-uat or deploy-prod groups.");
    if (!isKey(principal) && c.req.method !== "GET" && c.req.header("x-csrf-token") !== principal.csrfToken) return reject(c, 403, "auth/csrf", "The request has no valid CSRF token; reload the page.");
    return principal;
  }

  // D35: the executors. Each host's executor calls in with its own token (dpe_); the Deployer never calls a host.
  const handoff = deployments.handoff;
  const executorHost = (c: Context): string | undefined => {
    const bearer = /^Bearer (dpe_\S+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    return bearer ? store.executorHost(tokenSha256(bearer)) : undefined;
  };
  const executorRoute = (handler: (c: Context, host: string) => Promise<Response> | Response) => async (c: Context) => {
    const host = executorHost(c);
    if (!host) return reject(c, 401, "executor/unauthenticated", "An executor token (dpe_) of a registered host is required.");
    return handler(c, host);
  };
  api.post("/executor/v1/heartbeat", executorRoute(async (c, host) => {
    handoff.heartbeat(host, await c.req.json());
    return c.json({ ok: true, host, deployer: DEPLOYER_VERSION });
  }));
  api.get("/executor/v1/jobs/next", executorRoute(async (c, host) => {
    const wait = Math.min(30, Math.max(0, Number(c.req.query("wait") ?? 0))) * 1000;
    const job = await handoff.next(host, wait, c.req.raw.signal);
    return job ? c.json({ job }) : c.body(null, 204);
  }));
  const ownJob = (handler: (c: Context, id: string) => Promise<Response>) => executorRoute(async (c, host) => {
    const id = c.req.param("id") ?? "";
    if (!handoff.owns(host, id)) return reject(c, 404, "executor/job-unknown", `${id} is not a job of ${host}.`);
    return handler(c, id);
  });
  api.put("/executor/v1/jobs/:id/status", ownJob(async (c, id) => { handoff.putStatus(id, await c.req.json()); return c.json({ ok: true }); }));
  api.post("/executor/v1/jobs/:id/log", ownJob(async (c, id) => { handoff.appendLog(id, await c.req.text()); return c.json({ ok: true }); }));
  api.put("/executor/v1/jobs/:id/env-content", ownJob(async (c, id) => { handoff.putEnvContent(id, await c.req.text()); return c.json({ ok: true }); }));
  api.post("/executor/v1/state", executorRoute(async (c, host) => {
    const body = await c.req.json() as { containers?: string; files?: Record<string, string> };
    handoff.putState(host, parseDockerPs(String(body.containers ?? "")), body.files ?? {});
    return c.json({ ok: true });
  }));

  // §8.6: a host's executor is upgraded to the version this Deployer ships. The Deployer only names the version; the
  // host takes the release from its own EXECUTOR_UPGRADE_FROM. An executor job's app is executor@<host>.
  const upgradeOf = (env: Environment, host: string) => {
    const info = handoff.executor(host);
    const last = store.listJobs({ app: `executor@${host}`, kind: "executor-upgrade", limit: 1 })[0];
    const job = last ? { id: last.id, state: last.state, version: last.version, message: last.message, finishedAt: last.finishedAt } : null;
    const version = info.heartbeat?.version;
    const available = Boolean(version && /^\d+\.\d+\.\d+(-.+)?$/.test(version) && compareVersions(version, EXECUTOR_VERSION) < 0);
    const busy = store.activeJobs().find((j) => (j.kind === "executor-upgrade" ? j.app === `executor@${host}` : env.apps[j.app] !== undefined && hostOf(env, j.app) === host));
    const blocked = !available ? undefined
      : !info.online ? info.reason
      : !info.heartbeat?.kinds?.includes("executor-upgrade") ? `Executor ${version} on ${host} cannot upgrade itself: install ${EXECUTOR_VERSION} there by hand once (install.sh)`
      : !info.heartbeat.upgradeFrom ? `EXECUTOR_UPGRADE_FROM is not set on ${host}: set it in executor.env and restart the executor`
      : busy ? `${host} is running ${busy.id}; upgrade when it ends`
      : undefined;
    return { available, ...(blocked ? { blocked } : {}), job, from: info.heartbeat?.upgradeFrom ?? null };
  };

  // D16: the Deployer's own upgrade. The executor of the host that runs it (its heartbeat names the image repository)
  // pulls the version, backs up the state, switches and checks; the Deployer is down meanwhile and the executor reports
  // the end to whichever version runs afterwards. Its job's app is "deployer".
  const selfOf = (env: Environment) => {
    const runs = hostIds(env).map((h) => handoff.executor(h)).filter((e) => e.heartbeat?.deployer?.image);
    const at = runs.length === 1 ? runs[0]! : undefined;
    const last = store.listJobs({ app: "deployer", kind: "deployer-upgrade", limit: 1 })[0];
    const active = store.activeJobs();
    const blocked = !runs.length ? "No executor says it runs the Deployer: set EXECUTOR_DEPLOYER_DIR and EXECUTOR_DEPLOYER_IMAGE on its host"
      : runs.length > 1 ? `Executors on ${runs.map((r) => r.host).join(", ")} all say they run the Deployer; only one may`
      : !at!.online ? at!.reason
      : !at!.heartbeat?.kinds?.includes("deployer-upgrade") ? `Executor ${at!.heartbeat?.version} on ${at!.host} cannot upgrade the Deployer: upgrade it to ${EXECUTOR_VERSION} first`
      : active.length ? `${active.map((j) => j.id).join(", ")} ${active.length > 1 ? "are" : "is"} running; upgrade when nothing runs`
      : undefined;
    return {
      version: DEPLOYER_VERSION, host: at?.host ?? null, image: at?.heartbeat?.deployer?.image ?? null, ...(blocked ? { blocked } : {}),
      job: last ? { id: last.id, state: last.state, version: last.version, fromVersion: last.fromVersion, message: last.message, finishedAt: last.finishedAt } : null,
    };
  };
  api.get("/api/deployer", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    return c.json(selfOf(deployments.environment().env));
  });
  api.post("/api/deployer/upgrade", async (c) => {
    const p = await authenticate(c, "admin");
    if (p instanceof Response) return p;
    if (isKey(p)) return reject(c, 403, "auth/browser-only", "The Deployer is upgraded only from a browser session, not API keys.");
    const version = String(((await c.req.json().catch(() => ({}))) as { version?: unknown }).version ?? "").trim();
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) return reject(c, 400, "deployer/version", "Give the version to upgrade to, e.g. 0.2.0.");
    if (version === DEPLOYER_VERSION) return reject(c, 409, "deployer/same-version", `The Deployer already runs ${version}.`);
    const older = /^\d+\.\d+\.\d+/.test(DEPLOYER_VERSION) && compareVersions(version, DEPLOYER_VERSION) < 0;
    if (older && ((await c.req.json().catch(() => ({}))) as { confirmOlder?: unknown }).confirmOlder !== true) return reject(c, 409, "deployer/older", `${version} is older than ${DEPLOYER_VERSION}: confirm going back.`);
    const { env } = deployments.environment();
    const self = selfOf(env);
    if (self.blocked) return reject(c, 409, "deployer/upgrade-blocked", self.blocked);
    const id = newJobId("deployer-upgrade");
    const request = { kind: "deployer-upgrade", version };
    store.addJob({ id, kind: "deployer-upgrade", app: "deployer", version, environment: env.name, fromVersion: DEPLOYER_VERSION, manifest: null, pinFrom: null, request }, { id: p.id, via: p.via });
    handoff.submit(id, { ...request, requestedBy: p.id }, self.host!);
    return c.json({ job: store.job(id) }, 201);
  });

  // D38: the environment settings as revisions in the state database (environment.json is read only on the first start).
  // A change names the revision it was made on (base) and gives either the whole settings or a JSON Patch; it is checked
  // before saving, and validate shows the result without saving. Saving does not deploy: plans read the newest revision.
  type EnvironmentBody = { base?: unknown; environment?: unknown; patch?: unknown; note?: unknown };
  const environmentChange = (body: EnvironmentBody) => {
    const latest = deployments.settings();
    if (typeof body.base !== "number") throw new DeployError(400, "environment/base", `Give base: the revision the change was made on (the newest is ${latest.revision}).`);
    const from = store.environmentRevision(body.base);
    if (!from) throw new DeployError(404, "environment/unknown", `There is no revision ${body.base} of the environment settings.`);
    if ((body.patch === undefined) === (body.environment === undefined)) throw new DeployError(400, "environment/change", "Give either patch (JSON Patch on the base revision) or environment (the whole settings).");
    const next = body.patch !== undefined ? applyPatch(from.environment, body.patch) : body.environment;
    const findings = validateEnvironment(next);
    return {
      base: from.revision, latest: latest.revision, stale: from.revision !== latest.revision, environment: next as Environment, changes: changedPaths(from.environment, next),
      findings, diff: lineDiff(JSON.stringify(from.environment, null, 2), JSON.stringify(next, null, 2)),
    };
  };
  const environmentError = (c: Context, error: unknown) => {
    if (error instanceof PatchError) return reject(c, 400, "patch/invalid", error.message, [error.at.join("/")]);
    return deployError(c, error);
  };
  api.get("/api/environment", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const latest = deployments.settings();
    const shown = c.req.query("revision") ? store.environmentRevision(Number(c.req.query("revision"))) : latest;
    if (!shown) return reject(c, 404, "environment/unknown", "No such revision of the environment settings.");
    return c.json({ ...shown, latest: latest.revision, revisions: store.environmentRevisions(), fileDiffers: deployments.fileDiffers(), file: config.environmentFile, canSave: p.permissions.includes("admin") });
  });
  api.get("/api/environment/export", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const r = c.req.query("revision") ? store.environmentRevision(Number(c.req.query("revision"))) : deployments.settings();
    if (!r) return reject(c, 404, "environment/unknown", "No such revision of the environment settings.");
    c.header("content-disposition", `attachment; filename="environment-${r.environment.name}-r${r.revision}.json"`);
    return c.body(`${JSON.stringify(r.environment, null, 2)}\n`, 200, { "content-type": "application/json" });
  });
  api.post("/api/environment/validate", async (c) => {
    const p = await authenticate(c, "admin");
    if (p instanceof Response) return p;
    try {
      const change = environmentChange(await c.req.json().catch(() => ({})) as EnvironmentBody);
      return c.json(change);
    } catch (error) { return environmentError(c, error); }
  });
  api.put("/api/environment", async (c) => {
    const p = await authenticate(c, "admin");
    if (p instanceof Response) return p;
    const body = await c.req.json().catch(() => ({})) as EnvironmentBody;
    const newest = deployments.settings().revision;
    if (typeof body.base === "number" && body.base !== newest) return reject(c, 409, "environment/stale", `The environment settings are at revision ${newest}, not ${body.base}: read them again and make the change on that.`);
    try {
      const change = environmentChange(body);
      if (change.stale) return reject(c, 409, "environment/stale", `The environment settings are at revision ${change.latest}, not ${change.base}: read them again and make the change on that.`);
      if (change.findings.length) return reject(c, 400, "environment/invalid", "The environment settings are not valid.", change.findings.map((f) => `${f.at}: ${f.expected}`));
      if (!change.changes.length) return reject(c, 400, "environment/unchanged", "Nothing changed.");
      const saved = store.saveEnvironment(change.environment, change.base, actorOf(p), { ...(typeof body.note === "string" && body.note.trim() ? { note: body.note.trim() } : {}) });
      return c.json({ revision: saved.revision, changes: saved.changes, savedAt: saved.savedAt });
    } catch (error) { return environmentError(c, error); }
  });

  // D35: the hosts of this environment, their executors, and the tokens they call in with.
  api.get("/api/hosts", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const { env } = deployments.environment();
    const tokens = store.executorTokens();
    const reports = handoff.reports();
    return c.json({
      executorVersion: EXECUTOR_VERSION,
      hosts: hostIds(env).map((id) => ({
        id, address: env.hosts?.[id]?.address ?? null, executor: handoff.executor(id),
        apps: Object.keys(env.apps).filter((a) => hostOf(env, a) === id),
        report: reports.find((r) => r.host === id) ? { at: reports.find((r) => r.host === id)!.at, stale: reports.find((r) => r.host === id)!.stale, containers: reports.find((r) => r.host === id)!.containers.length } : null,
        tokens: tokens.filter((t) => t.host === id).map(({ prefix, createdAt, createdBy, revokedAt }) => ({ prefix, createdAt, createdBy, revokedAt })),
        upgrade: upgradeOf(env, id),
      })),
    });
  });
  const startExecutorUpgrade = (actor: Actor, host: string) => {
    const { env } = deployments.environment();
    if (!hostIds(env).includes(host)) throw new DeployError(404, "host/unknown", `${host} is not a host of this environment (environment settings hosts).`);
    const upgrade = upgradeOf(env, host);
    if (!upgrade.available) throw new DeployError(409, "executor/up-to-date", `The executor on ${host} is not older than ${EXECUTOR_VERSION}.`);
    if (upgrade.blocked) throw new DeployError(409, "executor/upgrade-blocked", upgrade.blocked);
    const id = newJobId("executor-upgrade");
    const request = { kind: "executor-upgrade", version: EXECUTOR_VERSION };
    store.addJob({ id, kind: "executor-upgrade", app: `executor@${host}`, version: EXECUTOR_VERSION, environment: env.name, fromVersion: handoff.executor(host).heartbeat?.version ?? null, manifest: null, pinFrom: null, request }, actor);
    handoff.submit(id, { ...request, requestedBy: actor.id }, host);
    return store.job(id)!;
  };
  api.post("/api/hosts/:id/upgrade-executor", async (c) => {
    const p = await authenticate(c, "admin");
    if (p instanceof Response) return p;
    if (isKey(p)) return reject(c, 403, "auth/browser-only", "Executor upgrades are started only from a browser session, not API keys.");
    try { return c.json({ job: startExecutorUpgrade(actorOf(p), c.req.param("id")) }, 201); } catch (error) { return deployError(c, error); }
  });

  // D39: every outdated executor, one host after the other; a failed or rolled-back one stops the rest.
  type Batch = { by: Actor; startedAt: string; current: { host: string; job: string } | null; remaining: string[]; done: string[]; stopped?: string; finishedAt?: string };
  const batchOf = (): Batch | null => { const raw = store.setting("executor-upgrade-batch"); return raw ? JSON.parse(raw) as Batch : null; };
  const saveBatch = (b: Batch) => store.setSetting("executor-upgrade-batch", JSON.stringify(b), { id: "deployer", via: "cli" });
  const nextInBatch = (b: Batch) => {
    while (b.remaining.length) {
      const host = b.remaining.shift()!;
      try { b.current = { host, job: startExecutorUpgrade(b.by, host).id }; return; } catch (error) { b.current = null; b.stopped = `${host}: ${(error as Error).message}`; return; }
    }
    b.current = null;
    b.finishedAt = new Date().toISOString();
  };
  deployments.onEnded.push((job, status) => {
    const b = batchOf();
    if (job.kind !== "executor-upgrade" || !b?.current || b.current.job !== job.id) return;
    if (status.state === "succeeded") { b.done.push(b.current.host); nextInBatch(b); }
    else { b.stopped = `${b.current.host}: ${status.message ?? status.state}`; b.current = null; }
    saveBatch(b);
  });
  api.post("/api/hosts/upgrade-outdated", async (c) => {
    const p = await authenticate(c, "admin");
    if (p instanceof Response) return p;
    if (isKey(p)) return reject(c, 403, "auth/browser-only", "Executor upgrades are started only from a browser session, not API keys.");
    const running = batchOf();
    if (running?.current) return reject(c, 409, "executor/batch-running", `An upgrade of the executors is running (${running.current.host}).`);
    const { env } = deployments.environment();
    const hosts = hostIds(env).filter((h) => { const u = upgradeOf(env, h); return u.available && !u.blocked; });
    if (!hosts.length) return reject(c, 409, "executor/none-outdated", "No executor can be upgraded now.");
    const b: Batch = { by: actorOf(p), startedAt: new Date().toISOString(), current: null, remaining: hosts, done: [] };
    try { b.current = { host: hosts[0]!, job: startExecutorUpgrade(b.by, hosts[0]!).id }; b.remaining.shift(); } catch (error) { return deployError(c, error); }
    saveBatch(b);
    return c.json({ batch: b }, 201);
  });

  // D39: what the Overview's Platform area shows: the Deployer (versions to choose from) and each host's executor.
  const deployerVersions = async () => {
    const src = config.deployerRelease;
    const running = DEPLOYER_VERSION;
    if (!src) return { versions: [] as { version: string; prerelease: boolean; relation: string }[], error: "DEPLOYER_RELEASE_REPO is not set: type the version" };
    if ("error" in src) return { versions: [], error: src.error };
    const listed = await versions.list(src.repo, config.deployerReleaseTag);
    const known = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(running);
    const all = [...new Set([...listed.versions, ...(known ? [running] : [])])].sort((a, b) => compareVersions(b, a)).slice(0, 30);
    const list = all.map((v) => ({ version: v, prerelease: v.includes("-"), relation: !known ? "unknown" : compareVersions(v, running) > 0 ? "newer" : compareVersions(v, running) < 0 ? "older" : "running" }));
    // A pre-release is offered but never announced, unless a pre-release is what runs.
    const latest = list.find((v) => v.relation === "newer" && (!v.prerelease || running.includes("-")))?.version ?? null;
    return { versions: list, latest, ...(listed.error ? { error: listed.error } : {}) };
  };
  api.get("/api/platform", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const { env } = deployments.environment();
    return c.json({
      deployer: { ...selfOf(env), ...(await deployerVersions()), repo: config.deployerRelease && "repo" in config.deployerRelease ? config.deployerRelease.repo : null },
      executors: hostIds(env).map((id) => { const e = handoff.executor(id); return { host: id, online: e.online, ...(e.reason ? { reason: e.reason } : {}), version: e.heartbeat?.version ?? null, upgrade: upgradeOf(env, id) }; }),
      shipped: EXECUTOR_VERSION, batch: batchOf(), canUpgrade: p.permissions.includes("admin") && !isKey(p),
    });
  });
  api.get("/api/deployer/plan", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const version = c.req.query("version") ?? "";
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) return reject(c, 400, "deployer/version", "Give the version to upgrade to, e.g. 0.2.0.");
    const self = selfOf(deployments.environment().env);
    const older = /^\d+\.\d+\.\d+/.test(DEPLOYER_VERSION) && compareVersions(version, DEPLOYER_VERSION) < 0;
    const src = config.deployerRelease;
    const release = src && "repo" in src ? await versions.release(src.repo, config.deployerReleaseTag.replaceAll("{version}", version)) : undefined;
    return c.json({
      from: DEPLOYER_VERSION, to: version, host: self.host, image: self.image, older, same: version === DEPLOYER_VERSION,
      ...(self.blocked ? { blocked: self.blocked } : {}), ...(release ? { release } : {}),
      steps: ["Pull the image and check its labels (version, executor protocols); a missing image stops here, before anything stops",
        "Stop the Deployer: this page is unavailable for about a minute", "Back up its state directory (data/)", "Switch the image in .env and start it",
        "Check it becomes healthy and answers as the new version", "If not: put the previous image and the state from before back"],
      warnings: [
        ...(older ? [`Going back from ${DEPLOYER_VERSION} to ${version}: the state database only gains tables and columns, so an older version usually reads it; if it does not start, the executor puts ${DEPLOYER_VERSION} back.`] : []),
        "Afterwards the executors are offered the version the new Deployer ships.",
      ],
    });
  });
  api.post("/api/hosts/:id/token", async (c) => {
    const p = await authenticate(c, "admin");
    if (p instanceof Response) return p;
    if (isKey(p)) return reject(c, 403, "auth/browser-only", "Executor tokens are issued only to browser sessions, not API keys.");
    const host = c.req.param("id");
    if (!hostIds(deployments.environment().env).includes(host)) return reject(c, 404, "host/unknown", `${host} is not a host of this environment (environment.json hosts).`);
    const token = `dpe_${randomBytes(24).toString("base64url")}`;
    store.addExecutorToken(host, tokenSha256(token), token.slice(0, 10), { id: p.id, via: p.via });
    return c.json({ host, token }, 201);
  });
  api.post("/api/hosts/:id/revoke", async (c) => {
    const p = await authenticate(c, "admin");
    if (p instanceof Response) return p;
    return c.json({ revoked: store.revokeExecutorTokens(c.req.param("id"), { id: p.id, via: p.via }) });
  });

  // D36: how each app is reached, the recommended nginx configuration with its revisions, and the internal CA.
  const caInfo = () => {
    const pem = store.setting("ca.pem");
    if (!pem) return null;
    try { const x = new X509Certificate(pem); return { subject: x.subject, issuer: x.issuer, validTo: x.validTo, fingerprint256: x.fingerprint256 }; } catch { return { subject: "unreadable", issuer: "", validTo: "", fingerprint256: "" }; }
  };
  api.get("/api/ingress", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const { env } = deployments.environment();
    const nginx = deployments.nginx();
    const latest = store.nginxRevision();
    return c.json({
      domain: env.domain ?? null,
      endpoints: Object.keys(env.apps).sort().map((id) => ({ host: hostOf(env, id), ...(deployments.endpointOf(id) ?? { app: id, kind: "none" }) })),
      nginx: { body: nginx.body, sha256: nginx.sha256, problems: nginx.problems, latest: latest ? { revision: latest.revision, sha256: latest.sha256, savedAt: latest.savedAt, savedBy: latest.savedBy, note: latest.note } : null, diff: latest && latest.sha256 !== nginx.sha256 ? lineDiff(latest.body, nginx.body) : null },
      revisions: store.nginxRevisions(),
      ca: caInfo(),
      canSave: deployments.canDeploy(p),
      canSetCa: p.permissions.includes("admin") && !isKey(p),
    });
  });
  api.post("/api/ingress/nginx", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    if (!deployments.canDeploy(p)) return reject(c, 403, "auth/forbidden", "Saving an nginx revision needs the deploy group of this environment.");
    const body = await c.req.json().catch(() => ({})) as { note?: string };
    const nginx = deployments.nginx();
    if (store.nginxRevision()?.sha256 === nginx.sha256) return reject(c, 409, "nginx/unchanged", "The recommended configuration is the same as the latest revision.");
    return c.json({ revision: store.saveNginx(nginx.body, nginx.sha256, { id: p.id, via: p.via }, body.note?.trim() || undefined) }, 201);
  });
  api.get("/api/ingress/nginx/:revision", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const r = store.nginxRevision(Number(c.req.param("revision")));
    if (!r) return reject(c, 404, "nginx/unknown", "No such revision.");
    c.header("content-disposition", `attachment; filename="open-atlas-${deployments.environment().env.name}-nginx-r${r.revision}.conf"`);
    return c.text(r.body);
  });
  api.put("/api/settings/ca", async (c) => {
    const p = await authenticate(c, "admin");
    if (p instanceof Response) return p;
    if (isKey(p)) return reject(c, 403, "auth/browser-only", "The internal CA is set only from a browser session.");
    const { pem } = await c.req.json().catch(() => ({})) as { pem?: string };
    const text = String(pem ?? "").trim();
    if (!text) { store.setSetting("ca.pem", null, { id: p.id, via: p.via }); return c.json({ ca: null }); }
    if (text.length > 64 * 1024 || !/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----$/.test(text)) return reject(c, 400, "ca/invalid", "Paste one or more PEM certificates (-----BEGIN CERTIFICATE----- … -----END CERTIFICATE-----).");
    try { new X509Certificate(text); } catch (error) { return reject(c, 400, "ca/invalid", `The certificate cannot be read: ${(error as Error).message}`); }
    store.setSetting("ca.pem", `${text}\n`, { id: p.id, via: p.via });
    return c.json({ ca: caInfo() });
  });

  // MCP (§10.4): every tool is one call to this API as the key's principal.
  api.post("/mcp", async (c) => {
    const bearer = /^Bearer (\S+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    if (!keys || !bearer || !/^dp[ks]_/.test(bearer)) {
      c.header("www-authenticate", "Bearer");
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "a Deployer API key (dpk_ or dps_) is required" } }, 401);
    }
    let principal: Principal;
    try { principal = await keys.resolve(bearer); } catch (error) {
      if (error instanceof KeyError) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: error.message } }, error.status);
      throw error;
    }
    let message: unknown;
    try { message = await c.req.json(); } catch { return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400); }
    const origin = new URL(c.req.url).origin;
    const call = async (spec: { method: string; path: string; query?: Record<string, unknown>; body?: unknown; headers?: Record<string, string> }) => {
      const nonce = randomBytes(12).toString("hex");
      internal.set(nonce, principal);
      const query = Object.entries(spec.query ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
      const res = await api.fetch(new Request(`${origin}${spec.path}${query ? `?${query}` : ""}`, {
        method: spec.method, headers: { ...(spec.headers ?? {}), "x-deployer-internal": `${internalSecret}.${nonce}`, ...(spec.body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(spec.body !== undefined ? { body: JSON.stringify(spec.body) } : {}),
      }));
      internal.delete(nonce);
      const raw = await res.text();
      let body: unknown = raw;
      try { body = raw ? JSON.parse(raw) : null; } catch { /* a text answer, e.g. an nginx configuration */ }
      return { status: res.status, body };
    };
    const reply = await handleMcp(message, { principal, store, call });
    return reply ? c.json(reply) : c.body(null, 202);
  });
  api.get("/mcp", (c) => c.json({ jsonrpc: "2.0", id: null, error: { code: -32601, message: "no event stream here; POST JSON-RPC to /mcp" } }, 405));

  // Assessments (§10.5): start, follow, the draft operations (page and Agent), validation, trial, registration.
  const assessmentError = (c: Context, error: unknown) => {
    if (error instanceof OnboardingError) return reject(c, error.status, error.code, error.message, error.details);
    return deployError(c, error);
  };
  const withOnboarding = async (c: Context, need: Permission, run: (p: Principal, o: Onboarding) => Promise<Response> | Response) => {
    const p = await authenticate(c, need);
    if (p instanceof Response) return p;
    if (!onboarding) return reject(c, 404, "assessment/not-configured", "Onboarding assessments are not enabled.");
    try { return await run(p, onboarding); } catch (error) { return assessmentError(c, error); }
  };
  api.get("/api/environment-facts", (c) => withOnboarding(c, "view", (_p, o) => c.json(o.environmentFacts())));
  api.get("/api/assessments", (c) => withOnboarding(c, "view", async (_p, o) => { await o.poll(); return c.json({ assessments: o.list().map((a) => o.view(a)) }); }));
  api.post("/api/assessments", (c) => withOnboarding(c, "view", async (p, o) => {
    const body = await c.req.json().catch(() => ({})) as { repo?: string; version?: string; app?: string };
    const { assessment } = await o.start(p, body);
    return c.json({ assessment: o.view(assessment) }, 201);
  }));
  api.get("/api/assessments/:id", (c) => withOnboarding(c, "view", async (_p, o) => { await o.poll(); return c.json(o.view(o.get(c.req.param("id")))); }));
  api.post("/api/assessments/:id/draft/:operation", (c) => withOnboarding(c, "view", async (p, o) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    return c.json(o.view(o.change(p, c.req.param("id"), c.req.param("operation"), body, c.req.header("x-task-token"))));
  }));
  api.post("/api/assessments/:id/validate", (c) => withOnboarding(c, "view", (p, o) => c.json({ findings: o.validate(p, c.req.param("id")) })));
  api.post("/api/assessments/:id/trial", (c) => withOnboarding(c, "view", async (p, o) => {
    const body = await c.req.json().catch(() => ({})) as { version?: string };
    const r = await o.trial(p, c.req.param("id"), body.version);
    return c.json({ assessment: o.view(r.assessment), job: r.job });
  }));
  api.post("/api/assessments/:id/register", (c) => withOnboarding(c, "view", (p, o) => c.json(o.view(o.register(p, c.req.param("id"))))));
  api.post("/api/assessments/:id/close", (c) => withOnboarding(c, "view", (p, o) => c.json(o.view(o.close(p, c.req.param("id"))))));
  api.post("/api/assessments/:id/issue", (c) => withOnboarding(c, "view", async (p, o) => c.json(o.view(await o.openIssue(p, c.req.param("id"))))));

  // API keys (§9.4): made and revoked on the page with a Workbench session; a key never makes a key.
  const keyError = (c: Context, error: unknown) => {
    if (error instanceof KeyError) return reject(c, error.status, error.code, error.message);
    throw error;
  };
  api.get("/api/keys", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    if (!keys) return reject(c, 404, "key/not-configured", "API keys are not enabled (they need DEPLOYER_WORKBENCH_API_KEY_FILE to confirm a key's owner with Workbench).");
    return c.json({ keys: keys.list(p) });
  });
  api.post("/api/keys", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    if (!keys) return reject(c, 404, "key/not-configured", "API keys are not enabled.");
    const body = await c.req.json().catch(() => ({})) as { kind?: string; name?: string; days?: number };
    try {
      const made = keys.create(p, body.kind === "service" ? "service" : "personal", String(body.name ?? ""), Number(body.days ?? 90));
      c.header("cache-control", "no-store");
      return c.json(made, 201);
    } catch (error) { return keyError(c, error); }
  });
  api.delete("/api/keys/:id", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    if (!keys) return reject(c, 404, "key/not-configured", "API keys are not enabled.");
    try { keys.revoke(p, c.req.param("id")); return c.json({ revoked: true }); } catch (error) { return keyError(c, error); }
  });

  const environment = (): Environment => deployments.settings().environment;
  const deployError = (c: Context, error: unknown) => {
    if (error instanceof DeployError) return reject(c, error.status, error.code, error.message, error.details);
    if (error instanceof StoreError) return reject(c, 400, error.code, error.message, error.details);
    throw error;
  };

  api.get("/health", (c) => c.json({ status: "ok" }));

  // §6.3: what the other Deployer may read with its read-only key. Nothing here changes anything.
  const peerAllowed = (c: Context) => {
    const key = /^Bearer (\S+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    return Boolean(key && config.peerKeySha256.includes(sha256(key)));
  };
  api.use("/api/peer/*", async (c, next) => {
    if (!config.peerKeySha256.length) return reject(c, 404, "peer/not-configured", "This Deployer has no read-only key configured (DEPLOYER_PEER_KEY_SHA256).");
    if (!peerAllowed(c)) return reject(c, 401, "peer/unauthorized", "Wrong read-only key.");
    await next();
  });

  api.get("/api/peer/status", (c) => {
    const { env, deployed } = deployments.environment();
    const apps: PeerStatus["apps"] = {};
    for (const id of Object.keys(deployed)) {
      const last = store.deployRecords(id)[0];
      if (last) apps[id] = { version: last.version, deployment: last.id, deployedAt: last.deployedAt, digests: last.digests };
    }
    return c.json({ environment: env.name, apps } satisfies PeerStatus);
  });

  api.get("/api/peer/apps/:id/deployments", (c) => c.json({ environment: deployments.environment().env.name, records: store.deployRecords(c.req.param("id"), c.req.query("version") || undefined).slice(0, 20) }));

  // D38 ⑤: PROD takes its manifests from here, by the revision a deploy used or the one that covers a version now.
  api.get("/api/peer/apps", (c) => c.json({
    environment: deployments.environment().env.name,
    apps: store.listApps().map((a) => ({ id: a.id, name: a.name, repo: a.repo, manifests: store.manifestSegments(a.id).map((s) => ({ revision: s.revision, manifest: store.manifestRevision(a.id, s.appliesFrom, s.revision)! })) })),
  }));
  api.get("/api/peer/apps/:id/manifests/:from/:revision", (c) => {
    const m = store.manifestRevision(c.req.param("id"), c.req.param("from"), Number(c.req.param("revision")));
    return m ? c.json(m) : reject(c, 404, "manifest/unknown", "No such manifest revision.");
  });
  api.get("/api/peer/apps/:id/manifest", (c) => {
    const id = c.req.param("id");
    const m = covering(store.manifests(id), c.req.query("version") ?? "");
    if (!m) return reject(c, 404, "manifest/none", `No manifest covers ${c.req.query("version")} here.`);
    return c.json({ revision: store.manifestSegments(id).find((s) => s.appliesFrom === m.appliesFrom)!.revision, manifest: m });
  });

  api.get("/api/peer/apps/:id/env/fingerprint", (c) => {
    try { return c.json(envVars.fingerprintOf(c.req.param("id"))); } catch (error) { return deployError(c, error); }
  });

  api.get("/api/me", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) {
      if (p.status !== 401 && p.status !== 503) return p;
      // Tell the page where to sign in, and whether the emergency login is usable right now.
      const emergencyAvailable = Boolean(config.emergencyPasswordHash) && !(await sessions.reachable());
      return c.json({ signedIn: false, workbenchUrl: config.workbenchPublicUrl, emergencyAvailable, reason: p.status === 503 ? "workbench-unavailable" : "unauthenticated" }, p.status as 401 | 503);
    }
    let environmentName: string | undefined;
    try { environmentName = environment().name; } catch { environmentName = undefined; }
    return c.json({ signedIn: true, principal: p, environment: environmentName, workbenchUrl: config.workbenchPublicUrl, deployerVersion: DEPLOYER_VERSION });
  });

  api.post("/api/emergency/login", async (c) => {
    if (!config.emergencyPasswordHash) return reject(c, 404, "emergency/not-configured", "No emergency account is configured.");
    if (await sessions.reachable()) return reject(c, 409, "emergency/workbench-available", "Workbench is reachable; sign in with Workbench.");
    if (throttle.blocked()) return reject(c, 429, "emergency/throttled", "Too many failed attempts; try again in 15 minutes.");
    const body = await c.req.json().catch(() => ({})) as { password?: unknown };
    if (typeof body.password !== "string" || !verifyPassword(body.password, config.emergencyPasswordHash)) {
      throttle.fail();
      store.audit({ id: "emergency", via: "emergency" }, "emergency.login-failed", "emergency");
      return reject(c, 401, "emergency/wrong-password", "Wrong password.");
    }
    const { token, sha256: hash } = newToken();
    const csrf = newToken().token;
    store.addEmergencySession(hash, csrf, EMERGENCY_TTL_MS);
    store.audit({ id: "emergency", via: "emergency" }, "emergency.login", "emergency");
    const cookie = [`${EMERGENCY_COOKIE}=${token}`, `Path=${config.basePath || "/"}`, "HttpOnly", "SameSite=Strict", `Max-Age=${EMERGENCY_TTL_MS / 1000}`, ...(config.secureCookies ? ["Secure"] : [])];
    c.header("set-cookie", cookie.join("; "));
    return c.json({ signedIn: true });
  });

  api.post("/api/emergency/logout", async (c) => {
    const token = parseCookies(c.req.header("cookie")).get(EMERGENCY_COOKIE);
    if (token) {
      store.endEmergencySession(sha256(token));
      store.audit({ id: "emergency", via: "emergency" }, "emergency.logout", "emergency");
    }
    c.header("set-cookie", `${EMERGENCY_COOKIE}=; Path=${config.basePath || "/"}; Max-Age=0`);
    return c.json({ signedIn: false });
  });

  api.get("/api/status", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    let env: Environment;
    try { env = deployments.environment().env; } catch { return reject(c, 503, "environment/missing", `Cannot read the environment settings ${config.environmentFile}.`); }
    const apps = store.listApps().map((a) => ({ id: a.id, name: a.name, manifests: store.manifests(a.id) }));
    const status = await environmentStatus(env, apps, hostStateOf(deployments.handoff.reports(hostIds(env))), observer);
    let uat: (PeerStatus & { url?: string }) | { error: string } | undefined;
    if (peer?.configured) { try { uat = await peer.status(); } catch (error) { uat = { error: (error as Error).message }; } }
    return c.json({ ...status, ...(uat ? { peer: uat } : {}), executor: deployments.handoff.executors(env)[0], executors: deployments.handoff.executors(env), hostOf: Object.fromEntries(Object.keys(env.apps).map((a) => [a, hostOf(env, a)])), canDeploy: deployments.canDeploy(p), envEnabled: envVars.enabled, active: store.activeJobs().map((j) => ({ id: j.id, kind: j.kind, app: j.app, version: j.version, state: j.state })) });
  });

  // Drift (§7.1): shown, never changed back.
  api.get("/api/drift", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    return c.json({ drift: drift ? await drift.check() : [] });
  });

  // The daily brief (D25): only here, on the Deployer's home page.
  api.get("/api/brief", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    return c.json({ brief: briefs?.latest() ?? null });
  });
  api.post("/api/brief", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    if (!briefs) return reject(c, 404, "brief/not-configured", "The daily brief is not enabled.");
    if (!p.permissions.includes("deploy-uat") && !p.permissions.includes("deploy-prod")) return reject(c, 403, "auth/forbidden", "Regenerating the brief needs a deploy group.");
    return c.json({ brief: await briefs.generate(p.id) });
  });

  api.get("/api/apps/:id/versions", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const manifests = store.manifests(c.req.param("id"));
    const release = manifests.at(-1)?.release;
    if (!release) return reject(c, 404, "app/unknown", "This app is not in the registry, or its manifest has no release.");
    const listed = await versions.list(release.repo, release.tag);
    const built = store.listJobs({ app: c.req.param("id"), kind: "build", limit: 200 }).filter((j) => j.state === "succeeded").map((j) => j.version);
    // D32: versions no manifest covers yet (older than the first one); they need an assessment before they can deploy.
    const uncovered = listed.versions.filter((v) => !covering(manifests, v));
    return c.json({ ...listed, built: [...new Set(built)], uncovered, deployed: store.deployedVersion(c.req.param("id"))?.version ?? null });
  });

  api.post("/api/apps/:id/plan", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const body = await c.req.json().catch(() => ({})) as { version?: string; pinFrom?: string; override?: { reason?: string } };
    const override = body.override ? { reason: String(body.override.reason ?? "") } : undefined;
    try { return c.json(await deployments.plan(p, c.req.param("id"), String(body.version ?? ""), body.pinFrom, override)); } catch (error) { return deployError(c, error); }
  });

  api.post("/api/apps/:id/deploy", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const body = await c.req.json().catch(() => ({})) as { version?: string; pinFrom?: string; acknowledgeManual?: boolean; override?: { reason?: string }; notice?: { minutes?: number } };
    try {
      const job = await deployments.deploy(p, c.req.param("id"), String(body.version ?? ""), {
        ...(body.pinFrom ? { pinFrom: body.pinFrom } : {}), acknowledgeManual: body.acknowledgeManual === true,
        ...(body.notice ? { notice: { minutes: Number(body.notice.minutes) } } : {}),
        ...(body.override ? { override: { reason: String(body.override.reason ?? "") } } : {}),
      });
      return c.json({ job });
    } catch (error) { return deployError(c, error); }
  });

  // A deploy that waits at a manual step (§4.2): people tick each item, or stop the deploy there.
  api.post("/api/jobs/:id/checks", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const body = await c.req.json().catch(() => ({})) as { component?: string; index?: number; checked?: boolean };
    try { return c.json({ job: await deployments.check(p, c.req.param("id"), String(body.component ?? ""), Number(body.index), body.checked !== false) }); } catch (error) { return deployError(c, error); }
  });

  api.post("/api/jobs/:id/stop", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    try { return c.json({ job: await deployments.stop(p, c.req.param("id")) }); } catch (error) { return deployError(c, error); }
  });

  api.post("/api/apps/:id/build", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const body = await c.req.json().catch(() => ({})) as { version?: string };
    try { return c.json({ jobs: deployments.build(p, c.req.param("id"), String(body.version ?? "")) }); } catch (error) { return deployError(c, error); }
  });

  // Environment variables (§7.2, phase 3). Values come back masked for secrets; admins can reveal one.
  api.get("/api/apps/:id/env", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const revision = c.req.query("revision");
    const version = c.req.query("version");
    try { return c.json(await envVars.view(p, c.req.param("id"), { ...(revision ? { revision: Number(revision) } : {}), ...(version ? { version } : {}) })); } catch (error) { return deployError(c, error); }
  });

  api.put("/api/apps/:id/env", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const body = await c.req.json().catch(() => ({})) as { base?: number | null; values?: { key: string; value?: string; keep?: boolean }[]; note?: string };
    if (!Array.isArray(body.values)) return reject(c, 400, "env/invalid", "The request has no values.");
    try { return c.json({ revision: envVars.save(p, c.req.param("id"), { base: body.base ?? null, values: body.values, ...(body.note ? { note: body.note } : {}) }) }); } catch (error) { return deployError(c, error); }
  });

  api.post("/api/apps/:id/env/revert", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const body = await c.req.json().catch(() => ({})) as { revision?: number; base?: number | null };
    try { return c.json({ revision: envVars.revert(p, c.req.param("id"), Number(body.revision), body.base ?? null) }); } catch (error) { return deployError(c, error); }
  });

  // POST, not GET: a secret value never sits in a URL, and the CSRF token is required.
  api.post("/api/apps/:id/env/reveal", async (c) => {
    const p = await authenticate(c, "admin");
    if (p instanceof Response) return p;
    const body = await c.req.json().catch(() => ({})) as { revision?: number; key?: string };
    try {
      c.header("cache-control", "no-store");
      return c.json({ value: envVars.reveal(p, c.req.param("id"), Number(body.revision), String(body.key ?? "")) });
    } catch (error) { return deployError(c, error); }
  });

  api.post("/api/apps/:id/env/plan", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const body = await c.req.json().catch(() => ({})) as { revision?: number };
    try { return c.json(envVars.plan(p, c.req.param("id"), body.revision === undefined ? undefined : Number(body.revision))); } catch (error) { return deployError(c, error); }
  });

  api.post("/api/apps/:id/env/apply", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const body = await c.req.json().catch(() => ({})) as { revision?: number };
    try { return c.json({ job: envVars.apply(p, c.req.param("id"), Number(body.revision)) }); } catch (error) { return deployError(c, error); }
  });

  api.post("/api/apps/:id/env/import", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    try { return c.json({ job: envVars.importFromServer(p, c.req.param("id")) }); } catch (error) { return deployError(c, error); }
  });

  // §6.3: the same comparison without copy and paste, when this is PROD and UAT's Deployer is configured.
  api.get("/api/apps/:id/env/peer-fingerprint", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    if (!peer?.configured) return reject(c, 404, "peer/not-configured", "No UAT Deployer is configured.");
    try { return c.json(await peer.fingerprint(c.req.param("id"))); } catch (error) {
      if (error instanceof PeerError) return reject(c, 503, "peer/unavailable", error.message);
      throw error;
    }
  });

  // §6.1: artifacts with where and how each was deployed here.
  api.get("/api/artifacts", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const app = c.req.query("app") || undefined;
    const deploys = store.listJobs({ ...(app ? { app } : {}), kind: "deploy", limit: 500 });
    const artifacts = store.artifacts(app).map((a) => ({
      ...a,
      deployments: deploys.filter((j) => j.app === a.app && j.status?.result.digests?.[a.service] === a.digest)
        .map((j) => ({ id: j.id, environment: j.environment, state: j.state, at: j.finishedAt ?? j.requestedAt, by: j.requestedBy, promotion: (j.request.promotion as { basis?: string } | undefined)?.basis ?? null })),
    }));
    return c.json({ artifacts });
  });

  api.get("/api/apps/:id/env/fingerprint", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    try { return c.json(envVars.fingerprint(p, c.req.param("id"))); } catch (error) { return deployError(c, error); }
  });

  api.get("/api/jobs", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    await deployments.sync();
    const jobs = store.listJobs({ ...(c.req.query("app") ? { app: c.req.query("app")! } : {}), ...(c.req.query("kind") ? { kind: c.req.query("kind")! } : {}), limit: Number(c.req.query("limit") ?? 50) });
    return c.json({ jobs: jobs.map(({ request: _request, ...rest }) => rest) });
  });

  api.get("/api/jobs/:id", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    await deployments.sync();
    const job = store.job(c.req.param("id"));
    if (!job) return reject(c, 404, "job/unknown", "No such job.");
    const { request, ...rest } = job;
    return c.json({
      job: rest,
      // The request without the compose text: the fragment is on the plan, and the log has the rest.
      request: { ...request, root: undefined, fragment: undefined },
      log: deployments.handoff.log(job.id),
      ...(request.promotion ? { promotion: request.promotion } : {}),
      ...(job.kind === "deploy" ? { record: deploymentRecord(job, store.app(job.app)?.repo) } : {}),
    });
  });

  api.get("/api/apps", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    return c.json({ apps: store.listApps() });
  });

  api.get("/api/apps/:id", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const app = store.app(c.req.param("id"));
    if (!app) return reject(c, 404, "app/unknown", "This app is not in the registry.");
    return c.json({ app, manifests: store.manifests(app.id) });
  });

  // D38: one manifest with its revision number (the base of a change), by default the newest range's newest revision.
  api.get("/api/apps/:id/manifest", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const id = c.req.param("id");
    if (!store.app(id)) return reject(c, 404, "app/unknown", "This app is not in the registry.");
    const ranges = store.manifestSegments(id);
    const range = c.req.query("applies_from") ? ranges.find((r) => r.appliesFrom === c.req.query("applies_from")) : ranges.at(-1);
    if (!range) return reject(c, 404, "manifest/unknown", `No range from ${c.req.query("applies_from")}; the ranges start at ${ranges.map((r) => r.appliesFrom).join(", ")}.`);
    const revision = c.req.query("revision") ? Number(c.req.query("revision")) : range.revision;
    const manifest = store.manifestRevision(id, range.appliesFrom, revision);
    if (!manifest) return reject(c, 404, "manifest/unknown", `No revision ${revision} of ${id} from ${range.appliesFrom}.`);
    return c.json({ app: id, appliesFrom: range.appliesFrom, revision, newest: revision === range.revision, manifest, ranges });
  });

  // One revision as deploy.json (D27: the manifest can be exported).
  api.get("/api/apps/:id/manifests/:from/:revision", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const manifest = store.manifestRevision(c.req.param("id"), c.req.param("from"), Number(c.req.param("revision")));
    if (!manifest) return reject(c, 404, "manifest/unknown", "No such manifest version.");
    if (c.req.query("download") !== undefined) c.header("content-disposition", `attachment; filename="${manifest.app}-${manifest.appliesFrom}.deploy.json"`);
    return c.json(manifest);
  });

  // D38: a manifest change names the range it changes (appliesFrom) or starts (newAppliesFrom) and the revision it was
  // made on (base), and gives the whole manifest or a JSON Patch on that revision. validate shows the merged manifest,
  // the findings, what changed and which versions it affects, without saving. PROD takes manifests from UAT (D38 ③⑤).
  type ManifestBody = { manifest?: unknown; patch?: unknown; appliesFrom?: unknown; newAppliesFrom?: unknown; base?: unknown; note?: unknown; name?: unknown; repoChange?: unknown };
  const manifestChange = async (p: Principal, appId: string, body: ManifestBody) => {
    const registered = store.app(appId);
    const segments = store.manifestSegments(appId);
    const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    const appliesFrom = text(body.appliesFrom), newAppliesFrom = text(body.newAppliesFrom);
    if (appliesFrom && newAppliesFrom && body.manifest !== undefined) throw new DeployError(400, "manifest/range", "Give appliesFrom (change that range) or newAppliesFrom (start one), not both.");
    let merged: unknown, source: { appliesFrom: string; revision: number } | undefined;
    if (body.patch !== undefined) {
      if (body.manifest !== undefined) throw new DeployError(400, "manifest/change", "Give either patch or manifest, not both.");
      source = segments.find((s) => s.appliesFrom === appliesFrom);
      if (!source) throw new DeployError(400, "manifest/range", `A patch applies to an existing range: give appliesFrom, one of ${segments.map((s) => s.appliesFrom).join(", ") || "none (register the app with a whole manifest first)"}.`);
      if (body.base !== source.revision) throw new DeployError(409, "manifest/stale", `${appId} from ${source.appliesFrom} is at revision ${source.revision}, not ${String(body.base ?? "none")}: read it again (get_manifest) and patch that.`);
      const patched = applyPatch(store.manifestRevision(appId, source.appliesFrom, source.revision)!, body.patch) as { appliesFrom?: unknown };
      if (patched.appliesFrom !== source.appliesFrom) throw new DeployError(400, "manifest/range", "A patch cannot change appliesFrom: start a range with newAppliesFrom instead.");
      merged = newAppliesFrom ? { ...patched, appliesFrom: newAppliesFrom } : patched;
      if (newAppliesFrom && segments.some((s) => s.appliesFrom === newAppliesFrom)) throw new DeployError(400, "manifest/range", `A range from ${newAppliesFrom} exists already: change it with appliesFrom.`);
    } else if (body.manifest !== undefined) {
      merged = body.manifest;
      const target = (merged as { appliesFrom?: unknown })?.appliesFrom;
      if (appliesFrom && target !== appliesFrom) throw new DeployError(400, "manifest/range", `The manifest's appliesFrom is ${String(target)}, not ${appliesFrom}.`);
      if (newAppliesFrom && target !== newAppliesFrom) throw new DeployError(400, "manifest/range", `The manifest's appliesFrom is ${String(target)}, not ${newAppliesFrom}.`);
      source = segments.find((s) => s.appliesFrom === target);
      if (newAppliesFrom && source) throw new DeployError(400, "manifest/range", `A range from ${newAppliesFrom} exists already: change it with appliesFrom.`);
      if (source && body.base !== source.revision) throw new DeployError(409, "manifest/stale", `${appId} from ${source.appliesFrom} is at revision ${source.revision}, not ${String(body.base ?? "none")}: read it again and make the change on that.`);
    } else throw new DeployError(400, "manifest/missing", "The request has no manifest or patch.");
    const m = merged as Manifest;
    if (m?.app !== appId) throw new DeployError(400, "manifest/app-mismatch", `The manifest's app is not ${appId}.`);
    const findings = validateManifest(m);
    if (!findings.length) findings.push(...crossAppConflicts([...store.listApps().filter((a) => a.id !== appId).flatMap((a) => store.manifests(a.id)), m]));
    const warnings: string[] = [];
    // What the change is compared with: the revision it was made on; the range it lands in is the one saved to.
    const before = source ? store.manifestRevision(appId, source.appliesFrom, source.revision) : covering(store.manifests(appId), m.appliesFrom ?? "0.0.0");
    const target = segments.find((s) => s.appliesFrom === m.appliesFrom);
    const repoChange = Boolean(registered && m.release?.repo && registered.repo !== m.release.repo);
    if (repoChange) {
      if (isKey(p)) findings.push(`release.repo: changing the repository (${registered!.repo} → ${m.release!.repo}) is done only on the page, by an administrator`);
      else if (body.repoChange !== true) findings.push(`release.repo: changes the repository from ${registered!.repo} to ${m.release!.repo}; confirm the change to save it`);
      warnings.push(`The repository changes from ${registered!.repo} to ${m.release!.repo}: verify the first deploy after it in UAT.`);
    }
    for (const c of m.components ?? []) {
      const was = before?.components.find((x) => x.id === c.id);
      if (was && JSON.stringify(was.source ?? null) !== JSON.stringify(c.source ?? null)) warnings.push(`${c.id} takes its image from a different source: deploy the affected versions in UAT again before PROD.`);
    }
    // Which versions the range covers: deployed ones went out with their own revision (D31); the others take this one.
    const next = segments.map((s) => s.appliesFrom).filter((v) => /^\d+\.\d+\.\d+/.test(v) && m.appliesFrom && /^\d+\.\d+\.\d+/.test(m.appliesFrom) && compareVersions(v, m.appliesFrom) > 0).sort(compareVersions)[0] ?? null;
    const inRange = (v: string) => /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v) && compareVersions(v, m.appliesFrom) >= 0 && (!next || compareVersions(v, next) < 0);
    const deployedVersions = [...new Set(store.deployRecords(appId).map((r) => r.version))].filter(inRange);
    const listed = m.release && typeof m.appliesFrom === "string" ? await versions.list(m.release.repo, m.release.tag) : { versions: [] as string[], error: "the manifest has no release" };
    const affected = { from: m.appliesFrom ?? null, to: next, deployed: deployedVersions, neverDeployed: listed.versions.filter((v) => inRange(v) && !deployedVersions.includes(v)), ...(listed.error ? { versionsUnknown: listed.error } : {}) };
    const diff = lineDiff(before ? JSON.stringify(before, null, 2) : "", JSON.stringify(m, null, 2));
    return { app: appId, appliesFrom: m.appliesFrom, base: target?.revision ?? null, newRange: !target, manifest: m, findings, warnings, affected, diff, repoChange };
  };
  const manifestError = (c: Context, error: unknown) => {
    if (error instanceof PatchError) return reject(c, 400, "patch/invalid", error.message, [error.at.join("/")]);
    if (error instanceof StoreError) return reject(c, error.code === "manifest/stale" ? 409 : 400, error.code, error.message, error.details);
    return deployError(c, error);
  };
  api.post("/api/apps/:id/manifests/validate", async (c) => {
    const p = await authenticate(c, "admin");
    if (p instanceof Response) return p;
    try { return c.json(await manifestChange(p, c.req.param("id"), await c.req.json().catch(() => ({})) as ManifestBody)); } catch (error) { return manifestError(c, error); }
  });
  api.put("/api/apps/:id/manifests", async (c) => {
    const p = await authenticate(c, "admin");
    if (p instanceof Response) return p;
    if (isProd(deployments.environment().env)) return reject(c, 403, "manifest/prod-read-only", "PROD takes its manifests from UAT with each promotion (D38): change the manifest in UAT.");
    const body = await c.req.json().catch(() => ({})) as ManifestBody;
    try {
      const change = await manifestChange(p, c.req.param("id"), body);
      if (change.findings.length) return reject(c, 400, "manifest/invalid", "The manifest is not valid.", change.findings);
      const saved = store.saveManifest(change.manifest, actorOf(p), {
        base: change.base, repoChange: change.repoChange,
        ...(typeof body.name === "string" && body.name ? { name: body.name } : {}), ...(typeof body.note === "string" && body.note.trim() ? { note: body.note.trim() } : {}),
      });
      return c.json({ ...saved, warnings: change.warnings, affected: change.affected });
    } catch (error) { return manifestError(c, error); }
  });

  // D38 ⑤: PROD's registry follows UAT's: an administrator takes every app's newest manifests from UAT here.
  api.post("/api/registry/from-uat", async (c) => {
    const p = await authenticate(c, "admin");
    if (p instanceof Response) return p;
    try { return c.json(await deployments.takeRegistryFromUat(actorOf(p))); } catch (error) { return deployError(c, error); }
  });

  api.delete("/api/apps/:id", async (c) => {
    const p = await authenticate(c, "admin");
    if (p instanceof Response) return p;
    try {
      store.removeApp(c.req.param("id"), actorOf(p));
      return c.json({ removed: c.req.param("id") });
    } catch (error) {
      if (error instanceof StoreError) return reject(c, 404, error.code, error.message);
      throw error;
    }
  });

  api.get("/api/audit", async (c) => {
    const p = await authenticate(c, "admin");
    if (p instanceof Response) return p;
    const q = (k: string) => c.req.query(k) || undefined;
    return c.json({ entries: store.listAudit(Number(c.req.query("limit") ?? 100), { actor: q("actor"), action: q("action"), target: q("target"), since: q("since") }) });
  });

  api.all("/api/*", (c) => reject(c, 404, "not-found", "No such endpoint."));

  // The built page; unknown paths get index.html so the page's own routes work on reload.
  api.get("*", (c) => {
    const rel = normalize(c.req.path.slice(config.basePath.length).replace(/^\/+/, "") || "index.html");
    if (rel.startsWith("..")) return c.notFound();
    let file = join(config.webDir, rel);
    if (!existsSync(file) || !statSync(file).isFile()) file = join(config.webDir, "index.html");
    if (!existsSync(file)) return c.text("The page has not been built yet: npm run build:web", 503);
    const immutable = rel.startsWith("assets/");
    return c.body(readFileSync(file), 200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" });
  });

  const app = new Hono();
  app.get("/health", (c) => c.json({ status: "ok" }));
  if (config.basePath) app.get("/", (c) => c.redirect(`${config.basePath}/`));
  app.route(config.basePath || "/", api);
  return app;
}
