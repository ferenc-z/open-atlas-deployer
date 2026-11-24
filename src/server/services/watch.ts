// Service ops §15.2 P5, §15.3: what a host's service executor samples. Its heartbeat reply carries the watch list: every
// registered standalone instance and cluster node on that host (S26: one per machine in production; the code takes a
// list). The executor guesses nothing and samples nothing else; a takeover or a removal counts from the next heartbeat.
// The HTTPS host and the log directory come from the discovery the member was registered from (the executor reads
// nifi.properties itself when they are missing).

import type { Store } from "../store.ts";
import { confDirOf, installKey, type ServiceMember } from "./draft.ts";
import { discoveredKey } from "./assess.ts";

export interface WatchEntry {
  /** The standalone instance's or the cluster's id. */
  service: string;
  kind: "standalone" | "node";
  /** installKey of the installation: host, installation, conf directory. */
  member: string;
  profile: string;
  installDir: string;
  confDir: string;
  /** nifi.web.https.host (null: not known, the executor reads it) and the HTTPS port. */
  https: { host: string | null; port: number | null };
  nodeAddress: string | null;
  /** NiFi's log directory as discovery saw it (NIFI_LOG_DIR, else <install>/logs); null: not known. */
  logDir: string | null;
  /** The configuration files to fingerprint (§16.3): what this member should have, so it is what the fingerprints are compared with. */
  files: { name: string; path: string }[];
  /** pages-rethink A9: no flow counts of this service yet, so the executor reads NiFi's status history (about 24 hours) once. */
  flowHistory: boolean;
  /** S39 step 1 (§7.4): the registered groups this member reads, each with its subgroups and one hop out (service
   *  executor 0.9.7, flow-groups@1). Left out: nothing registered for the service yet, the whole canvas is read as
   *  before. []: another node of the cluster reads them (§7.7 question 6), or none is registered. */
  groups?: { id: string }[];
}

/** S39 step 1: the capability a service executor names when it reads only the watch entry's groups. */
export const FLOW_GROUPS_KIND = "flow-groups@1";
const BEAT_FRESH_MS = 30_000;

/** S39 (step 2): the switch that lets the watch carry the registered groups. Off unless DEPLOYER_REGISTERED_GROUPS=1:
 *  the skeleton, the model and the gates still assume the whole canvas (step 3 changes that), so the real services are
 *  read whole until then. */
export const registeredGroupsOn = (env: NodeJS.ProcessEnv = process.env): boolean => env.DEPLOYER_REGISTERED_GROUPS === "1";

/** S39: the groups registered for a service (ids, a business's and a shared module's, once each); undefined while the
 *  switch is off or the service has no registration (never []: that would stop the service's counts and topology). */
export function registeredGroups(store: Store, service: string, on = registeredGroupsOn()): string[] | undefined {
  if (!on) return undefined;
  const ids = [...new Set(store.flowRegistrations({ service }).map((r) => r.groupId))];
  return ids.length ? ids : undefined;
}

/** §7.7 question 6: which node of a cluster reads its registered groups. A group's status is the cluster's total on
 *  every node, so one reads for all: the first node (in the cluster's order) whose service executor beat in the last
 *  30 seconds, names flow-groups@1 and whose last sample (10 minutes at most) saw NiFi answer; else the first such
 *  node; else the first with a fresh beat; else the first. Chosen again with every heartbeat reply, so another node
 *  takes over within a round or two. */
export function groupsReader(store: Store, service: string, nodes: ServiceMember[], now = Date.now()): string | undefined {
  const fresh = (m: ServiceMember) => {
    const beat = store.executorBeat(m.host, "service");
    return beat && now - Date.parse(beat.beatAt) <= BEAT_FRESH_MS ? (beat.heartbeat as { kinds?: unknown }) ?? {} : undefined;
  };
  const answered = new Set(store.latestServiceSamples(service)
    .filter((s) => ["ok", "partial"].includes(String((s.body?.nifi as { state?: unknown } | undefined)?.state)) && now - Date.parse(s.at) <= 10 * 60_000)
    .map((s) => s.member));
  const live = nodes.filter((m) => { const k = fresh(m)?.kinds; return Array.isArray(k) && k.includes(FLOW_GROUPS_KIND); });
  const pick = live.find((m) => answered.has(installKey(m))) ?? live[0] ?? nodes.find((m) => fresh(m)) ?? nodes[0];
  return pick ? installKey(pick) : undefined;
}

/** A sample as the executor sends it (§15.3); the Deployer keeps the body as it is (step 2 takes it apart). */
export interface ServiceSample { service: string; member: string; at: string; [k: string]: unknown }

type Instance = Record<string, any>;

/** What the discovery a member came from said about its installation (cached per job: a finished job does not change). */
function discovered(store: Store, cache: Map<string, Instance[]>, m: ServiceMember): Instance | undefined {
  const job = m.discovery?.job;
  if (!job) return undefined;
  if (!cache.has(job)) {
    const result = store.executorJob(job)?.status?.result as { instances?: Instance[] } | undefined;
    cache.set(job, Array.isArray(result?.instances) ? result!.instances : []);
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
  }
  return cache.get(job)!.find((i) => discoveredKey({ host: m.host, instance: i }) === installKey(m));
}

const jobs = new Map<string, Instance[]>();

/** The watch list of one host's service executor. groupsOf: the registered groups of a service (registeredGroups;
 *  tests give their own). */
export function watchList(store: Store, host: string, groupsOf: (service: string) => string[] | undefined = (s) => registeredGroups(store, s), now = Date.now()): WatchEntry[] {
  const entry = (service: string, kind: WatchEntry["kind"], profile: string, m: ServiceMember, reader?: string): WatchEntry => {
    const d = discovered(store, jobs, m);
    const httpsHost = d?.properties?.["nifi.web.https.host"];
    const logs = d?.storage?.logs?.path;
    const groups = groupsOf(service);
    return {
      service, kind, member: installKey(m), profile, installDir: m.installDir, confDir: confDirOf(m),
      https: { host: typeof httpsHost === "string" ? httpsHost : null, port: m.ports?.https ?? null },
      nodeAddress: m.nodeAddress ?? null, logDir: typeof logs === "string" ? logs : null,
      files: store.serviceMemberFiles(service).filter((f) => f.member === installKey(m)).map((f) => ({ name: f.file, path: f.path })),
      flowHistory: !store.hasFlowCounts(service),
      ...(groups ? { groups: reader === undefined || reader === installKey(m) ? groups.map((id) => ({ id })) : [] } : {}),
    };
  };
  return [
    ...store.standalones().filter((s) => s.member.host === host).map((s) => entry(s.id, "standalone", s.profile, s.member)),
    ...store.clusters().flatMap((c) => {
      const mine = c.nodes.filter((n) => n.host === host);
      const reader = mine.length && groupsOf(c.id) ? groupsReader(store, c.id, c.nodes, now) : undefined;
      return mine.map((n) => entry(c.id, "node", c.profile, n, reader));
    }),
  ];
}

export const SAMPLES_PER_POST = 20;

/** The samples of one POST /executor/v1/samples that belong to what the host watches; the rest are counted as dropped. */
export function acceptSamples(watch: WatchEntry[], body: unknown): { accepted: ServiceSample[]; dropped: number } | { error: string } {
  const samples = (body as { samples?: unknown })?.samples;
  if (!Array.isArray(samples)) return { error: "The body is {samples: [...]}." };
  if (samples.length > SAMPLES_PER_POST) return { error: `At most ${SAMPLES_PER_POST} samples per request.` };
  const known = new Set(watch.map((w) => `${w.service}\0${w.member}`));
  const accepted = samples.filter((s): s is ServiceSample =>
    Boolean(s) && typeof s === "object" && typeof s.service === "string" && typeof s.member === "string" && typeof s.at === "string"
    && !Number.isNaN(Date.parse(s.at)) && known.has(`${s.service}\0${s.member}`));
  return { accepted, dropped: samples.length - accepted.length };
}
