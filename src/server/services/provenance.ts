// Service ops §9.5, S28 (phase 2 step 7): a service's provenance, read by the Deployer itself. Studio 2.11 removed its
// `nifi` source, so the FlowFile trace no longer goes through Studio: each query is a `nifi-provenance` read job on the
// service executor of one member, which asks its local NiFi with the monitor certificate (submit, poll, always delete;
// at most 100 events, 4 MiB, 30 seconds; never replay, content or a flow change).
//
// A cluster is asked as a whole through one node: NiFi replicates a provenance query to every node and merges their
// events (each says its clusterNodeId and address), so one job answers for the cluster, whichever node's executor is
// online; when that member fails the next one is tried. Lineage and one event's details are per node (event ids are
// the node's own), so they take the event's clusterNodeId and NiFi routes them. Two queries per service run at a time
// (§9.5, like the graph's sources); a time range is required, the page's default is the last hour.

import { newJobId, type Handoff } from "../handoff.ts";
import type { Store } from "../store.ts";
import { LogsError, type LogMember, type ServiceLogs } from "./logs.ts";

type Any = Record<string, any>;

/** §9.5 bounds (the executor enforces them too). */
export const PROVENANCE_MAX = 100;
export const PROVENANCE_SPAN_DAYS = 31;
export const PROVENANCE_PARALLEL = 2;
/** What a member's executor has to name in its heartbeat (§15.2: by kind, not version). */
export const PROVENANCE_KIND = "nifi-provenance@1";
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const NODE = /^[A-Za-z0-9_-]{1,128}$/;

/** Which NiFi versions the trace was tried on (§15.5): 1.12.1, 2.0.0 and a 2.5.0 cluster; 1.12 and later of 1.x, and 2.x. */
export function provenanceSupport(version: string): { supported: boolean; note: string } {
  const m = /^(\d+)\.(\d+)/.exec(version ?? "");
  const [major, minor] = m ? [Number(m[1]), Number(m[2])] : [0, 0];
  if ((major === 1 && minor >= 12) || major === 2) return { supported: true, note: `NiFi ${version}: tried on 1.12.1, 2.0.0 and a 2.5.0 cluster.` };
  return { supported: false, note: `This version is not supported: the FlowFile trace was tried on NiFi 1.12.1, 2.0.0 and 2.5.0 only (NiFi ${version || "of unknown version"}).` };
}

export interface ProvenanceSearch { uuid?: string; field?: string; value?: string; from: string; to: string; maxResults: number; node?: string }
export interface LineageAsk { uuid?: string; eventId?: number; direction: "FLOWFILE" | "PARENTS" | "CHILDREN"; node?: string }

/** A search from the page or an API key: a FlowFile UUID or a field and value, and a time range (both ends required). */
export function parseProvenance(body: unknown): ProvenanceSearch | { error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Any;
  if (!b.from || !b.to) return { error: "from and to are required: a provenance search always has a time range (the page's default is the last hour)." };
  const from = new Date(b.from), to = new Date(b.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) return { error: "from and to are ISO times, from before to." };
  if (to.getTime() - from.getTime() > PROVENANCE_SPAN_DAYS * 86400_000) return { error: `The time range is at most ${PROVENANCE_SPAN_DAYS} days.` };
  const out: ProvenanceSearch = { from: from.toISOString(), to: to.toISOString(), maxResults: PROVENANCE_MAX };
  if (b.uuid !== undefined && b.uuid !== null && b.uuid !== "") {
    if (typeof b.uuid !== "string" || !UUID.test(b.uuid.trim())) return { error: "uuid is a FlowFile UUID." };
    out.uuid = b.uuid.trim().toLowerCase();
  } else {
    if (typeof b.field !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(b.field)) return { error: "Give uuid, or field (a searchable field's id, e.g. Filename, ProcessorID, EventType) and value." };
    if (typeof b.value !== "string" || !b.value.trim() || b.value.length > 256) return { error: "value is 1 to 256 characters." };
    out.field = b.field; out.value = b.value.trim();
  }
  if (b.maxResults !== undefined && !(Number.isInteger(b.maxResults) && b.maxResults >= 1 && b.maxResults <= PROVENANCE_MAX)) return { error: `maxResults is 1 to ${PROVENANCE_MAX}.` };
  if (b.maxResults) out.maxResults = b.maxResults;
  if (b.node !== undefined && b.node !== null && b.node !== "") {
    if (typeof b.node !== "string" || !NODE.test(b.node)) return { error: "node is a cluster node id (an event's clusterNodeId)." };
    out.node = b.node;
  }
  return out;
}

export function parseLineage(body: unknown): LineageAsk | { error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Any;
  const direction = b.direction ?? (b.uuid ? "FLOWFILE" : undefined);
  if (!["FLOWFILE", "PARENTS", "CHILDREN"].includes(direction)) return { error: "Give uuid (a FlowFile's lineage), or eventId with direction PARENTS or CHILDREN." };
  const out: LineageAsk = { direction };
  if (direction === "FLOWFILE") {
    if (typeof b.uuid !== "string" || !UUID.test(b.uuid.trim())) return { error: "uuid is a FlowFile UUID." };
    out.uuid = b.uuid.trim().toLowerCase();
  } else {
    if (!(Number.isInteger(b.eventId) && b.eventId >= 0)) return { error: "eventId is an event's id (a number)." };
    out.eventId = b.eventId;
  }
  if (b.node !== undefined && b.node !== null && b.node !== "") {
    if (typeof b.node !== "string" || !NODE.test(b.node)) return { error: "node is a cluster node id (an event's clusterNodeId)." };
    out.node = b.node;
  }
  return out;
}

export interface ProvenanceMember { key: string; label: string; host: string; online: boolean; canQuery: boolean; reason?: string }

export class ServiceProvenance {
  private store: Store;
  private handoff: Handoff;
  private logs: ServiceLogs;
  private opts: { waitMs?: number; pollMs?: number; busyMs?: number };
  /** The NiFi zone's offset from UTC per service, as the last search said (the event view needs it to give times). */
  private offsets = new Map<string, number>();
  private running = new Map<string, number>();

  constructor(store: Store, handoff: Handoff, logs: ServiceLogs, opts: { waitMs?: number; pollMs?: number; busyMs?: number } = {}) {
    this.store = store;
    this.handoff = handoff;
    this.logs = logs;
    this.opts = opts;
  }

  private service(id: string): { kind: "standalone" | "cluster"; version: string; members: LogMember[] } {
    const standalone = this.store.standalones().find((s) => s.id === id);
    const cluster = standalone ? undefined : this.store.clusters().find((c) => c.id === id);
    const members = this.logs.members(id);
    if ((!standalone && !cluster) || !members) throw new LogsError(404, "service/unknown", `No standalone instance or cluster ${id}.`);
    return { kind: standalone ? "standalone" : "cluster", version: (standalone ?? cluster)!.version, members };
  }

  /** What the page shows before a search: whether this version is supported and which members can be asked. */
  info(id: string): { kind: string; version: string; supported: boolean; note: string; members: ProvenanceMember[]; ready: boolean } {
    const s = this.service(id);
    const members = s.members.map((m): ProvenanceMember => ({
      key: m.key, label: m.label, host: m.host, online: m.executor.online, canQuery: m.canProvenance,
      ...(!m.executor.online ? { reason: m.executor.reason ?? "service executor offline" } : !m.canProvenance ? { reason: `service executor ${m.executor.version ?? ""} cannot read provenance (its heartbeat does not name ${PROVENANCE_KIND}): upgrade it` } : {}),
    }));
    const support = provenanceSupport(s.version);
    return { kind: s.kind, version: s.version, ...support, members, ready: support.supported && members.some((m) => m.online && m.canQuery) };
  }

  /** One nifi-provenance job, on the first usable member that answers (the next one when a member fails). */
  private async ask(id: string, request: Record<string, unknown>): Promise<{ body: Any; member: LogMember }> {
    const s = this.service(id);
    const support = provenanceSupport(s.version);
    if (!support.supported) throw new LogsError(409, "provenance/unsupported", support.note);
    const usable = s.members.filter((m) => m.executor.online && m.canProvenance);
    if (!usable.length) {
      const m = s.members[0];
      throw new LogsError(409, s.members.some((x) => x.executor.online) ? "executor/unsupported" : "provenance/executor-offline",
        s.members.some((x) => x.executor.online) ? `No member's service executor can read provenance (its heartbeat does not name ${PROVENANCE_KIND}): upgrade it first.` : (m?.executor.reason ?? "Every member's service executor is offline."));
    }
    await this.slot(id);
    try {
      let last: Error | undefined;
      for (const m of usable) {
        try { return { body: await this.job(m, request), member: m }; } catch (error) {
          // A refusal is about the request; it would be refused everywhere.
          if (error instanceof LogsError && error.status === 400) throw error;
          last = error as Error;
        }
      }
      throw last!;
    } finally { this.release(id); }
  }

  private async job(m: LogMember, request: Record<string, unknown>): Promise<Any> {
    const id = newJobId("nifi-provenance");
    this.handoff.submit(id, { kind: "nifi-provenance", member: m.key, timeoutSeconds: 40, ...request }, m.host, "service");
    const status = await this.handoff.awaitJob(id, this.opts.waitMs ?? 55_000, this.opts.pollMs ?? 200);
    if (!status) throw new LogsError(503, "provenance/timeout", `The service executor on ${m.host} did not answer in time (job ${id}).`);
    const content = this.handoff.takeContent(id);
    if (status.state !== "succeeded") throw new LogsError(status.state === "refused" ? 400 : 503, `provenance/${status.state}`, `${m.label}: ${status.message ?? status.state}`);
    if (!content || content.truncated) throw new LogsError(503, "provenance/content", `${m.label}: the answer did not arrive whole.`);
    return JSON.parse(content.data.toString("utf8"));
  }

  /** §9.5: two queries per service at a time; a third waits a little, then is told to try again. */
  private async slot(id: string) {
    const until = Date.now() + (this.opts.busyMs ?? 15_000);
    while ((this.running.get(id) ?? 0) >= PROVENANCE_PARALLEL) {
      if (Date.now() > until) throw new LogsError(503, "provenance/busy", `Two provenance queries of ${id} are running; try again in a moment.`);
      await new Promise((r) => setTimeout(r, 100));
    }
    this.running.set(id, (this.running.get(id) ?? 0) + 1);
  }

  private release(id: string) { this.running.set(id, Math.max(0, (this.running.get(id) ?? 1) - 1)); }

  /** Which member an event's node is (by its clusterNodeAddress, host:port as the member's label has it). */
  private memberOf(members: LogMember[], address: unknown): string | null {
    if (members.length === 1) return members[0]!.key;
    if (typeof address !== "string") return null;
    const port = address.split(":").pop();
    return (members.find((m) => m.label === address) ?? members.find((m) => m.label.split(":").pop() === port))?.key ?? null;
  }

  async search(id: string, q: ProvenanceSearch): Promise<Any> {
    const s = this.service(id);
    if (q.node && s.kind !== "cluster") throw new LogsError(400, "provenance/node", "node is only for a cluster.");
    const { body, member } = await this.ask(id, { op: "provenance", from: q.from, to: q.to, maxResults: q.maxResults, ...(q.uuid ? { uuid: q.uuid } : { field: q.field, value: q.value }), ...(q.node ? { node: q.node } : {}) });
    if (typeof body.timeOffset === "number") this.offsets.set(id, body.timeOffset);
    const events = (body.events ?? []) as Any[];
    return {
      ...body, from: q.from, to: q.to, via: { member: member.key, label: member.label },
      events: events.map((e) => ({ ...e, member: this.memberOf(s.members, e.clusterNodeAddress) })),
    };
  }

  async lineage(id: string, q: LineageAsk): Promise<Any> {
    const s = this.service(id);
    if (s.kind === "cluster" && !q.node) throw new LogsError(400, "provenance/node", "On a cluster give node, the event's clusterNodeId: lineage is read on the node that holds it.");
    if (q.node && s.kind !== "cluster") throw new LogsError(400, "provenance/node", "node is only for a cluster.");
    const { body, member } = await this.ask(id, { op: "lineage", direction: q.direction, ...(q.uuid ? { uuid: q.uuid } : { eventId: q.eventId }), ...(q.node ? { node: q.node } : {}) });
    return { ...body, via: { member: member.key, label: member.label } };
  }

  async event(id: string, eventId: number, node?: string): Promise<Any> {
    const s = this.service(id);
    if (!(Number.isInteger(eventId) && eventId >= 0)) throw new LogsError(400, "provenance/event", "The event id is a number.");
    if (s.kind === "cluster" && !node) throw new LogsError(400, "provenance/node", "On a cluster give node, the event's clusterNodeId: event ids are per node.");
    if (node && (s.kind !== "cluster" || !NODE.test(node))) throw new LogsError(400, "provenance/node", "node is a cluster node id, only for a cluster.");
    const offset = this.offsets.get(id);
    const { body, member } = await this.ask(id, { op: "event", eventId, ...(node ? { node } : {}), ...(offset !== undefined ? { timeOffset: offset } : {}) });
    return { ...body, via: { member: member.key, label: member.label }, member: this.memberOf(s.members, body.event?.clusterNodeAddress) };
  }

  async options(id: string): Promise<Any> {
    const { body } = await this.ask(id, { op: "search-options" });
    return body;
  }
}
