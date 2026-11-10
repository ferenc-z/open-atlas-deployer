// HTTP surface of the Deployer, phase 1: who am I, the emergency login, the read-only status of
// this environment, and the app registry (admins change it). Everything sits under the base path
// the reverse proxy serves the Deployer at (§9.1).

import { randomBytes, X509Certificate } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Environment, Manifest } from "../compose/generate.ts";
import { compareVersions, covering } from "../manifest/version.ts";
import { crossAppConflicts, validateManifest } from "../manifest/validate.ts";
import { deployPermission, isProd } from "./plan.ts";
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
import { EXECUTOR_KINDS, EXECUTOR_VERSION, ExecutorUnsupported, hostIds, hostOf, newJobId, SERVICE_READ_KINDS, tokenSha256, type ExecutorKind, type Heartbeat } from "./handoff.ts";
import { lineDiff } from "./ingress.ts";
import { environmentStatus, hostStateOf, parseDockerPs, type Observer } from "./observe.ts";
import { StoreError, type Actor, type ServiceConfigDraft, type Store } from "./store.ts";
import { withoutSealed } from "./services/config.ts";
import { ConfigDocError } from "./services/configdoc.ts";
import { redactText } from "./services/redact.ts";
import { acceptChanges, changeSummary, changeView, fileDiffs, outcomeOf, revealValue, sameFiles, secretSubmitted, xmlSecretChanged, type DraftChange } from "./services/configedit.ts";
import { configView } from "./services/configview.ts";
import { catalogFor, profile as profileById, profileFor, PROFILES } from "./services/profiles.ts";
import type { ConfigReviewer } from "./services/configreview.ts";
import { checkConfig, openMembers } from "./services/configcheck.ts";
import { filterStartEnvironment } from "./services/draft.ts";
import { ChangeError, changeView as serviceChangeView, checkContextOf, planView, ServiceChanges } from "./services/changes.ts";
import { adoptedBody, DriftError, hasDrifted, liveDifferences, readLive, serviceDrift, type LiveReadOptions } from "./services/configdrift.ts";
import { installKey, type DraftItem } from "./services/draft.ts";
import { serviceStatus, thresholdsOf, timeline } from "./services/status.ts";
import { alertView, check, parseThresholds, RULES, THRESHOLDS } from "./services/rules.ts";
import { TakeoverError, type Takeover } from "./services/takeover.ts";
import { acceptSamples, watchList } from "./services/watch.ts";
import { FIELDS, ingest, metrics, RANGES, trend, type Field, type Range } from "./services/metrics.ts";
import { DOWNLOAD_MAX, LogsError, parseSearch, ServiceLogs } from "./services/logs.ts";
import { parseLineage, parseProvenance, ServiceProvenance } from "./services/provenance.ts";
import { checkNginx, graphServices, NifiOpsGraph } from "./services/graph-publish.ts";
import { checkNginxUrl } from "./services/graph.ts";
import { streamSSE } from "hono/streaming";
import { DEPLOYER_VERSION } from "./version.ts";
import { validateEnvironment } from "./environment.ts";
import { applyPatch, changedPaths, PatchError } from "./jsonpatch.ts";
import type { Versions } from "./versions.ts";
import { aiStatus, deployerEntry, embedProblem } from "./setup-ai.ts";
import { DEPLOY_GROUPS, environmentFromForm, initialWorkbenchManifest, newWorkbenchEnv, setupStatus, WORKBENCH, withDeployerLink, type SetupEnvironmentForm } from "./setup.ts";
import { WorkbenchAdmin } from "./drivers/workbench.ts";
import { WorkbenchKey } from "./workbench-key.ts";
import { DeployerSettings, SettingsError, STARTED_AT } from "./deployer-settings.ts";

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
  /** §15.6 ③: Workbench's Administration API with the Deployer's key, and where that key comes from. */
  workbench?: WorkbenchAdmin;
  workbenchKey?: WorkbenchKey;
  /** D45: the Deployer's own settings, and how it restarts to apply them (only in the image). */
  deployerSettings?: DeployerSettings;
  restart?: () => void;
  /** §15.4 step 6: how the AI checks reach OMA (tests pass a fake). */
  omaFetcher?: typeof fetch;
  /** §16.3: the AI review of a saved configuration revision; none without OMA. */
  configReview?: Pick<ConfigReviewer, "start">;
  /** §16.3: how long reading a file from a host for its drift waits (tests pass their own timings). */
  liveRead?: LiveReadOptions;
  /** §16.3: the change engine; made here when not given. */
  changes?: ServiceChanges;
  /** Service ops §6: taking over discovered services (drafts, confirmation). */
  takeover?: Takeover;
  /** Phase 2 step 4: reading and following services' logs through their service executors (tests pass their own timings). */
  logs?: ServiceLogs;
  /** Phase 2 step 7 (S28): provenance through the service executors (tests pass their own timings). */
  provenance?: ServiceProvenance;
  /** Phase 2 step 6: the nifi-ops Studio graph, published after takeovers and nginx address changes. */
  graph?: NifiOpsGraph;
  /** How the Deployer checks an nginx address (tests pass a fake). */
  nginxFetcher?: typeof fetch;
}

const reject = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 429 | 503, code: string, message: string, details: string[] = []) =>
  c.json({ error: code, message, ...(details.length ? { details } : {}) }, status);

const actorOf = (p: Principal): Actor => ({ id: p.id, via: p.via });

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".ico": "image/x-icon" };

export function createApp({ config, store, sessions, observer, deployments, versions, env: envVars, peer, keys, onboarding, drift, briefs, takeover, ...deps }: Dependencies): Hono {
  const workbenchKey = deps.workbenchKey ?? new WorkbenchKey(store, config.workbenchApiKeyFile, undefined);
  const workbench = deps.workbench ?? new WorkbenchAdmin(config.workbenchUrl, () => workbenchKey.value());
  const deployerSettings = deps.deployerSettings ?? new DeployerSettings(store, undefined, {});
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
  /** serviceMay: a service key passes though it holds only view (one route: the AI creating a configuration draft, §16.3). */
  async function authenticate(c: Context, need: Permission, serviceMay = false): Promise<Principal | Response> {
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
    if (!principal.permissions.includes(need) && !(serviceMay && principal.via === "service")) return reject(c, 403, "auth/forbidden", need === "admin" ? "Only Workbench admins can do this." : "You are not in any of the deploy-viewer, deploy-uat or deploy-prod groups.");
    if (!isKey(principal) && c.req.method !== "GET" && c.req.header("x-csrf-token") !== principal.csrfToken) return reject(c, 403, "auth/csrf", "The request has no valid CSRF token; reload the page.");
    return principal;
  }

  // D35: the executors. Each host's executor calls in with its own token (dpe_); the Deployer never calls a host.
  // S18: the token also says which of the host's executors calls (deploy or service); each gets only its own jobs.
  const handoff = deployments.handoff;
  const changes = deps.changes ?? new ServiceChanges({ store, handoff, box: takeover?.box, liveRead: deps.liveRead });
  const serviceLogs = deps.logs ?? new ServiceLogs(store, handoff);
  const provenance = deps.provenance ?? new ServiceProvenance(store, handoff, serviceLogs);
  const graph = deps.graph ?? new NifiOpsGraph(store, { studio: undefined, graph: config.nifiOpsGraph });
  const executorOf = (c: Context): { host: string; executor: ExecutorKind } | undefined => {
    const bearer = /^Bearer (dpe_\S+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    return bearer ? store.executorOf(tokenSha256(bearer)) : undefined;
  };
  const executorRoute = (handler: (c: Context, host: string, kind: ExecutorKind) => Promise<Response> | Response) => async (c: Context) => {
    const who = executorOf(c);
    if (!who) return reject(c, 401, "executor/unauthenticated", "An executor token (dpe_) of a registered host is required.");
    return handler(c, who.host, who.executor);
  };
  api.post("/executor/v1/heartbeat", executorRoute(async (c, host, kind) => {
    const beat = await c.req.json() as Heartbeat;
    // A deploy executor from before S18 does not say which it is.
    const says = beat?.executor ?? "deploy";
    if (says !== kind) return reject(c, 409, "executor/kind-mismatch", `This token is for the ${kind} executor of ${host}, but a ${says} executor sent it: issue a ${says} executor token for ${host} on the Hosts page.`);
    handoff.heartbeat(host, beat, kind);
    // §15.2 P5: a service executor's reply carries what it samples, the installations registered on its host.
    return c.json({ ok: true, host, executor: kind, deployer: DEPLOYER_VERSION, ...(kind === "service" ? { watch: watchList(store, host) } : {}) });
  }));
  // §15.3: the collector's samples, at most 20 a request; only those of what the host watches are kept.
  api.post("/executor/v1/samples", executorRoute(async (c, host, kind) => {
    if (kind !== "service") return reject(c, 409, "executor/service-only", "Only a service executor sends samples.");
    if (Number(c.req.header("content-length") ?? 0) > 4 << 20) return reject(c, 400, "samples/too-large", "At most 4 MiB of samples per request.");
    const got = acceptSamples(watchList(store, host), await c.req.json().catch(() => null));
    if ("error" in got) return reject(c, 400, "samples/invalid", got.error);
    ingest(store, got.accepted);
    // §15.3: the rules run as the samples come in (and once a minute, index.ts).
    for (const id of new Set(got.accepted.map((x) => x.service))) {
      try { check(store, (h) => handoff.executor(h, "service"), id); } catch (error) { console.error(`service rules ${id}:`, error); }
    }
    return c.json({ ok: true, accepted: got.accepted.length, dropped: got.dropped });
  }));
  api.get("/executor/v1/jobs/next", executorRoute(async (c, host, kind) => {
    const wait = Math.min(30, Math.max(0, Number(c.req.query("wait") ?? 0))) * 1000;
    // §16.3: a change runs on the service executor, which takes only reads meanwhile. A value not known here must not
    // hand it a change.
    const only = c.req.query("only");
    if (only !== undefined && only !== "read") return reject(c, 400, "executor/bad-only", `only=${only.slice(0, 40)} is not known here.`);
    const job = await handoff.next(host, wait, c.req.raw.signal, kind, only ? SERVICE_READ_KINDS : undefined);
    return job ? c.json({ job }) : c.body(null, 204);
  }));
  const ownJob = (handler: (c: Context, id: string) => Promise<Response>) => executorRoute(async (c, host, kind) => {
    const id = c.req.param("id") ?? "";
    if (!handoff.owns(host, id, kind)) return reject(c, 404, "executor/job-unknown", `${id} is not a job of the ${kind} executor of ${host}.`);
    return handler(c, id);
  });
  api.put("/executor/v1/jobs/:id/status", ownJob(async (c, id) => { handoff.putStatus(id, await c.req.json()); return c.json({ ok: true }); }));
  api.post("/executor/v1/jobs/:id/log", ownJob(async (c, id) => { handoff.appendLog(id, await c.req.text()); return c.json({ ok: true }); }));
  api.put("/executor/v1/jobs/:id/env-content", ownJob(async (c, id) => { handoff.putEnvContent(id, await c.req.text()); return c.json({ ok: true }); }));
  // §15.3: a job's binary content (cut at the request's maxBytes), and a log-tail's chunks (§15.2 P7; {stop: true} when
  // nobody follows any more). Both stay in memory.
  api.put("/executor/v1/jobs/:id/content", ownJob(async (c, id) => {
    if (Number(c.req.header("content-length") ?? 0) > (DOWNLOAD_MAX + (1 << 20))) return reject(c, 400, "content/too-large", "At most 50 MiB of content.");
    return c.json({ ok: true, ...handoff.putContent(id, Buffer.from(await c.req.arrayBuffer())) });
  }));
  api.post("/executor/v1/jobs/:id/chunk", ownJob(async (c, id) => {
    const chunk = await c.req.json().catch(() => null);
    if (!chunk || typeof chunk !== "object") return reject(c, 400, "chunk/invalid", "A chunk is a JSON object.");
    return c.json({ ok: true, ...handoff.putChunk(id, chunk as Record<string, unknown>) });
  }));
  api.post("/executor/v1/state", executorRoute(async (c, host, kind) => {
    if (kind !== "deploy") return reject(c, 409, "executor/deploy-only", "Only a deploy executor reports containers and managed files.");
    const body = await c.req.json() as { containers?: string; files?: Record<string, string> };
    handoff.putState(host, parseDockerPs(String(body.containers ?? "")), body.files ?? {});
    return c.json({ ok: true });
  }));

  // §8.6: a host's executor is upgraded to the version this Deployer ships. The Deployer only names the version; the
  // host takes the release from its own EXECUTOR_UPGRADE_FROM. An executor job's app is executor@<host>; a service
  // executor's (§16.3, S18: its own queue, release archive and EXECUTOR_UPGRADE_FROM) is service-executor@<host>.
  const upgradeApp = (host: string, kind: ExecutorKind) => kind === "service" ? `service-executor@${host}` : `executor@${host}`;
  const upgradeOf = (env: Environment, host: string, kind: ExecutorKind = "deploy") => {
    const info = handoff.executor(host, kind);
    const name = kind === "service" ? "Service executor" : "Executor";
    const last = store.listJobs({ app: upgradeApp(host, kind), kind: "executor-upgrade", limit: 1 })[0];
    const job = last ? { id: last.id, state: last.state, version: last.version, message: last.message, finishedAt: last.finishedAt } : null;
    const version = info.heartbeat?.version;
    const available = Boolean(version && /^\d+\.\d+\.\d+(-.+)?$/.test(version) && compareVersions(version, EXECUTOR_VERSION) < 0);
    // A deploy executor waits for the deploys of its host; a service executor takes no deploy jobs, only its own upgrade counts.
    const busy = store.activeJobs().find((j) => (j.kind === "executor-upgrade" ? j.app === upgradeApp(host, kind) : kind === "deploy" && env.apps[j.app] !== undefined && hostOf(env, j.app) === host));
    // §16.3: only the service executor is held by changes (it restarts, and a running change's steps go through it); a
    // stopped change holds it too. The deploy executor touches no NiFi.
    const holding = kind === "service" ? changes.holding(host) : [];
    const blocked = !available ? undefined
      : !info.online ? info.reason
      : !info.heartbeat?.kinds?.includes("executor-upgrade") ? `${name} ${version} on ${host} cannot upgrade itself: install ${EXECUTOR_VERSION} there by hand once (install.sh)`
      : !info.heartbeat.upgradeFrom ? `EXECUTOR_UPGRADE_FROM is not set on ${host}: set it in ${kind === "service" ? "service-executor.env" : "executor.env"} and restart the ${kind === "service" ? "service " : ""}executor`
      : busy ? `${host} is running ${busy.id}; upgrade when it ends`
      : holding.length ? `${host} is in the middle of change ${holding[0]!.id}${holding[0]!.state === "stopped" ? " (stopped)" : ""}; upgrade when it ends`
      : undefined;
    // The upgrade does not touch the unit: with a KillMode other than process the restart would take NiFi along. Not
    // reported (0.8.0 and older, which cannot start or stop NiFi): nothing to protect, let it through.
    const km = kind === "service" ? info.heartbeat?.control?.killMode : undefined;
    const killModeUnsafe = available && km && km !== "process" ? km : undefined;
    return { available, ...(blocked ? { blocked } : {}), ...(killModeUnsafe ? { killModeUnsafe } : {}), job, from: info.heartbeat?.upgradeFrom ?? null };
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
      : changes.working().length ? `Change ${changes.working()[0]!.id} of ${changes.working()[0]!.service} is in progress; upgrade when it ends`
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

  // D45: the Deployer's own settings. deployer.env wins; what the page saves applies at the next start.
  const deployerSettingsView = () => ({
    settings: deployerSettings.rows(), pending: deployerSettings.pending(), canRestart: !!deps.restart, startedAt: STARTED_AT,
    workbenchKey: { source: workbenchKey.source(), canSet: workbenchKey.canSet() },
  });
  api.get("/api/deployer-settings", async (c) => {
    const p = await authenticate(c, "admin");
    if (p instanceof Response) return p;
    return c.json(deployerSettingsView());
  });
  api.put("/api/deployer-settings", async (c) => {
    const p = await setupAdmin(c);
    if (p instanceof Response) return p;
    const body = await c.req.json().catch(() => ({})) as { changes?: unknown };
    const changes = Array.isArray(body.changes) ? body.changes as { key?: unknown; value?: unknown }[] : [];
    if (!changes.length || changes.some((x) => typeof x?.key !== "string" || (x.value !== null && typeof x.value !== "string"))) return reject(c, 400, "settings/invalid", "Send changes as [{ key, value }], value a string or null.");
    try {
      const changed = deployerSettings.save(changes as { key: string; value: string | null }[], actorOf(p));
      return c.json({ changed, ...deployerSettingsView() });
    } catch (error) {
      if (error instanceof SettingsError) return reject(c, 400, "settings/invalid", error.message, error.details);
      throw error;
    }
  });
  api.post("/api/deployer-settings/restart", async (c) => {
    const p = await setupAdmin(c);
    if (p instanceof Response) return p;
    if (!deps.restart) return reject(c, 409, "settings/no-restart", "This Deployer does not run from its image, so it cannot restart itself: restart it where it runs.");
    const active = store.activeJobs();
    if (active.length) return reject(c, 409, "settings/busy", `Wait for the running jobs to end: ${active.map((j) => j.id).join(", ")}.`);
    store.audit(actorOf(p), "deployer.restart", "deployer", { pending: deployerSettings.rows().filter((r) => r.pending).map((r) => r.key) });
    deps.restart();
    return c.json({ restarting: true }, 202);
  });

  // §15 (D41): the first setup, up to Workbench and its API key. The state is worked out on every call.
  const setupContext = () => ({
    store, deployments, env: envVars, workbench, workbenchKey, workbenchUrl: config.workbenchUrl, workbenchReachable: () => sessions.reachable(),
    basePath: config.basePath, initialManifestsDir: config.initialManifestsDir,
  });
  /** Setup changes that touch Workbench or secrets: an administrator's browser session. */
  const setupAdmin = async (c: Context): Promise<Principal | Response> => {
    const p = await authenticate(c, "admin");
    if (p instanceof Response) return p;
    if (isKey(p)) return reject(c, 403, "auth/browser-only", "This setup step is done on the page, not with an API key.");
    return p;
  };
  api.get("/api/setup", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const status = await setupStatus(setupContext(), p);
    return c.json(config.devSkipSetup ? { ...status, complete: true, devSkipped: true } : status);
  });
  // Step 1: the first environment settings from a form, instead of a hand-written environment.json.
  api.post("/api/setup/environment", async (c) => {
    const p = await authenticate(c, "admin");
    if (p instanceof Response) return p;
    if (store.environmentRevision()) return reject(c, 409, "setup/environment-exists", "The environment settings exist already: change them in Environment settings.");
    if (existsSync(config.environmentFile)) return reject(c, 409, "setup/environment-file", `${config.environmentFile} exists and is imported as revision 1; remove it to use the form.`);
    const { environment, findings } = environmentFromForm(await c.req.json().catch(() => ({})) as SetupEnvironmentForm);
    if (findings.length) return reject(c, 400, "environment/invalid", "The environment settings are not valid.", findings.map((f) => `${f.at}: ${f.expected}`));
    try {
      const saved = store.saveEnvironment(environment, null, actorOf(p), { note: "Created on the Setup page" });
      return c.json({ revision: saved.revision, environment: saved.environment }, 201);
    } catch (error) {
      if (error instanceof StoreError) return reject(c, 409, error.code, error.message);
      throw error;
    }
  });
  // Step 3: the Workbench manifest the image ships, only while the registry has none (§15.6 ②); PROD takes UAT's.
  api.post("/api/setup/workbench-manifest", async (c) => {
    const p = await authenticate(c, "admin");
    if (p instanceof Response) return p;
    let env: Environment;
    try { env = deployments.environment().env; } catch { return reject(c, 409, "setup/no-environment", "Save the environment settings first."); }
    if (isProd(env)) return reject(c, 403, "manifest/prod-read-only", "PROD takes its manifests from UAT (D38): take the registry from UAT.");
    if (store.app(WORKBENCH)) return reject(c, 409, "setup/workbench-registered", "Workbench is in the registry already: change its manifest on its page.");
    try {
      const saved = store.saveManifest(initialWorkbenchManifest(config.initialManifestsDir), actorOf(p), { name: "Workbench", note: "Imported from the manifest this Deployer ships (Setup)" });
      return c.json(saved, 201);
    } catch (error) {
      if (error instanceof StoreError) return reject(c, 400, error.code, error.message, error.details);
      return reject(c, 503, "setup/no-manifest", (error as Error).message);
    }
  });

  // Step 4: a new Workbench's environment variables, generated; the initial admin's password is in this answer only.
  api.post("/api/setup/workbench-env", async (c) => {
    const p = await setupAdmin(c);
    if (p instanceof Response) return p;
    const body = await c.req.json().catch(() => ({})) as { adminEmail?: unknown; deployerUrl?: unknown };
    const email = String(body.adminEmail ?? "").trim();
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) return reject(c, 400, "setup/admin-email", "Give the initial admin's email address.");
    let deployerUrl: string | undefined;
    if (body.deployerUrl !== undefined && body.deployerUrl !== "") {
      try { deployerUrl = new URL(String(body.deployerUrl)).href; } catch { return reject(c, 400, "setup/deployer-url", "The Deployer's address is not a URL."); }
    }
    if (!store.app(WORKBENCH)) return reject(c, 409, "setup/workbench-unregistered", "Import the Workbench manifest first.");
    if (envVars.latestValues(WORKBENCH)) return reject(c, 409, "setup/workbench-env-exists", "Workbench's environment variables exist already: change them under Environment variables.");
    const url = deployments.endpointOf(WORKBENCH)?.url ?? "";
    const { values, password } = newWorkbenchEnv(email, deployerUrl, url.startsWith("https:"));
    try {
      const revision = envVars.save(p, WORKBENCH, { base: null, values: Object.entries(values).map(([key, value]) => ({ key, value })), note: "Generated on the Setup page" });
      // The file is read once, so the first write knows what it replaces (a new server has none).
      let job: string | null = null;
      try { job = envVars.importFromServer(p, WORKBENCH).id; } catch { job = null; }
      return c.json({ revision, password, job }, 201);
    } catch (error) { return deployError(c, error); }
  });
  // Step 6: the Deployer's Workbench API key, checked by using it before it is kept (§15.6 ③).
  api.put("/api/setup/workbench-key", async (c) => {
    const p = await setupAdmin(c);
    if (p instanceof Response) return p;
    const can = workbenchKey.canSet();
    if (!can.ok) return reject(c, 409, "setup/key-not-settable", can.reason);
    const key = String(((await c.req.json().catch(() => ({}))) as { key?: unknown }).key ?? "").trim();
    if (!key || key.length > 4096 || /\s/.test(key)) return reject(c, 400, "setup/key", "Paste the key from Workbench Administration → API keys.");
    try { await workbench.groups(key); } catch (error) { return reject(c, 400, "setup/key-refused", `Workbench does not accept the key: ${(error as Error).message}`); }
    workbenchKey.save(key, actorOf(p));
    return c.json({ source: "page" });
  });
  api.delete("/api/setup/workbench-key", async (c) => {
    const p = await setupAdmin(c);
    if (p instanceof Response) return p;
    if (workbenchKey.source() !== "page") return reject(c, 409, "setup/key-not-on-page", "No key was pasted on this page.");
    workbenchKey.clear(actorOf(p));
    return c.json({ source: workbenchKey.source() });
  });
  // Step 7: the deploy Groups that are missing, created in Workbench with the Deployer's key.
  api.post("/api/setup/workbench-groups", async (c) => {
    const p = await setupAdmin(c);
    if (p instanceof Response) return p;
    try {
      const have = await workbench.groups();
      const created: string[] = [];
      for (const [name, description] of DEPLOY_GROUPS) {
        if (have.some((g) => g.name === name)) continue;
        await workbench.createGroup(name, description);
        created.push(name);
      }
      store.audit(actorOf(p), "setup.workbench-groups", WORKBENCH, { created });
      return c.json({ created });
    } catch (error) { return reject(c, 503, "setup/workbench", (error as Error).message); }
  });
  // Step 8: the Deployer added to WORKBENCH_APP_LINKS as a new revision of Workbench's environment variables.
  api.post("/api/setup/workbench-applinks", async (c) => {
    const p = await setupAdmin(c);
    if (p instanceof Response) return p;
    let url: string;
    try { url = new URL(String(((await c.req.json().catch(() => ({}))) as { deployerUrl?: unknown }).deployerUrl ?? "")).href; } catch { return reject(c, 400, "setup/deployer-url", "Give the Deployer's address, e.g. https://uat.example.internal:8495/deploy/."); }
    const latest = envVars.latestValues(WORKBENCH);
    if (!latest) return reject(c, 409, "setup/workbench-env-missing", "The Deployer does not keep Workbench's environment variables yet.");
    const links = withDeployerLink(latest.values.WORKBENCH_APP_LINKS, url);
    try {
      const values = [...Object.keys(latest.values).filter((k) => k !== "WORKBENCH_APP_LINKS").map((key) => ({ key, keep: true })), { key: "WORKBENCH_APP_LINKS", value: links }];
      return c.json({ revision: envVars.save(p, WORKBENCH, { base: latest.revision, values, note: "Deployer added to WORKBENCH_APP_LINKS (Setup)" }) });
    } catch (error) { return deployError(c, error); }
  });

  // Step 6 (L3, optional): what the AI features need, checked against OMA and Workbench; apart from /api/setup because
  // it calls both and the pages ask for it only where it is shown.
  api.get("/api/setup/ai", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    return c.json(await aiStatus({
      store, workbench, basePath: config.basePath, workbenchPublicUrl: config.workbenchPublicUrl, ...(deps.omaFetcher ? { fetcher: deps.omaFetcher } : {}),
      oma: {
        ...(config.omaUrl ? { url: config.omaUrl } : {}), ...(config.omaApiKeyFile ? { keyFile: config.omaApiKeyFile } : {}), ...(config.omaApplicationId ? { applicationId: config.omaApplicationId } : {}),
        ...(config.omaAgent ? { agent: config.omaAgent } : {}), ...(config.omaEnvironment ? { environment: config.omaEnvironment } : {}), vaults: config.omaVaults,
        ...(config.omaAssessorAgent ? { assessorAgent: config.omaAssessorAgent } : {}), ...(config.omaAssessorEnvironment ? { assessorEnvironment: config.omaAssessorEnvironment } : {}), assessorVaults: config.omaAssessorVaults,
      },
    }));
  });
  // The Deployer's entry in Workbench's application list (chat.embed), visible to the deploy groups; an entry that is
  // there already keeps its other fields.
  api.post("/api/setup/workbench-entry", async (c) => {
    const p = await setupAdmin(c);
    if (p instanceof Response) return p;
    let url: string;
    try { url = new URL(String(((await c.req.json().catch(() => ({}))) as { deployerUrl?: unknown }).deployerUrl ?? "")).href; } catch { return reject(c, 400, "setup/deployer-url", "Give the Deployer's address, e.g. https://uat.example.internal:8495/deploy/."); }
    if (!url.startsWith("https:") && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url)) return reject(c, 400, "setup/deployer-https", "Workbench embeds its chat only in https pages on its own domain: open the Deployer by its https address.");
    const problem = embedProblem(url, config.workbenchPublicUrl);
    if (problem) return reject(c, 400, "setup/deployer-embed", `${url}: ${problem}. Give the address people open the Deployer by.`);
    try {
      const plugins = await workbench.plugins();
      const { dataTokenConfigured: _t, graphTokens: _g, visibility: _v, linkedAgents: _a, ...existing } = (plugins.find((x) => x.id === "deployer") ?? {}) as Record<string, unknown>;
      await workbench.putPlugin("deployer", deployerEntry(url, Object.keys(existing).length ? existing : undefined));
      const groups = (await workbench.groups()).filter((g) => DEPLOY_GROUPS.some(([name]) => name === g.name)).map((g) => g.id);
      await workbench.setVisibility("deployer", groups);
      store.audit(actorOf(p), "setup.workbench-entry", "deployer", { url, groups: groups.length });
      return c.json({ url, groups: groups.length });
    } catch (error) { return reject(c, 503, "setup/workbench", (error as Error).message); }
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
        tokens: tokens.filter((t) => t.host === id).map(({ executor, prefix, createdAt, createdBy, revokedAt }) => ({ executor, prefix, createdAt, createdBy, revokedAt })),
        upgrade: upgradeOf(env, id),
        // S18: the host's service executor, once it has a token or has called in; it takes no deploy jobs.
        service: hasServiceExecutor(id) ? handoff.executor(id, "service") : null,
        serviceUpgrade: hasServiceExecutor(id) ? upgradeOf(env, id, "service") : null,
      })),
    });
  });
  // S18: a host has a service executor once it has a token or has called in.
  const hasServiceExecutor = (host: string) => store.executorTokens().some((t) => t.host === host && t.executor === "service") || Boolean(store.executorBeat(host, "service"));
  const executorRow = (env: Environment, host: string, kind: ExecutorKind) => {
    const e = handoff.executor(host, kind);
    return { host, online: e.online, ...(e.reason ? { reason: e.reason } : {}), version: e.heartbeat?.version ?? null, upgrade: upgradeOf(env, host, kind) };
  };
  const startExecutorUpgrade = (actor: Actor, host: string, kind: ExecutorKind = "deploy") => {
    const { env } = deployments.environment();
    if (!hostIds(env).includes(host)) throw new DeployError(404, "host/unknown", `${host} is not a host of this environment (environment settings hosts).`);
    const upgrade = upgradeOf(env, host, kind);
    const name = kind === "service" ? "service executor" : "executor";
    if (!upgrade.available) throw new DeployError(409, "executor/up-to-date", `The ${name} on ${host} is not older than ${EXECUTOR_VERSION}.`);
    if (upgrade.blocked) throw new DeployError(409, "executor/upgrade-blocked", upgrade.blocked);
    if (upgrade.killModeUnsafe) throw new DeployError(409, "upgrade/killmode-unsafe", `The service executor's unit on ${host} has KillMode=${upgrade.killModeUnsafe}: restarting it would stop the NiFi it started. Add KillMode=process to the unit, run systemctl daemon-reload, then upgrade.`);
    const id = newJobId("executor-upgrade");
    const request = { kind: "executor-upgrade", version: EXECUTOR_VERSION };
    store.addJob({ id, kind: "executor-upgrade", app: upgradeApp(host, kind), version: EXECUTOR_VERSION, environment: env.name, fromVersion: handoff.executor(host, kind).heartbeat?.version ?? null, manifest: null, pinFrom: null, request }, actor);
    handoff.submit(id, { ...request, requestedBy: actor.id }, host, kind);
    return store.job(id)!;
  };
  api.post("/api/hosts/:id/upgrade-executor", async (c) => {
    const p = await authenticate(c, "admin");
    if (p instanceof Response) return p;
    if (isKey(p)) return reject(c, 403, "auth/browser-only", "Executor upgrades are started only from a browser session, not API keys.");
    const which = ((await c.req.json().catch(() => ({}))) as { executor?: unknown }).executor ?? "deploy";
    if (which !== "deploy" && which !== "service") return reject(c, 400, "executor/kind", "executor is deploy or service.");
    try { return c.json({ job: startExecutorUpgrade(actorOf(p), c.req.param("id"), which) }, 201); } catch (error) { return deployError(c, error); }
  });

  // D39: every outdated executor, one host after the other; a failed or rolled-back one stops the rest.
  type Batch = { by: Actor; startedAt: string; current: { host: string; job: string } | null; remaining: string[]; done: string[]; stopped?: string; finishedAt?: string };
  const batchOf = (): Batch | null => { const raw = store.setting("executor-upgrade-batch"); return raw ? JSON.parse(raw) as Batch : null; };
  const saveBatch = (b: Batch) => store.setSetting("executor-upgrade-batch", JSON.stringify(b), { id: "deployer", via: "cli" });
  // A batch entry is a host (its deploy executor) or "<host>/service" (its service executor).
  const startBatchEntry = (by: Actor, entry: string) => entry.endsWith("/service") ? startExecutorUpgrade(by, entry.slice(0, -"/service".length), "service") : startExecutorUpgrade(by, entry);
  const nextInBatch = (b: Batch) => {
    while (b.remaining.length) {
      const host = b.remaining.shift()!;
      try { b.current = { host, job: startBatchEntry(b.by, host).id }; return; } catch (error) { b.current = null; b.stopped = `${host}: ${(error as Error).message}`; return; }
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
    const hosts = hostIds(env).flatMap((h) => [
      ...(() => { const u = upgradeOf(env, h); return u.available && !u.blocked ? [h] : []; })(),
      ...(hasServiceExecutor(h) ? (() => { const u = upgradeOf(env, h, "service"); return u.available && !u.blocked && !u.killModeUnsafe ? [`${h}/service`] : []; })() : []),
    ]);
    if (!hosts.length) return reject(c, 409, "executor/none-outdated", "No executor can be upgraded now.");
    const b: Batch = { by: actorOf(p), startedAt: new Date().toISOString(), current: null, remaining: hosts, done: [] };
    try { b.current = { host: hosts[0]!, job: startBatchEntry(b.by, hosts[0]!).id }; b.remaining.shift(); } catch (error) { return deployError(c, error); }
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
      executors: hostIds(env).flatMap((id) => [
        { executor: "deploy" as ExecutorKind, ...executorRow(env, id, "deploy") },
        ...(hasServiceExecutor(id) ? [{ executor: "service" as ExecutorKind, ...executorRow(env, id, "service") }] : []),
      ]),
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
    // S18: which of the host's executors the token is for; deploy unless the body says service.
    const executor = (await c.req.json().catch(() => ({})) as { executor?: unknown }).executor ?? "deploy";
    if (!EXECUTOR_KINDS.includes(executor as ExecutorKind)) return reject(c, 400, "host/executor-kind", `executor is one of ${EXECUTOR_KINDS.join(", ")}.`);
    const token = `dpe_${randomBytes(24).toString("base64url")}`;
    store.addExecutorToken(host, tokenSha256(token), token.slice(0, 10), { id: p.id, via: p.via }, executor as ExecutorKind);
    return c.json({ host, executor, token }, 201);
  });
  api.post("/api/hosts/:id/revoke", async (c) => {
    const p = await authenticate(c, "admin");
    if (p instanceof Response) return p;
    // S18: one executor's tokens when the body names it, otherwise every token of the host.
    const executor = (await c.req.json().catch(() => ({})) as { executor?: unknown }).executor;
    if (executor !== undefined && !EXECUTOR_KINDS.includes(executor as ExecutorKind)) return reject(c, 400, "host/executor-kind", `executor is one of ${EXECUTOR_KINDS.join(", ")}.`);
    return c.json({ revoked: store.revokeExecutorTokens(c.req.param("id"), { id: p.id, via: p.via }, executor as ExecutorKind | undefined) });
  });

  // Service ops §6 step 2: discovery on a host's service executor (svc-discover). It only reads: the NiFi running there
  // (from their processes) and the installations named in dirs (ones not running, or unpacked somewhere uncommon). The
  // result stays with its job; the newest one is what GET returns. Taking over (the model, the draft) builds on it.
  api.post("/api/hosts/:id/discover", async (c) => {
    const p = await authenticate(c, "admin");
    if (p instanceof Response) return p;
    const host = c.req.param("id");
    if (!hostIds(deployments.environment().env).includes(host)) return reject(c, 404, "host/unknown", `${host} is not a host of this environment (environment settings hosts).`);
    const body = await c.req.json().catch(() => ({})) as { dirs?: unknown };
    // Each entry: an installation's path, or {install, conf} when its conf directory is elsewhere and bootstrap.conf's
    // conf.dir does not say so. {install} alone goes on as the plain path (what older service executors understand).
    const path = (v: unknown): v is string => typeof v === "string" && v.startsWith("/") && !v.includes("\0") && v.length <= 1024;
    const raw = body.dirs ?? [];
    const dirs = Array.isArray(raw) && raw.length <= 32 ? raw.map((d): string | { install: string; conf: string } | undefined => {
      if (path(d)) return d;
      if (!d || typeof d !== "object" || Array.isArray(d) || Object.keys(d).some((k) => k !== "install" && k !== "conf")) return undefined;
      const { install, conf } = d as { install?: unknown; conf?: unknown };
      if (!path(install) || (conf !== undefined && conf !== null && conf !== "" && !path(conf))) return undefined;
      return path(conf) ? { install, conf } : install;
    }) : undefined;
    if (!dirs || dirs.some((d) => d === undefined))
      return reject(c, 400, "discover/dirs", "dirs is a list of at most 32 NiFi installations: absolute paths, or {install, conf} with the installation's conf directory as well.");
    const executor = handoff.executor(host, "service");
    if (!executor.online) return reject(c, 409, "discover/executor-offline", executor.reason ?? `The service executor on ${host} is offline.`);
    if (!executor.heartbeat?.kinds?.includes("svc-discover")) return reject(c, 409, "discover/executor-old", `Service executor ${executor.heartbeat?.version} on ${host} cannot discover services; upgrade it first.`);
    const id = newJobId("svc-discover");
    // P1: secret values come back as fingerprints under this Deployer's key, so a cluster's nodes can be compared.
    handoff.submit(id, { kind: "svc-discover", dirs, timeoutSeconds: 60, requestedBy: p.id, ...(takeover ? { fingerprintKey: takeover.fingerprintKey() } : {}) }, host, "service");
    store.audit(actorOf(p), "service.discover", host, { job: id, dirs });
    return c.json({ id, host, dirs, state: "queued" }, 201);
  });
  api.get("/api/hosts/:id/discover", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const host = c.req.param("id");
    const id = c.req.query("job") ?? store.latestExecutorJob(host, "service", "svc-discover");
    const job = id ? store.executorJob(id) : undefined;
    if (!id || !job || job.host !== host || job.executor !== "service" || job.request.kind !== "svc-discover")
      return reject(c, 404, "discover/none", `No discovery on ${host}${c.req.query("job") ? ` with id ${c.req.query("job")}` : " yet"}.`);
    const s = job.status;
    return c.json({
      id, host, dirs: job.request.dirs ?? [], state: s?.state ?? (job.pickedAt ? "running" : "queued"),
      message: s?.message ?? null, startedAt: s?.startedAt ?? null, finishedAt: s?.finishedAt ?? null,
      result: s?.state === "succeeded" ? s.result : null, log: handoff.log(id, 16 * 1024),
    });
  });

  // Service ops §6 steps 3 and 5: takeover drafts. A draft is made from the hosts' newest discoveries, grouped and
  // assessed by rules (P1); an administrator edits and confirms it, which imports every installation's configuration as
  // revision 1 and registers it. The AI review is optional.
  const takeoverFailed = (c: Context, error: unknown) => {
    if (error instanceof TakeoverError) return reject(c, error.status, error.code, error.message, error.details);
    if (error instanceof StoreError) return reject(c, error.code === "draft/unknown" || error.code === "draft/item-unknown" ? 404 : error.code === "draft/item-invalid" ? 400 : 409, error.code, error.message, error.details);
    throw error;
  };
  const noTakeover = (c: Context) => reject(c, 503, "takeover/off", "Taking over services is not set up in this Deployer.");
  api.get("/api/services", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const configured = (id: string) => store.serviceConfigRevisions(id)[0]?.revision ?? null;
    // Step 6: with each its members' status in short (running at the newest discovery, executors online).
    // S23: and each member's state in the members' order, for the table view's node rows.
    // Phase 2: live states, and the cards' small trends (heap, queue) over the last hour.
    const now = new Date();
    const status = (id: string) => { const st = serviceStatus(store, (h) => handoff.executor(h, "service"), id, now); return { status: st?.summary ?? null, states: st?.members.map((m) => m.state) ?? [], trend: trend(store, id, now) }; };
    return c.json({
      standalones: store.standalones().map((s) => ({ ...s, configRevision: configured(s.id), ...status(s.id) })),
      clusters: store.clusters().map((s) => ({ ...s, configRevision: configured(s.id), ...status(s.id) })),
    });
  });
  api.get("/api/services/:id/config", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const revision = c.req.query("revision");
    const cfg = store.serviceConfig(c.req.param("id"), revision === undefined ? undefined : Number(revision));
    if (!cfg) return reject(c, 404, "service-config/none", `No configuration${revision ? ` revision ${revision}` : ""} for ${c.req.param("id")}.`);
    // S24: parsed rows with each key's catalog section and default status, and for a cluster the node comparison
    // (secrets compared on the sealed values, shown only as labels).
    const registered = store.standalones().find((s) => s.id === cfg.service) ?? store.clusters().find((s) => s.id === cfg.service);
    const view = registered ? configView(cfg.body, registered.profile, registered.version, registered.kind, takeover?.unsealer()) : null;
    return c.json({ ...cfg, body: withoutSealed(cfg.body), revisions: store.serviceConfigRevisions(cfg.service), view, canDraft: mayEditConfig(p), canReveal: p.permissions.includes("admin") && !isKey(p) });
  });
  // Phase 3 (§7, §16.3): configuration drafts and revisions. A draft is changes on a revision; saving makes the next
  // revision and changes nothing on the hosts. Seeing them takes deploy-viewer, with secrets hidden; changing them takes the
  // environment's deploy group, on PROD only from a browser session (D7); a secret's value only an admin in a browser.
  const mayEditConfig = (p: Principal) => {
    const env = deployments.environment().env;
    return p.permissions.includes(deployPermission(env)) && !(isProd(env) && isKey(p));
  };
  const configEditor = async (c: Context, serviceMay = false): Promise<Principal | Response> => {
    let env: Environment;
    try { env = deployments.environment().env; } catch (error) { return deployError(c, error); }
    const p = await authenticate(c, deployPermission(env), serviceMay);
    if (p instanceof Response) return p;
    if (isProd(env) && isKey(p) && p.via !== "service") return reject(c, 403, "auth/browser-only", "On PROD the configuration is changed only from a browser session, not API keys.");
    return p;
  };
  /** The service, its newest revision and the key its files are sealed with, or the answer why there are none. */
  const configOf = (c: Context) => {
    const id = c.req.param("id")!;
    const service = registeredService(id);
    if (!service) return reject(c, 404, "service/unknown", `No standalone instance or cluster ${id}.`);
    const latest = store.serviceConfig(id);
    if (!latest) return reject(c, 404, "service-config/none", `No configuration for ${id}.`);
    const box = takeover?.box;
    if (!box) return reject(c, 503, "config/no-key", "DEPLOYER_CREDENTIAL_ENCRYPTION_KEY is not set: configuration files cannot be opened.");
    return { id, service, latest, box };
  };
  const serviceMembers = (service: NonNullable<ReturnType<typeof registeredService>>) => (service.kind === "standalone" ? [service.member] : service.nodes);
  const driftFailed = (c: Context, error: unknown) => {
    if (error instanceof DriftError) return reject(c, error.status, error.code, error.message, error.details);
    return configFailed(c, error);
  };
  const configFailed = (c: Context, error: unknown) => {
    if (error instanceof ConfigDocError) return reject(c, error.code === "config/reimport" ? 409 : 400, error.code, error.message);
    if (error instanceof StoreError) return reject(c, error.code === "config-draft/unknown" ? 404 : 409, error.code, error.message, error.details);
    throw error;
  };
  /** What the checks look at besides the files: the other services' ports, and each host's memory from its newest sample. */
  const checkContext = (service: NonNullable<ReturnType<typeof registeredService>>) => checkContextOf(store, service);
  const draftView = (d: ServiceConfigDraft, latest: number) => {
    const { changes, ...rest } = d;
    return { ...rest, changes: changes.map((x) => changeView(x, takeover?.box)), stale: d.state === "open" && d.base !== latest };
  };
  /** What an open draft would make of its base: the files that differ (redacted) and what the change means. */
  const draftPreview = (d: ServiceConfigDraft, service: NonNullable<ReturnType<typeof registeredService>>) => {
    const box = takeover?.box, base = store.serviceConfig(d.service, d.base);
    if (d.state !== "open" || !box || !base) return null;
    try {
      const out = outcomeOf(base.body, d.changes, box, checkContext(service));
      return { findings: out.findings, change: out.change, members: fileDiffs(base.body.members, out.body.members, box) };
    } catch (error) {
      if (error instanceof ConfigDocError) return { problem: { code: error.code, message: error.message } };
      throw error;
    }
  };
  // Free text that reaches the timeline, and through it the AI: what looks like a password goes no further.
  const noteOf = (v: unknown): string | null => (typeof v === "string" && v.trim() ? redactText(v.trim().slice(0, 2000)) : null);
  const tooLarge = (c: Context) => (Number(c.req.header("content-length") ?? 0) > 8 << 20 ? reject(c, 400, "config-draft/too-large", "At most 8 MiB in a request.") : undefined);
  api.get("/api/services/:id/config/diff", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const cfg = configOf(c);
    if (cfg instanceof Response) return cfg;
    const number = (name: string) => {
      const raw = c.req.query(name);
      return raw === undefined ? undefined : Number.isInteger(Number(raw)) ? Number(raw) : NaN;
    };
    const toAsked = number("to"), fromAsked = number("from");
    if (Number.isNaN(toAsked) || Number.isNaN(fromAsked)) return reject(c, 400, "config-diff/revision", "from and to are revision numbers.");
    const to = toAsked === undefined ? cfg.latest : store.serviceConfig(cfg.id, toAsked);
    if (!to) return reject(c, 404, "service-config/none", `No configuration revision ${toAsked} for ${cfg.id}.`);
    const fromRevision = fromAsked ?? to.base ?? to.revision - 1;
    const from = store.serviceConfig(cfg.id, fromRevision);
    if (!from && fromAsked !== undefined) return reject(c, 404, "service-config/none", `No configuration revision ${fromAsked} for ${cfg.id}.`);
    const member = c.req.query("member") || undefined;
    if (member && ![...to.body.members, ...(from?.body.members ?? [])].some((m) => installKey(m) === member)) return reject(c, 404, "config/unknown-member", `${member} is not a member of ${cfg.id}.`);
    return c.json({ service: cfg.id, from: from?.revision ?? null, to: to.revision, members: fileDiffs(from?.body.members ?? [], to.body.members, cfg.box, member) });
  });
  // §16.3: "back to revision N": its files saved as the newest revision, then applied like any other. Nothing on the hosts
  // changes here. Files the newest already has make no new revision. Not reviewed by the AI: these files have been kept before.
  api.post("/api/services/:id/config/rollback", async (c) => {
    const p = await configEditor(c);
    if (p instanceof Response) return p;
    const cfg = configOf(c);
    if (cfg instanceof Response) return cfg;
    const body = await c.req.json().catch(() => ({})) as { revision?: unknown; note?: unknown };
    if (!Number.isInteger(body.revision)) return reject(c, 400, "config-rollback/invalid", "Give the revision to go back to.");
    const target = store.serviceConfig(cfg.id, body.revision as number);
    if (!target) return reject(c, 404, "service-config/none", `No revision ${String(body.revision)} of ${cfg.id}.`);
    if (sameFiles(target.body.members, cfg.latest.body.members)) return c.json({ revision: cfg.latest.revision, saved: false, findings: [] });
    const context = checkContext(cfg.service);
    const findings = context.profile ? checkConfig({ ...context, profile: context.profile, members: openMembers(target.body.members, cfg.box), base: openMembers(cfg.latest.body.members, cfg.box) }).findings : [];
    try {
      const revision = store.saveServiceConfigRollback(cfg.id, { from: target.revision, base: cfg.latest.revision, body: target.body, findings, note: noteOf(body.note) }, actorOf(p));
      return c.json({ revision, saved: true, findings }, 201);
    } catch (error) {
      if (error instanceof StoreError) return reject(c, 409, error.code, error.message);
      throw error;
    }
  });
  // §16.3: how a member is started when it has not been seen running: what `stop` would otherwise have read from the process.
  // An admin's browser session only: it runs as the service user. The same filter as at takeover; values do not come back.
  api.put("/api/services/:id/members/:member/start", async (c) => {
    const p = await authenticate(c, "admin");
    if (p instanceof Response) return p;
    if (isKey(p)) return reject(c, 403, "auth/browser-only", "A start environment is set only from a browser session, not with API keys.");
    const id = c.req.param("id")!, member = c.req.param("member")!;
    const service = registeredService(id);
    if (!service) return reject(c, 404, "service/unknown", `No standalone instance or cluster ${id}.`);
    const m = serviceMembers(service).find((x) => installKey(x) === member);
    if (!m) return reject(c, 404, "config/unknown-member", `${member} is not a member of ${id}.`);
    const holding = store.activeServiceChange(id);
    if (holding) return reject(c, 409, "service-change/active", `Change ${holding.id} is ${holding.state}: set this when it has ended.`);
    const body = await c.req.json().catch(() => ({})) as { environment?: unknown };
    const given = body.environment;
    if (!given || typeof given !== "object" || Array.isArray(given) || Object.values(given).some((v) => typeof v !== "string")) return reject(c, 400, "member-start/invalid", "environment is names to strings; {} forgets what is kept.");
    const { kept, dropped } = filterStartEnvironment(given as Record<string, unknown>);
    const names = Object.keys(kept ?? {}).sort();
    store.setServiceMemberStart(id, member, names.length ? kept : null, m.startLimits ?? null);
    store.audit(actorOf(p), "service.member-start", `${id}/${member}`, { names, dropped });
    return c.json({ kept: names, dropped });
  });
  api.post("/api/services/:id/config/reveal", async (c) => {
    const p = await authenticate(c, "admin");
    if (p instanceof Response) return p;
    if (isKey(p)) return reject(c, 403, "auth/browser-only", "A secret's value is shown only in a browser session, not to API keys.");
    const cfg = configOf(c);
    if (cfg instanceof Response) return cfg;
    const body = await c.req.json().catch(() => ({})) as { revision?: unknown; member?: unknown; file?: unknown; key?: unknown; index?: unknown };
    if (typeof body.file !== "string" || typeof body.key !== "string") return reject(c, 400, "config-reveal/invalid", "Give file and key, and member and revision if needed.");
    if (body.index !== undefined && (!Number.isInteger(body.index) || (body.index as number) < 0)) return reject(c, 400, "config-reveal/invalid", "index is which of the same-named XML secrets, from 0.");
    const revision = body.revision === undefined ? cfg.latest : typeof body.revision === "number" ? store.serviceConfig(cfg.id, body.revision) : undefined;
    if (!revision) return reject(c, 404, "service-config/none", `No configuration revision ${String(body.revision)} for ${cfg.id}.`);
    if (body.member === undefined && revision.body.members.length > 1) return reject(c, 400, "config-reveal/invalid", "Give member: this service has several.");
    const member = body.member === undefined ? revision.body.members[0] : revision.body.members.find((m) => installKey(m) === body.member);
    const file = member?.files.find((f) => f.name === body.file);
    if (!member || !file) return reject(c, 404, "config-reveal/none", "That revision has no such member or file.");
    try {
      const got = revealValue(file, body.key, cfg.box, body.index as number | undefined);
      if (!got) return reject(c, 404, "config-reveal/none", `${body.file} has no ${body.key} to show.`);
      store.audit(actorOf(p), "service.config-revealed", `${cfg.id}#${revision.revision}`, { member: installKey(member), file: body.file, key: body.key });
      c.header("cache-control", "no-store");
      return c.json({ revision: revision.revision, member: installKey(member), file: body.file, key: body.key, ...got });
    } catch (error) { return configFailed(c, error); }
  });
  api.get("/api/services/:id/config/drafts", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const id = c.req.param("id");
    if (!registeredService(id)) return reject(c, 404, "service/unknown", `No standalone instance or cluster ${id}.`);
    const state = c.req.query("state");
    if (state !== undefined && !["open", "saved", "discarded"].includes(state)) return reject(c, 400, "config-draft/state", "state is open, saved or discarded.");
    const latest = store.serviceConfig(id)?.revision ?? 0;
    return c.json({ drafts: store.serviceConfigDrafts(id, state as "open" | undefined).map((d) => draftView(d, latest)) });
  });
  api.get("/api/services/:id/config/drafts/:draft", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const id = c.req.param("id");
    const service = registeredService(id);
    const d = store.serviceConfigDraft(id, c.req.param("draft"));
    if (!service || !d) return reject(c, 404, "config-draft/unknown", `No configuration draft ${c.req.param("draft")} of ${id}.`);
    return c.json({ ...draftView(d, store.serviceConfig(id)?.revision ?? 0), preview: draftPreview(d, service) });
  });
  // §16.3: the Assistant's service key may create a draft, on PROD too; a person still saves it (every other draft route
  // keeps it out). What the AI submits (the service key, or ai: true from draft_service_config) touches no secret.
  api.post("/api/services/:id/config/drafts", async (c) => {
    const p = await configEditor(c, true);
    if (p instanceof Response) return p;
    const cfg = configOf(c);
    if (cfg instanceof Response) return cfg;
    const big = tooLarge(c);
    if (big) return big;
    const body = await c.req.json().catch(() => ({})) as { base?: unknown; changes?: unknown; note?: unknown; ai?: unknown };
    if (body.base !== undefined && body.base !== cfg.latest.revision) return reject(c, 409, "config-draft/stale", `The configuration of ${cfg.id} is at revision ${cfg.latest.revision}, not ${String(body.base)}: read it again and make the change on that.`);
    const byAi = p.via === "service" || body.ai === true;
    const personOnly = (what: string) => reject(c, 400, "config/secret-by-person", `${what} holds a secret: the AI does not touch those. Nothing was drafted. Ask the person to enter it on the Configuration tab, and draft the other changes without it.`);
    if (byAi) {
      const secret = secretSubmitted(body.changes);
      if (secret) return personOnly(secret);
      if (!Array.isArray(body.changes) || !body.changes.length) return reject(c, 400, "config-draft/empty", "Give at least one change.");
    }
    try {
      const changes = acceptChanges(body.changes ?? [], cfg.latest.body, cfg.service.kind, cfg.box);
      if (byAi) {
        const secret = xmlSecretChanged(changes, cfg.latest.body, cfg.service.kind, cfg.box);
        if (secret) return personOnly(secret);
      }
      const { findings } = outcomeOf(cfg.latest.body, changes, cfg.box, checkContext(cfg.service));
      const d = store.createServiceConfigDraft({ service: cfg.id, base: cfg.latest.revision, changes, note: noteOf(body.note), findings, audit: changes.map(changeSummary) }, actorOf(p));
      return c.json({ ...draftView(d, cfg.latest.revision), kind: cfg.service.kind, preview: draftPreview(d, cfg.service) }, 201);
    } catch (error) { return configFailed(c, error); }
  });
  // The whole draft again: what the page shows goes back as it is (a secret as hidden: true, XML with its "(hidden)").
  // base: moves the draft to the newest revision, after someone else saved one.
  api.put("/api/services/:id/config/drafts/:draft", async (c) => {
    const p = await configEditor(c);
    if (p instanceof Response) return p;
    const cfg = configOf(c);
    if (cfg instanceof Response) return cfg;
    const big = tooLarge(c);
    if (big) return big;
    const was = store.serviceConfigDraft(cfg.id, c.req.param("draft")!);
    if (!was) return reject(c, 404, "config-draft/unknown", `No configuration draft ${c.req.param("draft")} of ${cfg.id}.`);
    if (was.state !== "open") return reject(c, 409, "config-draft/closed", `Configuration draft ${was.id} is ${was.state}.`);
    const body = await c.req.json().catch(() => ({})) as { base?: unknown; changes?: unknown; note?: unknown };
    if (body.base !== undefined && body.base !== cfg.latest.revision) return reject(c, 409, "config-draft/stale", `The configuration of ${cfg.id} is at revision ${cfg.latest.revision}, not ${String(body.base)}.`);
    const base = body.base !== undefined ? cfg.latest : store.serviceConfig(cfg.id, was.base);
    if (!base) return reject(c, 404, "service-config/none", `No configuration revision ${was.base} for ${cfg.id}.`);
    try {
      const changes: DraftChange[] = body.changes === undefined ? was.changes : acceptChanges(body.changes, base.body, cfg.service.kind, cfg.box, was.changes);
      const { findings } = outcomeOf(base.body, changes, cfg.box, checkContext(cfg.service));
      const d = store.updateServiceConfigDraft(cfg.id, was.id, { base: base.revision, changes, note: body.note === undefined ? was.note : noteOf(body.note), findings, audit: changes.map(changeSummary) }, actorOf(p));
      return c.json({ ...draftView(d, cfg.latest.revision), preview: draftPreview(d, cfg.service) });
    } catch (error) { return configFailed(c, error); }
  });
  api.delete("/api/services/:id/config/drafts/:draft", async (c) => {
    const p = await configEditor(c);
    if (p instanceof Response) return p;
    const id = c.req.param("id")!;
    try { return c.json(draftView(store.discardServiceConfigDraft(id, c.req.param("draft")!, actorOf(p)), store.serviceConfig(id)?.revision ?? 0)); } catch (error) { return configFailed(c, error); }
  });
  api.post("/api/services/:id/config/drafts/:draft/save", async (c) => {
    const p = await configEditor(c);
    if (p instanceof Response) return p;
    const cfg = configOf(c);
    if (cfg instanceof Response) return cfg;
    const d = store.serviceConfigDraft(cfg.id, c.req.param("draft")!);
    if (!d) return reject(c, 404, "config-draft/unknown", `No configuration draft ${c.req.param("draft")} of ${cfg.id}.`);
    if (d.state !== "open") return reject(c, 409, "config-draft/closed", `Configuration draft ${d.id} is ${d.state}.`);
    if (d.base !== cfg.latest.revision) return reject(c, 409, "config-draft/stale", `The configuration of ${cfg.id} is at revision ${cfg.latest.revision}, this draft was made on ${d.base}: move it to the newest revision first.`);
    const body = await c.req.json().catch(() => ({})) as { note?: unknown };
    try {
      const out = outcomeOf(cfg.latest.body, d.changes, cfg.box, checkContext(cfg.service));
      if (sameFiles(out.split?.members ?? cfg.latest.body.members, out.body.members)) return reject(c, 409, "config-draft/no-change", "This draft changes nothing in any file.");
      const revision = store.saveServiceConfigDraft(cfg.id, d.id, { split: out.split, body: out.body, findings: out.findings, note: noteOf(body.note) ?? d.note, audit: d.changes.map(changeSummary) }, actorOf(p));
      // §16.3: advice, after the fact: the save does not wait for it and cannot fail because of it.
      deps.configReview?.start(cfg.id, revision, { findings: out.findings, change: out.change }).catch((error) => console.error("config review:", error));
      return c.json({ revision, findings: out.findings, change: out.change, draft: draftView(store.serviceConfigDraft(cfg.id, d.id)!, revision) }, 201);
    } catch (error) { return configFailed(c, error); }
  });
  const serviceKnown = (c: Context) => (registeredService(c.req.param("id")!) ? undefined : reject(c, 404, "service/unknown", `No standalone instance or cluster ${c.req.param("id")}.`));
  // §13, §16.3: changes. Anyone who sees a service sees its plans and changes; carrying one out takes the environment's
  // deploy group, on PROD only from a browser session (D7). Service keys (the AI) never: it only reads.
  const changeOperator = async (c: Context): Promise<Principal | Response> => {
    let env: Environment;
    try { env = deployments.environment().env; } catch (error) { return deployError(c, error); }
    const p = await authenticate(c, deployPermission(env));
    if (p instanceof Response) return p;
    if (isProd(env) && isKey(p)) return reject(c, 403, "auth/browser-only", "On PROD changes are made only from a browser session, not API keys.");
    return p;
  };
  const changeFailed = (c: Context, error: unknown) => {
    if (error instanceof ChangeError) return reject(c, error.status, error.code, error.message, error.details);
    if (error instanceof StoreError && error.code === "service-change/active") return reject(c, 409, error.code, error.message);
    return driftFailed(c, error);
  };
  api.get("/api/services/:id/changes", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const unknown = serviceKnown(c);
    if (unknown) return unknown;
    const id = c.req.param("id")!;
    return c.json({ changes: store.serviceChanges(id).map((x) => serviceChangeView(x)), active: store.activeServiceChange(id)?.id ?? null });
  });
  api.get("/api/services/:id/changes/:change", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const unknown = serviceKnown(c);
    if (unknown) return unknown;
    const found = store.serviceChange(c.req.param("id")!, c.req.param("change")!);
    if (!found) return reject(c, 404, "service-change/unknown", `No change ${c.req.param("change")} of ${c.req.param("id")}.`);
    return c.json(serviceChangeView(found, store.serviceChangeSteps(found.id)));
  });
  api.post("/api/services/:id/changes/plan", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    try { return c.json(planView(await changes.plan(c.req.param("id")!, await c.req.json().catch(() => ({}))))); } catch (error) { return changeFailed(c, error); }
  });
  api.post("/api/services/:id/changes", async (c) => {
    const p = await changeOperator(c);
    if (p instanceof Response) return p;
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    try { return c.json(serviceChangeView(await changes.start(c.req.param("id")!, body, noteOf(body.reason), actorOf(p))), 201); } catch (error) { return changeFailed(c, error); }
  });
  for (const [name, act] of [["continue", "resume"], ["stop", "halt"], ["rollback", "rollback"], ["force-kill", "forceKill"], ["close", "close"]] as const) {
    api.post(`/api/services/:id/changes/:change/${name}`, async (c) => {
      const p = await changeOperator(c);
      if (p instanceof Response) return p;
      try {
        const id = c.req.param("id")!, change = c.req.param("change")!;
        const out = act === "close"
          ? changes.close(id, change, actorOf(p), ((await c.req.json().catch(() => ({}))) as { filesMayBeMixed?: unknown }).filesMayBeMixed === true)
          : changes[act](id, change, actorOf(p));
        return c.json(serviceChangeView(out, store.serviceChangeSteps(out.id)));
      } catch (error) { return changeFailed(c, error); }
    });
  }
  api.get("/api/services/:id/drift", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const unknown = serviceKnown(c);
    if (unknown) return unknown;
    const id = c.req.param("id")!;
    const status = serviceStatus(store, (h) => handoff.executor(h, "service"), id)!;
    const rows = store.serviceMemberFiles(id);
    const drift = serviceDrift(status, rows);
    const asked = c.req.query("member");
    if (!asked) return c.json(drift);
    const cfg = configOf(c);
    if (cfg instanceof Response) return cfg;
    const m = serviceMembers(cfg.service).find((x) => installKey(x) === asked);
    if (!m) return reject(c, 404, "config/unknown-member", `${asked} is not a member of ${id}.`);
    const own = rows.filter((f) => f.member === asked);
    const names = own.filter(hasDrifted).map((f) => f.file);
    if (!names.length) return c.json({ ...drift, differences: { member: asked, files: [] } });
    try {
      const live = await readLive(handoff, m, own, names, p.id, deps.liveRead);
      const expected = (name: string) => {
        const row = own.find((f) => f.file === name)!;
        return store.serviceConfig(id, row.revision)?.body.members.find((x) => installKey(x) === asked)?.files.find((f) => f.name === name);
      };
      return c.json({ ...drift, differences: liveDifferences(m, live, expected, cfg.box) });
    } catch (error) { return driftFailed(c, error); }
  });
  // §16.3: the host's file becomes what is kept and what it should be. Nothing on the host changes. What the person saw
  // must still be what the host has: sha256 is checked against a new read, and the content is sealed from that read.
  api.post("/api/services/:id/drift/adopt", async (c) => {
    const p = await configEditor(c);
    if (p instanceof Response) return p;
    const cfg = configOf(c);
    if (cfg instanceof Response) return cfg;
    const body = await c.req.json().catch(() => ({})) as { member?: unknown; file?: unknown; sha256?: unknown; replacePending?: unknown; note?: unknown };
    if (typeof body.member !== "string" || typeof body.file !== "string" || typeof body.sha256 !== "string") return reject(c, 400, "drift/invalid", "Give member, file and the sha256 the differences showed.");
    const holding = store.activeServiceChange(cfg.id);
    if (holding) return reject(c, 409, "drift/change-active", `Change ${holding.id} is ${holding.state}: files may be in the middle of it. Finish or close it first.`);
    const m = serviceMembers(cfg.service).find((x) => installKey(x) === body.member);
    const own = store.serviceMemberFiles(cfg.id).filter((f) => f.member === body.member);
    const row = own.find((f) => f.file === body.file);
    if (!m || !row) return reject(c, 404, "drift/unknown-file", `${cfg.id} has no ${body.file} on ${body.member}.`);
    try {
      const [live] = await readLive(handoff, m, own, [row.file], p.id, deps.liveRead);
      if (!live?.bytes) throw new DriftError(409, "drift/missing", `${row.file} is gone from the host: there is nothing to adopt.`);
      if (live.sha256 !== body.sha256) throw new DriftError(409, "drift/changed", `${row.file} has changed on the host since the differences were shown: look at them again.`);
      if (live.sha256 === row.expectedSha256) throw new DriftError(409, "drift/none", `${row.file} is what it should be: there is nothing to adopt.`);
      const latest = store.serviceConfig(cfg.id)!;
      const kept = latest.body.members.find((x) => installKey(x) === body.member)?.files.find((f) => f.name === row.file);
      const same = kept?.sha256 === live.sha256;
      // A saved revision not applied yet changes this file: adopting would take its change out of the newest revision.
      if (!same && kept?.sha256 !== row.expectedSha256 && body.replacePending !== true) throw new DriftError(409, "drift/pending", `Revision ${latest.revision} changes ${row.file} and has not been applied: adopting replaces that change. Send replacePending to go on.`);
      const out = same ? { split: null, body: null } : adoptedBody(latest.body, cfg.service.kind, row.member, { ...live, bytes: live.bytes }, cfg.box);
      const context = checkContext(cfg.service);
      const findings = out.body && context.profile ? checkConfig({ ...context, profile: context.profile, members: openMembers(out.body.members, cfg.box), base: openMembers(latest.body.members, cfg.box) }).findings : [];
      const revision = store.adoptServiceFile(cfg.id, { member: row.member, file: row.file, base: latest.revision, expected: row.expectedSha256, sha256: live.sha256!, split: out.split, body: out.body, findings, note: noteOf(body.note) }, actorOf(p));
      check(store, (h) => handoff.executor(h, "service"), cfg.id);
      return c.json({ revision, saved: Boolean(out.body), findings }, out.body ? 201 : 200);
    } catch (error) { return driftFailed(c, error); }
  });
  api.get("/api/services/drafts", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const state = c.req.query("state");
    if (state !== undefined && !["open", "confirmed", "discarded"].includes(state)) return reject(c, 400, "draft/state", "state is open, confirmed or discarded.");
    return c.json({ drafts: store.serviceDrafts(state as "open" | undefined) });
  });
  // §10 lookup_property: the profiles' property catalog, for a registered service (its profile and version) or a profile
  // and version; key = exact key, q = words in the key or its description; file narrows to nifi.properties or bootstrap.conf.
  api.get("/api/service-properties", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const q = (k: string) => c.req.query(k) || undefined;
    const service = q("service") ? registeredService(q("service")!) : undefined;
    if (q("service") && !service) return reject(c, 404, "service/unknown", `No standalone instance or cluster ${q("service")}.`);
    const version = service?.version ?? q("version");
    const prof = service ? profileById(service.profile) : q("profile") ? profileById(q("profile")!) : version ? profileFor("nifi", version)?.profile : undefined;
    if (!prof) return reject(c, 400, "properties/profile", `Give service, profile (${PROFILES.map((x) => x.id).join(", ")}) or version.`);
    const file = q("file");
    if (file && !prof.files.some((f) => f.name === file)) return reject(c, 400, "properties/file", `file is one of ${prof.files.map((f) => f.name).join(", ")}.`);
    const key = q("key"), words = q("q")?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
    const pool = version ? catalogFor(prof, version) : prof.catalog;
    const entries = pool.filter((e) => (!file || e.file === file) && (!key || e.key === key) && words.every((w) => `${e.key} ${e.description} ${e.note ?? ""}`.toLowerCase().includes(w)));
    const limit = Math.min(200, Math.max(1, Number(q("limit") ?? 50) || 50));
    // A key this version does not have, but another of the profile's versions does: say since/until.
    const elsewhere = key && !entries.length ? prof.catalog.filter((e) => e.key === key && (!file || e.file === file)) : [];
    return c.json({
      profile: prof.id, version: version ?? null, tested: prof.tested, ...(service ? { service: service.id } : {}),
      entries: entries.slice(0, limit), more: Math.max(0, entries.length - limit),
      ...(elsewhere.length ? { otherVersions: elsewhere } : {}),
    });
  });
  // Step 6: one standalone instance or cluster with its members' status (get_cluster_status).
  api.get("/api/services/:id/status", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const status = serviceStatus(store, (h) => handoff.executor(h, "service"), c.req.param("id"));
    return status ? c.json(status) : reject(c, 404, "service/unknown", `No standalone instance or cluster ${c.req.param("id")}.`);
  });
  const registeredService = (id: string) => store.standalones().find((s) => s.id === id) ?? store.clusters().find((s) => s.id === id);
  // §15.3: a service's numbers per member, range=1h|6h|2d|30d or from/to (ISO), step in seconds, member, fields (comma-separated).
  api.get("/api/services/:id/metrics", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const id = c.req.param("id");
    if (!registeredService(id)) return reject(c, 404, "service/unknown", `No standalone instance or cluster ${id}.`);
    const now = new Date();
    const range = c.req.query("range");
    if (range !== undefined && !(range in RANGES)) return reject(c, 400, "metrics/range", `range is one of ${Object.keys(RANGES).join(", ")}.`);
    const to = c.req.query("to") ? new Date(c.req.query("to")!) : now;
    const from = c.req.query("from") ? new Date(c.req.query("from")!) : new Date(to.getTime() - RANGES[(range ?? "1h") as Range] * 1000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) return reject(c, 400, "metrics/time", "from and to are ISO times, from before to.");
    const step = c.req.query("step") ? Number(c.req.query("step")) : undefined;
    if (step !== undefined && !(step >= 10 && step <= 86400)) return reject(c, 400, "metrics/step", "step is 10 to 86400 seconds.");
    const fields = c.req.query("fields")?.split(",").filter(Boolean);
    const unknown = fields?.filter((f) => !(f in FIELDS));
    if (unknown?.length) return reject(c, 400, "metrics/fields", `Unknown fields: ${unknown.join(", ")}.`, Object.keys(FIELDS));
    const member = c.req.query("member");
    return c.json(metrics(store, id, { from, to, now, ...(step ? { step } : {}), ...(member ? { member } : {}), ...(fields ? { fields: fields as Field[] } : {}) }));
  });
  // §15.3: the bulletins taken from the samples, newest first (level, from, to, limit ≤ 1000).
  api.get("/api/services/:id/bulletins", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const id = c.req.param("id");
    if (!registeredService(id)) return reject(c, 404, "service/unknown", `No standalone instance or cluster ${id}.`);
    const q = (k: string) => c.req.query(k) || undefined;
    const level = q("level")?.toUpperCase();
    return c.json({ bulletins: store.serviceBulletins(id, { ...(q("from") ? { from: q("from")! } : {}), ...(q("to") ? { to: q("to")! } : {}), ...(level ? { level } : {}), ...(q("limit") ? { limit: Number(q("limit")) } : {}) }) });
  });
  // Phase 2 step 7 (§9.5, S28): the FlowFile trace, read by a member's service executor from its NiFi (deploy-viewer,
  // §13): whether this version and the executors can; the searchable fields; events of a FlowFile UUID or a field's
  // value in a time range (required); a FlowFile's lineage or an event's parents and children; one event's details.
  api.get("/api/services/:id/provenance", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    return c.json(provenance.info(c.req.param("id")));
  });
  api.get("/api/services/:id/provenance/options", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    return c.json(await provenance.options(c.req.param("id")));
  });
  api.post("/api/services/:id/provenance", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const q = parseProvenance(await c.req.json().catch(() => ({})));
    if ("error" in q) return reject(c, 400, "provenance/search", q.error);
    return c.json(await provenance.search(c.req.param("id"), q));
  });
  api.post("/api/services/:id/lineage", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const q = parseLineage(await c.req.json().catch(() => ({})));
    if ("error" in q) return reject(c, 400, "provenance/lineage", q.error);
    return c.json(await provenance.lineage(c.req.param("id"), q));
  });
  api.get("/api/services/:id/provenance/events/:eventId", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const eventId = Number(c.req.param("eventId"));
    if (!/^\d{1,15}$/.test(c.req.param("eventId"))) return reject(c, 400, "provenance/event", "The event id is a number.");
    return c.json(await provenance.event(c.req.param("id"), eventId, c.req.query("node") || undefined));
  });
  // Phase 2 step 4 (§9.3, §15.3): a service's logs, read through its members' service executors (deploy-viewer, §13):
  // the members with their log directories and the WARN/ERROR summary; a member's files; a search of all (or some)
  // members in parallel, merged by time; a member's files as a tar.gz; following one file (SSE, shared per file).
  api.get("/api/services/:id/logs", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const id = c.req.param("id");
    const members = serviceLogs.members(id);
    if (!members) return reject(c, 404, "service/unknown", `No standalone instance or cluster ${id}.`);
    const hours = Math.min(720, Math.max(1, Number(c.req.query("hours") ?? 24) || 24));
    const since = new Date(Date.now() - hours * 3600_000).toISOString();
    return c.json({ members, hours, patterns: store.serviceLogPatterns(id, { since, limit: Number(c.req.query("limit") ?? 100) || 100 }), tails: serviceLogs.tailing().filter((t) => t.service === id) });
  });
  api.get("/api/services/:id/logs/files", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    return c.json(await serviceLogs.files(c.req.param("id"), c.req.query("member") ?? ""));
  });
  api.get("/api/services/:id/logs/lines", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const lines = Number(c.req.query("lines") ?? 200);
    if (!(Number.isInteger(lines) && lines >= 1 && lines <= 5000)) return reject(c, 400, "logs/lines", "lines is 1 to 5000.");
    return c.json(await serviceLogs.lines(c.req.param("id"), c.req.query("member") ?? "", c.req.query("file") || "nifi-app.log", lines));
  });
  api.post("/api/services/:id/logs/search", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const q = parseSearch(await c.req.json().catch(() => ({})));
    if ("error" in q) return reject(c, 400, "logs/search", q.error);
    return c.json(await serviceLogs.search(c.req.param("id"), q));
  });
  api.get("/api/services/:id/logs/download", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const id = c.req.param("id"), member = c.req.query("member") ?? "";
    const files = (c.req.query("files") ?? "nifi-app.log").split(",").filter(Boolean);
    const got = await serviceLogs.download(id, member, files);
    store.audit(actorOf(p), "service.logs.download", id, { member, files: got.result.files ?? files, bytes: got.data.length });
    return c.body(new Uint8Array(got.data), 200, { "content-type": "application/gzip", "content-disposition": `attachment; filename="${got.name}"`, "cache-control": "no-store" });
  });
  // §15.2 P7: Server-Sent Events of one member's file: "lines" (text; first the recent lines, backlog) and "state".
  api.get("/api/services/:id/logs/tail", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const id = c.req.param("id"), member = c.req.query("member") ?? "", file = c.req.query("file") || "nifi-app.log";
    const events: { event: string; data: string }[] = [];
    let wake: (() => void) | null = null;
    // Checked before the stream starts, so a refusal is an ordinary error answer.
    const stop = serviceLogs.tail(id, member, file, (e) => { events.push({ event: e.type, data: JSON.stringify(e) }); wake?.(); });
    c.header("x-accel-buffering", "no");
    c.header("cache-control", "no-store");
    return streamSSE(c, async (stream) => {
      let open = true;
      stream.onAbort(() => { open = false; stop(); wake?.(); });
      try {
        while (open) {
          while (events.length) await stream.writeSSE(events.shift()!);
          await new Promise<void>((resolve) => { const t = setTimeout(resolve, 15_000); wake = () => { clearTimeout(t); resolve(); }; });
          wake = null;
          if (open && !events.length) await stream.writeSSE({ event: "ping", data: "{}" });
        }
      } finally { stop(); }
    });
  });
  // Phase 2 step 3 (§15.3): a service's alerts (open first, then resolved; state=open|resolved, limit), with the rules and
  // the thresholds in effect; its timeline; an admin's threshold overrides; every service's alerts.
  api.get("/api/services/:id/alerts", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const id = c.req.param("id");
    const s = registeredService(id);
    if (!s) return reject(c, 404, "service/unknown", `No standalone instance or cluster ${id}.`);
    const state = c.req.query("state");
    if (state !== undefined && state !== "open" && state !== "resolved") return reject(c, 400, "alerts/state", "state is open or resolved.");
    const limit = c.req.query("limit") ? Number(c.req.query("limit")) : 200;
    return c.json({
      alerts: store.serviceAlerts({ service: id, ...(state ? { state } : {}), limit }).map(alertView),
      rules: RULES, thresholds: { ...thresholdsOf(store, id, s.profile), info: THRESHOLDS },
      canEdit: p.permissions.includes("admin") && !isKey(p),
    });
  });
  api.get("/api/services/:id/events", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const id = c.req.param("id");
    if (!registeredService(id)) return reject(c, 404, "service/unknown", `No standalone instance or cluster ${id}.`);
    const q = (k: string) => c.req.query(k) || undefined;
    return c.json({ events: timeline(store, id, { ...(q("from") ? { from: q("from")! } : {}), ...(q("to") ? { to: q("to")! } : {}), ...(q("kind") ? { kind: q("kind")! } : {}), ...(q("limit") ? { limit: Number(q("limit")) } : {}) }) });
  });
  api.put("/api/services/:id/thresholds", async (c) => {
    const p = await authenticate(c, "admin");
    if (p instanceof Response) return p;
    const id = c.req.param("id");
    const s = registeredService(id);
    if (!s) return reject(c, 404, "service/unknown", `No standalone instance or cluster ${id}.`);
    const got = parseThresholds(await c.req.json().catch(() => null), thresholdsOf(store, id, s.profile).defaults);
    if ("error" in got) return reject(c, 400, "thresholds/invalid", got.error, got.details);
    store.setServiceThresholds(id, got.overrides as Record<string, number>, actorOf(p));
    // The alerts follow the new thresholds at once.
    const result = check(store, (h) => handoff.executor(h, "service"), id);
    return c.json({ thresholds: { ...thresholdsOf(store, id, s.profile), info: THRESHOLDS }, check: result ?? null });
  });
  // Phase 2 step 6 (§9.4, §15.3): where operations put a service behind nginx (all nodes of a cluster behind one
  // address; nginx holds the NiFi client certificate). Setting it checks /flow/about through it once and generates the
  // nifi-ops graph again, published to Studio in the background (recorded); clearing it (null) takes the service out.
  api.put("/api/services/:id/nginx", async (c) => {
    const p = await authenticate(c, "admin");
    if (p instanceof Response) return p;
    const id = c.req.param("id");
    const s = registeredService(id);
    if (!s) return reject(c, 404, "service/unknown", `No standalone instance or cluster ${id}.`);
    const body = await c.req.json().catch(() => null) as { nginxUrl?: unknown } | null;
    if (!body || !("nginxUrl" in body)) return reject(c, 400, "nginx/invalid", "The body is {\"nginxUrl\": \"http(s)://…\"}, or null to clear it.");
    let url: string | null = null;
    if (body.nginxUrl !== null && body.nginxUrl !== "") {
      const checked = checkNginxUrl(body.nginxUrl);
      if ("error" in checked) return reject(c, 400, "nginx/invalid", checked.error);
      url = checked.url;
    }
    const changed = url !== (s.nginxUrl ?? null);
    if (changed) store.setServiceNginxUrl(id, url, actorOf(p));
    const check = url ? await checkNginx(url, deps.nginxFetcher) : null;
    if (check) store.setServiceNginxCheck(id, check);
    if (changed) graph.schedule(url ? `nginx address of ${id} set` : `nginx address of ${id} removed`, actorOf(p));
    return c.json({ nginxUrl: url, check, changed, graph: { name: graph.graph, configured: graph.configured } });
  });
  api.post("/api/services/:id/nginx/check", async (c) => {
    const p = await authenticate(c, "admin");
    if (p instanceof Response) return p;
    const id = c.req.param("id");
    const s = registeredService(id);
    if (!s) return reject(c, 404, "service/unknown", `No standalone instance or cluster ${id}.`);
    if (!s.nginxUrl) return reject(c, 409, "nginx/none", `${id} has no nginx address.`);
    const check = await checkNginx(s.nginxUrl, deps.nginxFetcher);
    store.setServiceNginxCheck(id, check);
    return c.json({ nginxUrl: s.nginxUrl, check });
  });
  // The nifi-ops graph: its name, whether Studio is configured, the services in it and the last runs; an admin may
  // publish it again now (e.g. after Studio was unreachable).
  api.get("/api/services/graph", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    return c.json({ graph: graph.graph, configured: graph.configured, services: graphServices(store), runs: store.graphRuns(Number(c.req.query("limit") ?? 10) || 10), canPublish: p.permissions.includes("admin") });
  });
  // §16.2: removing a service only stops managing it (NiFi and its files are not touched). An admin's browser session; refused while a change holds it.
  api.delete("/api/services/:id", async (c) => {
    const p = await authenticate(c, "admin");
    if (p instanceof Response) return p;
    if (isKey(p)) return reject(c, 403, "auth/browser-only", "A service is removed only from a browser session, not with API keys.");
    const id = c.req.param("id")!;
    try {
      const was = registeredService(id);
      const done = store.removeService(id, actorOf(p));
      if (was?.nginxUrl) graph.schedule(`service ${id} removed`, actorOf(p));
      return c.json({ removed: done.id, kind: done.kind, members: done.members });
    } catch (error) {
      if (error instanceof StoreError) return reject(c, error.code === "service/unknown" ? 404 : 409, error.code, error.message);
      throw error;
    }
  });
  api.post("/api/services/graph/publish", async (c) => {
    const p = await authenticate(c, "admin");
    if (p instanceof Response) return p;
    return c.json(await graph.publish("published again by hand", actorOf(p)));
  });
  // Every service's open alerts, and with state=all also those resolved in the last day (since=ISO for longer).
  api.get("/api/alerts", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const state = c.req.query("state") ?? "open";
    if (!["open", "resolved", "all"].includes(state)) return reject(c, 400, "alerts/state", "state is open, resolved or all.");
    const since = c.req.query("since") ?? new Date(Date.now() - 86_400_000).toISOString();
    const services = new Map([...store.standalones(), ...store.clusters()].map((x) => [x.id, { kind: x.kind, environment: x.environment, profile: x.profile }] as const));
    const alerts = store.serviceAlerts({ ...(state === "all" ? { since } : { state: state as "open" | "resolved" }), limit: Number(c.req.query("limit") ?? 500) })
      .filter((a) => services.has(a.service)).map((a) => ({ ...alertView(a), ...services.get(a.service)! }));
    return c.json({ alerts, open: alerts.filter((a) => a.state === "open").length, rules: RULES });
  });
  api.post("/api/services/drafts", async (c) => {
    const p = await authenticate(c, "admin");
    if (p instanceof Response) return p;
    if (!takeover) return noTakeover(c);
    const body = await c.req.json().catch(() => ({})) as { hosts?: unknown };
    if (body.hosts !== undefined && (!Array.isArray(body.hosts) || !body.hosts.every((h) => typeof h === "string"))) return reject(c, 400, "draft/hosts", "hosts is a list of host ids.");
    try { return c.json(takeover.createDraft(actorOf(p), body.hosts as string[] | undefined), 201); } catch (error) { return takeoverFailed(c, error); }
  });
  api.get("/api/services/drafts/:id", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    if (!takeover) { const d = store.serviceDraft(c.req.param("id")); return d ? c.json(d) : reject(c, 404, "draft/unknown", `No takeover draft ${c.req.param("id")}.`); }
    try { return c.json(await takeover.withReview(c.req.param("id"))); } catch (error) { return takeoverFailed(c, error); }
  });
  api.put("/api/services/drafts/:id/items/:item", async (c) => {
    const p = await authenticate(c, "admin");
    if (p instanceof Response) return p;
    if (!takeover) return noTakeover(c);
    const item = await c.req.json().catch(() => null) as DraftItem | null;
    if (!item || typeof item !== "object" || item.id !== c.req.param("item")) return reject(c, 400, "draft/item-invalid", "The body is the item, with the id of the path.");
    try { return c.json(takeover.putItem(c.req.param("id"), item, actorOf(p))); } catch (error) { return takeoverFailed(c, error); }
  });
  api.delete("/api/services/drafts/:id/items/:item", async (c) => {
    const p = await authenticate(c, "admin");
    if (p instanceof Response) return p;
    if (!takeover) return noTakeover(c);
    try { return c.json(takeover.removeItem(c.req.param("id"), c.req.param("item"), actorOf(p))); } catch (error) { return takeoverFailed(c, error); }
  });
  api.post("/api/services/drafts/:id/assess", async (c) => {
    const p = await authenticate(c, "admin");
    if (p instanceof Response) return p;
    if (!takeover) return noTakeover(c);
    try { return c.json(takeover.reassess(c.req.param("id"), actorOf(p))); } catch (error) { return takeoverFailed(c, error); }
  });
  api.post("/api/services/drafts/:id/review", async (c) => {
    const p = await authenticate(c, "admin");
    if (p instanceof Response) return p;
    if (!takeover) return noTakeover(c);
    try { return c.json(await takeover.review(c.req.param("id"), actorOf(p)), 202); } catch (error) { return takeoverFailed(c, error); }
  });
  api.post("/api/services/drafts/:id/discard", async (c) => {
    const p = await authenticate(c, "admin");
    if (p instanceof Response) return p;
    try { store.discardServiceDraft(c.req.param("id"), actorOf(p)); return c.json(store.serviceDraft(c.req.param("id"))); } catch (error) { return takeoverFailed(c, error); }
  });
  api.post("/api/services/drafts/:id/confirm", async (c) => {
    const p = await authenticate(c, "admin");
    if (p instanceof Response) return p;
    if (!takeover) return noTakeover(c);
    try {
      const done = await takeover.confirm(c.req.param("id"), actorOf(p));
      graph.schedule(`takeover of draft ${c.req.param("id")}`, actorOf(p));
      return c.json(done);
    } catch (error) { return takeoverFailed(c, error); }
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

  // API keys (§9.4): made on the page with a Workbench session (a key never makes a key); revoked there or with an
  // administrator's key (D38).
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
  // §15.2: a job the executor does not name in its heartbeat is refused wherever it is submitted; anything else as Hono does.
  // On api too: /mcp dispatches to api.fetch directly, which does not reach app's handler.
  const failed = (error: Error, c: Context) => {
    if (error instanceof ExecutorUnsupported) return reject(c, error.status, error.code, error.message, error.missing);
    if (error instanceof LogsError) return reject(c, error.status, error.code, error.message);
    if (error instanceof HTTPException) return error.getResponse();
    console.error(error);
    return c.text("Internal Server Error", 500);
  };
  api.onError(failed);
  app.onError(failed);
  return app;
}
