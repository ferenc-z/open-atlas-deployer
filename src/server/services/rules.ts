// Service ops §9.2, §15.3, phase 2 step 3: the health rules, their alerts and the event timeline. The rules run in the
// Deployer, not on the hosts (they look across a cluster's nodes, the thresholds are in the database): after each batch
// of samples is taken in, and once a minute (an executor gone silent sends nothing). A rule holds or not for a member
// (a node, a standalone's installation) or for the whole service (member "*": the coordinator, back pressure, which is
// flow-wide, versions across the nodes, bulletins). Each rule and member has at most one open alert, resolved when the
// rule no longer holds; a rule that cannot tell (no fresh sample) leaves its alert as it is. Opening, a new level and
// resolving go on the timeline (service_events), with what the samples show changed: a node disconnecting and
// reconnecting (the coordinator's view), the process restarting (its start time), the version changing.

import type { ExecutorInfo } from "../handoff.ts";
import type { AlertLevel, ServiceAlert, Store } from "../store.ts";
import type { Thresholds } from "./profiles.ts";
import { serviceStatus, thresholdsOf, type MemberStatus, type ServiceStatus } from "./status.ts";
import { bucketOf } from "./logs.ts";
import { memberDrift } from "./configdrift.ts";

export type RuleId =
  | "executor-lost" | "no-samples" | "process-down" | "node-disconnected" | "no-coordinator" | "backpressure" | "repo-disk" | "heap"
  | "error-bulletins" | "zk-errors" | "version-mismatch" | "no-certificate" | "cert-expiry" | "cert-unreadable" | "config-drift";

/** What each rule watches; scope: per member or for the whole service. */
export const RULES: Record<RuleId, { label: string; scope: "member" | "service"; levels: AlertLevel[]; description: string }> = {
  "executor-lost": { label: "Service executor lost", scope: "member", levels: ["CRIT"], description: "The host's service executor has sent no heartbeat for longer than the threshold (it counts as offline after 30 seconds): nothing is known of the member." },
  "no-samples": { label: "No samples", scope: "member", levels: ["WARN"], description: "The executor has been online for 3 sampling periods or more but has sent no sample of this member for 3 periods." },
  "process-down": { label: "Process not running", scope: "member", levels: ["CRIT"], description: "The newest sample found no NiFi process for this installation." },
  "node-disconnected": { label: "Node disconnected", scope: "member", levels: ["CRIT"], description: "In the cluster coordinator's view the node is disconnected (or disconnecting, offloaded)." },
  "no-coordinator": { label: "No cluster coordinator", scope: "service", levels: ["CRIT"], description: "No node of the cluster is the cluster coordinator in any node's view." },
  "backpressure": { label: "Back pressure", scope: "service", levels: ["WARN"], description: "Some connection of the flow has been at its back pressure threshold for longer than the threshold (flow-wide: one alert for the service, not per node)." },
  "repo-disk": { label: "Repository disk full", scope: "member", levels: ["WARN", "CRIT"], description: "The disk of a FlowFile, content or provenance repository is fuller than the warning or critical threshold." },
  "heap": { label: "Heap high", scope: "member", levels: ["WARN"], description: "The JVM heap has stayed above the threshold for longer than the threshold minutes." },
  "error-bulletins": { label: "ERROR bulletins", scope: "service", levels: ["WARN"], description: "At least the threshold number of ERROR bulletins within the window." },
  "zk-errors": { label: "ZooKeeper errors", scope: "service", levels: ["WARN"], description: "Messages about the ZooKeeper connection (ZooKeeper, Curator, ConnectionLoss) keep coming, in bulletins and in nifi-app.log's WARN/ERROR summary: at least the threshold within the window (the log's counts are per 5 minutes, so the window is widened to whole 5-minute buckets)." },
  "version-mismatch": { label: "Versions differ", scope: "service", levels: ["WARN"], description: "The cluster's running nodes report different NiFi versions." },
  "no-certificate": { label: "No monitor certificate", scope: "member", levels: ["WARN"], description: "The service executor has no monitor certificate (EXECUTOR_NIFI_CLIENT_CERT and _KEY): only the process and the host are sampled, not NiFi." },
  "cert-expiry": { label: "Certificate expiring", scope: "member", levels: ["WARN", "CRIT"], description: "A certificate of the keystore, the truststore or the monitor certificate expires within the warning or critical number of days, or has expired." },
  "cert-unreadable": { label: "Certificate unreadable", scope: "member", levels: ["WARN"], description: "A keystore or truststore could not be read (encrypted password, missing file, no keytool): its expiry is not watched." },
  "config-drift": { label: "Configuration drift", scope: "member", levels: ["WARN"], description: "A configuration file on the host is not what the Deployer says it should be: someone or NiFi changed or removed it. See the differences on the Changes tab; adopt it there or, later, overwrite it." },
};

/** Each threshold: what it is, its unit and bounds (the page's form says the same). */
export const THRESHOLDS: Record<keyof Thresholds, { label: string; unit: string; min: number; max: number; rule: RuleId; description: string }> = {
  executorLostMinutes: { label: "Executor lost after", unit: "min", min: 0, max: 60, rule: "executor-lost", description: "How long the service executor may be offline (beyond its 30 seconds without a heartbeat) before the alert opens. Short restarts of the executor stay quiet." },
  backpressureMinutes: { label: "Back pressure for", unit: "min", min: 0, max: 1440, rule: "backpressure", description: "How long some connection must stay at back pressure. Back pressure is read every 5 minutes by default (the service executor's EXECUTOR_BACKPRESSURE_SECONDS), so it takes that many readings in a row; 0 opens the alert on the first reading that shows it." },
  repoDiskWarnPct: { label: "Repository disk warning", unit: "%", min: 1, max: 100, rule: "repo-disk", description: "A repository's disk this full opens a warning." },
  repoDiskCritPct: { label: "Repository disk critical", unit: "%", min: 1, max: 100, rule: "repo-disk", description: "This full makes it critical; above the warning threshold." },
  heapPct: { label: "Heap above", unit: "%", min: 1, max: 100, rule: "heap", description: "The heap use (of its maximum) that counts as high." },
  heapMinutes: { label: "Heap high for", unit: "min", min: 0, max: 1440, rule: "heap", description: "How long the heap must stay above it (a full GC usually brings it down)." },
  errorBulletins: { label: "ERROR bulletins", unit: "count", min: 1, max: 10000, rule: "error-bulletins", description: "How many ERROR bulletins within the window open the alert." },
  errorBulletinMinutes: { label: "ERROR bulletin window", unit: "min", min: 1, max: 1440, rule: "error-bulletins", description: "The window the ERROR bulletins are counted over." },
  zkErrors: { label: "ZooKeeper errors", unit: "count", min: 1, max: 10000, rule: "zk-errors", description: "How many ZooKeeper connection messages within the window open the alert." },
  zkMinutes: { label: "ZooKeeper error window", unit: "min", min: 1, max: 1440, rule: "zk-errors", description: "The window they are counted over." },
  certWarnDays: { label: "Certificate warning", unit: "days", min: 1, max: 3650, rule: "cert-expiry", description: "A certificate expiring within this many days opens a warning." },
  certCritDays: { label: "Certificate critical", unit: "days", min: 0, max: 3650, rule: "cert-expiry", description: "Within this many days (or expired) it is critical; below the warning threshold." },
};

/** What a rule found for a member ("*": the service). */
export interface Condition { rule: RuleId; member: string; level: AlertLevel; text: string; detail: Record<string, unknown> }

const DOWN = new Set(["DISCONNECTED", "DISCONNECTING", "OFFLOADED", "OFFLOADING"]);
const ZK = /zookeeper|curator|connectionloss|keeperexception/i;
/** In the log summary NiFi abbreviates the logger (o.a.z.ClientCnxn is ZooKeeper's client). */
const ZK_LOG = /zookeeper|curator|connectionloss|keeperexception|\bo\.a\.z\.|ClientCnxn/i;
const MIN = 60_000, DAY = 86_400_000, BUCKET_MS = 5 * MIN;
const keyOf = (rule: string, member: string) => `${rule}\0${member}`;

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

/** The rules over one service's status (and its samples, bulletins, certificates): what holds, and which rules cannot tell. */
export function evaluate(store: Store, s: ServiceStatus, t: Thresholds, now: Date, onlineSince: Map<string, string> = new Map()): { active: Condition[]; held: Set<string> } {
  const active: Condition[] = [];
  const held = new Set<string>();
  const nowMs = now.getTime();
  const iso = (ms: number) => new Date(ms).toISOString();
  const period = s.summary.period;
  const add = (rule: RuleId, member: string, level: AlertLevel, text: string, detail: Record<string, unknown> = {}) => active.push({ rule, member, level, text, detail });
  const hold = (rule: RuleId, member: string) => held.add(keyOf(rule, member));
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
    const fresh = m.source === "samples" && (m.state === "running" || m.state === "stopped");
    // The executor: offline for longer than its 30 seconds plus the threshold (never seen: at once).
    if (m.state === "lost") {
      const offlineFor = m.executor.ageSeconds === undefined ? Infinity : m.executor.ageSeconds - 30;
      if (offlineFor >= t.executorLostMinutes * 60) add("executor-lost", k, "CRIT", `${name}: ${m.executor.reason ?? "the service executor is offline"}`, { ...base, ageSeconds: m.executor.ageSeconds ?? null });
      else hold("executor-lost", k);
    }
    // Overdue samples, once the executor has been online for 3 periods (just back, its first sample is on the way).
    if (m.state === "unknown" && m.source === "samples") {
      const since = onlineSince.get(k);
      if (!working.has(k) && since && nowMs - Date.parse(since) >= 3 * period * 1000) add("no-samples", k, "WARN", `${name}: no sample since ${m.asOf}`, { ...base, asOf: m.asOf });
      else hold("no-samples", k);
    }
    // What the samples say, only from a fresh one.
    const sampled: RuleId[] = ["process-down", "heap", "repo-disk", "no-certificate", "version-mismatch"];
    if (!fresh) for (const r of sampled) if (r !== "version-mismatch") hold(r, k);
    if (fresh && m.live) {
      if (m.live.running === false && working.has(k)) hold("process-down", k);
      else if (m.live.running === false) add("process-down", k, "CRIT", `${name}: no NiFi process at ${m.live.at}`, { ...base, at: m.live.at });
      if (m.live.nifi === "no-certificate") add("no-certificate", k, "WARN", `${name}: the service executor has no monitor certificate`, base);
      if (m.live.running) {
        const p = m.live.point ?? {};
        if (typeof p.heapPct !== "number") hold("heap", k);
        else {
          const points = store.memberPoints(s.id, k, iso(nowMs - t.heapMinutes * MIN - 3 * period * 1000), iso(nowMs + 1000));
          const run = heldSince(points, (x) => (typeof x.point.heapPct === "number" ? x.point.heapPct >= t.heapPct : null));
          if (run && nowMs - Date.parse(run.since) >= t.heapMinutes * MIN) add("heap", k, "WARN", `${name}: heap ${p.heapPct} % (above ${t.heapPct} % since ${run.since})`, { ...base, heapPct: p.heapPct, since: run.since });
        }
        const repos = (["repoFlowfilePct", "repoContentPct", "repoProvenancePct"] as const).map((f) => [f, p[f]] as const).filter((x): x is readonly [typeof x[0], number] => typeof x[1] === "number");
        if (!repos.length) hold("repo-disk", k);
        else {
          const [field, full] = repos.reduce((a, b) => (b[1] > a[1] ? b : a));
          const level: AlertLevel | null = full >= t.repoDiskCritPct ? "CRIT" : full >= t.repoDiskWarnPct ? "WARN" : null;
          const which = field === "repoFlowfilePct" ? "FlowFile" : field === "repoContentPct" ? "content" : "provenance";
          if (level) add("repo-disk", k, level, `${name}: the ${which} repository's disk is ${full} % full`, { ...base, repository: which, pct: full });
        }
      }
    }
    // A cluster node's connection, in the coordinator's view (none: cannot tell).
    if (cluster) {
      const c = m.live?.connection ?? null;
      if (!c || working.has(k)) hold("node-disconnected", k);
      else if (DOWN.has(c)) add("node-disconnected", k, "CRIT", `${name} is ${c.toLowerCase()} in the coordinator's view`, { ...base, connection: c });
    }
    // Certificates: the newest reading of each (kept apart from the samples, so they count even when the sample is old).
    const certs = s.certs.filter((c) => c.member === k);
    let soonest: (typeof certs)[number] | undefined;
    for (const c of certs) if (c.notAfter && (!soonest || c.notAfter < soonest.notAfter!)) soonest = c;
    if (soonest) {
      const days = Math.floor((Date.parse(soonest.notAfter!) - nowMs) / DAY);
      const level: AlertLevel | null = days < 0 || days <= t.certCritDays ? "CRIT" : days <= t.certWarnDays ? "WARN" : null;
      const what = `${soonest.subject ?? soonest.alias ?? "a certificate"} (${soonest.store})`;
      if (level) add("cert-expiry", k, level, `${name}: ${what} ${days < 0 ? `expired ${-days} days ago` : `expires in ${days} days`}, ${soonest.notAfter}`, { ...base, store: soonest.store, subject: soonest.subject, notAfter: soonest.notAfter, days });
    }
    const unreadable = certs.filter((c) => c.error);
    if (unreadable.length) add("cert-unreadable", k, "WARN", `${name}: ${unreadable.map((c) => `${c.store}: ${c.error}`).join("; ")}`, { ...base, stores: unreadable.map((c) => ({ store: c.store, error: c.error })) });
    // §16.3: the fingerprints. Names only here: this goes on the timeline, and from there to the AI.
    const drift = memberDrift(m, memberFiles);
    if (drift.state === "unknown" || working.has(k)) hold("config-drift", k);
    else if (drift.state === "drift") {
      const off = drift.files.filter((f) => f.state === "changed" || f.state === "missing");
      add("config-drift", k, "WARN", `${name}: ${off.map((f) => `${f.name}${f.state === "missing" ? " (gone)" : ""}`).join(", ")} on the host ${off.length > 1 ? "are" : "is"} not what is kept`, { ...base, files: off.map((f) => f.name) });
    }
  }

  // The whole service.
  if (cluster) {
    const viewed = s.members.filter((m) => m.live?.connection);
    if (!viewed.length || whole) hold("no-coordinator", "*");
    else if (!viewed.some((m) => m.live!.roles.includes("Cluster Coordinator"))) add("no-coordinator", "*", "CRIT", "No node is the cluster coordinator in the newest view", {});
    const versions = [...new Set(s.members.filter((m) => m.source === "samples" && m.state === "running" && m.live?.version).map((m) => m.live!.version!))];
    if (versions.length > 1) add("version-mismatch", "*", "WARN", `The nodes run ${versions.join(" and ")}`, { versions });
  }
  // Back pressure is flow-wide: every node reports the same, so one alert for the service from all its points. It is
  // read every few minutes (owner 2026-11-07, summary.backpressure.everySeconds): the window reaches 3 intervals back,
  // and a summary older than that (stale) cannot tell.
  const bpEvery = Math.max(period, s.summary.backpressure?.everySeconds ?? period);
  const bp = s.summary.backpressure && !s.summary.backpressure.stale
    ? store.servicePoints(s.id, iso(nowMs - t.backpressureMinutes * MIN - 3 * bpEvery * 1000), iso(nowMs + 1000)).filter((x) => typeof x.point.bpFull === "number")
    : [];
  if (!bp.length) hold("backpressure", "*");
  else {
    const run = heldSince(bp, (x) => (x.point.bpFull as number) > 0);
    if (run && nowMs - Date.parse(run.since) >= t.backpressureMinutes * MIN) add("backpressure", "*", "WARN", `${run.latest.point.bpFull} connection(s) at back pressure since ${run.since} (fullest ${run.latest.point.bpMaxPct ?? "?"} %)`, { full: run.latest.point.bpFull, maxPct: run.latest.point.bpMaxPct ?? null, since: run.since });
  }
  const errors = store.serviceBulletins(s.id, { from: iso(nowMs - t.errorBulletinMinutes * MIN), level: "ERROR", limit: 1000 });
  if (errors.length >= t.errorBulletins) add("error-bulletins", "*", "WARN", `${errors.length} ERROR bulletins in ${t.errorBulletinMinutes} min (newest: ${errors[0]?.source ?? "?"}: ${(errors[0]?.message ?? "").slice(0, 200)})`, { count: errors.length, minutes: t.errorBulletinMinutes });
  // Step 14b: what a change's own stops and starts make NiFi log about ZooKeeper (forming and the stable time included) is
  // not counted; a 5-minute bucket that touches a change's time counts as the change's.
  const zkFrom = iso(nowMs - t.zkMinutes * MIN);
  const windows = changeWindows(store, s.id, Date.parse(bucketOf(zkFrom)), nowMs);
  const inChange = (from: number, to: number) => windows.some(([a, b]) => from <= b && to >= a);
  const zk = store.serviceBulletins(s.id, { from: zkFrom, limit: 1000 }).filter((b) => b.level !== "INFO" && b.level !== "DEBUG" && ZK.test(b.message ?? "") && !inChange(Date.parse(b.at), Date.parse(b.at)));
  // Step 4: and nifi-app.log's WARN/ERROR summary (5-minute counts: the window is widened to whole buckets).
  const logs = store.serviceLogCounts(s.id, bucketOf(zkFrom))
    .filter((c) => c.level !== "INFO" && c.level !== "DEBUG" && ZK_LOG.test(`${c.logger ?? ""} ${c.template} ${c.exception ?? ""}`))
    .filter((c) => !inChange(Date.parse(c.bucket), Date.parse(c.bucket) + BUCKET_MS - 1));
  const fromLogs = logs.reduce((n, c) => n + c.count, 0);
  if (whole) hold("zk-errors", "*");
  else if (zk.length + fromLogs >= t.zkErrors) {
    const newest = logs.length ? logs[logs.length - 1]! : null;
    const example = zk[0]?.message ?? (newest ? `${newest.logger ?? ""} ${newest.template}` : "");
    add("zk-errors", "*", "WARN", `${zk.length + fromLogs} ZooKeeper connection messages in ${t.zkMinutes} min (${zk.length} bulletins, ${fromLogs} in nifi-app.log; e.g. ${example.slice(0, 200)})`, { count: zk.length + fromLogs, bulletins: zk.length, log: fromLogs, minutes: t.zkMinutes });
  }
  return { active, held };
}

export interface CheckResult { opened: number; changed: number; resolved: number; events: number }

/** Runs the rules over one service: opens, updates and resolves its alerts, and writes what changed on the timeline. */
export function check(store: Store, executor: (host: string) => ExecutorInfo, id: string, now: Date = new Date()): CheckResult | undefined {
  const s = serviceStatus(store, executor, id, now);
  if (!s) return undefined;
  const at = now.toISOString();
  const out: CheckResult = { opened: 0, changed: 0, resolved: 0, events: 0 };
  // Since when each member's executor is online (facts, so a restart of the Deployer keeps them).
  const facts = store.serviceFacts(id);
  const onlineSince = new Map<string, string>();
  for (const m of s.members) {
    const was = facts.get(`${m.key} onlineSince`) ?? null;
    const since = m.executor.online ? was ?? at : null;
    if (since !== was) store.setServiceFact(id, m.key, "onlineSince", since);
    if (since) onlineSince.set(m.key, since);
  }
  const { active, held } = evaluate(store, s, thresholdsOf(store, id, s.profile).effective, now, onlineSince);
  const open = new Map(store.serviceAlerts({ service: id, state: "open", limit: 1000 }).map((a) => [keyOf(a.rule, a.member), a] as const));
  const seen = new Set<string>();
  for (const c of active) {
    const key = keyOf(c.rule, c.member);
    if (seen.has(key)) continue;
    seen.add(key);
    const detail = { ...c.detail, text: c.text };
    const was = open.get(key);
    if (!was) { if (store.openServiceAlert({ service: id, member: c.member, rule: c.rule, level: c.level, detail }, at, { text: `${c.level} ${RULES[c.rule].label}: ${c.text}` }, c.rule === "config-drift" ? "drift-detected" : undefined) !== undefined) out.opened++; }
    else if (was.level !== c.level || was.detail.text !== c.text) { store.updateServiceAlert(was.id, c.level, detail, at, { text: `${c.level} (was ${was.level}) ${RULES[c.rule].label}: ${c.text}` }); out.changed++; }
  }
  for (const [key, a] of open) {
    if (seen.has(key) || held.has(key)) continue;
    store.resolveServiceAlert(a.id, at, { text: `Resolved: ${RULES[a.rule as RuleId]?.label ?? a.rule}${a.member === "*" ? "" : ` (${String(a.detail.label ?? a.member)})`}` }, a.rule === "config-drift" ? "drift-resolved" : undefined);
    out.resolved++;
  }
  out.events += changes(store, s);
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
    const fact = (key: string) => facts.get(`${m.key}\0${key}`);
    if (live.startedAt) {
      const was = fact("startedAt");
      if (was !== undefined && was !== null && was !== live.startedAt) event(m, live.startedAt, "process-restarted", { text: `${name}: NiFi started again (pid ${live.pid ?? "?"}; the previous process started ${was})`, startedAt: live.startedAt, was, pid: live.pid });
      if (was !== live.startedAt) store.setServiceFact(s.id, m.key, "startedAt", live.startedAt);
    }
    if (live.version) {
      const was = fact("version");
      if (was !== undefined && was !== null && was !== live.version) event(m, live.at, "version-changed", { text: `${name}: version ${was} → ${live.version}`, from: was, to: live.version });
      if (was !== live.version) store.setServiceFact(s.id, m.key, "version", live.version);
    }
    const c = live.connection;
    const now = c === "CONNECTED" ? "up" : c && DOWN.has(c) ? "down" : null;
    if (now) {
      const was = fact("connection");
      if (now === "down" && was !== "down") event(m, live.at, "node-disconnected", { text: `${name} ${c!.toLowerCase()} (the coordinator's view)`, connection: c });
      if (now === "up" && was === "down") event(m, live.at, "node-reconnected", { text: `${name} connected to the cluster again`, connection: c });
      if (was !== now) store.setServiceFact(s.id, m.key, "connection", now);
    }
  }
  return events;
}

/** The minute's check over every registered service; one failing does not stop the rest. */
export function checkAll(store: Store, executor: (host: string) => ExecutorInfo, now: Date = new Date()): CheckResult {
  const total: CheckResult = { opened: 0, changed: 0, resolved: 0, events: 0 };
  for (const id of [...store.standalones().map((x) => x.id), ...store.clusters().map((x) => x.id)]) {
    try {
      const r = check(store, executor, id, now);
      if (r) for (const k of Object.keys(total) as (keyof CheckResult)[]) total[k] += r[k];
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
export const alertView = (a: ServiceAlert) => ({ ...a, label: RULES[a.rule as RuleId]?.label ?? a.rule, text: String(a.detail.text ?? ""), memberLabel: a.member === "*" ? null : String(a.detail.label ?? a.member) });

// --- S37 step 2 (pages-rethink §4.1): the to-do list. Every round of samples the rules above are read as findings: what is wrong
// now, since when, the evidence, a template cause and the next actions. Two rules are findings only (no alert, no timeline):
// collection incomplete and preventive risk. Same function for the page and the MCP tool get_service_health (D10).

export type TodoRule = RuleId | "collection-incomplete" | "preventive-risk";
export type Severity = "CRIT" | "WARN" | "INFO";
/** A next step: investigate (the troubleshooting page, from this finding), open-nifi, draft-config, member-control (start/stop), metrics, config-diff. */
export interface TodoAction { kind: "investigate" | "open-nifi" | "draft-config" | "member-control" | "metrics" | "config-diff"; label: string; target?: Record<string, unknown> }
export interface Todo { id: string; rule: TodoRule; severity: Severity; since: string; member: string; memberLabel: string | null; evidence: string[]; cause: string; actions: TodoAction[] }

const CAUSES: Record<TodoRule, string> = {
  "executor-lost": "The service executor on the host sends no heartbeat: the executor or the host is down, or the network between them and the Deployer is cut. Nothing is known of the member until it is back.",
  "no-samples": "The executor is online but the member's samples stopped coming: the collector may be stuck or the sample could not be built.",
  "process-down": "No NiFi process runs for this installation: it was stopped, crashed (check the log and the OS for an out-of-memory kill) or failed to start.",
  "node-disconnected": "The cluster coordinator sees the node as disconnected: the node is down or cannot reach the coordinator or ZooKeeper, or it was disconnected or offloaded on purpose.",
  "no-coordinator": "No node holds the cluster coordinator role: the election has not finished or ZooKeeper cannot be reached from the nodes.",
  "backpressure": "A connection's queue has stayed at its back pressure threshold: the component after it is slower than what comes in, stopped, or blocked downstream.",
  "repo-disk": "A repository's disk is filling: content is not removed fast enough (long queues, content claims held by a stuck queue) or the data grows with the flow's volume.",
  "heap": "The JVM heap stays high: a flow holds many FlowFiles or attributes in memory, or the heap is too small for the load; a leak shows as a baseline that keeps rising.",
  "error-bulletins": "Components are reporting ERRORs: a processor fails (credentials, target down, bad data). The bulletins name the component.",
  "zk-errors": "The nodes keep losing the ZooKeeper connection: ZooKeeper is down or overloaded, or the network or time sync is unstable.",
  "version-mismatch": "The running nodes report different NiFi versions: a rolling upgrade did not finish or one node was started from another installation.",
  "no-certificate": "The service executor has no monitor certificate, so only the process and the host are sampled, not NiFi's REST API.",
  "cert-expiry": "A certificate used by NiFi is expired or about to be: connections that rely on it will fail once it is.",
  "cert-unreadable": "A keystore or truststore could not be read (encrypted password, missing file, no keytool), so its expiry is not watched.",
  "config-drift": "A configuration file on the host differs from what the Deployer keeps: someone or something edited or removed it.",
  "collection-incomplete": "The numbers of this member are not complete: the collector could not read NiFi's REST API, or could not tell which cluster node this member is. Charts and rules for it are blind until this is fixed.",
  "preventive-risk": "A trend, not a fault yet: if it continues, the limit is reached within the time shown.",
};

const nifiLink = (s: ServiceStatus): TodoAction[] => (s.webUrl ? [{ kind: "open-nifi", label: "Open in NiFi", target: { url: s.webUrl } }] : []);
const investigate = (member?: string): TodoAction => ({ kind: "investigate", label: "Investigate", ...(member && member !== "*" ? { target: { member } } : {}) });
const ACTIONS: Partial<Record<TodoRule, (s: ServiceStatus, member: string) => TodoAction[]>> = {
  "no-samples": (_s, m) => [investigate(m)],
  "process-down": (_s, m) => [investigate(m), { kind: "member-control", label: "Start", target: { member: m, action: "start" } }],
  "node-disconnected": (_s, m) => [investigate(m), { kind: "member-control", label: "Restart", target: { member: m, action: "restart" } }],
  "no-coordinator": () => [investigate()],
  "backpressure": (s) => [investigate(), ...nifiLink(s)],
  "repo-disk": (_s, m) => [investigate(m), { kind: "metrics", label: "Disk trend", target: { member: m, fields: ["repoFlowfilePct", "repoContentPct", "repoProvenancePct"] } }],
  "heap": (_s, m) => [investigate(m), { kind: "draft-config", label: "Draft a heap change", target: { file: "bootstrap.conf" } }, { kind: "metrics", label: "Heap trend", target: { member: m, fields: ["heapPct", "gcMsPerMin"] } }],
  "error-bulletins": (s) => [investigate(), ...nifiLink(s)],
  "zk-errors": () => [investigate()],
  "version-mismatch": () => [{ kind: "config-diff", label: "Compare the nodes" }],
  "cert-expiry": (_s, m) => [investigate(m)],
  "config-drift": (_s, m) => [{ kind: "config-diff", label: "See the differences", target: { member: m } }],
  "collection-incomplete": (_s, m) => [investigate(m)],
  "preventive-risk": (_s, m) => [{ kind: "metrics", label: "Trend", target: { member: m } }],
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

/** The to-do list of a service: the rules' conditions, the two findings-only rules, worst first. */
export function todos(store: Store, s: ServiceStatus, t: Thresholds, now: Date): Todo[] {
  const nowIso = now.toISOString();
  const facts = store.serviceFacts(s.id);
  const onlineSince = new Map<string, string>();
  for (const m of s.members) { const v = facts.get(`${m.key}\0onlineSince`); if (v) onlineSince.set(m.key, v); }
  const openSince = new Map(store.serviceAlerts({ service: s.id, state: "open", limit: 1000 }).map((a) => [keyOf(a.rule, a.member), a.openedAt] as const));
  const label = (member: string) => { if (member === "*") return null; const m = s.members.find((x) => x.key === member); return m ? memberName(s, m) : member; };
  const list: Todo[] = [];
  const push = (rule: TodoRule, member: string, severity: Severity, since: string, evidence: string[]) => {
    if (list.some((x) => x.rule === rule && x.member === member)) { list.find((x) => x.rule === rule && x.member === member)!.evidence.push(...evidence); return; }
    list.push({ id: `${rule}:${member}`, rule, severity, since, member, memberLabel: label(member), evidence, cause: CAUSES[rule], actions: ACTIONS[rule]?.(s, member) ?? [] });
  };
  const seen = new Set<string>();
  for (const c of evaluate(store, s, t, now, onlineSince).active) {
    const key = keyOf(c.rule, c.member);
    if (seen.has(key)) continue;
    seen.add(key);
    push(c.rule, c.member, c.level, openSince.get(key) ?? nowIso, [c.text]);
  }
  for (const m of s.members) {
    const live = m.live;
    // Collection incomplete: REST says anything but ok (no certificate and a stopped process have their own rules), or the node was not recognised.
    if (m.state === "running" && live?.nifi && !["ok", "no-certificate", "not-running"].includes(live.nifi))
      push("collection-incomplete", m.key, "WARN", live.at, [`${memberName(s, m)}: the REST API reading is "${live.nifi}"`, ...live.problems.map((p) => `collector: ${p}`)]);
    if (live?.point && live.point._unmatched)
      push("collection-incomplete", m.key, "WARN", live.at, [`${memberName(s, m)}: this member was not found in NiFi's node list, so its heap, threads, repositories and queue are empty`]);
  }
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
  /** One row per member: the node strip. */
  members: { key: string; label: string; state: string; connection: string | null; heapPct: number | null; queuedCount: number | null; version: string | null }[];
}

/** get_service_health and GET /api/services/:id/health. */
export function health(store: Store, executor: (host: string) => ExecutorInfo, id: string, now: Date = new Date()): ServiceHealth | undefined {
  const s = serviceStatus(store, executor, id, now);
  if (!s) return undefined;
  const list = todos(store, s, thresholdsOf(store, id, s.profile).effective, now);
  const counts: Record<Severity, number> = { CRIT: 0, WARN: 0, INFO: 0 };
  for (const x of list) counts[x.severity]++;
  return {
    service: id, asOf: now.toISOString(), verdict: counts.CRIT ? "critical" : list.length ? "attention" : "ok", counts, todos: list,
    members: s.members.map((m) => ({ key: m.key, label: memberName(s, m), state: m.state, connection: m.live?.connection ?? null, heapPct: m.live?.point?.heapPct ?? null, queuedCount: m.live?.point?.queuedCount ?? null, version: m.live?.version ?? null })),
  };
}
