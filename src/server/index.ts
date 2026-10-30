import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { WorkbenchSessions } from "./auth.ts";
import { loadConfig } from "./config.ts";
import { Bundles } from "./bundle.ts";
import { ContractDocs } from "./contracts.ts";
import { Deployments } from "./deploy.ts";
import { Diagnoser } from "./diagnose.ts";
import { Keys } from "./keys.ts";
import { OmaSessions } from "./oma.ts";
import { Onboarding } from "./onboarding.ts";
import { OmaAgentDriver } from "./drivers/oma-agent.ts";
import { StudioGraphDriver } from "./drivers/studio-graph.ts";
import { WorkbenchAdmin } from "./drivers/workbench.ts";
import { WorkbenchAppDriver } from "./drivers/workbench-app.ts";
import { McpClient } from "./mcp-client.ts";
import { EnvManager, Schemas } from "./env.ts";
import { Handoff } from "./handoff.ts";
import { Observer } from "./observe.ts";
import { Peer } from "./peer.ts";
import { SecretBox } from "./secretbox.ts";
import { Store } from "./store.ts";
import { readToken, Versions } from "./versions.ts";

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });
const store = new Store(join(config.dataDir, "deployer.db"));
const observer = new Observer(config.observeUrls);
const versions = new Versions(config.githubTokenFile);
const peer = new Peer(config.uatUrl, config.uatKeyFile);
// Phase 5 drivers: Workbench through an Administration API key, Studio and OMA through their Builder MCPs.
const workbench = new WorkbenchAdmin(config.workbenchUrl, config.workbenchApiKeyFile);
const bearer = (file: string | undefined) => () => ({ authorization: `Bearer ${readToken(file)}` });
const studio = config.studioBuilderUrl && config.studioTokenFile ? new McpClient(config.studioBuilderUrl, bearer(config.studioTokenFile)) : undefined;
const omaBuilder = config.omaBuilderUrl && config.omaBuilderKeyFile ? new McpClient(config.omaBuilderUrl, bearer(config.omaBuilderKeyFile)) : undefined;
const drivers = [
  new WorkbenchAppDriver(workbench),
  new StudioGraphDriver(studio, config.templatesDir),
  new OmaAgentDriver(omaBuilder, workbench, config.templatesDir, config.omaUrl ? { url: config.omaUrl, keyFile: config.omaApiKeyFile } : undefined),
];
const deployments = new Deployments(store, new Handoff(config.handoffDir), observer, config.environmentFile, {
  peer, releases: versions, drivers,
  bundles: new Bundles(join(config.dataDir, "bundles"), config.githubTokenFile, fetch, config.githubApi),
  contracts: new ContractDocs(config.githubTokenFile, fetch, config.githubApi),
});
const keptTemplates = join(config.dataDir, "templates");
const env = new EnvManager(store, deployments, new Schemas(config.githubTokenFile, config.templatesDir, fetch, keptTemplates), config.credentialKey ? new SecretBox(config.credentialKey) : undefined, config.compareKey);
// Phase 6: personal and service API keys (need Workbench's API key to re-confirm owners), failure diagnosis through OMA.
const keys = config.workbenchApiKeyFile ? new Keys(store, workbench) : undefined;
const diagnoser = config.omaUrl && config.omaApiKeyFile && config.omaAgent
  ? new Diagnoser(store, { url: config.omaUrl, keyFile: config.omaApiKeyFile, agent: config.omaAgent, ...(config.omaEnvironment ? { environment: config.omaEnvironment } : {}), vaults: config.omaVaults, ...(config.omaApplicationId ? { application: config.omaApplicationId } : {}) }, (id) => deployments.handoff.log(id))
  : undefined;
if (diagnoser) deployments.onFailure = (job) => diagnoser.start(job);
// Phase 7: assessments with the Onboarding Assessor in an isolated Environment (§10.5).
const assessor = config.omaUrl && config.omaApiKeyFile && config.omaAssessorAgent
  ? new OmaSessions({ url: config.omaUrl, keyFile: config.omaApiKeyFile, agent: config.omaAssessorAgent, ...(config.omaAssessorEnvironment ? { environment: config.omaAssessorEnvironment } : {}), vaults: config.omaAssessorVaults, ...(config.omaApplicationId ? { application: config.omaApplicationId } : {}) })
  : undefined;
const onboarding = new Onboarding({ store, deployments, oma: assessor, githubApi: config.githubApi, githubTokenFile: config.githubTokenFile, issueRepo: config.issueRepo, issueTokenFile: config.issueTokenFile, templatesDir: keptTemplates, pageUrl: config.workbenchPublicUrl });
deployments.evaluated = (app, version) => onboarding.evaluated(app, version);
const app = createApp({ config, store, sessions: new WorkbenchSessions(config.workbenchUrl), observer, deployments, versions, env, peer, onboarding, ...(keys ? { keys } : {}) });
// Job records follow the executor's status files even while nobody has the page open.
setInterval(() => {
  deployments.sync().catch((error) => console.error("sync:", error));
  diagnoser?.poll().catch((error) => console.error("diagnose:", error));
  onboarding.poll().catch((error) => console.error("assessments:", error));
}, 2_000).unref();

serve({ fetch: app.fetch, hostname: config.bind, port: config.port }, (info) => {
  console.log(`Open Atlas Deployer on http://${info.address}:${info.port}${config.basePath}/ (Workbench ${config.workbenchUrl})`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { store.close(); process.exit(0); });
