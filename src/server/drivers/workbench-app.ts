// workbench-app (§4.2): the bundle is the business package; Workbench installs app/ from it and keeps the version
// before, so a rollback is one switch back (§8.3).

import type { Component } from "../../compose/generate.ts";
import { block, resolveEnv, type DeployDriver, type StepContext, type StepResult, type Undo } from "./types.ts";
import type { WorkbenchAdmin } from "./workbench.ts";

function packageApp(ctx: StepContext): { id: string; version: string } {
  const raw = ctx.bundle?.files.get("app/app.json");
  if (!raw) throw new Error(`发布包 ${ctx.bundle?.asset ?? ""} 里没有 app/app.json，不是 Workbench 应用包`);
  const app = JSON.parse(raw.toString("utf8")) as { id?: string; version?: string };
  if (!app.id || !app.version) throw new Error("app/app.json 缺 id 或 version");
  return { id: app.id, version: app.version };
}

export class WorkbenchAppDriver implements DeployDriver {
  readonly type = "workbench-app";
  private workbench: WorkbenchAdmin;

  constructor(workbench: WorkbenchAdmin) { this.workbench = workbench; }

  async plan(ctx: StepContext) {
    const findings = [];
    if (ctx.component.source) findings.push(block("workbench-app/source", `组件 ${ctx.component.id} 写了单独的 source；现在只支持取自清单的 bundle。`));
    if (!ctx.bundle) return { after: "—", findings: [...findings, block("workbench-app/no-bundle", `组件 ${ctx.component.id} 的应用包取自 bundle，清单没有 bundle。`)] };
    let pkg: { id: string; version: string };
    try { pkg = packageApp(ctx); } catch (error) { return { after: "—", findings: [...findings, block("workbench-app/package", (error as Error).message)] }; }
    if (pkg.version !== ctx.version) findings.push(block("workbench-app/version", `应用包里的版本是 ${pkg.version}，不是 ${ctx.version}。`));
    for (const [name, value] of Object.entries((ctx.component.settings ?? {}) as Record<string, string>)) {
      const r = resolveEnv(value, ctx.envValue);
      if (r.missing.length) findings.push(block("workbench-app/setting", `设置 ${name} 要用 env 里的 ${r.missing.join("、")}，服务器上的 env 文件没有。`));
    }
    const after = `${pkg.id} ${pkg.version}（${ctx.bundle.asset}，${ctx.bundle.digest.slice(0, 19)}…）`;
    if (!this.workbench.configured) return { after, findings: [...findings, block("workbench-app/key", "没有配置 Workbench API key（DEPLOYER_WORKBENCH_API_KEY_FILE），装不了应用包。")] };
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
      message: `Workbench 装好 ${r.app.id} ${r.app.version}${before ? `（之前 ${before.version}）` : "（第一次安装）"}${bound.length ? `，按名字绑定了 ${bound.join("、")}` : ""}`,
      detail: { appId: r.app.id, version: r.app.version, previous: before?.version ?? null },
    };
  }

  async verify(_ctx: StepContext, result: StepResult): Promise<string | null> {
    const app = (await this.workbench.apps()).find((a) => a.id === result.detail.appId);
    return app?.version === result.detail.version ? null : `Workbench 里 ${result.detail.appId} 是 ${app?.version ?? "没有"}，应为 ${result.detail.version}`;
  }

  async rollback(_ctx: StepContext, result: StepResult): Promise<Undo> {
    if (!result.detail.previous) return { message: `${result.detail.appId} 是第一次安装，保留在 Workbench 里（需要时在 Workbench 管理页面删除）`, undone: false };
    const r = await this.workbench.switchVersion(String(result.detail.appId));
    return { message: `Workbench 的 ${result.detail.appId} 切回 ${r.version}`, undone: true };
  }

  impact(_component: Component): string { return "不中断：应用包换好后，打开着的页面提示刷新"; }
}
