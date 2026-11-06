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

/** The watch list of one host's service executor. */
export function watchList(store: Store, host: string): WatchEntry[] {
  const entry = (service: string, kind: WatchEntry["kind"], profile: string, m: ServiceMember): WatchEntry => {
    const d = discovered(store, jobs, m);
    const httpsHost = d?.properties?.["nifi.web.https.host"];
    const logs = d?.storage?.logs?.path;
    return {
      service, kind, member: installKey(m), profile, installDir: m.installDir, confDir: confDirOf(m),
      https: { host: typeof httpsHost === "string" ? httpsHost : null, port: m.ports?.https ?? null },
      nodeAddress: m.nodeAddress ?? null, logDir: typeof logs === "string" ? logs : null,
    };
  };
  return [
    ...store.standalones().filter((s) => s.member.host === host).map((s) => entry(s.id, "standalone", s.profile, s.member)),
    ...store.clusters().flatMap((c) => c.nodes.filter((n) => n.host === host).map((n) => entry(c.id, "node", c.profile, n))),
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
