// Service ops §9.2, §15.3; pages-rethink C1 (step 3a): the machine light. Six checks (ops-types MachineCheck) run in the
// Deployer, not on the hosts (they look across a cluster's nodes, the thresholds are in the database): after each batch
// of samples is taken in, and once a minute (an executor gone silent sends nothing). A check holds or not for a member
// (a node, a standalone's installation) or for the whole service (member "*": the coordinator, versions across the
// nodes). Each check and member has at most one open alert, resolved when the check no longer holds; a check that
// cannot tell (no fresh sample) leaves its alert as it is. Opening, a new level and resolving go on the timeline
// (service_events), with what the samples show changed: a node disconnecting and reconnecting (the coordinator's view),
// the process restarting (its start time), the version changing; and the machine light turning red (machine-red) and
// back (machine-recovered), which step 5 starts an analysis from.
//
// C1: process (a standalone's process gone, any cluster node disconnected) failing; disk (the three repositories' disks)
// 85 % attention, 95 % failing; heap 85 % for 10 minutes attention, OutOfMemoryError in the log failing; certificate
// 30 days attention, 7 days or expired failing, unreadable unknown; coordinator (no primary node or coordinator)
// failing; collection (nothing collected for 5 minutes) unknown. P2 (§10.3): ZooKeeper errors are the coordinator's
// attention, differing versions the process's; configuration drift keeps its alert (the timeline and the configuration
// summary read it) but is no check and does not light. Queues are the business light's (stuck), not the machine's.

import type { ExecutorInfo } from "../handoff.ts";
import type { AlertLevel, ServiceAlert, Store } from "../store.ts";
import type { Thresholds } from "./profiles.ts";
import { serviceStatus, thresholdsOf, type MemberStatus, type ServiceStatus } from "./status.ts";
import { bucketOf } from "./logs.ts";
import { memberDrift } from "./configdrift.ts";
import { LIGHT_ORDER, type Light, type MachineCheck } from "./ops-types.ts";

/** The six checks and configuration drift (an alert, not a check: P2). */
export type RuleId = MachineCheck | "config-drift";
/** The rows of the machine light, in this order. */
export const MACHINE_CHECKS: readonly MachineCheck[] = ["process", "disk", "heap", "certificate", "coordinator", "collection"];

/** What each rule watches; scope: per member or for the whole service (process: per member, and "*" for versions). */
export const RULES: Record<RuleId, { label: string; scope: "member" | "service"; levels: AlertLevel[]; description: string }> = {
  process: { label: "Process", scope: "member", levels: ["WARN", "CRIT"], description: "Failing: the newest sample found no NiFi process for this installation, or a cluster node is disconnected (or disconnecting, offloaded) in the coordinator's view. Attention: the cluster's running nodes report different NiFi versions (member *)." },
  disk: { label: "Disk", scope: "member", levels: ["WARN", "CRIT"], description: "The fullest disk of the FlowFile, content and provenance repositories: attention from the warning threshold, failing from the critical one." },
  heap: { label: "Heap", scope: "member", levels: ["WARN", "CRIT"], description: "Attention: the JVM heap has stayed above the threshold for the threshold minutes. Failing: nifi-app.log has an OutOfMemoryError within the window and the process has not started again since." },
  certificate: { label: "Certificate", scope: "member", levels: ["WARN", "CRIT"], description: "The soonest-expiring certificate of the keystore, the truststore or the monitor certificate: attention within the warning days, failing within the critical days or expired. A store that cannot be read is unknown." },
  coordinator: { label: "Coordinator", scope: "service", levels: ["WARN", "CRIT"], description: "Failing: no node of the cluster is the primary node or the cluster coordinator in the newest view. Attention: messages about the ZooKeeper connection keep coming (bulletins and nifi-app.log's WARN/ERROR summary, at least the threshold within the window). A standalone is always healthy." },
  collection: { label: "Collection", scope: "member", levels: ["WARN"], description: "Unknown: nothing has been collected of the member for the threshold minutes (the service executor offline, no sample, or NiFi's REST API not readable: no monitor certificate, unreachable, the node not in NiFi's list). The machine light is unknown then, unless a check is failing." },
  "config-drift": { label: "Configuration drift", scope: "member", levels: ["WARN"], description: "A configuration file on the host is not what the Deployer says it should be: someone or NiFi changed or removed it. Not part of the machine light (P2): the configuration summary shows it." },
};

/** Each threshold: what it is, its unit and bounds; rule: the check it belongs to. */
export const THRESHOLDS: Record<keyof Thresholds, { label: string; unit: string; min: number; max: number; rule: RuleId; description: string }> = {
  collectionMinutes: { label: "Collection gap", unit: "min", min: 1, max: 60, rule: "collection", description: "How long nothing may be collected of a member before the machine light is unknown." },
  repoDiskWarnPct: { label: "Repository disk attention", unit: "%", min: 1, max: 100, rule: "disk", description: "A repository's disk this full needs attention." },
  repoDiskCritPct: { label: "Repository disk failing", unit: "%", min: 1, max: 100, rule: "disk", description: "This full is failing; above the attention threshold." },
  heapPct: { label: "Heap above", unit: "%", min: 1, max: 100, rule: "heap", description: "The heap use (of its maximum) that counts as high." },
  heapMinutes: { label: "Heap high for", unit: "min", min: 0, max: 1440, rule: "heap", description: "How long the heap must stay above it (a full GC usually brings it down)." },
  oomMinutes: { label: "OutOfMemoryError window", unit: "min", min: 1, max: 1440, rule: "heap", description: "How far back an OutOfMemoryError in nifi-app.log counts (until the process starts again)." },
  zkErrors: { label: "ZooKeeper errors", unit: "count", min: 1, max: 10000, rule: "coordinator", description: "How many ZooKeeper connection messages within the window need attention." },
  zkMinutes: { label: "ZooKeeper error window", unit: "min", min: 1, max: 1440, rule: "coordinator", description: "The window they are counted over." },
  certWarnDays: { label: "Certificate attention", unit: "days", min: 1, max: 3650, rule: "certificate", description: "A certificate expiring within this many days needs attention." },
  certCritDays: { label: "Certificate failing", unit: "days", min: 0, max: 3650, rule: "certificate", description: "Within this many days (or expired) it is failing; below the attention threshold." },
};

/** What a check found for a member ("*": the service). */
export interface Condition { rule: RuleId; member: string; light: Exclude<Light, "healthy">; text: string; detail: Record<string, unknown> }
/** Why a check could not tell: blind (no fresh reading) or a change is working on the member. */
export type HoldReason = "blind" | "change";

/** An alert's level: failing is CRIT; attention and unknown are WARN (the light is kept in the detail). */
export const levelOf = (light: Light): AlertLevel => (light === "failing" ? "CRIT" : "WARN");
/** An alert's light: its detail's, else from the level (alerts from before C1). */
export const lightOfAlert = (a: Pick<ServiceAlert, "level" | "detail">): Exclude<Light, "healthy"> => {
  const l = a.detail.light;
  return l === "failing" || l === "attention" || l === "unknown" ? l : a.level === "CRIT" ? "failing" : "attention";
};
const worse = (a: Light, b: Light): Light => (LIGHT_ORDER[a] <= LIGHT_ORDER[b] ? a : b);

const DOWN = new Set(["DISCONNECTED", "DISCONNECTING", "OFFLOADED", "OFFLOADING"]);
/** The REST readings that leave the NiFi side blind (partial still reads most of it). */
const REST_BLIND = new Set(["unreachable", "no-certificate", "no-https"]);
const ZK = /zookeeper|curator|connectionloss|keeperexception/i;
/** In the log summary NiFi abbreviates the logger (o.a.z.ClientCnxn is ZooKeeper's client). */
const ZK_LOG = /zookeeper|curator|connectionloss|keeperexception|\bo\.a\.z\.|ClientCnxn/i;
const OOM = /OutOfMemoryError/;
const MIN = 60_000, DAY = 86_400_000, BUCKET_MS = 5 * MIN;
const keyOf = (rule: string, member: string) => `${rule}\0${member}`;
const fact = (member: string, key: string) => `${member}\0${key}`;

/** The times a service's changes took, from their start to their end (one not closed yet: to now), that reach into [from, to] (ms). */
export function changeWindows(store: Store, service: string, from: number, to: number): [number, number][] {
  return store.serviceChanges(service, 50)
    .map((c) => [Date.parse(c.createdAt), c.finishedAt ? Date.parse(c.finishedAt) : to] as [number, number])
    .filter(([a, b]) => a <= to && b >= from);
}

/** How a member is named in alerts and on the timeline: a node by address and port, a standalone by host. */
export const memberName = (s: Pick<ServiceStatus, "kind">, m: Pick<MemberStatus, "host" | "nodeAddress" | "ports">) =>
  s.kind === "cluster" ? `${m.nodeAddress ?? m.host}:${m.ports.https ?? m.ports.http ?? "?"}` : m.host;

/** Since when the newest run of points meeting a test lasts: null when the newest does not (or there is none). */
export function heldSince<T extends { at: string }>(points: T[], test: (p: T) => boolean | null): { since: string; latest: T } | null {
  if (!points.length) return null;
  const latest = points[points.length - 1]!;
  if (test(latest) !== true) return null;
  let since = latest.at;
  for (let i = points.length - 2; i >= 0 && test(points[i]!) === true; i--) since = points[i]!.at;
  return { since, latest };
}

/** What check() remembers between runs (service_facts): since when each member's executor is online, and since when its REST API is blind. */
export interface Since { online: Map<string, string>; restBlind: Map<string, string> }
const noSince = (): Since => ({ online: new Map(), restBlind: new Map() });
const sinceFromFacts = (store: Store, s: ServiceStatus): Since => {
  const facts = store.serviceFacts(s.id);
  const out = noSince();
  for (const m of s.members) {
    const o = facts.get(fact(m.key, "onlineSince")); if (o) out.online.set(m.key, o);
    const r = facts.get(fact(m.key, "restBlindSince")); if (r) out.restBlind.set(m.key, r);
  }
  return out;
};
/** A member's NiFi side cannot be read although the process runs: why, or null. */
const restBlind = (m: MemberStatus): string | null => {
  const live = m.live;
  if (!live || live.running !== true) return null;
  if (live.nifi && REST_BLIND.has(live.nifi)) return live.nifi === "no-certificate" ? "the service executor has no monitor certificate" : `NiFi's REST API is ${live.nifi === "no-https" ? "not on HTTPS" : "unreachable"}`;
  if (live.point && live.point._unmatched) return "the member is not in NiFi's node list";
  return null;
};

/** The checks over one service's status (and its samples, logs, bulletins, certificates): what holds, and which checks cannot tell (and why). */
export function evaluate(store: Store, s: ServiceStatus, t: Thresholds, now: Date, since: Since = noSince()): { active: Condition[]; held: Map<string, HoldReason> } {
  const found = new Map<string, Condition>();
  const held = new Map<string, HoldReason>();
  const nowMs = now.getTime();
  const iso = (ms: number) => new Date(ms).toISOString();
  const period = s.summary.period;
  const gap = t.collectionMinutes * MIN;
  // Two findings of one check and member are one condition: the worse light, both texts, both details.
  const add = (rule: RuleId, member: string, light: Condition["light"], text: string, detail: Record<string, unknown> = {}) => {
    const key = keyOf(rule, member);
    const was = found.get(key);
    if (!was) { found.set(key, { rule, member, light, text, detail }); return; }
    const first = LIGHT_ORDER[light] < LIGHT_ORDER[was.light];
    found.set(key, { rule, member, light: worse(was.light, light) as Condition["light"], text: first ? `${text}; ${was.text}` : `${was.text}; ${text}`, detail: { ...was.detail, ...detail } });
  };
  const hold = (rule: RuleId, member: string, why: HoldReason) => { const k = keyOf(rule, member); if (held.get(k) !== "change") held.set(k, why); };
  const cluster = s.kind === "cluster";
  const memberFiles = store.serviceMemberFiles(s.id);
  // §16.3 no. 8: the member a change is working on is expected to look down, and in a full change (S31) every member and
  // the cluster as a whole. Until the change is closed (step 14b: paused and stopped too), not only while it runs: a person
  // is already on it, and closing it judges them again.
  const change = store.activeServiceChange(s.id) ?? null;
  const whole = change?.mode === "full";
  const working = new Set<string | null>(whole ? s.members.map((m) => m.key) : [change?.currentMember ?? null]);

  for (const m of s.members) {
    const name = memberName(s, m);
    const k = m.key;
    const base = { label: name };
    const busy = working.has(k);
    const fresh = m.source === "samples" && (m.state === "running" || m.state === "stopped");
    // Collection: the executor offline, no sample, or the NiFi side blind, for the gap (shorter: cannot tell yet).
    if (busy) hold("collection", k, "change");
    else if (m.state === "lost") {
      const age = m.executor.ageSeconds === undefined ? Infinity : m.executor.ageSeconds * 1000;
      if (age >= gap) add("collection", k, "unknown", `${name}: ${m.executor.reason ?? "the service executor is offline"}`, { ...base, why: "executor-lost", ageSeconds: m.executor.ageSeconds ?? null });
      else hold("collection", k, "blind");
    } else if (!fresh) {
      const last = m.source === "samples" ? (m.live?.at ?? m.asOf) : null;
      const from = last ?? since.online.get(k) ?? null;
      if (from && nowMs - Date.parse(from) >= gap) add("collection", k, "unknown", `${name}: ${last ? `no sample since ${last}` : "no sample yet"}`, { ...base, why: "no-samples", asOf: last });
      else hold("collection", k, "blind");
    } else {
      const why = restBlind(m);
      const from = since.restBlind.get(k);
      if (why && from && nowMs - Date.parse(from) >= gap) add("collection", k, "unknown", `${name}: ${why}`, { ...base, why: "rest", nifi: m.live?.nifi ?? null });
      else if (why) hold("collection", k, "blind");
    }
    // What the samples say, only from a fresh one with NiFi's side readable.
    const live = fresh ? m.live : null;
    if (!live) for (const r of ["process", "heap", "disk"] as const) hold(r, k, busy ? "change" : "blind");
    if (live) {
      if (live.running === false && busy) hold("process", k, "change");
      else if (live.running === false) add("process", k, "failing", `${name}: no NiFi process at ${live.at}`, { ...base, at: live.at, why: "process-down" });
      const blindRest = live.running === true && restBlind(m) !== null;
      if (live.running !== true || blindRest) { hold("heap", k, "blind"); hold("disk", k, "blind"); }
      else {
        const p = live.point ?? {};
        if (typeof p.heapPct !== "number") hold("heap", k, "blind");
        else {
          const points = store.memberPoints(s.id, k, iso(nowMs - t.heapMinutes * MIN - 3 * period * 1000), iso(nowMs + 1000));
          const run = heldSince(points, (x) => (typeof x.point.heapPct === "number" ? x.point.heapPct >= t.heapPct : null));
          if (run && nowMs - Date.parse(run.since) >= t.heapMinutes * MIN) add("heap", k, "attention", `${name}: heap ${p.heapPct} % (above ${t.heapPct} % since ${run.since})`, { ...base, heapPct: p.heapPct, since: run.since });
        }
        const repos = (["repoFlowfilePct", "repoContentPct", "repoProvenancePct"] as const).map((f) => [f, p[f]] as const).filter((x): x is readonly [typeof x[0], number] => typeof x[1] === "number");
        if (!repos.length) hold("disk", k, "blind");
        else {
          const [field, full] = repos.reduce((a, b) => (b[1] > a[1] ? b : a));
          const light = full >= t.repoDiskCritPct ? "failing" : full >= t.repoDiskWarnPct ? "attention" : null;
          const which = field === "repoFlowfilePct" ? "FlowFile" : field === "repoContentPct" ? "content" : "provenance";
          if (light) add("disk", k, light, `${name}: the ${which} repository's disk is ${full} % full`, { ...base, repository: which, pct: full });
        }
      }
    }
    // OutOfMemoryError in nifi-app.log within the window, and the process not started again since (the log is read apart
    // from the samples, so it counts even when the sample is old).
    const oomFrom = iso(nowMs - t.oomMinutes * MIN);
    const started = m.live?.startedAt ? Date.parse(m.live.startedAt) : null;
    const oom = store.serviceLogPatterns(s.id, { since: oomFrom, member: k, limit: 1000 })
      .filter((x) => x.count > 0 && OOM.test(`${x.template} ${x.exception ?? ""}`) && (started === null || Date.parse(x.lastAt) > started));
    if (oom.length) {
      const newest = oom.reduce((a, b) => (b.lastAt > a.lastAt ? b : a));
      add("heap", k, "failing", `${name}: OutOfMemoryError in nifi-app.log at ${newest.lastAt}${oom.length > 1 || newest.count > 1 ? ` (${oom.reduce((n, x) => n + x.count, 0)} times in ${t.oomMinutes} min)` : ""}`, { ...base, oomAt: newest.lastAt, oomCount: oom.reduce((n, x) => n + x.count, 0) });
    }
    // A cluster node's connection, in the coordinator's view (none: cannot tell).
    if (cluster) {
      const c = m.live?.connection ?? null;
      if (busy) hold("process", k, "change");
      else if (!c) hold("process", k, "blind");
      else if (DOWN.has(c)) add("process", k, "failing", `${name} is ${c.toLowerCase()} in the coordinator's view`, { ...base, connection: c });
    }
    // Certificates: the newest reading of each (kept apart from the samples, so they count even when the sample is old).
    const certs = s.certs.filter((c) => c.member === k);
    let soonest: (typeof certs)[number] | undefined;
    for (const c of certs) if (c.notAfter && (!soonest || c.notAfter < soonest.notAfter!)) soonest = c;
    if (soonest) {
      const days = Math.floor((Date.parse(soonest.notAfter!) - nowMs) / DAY);
      const light = days < 0 || days <= t.certCritDays ? "failing" : days <= t.certWarnDays ? "attention" : null;
      const what = `${soonest.subject ?? soonest.alias ?? "a certificate"} (${soonest.store})`;
      if (light) add("certificate", k, light, `${name}: ${what} ${days < 0 ? `expired ${-days} days ago` : `expires in ${days} days`}, ${soonest.notAfter}`, { ...base, store: soonest.store, subject: soonest.subject, notAfter: soonest.notAfter, days });
    }
    const unreadable = certs.filter((c) => c.error);
    if (unreadable.length) add("certificate", k, "unknown", `${name}: ${unreadable.map((c) => `${c.store}: ${c.error}`).join("; ")}`, { ...base, stores: unreadable.map((c) => ({ store: c.store, error: c.error })) });
    // §16.3: the fingerprints. Names only here: this goes on the timeline, and from there to the AI. Not a check (P2).
    const drift = memberDrift(m, memberFiles);
    if (drift.state === "unknown" || busy) hold("config-drift", k, busy ? "change" : "blind");
    else if (drift.state === "drift") {
      const off = drift.files.filter((f) => f.state === "changed" || f.state === "missing");
      add("config-drift", k, "attention", `${name}: ${off.map((f) => `${f.name}${f.state === "missing" ? " (gone)" : ""}`).join(", ")} on the host ${off.length > 1 ? "are" : "is"} not what is kept`, { ...base, files: off.map((f) => f.name) });
    }
  }

  // The whole service: the primary node and the coordinator (P2: and ZooKeeper), and the versions (P2: the process's).
  if (cluster) {
    const viewed = s.members.filter((m) => m.live?.connection);
    if (whole) hold("coordinator", "*", "change");
    else if (!viewed.length) hold("coordinator", "*", "blind");
    else {
      const roles = new Set(viewed.flatMap((m) => m.live!.roles));
      const missing = [...(roles.has("Primary Node") ? [] : ["primary node"]), ...(roles.has("Cluster Coordinator") ? [] : ["cluster coordinator"])];
      if (missing.length) add("coordinator", "*", "failing", `No node is the ${missing.join(" or the ")} in the newest view`, { missing });
    }
    const versions = [...new Set(s.members.filter((m) => m.source === "samples" && m.state === "running" && m.live?.version).map((m) => m.live!.version!))];
    if (versions.length > 1) add("process", "*", "attention", `The nodes run ${versions.join(" and ")}`, { versions });
    // Step 14b: what a change's own stops and starts make NiFi log about ZooKeeper (forming and the stable time included) is
    // not counted; a 5-minute bucket that touches a change's time counts as the change's.
    const zkFrom = iso(nowMs - t.zkMinutes * MIN);
    const windows = changeWindows(store, s.id, Date.parse(bucketOf(zkFrom)), nowMs);
    const inChange = (from: number, to: number) => windows.some(([a, b]) => from <= b && to >= a);
    const zk = store.serviceBulletins(s.id, { from: zkFrom, limit: 1000 }).filter((b) => b.level !== "INFO" && b.level !== "DEBUG" && ZK.test(b.message ?? "") && !inChange(Date.parse(b.at), Date.parse(b.at)));
    // And nifi-app.log's WARN/ERROR summary (5-minute counts: the window is widened to whole buckets).
    const logs = store.serviceLogCounts(s.id, bucketOf(zkFrom))
      .filter((c) => c.level !== "INFO" && c.level !== "DEBUG" && ZK_LOG.test(`${c.logger ?? ""} ${c.template} ${c.exception ?? ""}`))
      .filter((c) => !inChange(Date.parse(c.bucket), Date.parse(c.bucket) + BUCKET_MS - 1));
    const fromLogs = logs.reduce((n, c) => n + c.count, 0);
    if (!whole && zk.length + fromLogs >= t.zkErrors) {
      const newest = logs.length ? logs[logs.length - 1]! : null;
      const example = zk[0]?.message ?? (newest ? `${newest.logger ?? ""} ${newest.template}` : "");
      add("coordinator", "*", "attention", `${zk.length + fromLogs} ZooKeeper connection messages in ${t.zkMinutes} min (${zk.length} bulletins, ${fromLogs} in nifi-app.log; e.g. ${example.slice(0, 200)})`, { count: zk.length + fromLogs, bulletins: zk.length, log: fromLogs, minutes: t.zkMinutes });
    }
  }
  return { active: [...found.values()], held };
}

// --- The machine light (§10.2.2 MachineLightView): six rows, each its light and a plain sentence's material.

export interface MachineCheckRow { check: MachineCheck; light: Light; text: string; member: string | null; since: string | null }
export interface MachineLightView {
  light: Light; sentence: string; asOf: string;
  checks: MachineCheckRow[];
  members: { key: string; label: string; state: string; connection: string | null }[];
}

/** The light over the six rows: any failing is failing; else collection unknown is unknown; else any attention; else healthy.
 *  Another row that cannot tell (a store unreadable, a member blind) shows unknown on its row only. */
export function overallLight(rows: Pick<MachineCheckRow, "check" | "light">[]): Light {
  if (rows.some((r) => r.light === "failing")) return "failing";
  if (rows.some((r) => r.check === "collection" && r.light === "unknown")) return "unknown";
  if (rows.some((r) => r.light === "attention")) return "attention";
  return "healthy";
}

const pct = (v: number) => `${Math.round(v * 10) / 10} %`;

/** A healthy row's sentence: what was looked at. */
function fineText(check: MachineCheck, s: ServiceStatus, now: Date): string {
  const run = s.members.filter((m) => m.live?.running === true);
  const named = (m: MemberStatus) => (s.members.length > 1 ? `${memberName(s, m)} ` : "");
  switch (check) {
    case "process": return s.kind === "cluster" ? `All ${s.members.length} nodes running and connected` : "Running";
    case "disk": {
      let best: { m: MemberStatus; v: number; which: string } | null = null;
      for (const m of run) for (const [f, which] of [["repoFlowfilePct", "FlowFile"], ["repoContentPct", "content"], ["repoProvenancePct", "provenance"]] as const) {
        const v = m.live?.point?.[f];
        if (typeof v === "number" && (!best || v > best.v)) best = { m, v, which };
      }
      return best ? `Fullest: ${named(best.m)}${best.which} repository ${pct(best.v)}` : "Repository disks fine";
    }
    case "heap": {
      let best: { m: MemberStatus; v: number } | null = null;
      for (const m of run) { const v = m.live?.point?.heapPct; if (typeof v === "number" && (!best || v > best.v)) best = { m, v }; }
      return best ? `Highest: ${named(best.m)}heap ${pct(best.v)}` : "Heap fine";
    }
    case "certificate": {
      const soonest = s.certs.filter((c) => c.notAfter).sort((a, b) => (a.notAfter! < b.notAfter! ? -1 : 1))[0];
      return soonest ? `Soonest expires in ${Math.floor((Date.parse(soonest.notAfter!) - now.getTime()) / DAY)} days` : "No certificate read";
    }
    case "coordinator": return s.kind === "cluster" ? "Primary node and coordinator present" : "Standalone: no cluster roles";
    case "collection": {
      const at = s.members.map((m) => m.live?.at).filter((x): x is string => !!x).sort()[0];
      return at ? `Up to date (oldest sample ${Math.max(0, Math.round((now.getTime() - Date.parse(at)) / 1000))} s old)` : "Up to date";
    }
  }
}

/** The machine light of one service from the checks' result and its open alerts (a check that cannot tell keeps its open alert's light). */
export function machineView(s: ServiceStatus, result: ReturnType<typeof evaluate>, open: ServiceAlert[], now: Date): MachineLightView {
  const openBy = new Map(open.map((a) => [keyOf(a.rule, a.member), a] as const));
  const label = (member: string) => { if (member === "*") return null; const m = s.members.find((x) => x.key === member); return m ? memberName(s, m) : member; };
  const rows: MachineCheckRow[] = MACHINE_CHECKS.map((check) => {
    const now_: { light: Condition["light"]; text: string; member: string; since: string | null }[] = [];
    for (const c of result.active) if (c.rule === check) now_.push({ light: c.light, text: c.text, member: c.member, since: openBy.get(keyOf(c.rule, c.member))?.openedAt ?? null });
    for (const a of open) {
      const key = keyOf(a.rule, a.member);
      if (a.rule === check && result.held.has(key) && !result.active.some((c) => keyOf(c.rule, c.member) === key)) now_.push({ light: lightOfAlert(a), text: String(a.detail.text ?? ""), member: a.member, since: a.openedAt });
    }
    if (now_.length) {
      now_.sort((a, b) => LIGHT_ORDER[a.light] - LIGHT_ORDER[b.light] || ((a.since ?? "") < (b.since ?? "") ? -1 : 1));
      const top = now_[0]!;
      return { check, light: top.light, text: `${top.text}${now_.length > 1 ? ` (+${now_.length - 1} more)` : ""}`, member: top.member === "*" ? null : top.member, since: top.since };
    }
    const blind = [...result.held].filter(([k, why]) => why === "blind" && k.startsWith(`${check}\0`)).map(([k]) => k.slice(check.length + 1));
    // Collection blind for less than the gap is not unknown yet (C1: over 5 minutes).
    if (blind.length && check === "collection") return { check, light: "healthy", text: `Waiting for the next reading of ${blind.map((m) => label(m) ?? "the cluster").join(", ")}`, member: null, since: null };
    if (blind.length) return { check, light: "unknown", text: `Cannot tell: no fresh reading of ${blind.map((m) => label(m) ?? "the cluster").join(", ")}`, member: blind.length === 1 && blind[0] !== "*" ? blind[0]! : null, since: null };
    const busy = [...result.held].filter(([k, why]) => why === "change" && k.startsWith(`${check}\0`)).map(([k]) => k.slice(check.length + 1));
    if (busy.length) return { check, light: "healthy", text: `A change is working on ${busy.map((m) => label(m) ?? "the cluster").join(", ")}`, member: null, since: null };
    return { check, light: "healthy", text: fineText(check, s, now), member: null, since: null };
  });
  const light = overallLight(rows);
  const lead = rows.find((r) => r.light === light && (light !== "unknown" || r.check === "collection"));
  const sentence = light === "healthy" ? "All six machine checks are fine."
    : `${light === "failing" ? "Failing" : light === "unknown" ? "Not known" : "Needs attention"}: ${lead?.text ?? ""}`;
  return {
    light, sentence, asOf: now.toISOString(), checks: rows,
    members: s.members.map((m) => ({ key: m.key, label: memberName(s, m), state: m.state, connection: m.live?.connection ?? null })),
  };
}

/** The machine light of one service as it is now (no alert is opened or closed: check() does that). */
export function machineLight(store: Store, executor: (host: string) => ExecutorInfo, id: string, now: Date = new Date()): MachineLightView | undefined {
  const s = serviceStatus(store, executor, id, now);
  if (!s) return undefined;
  return machineOf(store, s, thresholdsOf(store, id, s.profile).effective, now);
}
const machineOf = (store: Store, s: ServiceStatus, t: Thresholds, now: Date, result = evaluate(store, s, t, now, sinceFromFacts(store, s))) =>
  machineView(s, result, store.serviceAlerts({ service: s.id, state: "open", limit: 1000 }), now);

/** A machine light change check() put on the timeline: machine-red (from any other light to failing) or machine-recovered. */
export interface MachineTurn { service: string; kind: "machine-red" | "machine-recovered"; from: Light; to: Light; at: string; text: string }
export interface CheckResult { opened: number; changed: number; resolved: number; events: number; turns: MachineTurn[] }

/** Runs the checks over one service: opens, updates and resolves its alerts, writes what changed on the timeline, and the machine light's turn. */
export function check(store: Store, executor: (host: string) => ExecutorInfo, id: string, now: Date = new Date()): CheckResult | undefined {
  const s = serviceStatus(store, executor, id, now);
  if (!s) return undefined;
  const at = now.toISOString();
  const out: CheckResult = { opened: 0, changed: 0, resolved: 0, events: 0, turns: [] };
  // Since when each member's executor is online, and its REST API blind (facts, so a restart of the Deployer keeps them).
  const facts = store.serviceFacts(id);
  const since = noSince();
  for (const m of s.members) {
    const remember = (key: string, value: string | null, into: Map<string, string>) => {
      const was = facts.get(fact(m.key, key)) ?? null;
      const now_ = value === null ? null : was ?? value;
      if (now_ !== was) store.setServiceFact(id, m.key, key, now_);
      if (now_) into.set(m.key, now_);
    };
    remember("onlineSince", m.executor.online ? at : null, since.online);
    const fresh = m.source === "samples" && (m.state === "running" || m.state === "stopped");
    // Only a fresh sample says the REST API is readable again; without one the blind time goes on.
    const blind = fresh ? (restBlind(m) ? at : null) : (facts.get(fact(m.key, "restBlindSince")) ?? null);
    remember("restBlindSince", blind, since.restBlind);
  }
  const t = thresholdsOf(store, id, s.profile).effective;
  const result = evaluate(store, s, t, now, since);
  const { active, held } = result;
  const open = new Map(store.serviceAlerts({ service: id, state: "open", limit: 1000 }).map((a) => [keyOf(a.rule, a.member), a] as const));
  const seen = new Set<string>();
  for (const c of active) {
    const key = keyOf(c.rule, c.member);
    if (seen.has(key)) continue;
    seen.add(key);
    const level = levelOf(c.light);
    const detail = { ...c.detail, text: c.text, light: c.light };
    const was = open.get(key);
    const label = RULES[c.rule].label;
    if (!was) { if (store.openServiceAlert({ service: id, member: c.member, rule: c.rule, level, detail }, at, { text: `${c.light} ${label}: ${c.text}` }, c.rule === "config-drift" ? "drift-detected" : undefined) !== undefined) out.opened++; }
    else if (was.level !== level || was.detail.text !== c.text || lightOfAlert(was) !== c.light) { store.updateServiceAlert(was.id, level, detail, at, { text: `${c.light} (was ${lightOfAlert(was)}) ${label}: ${c.text}` }); out.changed++; }
  }
  for (const [key, a] of open) {
    if (seen.has(key) || held.has(key)) continue;
    store.resolveServiceAlert(a.id, at, { text: `Resolved: ${RULES[a.rule as RuleId]?.label ?? a.rule}${a.member === "*" ? "" : ` (${String(a.detail.label ?? a.member)})`}` }, a.rule === "config-drift" ? "drift-resolved" : undefined);
    out.resolved++;
  }
  out.events += changes(store, s);
  // The machine light's turn (C1, A1 "red: analyse at once"). The first look only records it (no turn from nothing).
  const view = machineView(s, result, store.serviceAlerts({ service: id, state: "open", limit: 1000 }), now);
  const was = (facts.get(fact("*", "machineLight")) ?? null) as Light | null;
  if (was !== view.light) {
    store.setServiceFact(id, "*", "machineLight", view.light);
    const kind = was && was !== "failing" && view.light === "failing" ? "machine-red" : was === "failing" ? "machine-recovered" : null;
    if (kind) {
      const text = kind === "machine-red" ? view.sentence : `Machine light ${view.light} again (was failing)`;
      const failing = view.checks.filter((r) => r.light === "failing").map((r) => r.check);
      store.addServiceEvent({ service: id, member: null, at, kind, detail: { text, from: was, to: view.light, checks: failing } });
      out.events++;
      out.turns.push({ service: id, kind, from: was!, to: view.light, at, text });
    }
  }
  return out;
}

/** The timeline's own entries from the newest samples: restarts (start time), versions, a node's connection. */
function changes(store: Store, s: ServiceStatus): number {
  const facts = store.serviceFacts(s.id);
  let events = 0;
  // §16.3 no. 8: what a running change does to a member is on the timeline as the change's steps, not twice.
  const change = store.activeServiceChange(s.id);
  const inChange = change?.state === "running" ? new Set(change.mode === "full" ? s.members.map((m) => m.key) : [change.currentMember, ...((change.progress as { done?: string[] }).done ?? [])]) : new Set<string | null>();
  const event = (m: MemberStatus, at: string, kind: string, detail: Record<string, unknown>) => {
    if (inChange.has(m.key) && kind !== "version-changed") return;
    store.addServiceEvent({ service: s.id, member: m.key, at, kind, detail });
    events++;
  };
  for (const m of s.members) {
    const live = m.live;
    if (!live || m.source !== "samples") continue;
    const name = memberName(s, m);
    const was_ = (key: string) => facts.get(fact(m.key, key));
    if (live.startedAt) {
      const was = was_("startedAt");
      if (was !== undefined && was !== null && was !== live.startedAt) event(m, live.startedAt, "process-restarted", { text: `${name}: NiFi started again (pid ${live.pid ?? "?"}; the previous process started ${was})`, startedAt: live.startedAt, was, pid: live.pid });
      if (was !== live.startedAt) store.setServiceFact(s.id, m.key, "startedAt", live.startedAt);
    }
    if (live.version) {
      const was = was_("version");
      if (was !== undefined && was !== null && was !== live.version) event(m, live.at, "version-changed", { text: `${name}: version ${was} → ${live.version}`, from: was, to: live.version });
      if (was !== live.version) store.setServiceFact(s.id, m.key, "version", live.version);
    }
    const c = live.connection;
    const now = c === "CONNECTED" ? "up" : c && DOWN.has(c) ? "down" : null;
    if (now) {
      const was = was_("connection");
      if (now === "down" && was !== "down") event(m, live.at, "node-disconnected", { text: `${name} ${c!.toLowerCase()} (the coordinator's view)`, connection: c });
      if (now === "up" && was === "down") event(m, live.at, "node-reconnected", { text: `${name} connected to the cluster again`, connection: c });
      if (was !== now) store.setServiceFact(s.id, m.key, "connection", now);
    }
  }
  return events;
}

/** The minute's check over every registered service; one failing does not stop the rest. onTurn: each machine light turn
 *  (step 5 starts an analysis from machine-red; until then nothing listens and the timeline keeps it). */
export function checkAll(store: Store, executor: (host: string) => ExecutorInfo, now: Date = new Date(), onTurn?: (turn: MachineTurn) => void): CheckResult {
  const total: CheckResult = { opened: 0, changed: 0, resolved: 0, events: 0, turns: [] };
  for (const id of [...store.standalones().map((x) => x.id), ...store.clusters().map((x) => x.id)]) {
    try {
      const r = check(store, executor, id, now);
      if (!r) continue;
      total.opened += r.opened; total.changed += r.changed; total.resolved += r.resolved; total.events += r.events;
      total.turns.push(...r.turns);
      for (const turn of r.turns) try { onTurn?.(turn); } catch (error) { console.error(`machine light ${id}:`, error); }
    } catch (error) { console.error(`service rules ${id}:`, error); }
  }
  return total;
}

/** PUT …/thresholds: the overrides asked for (a key left out or null: the default), checked against the bounds. */
export function parseThresholds(body: unknown, defaults: Thresholds): { overrides: Partial<Thresholds> } | { error: string; details: string[] } {
  const given = (body as { thresholds?: unknown } | null)?.thresholds;
  if (!given || typeof given !== "object" || Array.isArray(given)) return { error: "The body is { thresholds: { name: number | null } }.", details: Object.keys(THRESHOLDS) };
  const overrides: Partial<Thresholds> = {};
  const details: string[] = [];
  for (const [k, v] of Object.entries(given)) {
    const info = THRESHOLDS[k as keyof Thresholds];
    if (!info) { details.push(`${k}: no such threshold`); continue; }
    if (v === null || v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v < info.min || v > info.max) { details.push(`${k}: a number from ${info.min} to ${info.max}`); continue; }
    if (v !== defaults[k as keyof Thresholds]) overrides[k as keyof Thresholds] = v;
  }
  const t = { ...defaults, ...overrides };
  if (t.certCritDays >= t.certWarnDays) details.push("certCritDays must be below certWarnDays");
  if (t.repoDiskWarnPct >= t.repoDiskCritPct) details.push("repoDiskWarnPct must be below repoDiskCritPct");
  return details.length ? { error: "Some thresholds are not valid.", details } : { overrides };
}

/** An alert as the pages and GET /api/alerts show it. */
export const alertView = (a: ServiceAlert) => ({ ...a, label: RULES[a.rule as RuleId]?.label ?? a.rule, light: lightOfAlert(a), text: String(a.detail.text ?? ""), memberLabel: a.member === "*" ? null : String(a.detail.label ?? a.member) });

// --- S37 step 2 (pages-rethink §4.1): the to-do list, until step 4's service_todos. Every round the checks above are read as
// findings: what is wrong now, since when, the evidence, a template cause and the next actions. Preventive risk is a finding
// only (no alert, no light: C1, "full in days" is the analysis's). Same function for the page and get_service_health (D10).

/** collection-incomplete: never produced any more (the collection check took it over); kept for the old Status page until 6a removes it. */
export type TodoRule = RuleId | "preventive-risk" | "collection-incomplete";
export type Severity = "CRIT" | "WARN" | "INFO";
/** A next step: open-nifi, draft-config, member-control (start/stop), config-diff. Step 3a (§9.2 ⑥): investigate and metrics are gone. */
export interface TodoAction { kind: "open-nifi" | "draft-config" | "member-control" | "config-diff"; label: string; target?: Record<string, unknown> }
export interface Todo { id: string; rule: TodoRule; severity: Severity; since: string; member: string; memberLabel: string | null; evidence: string[]; cause: string; actions: TodoAction[] }

const CAUSES: Record<TodoRule, string> = {
  process: "NiFi is not running here, or the cluster coordinator sees the node as disconnected: it was stopped, crashed (check the log and the OS for an out-of-memory kill), failed to start, or cannot reach the coordinator or ZooKeeper; or the nodes run different versions.",
  disk: "A repository's disk is filling: content is not removed fast enough (long queues, content claims held by a stuck queue) or the data grows with the flow's volume.",
  heap: "The JVM heap stays high or ran out: a flow holds many FlowFiles or attributes in memory, or the heap is too small for the load; a leak shows as a baseline that keeps rising.",
  certificate: "A certificate used by NiFi is expired or about to be, or its store cannot be read: connections that rely on it will fail once it is.",
  coordinator: "The cluster has no primary node or no coordinator, or keeps losing ZooKeeper: the election has not finished, or ZooKeeper is down, overloaded or unreachable.",
  collection: "Nothing is being collected of this member: the service executor or the host is down, the network to the Deployer is cut, or NiFi's REST API cannot be read (monitor certificate, address). The machine light is unknown until it is back.",
  "config-drift": "A configuration file on the host differs from what the Deployer keeps: someone or something edited or removed it.",
  "collection-incomplete": "Replaced by the collection check.",
  "preventive-risk": "A trend, not a fault yet: if it continues, the limit is reached within the time shown.",
};

const nifiLink = (s: ServiceStatus): TodoAction[] => (s.webUrl ? [{ kind: "open-nifi", label: "Open in NiFi", target: { url: s.webUrl } }] : []);
const ACTIONS: Partial<Record<TodoRule, (s: ServiceStatus, member: string, c?: Condition) => TodoAction[]>> = {
  process: (s, m, c) => (m === "*" ? [{ kind: "config-diff", label: "Compare the nodes" }]
    : c?.detail.why === "process-down" ? [{ kind: "member-control", label: "Start", target: { member: m, action: "start" } }]
    : s.kind === "cluster" ? [{ kind: "member-control", label: "Restart", target: { member: m, action: "restart" } }] : []),
  heap: () => [{ kind: "draft-config", label: "Draft a heap change", target: { file: "bootstrap.conf" } }],
  coordinator: (s) => nifiLink(s),
  "config-drift": (_s, m) => [{ kind: "config-diff", label: "See the differences", target: { member: m } }],
};

const ORDER: Record<Severity, number> = { CRIT: 0, WARN: 1, INFO: 2 };
/** Preventive: how far ahead a trend is worth a to-do (days), the window read, and the least history it needs (hours). */
export const PREVENT = { diskDays: 14, diskWarnDays: 3, windowHours: 24, certDays: 90, minHours: 3 };

const lineFit = (xs: number[], ys: number[]) => {
  const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (xs[i]! - mx) ** 2; sxy += (xs[i]! - mx) * (ys[i]! - my); }
  return sxx > 0 ? sxy / sxx : 0;
};

/** The preventive rule over one member's 5-minute summaries of the last day: disk full in N days, heap baseline rising. */
export function preventive(rows: { bucket: string; avg: Record<string, number | null> }[], t: Thresholds): { kind: "disk" | "heap"; severity: Severity; text: string; detail: Record<string, unknown> }[] {
  const out: ReturnType<typeof preventive> = [];
  const series = (f: string) => rows.map((r) => [Date.parse(r.bucket) / 3_600_000, r.avg[f]] as const).filter((x): x is readonly [number, number] => typeof x[1] === "number");
  const hours = (xs: readonly (readonly [number, number])[]) => (xs.length ? xs[xs.length - 1]![0] - xs[0]![0] : 0);
  for (const [f, name] of [["repoFlowfilePct", "FlowFile"], ["repoContentPct", "content"], ["repoProvenancePct", "provenance"]] as const) {
    const xs = series(f);
    if (xs.length < 12 || hours(xs) < PREVENT.minHours) continue;
    const last = xs[xs.length - 1]![1];
    if (last >= t.repoDiskCritPct) continue; // already an alert
    const slope = lineFit(xs.map((x) => x[0]), xs.map((x) => x[1])); // points per hour
    if (slope <= 0.01) continue;
    const days = (100 - last) / slope / 24;
    if (days <= PREVENT.diskDays) out.push({ kind: "disk", severity: days <= PREVENT.diskWarnDays ? "WARN" : "INFO", text: `the ${name} repository's disk (${Math.round(last * 10) / 10} % now) grows ${Math.round(slope * 240) / 10} points a day: full in about ${Math.max(0.1, Math.round(days * 10) / 10)} days`, detail: { repository: name, pct: last, perDay: slope * 24, daysLeft: days } });
  }
  // The heap's baseline: the lowest hourly average, not the peaks (a full GC brings it down to the baseline).
  const heap = series("heapPct");
  if (heap.length >= 12 && hours(heap) >= PREVENT.minHours) {
    const byHour = new Map<number, number>();
    for (const [x, y] of heap) { const h = Math.floor(x); byHour.set(h, Math.min(byHour.get(h) ?? Infinity, y)); }
    const lows = [...byHour].sort((a, b) => a[0] - b[0]);
    if (lows.length >= 3) {
      const slope = lineFit(lows.map((l) => l[0]), lows.map((l) => l[1]));
      const first = lows[0]![1], last = lows[lows.length - 1]![1];
      if (slope >= 0.5 && last - first >= 8 && last >= 40 && last < t.heapPct) {
        const hoursLeft = (t.heapPct - last) / slope;
        out.push({ kind: "heap", severity: hoursLeft <= 24 ? "WARN" : "INFO", text: `the heap's lowest level rose from ${Math.round(first)} % to ${Math.round(last)} % over ${lows.length} hours (${Math.round(slope * 10) / 10} points an hour): it reaches ${t.heapPct} % in about ${Math.round(hoursLeft)} hours`, detail: { from: first, to: last, perHour: slope, hoursLeft } });
      }
    }
  }
  return out;
}

/** The to-do list of a service: the checks' conditions (unknown and attention are WARN, failing CRIT), the preventive risks, worst first. */
export function todos(store: Store, s: ServiceStatus, t: Thresholds, now: Date, result: ReturnType<typeof evaluate> = evaluate(store, s, t, now, sinceFromFacts(store, s))): Todo[] {
  const nowIso = now.toISOString();
  const openSince = new Map(store.serviceAlerts({ service: s.id, state: "open", limit: 1000 }).map((a) => [keyOf(a.rule, a.member), a.openedAt] as const));
  const label = (member: string) => { if (member === "*") return null; const m = s.members.find((x) => x.key === member); return m ? memberName(s, m) : member; };
  const list: Todo[] = [];
  const push = (rule: TodoRule, member: string, severity: Severity, since: string, evidence: string[], c?: Condition) => {
    const was = list.find((x) => x.rule === rule && x.member === member);
    if (was) { was.evidence.push(...evidence); return; }
    list.push({ id: `${rule}:${member}`, rule, severity, since, member, memberLabel: label(member), evidence, cause: CAUSES[rule], actions: ACTIONS[rule]?.(s, member, c) ?? [] });
  };
  for (const c of result.active) push(c.rule, c.member, levelOf(c.light), openSince.get(keyOf(c.rule, c.member)) ?? nowIso, c.text.split("; "), c);
  // Preventive: the 5-minute summaries of the last day per member; the certificates' days.
  const rolls = store.serviceRollups(s.id, new Date(now.getTime() - PREVENT.windowHours * 3_600_000).toISOString(), nowIso);
  for (const m of s.members) {
    const rows = rolls.filter((r) => r.member === m.key).map((r) => ({ bucket: r.bucket, avg: (r.body?.avg ?? {}) as Record<string, number | null> }));
    for (const p of preventive(rows, t)) push("preventive-risk", m.key, p.severity, nowIso, [`${memberName(s, m)}: ${p.text}`]);
    let soonest: (typeof s.certs)[number] | undefined;
    for (const c of s.certs) if (c.member === m.key && c.notAfter && (!soonest || c.notAfter < soonest.notAfter!)) soonest = c;
    if (soonest) {
      const days = Math.floor((Date.parse(soonest.notAfter!) - now.getTime()) / DAY);
      if (days > t.certWarnDays && days <= PREVENT.certDays) push("preventive-risk", m.key, "INFO", nowIso, [`${memberName(s, m)}: ${soonest.subject ?? soonest.alias ?? "a certificate"} (${soonest.store}) expires in ${days} days, ${soonest.notAfter}`]);
    }
  }
  return list.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || (a.since < b.since ? -1 : a.since > b.since ? 1 : 0) || (a.id < b.id ? -1 : 1));
}

export interface ServiceHealth {
  service: string; asOf: string;
  /** ok: nothing to do; attention: only WARN and INFO to-dos; critical: some CRIT. */
  verdict: "ok" | "attention" | "critical";
  counts: Record<Severity, number>;
  todos: Todo[];
  /** Step 3a (C1): the machine light, six rows. The business light is step 3b's. */
  machine: MachineLightView;
  /** One row per member: the node strip. */
  members: { key: string; label: string; state: string; connection: string | null; heapPct: number | null; queuedCount: number | null; version: string | null }[];
}

/** get_service_health and GET /api/services/:id/health. */
export function health(store: Store, executor: (host: string) => ExecutorInfo, id: string, now: Date = new Date()): ServiceHealth | undefined {
  const s = serviceStatus(store, executor, id, now);
  if (!s) return undefined;
  const t = thresholdsOf(store, id, s.profile).effective;
  const result = evaluate(store, s, t, now, sinceFromFacts(store, s));
  const list = todos(store, s, t, now, result);
  const counts: Record<Severity, number> = { CRIT: 0, WARN: 0, INFO: 0 };
  for (const x of list) counts[x.severity]++;
  return {
    service: id, asOf: now.toISOString(), verdict: counts.CRIT ? "critical" : list.length ? "attention" : "ok", counts, todos: list,
    machine: machineOf(store, s, t, now, result),
    members: s.members.map((m) => ({ key: m.key, label: memberName(s, m), state: m.state, connection: m.live?.connection ?? null, heapPct: m.live?.point?.heapPct ?? null, queuedCount: m.live?.point?.queuedCount ?? null, version: m.live?.version ?? null })),
  };
}
