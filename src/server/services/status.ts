// Service ops: how a registered standalone instance or cluster is doing. Phase 2 (§15.2): the state is live, from the
// collector's newest sample of each member — running or stopped as of that sample ("as of" kept); no sample for more
// than 3 sampling periods: unknown; the member's service executor offline: lost. A member never sampled yet (an
// executor without the collector, or just registered) falls back to its host's newest discovery as in phase 1.
// A cluster's node connections come from the coordinator's view (/controller/cluster is complete only there).

import type { ExecutorInfo } from "../handoff.ts";
import type { NginxCheck, Point, ServiceCert, Store } from "../store.ts";
import { confDirOf, installKey, type DraftItem, type ServiceMember, type ServicePorts } from "./draft.ts";
import { discoveredKey, type Finding } from "./assess.ts";
import { ownNode } from "./metrics.ts";
import { NIFI_THRESHOLDS, profile, type Thresholds } from "./profiles.ts";

/** A service's thresholds in effect: its profile's defaults, overridden by its thresholds column. */
export function thresholdsOf(store: Store, id: string, profileId: string): { defaults: Thresholds; overrides: Partial<Thresholds>; effective: Thresholds } {
  const defaults = profile(profileId)?.thresholds ?? NIFI_THRESHOLDS;
  const overrides = Object.fromEntries(Object.entries(store.serviceThresholds(id)).filter(([k, v]) => k in defaults && typeof v === "number")) as Partial<Thresholds>;
  return { defaults, overrides, effective: { ...defaults, ...overrides } };
}

/** running / stopped: as of the newest sample (or discovery); not-found: the newest discovery did not see it;
 *  unknown: no sample for 3 periods (or nothing at all yet); lost: the member's service executor is offline. */
export type MemberState = "running" | "stopped" | "not-found" | "unknown" | "lost";

/** The default sampling period when the heartbeat does not say (EXECUTOR_COLLECT_SECONDS). */
export const DEFAULT_PERIOD = 60;
/** A member without a sample for this many periods is unknown. */
export const STALE_PERIODS = 3;

export interface LiveView {
  at: string;
  receivedAt: string;
  running: boolean | null;
  pid: number | null;
  startedAt: string | null;
  /** The collector's verdict on the REST API: ok, partial, unreachable, not-running, no-certificate, no-https. */
  nifi: string | null;
  version: string | null;
  /** A cluster node's connection status and roles, in the coordinator's view. */
  connection: string | null;
  roles: string[];
  /** The sample's flat numbers (heap, queue, threads, …: metrics.ts FIELDS). */
  point: Point | null;
  problems: string[];
}

export interface MemberStatus {
  /** installKey: how samples, metrics and certificates name the member. */
  key: string;
  host: string;
  installDir: string;
  confDir: string;
  nodeAddress?: string | null;
  serviceUser: string | null;
  ports: ServicePorts;
  executor: { online: boolean; reason?: string; version?: string; ageSeconds?: number };
  state: MemberState;
  /** Where the state comes from, and as of when. */
  source: "samples" | "discovery" | "executor" | "none";
  asOf: string | null;
  live: LiveView | null;
  /** The newest discovery (phase 1's state; still shown). */
  seen: { job: string; at: string | null; version: string | null; pid: number | null; webUrl: string | null } | null;
}

export interface CertSummary { member: string; store: string; subject: string | null; notAfter: string; days: number }

/** One of the fullest queues in a back pressure summary (the service executor sends at most its EXECUTOR_BACKPRESSURE_TOP). */
export interface CongestedQueue {
  id?: string; name?: string | null; group?: string | null; sourceName?: string | null; destinationName?: string | null;
  percentUseCount?: number; percentUseBytes?: number; flowFilesQueued?: number; bytesQueued?: number;
}

/** Owner 2026-11-07: back pressure is read every everySeconds (default 300) and kept only as a summary: how many
 *  connections are at their threshold (full), the fullest percentage and the fullest queues. Flow-wide: the newest of
 *  any member. stale: older than 3 intervals (the rules cannot tell then). */
export interface BackpressureSummary {
  at: string; member: string; everySeconds: number; connections: number | null; full: number | null; maxPercent: number | null;
  top: CongestedQueue[]; stale: boolean;
}

/** How far back the newest back pressure summary is looked for: 3 of the longest interval (3600 s). */
const BACKPRESSURE_LOOKBACK = 3 * 3600_000;

export function backpressureSummary(store: Store, id: string, period: number, now: Date): BackpressureSummary | null {
  const got = store.latestServiceBackpressure(id, new Date(now.getTime() - BACKPRESSURE_LOOKBACK).toISOString());
  if (!got) return null;
  const b = got.backpressure as Any;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  // An executor from before sends it every round, without its own time or interval.
  const everySeconds = n(b.everySeconds) ?? period;
  const at = typeof b.at === "string" ? b.at : got.at;
  return {
    at, member: got.member, everySeconds, connections: n(b.connections), full: n(b.full), maxPercent: n(b.maxPercent),
    top: Array.isArray(b.top) ? (b.top as CongestedQueue[]) : [], stale: now.getTime() - Date.parse(at) > STALE_PERIODS * Math.max(everySeconds, period) * 1000,
  };
}

export interface ServiceStatus {
  id: string;
  kind: DraftItem["kind"];
  service: string;
  profile: string;
  version: string;
  webUrl: string | null;
  /** Phase 2 step 6: where operations put it behind nginx (the nifi-ops graph) and the last check through it. */
  nginxUrl: string | null;
  nginxCheck: NginxCheck | null;
  zookeeper?: string | null;
  zookeeperRoot?: string | null;
  environment: string;
  draft: string | null;
  createdAt: string;
  createdBy: string;
  configRevision: number | null;
  members: MemberStatus[];
  /** members running of how many; executors online; versions seen that differ from the registered one; differences: the
   *  takeover's node-difference findings; findings: the takeover's findings by severity (alerts are step 3);
   *  asOf: the oldest member's as-of time; cert: the soonest-expiring certificate; certErrors: stores that could not be read. */
  summary: {
    members: number; running: number; executorsOnline: number; versionsSeen: string[]; differences: number; findings: Record<Finding["severity"], number>;
    asOf: string | null; period: number; cert: CertSummary | null; certErrors: number;
    /** Phase 2 step 3: the open alerts by level. */
    alerts: { open: number; CRIT: number; WARN: number };
    /** The certificate rule's thresholds in effect (days): the badges colour by them. */
    certDays: { warn: number; crit: number };
    /** The newest back pressure summary (none: never read, or not for 3 hours). */
    backpressure: BackpressureSummary | null;
  };
  findings: Finding[];
  /** S27: every certificate of every member, as of each member's newest reading. */
  certs: ServiceCert[];
  /** The newest of the timeline (service_events, rules.ts): takeover, configuration, alerts, restarts, connections. */
  events: TimelineEvent[];
}

export interface TimelineEvent { at: string; kind: string; member: string | null; text: string; by: string | null; level: string | null }

export function timeline(store: Store, id: string, options: { limit?: number; from?: string; to?: string; kind?: string } = {}): TimelineEvent[] {
  return store.serviceEvents(id, options).map((e) => ({ at: e.at, kind: e.kind, member: e.member, text: String(e.detail.text ?? e.kind), by: typeof e.detail.by === "string" ? e.detail.by : null, level: typeof e.detail.level === "string" ? e.detail.level : null }));
}

export function takeoverFindings(store: Store, draft: string | null, id: string): Finding[] {
  if (!draft) return [];
  const item = store.serviceDraft(draft)?.items.find((i) => i.id === id);
  return (item?.findings ?? []) as Finding[];
}

type Any = Record<string, any>;

/** The soonest-expiring certificate of a service's (end-entity and CA alike: either breaks TLS). */
export function soonestCert(certs: ServiceCert[], now: Date): CertSummary | null {
  let best: CertSummary | null = null;
  for (const c of certs) {
    if (!c.notAfter) continue;
    const days = Math.floor((Date.parse(c.notAfter) - now.getTime()) / 86_400_000);
    if (!best || c.notAfter < best.notAfter) best = { member: c.member, store: c.store, subject: c.subject, notAfter: c.notAfter, days };
  }
  return best;
}

/** The status of one registered service, or undefined when there is none with that id. */
export function serviceStatus(store: Store, executor: (host: string) => ExecutorInfo, id: string, now: Date = new Date()): ServiceStatus | undefined {
  const s = store.standalones().find((x) => x.id === id);
  const c = s ? undefined : store.clusters().find((x) => x.id === id);
  const item = s ?? c;
  if (!item) return undefined;
  const members: ServiceMember[] = s ? [s.member] : c!.nodes;
  const discoveries = new Map<string, { job: string; at: string | null; instances: Record<string, any>[] } | null>();
  const discoveryOf = (host: string) => {
    if (!discoveries.has(host)) {
      const job = store.latestExecutorJob(host, "service", "svc-discover", true);
      const j = job ? store.executorJob(job) : undefined;
      const result = j?.status?.result as unknown as { instances?: Record<string, any>[]; scannedAt?: string } | undefined;
      discoveries.set(host, job && j ? { job, at: result?.scannedAt ?? j.status?.finishedAt ?? null, instances: result?.instances ?? [] } : null);
    }
    return discoveries.get(host)!;
  };
  const samples = new Map(store.latestServiceSamples(id).map((x) => [x.member, x]));
  // The coordinator's view of the cluster: the newest sample whose own node is the coordinator, else the newest with a view.
  const views = [...samples.values()].filter((x) => Array.isArray((x.body.nifi as Any | undefined)?.cluster?.nodes)).sort((a, b) => (a.at < b.at ? 1 : -1));
  const coordinator = views.find((x) => {
    const m = members.find((mm) => installKey(mm) === x.member);
    return m && (ownNode((x.body.nifi as Any).cluster.nodes as Any[], m)?.roles as string[] | undefined)?.includes("Cluster Coordinator");
  }) ?? views[0];
  let period = DEFAULT_PERIOD;
  const statuses = members.map((m): MemberStatus => {
    const e = executor(m.host);
    const seconds = Number(e.heartbeat?.collector?.seconds);
    if (seconds > 0) period = seconds;
    const memberPeriod = seconds > 0 ? seconds : DEFAULT_PERIOD;
    const d = discoveryOf(m.host);
    const found = d?.instances.find((i) => discoveredKey({ host: m.host, instance: i }) === installKey(m));
    const sample = samples.get(installKey(m));
    let live: LiveView | null = null;
    if (sample) {
      const b = sample.body as Any;
      const view = coordinator ? ownNode((coordinator.body.nifi as Any).cluster.nodes as Any[], m) : undefined;
      live = {
        at: sample.at, receivedAt: sample.receivedAt, running: typeof b.process?.running === "boolean" ? b.process.running : null, pid: b.process?.pid ?? null,
        startedAt: b.process?.startedAt ?? null, nifi: b.nifi?.state ?? null, version: b.nifi?.about?.version ?? null,
        connection: s ? null : (view?.status as string | undefined) ?? null, roles: s ? [] : (view?.roles as string[] | undefined) ?? [],
        point: sample.point, problems: Array.isArray(b.problems) ? b.problems.map(String) : [],
      };
    }
    let state: MemberState, source: MemberStatus["source"], asOf: string | null;
    if (!e.online) { state = "lost"; source = "executor"; asOf = live?.at ?? null; }
    else if (live) {
      const stale = now.getTime() - Date.parse(live.at) > STALE_PERIODS * memberPeriod * 1000;
      state = stale || live.running === null ? "unknown" : live.running ? "running" : "stopped";
      source = "samples"; asOf = live.at;
    } else if (d) { state = !found ? "not-found" : found.running ? "running" : "stopped"; source = "discovery"; asOf = d.at; }
    else { state = "unknown"; source = "none"; asOf = null; }
    return {
      key: installKey(m), host: m.host, installDir: m.installDir, confDir: confDirOf(m), ...(m.nodeAddress !== undefined ? { nodeAddress: m.nodeAddress } : {}), serviceUser: m.serviceUser, ports: m.ports,
      executor: { online: e.online, ...(e.reason ? { reason: e.reason } : {}), ...(e.heartbeat?.version ? { version: e.heartbeat.version } : {}), ...(e.ageSeconds !== undefined ? { ageSeconds: e.ageSeconds } : {}) },
      state, source, asOf, live,
      seen: d ? { job: d.job, at: d.at, version: found?.version ?? null, pid: found?.process?.pid ?? null, webUrl: found?.webUrl ?? null } : null,
    };
  });
  const findings = takeoverFindings(store, item.draft, item.id);
  const count = (sev: Finding["severity"]) => findings.filter((f) => f.severity === sev).length;
  const revisions = store.serviceConfigRevisions(item.id);
  // A version differing from the registered one, live (REST) or as discovered.
  const versionsSeen = [...new Set(statuses.map((m) => m.live?.version ?? m.seen?.version).filter((v): v is string => Boolean(v) && v !== item.version))];
  const keys = new Set(members.map(installKey));
  const certs = store.serviceCerts(item.id).filter((x) => keys.has(x.member));
  const limits = thresholdsOf(store, item.id, item.profile).effective;
  const open = store.serviceAlerts({ service: item.id, state: "open" });
  const asOfs = statuses.map((m) => m.asOf).filter((a): a is string => Boolean(a)).sort();
  return {
    id: item.id, kind: item.kind, service: item.service, profile: item.profile, version: item.version, webUrl: item.webUrl, nginxUrl: item.nginxUrl ?? null, nginxCheck: item.nginxCheck ?? null,
    ...(c ? { zookeeper: c.zookeeper, zookeeperRoot: c.zookeeperRoot } : {}),
    environment: item.environment, draft: item.draft, createdAt: item.createdAt, createdBy: item.createdBy,
    configRevision: revisions[0]?.revision ?? null,
    members: statuses,
    summary: {
      members: statuses.length, running: statuses.filter((m) => m.state === "running").length, executorsOnline: statuses.filter((m) => m.executor.online).length, versionsSeen,
      differences: findings.filter((f) => f.code === "cluster/differs" || f.code === "cluster/version-differs").length,
      findings: { error: count("error"), warning: count("warning"), info: count("info") },
      asOf: asOfs[0] ?? null, period, cert: soonestCert(certs, now), certErrors: certs.filter((x) => x.error).length,
      certDays: { warn: limits.certWarnDays, crit: limits.certCritDays },
      alerts: { open: open.length, CRIT: open.filter((a) => a.level === "CRIT").length, WARN: open.filter((a) => a.level === "WARN").length },
      backpressure: backpressureSummary(store, item.id, period, now),
    },
    findings,
    certs,
    events: timeline(store, item.id, { limit: 20 }),
  };
}
