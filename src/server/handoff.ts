// The Deployer's side of the handoff directory shared with the host executor (design §8.2, D29,
// protocol 1): requests go in as files written to a temporary name and renamed; the executor answers
// in jobs/<id>/status.json and log.txt, and keeps executor.json fresh as its heartbeat.

import { existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, closeSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { ExecutorStatus } from "./store.ts";

export const PROTOCOL = 1;

export interface Heartbeat {
  version: string;
  protocols: number[];
  at: string;
  project: string;
  registries: string[];
  databaseBackup: Record<string, { dump: boolean; restore: boolean }>;
  busy: string | null;
  /** Job kinds this executor performs; executors before 0.2.0 do not say, and only build and deploy. */
  kinds?: string[];
}

export interface ExecutorInfo { online: boolean; reason?: string; heartbeat?: Heartbeat; ageSeconds?: number }

export function newJobId(kind: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `${kind}-${stamp}-${randomBytes(3).toString("hex")}`;
}

export class Handoff {
  readonly dir: string | undefined;
  private now: () => number;

  constructor(dir: string | undefined, now: () => number = Date.now) {
    this.dir = dir;
    this.now = now;
  }

  /** Online when the heartbeat is under 30 seconds old and speaks our protocol. */
  executor(): ExecutorInfo {
    if (!this.dir) return { online: false, reason: "没有配置执行器（DEPLOYER_HANDOFF_DIR）" };
    const file = join(this.dir, "executor.json");
    if (!existsSync(file)) return { online: false, reason: "执行器还没有上报过心跳" };
    let heartbeat: Heartbeat;
    try { heartbeat = JSON.parse(readFileSync(file, "utf8")); } catch { return { online: false, reason: "执行器心跳文件读不出来" }; }
    const ageSeconds = Math.round((this.now() - Date.parse(heartbeat.at)) / 1000);
    if (ageSeconds > 30) return { online: false, reason: `执行器 ${ageSeconds} 秒没有心跳`, heartbeat, ageSeconds };
    if (!heartbeat.protocols?.includes(PROTOCOL)) return { online: false, reason: `执行器 ${heartbeat.version} 不支持协议 ${PROTOCOL}`, heartbeat, ageSeconds };
    return { online: true, heartbeat, ageSeconds };
  }

  submit(id: string, request: Record<string, unknown>) {
    if (!this.dir) throw new Error("no handoff directory");
    const dir = join(this.dir, "requests");
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${id}.tmp`);
    // Env requests carry the file content until the executor picks them up: only the Deployer and root read it.
    writeFileSync(tmp, JSON.stringify({ protocol: PROTOCOL, id, ...request }, null, 2), { mode: 0o600 });
    renameSync(tmp, join(dir, `${id}.json`));
  }

  status(id: string): ExecutorStatus | undefined {
    if (!this.dir) return undefined;
    try { return JSON.parse(readFileSync(join(this.dir, "jobs", id, "status.json"), "utf8")); } catch { return undefined; }
  }

  /** The env file an env-read job copied out (0600, ours); the executor deletes it after a few minutes. */
  envContent(id: string): string | undefined {
    if (!this.dir) return undefined;
    try { return readFileSync(join(this.dir, "jobs", id, "env.content"), "utf8"); } catch { return undefined; }
  }

  /** The last `bytes` of the job's log. */
  log(id: string, bytes = 64 * 1024): string {
    if (!this.dir) return "";
    const file = join(this.dir, "jobs", id, "log.txt");
    if (!existsSync(file)) return "";
    const size = statSync(file).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    const fd = openSync(file, "r");
    try { readSync(fd, buffer, 0, buffer.length, start); } finally { closeSync(fd); }
    return (start > 0 ? "…\n" : "") + buffer.toString("utf8");
  }
}
