// Service ops §11 phase 1: how a registered standalone instance or cluster is doing, from what the Deployer already
// has: each member's host's service executor (online or not) and that host's newest finished discovery (was the
// installation's NiFi running then, at which version and pid). Phase 1 has no probes of its own (§9 is phase 2), so
// "running" means "running when last discovered", with the time; discovering again brings it up to date.

import type { ExecutorInfo } from "../handoff.ts";
import type { Store } from "../store.ts";
import { confDirOf, installKey, type DraftItem, type ServiceMember, type ServicePorts } from "./draft.ts";
import { discoveredKey, type Finding } from "./assess.ts";

export type MemberState = "running" | "stopped" | "not-found" | "unknown";

export interface MemberStatus {
  host: string;
  installDir: string;
  confDir: string;
  nodeAddress?: string | null;
  serviceUser: string | null;
  ports: ServicePorts;
  executor: { online: boolean; reason?: string; version?: string };
  /** running / stopped: discovery saw the installation (running or not); not-found: the newest discovery did not see it; unknown: no discovery yet. */
  state: MemberState;
  /** The discovery the state is from. */
  seen: { job: string; at: string | null; version: string | null; pid: number | null; webUrl: string | null } | null;
}

export interface ServiceStatus {
  id: string;
  kind: DraftItem["kind"];
  service: string;
  profile: string;
  version: string;
  webUrl: string | null;
  zookeeper?: string | null;
  zookeeperRoot?: string | null;
  environment: string;
  draft: string | null;
  createdAt: string;
  createdBy: string;
  configRevision: number | null;
  members: MemberStatus[];
  /** How many members were running at their host's newest discovery, of how many; versions seen that differ from the registered one;
   *  differences: the takeover's node-difference findings; findings: the takeover's findings by severity (phase 1 has no alerts). */
  summary: { members: number; running: number; executorsOnline: number; versionsSeen: string[]; differences: number; findings: Record<Finding["severity"], number> };
  /** What the takeover draft found for this item (rules, §6 step 3), errors first. */
  findings: Finding[];
  /** What happened to it, newest first: phase 1 has the registration and the configuration revisions (S23 timeline). */
  events: { at: string; kind: "registered" | "config"; text: string; by: string }[];
}

/** The takeover findings of a registered item: those of the draft item it was confirmed from. */
export function takeoverFindings(store: Store, draft: string | null, id: string): Finding[] {
  if (!draft) return [];
  const item = store.serviceDraft(draft)?.items.find((i) => i.id === id);
  return (item?.findings ?? []) as Finding[];
}


/** The status of one registered service, or undefined when there is none with that id. */
export function serviceStatus(store: Store, executor: (host: string) => ExecutorInfo, id: string): ServiceStatus | undefined {
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
  const statuses = members.map((m): MemberStatus => {
    const e = executor(m.host);
    const d = discoveryOf(m.host);
    const found = d?.instances.find((i) => discoveredKey({ host: m.host, instance: i }) === installKey(m));
    const state: MemberState = !d ? "unknown" : !found ? "not-found" : found.running ? "running" : "stopped";
    return {
      host: m.host, installDir: m.installDir, confDir: confDirOf(m), ...(m.nodeAddress !== undefined ? { nodeAddress: m.nodeAddress } : {}), serviceUser: m.serviceUser, ports: m.ports,
      executor: { online: e.online, ...(e.reason ? { reason: e.reason } : {}), ...(e.heartbeat?.version ? { version: e.heartbeat.version } : {}) },
      state,
      seen: d ? { job: d.job, at: d.at, version: found?.version ?? null, pid: found?.process?.pid ?? null, webUrl: found?.webUrl ?? null } : null,
    };
  });
  const findings = takeoverFindings(store, item.draft, item.id);
  const count = (s: Finding["severity"]) => findings.filter((f) => f.severity === s).length;
  const revisions = store.serviceConfigRevisions(item.id);
  const versionsSeen =[...new Set(statuses.map((m) => m.seen?.version).filter((v): v is string => Boolean(v) && v !== item.version))];
  return {
    id: item.id, kind: item.kind, service: item.service, profile: item.profile, version: item.version, webUrl: item.webUrl,
    ...(c ? { zookeeper: c.zookeeper, zookeeperRoot: c.zookeeperRoot } : {}),
    environment: item.environment, draft: item.draft, createdAt: item.createdAt, createdBy: item.createdBy,
    configRevision: revisions[0]?.revision ?? null,
    members: statuses,
    summary: {
      members: statuses.length, running: statuses.filter((m) => m.state === "running").length, executorsOnline: statuses.filter((m) => m.executor.online).length, versionsSeen,
      differences: findings.filter((f) => f.code === "cluster/differs" || f.code === "cluster/version-differs").length,
      findings: { error: count("error"), warning: count("warning"), info: count("info") },
    },
    findings,
    events: [
      ...revisions.map((r) => ({ at: r.savedAt, kind: "config" as const, text: `Configuration revision ${r.revision}${r.source === "import" ? ", imported from the hosts" : ` (${r.source})`}${r.note ? `: ${r.note}` : ""}`, by: r.savedBy })),
      { at: item.createdAt, kind: "registered" as const, text: `Taken over${item.draft ? ` from draft ${item.draft}` : ""}`, by: item.createdBy },
    ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.kind === "config" ? -1 : 1)),
  };
}
