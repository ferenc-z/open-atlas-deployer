// Service ops §9.4, §9.5, §15.3: the `nifi-ops` Studio graph. The Deployer writes it from the registered standalone
// instances and clusters that have an nginx address (nginxUrl): per service one `api` source for monitoring (GET only,
// 2 at a time, 5 s, no retries) and one `nifi` source for provenance, both at <nginxUrl>/nifi-api — nginx holds the
// NiFi client certificate and puts every node of a cluster behind the one address (S20); Studio authenticates to nginx
// only. Entities follow NiFi's objects: the flow controller (instance or cluster), nodes and their JVMs, process
// groups, connections, processors, bulletins, provenance events.
//
// One graph for every version line (§9.4 item 3, checked on 1.12.1 and the 2.5.0 cluster in step 6, §15.5): the
// endpoints used here answer the same shapes on both lines; fields only 2.x has are nullable.
//
// A resolver has exactly one binding and so one source; a graph with several services therefore gives each service
// its own entities, namespaced nifi.<service> (nifi.n112.processor/run-status …). The usage guide says so.

import { edn, kw, map, set } from "./edn.ts";

export interface GraphService {
  /** The standalone instance's or the cluster's id. */
  id: string;
  kind: "standalone" | "cluster";
  version: string;
  /** Where operations put the service behind nginx: http(s)://host[:port][/prefix], without /nifi-api. */
  nginxUrl: string;
}

export interface GraphSource { id: string; service: string; entry: Record<string, unknown> }
export interface GeneratedGraph { text: string; sources: GraphSource[]; services: string[]; entities: number; resolvers: number }

/** The bounds of every call Studio makes to a service's nginx (§9.4 item 2). */
export const SOURCE_RESILIENCE = { timeout_ms: 5000, max_retries: 0, bulkhead: { concurrency: 2, max_wait_ms: 100 } } as const;

/** A service id as it may stand in an attribute namespace and in source and resolver ids. */
export function slug(id: string): string {
  const s = id.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!s) throw new Error(`service id ${JSON.stringify(id)} has no letters or digits`);
  return /^[a-z]/.test(s) ? s : `s${s}`;
}

export const sourceIds = (service: string) => ({ api: `nifi-ops-${slug(service)}`, provenance: `nifi-ops-${slug(service)}-provenance` });

/** nginxUrl as the API root the sources call: no trailing slash, /nifi-api appended once. */
export function apiRoot(nginxUrl: string): string {
  const u = nginxUrl.trim().replace(/\/+$/, "").replace(/\/nifi-api$/, "");
  return `${u}/nifi-api`;
}

/** An admin's nginx address, checked: http or https, a host, no query, no credentials. Returns the cleaned value or an error. */
export function checkNginxUrl(value: unknown): { url: string } | { error: string } {
  if (typeof value !== "string" || !value.trim()) return { error: "nginxUrl is an http(s) address." };
  let u: URL;
  try { u = new URL(value.trim()); } catch { return { error: "nginxUrl is not a URL." }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { error: "nginxUrl starts with http:// or https://." };
  if (u.username || u.password) return { error: "nginxUrl carries no user or password: nginx authenticates Studio by other means." };
  if (u.search || u.hash) return { error: "nginxUrl has no query or fragment." };
  return { url: value.trim().replace(/\/+$/, "").replace(/\/nifi-api$/, "") };
}

type Type = "string" | "integer" | "decimal" | "boolean" | "datetime" | "json";
/** [local name, label, type, JSONPath in the record, nullable (default true)] */
type Field = [string, string, Type, string, boolean?];

const PG: Field[] = [
  ["id", "Process group id", "string", "$.id", false],
  ["name", "Name", "string", "$.name"],
  ["queued-count", "FlowFiles queued", "integer", "$.flowFilesQueued"],
  ["queued-bytes", "Bytes queued", "integer", "$.bytesQueued"],
  ["active-threads", "Active threads", "integer", "$.activeThreadCount"],
  ["flowfiles-in", "FlowFiles in (5 min)", "integer", "$.flowFilesIn"],
  ["flowfiles-out", "FlowFiles out (5 min)", "integer", "$.flowFilesOut"],
  ["bytes-in", "Bytes in (5 min)", "integer", "$.bytesIn"],
  ["bytes-out", "Bytes out (5 min)", "integer", "$.bytesOut"],
  ["bytes-read", "Bytes read (5 min)", "integer", "$.bytesRead"],
  ["bytes-written", "Bytes written (5 min)", "integer", "$.bytesWritten"],
];
const PROCESSOR: Field[] = [
  ["id", "Processor id", "string", "$.processorStatusSnapshot.id", false],
  ["name", "Name", "string", "$.processorStatusSnapshot.name"],
  ["type", "Type", "string", "$.processorStatusSnapshot.type"],
  ["run-status", "Run status (Running, Stopped, Invalid, Disabled, Validating)", "string", "$.processorStatusSnapshot.runStatus"],
  ["group-id", "Process group id", "string", "$.processorStatusSnapshot.groupId"],
  ["execution-node", "Runs on (ALL or PRIMARY)", "string", "$.processorStatusSnapshot.executionNode"],
  ["active-threads", "Active threads", "integer", "$.processorStatusSnapshot.activeThreadCount"],
  ["tasks", "Tasks (5 min)", "integer", "$.processorStatusSnapshot.taskCount"],
  ["flowfiles-in", "FlowFiles in (5 min)", "integer", "$.processorStatusSnapshot.flowFilesIn"],
  ["flowfiles-out", "FlowFiles out (5 min)", "integer", "$.processorStatusSnapshot.flowFilesOut"],
  ["bytes-read", "Bytes read (5 min)", "integer", "$.processorStatusSnapshot.bytesRead"],
  ["bytes-written", "Bytes written (5 min)", "integer", "$.processorStatusSnapshot.bytesWritten"],
];
const CONNECTION: Field[] = [
  ["id", "Connection id", "string", "$.connectionStatusSnapshot.id", false],
  ["name", "Name", "string", "$.connectionStatusSnapshot.name"],
  ["group-id", "Process group id", "string", "$.connectionStatusSnapshot.groupId"],
  ["source-name", "From", "string", "$.connectionStatusSnapshot.sourceName"],
  ["destination-name", "To", "string", "$.connectionStatusSnapshot.destinationName"],
  ["queued-count", "FlowFiles queued", "integer", "$.connectionStatusSnapshot.flowFilesQueued"],
  ["queued-bytes", "Bytes queued", "integer", "$.connectionStatusSnapshot.bytesQueued"],
  ["percent-use-count", "Back pressure by count, % of the threshold", "integer", "$.connectionStatusSnapshot.percentUseCount"],
  ["percent-use-bytes", "Back pressure by size, % of the threshold", "integer", "$.connectionStatusSnapshot.percentUseBytes"],
  ["flowfiles-in", "FlowFiles in (5 min)", "integer", "$.connectionStatusSnapshot.flowFilesIn"],
  ["flowfiles-out", "FlowFiles out (5 min)", "integer", "$.connectionStatusSnapshot.flowFilesOut"],
  ["availability", "FlowFile availability (2.x only)", "string", "$.connectionStatusSnapshot.flowFileAvailability"],
];
const CONTROLLER_STATUS: Field[] = [
  ["active-threads", "Active threads", "integer", "$.activeThreadCount"],
  ["queued-count", "FlowFiles queued", "integer", "$.flowFilesQueued"],
  ["queued-bytes", "Bytes queued", "integer", "$.bytesQueued"],
  ["running", "Components running", "integer", "$.runningCount"],
  ["stopped", "Components stopped", "integer", "$.stoppedCount"],
  ["invalid", "Components invalid", "integer", "$.invalidCount"],
  ["disabled", "Components disabled", "integer", "$.disabledCount"],
];
const CONTROLLER_ABOUT: Field[] = [
  ["version", "NiFi version", "string", "$.version", false],
  ["timezone", "NiFi's time zone (bulletin times are in it)", "string", "$.timezone"],
];
const NODE: Field[] = [
  ["id", "Node id", "string", "$.nodeId", false],
  ["address", "Address", "string", "$.address"],
  ["api-port", "API port", "integer", "$.apiPort"],
  ["status", "Status (CONNECTED, DISCONNECTED, CONNECTING, OFFLOADED …)", "string", "$.status"],
  ["roles", "Roles (Primary Node, Cluster Coordinator)", "json", "$.roles"],
  ["heartbeat", "Last heartbeat (NiFi's time zone)", "string", "$.heartbeat"],
  ["started", "Node started (NiFi's time zone)", "string", "$.nodeStartTime"],
  ["active-threads", "Active threads", "integer", "$.activeThreadCount"],
  ["queued-count", "FlowFiles queued", "integer", "$.flowFilesQueued"],
  ["queued-bytes", "Bytes queued", "integer", "$.bytesQueued"],
];
const JVM: Field[] = [
  ["heap-used", "Heap used, bytes", "integer", "$.usedHeapBytes"],
  ["heap-max", "Heap max, bytes", "integer", "$.maxHeapBytes"],
  ["heap-utilization", "Heap used, % (text)", "string", "$.heapUtilization"],
  ["non-heap-used", "Non-heap used, bytes", "integer", "$.usedNonHeapBytes"],
  ["threads", "JVM threads", "integer", "$.totalThreads"],
  ["processors", "CPUs", "integer", "$.availableProcessors"],
  ["load", "Load average", "decimal", "$.processorLoadAverage"],
  ["uptime", "Uptime", "string", "$.uptime"],
  ["flowfile-repo-utilization", "FlowFile repository disk used, % (text)", "string", "$.flowFileRepositoryStorageUsage.utilization"],
  ["content-repos", "Content repositories' disks", "json", "$.contentRepositoryStorageUsage"],
  ["provenance-repos", "Provenance repositories' disks", "json", "$.provenanceRepositoryStorageUsage"],
  ["gc", "Garbage collectors (count, time)", "json", "$.garbageCollection"],
];
const BULLETIN: Field[] = [
  ["id", "Bulletin id (per node)", "integer", "$.id", false],
  ["node", "Node address (clusters)", "string", "$.nodeAddress"],
  ["level", "Level", "string", "$.bulletin.level"],
  ["category", "Category", "string", "$.bulletin.category"],
  ["source-id", "Component id", "string", "$.bulletin.sourceId"],
  ["source-name", "Component name", "string", "$.bulletin.sourceName"],
  ["source-type", "Component type", "string", "$.bulletin.sourceType"],
  ["group-id", "Process group id", "string", "$.bulletin.groupId"],
  ["message", "Message", "string", "$.bulletin.message"],
  ["time", "Time of day (NiFi's time zone)", "string", "$.timestamp"],
];
const EVENT: Field[] = [
  ["id", "Event id", "integer", "$.eventId", false],
  ["flowfile", "FlowFile UUID", "string", "$.flowFileUuid"],
  ["type", "Event type (RECEIVE, CREATE, ROUTE, DROP …)", "string", "$.eventType"],
  ["time", "Event time (NiFi's format and time zone)", "string", "$.eventTime"],
  ["component-id", "Component id", "string", "$.componentId"],
  ["component-name", "Component name", "string", "$.componentName"],
  ["component-type", "Component type", "string", "$.componentType"],
  ["group-id", "Process group id", "string", "$.groupId"],
  ["relationship", "Relationship", "string", "$.relationship"],
  ["details", "Details", "string", "$.details"],
  ["node", "Cluster node id (standalone: standalone)", "string", "$.nodeScope"],
  ["size", "FlowFile size, bytes", "integer", "$.fileSizeBytes"],
  ["duration", "Event duration, ms", "integer", "$.eventDuration"],
];

const COLLECTION = (maxItems: number) => ({
  ":ordering": kw("source-defined"), ":paging": kw("none"), ":completeness": kw("not-guaranteed"),
  ":bounds": { ":max-items": maxItems, ":max-response-bytes": 4194304, ":timeout-ms": 5000 },
});

/** Builds the contract for these services. `workspace` and `graph` are placeholders the publisher replaces. */
export function generateGraph(services: GraphService[], opts: { workspace?: string; graph?: string; label?: string; release?: string; provenance?: boolean } = {}): GeneratedGraph {
  const withProvenance = opts.provenance ?? true;
  const list = [...services].sort((a, b) => a.id.localeCompare(b.id));
  const seen = new Set<string>();
  for (const s of list) { const k = slug(s.id); if (seen.has(k)) throw new Error(`two services make the same graph name ${k}`); seen.add(k); }
  const graphId = opts.graph ?? "nifi-ops";
  const entities: Record<string, unknown> = {};
  const attributes: [unknown, unknown][] = [];
  const resolvers: Record<string, unknown> = {};
  const bindings: Record<string, unknown> = {};
  const selection: [unknown, unknown][] = [];
  const execSources: Record<string, unknown> = {};
  const sources: GraphSource[] = [];
  const usedKinds = new Set<string>();

  for (const s of list) {
    const N = `nifi.${slug(s.id)}`;
    const ids = sourceIds(s.id);
    const what = s.kind === "cluster" ? `cluster ${s.id}` : `instance ${s.id}`;
    const ent = (name: string) => `${N}.${name}`;
    const attr = (e: string, local: string) => kw(`${ent(e)}/${local}`);
    const slot = (a: ReturnType<typeof kw>) => a.name;
    const addEntity = (name: string, label: string, identity: string[] | null, fields: Field[], extra: [string, Record<string, unknown>][] = [], notes?: string) => {
      const all = [...fields.map((f) => f[0]), ...extra.map(([n]) => n)];
      entities[ent(name)] = {
        ":entity/label": `${label} (${what})`,
        ":entity/identity": (identity ?? []).map((n) => attr(name, n)),
        ":entity/attributes": all.map((n) => attr(name, n)),
        ...(notes ? { ":entity/notes": notes } : {}),
      };
      for (const [n, label2, type, , nullable] of fields)
        attributes.push([attr(name, n), { ":attribute/label": label2, ":attribute/type": kw(type), ":attribute/nullable?": nullable ?? true }]);
      for (const [n, spec] of extra) attributes.push([attr(name, n), spec]);
    };
    const mapping = (e: string, fields: Field[], strip = "") => map(fields.map(([n, , , path]) => [attr(e, n), strip ? path.replace(strip, "$") : path]));
    const outMap = (pairs: ReturnType<typeof kw>[]) => map(pairs.map((a) => [a, slot(a)]));
    const resolver = (id: string, def: Record<string, unknown>, impl: Record<string, unknown>, inputMap: [ReturnType<typeof kw>, string][], outputs: ReturnType<typeof kw>[], source = ids.api, extra: Record<string, unknown> = {}) => {
      const rid = `${slug(s.id)}-${id}`;
      resolvers[rid] = { ":effect": kw("read"), ...def };
      bindings[`${rid}-api`] = {
        ":binding/for": [kw("resolver"), rid], ":binding/source": source, ":binding/effect": kw("read"),
        ":binding/implementation": impl,
        ":binding/input-map": map(inputMap), ":binding/output-map": outMap(outputs), ...extra,
      };
      selection.push([[kw("resolver"), rid], `${rid}-api`]);
    };

    // The flow controller: one per instance or cluster (cluster-wide numbers on a cluster).
    // A standalone instance's JVM and disks are the controller's; a cluster's are per node (jvm below).
    addEntity("controller", "NiFi flow controller", ["version"], [...CONTROLLER_ABOUT, ...CONTROLLER_STATUS, ...(s.kind === "standalone" ? JVM : [])], [],
      "Read at the root of a query: no input. On a cluster the numbers are the whole cluster's.");
    resolver("about", { ":label": `About ${s.id}`, ":result/cardinality": kw("one"), ":input": [], ":output": CONTROLLER_ABOUT.map((f) => attr("controller", f[0])) },
      { ":method": "GET", ":endpoint": "/flow/about", ":data_path": "$.about", ":field_mapping": mapping("controller", CONTROLLER_ABOUT) }, [], CONTROLLER_ABOUT.map((f) => attr("controller", f[0])));
    resolver("status", { ":label": `Flow status of ${s.id}`, ":result/cardinality": kw("one"), ":input": [], ":output": CONTROLLER_STATUS.map((f) => attr("controller", f[0])) },
      { ":method": "GET", ":endpoint": "/flow/status", ":data_path": "$.controllerStatus", ":field_mapping": mapping("controller", CONTROLLER_STATUS) }, [], CONTROLLER_STATUS.map((f) => attr("controller", f[0])));

    // Nodes (clusters): the cluster coordinator's view; the JVM of each node from system diagnostics.
    const jvmAttrs = JVM.map((f) => attr("controller", f[0]));
    if (s.kind === "cluster") {
      const all = attr("node", "all");
      addEntity("node", "NiFi cluster node", ["id"], NODE, [["all", { ":attribute/label": "All nodes", ":attribute/type": kw("ref"), ":attribute/target": ent("node"), ":attribute/cardinality": kw("many"), ":attribute/nullable?": false }]]);
      resolver("nodes", { ":label": `Nodes of ${s.id}`, ":result/cardinality": kw("many"), ":input": [], ":collection": COLLECTION(100), ":output": [map([[all, NODE.map((f) => attr("node", f[0]))]])] },
        { ":method": "GET", ":endpoint": "/controller/cluster", ":data_path": "$.cluster.nodes", ":result-root": all, ":field_mapping": mapping("node", NODE) }, [], [all, ...NODE.map((f) => attr("node", f[0]))]);
      const nodes = attr("jvm", "nodes");
      const JVM_NODE: Field[] = [["node-id", "Node id", "string", "$.nodeId", false], ["address", "Address", "string", "$.address"], ["api-port", "API port", "integer", "$.apiPort"],
        ...JVM.map(([n, l, t, p]): Field => [n, l, t, p.replace(/^\$\./, "$.snapshot.")])];
      addEntity("jvm", "NiFi node JVM and disks", ["node-id"], JVM_NODE, [["nodes", { ":attribute/label": "Every node's JVM", ":attribute/type": kw("ref"), ":attribute/target": ent("jvm"), ":attribute/cardinality": kw("many"), ":attribute/nullable?": false }]]);
      resolver("diagnostics", { ":label": `System diagnostics of each node of ${s.id}`, ":result/cardinality": kw("many"), ":input": [], ":collection": COLLECTION(100), ":output": [map([[nodes, JVM_NODE.map((f) => attr("jvm", f[0]))]])] },
        { ":method": "GET", ":endpoint": "/system-diagnostics", ":query_params": { nodewise: "true" }, ":data_path": "$.systemDiagnostics.nodeSnapshots", ":result-root": nodes, ":field_mapping": mapping("jvm", JVM_NODE) }, [], [nodes, ...JVM_NODE.map((f) => attr("jvm", f[0]))]);
    } else {
      resolver("diagnostics", { ":label": `System diagnostics of ${s.id}`, ":result/cardinality": kw("one"), ":input": [], ":output": jvmAttrs },
        { ":method": "GET", ":endpoint": "/system-diagnostics", ":data_path": "$.systemDiagnostics.aggregateSnapshot", ":field_mapping": mapping("controller", JVM) }, [], jvmAttrs);
    }

    // Process groups, one level at a time (never recursive=true, §9.4 item 2): give the id ("root" for the top).
    const pgId = attr("pg", "id");
    const ref = (target: string, label: string) => ({ ":attribute/label": label, ":attribute/type": kw("ref"), ":attribute/target": ent(target), ":attribute/cardinality": kw("many"), ":attribute/nullable?": true });
    addEntity("pg", "NiFi process group", ["id"], PG, [["groups", ref("pg", "Child process groups")], ["processors", ref("processor", "Processors")], ["connections", ref("connection", "Connections")]],
      'Name a group by an ident join, {[:<ns>/id "root"] [...]} for the top group; children come one level at a time.');
    addEntity("processor", "NiFi processor status", ["id"], PROCESSOR);
    addEntity("connection", "NiFi connection (queue) status", ["id"], CONNECTION);
    const PG_CHILD: Field[] = PG.map(([n, l, t, p, nl]) => [n, l, t, p.replace(/^\$\./, "$.processGroupStatusSnapshot."), nl]);
    const pgOut = PG.filter((f) => f[0] !== "id").map((f) => attr("pg", f[0]));
    const procAttrs = PROCESSOR.map((f) => attr("processor", f[0]));
    const connAttrs = CONNECTION.map((f) => attr("connection", f[0]));
    resolver("pg-status", {
      ":label": `Process group status of ${s.id}`, ":result/cardinality": kw("one"), ":input": [pgId],
      ":output": [...pgOut, map([[attr("pg", "groups"), PG_CHILD.map((f) => attr("pg", f[0]))]]), map([[attr("pg", "processors"), procAttrs]]), map([[attr("pg", "connections"), connAttrs]])],
    }, {
      ":method": "GET", ":endpoint": `/flow/process-groups/{${pgId.name}}/status`, ":data_path": "$.processGroupStatus.aggregateSnapshot",
      ":field_mapping": map([
        ...PG.filter((f) => f[0] !== "id").map(([n, , , p]) => [attr("pg", n), p] as [unknown, unknown]),
        [attr("pg", "groups"), map([[kw("_from"), "$.processGroupStatusSnapshots[*]"], ...PG_CHILD.map(([n, , , p]) => [attr("pg", n), p] as [unknown, unknown])])],
        [attr("pg", "processors"), map([[kw("_from"), "$.processorStatusSnapshots[*]"], ...PROCESSOR.map(([n, , , p]) => [attr("processor", n), p] as [unknown, unknown])])],
        [attr("pg", "connections"), map([[kw("_from"), "$.connectionStatusSnapshots[*]"], ...CONNECTION.map(([n, , , p]) => [attr("connection", n), p] as [unknown, unknown])])],
      ]),
    }, [[pgId, slot(pgId)]], [...pgOut, attr("pg", "groups"), attr("pg", "processors"), attr("pg", "connections"), ...PG_CHILD.map((f) => attr("pg", f[0])), ...procAttrs, ...connAttrs]
      .filter((a, i, all) => all.findIndex((b) => b.name === a.name) === i));

    // Bulletins: the newest 50 on the board (NiFi keeps 5 minutes of them).
    const recent = attr("bulletin", "recent");
    addEntity("bulletin", "NiFi bulletin", ["id"], BULLETIN, [["recent", { ":attribute/label": "Newest bulletins", ":attribute/type": kw("ref"), ":attribute/target": ent("bulletin"), ":attribute/cardinality": kw("many"), ":attribute/nullable?": false }]]);
    resolver("bulletins", { ":label": `Bulletins of ${s.id}`, ":result/cardinality": kw("many"), ":input": [], ":collection": COLLECTION(50), ":output": [map([[recent, BULLETIN.map((f) => attr("bulletin", f[0]))]])] },
      { ":method": "GET", ":endpoint": "/flow/bulletin-board", ":query_params": { limit: "50" }, ":data_path": "$.bulletinBoard.bulletins", ":result-root": recent, ":field_mapping": mapping("bulletin", BULLETIN) }, [], [recent, ...BULLETIN.map((f) => attr("bulletin", f[0]))]);

    // Provenance (§9.5) through Studio's nifi source: the events of one FlowFile UUID. Step 7 builds the trace on it.
    // Left out (provenance: false) when Studio cannot take the nifi source; monitoring stands on its own.
    if (withProvenance) {
    const ffId = attr("flowfile", "uuid");
    addEntity("flowfile", "NiFi FlowFile", ["uuid"], [["uuid", "FlowFile UUID", "string", "$.flowFileUuid", false]], [["events", ref("event", "Provenance events")]]);
    addEntity("event", "NiFi provenance event", ["id"], EVENT);
    const evAttrs = EVENT.map((f) => attr("event", f[0]));
    resolver("provenance", {
      ":label": `Provenance events of a FlowFile in ${s.id}`, ":result/cardinality": kw("one"), ":input": [ffId],
      ":params": { ":start": { ":type": kw("string"), ":description": "Earliest event, NiFi's format MM/dd/yyyy HH:mm:ss z" }, ":end": { ":type": kw("string"), ":description": "Latest event, same format" } },
      ":output": [map([[attr("flowfile", "events"), evAttrs]])],
    }, {
      ":operation": kw("provenance"),
      ":field_mapping": map([[attr("flowfile", "events"), map([[kw("_from"), "$.events[*]"], ...EVENT.map(([n, , , p]) => [attr("event", n), p] as [unknown, unknown])])]]),
    }, [[ffId, "uuid"]], [attr("flowfile", "events"), ...evAttrs], ids.provenance, { ":binding/parameter-map": { ":start": "start-date", ":end": "end-date" } });
    }

    execSources[ids.api] = { ":source/kind": "api", ":source/effects": set([kw("read")]), ":source/policy": { ":max_retries": 0 } };
    usedKinds.add("api");
    if (withProvenance) { execSources[ids.provenance] = { ":source/kind": "nifi", ":source/effects": set([kw("read")]) }; usedKinds.add("nifi"); }
    const base = apiRoot(s.nginxUrl);
    sources.push({ id: ids.api, service: s.id, entry: { type: "api", label: `NiFi monitoring: ${s.id}`, base_url: base, health_endpoint: "/flow/about", resilience: SOURCE_RESILIENCE } });
    if (withProvenance) sources.push(
      { id: ids.provenance, service: s.id, entry: { type: "nifi", label: `NiFi provenance: ${s.id}`, base_url: base, health_endpoint: "/flow/about", resilience: SOURCE_RESILIENCE } },
    );
  }

  const entityIds = Object.keys(entities);
  const resolverIds = Object.keys(resolvers);
  const doc = {
    ":contract": { ":contract/family": "atlas-semantic", ":contract/version": "2.0.0" },
    ":workspace": { ":workspace/id": opts.workspace ?? "deployer" },
    ":graph": {
      ":graph/id": graphId, ":graph/label": opts.label ?? "NiFi operations", ":graph/exposure": kw("restricted"),
      ":graph/entities": entityIds, ":graph/resolvers": resolverIds, ":graph/operations": [], ":graph/terms": [], ":graph/dependencies": [],
      ":graph/usage-guide": {
        ":guide/purpose": "Live details of the NiFi instances and clusters the Open Atlas Deployer manages: flow status, nodes, JVMs, process groups, queues, processors, bulletins, provenance.",
        ":guide/asset-scope": `Services: ${list.map((s) => `${s.id} (${s.kind}, NiFi ${s.version}) as nifi.${slug(s.id)}.*`).join("; ")}.`,
        ":guide/applicability": "Drill down to a component when the Deployer's samples point at one. Process groups are named by an ident join, [{[:nifi.<service>.pg/id \"root\"] [...]}] for the top, and answer one level: their child groups, processors and connections.",
        ":guide/limitations": ["Read only: nothing here starts, stops or changes NiFi", "Each call goes to NiFi through nginx, two at a time per service, 5 seconds each; history and alerts are in the Deployer", "Times are in NiFi's own time zone (controller timezone)", "Fields marked 2.x only are empty on NiFi 1.x"],
      },
    },
    ":vocabulary": { ":entities": entities, ":attributes": map(attributes) },
    ":execution": { ":resolvers": resolvers, ":operations": {}, ":sources": execSources, ":bindings": bindings, ":selection": map(selection) },
    ":ownership": {
      ":entities": Object.fromEntries(entityIds.map((e) => [e, graphId])), ":resolvers": Object.fromEntries(resolverIds.map((r) => [r, graphId])),
      ":operations": {}, ":terms": {},
    },
    ":publication": {
      ":release/version": opts.release ?? "1.0.0", ":source/revision": 1,
      ":required-capabilities": set([
        kw("semantic/core-v1"), kw("graph/single-owner-v1"), kw("deployment/source-slot-v1"), kw("artifact/embedded-closure-v1"),
        ...[...usedKinds].sort().map((k) => kw(`connector/${k}`)),
        kw("query/source-collection-v1"), ...(withProvenance ? [kw("execution/params-v2")] : []), kw("source/policy-v1"),
      ]),
    },
  };
  return { text: `;; Generated by the Open Atlas Deployer (services/graph.ts); edit the generator, not this file.\n${edn(doc)}\n`, sources, services: list.map((s) => s.id), entities: entityIds.length, resolvers: resolverIds.length };
}
