import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { WorkbenchSessions } from "./auth.ts";
import { loadConfig } from "./config.ts";
import { Bundles } from "./bundle.ts";
import { ContractDocs } from "./contracts.ts";
import { Deployments } from "./deploy.ts";
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
const env = new EnvManager(store, deployments, new Schemas(config.githubTokenFile, config.templatesDir), config.credentialKey ? new SecretBox(config.credentialKey) : undefined, config.compareKey);
const app = createApp({ config, store, sessions: new WorkbenchSessions(config.workbenchUrl), observer, deployments, versions, env, peer });
// Job records follow the executor's status files even while nobody has the page open.
setInterval(() => { deployments.sync().catch((error) => console.error("sync:", error)); }, 2_000).unref();

serve({ fetch: app.fetch, hostname: config.bind, port: config.port }, (info) => {
  console.log(`Open Atlas Deployer on http://${info.address}:${info.port}${config.basePath}/ (Workbench ${config.workbenchUrl})`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { store.close(); process.exit(0); });
