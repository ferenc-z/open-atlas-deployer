// Service ops §15.3: publishing the nifi-ops graph (services/graph.ts). After a takeover, an nginx address change or a
// removal the Deployer generates the graph again and publishes it through the studio-graph driver's path (Builder MCP:
// declare_source for each source, create the graph the first time, upload at the draft's revision, publish). Every
// run is recorded (service_graph_runs) and audited. Runs are serial; requests while one runs make one more run
// afterwards, not one each. The check of an nginx address (GET /flow/about through it) is here too.

import type { McpClient } from "../mcp-client.ts";
import { publishContract } from "../drivers/studio-graph.ts";
import type { Actor, GraphRun, NginxCheck, Store } from "../store.ts";
import { apiRoot, generateGraph, type GraphService } from "./graph.ts";

/** Registered services with an nginx address, as the generator takes them. */
export function graphServices(store: Store): GraphService[] {
  return [
    ...store.standalones().filter((s) => s.nginxUrl).map((s) => ({ id: s.id, kind: "standalone" as const, version: s.version, nginxUrl: s.nginxUrl! })),
    ...store.clusters().filter((s) => s.nginxUrl).map((s) => ({ id: s.id, kind: "cluster" as const, version: s.version, nginxUrl: s.nginxUrl! })),
  ];
}

/** GET <nginxUrl>/nifi-api/flow/about once, 5 s at most: what Studio will find behind that address. */
export async function checkNginx(url: string, fetcher: typeof fetch = fetch, now = () => new Date()): Promise<NginxCheck> {
  const started = Date.now();
  const at = now().toISOString();
  try {
    const r = await fetcher(`${apiRoot(url)}/flow/about`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000), redirect: "manual" });
    const ms = Date.now() - started;
    const text = await r.text();
    if (!r.ok) {
      const hint = r.status === 401 || r.status === 403 ? ": refused (nginx's client certificate, or NiFi's /flow read policy for nginx's identity)" : r.status === 404 ? ": not found (does nginx pass /nifi-api/ to NiFi?)" : "";
      return { url, at, ok: false, status: r.status, version: null, ms, error: `HTTP ${r.status}${hint}` };
    }
    let version: string | null = null;
    try { const v = (JSON.parse(text) as { about?: { version?: unknown } }).about?.version; version = typeof v === "string" ? v : null; } catch { /* below */ }
    if (!version) return { url, at, ok: false, status: r.status, version: null, ms, error: "The answer is not NiFi's /flow/about (is this the nginx in front of NiFi?)" };
    return { url, at, ok: true, status: r.status, version, ms, error: null };
  } catch (error) {
    const e = error as Error & { cause?: { code?: string; message?: string } };
    return { url, at, ok: false, status: null, version: null, ms: Date.now() - started, error: e.name === "TimeoutError" ? "No answer within 5 seconds" : `${e.cause?.code ?? e.name}: ${e.cause?.message ?? e.message}` };
  }
}

export interface GraphOptions {
  /** The Builder MCP with the workspace token (DEPLOYER_STUDIO_BUILDER_URL, DEPLOYER_STUDIO_TOKEN_FILE); none: runs are recorded as skipped. */
  studio: McpClient | undefined;
  /** The graph's name in Studio (DEPLOYER_NIFI_OPS_GRAPH): name, or workspace/name; default nifi-ops. */
  graph?: string | undefined;
}

const failed = (answer: any) => Array.isArray(answer?.findings) && answer.findings.some((f: { severity?: string }) => f?.severity !== "info" && f?.severity !== "warning");

export class NifiOpsGraph {
  private store: Store;
  private studio: McpClient | undefined;
  readonly graph: string;
  private running: Promise<GraphRun> | null = null;
  private again: { reason: string; actor: Actor } | null = null;

  constructor(store: Store, options: GraphOptions) {
    this.store = store;
    this.studio = options.studio;
    this.graph = options.graph?.trim() || "nifi-ops";
  }

  get configured(): boolean { return !!this.studio; }

  /** Generates and publishes in the background (takeover, nginx address, removal); the run is recorded. */
  schedule(reason: string, actor: Actor): void {
    if (this.running) { this.again = { reason, actor }; return; }
    void this.publish(reason, actor).catch((error) => console.error(`nifi-ops graph: ${(error as Error).message}`));
  }

  /** One generation and publication, recorded; waits for a run in progress first. */
  async publish(reason: string, actor: Actor): Promise<GraphRun> {
    while (this.running) await this.running.catch(() => undefined);
    const run = this.run(reason, actor);
    this.running = run;
    try { return await run; } finally {
      this.running = null;
      if (this.again) { const next = this.again; this.again = null; this.schedule(next.reason, next.actor); }
    }
  }

  /** Resolves when no run is in progress or queued (tests). */
  async idle(): Promise<void> {
    while (this.running || this.again) await (this.running ?? new Promise((r) => setTimeout(r, 5))).catch(() => undefined);
  }

  private record(reason: string, actor: Actor, graph: string | null, services: string[], state: GraphRun["state"], message: string, detail: Record<string, unknown>): GraphRun {
    const run = { at: new Date().toISOString(), by: actor.id, reason, graph, services, state, message, detail };
    const id = this.store.addGraphRun(run);
    this.store.audit(actor, "service.graph", graph ?? this.graph, { reason, state, services, message });
    return { id, ...run };
  }

  private async run(reason: string, actor: Actor): Promise<GraphRun> {
    const services = graphServices(this.store);
    const ids = services.map((s) => s.id);
    if (!this.studio) return this.record(reason, actor, null, ids, "skipped", "Studio's Builder MCP is not configured (DEPLOYER_STUDIO_BUILDER_URL, DEPLOYER_STUDIO_TOKEN_FILE).", {});
    if (!services.length) return this.record(reason, actor, null, ids, "skipped", "No standalone instance or cluster has an nginx address; the graph in Studio is left as it is.", {});
    const log: string[] = [];
    const studio = this.studio;
    let graph = this.graph;
    try {
      let generated = generateGraph(services, { workspace: "deployer", graph: "nifi-ops", label: "NiFi operations" });
      // The sources, declared as they should be now. declare_source has no upsert: a new id is declared without a
      // revision; a taken one is refused with its revision, and declared again at that revision (replaced).
      const declare = async (id: string, entry: Record<string, unknown>): Promise<string> => {
        const args = { id, entry, verify: false, apply: true };
        let answer: any, how = "declared";
        try { answer = await studio.call("declare_source", args); } catch (error) {
          const taken = /:pool\.action\/id-taken[\s\S]*?:got \{:revision (\d+)\}/.exec((error as Error).message);
          if (!taken) throw error;
          answer = await studio.call("declare_source", { ...args, expected_revision: Number(taken[1]) });
          how = "replaced";
        }
        if (failed(answer)) throw new Error(`declare_source ${id}: ${JSON.stringify(answer.findings).slice(0, 400)}`);
        return how;
      };
      for (const s of generated.sources.filter((x) => x.entry.type === "api")) log.push(`Studio: source ${s.id} ${await declare(s.id, s.entry)} (${String(s.entry.base_url)})`);
      // Provenance needs Studio's nifi sources; a Studio that cannot declare them (2.8.0 fails its health check with an
      // internal error, §15.5) still gets the monitoring half, and the run says provenance was left out.
      let provenance: string | null = null;
      for (const s of generated.sources.filter((x) => x.entry.type === "nifi")) {
        try { log.push(`Studio: source ${s.id} ${await declare(s.id, s.entry)} (${String(s.entry.base_url)})`); } catch (error) {
          provenance = `provenance left out: Studio did not take the nifi source ${s.id} (${(error as Error).message.slice(0, 300)})`;
          log.push(provenance);
          generated = generateGraph(services, { workspace: "deployer", graph: "nifi-ops", label: "NiFi operations", provenance: false });
          break;
        }
      }
      // The graph, made the first time (a name, or workspace/name in this token's workspace).
      const graphs = await studio.call("list_graphs", {});
      const name = graph.includes("/") ? graph.split("/").slice(1).join("/") : graph;
      const found = ((graphs?.graphs ?? []) as Record<string, string>[]).find((g) => g["graph/qualified-name"] === graph || g["graph/name"] === name);
      if (!found) {
        const made = await studio.call("create_graph", { name });
        if (failed(made)) throw new Error(`create_graph ${name}: ${JSON.stringify(made.findings).slice(0, 400)}`);
        graph = made?.graph?.["graph/qualified-name"] ?? name;
        log.push(`Studio: graph ${graph} created`);
      } else graph = found["graph/qualified-name"] ?? graph;
      const { revision, version } = await publishContract(studio, graph, generated.text, (line) => log.push(line));
      return this.record(reason, actor, graph, ids, "published", `${graph} published${version != null ? ` as version ${version}` : ""}: ${ids.length} service(s), ${generated.entities} entities, ${generated.resolvers} resolvers${provenance ? `; ${provenance.split(" (")[0]}` : ""}`,
        { revision, version, sources: generated.sources.map((s) => s.id), provenance: !provenance, log });
    } catch (error) {
      return this.record(reason, actor, graph, ids, "failed", (error as Error).message.slice(0, 1000), { log });
    }
  }
}
