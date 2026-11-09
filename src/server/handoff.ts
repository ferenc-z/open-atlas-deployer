// The Deployer's side of the executor protocol (design §7.4, D35, protocol 2). Each host runs an executor
// that reaches the Deployer over HTTPS with its own token: it long-polls for the next job queued for its
// host, reports the job's status and log, sends a heartbeat, and reports the host's containers and the
// hashes of the files the Deployer writes. The Deployer never connects to a host. Protocol 1 (a shared
// handoff directory, one host only) is gone.
//
// S18: a host may run two executors, each with its own tokens: the deploy executor (the one above) and the service
// executor (managed services such as NiFi, no Docker). The token says which one calls; each has its own heartbeat and
// its own queue, so a deploy job never reaches a service executor and the other way round.

import { createHash, randomBytes } from "node:crypto";
import type { Environment } from "../compose/generate.ts";
import type { ExecutorKind, ExecutorStatus, Store } from "./store.ts";
export { EXECUTOR_KINDS, type ExecutorKind } from "./store.ts";

export const PROTOCOL = 2;
/** §8.6: the executor release this Deployer ships with (executor/deployer_executor.py VERSION); hosts on an older one are offered the upgrade. */
export const EXECUTOR_VERSION = "0.9.0";

export interface Heartbeat {
  /** S18: which executor sent it; absent from deploy executors before S18. */
  executor?: ExecutorKind;
  version: string;
  protocols: number[];
  at: string;
  project: string;
  registries: string[];
  databaseBackup: Record<string, { dump: boolean; restore: boolean }>;
  busy: string | null;
  /** Job kinds this executor performs. */
  kinds?: string[];
  /** §15.3: a service executor's collector (sampling period in seconds, members watched, samples waiting to be sent). */
  collector?: { seconds?: number; watching?: number; backlog?: number; certificate?: unknown };
  /** The deploy root on its host. */
  root?: string;
  /** §8.6: what kind of source the host upgrades its executor from (EXECUTOR_UPGRADE_FROM); null: not set. */
  upgradeFrom?: "github" | "directory" | null;
  /** D16: this host runs the Deployer and upgrades it from this image repository (EXECUTOR_DEPLOYER_IMAGE). */
  deployer?: { image: string } | null;
  /** The service executor (S18): the user it runs as; not root, it sees and manages only that user's services. */
  user?: string;
  isRoot?: boolean;
  /** The service executor's read channel: the reads in flight, and how many may run at once. */
  reading?: string[];
  readSlots?: number;
}

export interface ExecutorInfo { online: boolean; host: string; executor?: ExecutorKind; reason?: string; heartbeat?: Heartbeat; ageSeconds?: number }

/** Where one host's executor said its containers and managed files were. */
export interface HostReport { host: string; containers: unknown[]; files: Record<string, string>; at: string }

export function newJobId(kind: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `${kind}-${stamp}-${randomBytes(3).toString("hex")}`;
}

/** The hosts of an environment; one called "local" when the environment names none (a single machine). */
export function hostIds(env: Pick<Environment, "hosts">): string[] {
  const ids = Object.keys(env.hosts ?? {});
  return ids.length ? ids : ["local"];
}

/** The host an app runs on (D35: placed per app); the first host when the environment does not say. */
export function hostOf(env: Pick<Environment, "hosts" | "apps">, app: string): string {
  return env.apps[app]?.host ?? hostIds(env)[0]!;
}

/** §15.2: what a request needs of the executor, as the job kinds its heartbeat names. An executor says what it can do
 *  by kind, not by version: the job's kind, and "<kind>@<n>" for a later form of a request. svc-discover@2: dirs
 *  entries {install, conf}; svc-read@2: a conf directory (confDir) or bootstrap.conf elsewhere than <installDir>/conf. */
export function kindsNeeded(request: Record<string, unknown>): string[] {
  const kind = String(request.kind ?? "");
  const out = [kind];
  if (kind === "svc-discover" && Array.isArray(request.dirs) && request.dirs.some((d) => d !== null && typeof d === "object")) out.push("svc-discover@2");
  // S28: provenance reads as ProvenanceQuery does them (the job's first form is @1, so the plain kind alone never counts).
  if (kind === "nifi-provenance") out.push("nifi-provenance@1");
  if (kind === "svc-read") {
    const home = String(request.installDir ?? "").replace(/\/+$/, "");
    if (request.confDir || (typeof request.bootstrapFile === "string" && request.bootstrapFile !== `${home}/conf/bootstrap.conf`)) out.push("svc-read@2");
  }
  return out;
}

/** An executor that cannot run a request: refused before it is queued, or failed before it is handed over. */
export class ExecutorUnsupported extends Error {
  readonly status = 409;
  readonly code = "executor/unsupported";
  readonly missing: string[];
  constructor(message: string, missing: string[]) { super(message); this.missing = missing; }
}

export const tokenSha256 = (token: string) => createHash("sha256").update(token).digest("hex");

export class Handoff {
  private store: Store;
  private now: () => number;
  /** Long polls waiting for a job, by host. */
  private waiting = new Map<string, Set<() => void>>();

  constructor(store: Store, now: () => number = Date.now) {
    this.store = store;
    this.now = now;
  }

  // --- the Deployer's side ---------------------------------------------------------------------------

  /** Online when the heartbeat of the host's executor (by default its deploy executor) is under 30 seconds old and
   *  speaks our protocol. */
  executor(host: string, kind: ExecutorKind = "deploy"): ExecutorInfo {
    const row = kind === "deploy" ? this.store.executorHosts().find((h) => h.host === host) : this.store.executorBeat(host, kind);
    const name = kind === "deploy" ? "executor" : `${kind} executor`;
    const info = { host, ...(kind === "deploy" ? {} : { executor: kind }) };
    if (!row?.heartbeat || !row.beatAt) return { online: false, ...info, reason: `The ${name} on ${host} has not sent a heartbeat yet` };
    const heartbeat = row.heartbeat as Heartbeat;
    const ageSeconds = Math.round((this.now() - Date.parse(row.beatAt)) / 1000);
    if (ageSeconds > 30) return { online: false, ...info, reason: `No heartbeat from the ${name} on ${host} for ${ageSeconds} seconds`, heartbeat, ageSeconds };
    if (!heartbeat.protocols?.includes(PROTOCOL)) return { online: false, ...info, reason: `Executor ${heartbeat.version} on ${host} does not support protocol ${PROTOCOL}`, heartbeat, ageSeconds };
    return { online: true, ...info, heartbeat, ageSeconds };
  }

  /** What of `request` the executor's last heartbeat does not name (kindsNeeded); [] when it names all of it, or when it
   *  sent no heartbeat or no kinds (not known: the job waits, and is checked again when it is handed over). */
  missing(host: string, request: Record<string, unknown>, kind: ExecutorKind = "deploy"): string[] {
    const kinds = this.executor(host, kind).heartbeat?.kinds;
    return Array.isArray(kinds) ? kindsNeeded(request).filter((k) => !kinds.includes(k)) : [];
  }

  private unsupported(host: string, request: Record<string, unknown>, kind: ExecutorKind, missing: string[]): ExecutorUnsupported {
    const version = this.executor(host, kind).heartbeat?.version;
    return new ExecutorUnsupported(`The ${kind === "deploy" ? "executor" : `${kind} executor`}${version ? ` ${version}` : ""} on ${host} cannot run this ${String(request.kind)} job (it does not name ${missing.join(", ")}): upgrade it first.`, missing);
  }

  executors(env: Pick<Environment, "hosts">): ExecutorInfo[] {
    return hostIds(env).map((h) => this.executor(h));
  }

  /** Queues a job for one executor of a host (by default its deploy executor); an env job's content is kept apart and
   *  leaves the queue on pickup. */
  submit(id: string, request: Record<string, unknown>, host: string, kind: ExecutorKind = "deploy") {
    const missing = this.missing(host, request, kind);
    if (missing.length) throw this.unsupported(host, request, kind, missing);
    const { content, ...rest } = request;
    this.store.queueExecutorJob(id, host, { protocol: PROTOCOL, id, ...rest }, typeof content === "string" ? content : undefined, kind);
    for (const wake of this.waiting.get(`${kind}:${host}`) ?? []) wake();
  }

  status(id: string): ExecutorStatus | undefined {
    return this.store.executorJob(id)?.status ?? undefined;
  }

  /** The request as queued, without an env job's content (tests and the job page). */
  request(id: string): Record<string, unknown> | undefined {
    return this.store.executorJob(id)?.request;
  }

  /** The env file an env-read job sent back; handed over once. */
  envContent(id: string): string | undefined {
    return this.store.takeExecutorEnvContent(id);
  }

  /** The last `bytes` of the job's log. */
  log(id: string, bytes = 64 * 1024): string {
    const text = this.store.executorJob(id)?.log ?? "";
    return text.length > bytes ? `…\n${text.slice(-bytes)}` : text;
  }

  /** What each host last reported; stale after five minutes. hosts: only these (a host taken out of the environment keeps its last report). */
  reports(hosts?: string[]): (HostReport & { stale: boolean })[] {
    return this.store.executorHosts().filter((h) => h.stateAt && (!hosts || hosts.includes(h.host))).map((h) => ({
      host: h.host, containers: h.containers ?? [], files: h.files ?? {}, at: h.stateAt!, stale: this.now() - Date.parse(h.stateAt!) > 5 * 60_000,
    }));
  }

  // --- the executor's side (behind its token) ---------------------------------------------------------

  heartbeat(host: string, heartbeat: Heartbeat, kind: ExecutorKind = "deploy") {
    this.store.setHeartbeat(host, { ...heartbeat, at: new Date(this.now()).toISOString() }, kind);
  }

  /** The next job for the host, waiting up to `waitMs` for one to be queued. `signal`: the executor's request; a poll
   *  whose executor went away (restarted, network) takes no job, or it would be claimed with nobody to run it. */
  async next(host: string, waitMs = 0, signal?: AbortSignal, kind: ExecutorKind = "deploy"): Promise<Record<string, unknown> | undefined> {
    if (signal?.aborted) return undefined;
    const now = this.claim(host, kind);
    if (now || waitMs <= 0) return now;
    await new Promise<void>((resolve) => {
      const key = `${kind}:${host}`;
      const set = this.waiting.get(key) ?? new Set();
      this.waiting.set(key, set);
      const done = () => { clearTimeout(timer); set.delete(done); signal?.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, waitMs);
      set.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
    return signal?.aborted ? undefined : this.claim(host, kind);
  }

  /** The next queued job the executor can run; one it cannot (queued before it said so, or it was replaced by an
   *  older one since) fails here and never reaches it, so an old executor does not refuse a whole request it misreads. */
  private claim(host: string, kind: ExecutorKind): Record<string, unknown> | undefined {
    for (;;) {
      const job = this.store.claimExecutorJob(host, kind);
      if (!job) return undefined;
      const missing = this.missing(host, job, kind);
      if (!missing.length) return job;
      const at = new Date(this.now()).toISOString();
      this.store.setExecutorStatus(String(job.id), { state: "refused", steps: [], result: {}, message: this.unsupported(host, job, kind, missing).message, finishedAt: at });
    }
  }

  /** Whether a job belongs to the executor asking about it. */
  owns(host: string, id: string, kind: ExecutorKind = "deploy"): boolean {
    const job = this.store.executorJob(id);
    return job?.host === host && job.executor === kind;
  }

  // §15.3: a job's binary content (a log search's matches, a download's tar.gz) and a log-tail's chunks. Both stay in
  // memory only: the content until it is taken or for 10 minutes, the chunks go straight to whoever listens.
  private contents = new Map<string, { data: Buffer; at: number; truncated: boolean }>();
  private chunkListeners = new Map<string, (chunk: Record<string, unknown>) => boolean>();

  /** Keeps a job's content, cut at the request's maxBytes (default 4 MiB). */
  putContent(id: string, data: Buffer): { bytes: number; truncated: boolean } {
    const now = this.now();
    for (const [k, v] of this.contents) if (now - v.at > 600_000) this.contents.delete(k);
    const max = Number(this.store.executorJob(id)?.request.maxBytes) || 4 << 20;
    const truncated = data.length > max;
    this.contents.set(id, { data: truncated ? data.subarray(0, max) : data, at: now, truncated });
    return { bytes: Math.min(data.length, max), truncated };
  }

  /** The content a job sent, handed over once. */
  takeContent(id: string): { data: Buffer; truncated: boolean } | undefined {
    const c = this.contents.get(id);
    this.contents.delete(id);
    return c;
  }

  /** Who gets a job's chunks; the listener says whether anyone still follows. */
  onChunk(id: string, listener: ((chunk: Record<string, unknown>) => boolean) | null) {
    if (listener) this.chunkListeners.set(id, listener); else this.chunkListeners.delete(id);
  }

  /** A chunk of a job: {stop: true} when nobody listens (the executor ends the job early). */
  putChunk(id: string, chunk: Record<string, unknown>): { stop: boolean } {
    const listener = this.chunkListeners.get(id);
    return { stop: !listener || !listener(chunk) };
  }

  /** The job's status once final, or undefined after `ms`. */
  async awaitJob(id: string, ms: number, pollMs = 200, background = false): Promise<ExecutorStatus | undefined> {
    const end = Date.now() + ms;
    for (;;) {
      const s = this.status(id);
      if (s && ["succeeded", "failed", "rolled-back", "refused"].includes(s.state)) return s;
      if (Date.now() >= end) return undefined;
      // background: nobody awaits it (a tail's end), so it never keeps the process alive by itself.
      await new Promise((r) => { const t = setTimeout(r, pollMs); if (background) t.unref(); });
    }
  }

  putStatus(id: string, status: ExecutorStatus) { this.store.setExecutorStatus(id, status); }
  appendLog(id: string, text: string) { this.store.appendExecutorLog(id, text); }
  putEnvContent(id: string, content: string) { this.store.setExecutorEnvContent(id, content); }
  putState(host: string, containers: unknown[], files: Record<string, string>) { this.store.setHostState(host, containers, files); }
}
