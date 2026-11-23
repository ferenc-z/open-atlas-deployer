// pages-rethink A9, §10.2 step 1: the flow counts and the topology the service executor sends in its samples
// (nifi.flowCounts, every 5 minutes): the in/out counts of each group under root and of the S2S ports, a topology
// snapshot when it was walked, and once, for a service just taken over, NiFi's own status history (about 24 hours).
// Kept 30 days. B2: only "is there traffic", no baseline.

import { createHash } from "node:crypto";
import type { FlowCountRow, Store } from "../store.ts";
import type { ServiceSample } from "./watch.ts";

export const FLOW_DAYS = 30;
const FIVE_MINUTES = 5 * 60_000;
const DAY = 86_400_000;

/** One unit's connected piece (A7 ②): key = its smallest component id. */
export interface TopologyFragment {
  key: string; processors: number; names: string[];
  /** The unit's own input and output ports in this piece (names). */
  inputs: string[]; outputs: string[];
  /** Remote-access input ports in it (S2S in), and the S2S refs it sends to. */
  remoteIn: string[]; s2sOut: string[];
  /** Processors without an incoming connection, plus remote input ports: where data starts (A7 ③ "its own start"). */
  starts: number;
}
/** A group directly under root; root: true is the root canvas' own components. */
export interface TopologyGroup { id: string; name: string; root: boolean; fragments: TopologyFragment[] }
export interface TopologyEnd { group: string; fragment: string | null; port: string | null }
/** The topology body (service_topology.body), as the executor's build_topology makes it. */
export interface Topology {
  root: { id: string; name: string };
  groups: TopologyGroup[];
  /** Root-level connections between units. */
  links: { connection: string; from: TopologyEnd; to: TopologyEnd }[];
  s2sIn: { id: string; name: string; group: string; fragment: string | null }[];
  /** sources (service executor 0.9.5 on): the components whose connections lead into the RPG port. */
  s2sOut: { ref: string; name: string; targets: string[]; group: string; fragment: string | null; sources?: { id: string; name: string; kind: string; relationships: string[] }[] }[];
  /** Service executor 0.9.6: where data leaves NiFi (a writing processor that leads nowhere on the canvas) and what it auto-terminates. */
  ends?: { id: string; name: string; type: string; group: string; fragment: string | null; relationships: string[] }[];
  /** Step 3b (executors from ops step 3b on; older ones leave it out): a group deeper than root's children -> its unit (group under root, or root's id). */
  nested?: Record<string, string>;
  /** Step 3b: in a unit of several fragments, a processor's id -> its fragment key. */
  split?: Record<string, string>;
}

type Any = Record<string, any>;
const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
const KINDS = new Set(["group", "s2s-out", "s2s-in"]);

/** The 5-minute bucket of NiFi's window that ends at `endMs` (it covers the 5 minutes before): the boundary nearest its start. */
export function bucketOfWindow(endMs: number): string {
  return new Date(Math.round((endMs - FIVE_MINUTES) / FIVE_MINUTES) * FIVE_MINUTES).toISOString().replace(".000Z", "Z");
}

/** Key order fixed, so the same topology hashes the same. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Any)[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}
export const topologyHash = (t: unknown) => createHash("sha256").update(canonical(t)).digest("hex");

function isTopology(t: unknown): t is Topology {
  const x = t as Any;
  return Boolean(x) && typeof x.root?.id === "string" && Array.isArray(x.groups) && Array.isArray(x.links) && Array.isArray(x.s2sIn) && Array.isArray(x.s2sOut);
}

/** The rows of one sample's nifi.flowCounts. */
export function flowRows(service: string, flow: Any): FlowCountRow[] {
  const rows: FlowCountRow[] = [];
  const at = Date.parse(flow?.at);
  const row = (bucket: string, c: Any, v: number[], source: FlowCountRow["source"]): FlowCountRow => ({
    service, bucket, kind: c.kind, ref: String(c.ref).slice(0, 1000), name: String(c.name ?? c.ref).slice(0, 500),
    flowfilesIn: int(v[0]), flowfilesOut: int(v[1]), bytesIn: int(v[2]), bytesOut: int(v[3]), transferred: int(v[4]), source,
  });
  const ok = (c: Any) => c && KINDS.has(c.kind) && typeof c.ref === "string" && c.ref;
  if (!Number.isNaN(at) && Array.isArray(flow?.counts)) {
    const bucket = bucketOfWindow(at);
    for (const c of flow.counts) if (ok(c)) rows.push(row(bucket, c, [c.flowFilesIn, c.flowFilesOut, c.bytesIn, c.bytesOut, c.transferred], "sample"));
  }
  if (Array.isArray(flow?.history)) {
    for (const h of flow.history) {
      if (!ok(h) || !Array.isArray(h.points)) continue;
      for (const p of h.points) if (Array.isArray(p) && typeof p[0] === "number") rows.push(row(bucketOfWindow(p[0]), h, p.slice(1), "nifi-history"));
    }
  }
  return rows;
}

/** A sample's flow counts and topology into their tables; the sample body keeps neither (the caller strips nifi.flowCounts). */
export function ingestFlow(store: Store, sample: ServiceSample): { counts: number; topology: boolean } {
  const flow = (sample.nifi as Any | undefined)?.flowCounts as Any | undefined;
  if (!flow || typeof flow !== "object") return { counts: 0, topology: false };
  const rows = flowRows(sample.service, flow);
  store.putFlowCounts(rows);
  let topology = false;
  if (isTopology(flow.topology) && !Number.isNaN(Date.parse(flow.at))) topology = store.putTopology(sample.service, new Date(flow.at).toISOString(), topologyHash(flow.topology), flow.topology);
  return { counts: rows.length, topology };
}

export function pruneFlow(store: Store, now: Date) {
  const before = new Date(now.getTime() - FLOW_DAYS * DAY).toISOString();
  store.pruneFlowAnomalies(before);
  return store.pruneFlowData(before);
}
