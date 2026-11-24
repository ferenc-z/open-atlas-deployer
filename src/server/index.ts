import { mkdirSync } from "node:fs";
import { Git } from "./git.ts";
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
import { opsBusinessHooks, opsPageSources, servicesOverview } from "./services/page-views.ts";
import { BusinessScanner, businessCheckAll, SCAN_MINUTES } from "./services/business.ts";
import { ServiceLogs } from "./services/logs.ts";
import { HandoffGroupReader } from "./services/group-reader.ts";
import { ServiceProvenance } from "./services/provenance.ts";
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
import { ServiceChanges } from "./services/changes.ts";
import { ConfigReviewer } from "./services/configreview.ts";
import { Takeover } from "./services/takeover.ts";
import { Store } from "./store.ts";
import { WorkbenchKey } from "./workbench-key.ts";
import { readToken, Versions, type TokenSource } from "./versions.ts";
import { prune, rollUp } from "./services/metrics.ts";
import { pruneFlow } from "./services/flowcounts.ts";
import { checkAll, machineLight } from "./services/rules.ts";
import { Analyses, checkupDone } from "./services/analyses.ts";
import { CHECKUP_CRON, CHECKUP_TIMEZONE, CheckupSchedule } from "./services/checkup-schedule.ts";

// D45: deployer.env first (the state directory and the credential key come only from there), then what an
// administrator set on the page for the settings the file leaves unset.
const dataDir = resolve(process.env.DEPLOYER_DATA ?? "data");
mkdirSync(dataDir, { recursive: true });
const store = new Store(join(dataDir, "deployer.db"));
const box = process.env.DEPLOYER_CREDENTIAL_ENCRYPTION_KEY ? new SecretBox(process.env.DEPLOYER_CREDENTIAL_ENCRYPTION_KEY) : undefined;
const deployerSettings = new DeployerSettings(store, box, process.env);
const config = loadConfig(deployerSettings.env(), deployerSettings.tokens());
const observer = new Observer(config.observeUrls);
// D46: repositories are read with git over SSH once a key is set.
const git = new Git({ dir: join(config.dataDir, "git"), keyFile: config.gitKeyFile, ...(config.gitKnownHostsFile ? { knownHostsFile: config.gitKnownHostsFile } : {}) });
const versions = new Versions(config.githubTokenFile, fetch, Date.now, config.githubApi, git);
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
const deployments = new Deployments(store, new Handoff(store, Date.now, box), observer, config.environmentFile, {
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
const onboarding = new Onboarding({ store, deployments, oma: assessor, git, githubApi: config.githubApi, githubTokenFile: config.githubTokenFile, issueRepo: config.issueRepo, issueTokenFile: config.issueTokenFile, templatesDir: keptTemplates, pageUrl: config.workbenchPublicUrl });
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
// Ops step 5 (A1): the AI's analyses through the Service Check-up agent (its Vault holds the dpc_ key), and its OMA schedule.
const serviceExecutor = (host: string) => deployments.handoff.executor(host, "service");
const serviceIds = () => [...store.standalones(), ...store.clusters()].map((s) => s.id).sort();
const businessHooks = opsBusinessHooks(store);
const checkupAgent = config.omaUrl && config.omaApiKeyFile && config.omaCheckupAgent
  ? new OmaSessions({ url: config.omaUrl, keyFile: config.omaApiKeyFile, agent: config.omaCheckupAgent, ...(config.omaCheckupEnvironment ? { environment: config.omaCheckupEnvironment } : {}), vaults: config.omaCheckupVaults ?? [], ...(config.omaApplicationId ? { application: config.omaApplicationId } : {}) })
  : undefined;
const analyses = new Analyses({
  store, ...(checkupAgent ? { oma: checkupAgent } : {}), services: serviceIds, auto: config.checkupAuto !== false,
  lights: (service, at) => ({ machine: machineLight(store, serviceExecutor, service, at)?.light ?? "unknown", business: businessHooks.business!(service, at).light }),
});
const checkupSchedule = config.omaUrl && config.omaApiKeyFile && config.omaCheckupAgent
  ? new CheckupSchedule({ url: config.omaUrl, keyFile: config.omaApiKeyFile, agent: config.omaCheckupAgent, ...(config.omaCheckupEnvironment ? { environment: config.omaCheckupEnvironment } : {}), vaults: config.omaCheckupVaults ?? [], cron: config.checkupCron ?? CHECKUP_CRON, timezone: config.checkupTimezone ?? CHECKUP_TIMEZONE, name: `deployer-checkup-${(() => { try { return deployments.environment().env.name; } catch { return "default"; } })()}`, auto: config.checkupAuto !== false })
  : undefined;
if (config.checkupAuto === false) console.log("Automatic check-ups are off (DEPLOYER_CHECKUP_AUTO); Check now still works.");
const pageSources = opsPageSources(store, checkupSchedule ? () => checkupSchedule.nextRunAt : undefined);
const briefs = new Briefs(store, () => collectFacts({ store, deployments, status: statusOf, versions, ...(peer.configured ? { peer: () => peer.status() } : {}), drift: () => drift.check(), ops: () => servicesOverview(store, serviceExecutor, pageSources) }), briefWriter, {
  hour: config.briefHour,
  // A1: the brief uses the morning check-up; with a schedule it waits (up to an hour) until every service has one since an hour before.
  ...(checkupSchedule ? { ready: () => { const d = new Date(); d.setHours(config.briefHour - 1, 0, 0, 0); return checkupDone(store, serviceIds(), d); } } : {}),
});
// Service ops §6: taking over discovered NiFi (drafts, confirmation); the AI review uses the Onboarding Assessor.
const takeover = new Takeover({ store, handoff: deployments.handoff, box, oma: assessor, environment: () => deployments.environment().env.name, hosts: () => hostIds(deployments.environment().env) });
// Phase 2 step 6: the nifi-ops Studio graph, published through the same Builder MCP as studio-graph.
const nifiOpsGraph = new NifiOpsGraph(store, { studio, graph: config.nifiOpsGraph });
// §16.3: the AI review of a saved configuration revision, through the Deploy Assistant. No Vault: no tools (configreview.ts).
const configReview = box && config.omaUrl && config.omaApiKeyFile && config.omaAgent
  ? new ConfigReviewer(store, new OmaSessions({ url: config.omaUrl, keyFile: config.omaApiKeyFile, agent: config.omaAgent, ...(config.omaEnvironment ? { environment: config.omaEnvironment } : {}), vaults: [], ...(config.omaApplicationId ? { application: config.omaApplicationId } : {}) }), box, () => deployments.environment().env.name)
  : undefined;
// §16.3: the changes of services, driven from the database: what was running when this process started finishes its member and waits for a person.
const serviceChanges = new ServiceChanges({ store, handoff: deployments.handoff, box });
serviceChanges.recover();
// The cases' analysis ("Let the AI analyse", CRIT alerts) went with ops step 4; step 5 starts analyses (oma-turn.ts).
// Ops step 3b: provenance made here so the business scan (data dropped, failure, invalid) shares it with the pages.
const serviceLogs = new ServiceLogs(store, deployments.handoff);
const serviceProvenance = new ServiceProvenance(store, deployments.handoff, serviceLogs);
const businessScanner = new BusinessScanner(store, serviceProvenance);
// Steps 3b + 4: the pages read the to-dos and analyses (opsReads); describe reads the real business light.
const app = createApp({ config, store, takeover, groupReader: new HandoffGroupReader(deployments.handoff, serviceLogs), changes: serviceChanges, ...(configReview ? { configReview } : {}), graph: nifiOpsGraph, logs: serviceLogs, provenance: serviceProvenance, pageSources, businessHooks, businessScanner, analyses, sessions: new WorkbenchSessions(config.workbenchUrl), observer, deployments, versions, env, peer, onboarding, drift, briefs, keys, workbench, workbenchKey, deployerSettings,
  // D45: the image sets DEPLOYER_RESTART_BY_EXIT; the container's restart policy starts it again with the new settings.
  ...(process.env.DEPLOYER_RESTART_BY_EXIT === "true" ? { restart: () => setTimeout(() => { store.close(); process.exit(75); }, 300) } : {}) });
// Job records follow the executor's status files even while nobody has the page open.
setInterval(() => {
  deployments.sync().catch((error) => console.error("sync:", error));
  try { serviceChanges.tick(); } catch (error) { console.error("service changes:", error); }
  diagnoser?.poll().catch((error) => console.error("diagnose:", error));
  onboarding.poll().catch((error) => console.error("assessments:", error));
  configReview?.poll().catch((error) => console.error("config review:", error));
}, 2_000).unref();
setInterval(() => { briefs.tick().catch((error) => console.error("brief:", error)); }, 60_000).unref();
setInterval(() => { drift.check().catch((error) => console.error("drift:", error)); }, 10 * 60_000).unref();
// Ops step 5: follow the analyses' sessions; keep the check-up's OMA schedule as configured (at start, then every 15 minutes).
setInterval(() => { analyses.poll().catch((error) => console.error("analyses:", error)); }, 10_000).unref();
if (checkupSchedule) {
  const ensure = () => checkupSchedule.ensure()
    .then((r) => { if (r.action !== "unchanged") console.log(`Check-up schedule ${r.id} ${r.action} (${checkupSchedule.config.cron}, ${checkupSchedule.config.timezone}); next ${r.nextRunAt ?? "-"}`); })
    .catch((error) => console.error("check-up schedule:", (error as Error).message));
  setTimeout(ensure, 15_000).unref();
  setInterval(ensure, 15 * 60_000).unref();
}
// §15.3: the services' 5-minute rollups as each bucket ends, and the hourly cleanup (raw 2 days, rollups 30 days).
const serviceUpkeep = (cleanup: boolean) => {
  try {
    rollUp(store, new Date());
    // §15.3: the rules once a minute too, for what sends nothing (an executor gone, samples overdue).
    // Ops step 5 (A1): a machine light turning red is analysed at once.
    checkAll(store, serviceExecutor, new Date(), (turn) => { analyses.machineTurn(turn); });
    // Ops step 3b: the business light's bulletins, queues, S2S hand-overs and error groups.
    businessCheckAll(store);
    store.dropOldExecutorContent();
    store.pruneRegistrationDrafts();
    deployments.handoff.expireQueued();
    if (cleanup) { prune(store, new Date()); pruneFlow(store, new Date()); }
  } catch (error) { console.error("service metrics:", error); }
};
setInterval(() => serviceUpkeep(false), 60_000).unref();
setInterval(() => serviceUpkeep(true), 60 * 60_000).unref();
setTimeout(() => serviceUpkeep(true), 30_000).unref();
// Ops step 3b: the provenance scan of every service with businesses (B3 data dropped, processing failed, invalid data).
setInterval(() => { businessScanner.tick().catch((error) => console.error("business scan:", error)); }, SCAN_MINUTES * 60_000).unref();

serve({ fetch: app.fetch, hostname: config.bind, port: config.port }, (info) => {
  console.log(`Open Atlas Deployer on http://${info.address}:${info.port}${config.basePath}/ (Workbench ${config.workbenchUrl})`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { store.close(); process.exit(0); });
