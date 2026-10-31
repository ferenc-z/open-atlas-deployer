// Drift (§7.1, phase 8): every so often, compare what should be with what is, and show the difference on the page —
// never change it back. Three kinds: a container runs another version than the Deployer last deployed; an app's
// compose fragment or env file on the server is not the one the Deployer last wrote (someone edited it by hand). The
// executor of each host reports the files' SHA-256 (D35), never their content.

import { covering } from "../manifest/version.ts";
import type { Deployments } from "./deploy.ts";
import { hostOf } from "./handoff.ts";
import type { EnvironmentStatus } from "./observe.ts";
import type { Store } from "./store.ts";

export interface DriftItem { key: string; app: string; kind: "version" | "fragment" | "env"; detail: string; firstSeen: string; lastSeen: string }


export class Drift {
  private store: Store;
  private deployments: Deployments;
  private files: (host: string) => Record<string, string> | undefined;
  private status: () => Promise<EnvironmentStatus>;

  constructor(store: Store, deployments: Deployments, files: (host: string) => Record<string, string> | undefined, status: () => Promise<EnvironmentStatus>) {
    this.store = store;
    this.deployments = deployments;
    this.files = files;
    this.status = status;
  }

  /** What differs now, without remembering it. */
  async current(): Promise<Omit<DriftItem, "firstSeen" | "lastSeen">[]> {
    const out: Omit<DriftItem, "firstSeen" | "lastSeen">[] = [];
    const { env, deployed } = this.deployments.environment();
    const status = await this.status();
    for (const a of status.apps) {
      if (!deployed[a.app] || a.verdict !== "drift") continue;
      const running = a.components.filter((c) => c.verdict === "drift").map((c) => `${c.service} runs ${c.container?.version ?? c.container?.image ?? "?"}`);
      out.push({ key: `version:${a.app}`, app: a.app, kind: "version", detail: `Expected ${a.desired}, actual: ${running.join("; ")}` });
    }
    for (const app of Object.keys(deployed)) {
      const files = this.files(hostOf(env, app));
      if (!files) continue;
      const last = this.store.deployedVersion(app);
      const fragment = last?.status?.result && (last.status.result as { fragmentSha256?: string }).fragmentSha256;
      const on = files[`${app}/compose.yaml`];
      if (fragment && on && on !== fragment) out.push({ key: `fragment:${app}`, app, kind: "fragment", detail: `${app}/compose.yaml differs from what the Deployer wrote in ${last!.id} (someone changed it on the server)` });
      if (fragment && !on) out.push({ key: `fragment:${app}`, app, kind: "fragment", detail: `${app}/compose.yaml is no longer on the server` });
    }
    for (const app of this.store.listApps()) {
      const manifest = covering(this.store.manifests(app.id), deployed[app.id] ?? "") ?? this.store.manifests(app.id).at(-1);
      const file = manifest?.env?.file;
      if (!file) continue;
      const expected = this.expectedEnv(app.id);
      const files = this.files(hostOf(env, app.id));
      if (!expected || !files) continue;
      const on = files[file];
      if (on !== expected.sha256) out.push({ key: `env:${app.id}`, app: app.id, kind: "env", detail: on ? `${file} differs from what the Deployer last ${expected.how} (${expected.job}) (someone changed it on the server)` : `${file} is no longer on the server` });
    }
    return out;
  }

  /** The env file's hash as the Deployer last wrote or read it. */
  private expectedEnv(app: string): { sha256: string; job: string; how: string } | undefined {
    const jobs = this.store.listJobs({ app, limit: 200 }).filter((j) => (j.kind === "env" || j.kind === "env-read") && j.state === "succeeded");
    const last = jobs[0];
    if (!last) return undefined;
    const sha = last.kind === "env" ? String(last.request.sha256 ?? "") : last.status?.result.env?.exists ? last.status.result.env.sha256 ?? "" : "";
    return sha ? { sha256: sha, job: last.id, how: last.kind === "env" ? "wrote" : "imported" } : undefined;
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
