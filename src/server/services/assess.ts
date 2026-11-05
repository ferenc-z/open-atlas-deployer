// Service ops §6 step 3, P1: the takeover assessment. Code decides, the AI explains: which installations form a cluster
// (nifi.cluster.is.node, the ZooKeeper connect string and root node), where a cluster's nodes disagree (the profile's
// catalog: every scope "cluster" key), ports two installations of one machine both use, and the risks the design lists
// (1.x no longer maintained, an empty sensitive properties key, repositories and logs on one disk, no autostart). The
// rules are stable and testable and need no OMA; the AI review (reviewPrompt) only writes explanations and advice on top.

import { confDirOf, installKey, memberFromDiscovery, type DraftCluster, type DraftItem, type DraftStandalone, type ServiceMember, type ServicePorts } from "./draft.ts";
import { catalogFor, profile, profileFor, type CatalogEntry, type ConfigFile, type ProfileId } from "./profiles.ts";

/** One instance of a discovery result (svc-discover), with the job and host it came from. */
export interface Discovered { job: string; host: string; instance: Record<string, any> }

export type Severity = "error" | "warning" | "info";

/** What the assessment found about a draft item. Secret values never appear: a sensitive key's nodes are told apart by
 *  labels (value A, value B) from the fingerprints discovery sent. */
export interface Finding {
  severity: Severity;
  code: string;
  message: string;
  file?: ConfigFile;
  key?: string;
  /** Per installation, for differences and conflicts. */
  values?: { host: string; installDir: string; value: string | null }[];
}

export interface Skipped { host: string; installDir: string; reason: string }

const HIDDEN = "(hidden)";
const install = (host: string, dir: string, conf?: string | null) => installKey({ host, installDir: dir, confDir: conf });
/** A discovered instance's installation key (installKey): host, installation, conf directory. */
export const discoveredKey = (d: { host: string; instance: Record<string, any> }) =>
  install(d.host, String(d.instance.installDir ?? ""), typeof d.instance.confDir === "string" ? d.instance.confDir : null);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);

/** The ZooKeeper servers of a connect string ("a:2181,b:2181/chroot"), normalised for comparing. */
export function zookeeperServers(connect: string | null | undefined): string[] {
  if (!connect) return [];
  const servers = connect.trim().replace(/\/.*$/, "");
  return servers.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).sort();
}

const rootOf = (i: Record<string, any>) => (i.cluster?.zookeeperRoot || "/nifi").replace(/\/+$/, "") || "/";

function unique(base: string, taken: Set<string>): string {
  let id = base || "nifi";
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

const mostCommon = <T>(values: T[]): T => {
  const counts = new Map<string, { v: T; n: number }>();
  for (const v of values) { const k = JSON.stringify(v); const c = counts.get(k) ?? { v, n: 0 }; c.n++; counts.set(k, c); }
  return [...counts.values()].sort((a, b) => b.n - a.n)[0]!.v;
};

/**
 * Proposes draft items from discoveries (P1): a NiFi that is not a cluster node is a standalone instance; cluster nodes
 * of one profile with the same ZooKeeper root node and ZooKeeper servers in common are one cluster. A node without a
 * connect string forms a cluster of its own (and the assessment says so). Installations already registered, and versions
 * without a profile, are left out with the reason.
 */
export function groupDiscoveries(found: Discovered[], options: { registered?: (host: string, installDir: string, confDir?: string | null) => string | undefined; takenIds?: Iterable<string> } = {}): { items: DraftItem[]; skipped: Skipped[] } {
  const skipped: Skipped[] = [];
  const ids = new Set(options.takenIds ?? []);
  const seen = new Set<string>();
  const standalones: { d: Discovered; m: ReturnType<typeof memberFromDiscovery> }[] = [];
  const nodes: { d: Discovered; m: ReturnType<typeof memberFromDiscovery> }[] = [];
  for (const d of found) {
    const dir = String(d.instance.installDir ?? "");
    const conf = typeof d.instance.confDir === "string" ? d.instance.confDir : null;
    const key = install(d.host, dir, conf);
    if (seen.has(key)) continue;
    seen.add(key);
    const used = options.registered?.(d.host, dir, conf);
    if (used) { skipped.push({ host: d.host, installDir: dir, reason: `already registered as ${used}` }); continue; }
    const m = memberFromDiscovery(d.job, d.host, d.instance);
    if (!m.version || !m.profile) { skipped.push({ host: d.host, installDir: dir, reason: m.version ? `no profile for NiFi ${m.version}` : "the version could not be read" }); continue; }
    (d.instance.cluster?.isNode ? nodes : standalones).push({ d, m });
  }

  // Clusters: union-find over the nodes, joined when profile and root node match and their ZooKeeper servers overlap.
  const parent = nodes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!, b = nodes[j]!;
      const za = zookeeperServers(a.d.instance.cluster?.zookeeper), zb = new Set(zookeeperServers(b.d.instance.cluster?.zookeeper));
      if (a.m.profile === b.m.profile && rootOf(a.d.instance) === rootOf(b.d.instance) && za.some((s) => zb.has(s))) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, typeof nodes>();
  nodes.forEach((n, i) => { const g = groups.get(find(i)) ?? []; g.push(n); groups.set(find(i), g); });

  const items: DraftItem[] = [];
  for (const g of groups.values()) {
    g.sort((a, b) => (a.m.member.nodeAddress ?? "").localeCompare(b.m.member.nodeAddress ?? "") || installKey(a.m.member).localeCompare(installKey(b.m.member)));
    const root = rootOf(g[0]!.d.instance);
    const version = mostCommon(g.map((n) => n.m.version!));
    const c: DraftCluster = {
      kind: "cluster", id: unique(slug(root === "/nifi" ? "nifi-cluster" : root), ids), service: "nifi", profile: g[0]!.m.profile!, version,
      webUrl: g[0]!.m.webUrl, zookeeper: mostCommon(g.map((n) => n.d.instance.cluster?.zookeeper ?? null)), zookeeperRoot: root,
      nodes: g.map((n) => n.m.member),
    };
    items.push(c);
  }
  for (const { d, m } of standalones) {
    // Named after the installation, or after what holds its conf directory when that is elsewhere (/webapp/deploy/nifi/conf: nifi).
    const conf = confDirOf(m.member), named = conf === confDirOf({ installDir: m.member.installDir }) ? m.member.installDir : conf.replace(/\/conf$/, "");
    const base = slug(named.split("/").filter(Boolean).pop() ?? "nifi") || "nifi";
    const s: DraftStandalone = { kind: "standalone", id: unique(ids.has(base) ? slug(`${d.host}-${base}`) : base, ids), service: "nifi", profile: m.profile!, version: m.version!, webUrl: m.webUrl, member: m.member };
    items.push(s);
  }
  return { items, skipped };
}

/** A registered installation, for the port check across what is already managed. */
export interface RegisteredMember { service: string; profile: string; member: Pick<ServiceMember, "host" | "installDir" | "confDir" | "ports"> }

const PORT_NAMES: (keyof ServicePorts)[] = ["https", "http", "clusterProtocol", "loadBalance", "remoteInput", "management"];

/** The ports an installation takes; 2.x without management.server.address listens on 52020 (the profile's default). */
export function portsTaken(profileId: string, ports: ServicePorts): { name: keyof ServicePorts; port: number }[] {
  const out: { name: keyof ServicePorts; port: number }[] = [];
  for (const name of PORT_NAMES) {
    let port = ports[name] ?? null;
    if (name === "management" && port === null && profileId === "nifi-2.x") port = 52020;
    if (port !== null) out.push({ name, port });
  }
  return out;
}

/** Ports two installations of one machine both use (§5.2): within the draft and against what is registered. */
export function portConflicts(items: DraftItem[], registered: RegisteredMember[] = []): Map<string, Finding[]> {
  const byHost = new Map<string, Map<number, { owner: string | null; host: string; installDir: string; confDir: string | null; name: string }[]>>();
  const add = (owner: string | null, profileId: string, m: Pick<ServiceMember, "host" | "installDir" | "confDir" | "ports">) => {
    const ports = byHost.get(m.host) ?? new Map();
    byHost.set(m.host, ports);
    for (const { name, port } of portsTaken(profileId, m.ports ?? {})) {
      const users = ports.get(port) ?? [];
      if (!users.some((u: { host: string; installDir: string; confDir: string | null }) => installKey(u) === installKey(m))) users.push({ owner, host: m.host, installDir: m.installDir, confDir: m.confDir ?? null, name });
      ports.set(port, users);
    }
  };
  const draftInstalls = new Set(items.flatMap((i) => (i.kind === "cluster" ? i.nodes : [i.member]).map(installKey)));
  for (const i of items) for (const m of i.kind === "cluster" ? i.nodes : [i.member]) add(i.id, i.profile, m);
  for (const r of registered) if (!draftInstalls.has(installKey(r.member))) add(null, r.profile, r.member);
  const out = new Map<string, Finding[]>();
  for (const [host, ports] of byHost) {
    for (const [port, users] of ports) {
      if (users.length < 2) continue;
      const finding: Finding = {
        severity: "error", code: "ports/conflict", message: `Port ${port} on ${host} is taken by ${users.length} installations (${users.map((u) => u.name).join(", ")}).`,
        values: users.map((u) => ({ host: u.host, installDir: u.installDir, value: `${u.name} ${port}` })),
      };
      for (const owner of new Set(users.map((u) => u.owner).filter((o): o is string => o !== null))) out.set(owner, [...(out.get(owner) ?? []), finding]);
    }
  }
  return out;
}

/** A key's value on one installation: the file's, or the catalog default when the file leaves the key out. Hidden
 *  (secret) values become their fingerprint, or undefined when discovery sent none (an older executor or Deployer). */
function valueOf(instance: Record<string, any>, e: CatalogEntry): string | null | undefined {
  const file = e.file === "bootstrap.conf" ? instance.bootstrap : instance.properties;
  if (!file || !(e.key in file)) return e.default;
  const v = String(file[e.key]);
  if (v !== HIDDEN) return v;
  const fp = instance.fingerprints?.[e.file]?.[e.key];
  return typeof fp === "string" ? `fp:${fp}` : undefined;
}

const SHOWN_SEVERITY = (e: CatalogEntry): Severity => (e.sensitive || e.grouping ? "error" : "warning");

function compareNodes(c: DraftCluster, byInstall: Map<string, Discovered>): Finding[] {
  const prof = profile(c.profile);
  if (!prof) return [];
  const found: Finding[] = [];
  const nodes = c.nodes.map((m) => ({ m, d: byInstall.get(installKey(m)) })).filter((n): n is { m: ServiceMember; d: Discovered } => Boolean(n.d));
  if (nodes.length < 2) return found;
  const versions = [...new Set(nodes.map((n) => String(n.d.instance.version)))];
  if (versions.length > 1) found.push({ severity: "error", code: "cluster/version-differs", message: `The nodes run different versions: ${versions.join(", ")}.`, values: nodes.map((n) => ({ host: n.m.host, installDir: n.m.installDir, value: String(n.d.instance.version) })) });
  const uncompared: string[] = [];
  for (const e of catalogFor(prof, c.version)) {
    if (e.scope !== "cluster") continue;
    const values = nodes.map((n) => valueOf(n.d.instance, e));
    if (values.some((v) => v === undefined)) { uncompared.push(e.key); continue; }
    if (new Set(values).size < 2) continue;
    // Secrets: never the value, never the fingerprint; the nodes with the same one share a label.
    const labels = new Map<string, string>();
    const shown = values.map((v) => (!e.sensitive ? v : v === "" || v === null ? "(empty)" : labels.get(v!) ?? (labels.set(v!, `value ${String.fromCharCode(65 + labels.size)}`), labels.get(v!)!)));
    found.push({
      severity: SHOWN_SEVERITY(e), code: "cluster/differs", file: e.file, key: e.key,
      message: `${e.key} (${e.file}) differs between the nodes${e.note ? `: ${e.note}` : "."}`,
      values: nodes.map((n, i) => ({ host: n.m.host, installDir: n.m.installDir, value: shown[i] ?? null })),
    });
  }
  if (uncompared.length) found.push({ severity: "info", code: "cluster/not-compared", message: `Not compared (discovery sent no fingerprint for these secrets; discover again with a current executor): ${uncompared.join(", ")}.` });
  return found;
}

function memberRisks(m: ServiceMember, d: Discovered | undefined, prof: ProfileId): Finding[] {
  const where = { host: m.host, installDir: m.installDir };
  const at = installKey(m);
  if (!d) return [{ severity: "warning", code: "discovery/missing", message: `No discovery result for ${at}: discover the host again.` }];
  const i = d.instance, out: Finding[] = [];
  for (const p of i.problems ?? []) out.push({ severity: "warning", code: "discovery/problem", message: `${at}: ${p}` });
  if (!i.running) out.push({ severity: "info", code: "not-running", message: `${at} was not running when discovered.` });
  const key = i.properties?.["nifi.sensitive.props.key"];
  if (key === "" || key === undefined) {
    out.push({ severity: prof === "nifi-1.x" ? "error" : "warning", code: "sensitive-key/empty", message: prof === "nifi-1.x"
      ? `${at}: nifi.sensitive.props.key is empty, so 1.x encrypts the flow's secrets with its built-in default key.`
      : `${at}: nifi.sensitive.props.key is empty; 2.x generates one at the next start, which must then be the same on every node.` });
  }
  const s = i.storage as Record<string, { path: string; device: number | null } | null> | undefined;
  if (s?.logs?.device != null) {
    const shared = (["content", "flowfile", "provenance"] as const).filter((r) => s[r]?.device != null && s[r]!.device === s.logs!.device);
    if (shared.length) out.push({ severity: "warning", code: "storage/shared-disk", message: `${at}: the ${shared.join(", ")} repositor${shared.length > 1 ? "ies are" : "y is"} on the same disk as the logs; a full repository stops the logging too.`, values: [{ ...where, value: shared.map((r) => s[r]!.path).concat(s.logs.path).join(", ") }] });
  }
  if (Array.isArray(i.autostart) && i.autostart.length === 0) out.push({ severity: "warning", code: "autostart/none", message: `${at}: no systemd unit or init script starts it at boot.` });
  return out;
}

/** The findings of one draft item from the discoveries behind it, with the port conflicts already worked out. */
export function assessItem(item: DraftItem, byInstall: Map<string, Discovered>, conflicts: Finding[] = []): Finding[] {
  const out: Finding[] = [];
  const tested = profileFor(item.service, item.version)?.tested;
  if (item.profile === "nifi-1.x") out.push({ severity: "warning", code: "version/unmaintained", message: `NiFi ${item.version}: the 1.x line is no longer maintained; plan the move to 2.x.` });
  if (tested === false) out.push({ severity: "info", code: "version/untested", message: `NiFi ${item.version} matches ${item.profile} but was not tested against it.` });
  const members = item.kind === "cluster" ? item.nodes : [item.member];
  if (item.kind === "cluster") {
    if (item.nodes.length === 1) out.push({ severity: "warning", code: "cluster/one-node", message: "Only one node of this cluster was found: discover its other hosts, or check the ZooKeeper settings." });
    if (!item.zookeeper) out.push({ severity: "warning", code: "cluster/no-zookeeper", message: "A cluster node without nifi.zookeeper.connect.string: it cannot be grouped with its other nodes." });
    out.push(...compareNodes(item, byInstall));
  }
  for (const m of members) out.push(...memberRisks(m, byInstall.get(installKey(m)), item.profile));
  out.push(...conflicts);
  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

/** Every item with its findings (rules only), replacing what they had. */
export function assessItems(items: DraftItem[], found: Discovered[], registered: RegisteredMember[] = []): DraftItem[] {
  const byInstall = new Map(found.map((d) => [discoveredKey(d), d]));
  const conflicts = portConflicts(items, registered);
  return items.map((item) => ({ ...item, findings: assessItem(item, byInstall, conflicts.get(item.id)) }));
}

/** What the AI review is asked (P1: it explains and advises; the grouping and findings are the rules'). No secret goes
 *  in: findings carry labels, never values, and the configuration files are not sent. */
export function reviewPrompt(draftId: string, environment: string, items: DraftItem[]): string {
  const brief = items.map((i) => ({
    id: i.id, kind: i.kind, version: i.version, profile: i.profile,
    installations: (i.kind === "cluster" ? i.nodes : [i.member]).map(installKey),
    ...(i.kind === "cluster" ? { zookeeper: i.zookeeper, zookeeperRoot: i.zookeeperRoot } : {}),
    findings: (i.findings ?? []) as Finding[],
  }));
  return [
    `Takeover assessment ${draftId} for the ${environment} environment: NiFi installations the Deployer found and proposes to register as managed services.`,
    "The grouping into standalone instances and clusters, and the findings below, come from rules (the service profile's property catalog); do not regroup.",
    "For each item write, in Chinese, a short explanation of the risks its findings mean for operating it, and what to do about them, most important first.",
    "Answer in plain text, one section per item id. Nothing is changed by the takeover itself: it only registers and reads.",
    "",
    JSON.stringify(brief, null, 2),
  ].join("\n");
}
