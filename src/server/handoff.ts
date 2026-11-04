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
export const EXECUTOR_VERSION = "0.7.3";

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

  executors(env: Pick<Environment, "hosts">): ExecutorInfo[] {
    return hostIds(env).map((h) => this.executor(h));
  }

  /** Queues a job for one executor of a host (by default its deploy executor); an env job's content is kept apart and
   *  leaves the queue on pickup. */
  submit(id: string, request: Record<string, unknown>, host: string, kind: ExecutorKind = "deploy") {
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
    const now = this.store.claimExecutorJob(host, kind);
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
    return signal?.aborted ? undefined : this.store.claimExecutorJob(host, kind);
  }

  /** Whether a job belongs to the executor asking about it. */
  owns(host: string, id: string, kind: ExecutorKind = "deploy"): boolean {
    const job = this.store.executorJob(id);
    return job?.host === host && job.executor === kind;
  }

  putStatus(id: string, status: ExecutorStatus) { this.store.setExecutorStatus(id, status); }
  appendLog(id: string, text: string) { this.store.appendExecutorLog(id, text); }
  putEnvContent(id: string, content: string) { this.store.setExecutorEnvContent(id, content); }
  putState(host: string, containers: unknown[], files: Record<string, string>) { this.store.setHostState(host, containers, files); }
}
