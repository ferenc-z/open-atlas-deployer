// Settings from the environment. Everything secret (the emergency password hash, the credential key) lives only in
// the host's env file for the Deployer.

import { join, resolve } from "node:path";

export interface Config {
  bind: string;
  port: number;
  /** The path the reverse proxy serves the Deployer under (§9.1), same domain as Workbench. */
  basePath: string;
  dataDir: string;
  /** Workbench as the Deployer reaches it, e.g. http://workbench:8090 on the compose network. */
  workbenchUrl: string;
  /** Where the browser signs in to Workbench. */
  workbenchPublicUrl: string;
  /** This environment's desired state (§7.1): name, registries, each app's version. */
  environmentFile: string;
  /** GitHub read-only token for listing a private release repo's tags. */
  githubTokenFile?: string;
  /** service -> base URL, for asking /meta/contracts outside the compose network (development). */
  observeUrls: Record<string, string>;
  emergencyPasswordHash?: string;
  /** base64, 32 bytes: seals env secrets (§7.2). Without it env management is off. */
  credentialKey?: string;
  /** Shared by the UAT and PROD Deployers so secret fingerprints compare across them. */
  compareKey?: string;
  /** The Deployer's own env templates (env.template in a manifest). */
  templatesDir: string;
  /** GitHub's API (release bundles, release.json for contracts); a stand-in for tests and local runs. */
  githubApi: string;
  /** Workbench Administration → API keys key the drivers use (workbench-app, oma-agent; instead of W2 for now). */
  workbenchApiKeyFile?: string;
  /** Studio Builder MCP and the workspace token (oaw_v1., read + write) for studio-graph. */
  studioBuilderUrl?: string;
  studioTokenFile?: string;
  /** OMA Builder MCP and its key for oma-agent; OMA's API and key to archive older agents (optional). */
  omaBuilderUrl?: string;
  omaBuilderKeyFile?: string;
  omaUrl?: string;
  omaApiKeyFile?: string;
  /** Interface B (phase 6): the Deployer's own OMA Application, and the Agent, Environment and Vaults its sessions use. */
  omaApplicationId?: string;
  omaAgent?: string;
  omaEnvironment?: string;
  omaVaults: string[];
  /** Phase 7: the Onboarding Assessor and its isolated Environment (§10.5.2), and where issues go (D23). */
  omaAssessorAgent?: string;
  omaAssessorEnvironment?: string;
  omaAssessorVaults: string[];
  issueRepo?: string;
  issueTokenFile?: string;
  /** Phase 8: the daily brief is made after this hour (server time), default 8. */
  briefHour: number;
  /** UAT side (§6.3): SHA-256 of the read-only keys PROD's Deployer may use on /api/peer/*. */
  peerKeySha256: string[];
  /** PROD side: UAT's Deployer as this one reaches it, and the file holding the read-only key. */
  uatUrl?: string;
  uatKeyFile?: string;
  secureCookies: boolean;
  webDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const workbenchUrl = env.DEPLOYER_WORKBENCH_URL;
  if (!workbenchUrl) throw new Error("DEPLOYER_WORKBENCH_URL is required: the Deployer authenticates every request with Workbench (design §9.1)");
  const dataDir = resolve(env.DEPLOYER_DATA ?? "data");
  const basePath = `/${(env.DEPLOYER_BASE_PATH ?? "/deploy").replace(/^\/+|\/+$/g, "")}`.replace(/^\/$/, "");
  return {
    bind: env.DEPLOYER_BIND ?? "0.0.0.0",
    port: Number(env.DEPLOYER_PORT ?? 8095),
    basePath,
    dataDir,
    workbenchUrl,
    workbenchPublicUrl: env.DEPLOYER_WORKBENCH_PUBLIC_URL ?? "/",
    environmentFile: resolve(env.DEPLOYER_ENVIRONMENT_FILE ?? join(dataDir, "environment.json")),
    ...(env.DEPLOYER_GITHUB_TOKEN_FILE ? { githubTokenFile: resolve(env.DEPLOYER_GITHUB_TOKEN_FILE) } : {}),
    observeUrls: env.DEPLOYER_OBSERVE_URLS ? JSON.parse(env.DEPLOYER_OBSERVE_URLS) : {},
    ...(env.DEPLOYER_EMERGENCY_PASSWORD_HASH ? { emergencyPasswordHash: env.DEPLOYER_EMERGENCY_PASSWORD_HASH } : {}),
    ...(env.DEPLOYER_CREDENTIAL_ENCRYPTION_KEY ? { credentialKey: env.DEPLOYER_CREDENTIAL_ENCRYPTION_KEY } : {}),
    ...(env.DEPLOYER_COMPARE_KEY ? { compareKey: env.DEPLOYER_COMPARE_KEY } : {}),
    templatesDir: resolve(env.DEPLOYER_TEMPLATES_DIR ?? "templates"),
    githubApi: env.DEPLOYER_GITHUB_API ?? "https://api.github.com",
    ...(env.DEPLOYER_WORKBENCH_API_KEY_FILE ? { workbenchApiKeyFile: resolve(env.DEPLOYER_WORKBENCH_API_KEY_FILE) } : {}),
    ...(env.DEPLOYER_STUDIO_BUILDER_URL ? { studioBuilderUrl: env.DEPLOYER_STUDIO_BUILDER_URL } : {}),
    ...(env.DEPLOYER_STUDIO_TOKEN_FILE ? { studioTokenFile: resolve(env.DEPLOYER_STUDIO_TOKEN_FILE) } : {}),
    ...(env.DEPLOYER_OMA_BUILDER_URL ? { omaBuilderUrl: env.DEPLOYER_OMA_BUILDER_URL } : {}),
    ...(env.DEPLOYER_OMA_BUILDER_KEY_FILE ? { omaBuilderKeyFile: resolve(env.DEPLOYER_OMA_BUILDER_KEY_FILE) } : {}),
    ...(env.DEPLOYER_OMA_URL ? { omaUrl: env.DEPLOYER_OMA_URL } : {}),
    ...(env.DEPLOYER_OMA_API_KEY_FILE ? { omaApiKeyFile: resolve(env.DEPLOYER_OMA_API_KEY_FILE) } : {}),
    ...(env.DEPLOYER_OMA_APPLICATION_ID ? { omaApplicationId: env.DEPLOYER_OMA_APPLICATION_ID } : {}),
    ...(env.DEPLOYER_OMA_AGENT ? { omaAgent: env.DEPLOYER_OMA_AGENT } : {}),
    ...(env.DEPLOYER_OMA_ENVIRONMENT ? { omaEnvironment: env.DEPLOYER_OMA_ENVIRONMENT } : {}),
    omaVaults: (env.DEPLOYER_OMA_VAULTS ?? "").split(/[\s,]+/).filter(Boolean),
    ...(env.DEPLOYER_OMA_ASSESSOR_AGENT ? { omaAssessorAgent: env.DEPLOYER_OMA_ASSESSOR_AGENT } : {}),
    ...(env.DEPLOYER_OMA_ASSESSOR_ENVIRONMENT ? { omaAssessorEnvironment: env.DEPLOYER_OMA_ASSESSOR_ENVIRONMENT } : {}),
    omaAssessorVaults: (env.DEPLOYER_OMA_ASSESSOR_VAULTS ?? "").split(/[\s,]+/).filter(Boolean),
    ...(env.DEPLOYER_ISSUE_REPO ? { issueRepo: env.DEPLOYER_ISSUE_REPO } : {}),
    briefHour: Number(env.DEPLOYER_BRIEF_HOUR ?? 8),
    ...(env.DEPLOYER_ISSUE_TOKEN_FILE ? { issueTokenFile: resolve(env.DEPLOYER_ISSUE_TOKEN_FILE) } : {}),
    peerKeySha256: (env.DEPLOYER_PEER_KEY_SHA256 ?? "").split(/[\s,]+/).filter(Boolean),
    ...(env.DEPLOYER_UAT_URL ? { uatUrl: env.DEPLOYER_UAT_URL } : {}),
    ...(env.DEPLOYER_UAT_KEY_FILE ? { uatKeyFile: resolve(env.DEPLOYER_UAT_KEY_FILE) } : {}),
    secureCookies: (env.DEPLOYER_SECURE_COOKIES ?? "true") !== "false",
    webDir: resolve(env.DEPLOYER_WEB_DIR ?? "dist/web"),
  };
}
