// Service ops 搂6: the takeover draft. Discovery (svc-discover, its result kept with its executor_jobs row) says what
// runs where; a draft proposes from it the standalone instances and clusters to register (S4). Nothing in a draft is
// in effect: an administrator edits it item by item and confirms (step 5), which is when rows go into
// service_standalones / service_clusters / service_nodes. This module holds the draft's shapes, their checks, the
// start environment filter, and the step from one discovered instance to a draft member; grouping and the
// comparison between nodes are step 5's.

import { profileFor, type ProfileId, type ServiceType } from "./profiles.ts";

export interface ServicePorts { https?: number | null; http?: number | null; clusterProtocol?: number | null; loadBalance?: number | null; remoteInput?: number | null; management?: number | null }

/** Where a member came from: the discovery job and the installation it found. */
export interface DiscoveryRef { job: string; host: string; installDir: string; confDir?: string | null }

/** One installation as the model keeps it: a standalone instance, or a node of a cluster. */
export interface ServiceMember {
  host: string;
  /** Where NiFi is unpacked (bin/, lib/). */
  installDir: string;
  /** Where nifi.properties and the files beside it are: <installDir>/conf unless bootstrap.conf's conf.dir moves them. Absent or null: <installDir>/conf. */
  confDir?: string | null;
  serviceUser: string | null;
  /** The filtered start environment (filterStartEnvironment): what bin/nifi.sh is run with (S10). */
  startEnvironment: Record<string, string> | null;
  ports: ServicePorts;
  /** NiFi's nifi.cluster.node.address (nodes only). */
  nodeAddress?: string | null;
  discovery?: DiscoveryRef | null;
}

interface ItemBase {
  /** Becomes the instance's or cluster's id when confirmed. */
  id: string;
  service: ServiceType;
  profile: ProfileId;
  version: string;
  webUrl: string | null;
  /** The assessment's findings (assess.ts Finding: differences between nodes, port conflicts, risks), by the rules. */
  findings?: unknown[];
  note?: string | null;
}
export interface DraftStandalone extends ItemBase { kind: "standalone"; member: ServiceMember }
export interface DraftCluster extends ItemBase { kind: "cluster"; zookeeper: string | null; zookeeperRoot: string | null; nodes: ServiceMember[] }
export type DraftItem = DraftStandalone | DraftCluster;

export type DraftState = "open" | "confirmed" | "discarded";
/** The AI review of a draft (P1, optional): explanations and advice on top of the rules' findings, from an OMA session. */
export interface DraftReview { state: "running" | "done" | "failed"; session: string | null; requestedAt: string; requestedBy: string; finishedAt?: string; text?: string; error?: string }
export interface ServiceDraft {
  id: string;
  state: DraftState;
  environment: string;
  /** The discoveries the draft was made from, one per host. */
  sources: { job: string; host: string }[];
  items: (DraftItem & { updatedAt: string; updatedBy: string })[];
  review: DraftReview | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

// The start environment: discovery reads the bootstrap process's environ as it is (desktop and session variables,
// sensitive values already "(hidden)"). Only what starting NiFi depends on is kept, never anything that looks secret.
const KEEP = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TZ", "UMASK", "JAVA_HOME", "JAVA_OPTS", "JAVA_TOOL_OPTIONS", "JRE_HOME", "RUN_AS_USER", "TMPDIR"]);
const KEEP_PREFIX = [/^LC_[A-Z]+$/, /^NIFI_[A-Z0-9_]+$/];
const SECRET = /PASS|SECRET|TOKEN|CREDENTIAL|PRIVATE|(^|_)KEY($|_)|AUTH/i;
/** A kept variable such as JAVA_OPTS can still carry one (-Djavax.net.ssl.keyStorePassword=...). */
const SECRET_VALUE = /pass(word|wd)?=|secret=|token=/i;

/** The start environment worth keeping, and the names of the variables dropped. */
export function filterStartEnvironment(env: Record<string, unknown> | null | undefined): { kept: Record<string, string> | null; dropped: string[] } {
  if (!env) return { kept: null, dropped: [] };
  const kept: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    const wanted = KEEP.has(name) || KEEP_PREFIX.some((r) => r.test(name));
    if (!wanted || SECRET.test(name) || typeof value !== "string" || value === "(hidden)" || SECRET_VALUE.test(value) || value.length > 8192) dropped.push(name);
    else kept[name] = value;
  }
  return { kept, dropped: dropped.sort() };
}

const trimDir = (d: string) => d.replace(/\/+$/, "") || "/";
/** An installation's conf directory: the one recorded, else <installDir>/conf (NiFi's default). */
export const confDirOf = (m: { installDir: string; confDir?: string | null }): string => trimDir(m.confDir || `${trimDir(m.installDir)}/conf`);
/**
 * One installation on a host, as a key: host, installation and conf directory (one unpacked NiFi may run several
 * instances, each with its own conf directory). With the default conf directory it is "host:installDir", as before.
 */
export function installKey(m: { host: string; installDir: string; confDir?: string | null }): string {
  const dir = trimDir(m.installDir), conf = confDirOf(m);
  return conf === `${dir}/conf` ? `${m.host}:${dir}` : `${m.host}:${dir} (conf ${conf})`;
}

const isPort = (v: unknown) => v === null || v === undefined || (Number.isInteger(v) && (v as number) > 0 && (v as number) < 65536);

function checkMember(m: ServiceMember | undefined, where: string): string[] {
  if (!m || typeof m !== "object") return [`${where}: missing`];
  const errors: string[] = [];
  if (typeof m.host !== "string" || !ID.test(m.host)) errors.push(`${where}.host: a host id`);
  if (typeof m.installDir !== "string" || !m.installDir.startsWith("/") || m.installDir.includes("\0") || m.installDir.length > 1024) errors.push(`${where}.installDir: an absolute path`);
  if (m.confDir !== undefined && m.confDir !== null && (typeof m.confDir !== "string" || !m.confDir.startsWith("/") || m.confDir.includes("\0") || m.confDir.length > 1024)) errors.push(`${where}.confDir: an absolute path or null`);
  if (m.serviceUser !== null && typeof m.serviceUser !== "string") errors.push(`${where}.serviceUser: a user name or null`);
  if (m.startEnvironment !== null && (typeof m.startEnvironment !== "object" || Object.values(m.startEnvironment).some((v) => typeof v !== "string"))) errors.push(`${where}.startEnvironment: names to strings, or null`);
  if (!m.ports || typeof m.ports !== "object" || !Object.values(m.ports).every(isPort)) errors.push(`${where}.ports: port numbers`);
  return errors;
}

/** What is wrong with a draft item (empty when it is fine); one installation may appear once in a draft. */
export function checkDraftItem(item: DraftItem, others: DraftItem[] = []): string[] {
  const errors: string[] = [];
  if (!item || typeof item !== "object") return ["item: an object"];
  if (typeof item.id !== "string" || !ID.test(item.id)) errors.push("id: lowercase letters, digits and dashes");
  if (item.kind !== "standalone" && item.kind !== "cluster") errors.push("kind: standalone or cluster");
  const matched = typeof item.version === "string" ? profileFor(item.service, item.version) : undefined;
  if (!matched) errors.push(`version: no profile for ${item.service} ${item.version}`);
  else if (matched.profile.id !== item.profile) errors.push(`profile: ${item.service} ${item.version} is ${matched.profile.id}`);
  if (item.webUrl !== null && (typeof item.webUrl !== "string" || !/^https?:\/\//.test(item.webUrl))) errors.push("webUrl: an http(s) URL or null");
  const members = item.kind === "cluster" ? item.nodes : item.kind === "standalone" ? [item.member] : [];
  if (item.kind === "standalone") errors.push(...checkMember(item.member, "member"));
  if (item.kind === "cluster") {
    if (!Array.isArray(item.nodes) || item.nodes.length === 0) errors.push("nodes: at least one");
    else item.nodes.forEach((n, i) => errors.push(...checkMember(n, `nodes[${i}]`)));
    if (item.zookeeper !== null && typeof item.zookeeper !== "string") errors.push("zookeeper: a connect string or null");
  }
  if (errors.length) return errors;
  const installs = (ms: ServiceMember[]) => ms.map(installKey);
  const mine = installs(members);
  if (new Set(mine).size !== mine.length) errors.push("an installation appears twice");
  // A cluster's nodes are kept by host and installation: two of its nodes from one unpacked NiFi are not supported.
  else if (item.kind === "cluster" && new Set(members.map((m) => `${m.host}:${trimDir(m.installDir)}`)).size !== members.length)
    errors.push("two nodes of the cluster run from one installation on one host (with different conf directories): not supported");
  for (const o of others) {
    if (o.id === item.id) continue;
    const theirs = new Set(installs(o.kind === "cluster" ? o.nodes : [o.member]));
    for (const i of mine) if (theirs.has(i)) errors.push(`${i} is already in ${o.id}`);
  }
  return errors;
}

/** One instance of a discovery result (svc-discover) as a draft member, with its version and profile. */
export function memberFromDiscovery(job: string, host: string, instance: Record<string, any>): { member: ServiceMember; version: string | null; profile: ProfileId | null; webUrl: string | null; dropped: string[] } {
  const { kept, dropped } = filterStartEnvironment(instance.startEnvironment);
  const ports: ServicePorts = {};
  for (const [k, v] of Object.entries(instance.ports ?? {})) if (Number.isInteger(v)) ports[k as keyof ServicePorts] = v as number;
  const version = typeof instance.version === "string" ? instance.version : null;
  const matched = version ? profileFor(instance.service ?? "nifi", version) : undefined;
  // Older service executors did not say (their conf directory was always <installDir>/conf).
  const conf = typeof instance.confDir === "string" ? { confDir: instance.confDir } : {};
  return {
    member: {
      host, installDir: String(instance.installDir), ...conf, serviceUser: instance.serviceUser ?? instance.owner ?? null, startEnvironment: kept, ports,
      ...(instance.cluster?.isNode ? { nodeAddress: instance.cluster.nodeAddress ?? null } : {}),
      discovery: { job, host, installDir: String(instance.installDir), ...conf },
    },
    version, profile: matched?.profile.id ?? null, webUrl: typeof instance.webUrl === "string" ? instance.webUrl : null, dropped,
  };
}
