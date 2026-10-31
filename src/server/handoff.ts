// The Deployer's side of the executor protocol (design §7.4, D35, protocol 2). Each host runs an executor
// that reaches the Deployer over HTTPS with its own token: it long-polls for the next job queued for its
// host, reports the job's status and log, sends a heartbeat, and reports the host's containers and the
// hashes of the files the Deployer writes. The Deployer never connects to a host. Protocol 1 (a shared
// handoff directory, one host only) is gone.

import { createHash, randomBytes } from "node:crypto";
import type { Environment } from "../compose/generate.ts";
import type { ExecutorStatus, Store } from "./store.ts";

export const PROTOCOL = 2;

export interface Heartbeat {
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
}

export interface ExecutorInfo { online: boolean; host: string; reason?: string; heartbeat?: Heartbeat; ageSeconds?: number }

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

  /** Online when the host's heartbeat is under 30 seconds old and speaks our protocol. */
  executor(host: string): ExecutorInfo {
    const row = this.store.executorHosts().find((h) => h.host === host);
    if (!row?.heartbeat || !row.beatAt) return { online: false, host, reason: `The executor on ${host} has not sent a heartbeat yet` };
    const heartbeat = row.heartbeat as Heartbeat;
    const ageSeconds = Math.round((this.now() - Date.parse(row.beatAt)) / 1000);
    if (ageSeconds > 30) return { online: false, host, reason: `No heartbeat from the executor on ${host} for ${ageSeconds} seconds`, heartbeat, ageSeconds };
    if (!heartbeat.protocols?.includes(PROTOCOL)) return { online: false, host, reason: `Executor ${heartbeat.version} on ${host} does not support protocol ${PROTOCOL}`, heartbeat, ageSeconds };
    return { online: true, host, heartbeat, ageSeconds };
  }

  executors(env: Pick<Environment, "hosts">): ExecutorInfo[] {
    return hostIds(env).map((h) => this.executor(h));
  }

  /** Queues a job for one host's executor; an env job's content is kept apart and leaves the queue on pickup. */
  submit(id: string, request: Record<string, unknown>, host: string) {
    const { content, ...rest } = request;
    this.store.queueExecutorJob(id, host, { protocol: PROTOCOL, id, ...rest }, typeof content === "string" ? content : undefined);
    for (const wake of this.waiting.get(host) ?? []) wake();
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

  /** What each host last reported; stale after five minutes. */
  reports(): (HostReport & { stale: boolean })[] {
    return this.store.executorHosts().filter((h) => h.stateAt).map((h) => ({
      host: h.host, containers: h.containers ?? [], files: h.files ?? {}, at: h.stateAt!, stale: this.now() - Date.parse(h.stateAt!) > 5 * 60_000,
    }));
  }

  // --- the executor's side (behind its token) ---------------------------------------------------------

  heartbeat(host: string, heartbeat: Heartbeat) {
    this.store.setHeartbeat(host, { ...heartbeat, at: new Date(this.now()).toISOString() });
  }

  /** The next job for the host, waiting up to `waitMs` for one to be queued. */
  async next(host: string, waitMs = 0): Promise<Record<string, unknown> | undefined> {
    const now = this.store.claimExecutorJob(host);
    if (now || waitMs <= 0) return now;
    await new Promise<void>((resolve) => {
      const set = this.waiting.get(host) ?? new Set();
      this.waiting.set(host, set);
      const done = () => { clearTimeout(timer); set.delete(done); resolve(); };
      const timer = setTimeout(done, waitMs);
      set.add(done);
    });
    return this.store.claimExecutorJob(host);
  }

  /** Whether a job belongs to the host asking about it. */
  owns(host: string, id: string): boolean {
    return this.store.executorJob(id)?.host === host;
  }

  putStatus(id: string, status: ExecutorStatus) { this.store.setExecutorStatus(id, status); }
  appendLog(id: string, text: string) { this.store.appendExecutorLog(id, text); }
  putEnvContent(id: string, content: string) { this.store.setExecutorEnvContent(id, content); }
  putState(host: string, containers: unknown[], files: Record<string, string>) { this.store.setHostState(host, containers, files); }
}
