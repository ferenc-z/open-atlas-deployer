// HTTP surface of the Deployer, phase 1: who am I, the emergency login, the read-only status of
// this environment, and the app registry (admins change it). Everything sits under the base path
// the reverse proxy serves the Deployer at (§9.1).

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { Hono, type Context } from "hono";
import type { Environment } from "../compose/generate.ts";
import {
  EMERGENCY_COOKIE, EMERGENCY_TTL_MS, LoginThrottle, emergencyPrincipal, newToken, parseCookies, sha256, verifyPassword,
  type Permission, type Principal, type WorkbenchSessions,
} from "./auth.ts";
import type { Config } from "./config.ts";
import { DeployError, deploymentRecord, type Deployments } from "./deploy.ts";
import type { EnvManager } from "./env.ts";
import { KeyError, isKey, type Keys } from "./keys.ts";
import { handleMcp } from "./mcp.ts";
import { PeerError, type Peer, type PeerStatus } from "./peer.ts";
import { environmentStatus, readHostState, type Observer } from "./observe.ts";
import { StoreError, type Actor, type Store } from "./store.ts";
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
}

const reject = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 429 | 503, code: string, message: string, details: string[] = []) =>
  c.json({ error: code, message, ...(details.length ? { details } : {}) }, status);

const actorOf = (p: Principal): Actor => ({ id: p.id, via: p.via });

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".ico": "image/x-icon" };

export function createApp({ config, store, sessions, observer, deployments, versions, env: envVars, peer, keys }: Dependencies): Hono {
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
      if (!principal) return reject(c, 401, "auth/unauthenticated", "请先登录 Workbench。");
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
      if (result.kind === "unavailable") return reject(c, 503, "auth/workbench-unavailable", "Workbench 暂时无法访问，无法确认登录。", config.emergencyPasswordHash ? ["emergency-available"] : []);
      if (result.kind === "anonymous") return reject(c, 401, "auth/unauthenticated", "请先登录 Workbench。");
      principal = result.principal;
    }
    if (!principal.permissions.includes(need)) return reject(c, 403, "auth/forbidden", need === "admin" ? "只有 Workbench 管理员能做这件事。" : "你不在 deploy-viewer、deploy-uat、deploy-prod 任何一个组里。");
    if (!isKey(principal) && c.req.method !== "GET" && c.req.header("x-csrf-token") !== principal.csrfToken) return reject(c, 403, "auth/csrf", "请求缺少有效的 CSRF 令牌，请刷新页面。");
    return principal;
  }

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
    const call = async (spec: { method: string; path: string; query?: Record<string, unknown>; body?: unknown }) => {
      const nonce = randomBytes(12).toString("hex");
      internal.set(nonce, principal);
      const query = Object.entries(spec.query ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
      const res = await api.fetch(new Request(`${origin}${spec.path}${query ? `?${query}` : ""}`, {
        method: spec.method, headers: { "x-deployer-internal": `${internalSecret}.${nonce}`, ...(spec.body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(spec.body !== undefined ? { body: JSON.stringify(spec.body) } : {}),
      }));
      internal.delete(nonce);
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    const reply = await handleMcp(message, { principal, store, call });
    return reply ? c.json(reply) : c.body(null, 202);
  });
  api.get("/mcp", (c) => c.json({ jsonrpc: "2.0", id: null, error: { code: -32601, message: "no event stream here; POST JSON-RPC to /mcp" } }, 405));

  // API keys (§9.4): made and revoked on the page with a Workbench session; a key never makes a key.
  const keyError = (c: Context, error: unknown) => {
    if (error instanceof KeyError) return reject(c, error.status, error.code, error.message);
    throw error;
  };
  api.get("/api/keys", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    if (!keys) return reject(c, 404, "key/not-configured", "API key 没有启用（需要 DEPLOYER_WORKBENCH_API_KEY_FILE，用来向 Workbench 确认 key 的主人）。");
    return c.json({ keys: keys.list(p) });
  });
  api.post("/api/keys", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    if (!keys) return reject(c, 404, "key/not-configured", "API key 没有启用。");
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
    if (!keys) return reject(c, 404, "key/not-configured", "API key 没有启用。");
    try { keys.revoke(p, c.req.param("id")); return c.json({ revoked: true }); } catch (error) { return keyError(c, error); }
  });

  const environment = (): Environment => JSON.parse(readFileSync(config.environmentFile, "utf8"));
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
    if (!config.peerKeySha256.length) return reject(c, 404, "peer/not-configured", "这个 Deployer 没有配置只读 key（DEPLOYER_PEER_KEY_SHA256）。");
    if (!peerAllowed(c)) return reject(c, 401, "peer/unauthorized", "只读 key 不对。");
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
    return c.json({ signedIn: true, principal: p, environment: environmentName, workbenchUrl: config.workbenchPublicUrl });
  });

  api.post("/api/emergency/login", async (c) => {
    if (!config.emergencyPasswordHash) return reject(c, 404, "emergency/not-configured", "没有配置紧急账号。");
    if (await sessions.reachable()) return reject(c, 409, "emergency/workbench-available", "Workbench 可以访问，请用 Workbench 登录。");
    if (throttle.blocked()) return reject(c, 429, "emergency/throttled", "失败次数过多，请 15 分钟后再试。");
    const body = await c.req.json().catch(() => ({})) as { password?: unknown };
    if (typeof body.password !== "string" || !verifyPassword(body.password, config.emergencyPasswordHash)) {
      throttle.fail();
      store.audit({ id: "emergency", via: "emergency" }, "emergency.login-failed", "emergency");
      return reject(c, 401, "emergency/wrong-password", "密码不对。");
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
    try { env = deployments.environment().env; } catch { return reject(c, 503, "environment/missing", `读不到环境设置 ${config.environmentFile}。`); }
    const apps = store.listApps().map((a) => ({ id: a.id, name: a.name, manifests: store.manifests(a.id) }));
    const status = await environmentStatus(env, apps, readHostState(config.hostStateFile), observer);
    let uat: (PeerStatus & { url?: string }) | { error: string } | undefined;
    if (peer?.configured) { try { uat = await peer.status(); } catch (error) { uat = { error: (error as Error).message }; } }
    return c.json({ ...status, ...(uat ? { peer: uat } : {}), executor: deployments.handoff.executor(), canDeploy: deployments.canDeploy(p), envEnabled: envVars.enabled, active: store.activeJobs().map((j) => ({ id: j.id, kind: j.kind, app: j.app, version: j.version, state: j.state })) });
  });

  api.get("/api/apps/:id/versions", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const manifests = store.manifests(c.req.param("id"));
    const release = manifests.at(-1)?.release;
    if (!release) return reject(c, 404, "app/unknown", "注册表里没有这个应用，或它的清单没有 release。");
    const listed = await versions.list(release.repo, release.tag);
    const built = store.listJobs({ app: c.req.param("id"), kind: "build", limit: 200 }).filter((j) => j.state === "succeeded").map((j) => j.version);
    return c.json({ ...listed, built: [...new Set(built)], deployed: store.deployedVersion(c.req.param("id"))?.version ?? null });
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
    const body = await c.req.json().catch(() => ({})) as { version?: string; pinFrom?: string; acknowledgeManual?: boolean; override?: { reason?: string } };
    try {
      const job = await deployments.deploy(p, c.req.param("id"), String(body.version ?? ""), {
        ...(body.pinFrom ? { pinFrom: body.pinFrom } : {}), acknowledgeManual: body.acknowledgeManual === true,
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
    if (!Array.isArray(body.values)) return reject(c, 400, "env/invalid", "请求里没有 values。");
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
    if (!peer?.configured) return reject(c, 404, "peer/not-configured", "没有配置 UAT 的 Deployer。");
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
    if (!job) return reject(c, 404, "job/unknown", "没有这个任务。");
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
    if (!app) return reject(c, 404, "app/unknown", "注册表里没有这个应用。");
    return c.json({ app, manifests: store.manifests(app.id) });
  });

  // One revision as deploy.json (D27: the manifest can be exported).
  api.get("/api/apps/:id/manifests/:from/:revision", async (c) => {
    const p = await authenticate(c, "view");
    if (p instanceof Response) return p;
    const manifest = store.manifestRevision(c.req.param("id"), c.req.param("from"), Number(c.req.param("revision")));
    if (!manifest) return reject(c, 404, "manifest/unknown", "没有这一版清单。");
    if (c.req.query("download") !== undefined) c.header("content-disposition", `attachment; filename="${manifest.app}-${manifest.appliesFrom}.deploy.json"`);
    return c.json(manifest);
  });

  api.put("/api/apps/:id/manifests", async (c) => {
    const p = await authenticate(c, "admin");
    if (p instanceof Response) return p;
    const body = await c.req.json().catch(() => undefined) as { manifest?: { app?: unknown }; name?: string; note?: string } | undefined;
    if (!body?.manifest) return reject(c, 400, "manifest/missing", "请求里没有清单。");
    if (body.manifest.app !== c.req.param("id")) return reject(c, 400, "manifest/app-mismatch", `清单的 app 不是 ${c.req.param("id")}。`);
    try {
      return c.json(store.saveManifest(body.manifest, actorOf(p), { ...(body.name ? { name: body.name } : {}), ...(body.note ? { note: body.note } : {}) }));
    } catch (error) {
      if (error instanceof StoreError) return reject(c, 400, error.code, error.message, error.details);
      throw error;
    }
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
    return c.json({ entries: store.listAudit(Number(c.req.query("limit") ?? 100)) });
  });

  api.all("/api/*", (c) => reject(c, 404, "not-found", "没有这个接口。"));

  // The built page; unknown paths get index.html so the page's own routes work on reload.
  api.get("*", (c) => {
    const rel = normalize(c.req.path.slice(config.basePath.length).replace(/^\/+/, "") || "index.html");
    if (rel.startsWith("..")) return c.notFound();
    let file = join(config.webDir, rel);
    if (!existsSync(file) || !statSync(file).isFile()) file = join(config.webDir, "index.html");
    if (!existsSync(file)) return c.text("页面还没有构建：npm run build:web", 503);
    const immutable = rel.startsWith("assets/");
    return c.body(readFileSync(file), 200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" });
  });

  const app = new Hono();
  app.get("/health", (c) => c.json({ status: "ok" }));
  if (config.basePath) app.get("/", (c) => c.redirect(`${config.basePath}/`));
  app.route(config.basePath || "/", api);
  return app;
}
