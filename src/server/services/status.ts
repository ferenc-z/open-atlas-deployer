// Service ops §11 phase 1: how a registered standalone instance or cluster is doing, from what the Deployer already
// has: each member's host's service executor (online or not) and that host's newest finished discovery (was the
// installation's NiFi running then, at which version and pid). Phase 1 has no probes of its own (§9 is phase 2), so
// "running" means "running when last discovered", with the time; discovering again brings it up to date.

import type { ExecutorInfo } from "../handoff.ts";
import type { Store } from "../store.ts";
import type { DraftItem, ServiceMember, ServicePorts } from "./draft.ts";

export type MemberState = "running" | "stopped" | "not-found" | "unknown";

export interface MemberStatus {
  host: string;
  installDir: string;
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
  /** How many members were running at their host's newest discovery, of how many; versions seen that differ from the registered one. */
  summary: { members: number; running: number; executorsOnline: number; versionsSeen: string[] };
}

const dirOf = (d: string) => d.replace(/\/+$/, "");

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
    const found = d?.instances.find((i) => dirOf(String(i.installDir ?? "")) === dirOf(m.installDir));
    const state: MemberState = !d ? "unknown" : !found ? "not-found" : found.running ? "running" : "stopped";
    return {
      host: m.host, installDir: m.installDir, ...(m.nodeAddress !== undefined ? { nodeAddress: m.nodeAddress } : {}), serviceUser: m.serviceUser, ports: m.ports,
      executor: { online: e.online, ...(e.reason ? { reason: e.reason } : {}), ...(e.heartbeat?.version ? { version: e.heartbeat.version } : {}) },
      state,
      seen: d ? { job: d.job, at: d.at, version: found?.version ?? null, pid: found?.process?.pid ?? null, webUrl: found?.webUrl ?? null } : null,
    };
  });
  const versionsSeen = [...new Set(statuses.map((m) => m.seen?.version).filter((v): v is string => Boolean(v) && v !== item.version))];
  return {
    id: item.id, kind: item.kind, service: item.service, profile: item.profile, version: item.version, webUrl: item.webUrl,
    ...(c ? { zookeeper: c.zookeeper, zookeeperRoot: c.zookeeperRoot } : {}),
    environment: item.environment, draft: item.draft, createdAt: item.createdAt, createdBy: item.createdBy,
    configRevision: store.serviceConfigRevisions(item.id)[0]?.revision ?? null,
    members: statuses,
    summary: { members: statuses.length, running: statuses.filter((m) => m.state === "running").length, executorsOnline: statuses.filter((m) => m.executor.online).length, versionsSeen },
  };
}
