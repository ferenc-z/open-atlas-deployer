import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { WorkbenchSessions } from "./auth.ts";
import { loadConfig } from "./config.ts";
import { DeployerSettings } from "./deployer-settings.ts";
import { Bundles } from "./bundle.ts";
import { ContractDocs } from "./contracts.ts";
import { Deployments } from "./deploy.ts";
import { Diagnoser } from "./diagnose.ts";
import { Keys } from "./keys.ts";
import { OmaSessions } from "./oma.ts";
import { Briefs, collectFacts } from "./brief.ts";
import { Drift } from "./drift.ts";
import { environmentStatus, hostStateOf } from "./observe.ts";
import { Onboarding } from "./onboarding.ts";
import { OmaAgentDriver } from "./drivers/oma-agent.ts";
import { StudioGraphDriver } from "./drivers/studio-graph.ts";
import { NifiOpsGraph } from "./services/graph-publish.ts";
import { WorkbenchAdmin } from "./drivers/workbench.ts";
import { WorkbenchAppDriver } from "./drivers/workbench-app.ts";
import { McpClient } from "./mcp-client.ts";
import { EnvManager, Schemas } from "./env.ts";
import { Handoff, hostIds } from "./handoff.ts";
import { Observer } from "./observe.ts";
import { Peer } from "./peer.ts";
import { SecretBox } from "./secretbox.ts";
import { ConfigReviewer } from "./services/configreview.ts";
import { Takeover } from "./services/takeover.ts";
import { Store } from "./store.ts";
import { WorkbenchKey } from "./workbench-key.ts";
import { readToken, Versions, type TokenSource } from "./versions.ts";
import { prune, rollUp } from "./services/metrics.ts";
import { checkAll } from "./services/rules.ts";

// D45: deployer.env first (the state directory and the credential key come only from there), then what an
// administrator set on the page for the settings the file leaves unset.
const dataDir = resolve(process.env.DEPLOYER_DATA ?? "data");
mkdirSync(dataDir, { recursive: true });
const store = new Store(join(dataDir, "deployer.db"));
const box = process.env.DEPLOYER_CREDENTIAL_ENCRYPTION_KEY ? new SecretBox(process.env.DEPLOYER_CREDENTIAL_ENCRYPTION_KEY) : undefined;
const deployerSettings = new DeployerSettings(store, box, process.env);
const config = loadConfig(deployerSettings.env(), deployerSettings.tokens());
const observer = new Observer(config.observeUrls);
const versions = new Versions(config.githubTokenFile, fetch, Date.now, config.githubApi);
const peer = new Peer(config.uatUrl, config.uatKeyFile);
// Phase 5 drivers: Workbench through an Administration API key, Studio and OMA through their Builder MCPs.
// §15.6 ③: the key from DEPLOYER_WORKBENCH_API_KEY_FILE, or the one an administrator pasted on the Setup page.
const workbenchKey = new WorkbenchKey(store, config.workbenchApiKeyFile, box);
const workbench = new WorkbenchAdmin(config.workbenchUrl, () => workbenchKey.value());
const bearer = (file: TokenSource) => () => ({ authorization: `Bearer ${readToken(file)}` });
const studio = config.studioBuilderUrl && config.studioTokenFile ? new McpClient(config.studioBuilderUrl, bearer(config.studioTokenFile)) : undefined;
const omaBuilder = config.omaBuilderUrl && config.omaBuilderKeyFile ? new McpClient(config.omaBuilderUrl, bearer(config.omaBuilderKeyFile)) : undefined;
const drivers = [
  new WorkbenchAppDriver(workbench),
  new StudioGraphDriver(studio, config.templatesDir),
  new OmaAgentDriver(omaBuilder, workbench, config.templatesDir, config.omaUrl ? { url: config.omaUrl, keyFile: config.omaApiKeyFile } : undefined),
];
const deployments = new Deployments(store, new Handoff(store), observer, config.environmentFile, {
  peer, releases: versions, drivers,
  bundles: new Bundles(join(config.dataDir, "bundles"), config.githubTokenFile, fetch, config.githubApi),
  contracts: new ContractDocs(config.githubTokenFile, fetch, config.githubApi),
});
// D38: the environment settings live in the state database; on the first start environment.json becomes revision 1.
try {
  const s = deployments.settings();
  console.log(`Environment settings: revision ${s.revision}${s.source === "import" && s.revision === 1 ? ` (imported from ${config.environmentFile})` : ""}`);
} catch (error) {
  console.error(`Cannot read the environment settings (${config.environmentFile}): ${(error as Error).message}`);
}
const keptTemplates = join(config.dataDir, "templates");
const env = new EnvManager(store, deployments, new Schemas(config.githubTokenFile, config.templatesDir, fetch, keptTemplates, config.githubApi), box, config.compareKey);
// Phase 6: personal and service API keys (need Workbench's API key to re-confirm owners), failure diagnosis through OMA.
const keys = new Keys(store, workbench);
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
// Phase 8: the maintenance notice before a deploy (W3), drift, the daily brief.
deployments.maintenance = workbench;
const statusOf = () => {
  const { env } = deployments.environment();
  return environmentStatus(env, store.listApps().map((a) => ({ id: a.id, name: a.name, manifests: store.manifests(a.id) })), hostStateOf(deployments.handoff.reports(hostIds(env))), observer);
};
const drift = new Drift(store, deployments, (host) => deployments.handoff.reports().find((r) => r.host === host)?.files, statusOf);
const briefWriter = config.omaUrl && config.omaApiKeyFile && config.omaAgent
  ? new OmaSessions({ url: config.omaUrl, keyFile: config.omaApiKeyFile, agent: config.omaAgent, ...(config.omaEnvironment ? { environment: config.omaEnvironment } : {}), vaults: config.omaVaults, ...(config.omaApplicationId ? { application: config.omaApplicationId } : {}) })
  : undefined;
const briefs = new Briefs(store, () => collectFacts({ store, deployments, status: statusOf, versions, ...(peer.configured ? { peer: () => peer.status() } : {}), drift: () => drift.check() }), briefWriter, { hour: config.briefHour });
// Service ops §6: taking over discovered NiFi (drafts, confirmation); the AI review uses the Onboarding Assessor.
const takeover = new Takeover({ store, handoff: deployments.handoff, box, oma: assessor, environment: () => deployments.environment().env.name, hosts: () => hostIds(deployments.environment().env) });
// Phase 2 step 6: the nifi-ops Studio graph, published through the same Builder MCP as studio-graph.
const nifiOpsGraph = new NifiOpsGraph(store, { studio, graph: config.nifiOpsGraph });
// §16.3: the AI review of a saved configuration revision, through the Deploy Assistant. No Vault: no tools (configreview.ts).
const configReview = box && config.omaUrl && config.omaApiKeyFile && config.omaAgent
  ? new ConfigReviewer(store, new OmaSessions({ url: config.omaUrl, keyFile: config.omaApiKeyFile, agent: config.omaAgent, ...(config.omaEnvironment ? { environment: config.omaEnvironment } : {}), vaults: [], ...(config.omaApplicationId ? { application: config.omaApplicationId } : {}) }), box, () => deployments.environment().env.name)
  : undefined;
const app = createApp({ config, store, takeover, ...(configReview ? { configReview } : {}), graph: nifiOpsGraph, sessions: new WorkbenchSessions(config.workbenchUrl), observer, deployments, versions, env, peer, onboarding, drift, briefs, keys, workbench, workbenchKey, deployerSettings,
  // D45: the image sets DEPLOYER_RESTART_BY_EXIT; the container's restart policy starts it again with the new settings.
  ...(process.env.DEPLOYER_RESTART_BY_EXIT === "true" ? { restart: () => setTimeout(() => { store.close(); process.exit(75); }, 300) } : {}) });
// Job records follow the executor's status files even while nobody has the page open.
setInterval(() => {
  deployments.sync().catch((error) => console.error("sync:", error));
  diagnoser?.poll().catch((error) => console.error("diagnose:", error));
  onboarding.poll().catch((error) => console.error("assessments:", error));
  configReview?.poll().catch((error) => console.error("config review:", error));
}, 2_000).unref();
setInterval(() => { briefs.tick().catch((error) => console.error("brief:", error)); }, 60_000).unref();
setInterval(() => { drift.check().catch((error) => console.error("drift:", error)); }, 10 * 60_000).unref();
// §15.3: the services' 5-minute rollups as each bucket ends, and the hourly cleanup (raw 2 days, rollups 30 days).
const serviceUpkeep = (cleanup: boolean) => {
  try {
    rollUp(store, new Date());
    // §15.3: the rules once a minute too, for what sends nothing (an executor gone, samples overdue).
    checkAll(store, (h) => deployments.handoff.executor(h, "service"));
    store.dropOldExecutorContent();
    if (cleanup) prune(store, new Date());
  } catch (error) { console.error("service metrics:", error); }
};
setInterval(() => serviceUpkeep(false), 60_000).unref();
setInterval(() => serviceUpkeep(true), 60 * 60_000).unref();
setTimeout(() => serviceUpkeep(true), 30_000).unref();

serve({ fetch: app.fetch, hostname: config.bind, port: config.port }, (info) => {
  console.log(`Open Atlas Deployer on http://${info.address}:${info.port}${config.basePath}/ (Workbench ${config.workbenchUrl})`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { store.close(); process.exit(0); });
