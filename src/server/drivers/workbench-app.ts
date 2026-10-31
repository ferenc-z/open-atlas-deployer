// workbench-app (§4.2): the bundle is the business package; Workbench installs app/ from it and keeps the version
// before, so a rollback is one switch back (§8.3).

import type { Component } from "../../compose/generate.ts";
import { block, resolveEnv, type DeployDriver, type StepContext, type StepResult, type Undo } from "./types.ts";
import type { WorkbenchAdmin } from "./workbench.ts";

function packageApp(ctx: StepContext): { id: string; version: string } {
  const raw = ctx.bundle?.files.get("app/app.json");
  if (!raw) throw new Error(`The release bundle ${ctx.bundle?.asset ?? ""} has no app/app.json, so it is not a Workbench app package`);
  const app = JSON.parse(raw.toString("utf8")) as { id?: string; version?: string };
  if (!app.id || !app.version) throw new Error("app/app.json is missing id or version");
  return { id: app.id, version: app.version };
}

export class WorkbenchAppDriver implements DeployDriver {
  readonly type = "workbench-app";
  private workbench: WorkbenchAdmin;

  constructor(workbench: WorkbenchAdmin) { this.workbench = workbench; }

  async plan(ctx: StepContext) {
    const findings = [];
    if (ctx.component.source) findings.push(block("workbench-app/source", `Component ${ctx.component.id} has its own source; only the manifest's bundle is supported for now.`));
    if (!ctx.bundle) return { after: "—", findings: [...findings, block("workbench-app/no-bundle", `The app package of component ${ctx.component.id} comes from the bundle, but the manifest has no bundle.`)] };
    let pkg: { id: string; version: string };
    try { pkg = packageApp(ctx); } catch (error) { return { after: "—", findings: [...findings, block("workbench-app/package", (error as Error).message)] }; }
    if (pkg.version !== ctx.version) findings.push(block("workbench-app/version", `The app package's version is ${pkg.version}, not ${ctx.version}.`));
    for (const [name, value] of Object.entries((ctx.component.settings ?? {}) as Record<string, string>)) {
      const r = resolveEnv(value, ctx.envValue);
      if (r.missing.length) findings.push(block("workbench-app/setting", `Setting ${name} uses ${r.missing.join(", ")} from env, which the env file on the server does not have.`));
    }
    const after = `${pkg.id} ${pkg.version} (${ctx.bundle.asset}, ${ctx.bundle.digest.slice(0, 19)}…)`;
    if (!this.workbench.configured) return { after, findings: [...findings, block("workbench-app/key", "No Workbench API key is configured (DEPLOYER_WORKBENCH_API_KEY_FILE), so the app package cannot be installed.")] };
    try {
      const installed = (await this.workbench.apps()).find((a) => a.id === pkg.id);
      return { ...(installed ? { before: `${pkg.id} ${installed.version}` } : {}), after, findings };
    } catch (error) {
      return { after, findings: [...findings, block("workbench-app/unreachable", (error as Error).message)] };
    }
  }

  async apply(ctx: StepContext): Promise<StepResult> {
    const pkg = packageApp(ctx);
    const before = (await this.workbench.apps()).find((a) => a.id === pkg.id);
    ctx.log(`Workbench: installing ${ctx.bundle!.asset} (${pkg.id} ${pkg.version}), installed now: ${before?.version ?? "none"}`);
    const r = await this.workbench.install(ctx.bundle!.bytes, ctx.bundle!.asset);
    const settings = Object.fromEntries(Object.entries((ctx.component.settings ?? {}) as Record<string, string>).map(([k, v]) => [k, resolveEnv(v, ctx.envValue).value]));
    if (Object.keys(settings).length) {
      await this.workbench.setSettings(r.app.id, settings);
      ctx.log(`Workbench: settings ${Object.keys(settings).join(", ")} set`);
    }
    const bound = Object.keys(r.bound ?? {});
    return {
      message: `Workbench installed ${r.app.id} ${r.app.version}${before ? ` (was ${before.version})` : " (first install)"}${bound.length ? `; bound ${bound.join(", ")} by name` : ""}`,
      detail: { appId: r.app.id, version: r.app.version, previous: before?.version ?? null },
    };
  }

  async verify(_ctx: StepContext, result: StepResult): Promise<string | null> {
    const app = (await this.workbench.apps()).find((a) => a.id === result.detail.appId);
    return app?.version === result.detail.version ? null : `${result.detail.appId} in Workbench is ${app?.version ?? "missing"}, expected ${result.detail.version}`;
  }

  async rollback(_ctx: StepContext, result: StepResult): Promise<Undo> {
    if (!result.detail.previous) return { message: `${result.detail.appId} was a first install and stays in Workbench (remove it on the Workbench admin page if needed)`, undone: false };
    const r = await this.workbench.switchVersion(String(result.detail.appId));
    return { message: `${result.detail.appId} in Workbench switched back to ${r.version}`, undone: true };
  }

  impact(_component: Component): string { return "No interruption: once the package is replaced, open pages are asked to reload"; }
}
