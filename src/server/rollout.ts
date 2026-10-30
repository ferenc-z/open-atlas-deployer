// A deploy's steps (§8.1, phase 5): components in dependsOn order. The executor's part (compose-service,
// db-migration) goes first as one executor job; then the Deployer applies each workbench-app, studio-graph and
// oma-agent component through that service's API (apply → verify), and a manual component waits until people have
// ticked every item. When a Deployer step fails, the Deployer steps already done are rolled back in reverse order
// (§8.3); the containers stay on the new version, which passed its health checks, and the job says so.

import type { Component } from "../compose/generate.ts";
import type { DeployDriver, StepContext, StepResult } from "./drivers/types.ts";
import type { Actor, Job, Store } from "./store.ts";

export const HOST_TYPES = new Set(["compose-service", "db-migration"]);
export const DEPLOYER_TYPES = new Set(["workbench-app", "studio-graph", "oma-agent"]);

export type StepState = "pending" | "running" | "waiting" | "succeeded" | "failed" | "skipped" | "rolled-back";

export interface RolloutStep {
  component: string;
  type: string;
  where: "host" | "deployer" | "person";
  state: StepState;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
  result?: StepResult;
  checks?: { text: string; by?: string; at?: string }[];
}

export interface Rollout {
  /** none: no executor part; pending: the executor job is running; done: it succeeded. */
  host: "none" | "pending" | "done";
  steps: RolloutStep[];
  log: string[];
  /** Phase 8 (§8.4): a deploy announced in Workbench starts at this time; until then nothing is sent. */
  scheduled?: { at: string; submitted: boolean };
  /** The Deployer set Workbench's maintenance notice for this deploy, and clears it when the deploy ends. */
  notice?: boolean;
}

/** dependsOn order, keeping the manifest's order where it leaves a choice. */
export function order<C extends Pick<Component, "id" | "dependsOn">>(components: C[]): C[] {
  const byId = new Map(components.map((c) => [c.id, c]));
  const done = new Set<string>();
  const out: C[] = [];
  const visit = (c: C, stack: Set<string>) => {
    if (done.has(c.id) || stack.has(c.id)) return;
    stack.add(c.id);
    for (const d of c.dependsOn ?? []) { const dep = byId.get(d); if (dep) visit(dep, stack); }
    stack.delete(c.id);
    done.add(c.id);
    out.push(c);
  };
  for (const c of components) visit(c, new Set());
  return out;
}

/** Executor components that wait for a Deployer or manual one: they cannot all go first. */
export function hostAfterOthers(components: Component[]): string[] {
  const byId = new Map(components.map((c) => [c.id, c]));
  const reaches = (c: Component, seen = new Set<string>()): boolean => (c.dependsOn ?? []).some((d) => {
    if (seen.has(d)) return false;
    seen.add(d);
    const dep = byId.get(d);
    return Boolean(dep && (!HOST_TYPES.has(dep.type) || reaches(dep, seen)));
  });
  return components.filter((c) => HOST_TYPES.has(c.type) && reaches(c)).map((c) => c.id);
}

export const whereOf = (type: string): RolloutStep["where"] => (HOST_TYPES.has(type) ? "host" : type === "manual" ? "person" : "deployer");

export interface RunnerHooks {
  context: (job: Job, step: RolloutStep) => Promise<StepContext>;
  drivers: Record<string, DeployDriver>;
  /** Ends the job: records, artifacts, observation (Deployments). */
  finish: (job: Job, state: "succeeded" | "failed", message: string) => Promise<void>;
}

export class RolloutError extends Error {
  readonly status: 400 | 403 | 409;
  constructor(status: 400 | 403 | 409, message: string) { super(message); this.status = status; }
}

export class Runner {
  private store: Store;
  private hooks: RunnerHooks;
  private now: () => Date;
  private running = new Set<string>();

  constructor(store: Store, hooks: RunnerHooks, now: () => Date = () => new Date()) {
    this.store = store;
    this.hooks = hooks;
    this.now = now;
  }

  private stamp() { return this.now().toISOString(); }

  private save(job: Job, rollout: Rollout) { this.store.setRollout(job.id, rollout, "running"); }

  /** Runs the Deployer's steps until one waits for people, fails, or all are done. One run per job at a time. */
  async advance(jobId: string): Promise<void> {
    if (this.running.has(jobId)) return;
    this.running.add(jobId);
    try { await this.run(jobId); } finally { this.running.delete(jobId); }
  }

  private async run(jobId: string) {
    const job = this.store.job(jobId);
    if (!job?.rollout || !["queued", "running"].includes(job.state) || job.rollout.host === "pending") return;
    const rollout = job.rollout;
    const log = (line: string) => rollout.log.push(`${this.stamp()} ${line}`);
    for (const step of rollout.steps) {
      if (step.where === "host" || step.state === "succeeded" || step.state === "skipped") continue;
      if (step.where === "person") {
        if (step.state === "pending") {
          step.state = "waiting";
          step.startedAt = this.stamp();
          log(`${step.component}: waiting for people to tick ${step.checks?.length ?? 0} items`);
          this.save(job, rollout);
          return;
        }
        if (step.state === "waiting" && step.checks?.every((c) => c.by)) {
          step.state = "succeeded";
          step.finishedAt = this.stamp();
          step.message = `全部 ${step.checks.length} 项已确认`;
          log(`${step.component}: every item ticked`);
          this.save(job, rollout);
          continue;
        }
        return;
      }
      const driver = this.hooks.drivers[step.type];
      step.state = "running";
      step.startedAt = this.stamp();
      this.save(job, rollout);
      let ctx: StepContext | undefined;
      try {
        if (!driver) throw new Error(`没有 ${step.type} 驱动`);
        ctx = await this.hooks.context(job, step);
        ctx.log = (line) => log(`${step.component}: ${line}`);
        const result = await driver.apply(ctx);
        step.result = result;
        this.save(job, rollout);
        const problem = await driver.verify(ctx, result);
        if (problem) throw new Error(`核对没通过：${problem}`);
        step.state = "succeeded";
        step.message = result.message;
        step.finishedAt = this.stamp();
        log(`${step.component}: ${result.message}`);
        this.save(job, rollout);
      } catch (error) {
        step.state = "failed";
        step.message = (error as Error).message;
        step.finishedAt = this.stamp();
        log(`${step.component}: failed: ${step.message}`);
        const undone = await this.undo(job, rollout, step, log);
        for (const s of rollout.steps) if (s.state === "pending") s.state = "skipped";
        this.save(job, rollout);
        const host = rollout.host === "done" ? "；容器保持新版本（健康检查已通过），需要时在部署记录里回到上一版" : "";
        await this.hooks.finish(this.store.job(job.id)!, "failed", `组件 ${step.component} 失败：${step.message}${undone.length ? `。已撤回：${undone.join("；")}` : ""}${host}`);
        return;
      }
    }
    await this.hooks.finish(this.store.job(job.id)!, "succeeded", `${job.app} ${job.version} 部署完成（${rollout.steps.length} 个组件）`);
  }

  /** Rolls back the Deployer steps done before (and the failed one, if it got as far as a result), newest first. */
  private async undo(job: Job, rollout: Rollout, failed: RolloutStep, log: (line: string) => void): Promise<string[]> {
    const done = rollout.steps.filter((s) => s.where === "deployer" && s.result && (s.state === "succeeded" || s === failed)).reverse();
    const out: string[] = [];
    for (const s of done) {
      try {
        const ctx = await this.hooks.context(job, s);
        ctx.log = (line) => log(`${s.component}: ${line}`);
        const { message, undone } = await this.hooks.drivers[s.type]!.rollback(ctx, s.result!);
        if (s !== failed && undone) s.state = "rolled-back";
        if (s !== failed) s.message = `${s.message ?? ""}；${undone ? "已撤回" : "未撤回"}：${message}`;
        out.push(message);
        log(`${s.component}: ${undone ? "rolled back" : "left as it is"}: ${message}`);
      } catch (error) {
        out.push(`${s.component} 撤回失败（${(error as Error).message}），需要人处理`);
        log(`${s.component}: rollback failed: ${(error as Error).message}`);
      }
    }
    return out;
  }

  /** A person ticks (or unticks) one item of a manual step; the run goes on once every item is ticked. */
  async check(jobId: string, component: string, index: number, checked: boolean, actor: Actor): Promise<Job> {
    const job = this.store.job(jobId);
    const step = job?.rollout?.steps.find((s) => s.component === component && s.where === "person");
    if (!job || !step || !step.checks) throw new RolloutError(400, "这个部署没有这个人工步骤。");
    if (step.state !== "waiting") throw new RolloutError(409, step.state === "pending" ? "还没到这个人工步骤：前面的步骤完成后才能勾选。" : "这个人工步骤已经结束。");
    const item = step.checks[index];
    if (!item) throw new RolloutError(400, "没有这一项。");
    if (checked) { item.by = actor.id; item.at = this.stamp(); } else { delete item.by; delete item.at; }
    job.rollout!.log.push(`${this.stamp()} ${component}: item ${index + 1} ${checked ? "ticked" : "unticked"} by ${actor.id}`);
    this.store.setRollout(job.id, job.rollout!);
    this.store.audit(actor, checked ? "deploy.manual-check" : "deploy.manual-uncheck", `${job.app}@${job.version}`, { job: job.id, component, item: index + 1, text: item.text });
    await this.advance(job.id);
    return this.store.job(job.id)!;
  }

  /** Stops a deploy that waits at a manual step; what is done stays done. */
  async stop(jobId: string, actor: Actor): Promise<Job> {
    const job = this.store.job(jobId);
    const waiting = job?.rollout?.steps.find((s) => s.state === "waiting");
    if (!job || !waiting) throw new RolloutError(409, "只能停止停在人工步骤上的部署。");
    waiting.state = "failed";
    waiting.finishedAt = this.stamp();
    waiting.message = `由 ${actor.id} 停止`;
    for (const s of job.rollout!.steps) if (s.state === "pending") s.state = "skipped";
    this.store.setRollout(job.id, job.rollout!);
    this.store.audit(actor, "deploy.stop", `${job.app}@${job.version}`, { job: job.id, at: waiting.component });
    await this.hooks.finish(this.store.job(job.id)!, "failed", `在人工步骤 ${waiting.component} 处由 ${actor.id} 停止；已完成的步骤保留`);
    return this.store.job(job.id)!;
  }
}
