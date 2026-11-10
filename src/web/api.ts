/// <reference types="vite/client" />
// The page's calls to the Deployer API, relative to the base path the page is served under.

import type { Principal } from "../server/auth.ts";
import type { EnvironmentStatus } from "../server/observe.ts";
import type { AuditEntry, RegisteredApp, ServiceConfigDraft } from "../server/store.ts";
import type { Manifest } from "../compose/generate.ts";
import type { SetupStatus, SetupStep } from "../server/setup.ts";
import type { AiItem, AiStatus, AiUse } from "../server/setup-ai.ts";
import type { SettingRow } from "../server/deployer-settings.ts";

export type { SettingRow };
export type { AiItem, AiStatus, AiUse, AuditEntry, EnvironmentStatus, Manifest, Principal, RegisteredApp, SetupStatus, SetupStep };

export type Me =
  | { signedIn: true; principal: Principal; environment?: string; workbenchUrl: string; deployerVersion?: string }
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
/** §15 (D41): the first setup. */
export const setup = () => call<SetupStatus>("GET", "setup");
export const createEnvironment = (form: Record<string, string>) => call<{ revision: number }>("POST", "setup/environment", form);
export const importWorkbenchManifest = () => call<{ revision: number }>("POST", "setup/workbench-manifest", {});
export const generateWorkbenchEnv = (adminEmail: string, deployerUrl: string) => call<{ revision: number; password: string; job: string | null }>("POST", "setup/workbench-env", { adminEmail, deployerUrl });
export const setWorkbenchKey = (key: string) => call<{ source: string }>("PUT", "setup/workbench-key", { key });
export const createWorkbenchGroups = () => call<{ created: string[] }>("POST", "setup/workbench-groups", {});
export const addDeployerLink = (deployerUrl: string) => call<{ revision: number }>("POST", "setup/workbench-applinks", { deployerUrl });
/** Step 6 (L3): what the AI features still need; the Deployer's entry in Workbench's application list. */
export const setupAi = () => call<AiStatus>("GET", "setup/ai");
export const registerInWorkbench = (deployerUrl: string) => call<{ url: string; groups: number }>("POST", "setup/workbench-entry", { deployerUrl });
/** This page's own address, as Workbench's app menu should link it. */
export type DeployerSettingsView = {
  settings: SettingRow[]; pending: boolean; canRestart: boolean; startedAt: string;
  workbenchKey: { source: "file" | "page" | null; canSet: { ok: true } | { ok: false; reason: string } };
};
export const deployerSettings = () => call<DeployerSettingsView>("GET", "deployer-settings");
export const saveDeployerSettings = (changes: { key: string; value: string | null }[]) => call<DeployerSettingsView & { changed: string[] }>("PUT", "deployer-settings", { changes });
export const restartDeployer = () => call<{ restarting: true }>("POST", "deployer-settings/restart", {});
export const deployerUrl = () => new URL(BASE, location.href).href;
export const apps = () => call<{ apps: RegisteredApp[] }>("GET", "apps");
export const app = (id: string) => call<{ app: RegisteredApp; manifests: Manifest[] }>("GET", `apps/${encodeURIComponent(id)}`);
export const revision = (id: string, from: string, rev: number) => call<Manifest>("GET", `apps/${encodeURIComponent(id)}/manifests/${encodeURIComponent(from)}/${rev}`);
export const revisionUrl = (id: string, from: string, rev: number) => `${BASE}api/apps/${encodeURIComponent(id)}/manifests/${encodeURIComponent(from)}/${rev}?download`;
/** D38: what a manifest change would save: merged manifest, findings, warnings, the versions it affects, the diff. */
export type ManifestCheck = { appliesFrom: string; base: number | null; newRange: boolean; findings: string[]; warnings: string[]; repoChange: boolean; diff: string;
  affected: { from: string | null; to: string | null; deployed: string[]; neverDeployed: string[]; versionsUnknown?: string } };
export const appManifest = (id: string, appliesFrom?: string) => call<{ appliesFrom: string; revision: number; manifest: Manifest; ranges: { appliesFrom: string; revision: number }[] }>("GET", `apps/${encodeURIComponent(id)}/manifest${appliesFrom ? `?applies_from=${encodeURIComponent(appliesFrom)}` : ""}`);
export const checkManifest = (id: string, manifest: unknown, base: number | null, repoChange = false) => call<ManifestCheck>("POST", `apps/${encodeURIComponent(id)}/manifests/validate`, { manifest, ...(base !== null ? { base } : {}), ...(repoChange ? { repoChange: true } : {}) });
export const saveManifest = (id: string, manifest: unknown, base: number | null, options: { name?: string; note?: string; repoChange?: boolean } = {}) =>
  call<{ revision: number; warnings: string[] }>("PUT", `apps/${encodeURIComponent(id)}/manifests`, { manifest, ...(base !== null ? { base } : {}), ...(options.name ? { name: options.name } : {}), ...(options.note ? { note: options.note } : {}), ...(options.repoChange ? { repoChange: true } : {}) });
export const takeRegistryFromUat = () => call<{ added: string[]; unchanged: number }>("POST", "registry/from-uat", {});

/** D38: the environment settings, kept as revisions. */
export type EnvironmentView = { revision: number; environment: Record<string, unknown>; changes: string[]; source: string; savedAt: string; savedBy: string; note: string | null;
  latest: number; revisions: { revision: number; changes: string[]; source: string; savedAt: string; savedBy: string; via: string; note: string | null }[]; fileDiffers: boolean; file: string; canSave: boolean };
export type EnvironmentCheck = { base: number; latest: number; stale: boolean; changes: string[]; findings: { at: string; expected: string }[]; diff: string };
export const environmentSettings = (revision?: number) => call<EnvironmentView>("GET", `environment${revision ? `?revision=${revision}` : ""}`);
export const environmentExportUrl = (revision: number) => `${BASE}api/environment/export?revision=${revision}`;
export const checkEnvironment = (base: number, environment: unknown) => call<EnvironmentCheck>("POST", "environment/validate", { base, environment });
export const saveEnvironment = (base: number, environment: unknown, note?: string) => call<{ revision: number; changes: string[] }>("PUT", "environment", { base, environment, ...(note ? { note } : {}) });
export const removeApp = (id: string) => call<{ removed: string }>("DELETE", `apps/${encodeURIComponent(id)}`);
export const audit = () => call<{ entries: AuditEntry[] }>("GET", "audit");
export const emergencyLogin = (password: string) => call<{ signedIn: true }>("POST", "emergency/login", { password });
export const emergencyLogout = () => call<{ signedIn: false }>("POST", "emergency/logout");

// Phase 2: plans, builds, deploys, jobs.
import type { Plan } from "../server/plan.ts";
import type { Job } from "../server/store.ts";
import type { ExecutorInfo } from "../server/handoff.ts";
export type { ExecutorInfo, Job, Plan };

export type StatusView = EnvironmentStatus & { executor: ExecutorInfo; executors: ExecutorInfo[]; hostOf: Record<string, string>; canDeploy: boolean; active: Pick<Job, "id" | "kind" | "app" | "version" | "state">[]; peer?: import("../server/peer.ts").PeerStatus | { error: string } };
export interface JobView { job: Omit<Job, "request">; request: Record<string, unknown>; log: string; record?: Record<string, unknown>; promotion?: import("../server/plan.ts").Promotion }

export const statusView = () => call<StatusView>("GET", "status");

// D35: the hosts of this environment and their executors' tokens.
export type ExecutorUpgrade = { available: boolean; blocked?: string; from: "github" | "directory" | null; job: { id: string; state: Job["state"]; version: string; message: string | null; finishedAt: string | null } | null };
/** S18: a host runs a deploy executor, a service executor, or both, each with its own tokens. */
export type ExecutorKind = "deploy" | "service";
export type HostView = { id: string; address: string | null; executor: ExecutorInfo; apps: string[]; report: { at: string; stale: boolean; containers: number } | null; tokens: { executor: ExecutorKind; prefix: string; createdAt: string; createdBy: string; revokedAt: string | null }[]; upgrade: ExecutorUpgrade; service: ExecutorInfo | null };
export const hosts = () => call<{ executorVersion: string; hosts: HostView[] }>("GET", "hosts");
export const upgradeExecutor = (id: string) => call<{ job: Job }>("POST", `hosts/${encodeURIComponent(id)}/upgrade-executor`, {});
/** D39: the Overview's Platform area. */
export type UpgradeJob = { id: string; state: Job["state"]; version: string; fromVersion?: string | null; message: string | null; finishedAt: string | null };
export type PlatformView = {
  deployer: { version: string; host: string | null; image: string | null; blocked?: string; job: UpgradeJob | null; repo: string | null; latest?: string | null; error?: string;
    versions: { version: string; prerelease: boolean; relation: "newer" | "older" | "running" | "unknown" }[] };
  executors: { host: string; online: boolean; reason?: string; version: string | null; upgrade: ExecutorUpgrade }[];
  shipped: string; canUpgrade: boolean;
  batch: { startedAt: string; current: { host: string; job: string } | null; remaining: string[]; done: string[]; stopped?: string; finishedAt?: string } | null;
};
export type DeployerPlan = { from: string; to: string; host: string | null; image: string | null; older: boolean; same: boolean; blocked?: string; steps: string[]; warnings: string[];
  release?: { released: boolean; detail: string; notes?: string; url?: string } };
export const platform = () => call<PlatformView>("GET", "platform");
export const deployerPlan = (version: string) => call<DeployerPlan>("GET", `deployer/plan?version=${encodeURIComponent(version)}`);
export const upgradeDeployer = (version: string, confirmOlder = false) => call<{ job: Job }>("POST", "deployer/upgrade", { version, ...(confirmOlder ? { confirmOlder: true } : {}) });
export const upgradeOutdated = () => call<{ batch: PlatformView["batch"] }>("POST", "hosts/upgrade-outdated", {});
export const issueHostToken = (id: string, executor: ExecutorKind = "deploy") => call<{ host: string; executor: ExecutorKind; token: string }>("POST", `hosts/${encodeURIComponent(id)}/token`, { executor });
export const revokeHost = (id: string, executor?: ExecutorKind) => call<{ revoked: number }>("POST", `hosts/${encodeURIComponent(id)}/revoke`, executor ? { executor } : {});

// D36: addresses, the recommended nginx configuration and its revisions, the internal CA.
export type IngressView = {
  domain: string | null;
  endpoints: { app: string; host: string; kind: string; url?: string; upstream?: string; problem?: string }[];
  nginx: { body: string; sha256: string; problems: string[]; latest: { revision: number; sha256: string; savedAt: string; savedBy: string; note: string | null } | null; diff: string | null };
  revisions: { revision: number; sha256: string; savedAt: string; savedBy: string; note: string | null }[];
  ca: { subject: string; issuer: string; validTo: string; fingerprint256: string } | null;
  canSave: boolean;
  canSetCa: boolean;
};
export const ingress = () => call<IngressView>("GET", "ingress");
export const saveNginx = (note: string) => call<{ revision: number }>("POST", "ingress/nginx", { note });
export const nginxRevisionUrl = (revision: number) => `${BASE}api/ingress/nginx/${revision}`;
export const setCa = (pem: string) => call<{ ca: IngressView["ca"] }>("PUT", "settings/ca", { pem });
/** uncovered: versions no manifest covers yet, which need an assessment first (D32). */
export type VersionList = { versions: string[]; error?: string; built: string[]; uncovered: string[]; deployed: string | null };
export const versions = (id: string) => call<VersionList>("GET", `apps/${encodeURIComponent(id)}/versions`);
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

// Phase 8: drift, the daily brief, deploys announced in Workbench.
import type { DriftItem } from "../server/drift.ts";
import type { Brief } from "../server/brief.ts";
export type DriftView = DriftItem;
export type BriefView = Brief;
export const drift = () => call<{ drift: DriftItem[] }>("GET", "drift");
export const brief = () => call<{ brief: Brief | null }>("GET", "brief");
export const regenerateBrief = () => call<{ brief: Brief }>("POST", "brief");
export const deployWithNotice = (id: string, version: string, minutes: number, pinFrom?: string) =>
  call<{ job: Job }>("POST", `apps/${encodeURIComponent(id)}/deploy`, { version, acknowledgeManual: true, notice: { minutes }, ...(pinFrom ? { pinFrom } : {}) });

// Phase 7: assessments.
import type { Assessment } from "../server/onboarding.ts";
export type AssessmentView = Omit<Assessment, "tokenSha256"> & { manifest: Manifest };
const asm = (id: string, rest = "") => `assessments/${encodeURIComponent(id)}${rest}`;
export const assessments = () => call<{ assessments: AssessmentView[] }>("GET", "assessments");
export const assessment = (id: string) => call<AssessmentView>("GET", asm(id));
export const startAssessment = (body: { repo?: string; version?: string; app?: string }) => call<{ assessment: AssessmentView }>("POST", "assessments", body);
export const changeDraft = (id: string, operation: string, body: Record<string, unknown>) => call<AssessmentView>("POST", asm(id, `/draft/${operation}`), body);
export const validateDraft = (id: string) => call<{ findings: Assessment["findings"] }>("POST", asm(id, "/validate"));
export const trialAssessment = (id: string) => call<{ assessment: AssessmentView; job: Job }>("POST", asm(id, "/trial"), {});
export const registerAssessment = (id: string) => call<AssessmentView>("POST", asm(id, "/register"));
export const closeAssessment = (id: string) => call<AssessmentView>("POST", asm(id, "/close"));
export const openIssue = (id: string) => call<AssessmentView>("POST", asm(id, "/issue"));
export const planWithOverride = (id: string, version: string, reason: string) => call<Plan>("POST", `apps/${encodeURIComponent(id)}/plan`, { version, override: { reason } });
export const deployWithOverride = (id: string, version: string, acknowledgeManual: boolean, reason: string) =>
  call<{ job: Job }>("POST", `apps/${encodeURIComponent(id)}/deploy`, { version, acknowledgeManual, override: { reason } });

// Service ops (phase 1): managed services (NiFi) taken over from discovery, and their status.
import type { DraftItem, ServiceDraft } from "../server/services/draft.ts";
import type { Finding, Skipped } from "../server/services/assess.ts";
import type { MemberStatus, ServiceStatus } from "../server/services/status.ts";
import type { ConfigFileRecord } from "../server/services/config.ts";
import type { ChangeAssessment, ConfigFinding } from "../server/services/configcheck.ts";
import type { DraftChangeView, MemberDiff } from "../server/services/configedit.ts";
import type { CatalogView, CompareRow, ConfigView, FileCompare, PropertyRow } from "../server/services/configview.ts";
export type { CatalogView, CompareRow, ConfigView, FileCompare, PropertyRow };
export type { DraftItem, Finding, MemberStatus, ServiceDraft, ServiceStatus, Skipped };
export type ServiceSummary = ServiceStatus["summary"];
type Registered = { environment: string; draft: string | null; createdAt: string; createdBy: string; configRevision: number | null; status: ServiceSummary | null; states: MemberStatus["state"][];
  /** Phase 2: the last hour in 5-minute steps (heap % averaged over the members, queued flowfiles summed). */
  trend: { heapPct: (number | null)[]; queuedCount: (number | null)[] } };
export type RegisteredService = (Extract<DraftItem, { kind: "standalone" }> | Extract<DraftItem, { kind: "cluster" }>) & Registered;
export const services = () => call<{ standalones: RegisteredService[]; clusters: RegisteredService[] }>("GET", "services");
export const serviceStatus = (id: string) => call<ServiceStatus>("GET", `services/${encodeURIComponent(id)}/status`);
export type ServiceConfigView = { service: string; revision: number; source: string; savedAt: string; savedBy: string; via: string; note: string | null;
  body: { members: { host: string; installDir: string; confDir?: string; files: Omit<ConfigFileRecord, "sealed">[]; missing: string[] }[]; layers?: unknown };
  revisions: { revision: number; source: string; savedAt: string; savedBy: string; via: string; note: string | null; base: number | null }[];
  /** The revision this one was edited from, its findings when saved, and its AI review (step 6 fills it). */
  base: number | null; findings: ConfigFinding[] | null; review: ConfigReview | null;
  canDraft: boolean; canReveal: boolean;
  /** S24: parsed rows, the catalog, and a cluster's node comparison (null when the service is not registered). */
  view: ConfigView | null };
export const serviceConfig = (id: string, revision?: number) => call<ServiceConfigView>("GET", `services/${encodeURIComponent(id)}/config${revision ? `?revision=${revision}` : ""}`);
// Phase 3: configuration drafts and revisions (§7, §16.3). A draft is changes on a revision; saving one makes the next
// revision and changes nothing on the hosts.
export type { ChangeAssessment, ConfigFinding, DraftChangeView, MemberDiff };
export type ConfigReview = { state?: string; text?: string; error?: string };
/** What is sent: as the page got it (a secret as hidden: true keeps the draft's own new value), or a new secret. */
export type DraftChangeInput = DraftChangeView | { file: string; member: string | null; key: string; secret: string };
export type ConfigDraft = Omit<ServiceConfigDraft, "changes"> & { changes: DraftChangeView[]; stale: boolean };
export type DraftPreview = { findings: ConfigFinding[]; change: ChangeAssessment | null; members: MemberDiff[] } | { problem: { code: string; message: string } } | null;
export type ConfigDraftDetail = ConfigDraft & { preview: DraftPreview };
export type ConfigDiff = { service: string; from: number | null; to: number; members: MemberDiff[] };
const configPath = (id: string, rest: string) => `services/${encodeURIComponent(id)}/config/${rest}`;
export type { DriftFile, LiveDiff, LiveDifferences, MemberDrift, ServiceDrift } from "../server/services/configdrift.ts";
export type DriftAnswer = import("../server/services/configdrift.ts").ServiceDrift & { differences?: import("../server/services/configdrift.ts").LiveDifferences };
export const serviceDrift = (id: string, member?: string) => call<DriftAnswer>("GET", `services/${encodeURIComponent(id)}/drift${member ? `?member=${encodeURIComponent(member)}` : ""}`);
export const adoptDrift = (id: string, body: { member: string; file: string; sha256: string; replacePending?: boolean }) => call<{ revision: number; saved: boolean; findings: ConfigFinding[] }>("POST", `services/${encodeURIComponent(id)}/drift/adopt`, body);
export const serviceConfigDiff = (id: string, q: { from?: number; to?: number; member?: string }) => {
  const query = new URLSearchParams(Object.entries(q).flatMap(([k, v]) => (v === undefined || v === "" ? [] : [[k, String(v)]])));
  return call<ConfigDiff>("GET", configPath(id, `diff?${query}`));
};
export const configDrafts = (id: string, state?: "open" | "saved" | "discarded") => call<{ drafts: ConfigDraft[] }>("GET", configPath(id, `drafts${state ? `?state=${state}` : ""}`));
export const configDraft = (id: string, draft: string) => call<ConfigDraftDetail>("GET", configPath(id, `drafts/${encodeURIComponent(draft)}`));
export const createConfigDraft = (id: string, body: { base: number; changes: DraftChangeInput[]; note?: string }) => call<ConfigDraftDetail>("POST", configPath(id, "drafts"), body);
export const putConfigDraft = (id: string, draft: string, body: { base?: number; changes?: DraftChangeInput[]; note?: string }) => call<ConfigDraftDetail>("PUT", configPath(id, `drafts/${encodeURIComponent(draft)}`), body);
export const discardConfigDraft = (id: string, draft: string) => call<ConfigDraft>("DELETE", configPath(id, `drafts/${encodeURIComponent(draft)}`));
export const saveConfigDraft = (id: string, draft: string, note?: string) => call<{ revision: number; findings: ConfigFinding[]; change: ChangeAssessment | null; draft: ConfigDraft }>("POST", configPath(id, `drafts/${encodeURIComponent(draft)}/save`), note === undefined ? {} : { note });
/** A kept value (admin in a browser): one key at a time, and written to the audit trail. */
export const revealConfigValue = (id: string, body: { member?: string; revision: number; file: string; key: string; index?: number }) => call<{ value: string; count: number }>("POST", configPath(id, "reveal"), body);
/** svc-discover on a host's service executor; the newest one. */
/** One asked installation: its path, or with its conf directory when that is elsewhere (and conf.dir does not say so). */
export type DiscoverDir = string | { install: string; conf?: string };
export type DiscoveryView = { id: string; host: string; dirs: DiscoverDir[]; state: string; message: string | null; startedAt: string | null; finishedAt: string | null;
  result: { scannedAt?: string; user?: string; isRoot?: boolean; instances: Record<string, any>[]; dirs: { dir: string; conf?: string; found: boolean; running?: boolean; error?: string }[]; skipped: { pid: number; user: string }[] } | null; log: string };
export const discover = (host: string, dirs: DiscoverDir[] = []) => call<{ id: string; host: string; dirs: DiscoverDir[]; state: string }>("POST", `hosts/${encodeURIComponent(host)}/discover`, { dirs });
export const discovery = (host: string) => call<DiscoveryView>("GET", `hosts/${encodeURIComponent(host)}/discover`);
// §16.3: changes. A plan is only worked out; a change starts with the plan's hash, and the buttons steer it.
import type { changeView, ChangeKind, planView } from "../server/services/changes.ts";
export type { ChangeKind };
export type ChangePlan = ReturnType<typeof planView>;
export type ServiceChangeView = ReturnType<typeof changeView>;
export type ChangeOptionsInput = { offload?: boolean; invalidTolerance?: number; stableSeconds?: number; timeouts?: Record<string, number> };
export type ChangeRequest = { kind: ChangeKind; revision?: number; members?: string[]; options?: ChangeOptionsInput };
const changesPath = (id: string, rest = "") => `services/${encodeURIComponent(id)}/changes${rest}`;
export const serviceChanges = (id: string) => call<{ changes: ServiceChangeView[]; active: string | null }>("GET", changesPath(id));
export const serviceChange = (id: string, change: string) => call<ServiceChangeView>("GET", changesPath(id, `/${encodeURIComponent(change)}`));
export const planChange = (id: string, request: ChangeRequest) => call<ChangePlan>("POST", changesPath(id, "/plan"), request);
export const startChange = (id: string, request: ChangeRequest, planHash: string, reason: string) => call<ServiceChangeView>("POST", changesPath(id), { ...request, planHash, ...(reason ? { reason } : {}) });
export const steerChange = (id: string, change: string, action: "continue" | "stop" | "rollback" | "force-kill" | "close", body: Record<string, unknown> = {}) =>
  call<ServiceChangeView>("POST", changesPath(id, `/${encodeURIComponent(change)}/${action}`), body);
export const rollBackConfig = (id: string, revision: number, note?: string) => call<{ revision: number; saved: boolean; findings: ConfigFinding[] }>("POST", `services/${encodeURIComponent(id)}/config/rollback`, { revision, ...(note ? { note } : {}) });
export const setMemberStart = (id: string, member: string, environment: Record<string, string>) => call<{ kept: string[]; dropped: string[] }>("PUT", `services/${encodeURIComponent(id)}/members/${encodeURIComponent(member)}/start`, { environment });
export type DraftSummary = Omit<ServiceDraft, "items" | "review">;
const drafts = (rest = "") => `services/drafts${rest}`;
export const serviceDrafts = (state?: "open" | "confirmed" | "discarded") => call<{ drafts: DraftSummary[] }>("GET", drafts(state ? `?state=${state}` : ""));
export const serviceDraft = (id: string) => call<ServiceDraft>("GET", drafts(`/${encodeURIComponent(id)}`));
export const createServiceDraft = (hosts?: string[]) => call<{ draft: ServiceDraft; skipped: Skipped[]; missing: string[] }>("POST", drafts(), hosts ? { hosts } : {});
export const putDraftItem = (id: string, item: DraftItem) => call<{ result: "added" | "changed"; draft: ServiceDraft }>("PUT", drafts(`/${encodeURIComponent(id)}/items/${encodeURIComponent(item.id)}`), item);
export const removeDraftItem = (id: string, item: string) => call<ServiceDraft>("DELETE", drafts(`/${encodeURIComponent(id)}/items/${encodeURIComponent(item)}`));
export const reassessDraft = (id: string) => call<ServiceDraft>("POST", drafts(`/${encodeURIComponent(id)}/assess`), {});
export const reviewDraft = (id: string) => call<ServiceDraft>("POST", drafts(`/${encodeURIComponent(id)}/review`), {});
export const discardDraft = (id: string) => call<ServiceDraft>("POST", drafts(`/${encodeURIComponent(id)}/discard`), {});
export const confirmDraft = (id: string) => call<{ draft: ServiceDraft; registered: string[]; reads: string[] }>("POST", drafts(`/${encodeURIComponent(id)}/confirm`), {});
// Phase 2 step 2 (§15.3): a service's numbers per member, its bulletins.
import type { Field, MetricsView, Range } from "../server/services/metrics.ts";
import type { ServiceBulletin, ServiceCert } from "../server/store.ts";
export type { Field, MetricsView, Range, ServiceBulletin, ServiceCert };
export const serviceMetrics = (id: string, range: Range, fields?: Field[]) =>
  call<MetricsView>("GET", `services/${encodeURIComponent(id)}/metrics?range=${range}${fields ? `&fields=${fields.join(",")}` : ""}`);
export const serviceBulletins = (id: string, limit = 50) => call<{ bulletins: ServiceBulletin[] }>("GET", `services/${encodeURIComponent(id)}/bulletins?limit=${limit}`);
// Phase 2 step 3 (§15.3): alerts, the timeline, the thresholds.
import type { RuleId } from "../server/services/rules.ts";
import type { Thresholds } from "../server/services/profiles.ts";
import type { TimelineEvent } from "../server/services/status.ts";
import type { ServiceAlert } from "../server/store.ts";
export type { RuleId, Thresholds, TimelineEvent };
export type AlertView = ServiceAlert & { label: string; text: string; memberLabel: string | null };
export type RuleInfo = { label: string; scope: "member" | "service"; levels: ("WARN" | "CRIT")[]; description: string };
export type ThresholdInfo = { label: string; unit: string; min: number; max: number; rule: RuleId; description: string };
export type ThresholdsView = { defaults: Thresholds; overrides: Partial<Thresholds>; effective: Thresholds; info: Record<keyof Thresholds, ThresholdInfo> };
export const serviceAlerts = (id: string) => call<{ alerts: AlertView[]; rules: Record<RuleId, RuleInfo>; thresholds: ThresholdsView; canEdit: boolean }>("GET", `services/${encodeURIComponent(id)}/alerts`);
export const serviceEvents = (id: string, limit = 200) => call<{ events: TimelineEvent[] }>("GET", `services/${encodeURIComponent(id)}/events?limit=${limit}`);
export const putThresholds = (id: string, thresholds: Partial<Record<keyof Thresholds, number | null>>) => call<{ thresholds: ThresholdsView }>("PUT", `services/${encodeURIComponent(id)}/thresholds`, { thresholds });
export type GlobalAlert = AlertView & { kind: "standalone" | "cluster"; environment: string; profile: string };
export const alerts = (state: "open" | "all" = "open") => call<{ alerts: GlobalAlert[]; open: number; rules: Record<RuleId, RuleInfo> }>("GET", `alerts?state=${state}`);
// Phase 2 step 4 (§9.3, §15.3): a service's logs through its service executors.
import type { LogEntry, LogMember, SearchResult } from "../server/services/logs.ts";
import type { LogPattern } from "../server/store.ts";
export type { LogEntry, LogMember, LogPattern, SearchResult };
export type LogFile = { name: string; size: number; modifiedAt: string; gz: boolean };
export type LogSearch = { members?: string[]; files?: string[]; from: string; to: string; levels?: string[]; query?: string; regex?: boolean; limit?: number };
const logsPath = (id: string, rest = "") => `services/${encodeURIComponent(id)}/logs${rest}`;
export const serviceLogs = (id: string, hours = 24) => call<{ members: LogMember[]; hours: number; patterns: LogPattern[]; tails: { member: string; file: string; followers: number }[] }>("GET", logsPath(id, `?hours=${hours}`));
export const logFiles = (id: string, member: string) => call<{ dir: string; files: LogFile[]; more: number }>("GET", logsPath(id, `/files?member=${encodeURIComponent(member)}`));
export const searchLogs = (id: string, q: LogSearch) => call<SearchResult>("POST", logsPath(id, "/search"), q);
/** Opened by the page itself (a link, an EventSource): the session cookie goes along, a GET needs no CSRF token. */
export const logDownloadUrl = (id: string, member: string, files: string[]) => `${BASE}api/${logsPath(id, `/download?member=${encodeURIComponent(member)}&files=${files.map(encodeURIComponent).join(",")}`)}`;
export const logTailUrl = (id: string, member: string, file: string) => `${BASE}api/${logsPath(id, `/tail?member=${encodeURIComponent(member)}&file=${encodeURIComponent(file)}`)}`;
// Phase 2 step 6 (§9.4, §15.3): a service's nginx address for Studio's nifi-ops graph, its check, the graph's runs.
import type { GraphRun, NginxCheck } from "../server/store.ts";
export type { GraphRun, NginxCheck };
export type GraphState = { graph: string; configured: boolean; services: { id: string; kind: string; version: string; nginxUrl: string }[]; runs: GraphRun[]; canPublish: boolean };
export const putServiceNginx = (id: string, nginxUrl: string | null) => call<{ nginxUrl: string | null; check: NginxCheck | null; changed: boolean; graph: { name: string; configured: boolean } }>("PUT", `services/${encodeURIComponent(id)}/nginx`, { nginxUrl });
export const checkServiceNginx = (id: string) => call<{ nginxUrl: string; check: NginxCheck }>("POST", `services/${encodeURIComponent(id)}/nginx/check`);
export const serviceGraph = () => call<GraphState>("GET", "services/graph");
export const publishServiceGraph = () => call<GraphRun>("POST", "services/graph/publish");
// Phase 2 step 7 (§9.5, S28): the FlowFile trace, read by the service executors from NiFi's provenance.
import type { ProvenanceMember } from "../server/services/provenance.ts";
export type { ProvenanceMember };
export type ProvenanceInfo = { kind: string; version: string; supported: boolean; note: string; members: ProvenanceMember[]; ready: boolean };
export type ProvEvent = {
  id?: string; eventId: number; eventTime?: string; at: string | null; eventType: string; flowFileUuid: string; fileSizeBytes?: number;
  clusterNodeId?: string; clusterNodeAddress?: string; member?: string | null; groupId?: string; componentId?: string; componentType?: string; componentName?: string;
  relationship?: string; details?: string; eventDuration?: number; lineageDuration?: number; parentUuids?: string[]; childUuids?: string[]; transitUri?: string;
  attributes?: { name: string; value?: string; previousValue?: string }[]; attributesHidden?: boolean;
};
export type ProvenanceResult = { from: string; to: string; events: ProvEvent[]; total: number; totalText?: string; limit: number; limitReached: boolean; scope: string; shiftedHours: number; notes?: string[]; errors: string[]; nifiVersion: string; via: { member: string; label: string } };
export type LineageNode = { id: string; type: "FLOWFILE" | "EVENT"; flowFileUuid?: string; eventType?: string; at: string | null; parentUuids?: string[]; childUuids?: string[]; clusterNodeIdentifier?: string; componentId?: string; componentName?: string; componentType?: string; relationship?: string; details?: string; error?: string };
export type LineageResult = { nodes: LineageNode[]; links: { sourceId: string; targetId: string; flowFileUuid?: string; at: string | null }[]; enriched: number; notes?: string[]; errors: string[]; direction: string };
export type ProvenanceSearchAsk = { uuid?: string; field?: string; value?: string; from: string; to: string; maxResults?: number; node?: string };
const provPath = (id: string, rest = "") => `services/${encodeURIComponent(id)}${rest}`;
export const provenanceInfo = (id: string) => call<ProvenanceInfo>("GET", provPath(id, "/provenance"));
export const provenanceOptions = (id: string) => call<{ fields: { id: string; field: string; label: string; type: string }[] }>("GET", provPath(id, "/provenance/options"));
export const searchProvenance = (id: string, q: ProvenanceSearchAsk) => call<ProvenanceResult>("POST", provPath(id, "/provenance"), q);
export const lineage = (id: string, q: { uuid?: string; eventId?: number; direction?: string; node?: string }) => call<LineageResult>("POST", provPath(id, "/lineage"), q);
export const provenanceEvent = (id: string, eventId: number, node?: string) => call<{ event: ProvEvent; member: string | null }>("GET", provPath(id, `/provenance/events/${eventId}${node ? `?node=${encodeURIComponent(node)}` : ""}`));
export const bulletinsBetween = (id: string, from: string, to: string, limit = 200) => call<{ bulletins: ServiceBulletin[] }>("GET", `services/${encodeURIComponent(id)}/bulletins?limit=${limit}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
