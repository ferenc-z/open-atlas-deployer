// The deploy-driver interface (§4.2) for the components the Deployer itself applies through another service's API
// (workbench-app, studio-graph, oma-agent). compose-service and db-migration run on the host executor; manual is a
// checklist people tick. A step's result is kept in the job, so verify and rollback work from what apply did.

import type { Component, Manifest } from "../../compose/generate.ts";
import type { Bundle } from "../bundle.ts";
import type { Finding } from "../plan.ts";

export interface ComponentState {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
}

export interface StepContext {
  app: string;
  version: string;
  fromVersion: string | null;
  environment: string;
  component: Component & Record<string, unknown>;
  manifest: Manifest;
  bundle: Bundle | undefined;
  /** This environment's settings for the component (environment.json apps.<app>.settings.<component>). */
  settings: Record<string, string>;
  /** What the Deployer keeps between deploys for this component here (e.g. the OMA package id). */
  state: ComponentState;
  /** A value of the app's env file as last written to the server, for ${KEY} in settings. */
  envValue: (key: string) => string | undefined;
  log: (line: string) => void;
}

export interface StepPlan { before?: string; after: string; findings: Finding[] }
export interface StepResult { message: string; detail: Record<string, unknown> }
/** undone: whether the service is back as it was; false when the change stays (said in the message). */
export interface Undo { message: string; undone: boolean }

export interface DeployDriver {
  type: string;
  plan(ctx: StepContext): Promise<StepPlan>;
  apply(ctx: StepContext): Promise<StepResult>;
  /** A problem, or null when what apply did is in place. */
  verify(ctx: StepContext, result: StepResult): Promise<string | null>;
  rollback(ctx: StepContext, result: StepResult): Promise<Undo>;
  /** Does it interrupt the people using the app, and for how long (§8.4). */
  impact(component: Component): string;
}

export const block = (code: string, message: string): Finding => ({ code, message, blocking: true });
export const note = (code: string, message: string): Finding => ({ code, message, blocking: false });

/** {{name}} placeholders filled from values; the names with no value are returned, not left in. */
export function fill(template: string, values: Record<string, string>): { text: string; missing: string[] } {
  const missing = new Set<string>();
  const text = template.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_, name: string) => {
    if (values[name] === undefined) { missing.add(name); return ""; }
    return values[name]!;
  });
  return { text, missing: [...missing] };
}

/** ${KEY} in a setting refers to the app's env file (deploy-manifest v1). */
export function resolveEnv(value: string, envValue: (key: string) => string | undefined): { value: string; missing: string[] } {
  const missing: string[] = [];
  const out = value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, key: string) => {
    const v = envValue(key);
    if (v === undefined) missing.push(key);
    return v ?? "";
  });
  return { value: out, missing };
}
