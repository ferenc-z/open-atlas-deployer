// Drift (§7.1, phase 8): every so often, compare what should be with what is, and show the difference on the page —
// never change it back. Three kinds: a container runs another version than the Deployer last deployed; an app's
// compose fragment or env file on the server is not the one the Deployer last wrote (someone edited it by hand). The
// executor reports the files' SHA-256 (files.json beside its container list), never their content.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { covering } from "../manifest/version.ts";
import type { Deployments } from "./deploy.ts";
import type { EnvironmentStatus } from "./observe.ts";
import type { Store } from "./store.ts";

export interface DriftItem { key: string; app: string; kind: "version" | "fragment" | "env"; detail: string; firstSeen: string; lastSeen: string }

/** The executor's file hashes, written next to its container list. */
export function readFileHashes(stateFile: string | undefined): Record<string, string> | undefined {
  if (!stateFile) return undefined;
  try { return (JSON.parse(readFileSync(join(dirname(stateFile), "files.json"), "utf8")) as { files: Record<string, string> }).files; } catch { return undefined; }
}

export class Drift {
  private store: Store;
  private deployments: Deployments;
  private files: () => Record<string, string> | undefined;
  private status: () => Promise<EnvironmentStatus>;

  constructor(store: Store, deployments: Deployments, files: () => Record<string, string> | undefined, status: () => Promise<EnvironmentStatus>) {
    this.store = store;
    this.deployments = deployments;
    this.files = files;
    this.status = status;
  }

  /** What differs now, without remembering it. */
  async current(): Promise<Omit<DriftItem, "firstSeen" | "lastSeen">[]> {
    const out: Omit<DriftItem, "firstSeen" | "lastSeen">[] = [];
    const { deployed } = this.deployments.environment();
    const status = await this.status();
    for (const a of status.apps) {
      if (!deployed[a.app] || a.verdict !== "drift") continue;
      const running = a.components.filter((c) => c.verdict === "drift").map((c) => `${c.service} 运行 ${c.container?.version ?? c.container?.image ?? "?"}`);
      out.push({ key: `version:${a.app}`, app: a.app, kind: "version", detail: `期望 ${a.desired}，实际：${running.join("；")}` });
    }
    const files = this.files();
    if (!files) return out;
    for (const app of Object.keys(deployed)) {
      const last = this.store.deployedVersion(app);
      const fragment = last?.status?.result && (last.status.result as { fragmentSha256?: string }).fragmentSha256;
      const on = files[`${app}/compose.yaml`];
      if (fragment && on && on !== fragment) out.push({ key: `fragment:${app}`, app, kind: "fragment", detail: `${app}/compose.yaml 与 Deployer 在 ${last!.id} 写入的不一样（有人在服务器上改过）` });
      if (fragment && !on) out.push({ key: `fragment:${app}`, app, kind: "fragment", detail: `${app}/compose.yaml 不在服务器上了` });
    }
    for (const app of this.store.listApps()) {
      const manifest = covering(this.store.manifests(app.id), deployed[app.id] ?? "") ?? this.store.manifests(app.id).at(-1);
      const file = manifest?.env?.file;
      if (!file) continue;
      const expected = this.expectedEnv(app.id);
      if (!expected) continue;
      const on = files[file];
      if (on !== expected.sha256) out.push({ key: `env:${app.id}`, app: app.id, kind: "env", detail: on ? `${file} 与 Deployer 最后一次${expected.how}（${expected.job}）的不一样（有人在服务器上改过）` : `${file} 不在服务器上了` });
    }
    return out;
  }

  /** The env file's hash as the Deployer last wrote or read it. */
  private expectedEnv(app: string): { sha256: string; job: string; how: string } | undefined {
    const jobs = this.store.listJobs({ app, limit: 200 }).filter((j) => (j.kind === "env" || j.kind === "env-read") && j.state === "succeeded");
    const last = jobs[0];
    if (!last) return undefined;
    const sha = last.kind === "env" ? String(last.request.sha256 ?? "") : last.status?.result.env?.exists ? last.status.result.env.sha256 ?? "" : "";
    return sha ? { sha256: sha, job: last.id, how: last.kind === "env" ? "写入" : "导入" } : undefined;
  }

  /** Remembers since when each difference is seen; a new one and a resolved one are audited once. */
  async check(): Promise<DriftItem[]> {
    const now = this.store.listDrift();
    const seen = await this.current();
    const keys = new Set(seen.map((d) => d.key));
    for (const d of seen) {
      const known = now.find((x) => x.key === d.key);
      this.store.saveDrift(d);
      if (!known) this.store.audit({ id: "deployer", via: "cli" }, "drift.detected", d.app, { kind: d.kind, detail: d.detail });
    }
    for (const d of now) if (!keys.has(d.key)) { this.store.resolveDrift(d.key); this.store.audit({ id: "deployer", via: "cli" }, "drift.resolved", d.app, { kind: d.kind }); }
    return this.store.listDrift();
  }
}
