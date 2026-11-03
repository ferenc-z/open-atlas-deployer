// §15.4 step 6 (L3): what the AI features need, checked against OMA and Workbench on every call like the other setup
// steps. Nothing here blocks deploys; the assistant and onboarding entry points use it to say what is still missing.

import type { WorkbenchAdmin, WorkbenchPlugin } from "./drivers/workbench.ts";
import type { StepState } from "./setup.ts";
import type { Store } from "./store.ts";
import { readToken, type TokenSource } from "./versions.ts";

export const OMA = "oma";
/** The Deploy Assistant's name in Workbench: the Business Agent and the Deployer's entry's chat.agent. */
export const ASSISTANT_NAME = "Deploy Assistant";

export type AiUse = "assistant" | "assessments" | "diagnosis" | "briefs";
export interface AiItem { id: string; state: StepState; title: string; detail: string; uses: AiUse[] }
export interface AiStatus {
  items: AiItem[];
  left: number;
  /** For each AI feature, the titles of the items it still waits for. */
  missing: Record<AiUse, string[]>;
}

export interface AiContext {
  store: Store;
  workbench: WorkbenchAdmin;
  basePath: string;
  /** Where people open Workbench (DEPLOYER_WORKBENCH_PUBLIC_URL): the Deployer's entry has to be embeddable there. */
  workbenchPublicUrl?: string;
  oma: {
    url?: string; keyFile?: TokenSource; applicationId?: string;
    agent?: string; environment?: string; vaults: string[];
    assessorAgent?: string; assessorEnvironment?: string; assessorVaults: string[];
  };
  fetcher?: typeof fetch;
}

const ALL: AiUse[] = ["assistant", "assessments", "diagnosis", "briefs"];

/** The Deployer's entry in Workbench's plug-in manifest: an application whose chat embeds the Deploy Assistant (§10.2 A). */
export function deployerEntry(url: string, existing?: Record<string, unknown>): Record<string, unknown> {
  const chat = (existing?.chat ?? {}) as Record<string, unknown>;
  return {
    name: "Deployer",
    ...existing,
    id: "deployer", kind: "application", url,
    chat: {
      agent: { name: ASSISTANT_NAME },
      hostOperations: ["plan_deploy", "plan_rollback", "build_artifact", "set_env_value"],
      starters: [
        { title: "What to upgrade", q: "Which apps in this environment have new versions? Which have already run in UAT?" },
        { title: "Why it failed", q: "Why did the latest failed deploy fail?" },
        { title: "Env differences", q: "How do this app's environment variables differ from UAT?" },
      ],
      ...chat,
      embed: true,
    },
  };
}

/** Whether a URL is this Deployer's page (its path is the base path). */
export function isDeployerUrl(url: unknown, basePath: string): boolean {
  if (typeof url !== "string") return false;
  try { return new URL(url, "https://x").pathname.replace(/\/+$/, "") === basePath.replace(/\/+$/, ""); } catch { return false; }
}

/** Why a browser on Workbench's page would not embed the Deployer at `url`: an http page inside https, or another site
 * (the Workbench session cookie does not reach it). Sites are compared by their last two host labels. */
export function embedProblem(url: string, workbenchPublicUrl?: string): string {
  let page: URL, workbench: URL;
  try { workbench = new URL(workbenchPublicUrl ?? ""); page = new URL(url, workbench); } catch { return ""; }
  if (workbench.protocol === "https:" && page.protocol !== "https:") return `Workbench is served over https (${workbench.origin}) and the browser does not embed an http page there`;
  const site = (host: string) => host.split(".").slice(-2).join(".");
  if (site(page.hostname) !== site(workbench.hostname)) return `it is not on the same site as Workbench (${workbench.origin}), so the chat cannot be embedded`;
  return "";
}

export async function aiStatus(ctx: AiContext): Promise<AiStatus> {
  const { oma, store } = ctx;
  const fetcher = ctx.fetcher ?? fetch;
  const base = oma.url?.replace(/\/+$/, "");
  const key = readToken(oma.keyFile);
  const get = async (path: string): Promise<any> => {
    const response = await fetcher(`${base}${path}`, {
      headers: { "x-api-key": key ?? "", accept: "application/json", "anthropic-version": "2023-06-01", "anthropic-beta": "managed-agents-2026-04-01" },
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };
  const exists = async (path: string): Promise<string | null> => {
    try { const r = await get(path); return r?.archived_at ? "is archived" : null; } catch (error) { return `cannot be read (${(error as Error).message})`; }
  };

  // OMA itself: registered and deployed by this Deployer (§15.6 ④), answering at DEPLOYER_OMA_URL.
  let healthy = false;
  if (base) { try { healthy = (await fetcher(`${base}/health`, { signal: AbortSignal.timeout(4_000) })).ok; } catch { healthy = false; } }
  const registered = Boolean(store.app(OMA));
  const deployed = store.deployedVersion(OMA)?.version;
  const register = "Register it under Apps & manifests → Register an app with OMA's manifest (start from examples/oma.manifest.json and try it on UAT first), then deploy it";
  const items: AiItem[] = [];
  items.push(healthy && deployed
    ? { id: "oma", state: "done", title: "OMA", detail: `OMA ${deployed} runs, deployed by this Deployer, and answers at ${base}.`, uses: ALL }
    : healthy
      ? { id: "oma", state: "next", title: "OMA", detail: `OMA answers at ${base} but was not deployed by this Deployer. ${registered ? "Deploy it once from its page to take it over" : register}.`, uses: ALL }
      : !base
        ? { id: "oma", state: "next", title: "OMA", detail: `${registered ? (deployed ? `OMA ${deployed} is deployed` : "Deploy OMA from its page") : register}; then set DEPLOYER_OMA_URL (e.g. http://oma-server:8787) in deployer.env and restart the Deployer.`, uses: ALL }
        : { id: "oma", state: deployed ? "blocked" : "next", title: "OMA", detail: deployed ? `OMA ${deployed} was deployed but ${base}/health does not answer: check the container and DEPLOYER_OMA_URL.` : `${base}/health does not answer. ${registered ? "Deploy OMA from its page" : register}.`, uses: ALL });

  // O1: the Deployer's own Application and API key in OMA.
  let keyWorks = false;
  let keyError = "";
  if (healthy && key) { try { await get("/v1/agents?limit=1"); keyWorks = true; } catch (error) { keyError = (error as Error).message; } }
  items.push(!healthy
    ? { id: "oma-key", state: "waiting", title: "The Deployer's OMA application and key (O1)", detail: "Waits for OMA.", uses: ALL }
    : !key
      ? { id: "oma-key", state: "next", title: "The Deployer's OMA application and key (O1)", detail: "Create an Application for the Deployer in OMA with an API key; put the key in the file DEPLOYER_OMA_API_KEY_FILE names, set DEPLOYER_OMA_APPLICATION_ID and restart the Deployer.", uses: ALL }
      : !keyWorks
        ? { id: "oma-key", state: "blocked", title: "The Deployer's OMA application and key (O1)", detail: `OMA does not accept the key in DEPLOYER_OMA_API_KEY_FILE: ${keyError}.`, uses: ALL }
        : { id: "oma-key", state: "done", title: "The Deployer's OMA application and key (O1)", detail: oma.applicationId ? `The key works; sessions are filed under Application ${oma.applicationId}.` : "The key works. Sessions are not filed under an Application: set DEPLOYER_OMA_APPLICATION_ID and restart the Deployer to file them under the Deployer's.", uses: ALL });

  // O4: the two agents, published with bin/publish-assistant.ts; O2: the Assessor's isolated Environment.
  const assistantUses: AiUse[] = ["assistant", "diagnosis", "briefs"];
  if (!keyWorks) {
    items.push({ id: "oma-assistant", state: "waiting", title: "Deploy Assistant published (O4)", detail: "Waits for the Deployer's OMA key.", uses: assistantUses });
  } else if (!oma.agent) {
    items.push({ id: "oma-assistant", state: "next", title: "Deploy Assistant published (O4)", detail: "Publish the Deploy Assistant with bin/publish-assistant.ts, then set DEPLOYER_OMA_AGENT (and DEPLOYER_OMA_ENVIRONMENT) to the agent and Environment it uses and restart the Deployer.", uses: assistantUses });
  } else {
    const wrong = await exists(`/v1/agents/${encodeURIComponent(oma.agent)}`);
    items.push(wrong
      ? { id: "oma-assistant", state: "blocked", title: "Deploy Assistant published (O4)", detail: `Agent ${oma.agent} (DEPLOYER_OMA_AGENT) ${wrong}: publish it again with bin/publish-assistant.ts and set the new id.`, uses: assistantUses }
      : { id: "oma-assistant", state: "done", title: "Deploy Assistant published (O4)", detail: `Agent ${oma.agent} is published.`, uses: assistantUses });
  }
  if (!keyWorks) {
    items.push({ id: "oma-assessor", state: "waiting", title: "Onboarding Assessor and its isolated Environment (O2, O4)", detail: "Waits for the Deployer's OMA key.", uses: ["assessments"] });
  } else if (!oma.assessorAgent || !oma.assessorEnvironment) {
    items.push({ id: "oma-assessor", state: "next", title: "Onboarding Assessor and its isolated Environment (O2, O4)", detail: "Create an Environment whose network allows only the git hosts and the Deployer's /mcp, publish the Onboarding Assessor with bin/publish-assistant.ts, then set DEPLOYER_OMA_ASSESSOR_AGENT and DEPLOYER_OMA_ASSESSOR_ENVIRONMENT and restart the Deployer.", uses: ["assessments"] });
  } else {
    const agent = await exists(`/v1/agents/${encodeURIComponent(oma.assessorAgent)}`);
    const environment = await exists(`/v1/environments/${encodeURIComponent(oma.assessorEnvironment)}`);
    items.push(agent || environment
      ? { id: "oma-assessor", state: "blocked", title: "Onboarding Assessor and its isolated Environment (O2, O4)", detail: [agent && `Agent ${oma.assessorAgent} ${agent}`, environment && `Environment ${oma.assessorEnvironment} ${environment}`].filter(Boolean).join("; ") + ".", uses: ["assessments"] }
      : { id: "oma-assessor", state: "done", title: "Onboarding Assessor and its isolated Environment (O2, O4)", detail: `Agent ${oma.assessorAgent} in Environment ${oma.assessorEnvironment}.`, uses: ["assessments"] });
  }

  // O3: a read-only service key of this Deployer, kept in an OMA Vault under the Deployer's /mcp address. OMA shows a
  // Vault's credentials only to its owner and workspace admins, so the Deployer's key usually cannot list them; then
  // a live service key that has been used is the evidence that a Vault holds it.
  const service = store.listKeys().filter((k) => k.kind === "service" && !k.revokedAt && (!k.expiresAt || Date.parse(k.expiresAt) > Date.now()));
  const used = service.map((k) => k.lastUsedAt).filter((t): t is string => Boolean(t)).sort().at(-1);
  const vaults = [...new Set([...oma.vaults, ...oma.assessorVaults])];
  const mcpPath = `${ctx.basePath.replace(/\/+$/, "")}/mcp`;
  let stored: string | undefined;
  const missingVaults: string[] = [];
  const hidden: string[] = [];
  if (keyWorks && vaults.length) {
    for (const vault of vaults) {
      const wrong = await exists(`/v1/vaults/${encodeURIComponent(vault)}`);
      if (wrong) { missingVaults.push(`Vault ${vault} ${wrong}`); continue; }
      try {
        const credentials = ((await get(`/v1/vaults/${encodeURIComponent(vault)}/credentials`)).data ?? []) as { archived_at?: string | null; auth?: { mcp_server_url?: string } }[];
        if (credentials.some((c) => !c.archived_at && typeof c.auth?.mcp_server_url === "string" && new URL(c.auth.mcp_server_url).pathname.replace(/\/+$/, "") === mcpPath)) { stored = vault; break; }
      } catch { hidden.push(vault); }
    }
  }
  const serviceNote = service.length ? "" : " First create a service key under API keys (Service key, read-only).";
  const usedNote = used ? `last used ${used}` : "not used yet";
  const title = "Read-only service key in an OMA Vault (O3)";
  items.push(!keyWorks
    ? { id: "oma-vault", state: "waiting", title, detail: "Waits for the Deployer's OMA key.", uses: ALL }
    : !vaults.length
      ? { id: "oma-vault", state: "next", title, detail: `Create a Vault in OMA, store a service key of this Deployer in it for the address ending in ${mcpPath}, then set DEPLOYER_OMA_VAULTS (and DEPLOYER_OMA_ASSESSOR_VAULTS) and restart the Deployer.${serviceNote}`, uses: ALL }
      : missingVaults.length
        ? { id: "oma-vault", state: "blocked", title, detail: `${missingVaults.join("; ")}: create the Vault again and set its id in DEPLOYER_OMA_VAULTS (and DEPLOYER_OMA_ASSESSOR_VAULTS).`, uses: ALL }
        : stored
          ? (!service.length
            ? { id: "oma-vault", state: "blocked", title, detail: `Vault ${stored} has a credential for ${mcpPath}, but this Deployer has no live service key: create one under API keys and store it in place of the old one.`, uses: ALL }
            : { id: "oma-vault", state: "done", title, detail: `Vault ${stored} holds a credential for ${mcpPath}; ${service.length} live service key${service.length > 1 ? "s" : ""}, ${usedNote}.`, uses: ALL })
          : hidden.length
            ? (!service.length
              ? { id: "oma-vault", state: "next", title, detail: `Create a service key under API keys (Service key, read-only) and store it in ${hidden.join(", ")} for the address ending in ${mcpPath}.`, uses: ALL }
              : used
                ? { id: "oma-vault", state: "done", title, detail: `OMA does not show this Deployer's key the credentials in ${hidden.join(", ")}; a live service key was ${usedNote}, so OMA reaches ${mcpPath} with it.`, uses: ALL }
                : { id: "oma-vault", state: "next", title, detail: `OMA does not show this Deployer's key the credentials in ${hidden.join(", ")}, and no service key has been used yet. Store a live service key there for the address ending in ${mcpPath}; this item is done once OMA calls ${mcpPath} with it.`, uses: ALL })
            : { id: "oma-vault", state: "next", title, detail: `No credential in ${vaults.join(", ")} is for the Deployer's MCP address (ending in ${mcpPath}): store a service key there.${serviceNote}`, uses: ALL });

  // Workbench: the Business Agent people talk to, and the Deployer's entry that embeds it (chat.embed).
  let agents: { id: string; name: string; agentId: string; enabled: boolean }[] | undefined;
  let plugins: WorkbenchPlugin[] | undefined;
  let wbError = "";
  if (ctx.workbench.configured) {
    try {
      [agents, plugins] = await Promise.all([ctx.workbench.businessAgents(), ctx.workbench.plugins()]);
    } catch (error) { wbError = (error as Error).message; }
  }
  const named = agents?.filter((a) => a.enabled && a.name === ASSISTANT_NAME) ?? [];
  items.push(!agents
    ? { id: "workbench-agent", state: wbError ? "blocked" : "waiting", title: `Business Agent "${ASSISTANT_NAME}" in Workbench`, detail: wbError ? `Workbench does not answer: ${wbError}` : "Waits for a working Workbench API key.", uses: ["assistant"] }
    : named.length === 0
      ? { id: "workbench-agent", state: "next", title: `Business Agent "${ASSISTANT_NAME}" in Workbench`, detail: `In Workbench Administration → Business Agents, create "${ASSISTANT_NAME}" with OMA agent ${oma.agent ?? "(the published Deploy Assistant)"}${oma.environment ? `, Environment ${oma.environment}` : ""}${oma.vaults.length ? ` and Vault ${oma.vaults.join(", ")}` : ""}.`, uses: ["assistant"] }
      : named.length > 1
        ? { id: "workbench-agent", state: "blocked", title: `Business Agent "${ASSISTANT_NAME}" in Workbench`, detail: `Workbench has ${named.length} enabled Business Agents named "${ASSISTANT_NAME}": keep one, so the Deployer's chat knows which to use.`, uses: ["assistant"] }
        : oma.agent && named[0]!.agentId !== oma.agent
          ? { id: "workbench-agent", state: "next", title: `Business Agent "${ASSISTANT_NAME}" in Workbench`, detail: `It points at OMA agent ${named[0]!.agentId}, not at ${oma.agent} (DEPLOYER_OMA_AGENT): point it at the agent published last.`, uses: ["assistant"] }
          : { id: "workbench-agent", state: "done", title: `Business Agent "${ASSISTANT_NAME}" in Workbench`, detail: `It points at OMA agent ${named[0]!.agentId}.`, uses: ["assistant"] });

  const entry = plugins?.find((p) => p.id === "deployer");
  const embed = entry?.url ? embedProblem(entry.url, ctx.workbenchPublicUrl) : "";
  const entryProblem = !entry ? "" : entry.kind !== "application" ? "is not an application"
    : entry.enabled === false ? "is switched off"
    : !entry.chat?.embed ? "does not embed the chat (chat.embed)"
    : !isDeployerUrl(entry.url, ctx.basePath) ? `links ${entry.url ?? "nothing"}, not this Deployer's page`
    : embed && `links ${entry.url}, but ${embed}`;
  const visibility = entry?.visibility;
  const visibleNote = !visibility || visibility.mode === "all" ? " Everyone in Workbench sees it: limit it to the deploy groups under Administration → Applications if you like." : "";
  items.push(!plugins
    ? { id: "workbench-entry", state: wbError ? "blocked" : "waiting", title: "Deployer registered in Workbench (chat.embed)", detail: wbError ? `Workbench does not answer: ${wbError}` : "Waits for a working Workbench API key.", uses: ["assistant"] }
    : !entry
      ? { id: "workbench-entry", state: "next", title: "Deployer registered in Workbench (chat.embed)", detail: `Workbench's application list has no Deployer, so the assistant cannot be embedded on this page. Register it here: an application entry with this page's address, chat.embed and "${ASSISTANT_NAME}", visible to the deploy groups.`, uses: ["assistant"] }
      : entryProblem
        ? { id: "workbench-entry", state: "next", title: "Deployer registered in Workbench (chat.embed)", detail: `The Deployer's entry ${entryProblem}. Register it again here to fix it (other fields are kept).`, uses: ["assistant"] }
        : { id: "workbench-entry", state: "done", title: "Deployer registered in Workbench (chat.embed)", detail: `The entry links ${entry.url} and embeds the chat.${visibleNote}`, uses: ["assistant"] });

  const open = items.filter((i) => i.state !== "done");
  const missing = Object.fromEntries(ALL.map((u) => [u, open.filter((i) => i.uses.includes(u)).map((i) => i.title)])) as Record<AiUse, string[]>;
  return { items, left: open.length, missing };
}
