/// <reference types="vite/client" />
// The page's calls to the Deployer API, relative to the base path the page is served under.

import type { Principal } from "../server/auth.ts";
import type { EnvironmentStatus } from "../server/observe.ts";
import type { AuditEntry, RegisteredApp } from "../server/store.ts";
import type { Manifest } from "../compose/generate.ts";

export type { AuditEntry, EnvironmentStatus, Manifest, Principal, RegisteredApp };

export type Me =
  | { signedIn: true; principal: Principal; environment?: string; workbenchUrl: string }
  | { signedIn: false; workbenchUrl: string; emergencyAvailable: boolean; reason: "unauthenticated" | "workbench-unavailable" }
  | { signedIn: false; forbidden: true; message: string };

export class ApiError extends Error {
  readonly status: number;
  readonly details: string[];
  constructor(status: number, message: string, details: string[] = []) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const BASE = import.meta.env.BASE_URL;
let csrfToken = "";

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${BASE}api/${path}`, {
    method,
    credentials: "same-origin",
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(method === "GET" ? {} : { "x-csrf-token": csrfToken }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, data.message ?? `HTTP ${response.status}`, data.details ?? []);
  return data as T;
}

export async function me(): Promise<Me> {
  const response = await fetch(`${BASE}api/me`, { credentials: "same-origin" });
  const data = await response.json().catch(() => ({}));
  if (response.status === 403) return { signedIn: false, forbidden: true, message: data.message };
  if (data.signedIn) csrfToken = data.principal.csrfToken;
  return data as Me;
}

export const status = () => call<EnvironmentStatus>("GET", "status");
export const apps = () => call<{ apps: RegisteredApp[] }>("GET", "apps");
export const app = (id: string) => call<{ app: RegisteredApp; manifests: Manifest[] }>("GET", `apps/${encodeURIComponent(id)}`);
export const revision = (id: string, from: string, rev: number) => call<Manifest>("GET", `apps/${encodeURIComponent(id)}/manifests/${encodeURIComponent(from)}/${rev}`);
export const revisionUrl = (id: string, from: string, rev: number) => `${BASE}api/apps/${encodeURIComponent(id)}/manifests/${encodeURIComponent(from)}/${rev}?download`;
export const saveManifest = (id: string, manifest: unknown, name?: string, note?: string) =>
  call<{ revision: number }>("PUT", `apps/${encodeURIComponent(id)}/manifests`, { manifest, ...(name ? { name } : {}), ...(note ? { note } : {}) });
export const removeApp = (id: string) => call<{ removed: string }>("DELETE", `apps/${encodeURIComponent(id)}`);
export const audit = () => call<{ entries: AuditEntry[] }>("GET", "audit");
export const emergencyLogin = (password: string) => call<{ signedIn: true }>("POST", "emergency/login", { password });
export const emergencyLogout = () => call<{ signedIn: false }>("POST", "emergency/logout");

// Phase 2: plans, builds, deploys, jobs.
import type { Plan } from "../server/plan.ts";
import type { Job } from "../server/store.ts";
import type { ExecutorInfo } from "../server/handoff.ts";
export type { ExecutorInfo, Job, Plan };

export type StatusView = EnvironmentStatus & { executor: ExecutorInfo; canDeploy: boolean; active: Pick<Job, "id" | "kind" | "app" | "version" | "state">[]; peer?: import("../server/peer.ts").PeerStatus | { error: string } };
export interface JobView { job: Omit<Job, "request">; request: Record<string, unknown>; log: string; record?: Record<string, unknown>; promotion?: import("../server/plan.ts").Promotion }

export const statusView = () => call<StatusView>("GET", "status");
export const versions = (id: string) => call<{ versions: string[]; error?: string; built: string[]; deployed: string | null }>("GET", `apps/${encodeURIComponent(id)}/versions`);
export const plan = (id: string, version: string, pinFrom?: string) => call<Plan>("POST", `apps/${encodeURIComponent(id)}/plan`, { version, ...(pinFrom ? { pinFrom } : {}) });
export const deploy = (id: string, version: string, acknowledgeManual: boolean, pinFrom?: string) =>
  call<{ job: Job }>("POST", `apps/${encodeURIComponent(id)}/deploy`, { version, acknowledgeManual, ...(pinFrom ? { pinFrom } : {}) });
export const build = (id: string, version: string) => call<{ jobs: Job[] }>("POST", `apps/${encodeURIComponent(id)}/build`, { version });
export const jobs = (app?: string) => call<{ jobs: Omit<Job, "request">[] }>("GET", `jobs${app ? `?app=${encodeURIComponent(app)}` : ""}`);
export const job = (id: string) => call<JobView>("GET", `jobs/${encodeURIComponent(id)}`);

// Phase 3: environment variables.
import type { EnvManager, EnvPlan } from "../server/env.ts";
export type { EnvPlan };
export type EnvView = Awaited<ReturnType<EnvManager["view"]>>;
export type Fingerprint = ReturnType<EnvManager["fingerprint"]>;
export type EnvEdit = { key: string; value?: string; keep?: boolean };

const envPath = (id: string, rest = "") => `apps/${encodeURIComponent(id)}/env${rest}`;
export const env = (id: string, revision?: number) => call<EnvView>("GET", envPath(id, revision ? `?revision=${revision}` : ""));
export const saveEnv = (id: string, base: number | null, values: EnvEdit[], note?: string) => call<{ revision: number }>("PUT", envPath(id), { base, values, ...(note ? { note } : {}) });
export const revertEnv = (id: string, revision: number, base: number | null) => call<{ revision: number }>("POST", envPath(id, "/revert"), { revision, base });
export const revealEnv = (id: string, revision: number, key: string) => call<{ value: string }>("POST", envPath(id, "/reveal"), { revision, key });
export const planEnv = (id: string, revision: number) => call<EnvPlan>("POST", envPath(id, "/plan"), { revision });
export const applyEnv = (id: string, revision: number) => call<{ job: Job }>("POST", envPath(id, "/apply"), { revision });
export const importEnv = (id: string) => call<{ job: Job }>("POST", envPath(id, "/import"));
export const fingerprint = (id: string) => call<Fingerprint>("GET", envPath(id, "/fingerprint"));

// Phase 4: artifacts, promotion, UAT seen from PROD.
import type { Artifact } from "../server/store.ts";
import type { PeerStatus } from "../server/peer.ts";
export type { PeerStatus };
export type ArtifactView = Artifact & { deployments: { id: string; environment: string; state: string; at: string; by: string; promotion: string | null }[] };
export const artifacts = (app?: string) => call<{ artifacts: ArtifactView[] }>("GET", `artifacts${app ? `?app=${encodeURIComponent(app)}` : ""}`);
export const peerFingerprint = (id: string) => call<Fingerprint>("GET", envPath(id, "/peer-fingerprint"));

// Phase 5: a deploy's manual step, ticked item by item, or stopped there.
export const check = (job: string, component: string, index: number, checked: boolean) => call<{ job: Job }>("POST", `jobs/${encodeURIComponent(job)}/checks`, { component, index, checked });
export const stopJob = (job: string) => call<{ job: Job }>("POST", `jobs/${encodeURIComponent(job)}/stop`);

// Phase 6: API keys.
import type { ApiKey } from "../server/keys.ts";
export type ApiKeyView = ApiKey;
export const keys = () => call<{ keys: ApiKey[] }>("GET", "keys");
export const createKey = (kind: "personal" | "service", name: string, days: number) => call<{ key: string; record: ApiKey }>("POST", "keys", { kind, name, days });
export const revokeKey = (id: string) => call<{ revoked: true }>("DELETE", `keys/${encodeURIComponent(id)}`);
export const planWithOverride = (id: string, version: string, reason: string) => call<Plan>("POST", `apps/${encodeURIComponent(id)}/plan`, { version, override: { reason } });
export const deployWithOverride = (id: string, version: string, acknowledgeManual: boolean, reason: string) =>
  call<{ job: Job }>("POST", `apps/${encodeURIComponent(id)}/deploy`, { version, acknowledgeManual, override: { reason } });
