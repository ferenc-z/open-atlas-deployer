// Service ops §7, §8, §16.3: the change engine. A change (applying a revision, overwriting drift, a restart, a rolling
// restart, a start or a stop) is planned, then carried out one member at a time by tick(), which looks only at the
// database: the change, its steps, and the executor jobs they wait for. Nothing lives in memory, so a Deployer restart
// loses nothing, and the executors know no flow: each job is one thing to do, and each is safe to repeat. Before a
// member is touched the cluster is looked at afresh (svc-state): ordinary nodes go first and the primary node and the
// coordinator last, since those roles move while it rolls. A step that fails for a clear reason rolls that member back
// and stops; a step past its deadline just stops, since what happened on the host is not known. Going on (continue)
// always compares with what the hosts have first. mode "full" (S31) shares the tables, the lock and the routes; its flow
// is planned here and refused at the start until step 11b.

import { createHash, randomBytes } from "node:crypto";
import type { Handoff } from "../handoff.ts";
import { newJobId } from "../handoff.ts";
import type { SecretBox } from "../secretbox.ts";
import type { Actor, ExecutorStatus, ServiceChange, ServiceChangeStep, Store } from "../store.ts";
import { assessChange, blockingFindings, checkConfig, openMembers, type ChangeMode, type CheckMember, type ConfigFinding, type FileChange } from "./configcheck.ts";
import { hasDrifted, liveDifferences, readLive, DriftError, type LiveReadOptions } from "./configdrift.ts";
import { effectiveProperties } from "./configdoc.ts";
import { fileDiffs } from "./configedit.ts";
import { openFile, type ConfigFileRecord, type ConfigMember } from "./config.ts";
import { confDirOf, filterStartEnvironment, installKey, type ServiceMember } from "./draft.ts";
import { profile as profileById } from "./profiles.ts";

export type ChangeKind = "apply" | "overwrite" | "restart" | "rolling-restart" | "start" | "stop";
export const CHANGE_KINDS: readonly ChangeKind[] = ["apply", "overwrite", "restart", "rolling-restart", "start", "stop"];
export type Stage = "disconnect" | "offload" | "stop" | "write" | "start" | "wait-rest" | "wait-connected" | "wait-stable" | "restore";

/** What the executor says when it comes back and finds a job it was running (service_executor.py INTERRUPTED). */
export const INTERRUPTED = "The service executor stopped while this job ran.";

/** §16.3: seconds for each step; the first five are what the design names, to be set from the measurements of steps 13 and 14. */
export const DEFAULT_TIMEOUTS = { disconnect: 60, offload: 900, stop: 120, rest: 600, connect: 600, write: 120, start: 300, stable: 300, gate: 180 };
export type Timeouts = typeof DEFAULT_TIMEOUTS;
const TIMEOUT_MAX = 3600; // svc-control's own limit (CONTROL_TIMEOUT_MAX)
const STAGE_TIMEOUT: Record<Stage, keyof Timeouts> = { disconnect: "disconnect", offload: "offload", stop: "stop", write: "write", start: "start", restore: "write", "wait-rest": "rest", "wait-connected": "connect", "wait-stable": "stable" };
export interface ChangeOptions { offload: boolean; invalidTolerance: number; stableSeconds: number; timeouts: Timeouts }

/** How long a job may wait in the queue (§16.3: expiresAt); a step's deadline leaves that much on top of its own time. */
const QUEUE_MS = 5 * 60_000;
const GRACE_MS = 30_000;
const PROBE_EVERY_MS = 5_000;
/** A svc-state not answered by then counts as no answer this round. */
const PROBE_WAIT_MS = 35_000;
/** How long a node may stay away before another node is asked to connect it (§16.3). */
const CONNECT_NUDGE_MS = 60_000;
const COORDINATOR = "Cluster Coordinator", PRIMARY = "Primary Node";
const AWAY = new Set(["DISCONNECTED", "DISCONNECTING", "OFFLOADING", "OFFLOADED"]);
const FINAL = new Set(["succeeded", "failed", "refused", "rolled-back"]);

export interface PlanFile extends Omit<FileChange, "name" | "change"> { name: string; change: FileChange["change"]; path: string; baseSha256: string | null; sha256: string; revision: number }
export interface PlanMember { member: string; host: string; restart: boolean; files: PlanFile[]; stages: Stage[]; differences?: unknown[] }
export interface ChangePlan {
  service: string; kind: ChangeKind; revision: number | null; mode: ChangeMode; fullBecause: { file: string; key?: string }[]; restart: boolean;
  members: PlanMember[]; order: string; options: ChangeOptions; findings: ConfigFinding[]; blocking: ConfigFinding[];
  executors: { host: string; online: boolean; version: string | null; reason?: string }[];
  empty: boolean; planHash: string;
}
export interface ChangeRequest { kind?: unknown; revision?: unknown; members?: unknown; options?: unknown }

interface ProcessPair { pid?: unknown; startedAt?: unknown; bootstrapPid?: unknown; bootstrapStartedAt?: unknown }
/** A change's working state, in its row. */
export interface ChangeProgress {
  done: string[]; remaining: Stage[]; baseline: number | null; nodeId: string | null;
  rollingBack: boolean; wrote: boolean; before: ProcessPair | null; stuck: ProcessPair | null;
  probes: Record<string, string>; probedAt: string | null; nextProbe: string | null; stableSince: string | null; invalidHigh: boolean;
  nudge: string | null; resume: boolean; intent: "forward" | "rollback"; pruning: string[];
}
export const newProgress = (): ChangeProgress => ({ done: [], remaining: [], baseline: null, nodeId: null, rollingBack: false, wrote: false, before: null, stuck: null, probes: {}, probedAt: null, nextProbe: null, stableSince: null, invalidHigh: false, nudge: null, resume: false, intent: "forward", pruning: [] });

interface StateFile { name: string; sha256?: string; missing?: boolean; error?: string }
interface ClusterNode { nodeId: string; address: string | null; apiPort: number | null; status: string | null; roles: string[] }
interface StateAnswer {
  process: { running: boolean; pid?: number; startedAt?: string; bootstrapPid?: number; bootstrapStartedAt?: string };
  environment: Record<string, unknown> | null;
  limits: unknown;
  files: StateFile[];
  rest: { state: string; error?: string; invalidCount?: number | null; cluster?: { nodes: ClusterNode[]; self: string | null } };
}
/** What one round of svc-state saw. Used and let go: it holds the start environments, which do not go in the change's row. */
interface View { answers: Map<string, StateAnswer>; problems: Map<string, string>; nodes: ClusterNode[] }

type Registered = NonNullable<ReturnType<typeof registered>>;
const registered = (store: Store, id: string) => store.standalones().find((s) => s.id === id) ?? store.clusters().find((s) => s.id === id);
const membersOf = (s: Registered): ServiceMember[] => (s.kind === "standalone" ? [s.member] : s.nodes);

/** What the configuration checks look at besides the files: the other services' ports, and each host's memory from its newest sample. */
export function checkContextOf(store: Store, service: Registered) {
  const others = [
    ...store.standalones().filter((s) => s.id !== service.id).map((s) => ({ service: s.service, profile: s.profile, member: s.member })),
    ...store.clusters().filter((s) => s.id !== service.id).flatMap((s) => s.nodes.map((member) => ({ service: s.service, profile: s.profile, member }))),
  ];
  const members = membersOf(service);
  const memory: Record<string, number> = {};
  for (const s of store.latestServiceSamples(service.id)) {
    const total = (s.body as { host?: { memory?: { totalBytes?: unknown } } }).host?.memory?.totalBytes;
    const m = members.find((x) => installKey(x) === s.member);
    if (m && typeof total === "number") memory[m.host] = total;
  }
  return { profile: profileById(service.profile), version: service.version, kind: service.kind, others, memory };
}

export class ChangeError extends Error {
  readonly status: 400 | 404 | 409;
  readonly code: string;
  readonly details: string[];
  constructor(status: 400 | 404 | 409, code: string, message: string, details: string[] = []) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** What a member goes through, before looking at what it has now (nowStages). */
export function stagesFor(kind: ChangeKind, cluster: boolean, m: Pick<PlanMember, "restart" | "files">, offload: boolean): Stage[] {
  const node = (s: Stage): Stage[] => (cluster ? [s] : []);
  if (kind === "stop") return [...node("disconnect"), "stop"];
  if (kind === "start") return ["start", "wait-rest", ...node("wait-connected"), "wait-stable"];
  const restart = kind === "restart" || kind === "rolling-restart" || m.restart;
  const write: Stage[] = m.files.length ? ["write"] : [];
  // §16.3 no. 9: without a restart, only the backup and the replacement.
  if (!restart) return write.length ? [...write, "wait-stable"] : [];
  return [...node("disconnect"), ...(cluster && offload ? (["offload"] as Stage[]) : []), "stop", ...write, "start", "wait-rest", ...node("wait-connected"), "wait-stable"];
}

const isRunning = (a: StateAnswer) => a.process.running || Boolean(a.process.bootstrapPid);
const pairOf = (a: StateAnswer): ProcessPair | null => (isRunning(a) ? { ...(a.process.pid ? { pid: a.process.pid, startedAt: a.process.startedAt } : {}), ...(a.process.bootstrapPid ? { bootstrapPid: a.process.bootstrapPid, bootstrapStartedAt: a.process.bootstrapStartedAt } : {}) } : null);
const samePair = (a: ProcessPair | null, b: ProcessPair | null) => JSON.stringify(a) === JSON.stringify(b);
/** A file's hash on the host: null when it is not there, undefined when it could not be told. */
function liveHash(a: StateAnswer, f: Pick<PlanFile, "name" | "baseSha256">): string | null | undefined {
  const seen = a.files.find((x) => x.name === f.name);
  if (!seen) return f.baseSha256 === null ? null : undefined; // svc-state lists what is registered: a new file is not, yet
  return seen.missing ? null : seen.sha256 ?? undefined;
}

/** §16.3 "继续": what is left of a member's stages given what the host has: a file already as planned is not written, a
 *  process running is not started (nor one gone stopped), a node already away is not disconnected. */
export function nowStages(stages: readonly Stage[], m: Pick<PlanMember, "files">, a: StateAnswer, before: ProcessPair | null, status: string | null): Stage[] {
  const running = isRunning(a);
  const unwritten = m.files.some((f) => liveHash(a, f) !== f.sha256);
  const restarted = running && !samePair(pairOf(a), before);
  const drop = new Set<Stage>();
  if (!unwritten) drop.add("write");
  if (!running) { drop.add("disconnect"); drop.add("offload"); drop.add("stop"); }
  if (running && restarted && !unwritten) { drop.add("disconnect"); drop.add("offload"); drop.add("stop"); drop.add("start"); }
  if (running && !stages.includes("stop") && stages.includes("start")) drop.add("start"); // a start: it runs already
  if (status && AWAY.has(status)) drop.add("disconnect");
  if (status === "OFFLOADED") drop.add("offload");
  // Not running and not to be started: there is nothing to wait for.
  if (!running && !stages.includes("start")) { drop.add("wait-rest"); drop.add("wait-connected"); drop.add("wait-stable"); }
  return stages.filter((s) => !drop.has(s));
}

export interface ServiceChangesDeps { store: Store; handoff: Handoff; box?: SecretBox | undefined; liveRead?: LiveReadOptions | undefined; now?: () => number }

export class ServiceChanges {
  private store: Store;
  private handoff: Handoff;
  private box: SecretBox | undefined;
  private liveRead: LiveReadOptions | undefined;
  private clock: () => number;

  constructor(deps: ServiceChangesDeps) {
    this.store = deps.store;
    this.handoff = deps.handoff;
    this.box = deps.box;
    this.liveRead = deps.liveRead;
    this.clock = deps.now ?? Date.now;
  }

  private iso(offsetMs = 0) { return new Date(this.clock() + offsetMs).toISOString(); }

  // --- the plan ----------------------------------------------------------------------------------------------------

  private options(raw: unknown, service: Registered): { options: ChangeOptions; problems: string[] } {
    const given = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const problems: string[] = [];
    const number = (name: string, value: unknown, fallback: number, min: number, max: number) => {
      if (value === undefined) return fallback;
      if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) { problems.push(`${name}: a number from ${min} to ${max}`); return fallback; }
      return value;
    };
    if (given.offload !== undefined && typeof given.offload !== "boolean") problems.push("offload: true or false");
    if (given.offload === true && service.kind === "standalone") problems.push("offload: a standalone has no cluster to offload to");
    const asked = (given.timeouts && typeof given.timeouts === "object" ? given.timeouts : {}) as Record<string, unknown>;
    for (const k of Object.keys(asked)) if (!(k in DEFAULT_TIMEOUTS)) problems.push(`timeouts.${k}: no such step`);
    const timeouts = Object.fromEntries(Object.entries(DEFAULT_TIMEOUTS).map(([k, v]) => [k, number(`timeouts.${k}`, asked[k], v, 1, TIMEOUT_MAX)])) as Timeouts;
    return { options: { offload: given.offload === true, invalidTolerance: number("invalidTolerance", given.invalidTolerance, 0, 0, 1000), stableSeconds: number("stableSeconds", given.stableSeconds, 30, 0, 600), timeouts }, problems };
  }

  private selected(service: Registered, kind: ChangeKind, raw: unknown): ServiceMember[] {
    const all = membersOf(service);
    if (raw !== undefined && (!Array.isArray(raw) || !raw.every((x) => typeof x === "string") || !raw.length)) throw new ChangeError(400, "service-change/invalid", "members is a list of member keys.");
    const named = raw as string[] | undefined;
    for (const k of named ?? []) if (!all.some((m) => installKey(m) === k)) throw new ChangeError(404, "config/unknown-member", `${k} is not a member of ${service.id}.`);
    if (service.kind === "standalone" && kind === "rolling-restart") throw new ChangeError(400, "service-change/invalid", "A standalone has no rolling restart: restart it.");
    if (service.kind === "cluster" && (kind === "restart" || kind === "start" || kind === "stop") && named?.length !== 1) throw new ChangeError(400, "service-change/invalid", `A ${kind} is of one node: name it in members.`);
    return named ? all.filter((m) => named.includes(installKey(m))) : all;
  }

  /** §16.3: what stops a plan early on the executors' side; their own refusals remain the last word. */
  private capabilityFindings(service: Registered, kind: ChangeKind, chosen: ServiceMember[], writes: boolean): { findings: ConfigFinding[]; executors: ChangePlan["executors"] } {
    const out: ConfigFinding[] = [];
    const error = (code: string, message: string, member?: string) => out.push({ severity: "error", code, message, ...(member ? { member } : {}), introduced: true });
    const executors = [...new Set(membersOf(service).map((m) => m.host))].map((host) => {
      const e = this.handoff.executor(host, "service");
      if (!e.online) error("change/executor-offline", `The service executor of ${host} is offline: ${e.reason ?? "no heartbeat"}.`);
      else {
        const missing = ["svc-state", "svc-control", ...(writes ? ["svc-write"] : [])].flatMap((k) => this.handoff.missing(host, { kind: k }, "service"));
        if (missing.length) error("change/executor-old", `The service executor ${e.heartbeat?.version ?? ""} on ${host} is too old for this: upgrade it first (it does not name ${missing.join(", ")}).`);
      }
      return { host, online: e.online, version: e.heartbeat?.version ?? null, ...(e.reason ? { reason: e.reason } : {}) };
    });
    for (const m of chosen) {
      const key = installKey(m), hb = this.handoff.executor(m.host, "service").heartbeat;
      const control = hb?.control;
      if (!m.serviceUser) error("change/service-user", `${key}: the user this NiFi runs as is not known, and the Deployer does not guess it (S10).`, key);
      else if (m.serviceUser === "root") error("change/service-user", `${key}: NiFi is not run as root (S10).`, key);
      else if (hb && hb.isRoot === false && hb.user && hb.user !== m.serviceUser) error("change/other-user", `${key}: the service executor runs as ${hb.user} and cannot act as ${m.serviceUser}.`, key);
      if (kind !== "stop" && control && control.killMode && control.killMode !== "process") error("change/kill-mode", `${m.host}: the service executor's unit has KillMode=${control.killMode}: NiFi would die with it. Run its install.sh again first.`, key);
      if (service.kind === "cluster" && kind !== "start" && control && !control.operatorCert) error("change/no-operator-cert", `${m.host}: the service executor has no operator certificate (EXECUTOR_NIFI_OPERATOR_CERT): it cannot disconnect a node.`, key);
      if (kind !== "stop" && !m.startEnvironment) out.push({ severity: "warning", code: "change/no-start-env", message: `${key}: no start environment is known (it never ran under the Deployer's eye): NiFi starts with what its own scripts set.`, member: key, introduced: true });
    }
    return { findings: out, executors };
  }

  async plan(id: string, req: ChangeRequest): Promise<ChangePlan> {
    const service = registered(this.store, id);
    if (!service) throw new ChangeError(404, "service/unknown", `No standalone instance or cluster ${id}.`);
    if (!CHANGE_KINDS.includes(req.kind as ChangeKind)) throw new ChangeError(400, "service-change/invalid", `kind is one of ${CHANGE_KINDS.join(", ")}.`);
    const kind = req.kind as ChangeKind;
    const { options, problems } = this.options(req.options, service);
    if (problems.length) throw new ChangeError(400, "service-change/invalid", "Some options are not valid.", problems);
    const chosen = this.selected(service, kind, req.members);
    const cluster = service.kind === "cluster";
    const context = checkContextOf(this.store, service);
    const rows = this.store.serviceMemberFiles(id);

    const found: ConfigFinding[] = [];
    let revision: number | null = null;
    let mode: ChangeMode = "rolling", fullBecause: ChangePlan["fullBecause"] = [];
    const files = new Map<string, PlanFile[]>();
    const differences = new Map<string, unknown[]>();
    const add = (member: string, list: readonly FileChange[], fileOf: (name: string) => Omit<PlanFile, keyof FileChange> | undefined) => {
      files.set(member, list.flatMap((f) => {
        const at = fileOf(f.name);
        if (f.change === "removed" || !at) { found.push({ severity: "error", code: "change/file-removed", message: `${member}: ${f.name} would go away, and a change only writes files.`, file: f.name, member, introduced: true }); return []; }
        return [{ ...f, ...at }];
      }));
    };

    if (kind === "apply" || kind === "overwrite") {
      const box = this.box;
      if (!box) throw new ChangeError(409, "config/no-key", "DEPLOYER_CREDENTIAL_ENCRYPTION_KEY is not set: configuration files cannot be opened.");
      if (!context.profile) throw new ChangeError(409, "service-change/no-profile", `${service.profile} is not a known profile.`);
      const kept = (rev: number, member: string, name: string): ConfigFileRecord | undefined => this.store.serviceConfig(id, rev)?.body.members.find((m) => installKey(m) === member)?.files.find((f) => f.name === name);
      if (kind === "apply") {
        const target = this.store.serviceConfig(id, typeof req.revision === "number" ? req.revision : undefined);
        if (!target) throw new ChangeError(404, "service-config/none", `No configuration${req.revision !== undefined ? ` revision ${String(req.revision)}` : ""} for ${id}.`);
        revision = target.revision;
        // What each member should have now, which in a rolling change may come from different revisions.
        const base: ConfigMember[] = target.body.members.map((m) => {
          const key = installKey(m);
          return { ...m, files: rows.filter((r) => r.member === key).flatMap((r) => kept(r.revision, key, r.file) ?? []) };
        });
        const checked = checkConfig({ ...context, profile: context.profile, members: openMembers(target.body.members, box), base: openMembers(base, box) });
        found.push(...checked.findings);
        mode = checked.change!.mode;
        fullBecause = checked.change!.fullBecause;
        const asked = new Set(chosen.map(installKey));
        for (const mc of checked.change!.members) {
          if (!asked.has(mc.member)) continue;
          const records = target.body.members.find((m) => installKey(m) === mc.member)!;
          add(mc.member, mc.files, (name) => {
            const rec = records.files.find((f) => f.name === name);
            const row = rows.find((r) => r.member === mc.member && r.file === name);
            return rec && { path: rec.path, baseSha256: row?.expectedSha256 ?? null, sha256: rec.sha256, revision: target.revision };
          });
          for (const f of mc.files) {
            const row = rows.find((r) => r.member === mc.member && r.file === f.name);
            if (row && hasDrifted(row)) found.push({ severity: "error", code: "change/drifted", message: `${mc.member}: ${f.name} on the host is not what is kept: adopt it or overwrite it first.`, file: f.name, member: mc.member, introduced: true });
          }
        }
        for (const [member, d] of fileDiffs(base, target.body.members, box).map((x) => [x.member, x.files] as const)) if (asked.has(member) && d.length) differences.set(member, d);
      } else {
        // Overwriting drift (§7): back to what each member should have; the base is what the host has, read now.
        for (const m of chosen) {
          const key = installKey(m), own = rows.filter((r) => r.member === key), off = own.filter(hasDrifted);
          if (!off.length) continue;
          let live;
          try { live = await readLive(this.handoff, m, own, off.map((r) => r.file), "plan", this.liveRead); } catch (error) {
            if (error instanceof DriftError) throw new ChangeError(409, error.code, error.message, error.details);
            throw error;
          }
          const targets = off.flatMap((r) => kept(r.revision, key, r.file) ?? []);
          const opened = (records: ConfigFileRecord[]) => openMembers([{ host: m.host, installDir: m.installDir, confDir: confDirOf(m), missing: [], files: records }], box)[0]!;
          const basis: CheckMember = { ...opened([]), files: live.flatMap((f) => (f.bytes && f.sha256 ? [{ name: f.name, sha256: f.sha256, bytes: f.bytes }] : [])) };
          const change = assessChange({ profile: context.profile, kind: service.kind, members: [opened(targets)], base: [basis] });
          if (change.mode === "full") { mode = "full"; fullBecause.push(...change.fullBecause); }
          add(key, change.members[0]?.files ?? [], (name) => {
            const row = off.find((r) => r.file === name)!, rec = targets.find((f) => f.name === name);
            return rec && { path: rec.path, baseSha256: live.find((f) => f.name === name)?.sha256 ?? null, sha256: rec.sha256, revision: row.revision };
          });
          differences.set(key, liveDifferences(m, live, (name) => targets.find((f) => f.name === name), box).files.map(({ sha256: _s, ...d }) => d));
        }
      }
      // §16.5 step 9: svc-write takes only the files of the conf directory, and bootstrap.conf where it was registered.
      for (const m of chosen) {
        const key = installKey(m), conf = confDirOf(m);
        for (const f of files.get(key) ?? []) {
          if (f.name !== "bootstrap.conf" && !f.path.startsWith(`${conf}/`)) found.push({ severity: "error", code: "change/outside-conf", message: `${key}: ${f.name} is at ${f.path}, outside the conf directory ${conf}: it cannot be written from here.`, file: f.name, member: key, introduced: true });
          const rec = kept(f.revision, key, f.name);
          if (rec && !openFile(rec, box).ok) found.push({ severity: "error", code: "config/reimport", message: `${key}: ${f.name} cannot be opened as kept: take the service over again to import it.`, file: f.name, member: key, introduced: true });
          if (f.name === "bootstrap.conf" && rec) {
            const opened = openFile(rec, box);
            const runAs = opened.ok ? effectiveProperties(opened.bytes).get("run.as")?.value.trim() : undefined;
            if (runAs && runAs !== m.serviceUser) found.push({ severity: "error", code: "change/run-as", message: `${key}: bootstrap.conf's run.as is ${runAs}, not the service user ${m.serviceUser ?? "(unknown)"}.`, file: f.name, member: key, introduced: true });
          }
        }
      }
      if (!this.handoff.canSeal) found.push({ severity: "error", code: "executor/no-encryption-key", message: "A write holds secrets and cannot be queued without DEPLOYER_CREDENTIAL_ENCRYPTION_KEY.", introduced: true });
    }

    const writes = kind === "apply" || kind === "overwrite";
    const capability = this.capabilityFindings(service, kind, chosen, writes);
    found.push(...capability.findings);
    // S31's flow is step 11b: the plan already says what the change would be.
    if (mode === "full") found.push({ severity: "error", code: "change/full-not-yet", message: "This change has to stop and start the whole cluster, which this version cannot do yet.", introduced: true });

    const planned = (writes ? chosen.filter((m) => files.get(installKey(m))?.length) : chosen).map((m): PlanMember => {
      const key = installKey(m), own = files.get(key) ?? [];
      const restart = kind === "restart" || kind === "rolling-restart" || own.some((f) => f.restart);
      return { member: key, host: m.host, restart, files: own, stages: stagesFor(kind, cluster, { restart, files: own }, options.offload), ...(differences.has(key) ? { differences: differences.get(key)! } : {}) };
    });
    const hash = createHash("sha256").update(JSON.stringify({ kind, revision, mode, fullBecause, options, members: planned.map((m) => ({ member: m.member, restart: m.restart, files: m.files.map((f) => [f.name, f.path, f.baseSha256, f.sha256, f.revision]) })) })).digest("hex");
    return {
      service: id, kind, revision, mode, fullBecause, restart: planned.some((m) => m.restart), members: planned,
      order: cluster && planned.length > 1 ? "One node at a time: ordinary nodes first, the primary node and the coordinator last, decided each round." : "As listed.",
      options, findings: found, blocking: blockingFindings(found), executors: capability.executors, empty: planned.length === 0, planHash: hash,
    };
  }

  // --- starting and the people's buttons ---------------------------------------------------------------------------

  async start(id: string, req: ChangeRequest & { planHash?: unknown }, reason: string | null, actor: Actor): Promise<ServiceChange> {
    const plan = await this.plan(id, req);
    if (typeof req.planHash !== "string") throw new ChangeError(400, "service-change/invalid", "Give the planHash of the plan you looked at.");
    if (plan.planHash !== req.planHash) throw new ChangeError(409, "service-change/plan-changed", "The plan has changed since you looked at it: look at it again.");
    if (plan.blocking.length) throw new ChangeError(409, "service-change/blocked", "The plan has errors that stop it.", plan.blocking.map((f) => `${f.code}: ${f.message}`));
    if (plan.empty) throw new ChangeError(409, "service-change/nothing", "There is nothing to do: every member already has this.");
    const change = this.store.createServiceChange({
      id: `chg-${this.iso().replace(/[-:TZ.]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`,
      service: id, kind: plan.kind, revision: plan.revision, mode: plan.mode, phase: "gate", plan, options: plan.options, reason, progress: newProgress(),
      text: `${plan.kind} started${plan.revision !== null ? ` (revision ${plan.revision})` : ""}${reason ? `: ${reason}` : ""}`,
    }, actor);
    this.advanceSafely(change);
    return this.store.serviceChange(id, change.id)!;
  }

  private mine(id: string, change: string): ServiceChange {
    const c = this.store.serviceChange(id, change);
    if (!c) throw new ChangeError(404, "service-change/unknown", `No change ${change} of ${id}.`);
    return c;
  }

  /** Goes on from what the hosts have (§16.3): paused at a member's end, on with the next; stopped in the middle of one, it is looked at first. */
  resume(id: string, change: string, actor: Actor): ServiceChange {
    const c = this.mine(id, change);
    if (c.state !== "paused" && c.state !== "stopped") throw new ChangeError(409, "service-change/state", `This change is ${c.state}: there is nothing to continue.`);
    const p = c.progress as ChangeProgress;
    Object.assign(p, { resume: false, rollingBack: false, stuck: null, intent: "forward", probes: {}, nextProbe: null, stableSince: null, nudge: null, invalidHigh: false });
    this.save(c, { state: "running", phase: c.currentMember ? "reconcile" : "gate", message: null });
    this.store.audit(actor, "service.change-continued", `${id}/${change}`, { member: c.currentMember });
    this.event(c, "change-resumed", c.currentMember, `Change continued by ${actor.id}`);
    this.advanceSafely(c);
    return this.store.serviceChange(id, change)!;
  }

  /** Stops where it is. A job an executor has taken may still finish: that is why going on looks at the hosts first. */
  halt(id: string, change: string, actor: Actor): ServiceChange {
    const c = this.mine(id, change);
    if (c.state !== "running" && c.state !== "paused") throw new ChangeError(409, "service-change/state", `This change is ${c.state}: there is nothing to stop.`);
    this.store.audit(actor, "service.change-stopped", `${id}/${change}`, { member: c.currentMember });
    const step = this.store.runningServiceChangeStep(c.id);
    if (step) this.closeStep(step, "failed", `Stopped by ${actor.id}`);
    this.stopHere(c, `Stopped by ${actor.id}`);
    return this.store.serviceChange(id, change)!;
  }

  /** §7: this member back to its backup and started, by a person, after a stop. */
  rollback(id: string, change: string, actor: Actor): ServiceChange {
    const c = this.mine(id, change);
    if (c.state !== "stopped") throw new ChangeError(409, "service-change/state", `This change is ${c.state}: only a stopped change is rolled back.`);
    const pm = (c.plan as ChangePlan).members.find((m) => m.member === c.currentMember);
    if (!pm?.files.length) throw new ChangeError(409, "service-change/nothing-to-roll-back", "No member's files are in the middle of this change: there is nothing to put back. Continue or close it.");
    const p = c.progress as ChangeProgress;
    Object.assign(p, { resume: false, stuck: null, intent: "rollback", rollingBack: true, probes: {}, nextProbe: null, stableSince: null, nudge: null, invalidHigh: false });
    this.save(c, { state: "running", phase: "reconcile", message: null });
    this.store.audit(actor, "service.change-rollback", `${id}/${change}`, { member: c.currentMember });
    this.advanceSafely(c);
    return this.store.serviceChange(id, change)!;
  }

  /** §8: only when a stop timed out, only the very processes it named, and only by a person. The change stays stopped, to be continued. */
  forceKill(id: string, change: string, actor: Actor): ServiceChange {
    const c = this.mine(id, change);
    const p = c.progress as ChangeProgress;
    if (c.state !== "stopped" || !p.stuck || !c.currentMember) throw new ChangeError(409, "service-change/nothing-to-kill", "Only a change stopped on a NiFi that would not stop can kill it.");
    this.store.audit(actor, "service.change-force-kill", `${id}/${change}`, { member: c.currentMember, process: p.stuck });
    this.save(c, { state: "running", phase: "kill", message: null });
    this.advanceSafely(c);
    return this.store.serviceChange(id, change)!;
  }

  /** "Accept things as they are": frees the service for other changes. Members already done keep what they got. */
  close(id: string, change: string, actor: Actor): ServiceChange {
    const c = this.mine(id, change);
    if (c.state !== "stopped" && c.state !== "paused") throw new ChangeError(409, "service-change/state", `This change is ${c.state}: only a stopped or paused change is closed.`);
    const p = c.progress as ChangeProgress;
    this.store.audit(actor, "service.change-closed", `${id}/${change}`, { member: c.currentMember, done: p.done });
    this.finish(c, "closed", `Closed by ${actor.id} with things as they are${c.currentMember ? ` (${c.currentMember} was in the middle of it)` : ""}`);
    return this.store.serviceChange(id, change)!;
  }

  // --- what goes on by itself --------------------------------------------------------------------------------------

  /** The Deployer has just started: what is running finishes its current member and then waits for a person (§16.3). */
  recover() {
    for (const c of this.store.runningServiceChanges()) {
      (c.progress as ChangeProgress).resume = true;
      this.save(c);
    }
  }

  /** Every 2 seconds. Looks only at the database, and at nothing that is not due. */
  tick() {
    this.handoff.expireQueued();
    for (const c of this.store.runningServiceChanges()) this.advanceSafely(c);
  }

  private advanceSafely(c: ServiceChange) {
    try { this.advance(c); } catch (error) {
      console.error(`service change ${c.id}:`, error);
      const step = this.store.runningServiceChangeStep(c.id);
      if (step) this.closeStep(step, "failed", (error as Error).message);
      this.stopHere(c, (error as Error).message);
    }
  }

  private advance(c: ServiceChange) {
    if (c.state !== "running") return;
    if (c.mode === "full") throw new Error("A full stop and start is not implemented yet (step 11b)."); // advanceFull in step 11b
    if (c.phase === "gate") this.gate(c);
    else if (c.phase === "reconcile") this.reconcile(c);
    else if (c.phase === "member") this.member(c);
    else if (c.phase === "finish") this.finishing(c);
    else if (c.phase === "kill") this.killing(c);
  }

  private save(c: ServiceChange, patch: Partial<Pick<ServiceChange, "state" | "phase" | "currentMember" | "message" | "finishedAt">> = {}) {
    Object.assign(c, patch);
    this.store.updateServiceChange(c.id, { state: c.state, phase: c.phase, currentMember: c.currentMember, message: c.message, finishedAt: c.finishedAt, progress: c.progress });
  }

  private event(c: ServiceChange, kind: string, member: string | null, text: string, detail: Record<string, unknown> = {}) {
    this.store.addServiceEvent({ service: c.service, member, at: this.iso(), kind, detail: { text, change: c.id, by: c.createdBy, ...detail } });
  }

  private closeStep(step: ServiceChangeStep, state: "succeeded" | "failed" | "timed-out", message?: string, detail: Record<string, unknown> = {}) {
    this.store.updateServiceChangeStep(step.change, step.seq, { state, finishedAt: this.iso(), detail: { ...step.detail, ...detail, ...(message ? { message } : {}) } });
    if (state !== "succeeded" && step.job && !FINAL.has(this.handoff.status(step.job)?.state ?? "")) this.handoff.cancelQueued(step.job, "Its change stopped before it was run.");
  }

  /** The change stops where it is; a person decides (continue, rollback, close). */
  private stopHere(c: ServiceChange, message: string) {
    const p = c.progress as ChangeProgress;
    this.dropProbes(p);
    this.save(c, { state: "stopped", message });
    this.event(c, "change-stopped", c.currentMember, `Change stopped: ${message}`);
  }

  private finish(c: ServiceChange, state: "succeeded" | "rolled-back" | "closed", message: string) {
    const p = c.progress as ChangeProgress;
    this.dropProbes(p);
    p.remaining = [];
    const member = c.currentMember;
    this.save(c, { state, phase: "done", currentMember: null, message, finishedAt: this.iso() });
    if (state === "rolled-back") this.event(c, "config-rolled-back", member, message);
    this.event(c, "change-finished", null, `Change ${state}: ${message}`, { state });
  }

  private member_(c: ServiceChange, key: string | null = c.currentMember): ServiceMember {
    const s = registered(this.store, c.service);
    const m = s && membersOf(s).find((x) => installKey(x) === key);
    if (!m) throw new Error(`${key} is no longer a member of ${c.service}`);
    return m;
  }

  private planMember(c: ServiceChange, key: string | null = c.currentMember): PlanMember {
    const m = (c.plan as ChangePlan).members.find((x) => x.member === key);
    if (!m) throw new Error(`${key} is not in the plan of ${c.id}`);
    return m;
  }

  private addStep(c: ServiceChange, step: string, member: string | null, deadlineMs: number, job: string | null = null): ServiceChangeStep {
    return this.store.addServiceChangeStep({ change: c.id, member, step, job, deadline: this.iso(deadlineMs), startedAt: this.iso() });
  }

  // --- looking at the hosts ------------------------------------------------------------------------------------------

  private dropProbes(p: ChangeProgress) {
    for (const job of Object.values(p.probes)) {
      if (FINAL.has(this.handoff.status(job)?.state ?? "")) this.handoff.drop(job);
      else this.handoff.cancelQueued(job, "Its change no longer waited for it.");
    }
    p.probes = {};
  }

  /** One round of svc-state over all the members: null until it is complete. Executors that are offline, or do not answer in time, are in view.problems. */
  private probe(c: ServiceChange): View | null {
    const p = c.progress as ChangeProgress;
    const s = registered(this.store, c.service);
    if (!s) throw new Error(`${c.service} is no longer registered`);
    const members = membersOf(s);
    if (!Object.keys(p.probes).length) {
      if (p.nextProbe && this.iso() < p.nextProbe) return null;
      for (const m of members) {
        if (!this.handoff.executor(m.host, "service").online) continue;
        const id = newJobId("svc-state", new Date(this.clock()));
        this.handoff.submit(id, { kind: "svc-state", member: installKey(m), change: c.id, expiresAt: this.iso(PROBE_WAIT_MS), requestedBy: c.createdBy }, m.host, "service");
        p.probes[installKey(m)] = id;
      }
      p.probedAt = this.iso();
      this.save(c);
      if (Object.keys(p.probes).length) return null;
    }
    const jobs = Object.values(p.probes);
    const overdue = this.clock() - Date.parse(p.probedAt!) > PROBE_WAIT_MS;
    if (!overdue && !jobs.every((j) => FINAL.has(this.handoff.status(j)?.state ?? ""))) return null;
    const answers = new Map<string, StateAnswer>(), problems = new Map<string, string>();
    for (const m of members) {
      const key = installKey(m), job = p.probes[key];
      if (!job) { problems.set(key, `the service executor of ${m.host} is offline`); continue; }
      const status = this.handoff.status(job);
      if (status?.state === "succeeded") answers.set(key, status.result as unknown as StateAnswer);
      else problems.set(key, status?.message ?? "svc-state was not answered in time");
    }
    this.dropProbes(p);
    p.nextProbe = this.iso(PROBE_EVERY_MS);
    this.save(c);
    return { answers, problems, nodes: bestTable(answers) };
  }

  private nodeOf(view: View, m: ServiceMember): ClusterNode | undefined {
    const self = view.answers.get(installKey(m))?.rest.cluster?.self;
    return view.nodes.find((n) => (self && n.nodeId === self) || (n.address === m.nodeAddress && n.apiPort === m.ports.https));
  }

  /** §16.3: an ordinary node first; only when just those are left the primary node, the coordinator last. */
  private pick(c: ServiceChange, s: Registered, view: View): PlanMember {
    const plan = c.plan as ChangePlan, done = (c.progress as ChangeProgress).done;
    const weight = (pm: PlanMember) => {
      const roles = this.nodeOf(view, membersOf(s).find((m) => installKey(m) === pm.member)!)?.roles ?? [];
      return (roles.includes(PRIMARY) ? 1 : 0) + (roles.includes(COORDINATOR) ? 2 : 0);
    };
    const left = plan.members.filter((m) => !done.includes(m.member));
    return left.reduce((a, b) => (weight(b) < weight(a) ? b : a));
  }

  /** What in a member's files is neither what the plan started from nor what it writes: someone changed it. */
  private filesChanged(pm: PlanMember, a: StateAnswer): string[] {
    return pm.files.filter((f) => { const live = liveHash(a, f); return live !== f.baseSha256 && live !== f.sha256; }).map((f) => f.name);
  }

  /** §16.3: the running process is the best source of how to start it again. */
  private keepStartSettings(c: ServiceChange, key: string, a: StateAnswer) {
    if (!a.process.running || !a.environment) return;
    this.store.setServiceMemberStart(c.service, key, filterStartEnvironment(a.environment).kept, a.limits ?? null);
  }

  /** The check before a member is touched: fails to stopped, with nothing done to it. */
  private gate(c: ServiceChange) {
    const p = c.progress as ChangeProgress;
    if (p.resume) { // the Deployer restarted between members
      const looking = this.store.runningServiceChangeStep(c.id);
      if (looking) this.closeStep(looking, "failed", "The Deployer restarted");
      this.dropProbes(p);
      this.save(c, { state: "paused", currentMember: null, message: "The Deployer restarted: press continue to go on with the next member." });
      this.event(c, "change-paused", null, c.message!);
      return;
    }
    const s = registered(this.store, c.service);
    if (!s) throw new Error(`${c.service} is no longer registered`);
    let step = this.store.runningServiceChangeStep(c.id);
    if (!step) step = this.addStep(c, "gate", null, (c.options as ChangeOptions).timeouts.gate * 1000);
    const offline = membersOf(s).map((m) => this.handoff.executor(m.host, "service")).find((e) => !e.online);
    const refuse = (message: string) => { this.closeStep(step!, "failed", message); this.stopHere(c, message); };
    if (offline) return refuse(`Before touching a member: the service executor of ${offline.host} is offline.`);
    const view = this.probe(c);
    if (!view || view.problems.size) {
      if (this.iso() <= step.deadline) return;
      return refuse(`Before touching a member: ${view ? [...view.problems].map(([k, v]) => `${k}: ${v}`).join("; ") : "svc-state was not answered"}.`);
    }
    const pm = this.pick(c, s, view);
    const m = membersOf(s).find((x) => installKey(x) === pm.member)!;
    const a = view.answers.get(pm.member)!;
    if (s.kind === "cluster") {
      if (!view.nodes.length) return refuse("Before touching a member: no node gives the cluster's nodes.");
      const others = s.nodes.filter((n) => installKey(n) !== pm.member);
      const away = others.filter((n) => this.nodeOf(view, n)?.status !== "CONNECTED").map(installKey);
      if (away.length) return refuse(`Before touching ${pm.member}: ${away.join(", ")} ${away.length > 1 ? "are" : "is"} not connected.`);
      if (!view.nodes.some((n) => n.roles.includes(COORDINATOR))) return refuse(`Before touching ${pm.member}: the cluster has no coordinator.`);
    }
    const changed = this.filesChanged(pm, a);
    if (changed.length) return refuse(`${pm.member}: ${changed.join(", ")} changed on the host since the plan: look at the plan again.`);
    const node = s.kind === "cluster" ? this.nodeOf(view, m) : undefined;
    const reported = [...view.answers.values()].map((x) => x.rest.invalidCount).find((n) => typeof n === "number");
    p.baseline = typeof a.rest.invalidCount === "number" ? a.rest.invalidCount : reported ?? null;
    p.nodeId = node?.nodeId ?? null;
    p.before = pairOf(a);
    p.wrote = false;
    p.remaining = nowStages(pm.stages, pm, a, p.before, node?.status ?? null);
    if (p.remaining.includes("disconnect") && !p.nodeId) return refuse(`Before touching ${pm.member}: the cluster does not list this node.`);
    this.keepStartSettings(c, pm.member, a);
    this.closeStep(step, "succeeded", undefined, { member: pm.member, roles: node?.roles ?? [], baseline: p.baseline });
    this.save(c, { phase: "member", currentMember: pm.member });
    this.member(c);
  }

  /** Continue and rollback after a stop start here: what the hosts have decides what is left. */
  private reconcile(c: ServiceChange) {
    const p = c.progress as ChangeProgress;
    const key = c.currentMember!;
    let step = this.store.runningServiceChangeStep(c.id);
    if (!step) step = this.addStep(c, "reconcile", key, (c.options as ChangeOptions).timeouts.gate * 1000);
    const refuse = (message: string) => { this.closeStep(step!, "failed", message); this.stopHere(c, message); };
    const view = this.probe(c);
    const a = view?.answers.get(key);
    if (!view || !a) {
      if (this.iso() <= step.deadline) return;
      return refuse(`Cannot look at ${key}: ${view?.problems.get(key) ?? "svc-state was not answered"}.`);
    }
    const pm = this.planMember(c), m = this.member_(c);
    const changed = this.filesChanged(pm, a);
    if (changed.length) return refuse(`${key}: ${changed.join(", ")} changed on the host since the plan: this needs a person. Close the change and plan again.`);
    p.wrote = pm.files.some((f) => liveHash(a, f) !== f.baseSha256);
    const node = this.nodeOf(view, m);
    if (node) p.nodeId = node.nodeId;
    if (p.intent === "rollback") p.remaining = rollbackStages(c.kind as ChangeKind, this.isCluster(c), pm, p.wrote, isRunning(a));
    else p.remaining = nowStages(pm.stages, pm, a, p.before, node?.status ?? null);
    if (p.remaining.includes("disconnect") && !p.nodeId) return refuse(`${key}: the cluster does not list this node.`);
    this.keepStartSettings(c, key, a);
    this.closeStep(step, "succeeded", undefined, { remaining: p.remaining });
    this.save(c, { phase: "member" });
    this.member(c);
  }

  private isCluster(c: ServiceChange) { return registered(this.store, c.service)?.kind === "cluster"; }

  // --- one member ------------------------------------------------------------------------------------------------------

  private member(c: ServiceChange): void {
    const p = c.progress as ChangeProgress;
    const stage = p.remaining[0];
    if (!stage) return this.memberDone(c);
    const open = this.store.runningServiceChangeStep(c.id);
    if (stage.startsWith("wait-")) {
      const step = open ?? this.addStep(c, stage, c.currentMember, (c.options as ChangeOptions).timeouts[STAGE_TIMEOUT[stage]] * 1000);
      return this.waiting(c, stage, step);
    }
    if (!open) return this.dispatch(c, stage);
    const status = open.job ? this.handoff.status(open.job) : undefined;
    if (status && FINAL.has(status.state)) return this.judge(c, stage, open, status);
    if (this.iso() > open.deadline) {
      const message = `${stage} on ${c.currentMember} timed out`;
      this.closeStep(open, "timed-out", message);
      return this.stopHere(c, `${message}: it may still be running there. Look at the host before going on.`);
    }
  }

  private expiry() { return this.iso(QUEUE_MS); }

  /** The job of a stage. The step is written first: a crash between the two leaves a step that times out, never a job nobody waits for. */
  private dispatch(c: ServiceChange, stage: Stage): void {
    const p = c.progress as ChangeProgress;
    const key = c.currentMember!, m = this.member_(c), pm = this.planMember(c);
    const seconds = (c.options as ChangeOptions).timeouts[STAGE_TIMEOUT[stage]];
    const base = { change: c.id, member: key, expiresAt: this.expiry(), requestedBy: c.createdBy };
    const control = { ...base, kind: "svc-control", timeoutSeconds: seconds };
    const who = { serviceUser: m.serviceUser, env: m.startEnvironment ?? {} };
    let request: Record<string, unknown>;
    if (stage === "disconnect") request = { ...control, action: "node-disconnect", nodeId: p.nodeId };
    else if (stage === "offload") request = { ...control, action: "node-offload", nodeId: p.nodeId };
    else if (stage === "stop") request = { ...control, action: "stop", ...who };
    else if (stage === "start") request = { ...control, action: "start", ...who, limits: m.startLimits ?? null };
    else if (stage === "restore") request = { ...base, kind: "svc-write", action: "restore" };
    else request = { ...base, kind: "svc-write", action: "apply", files: pm.files.map((f) => ({ name: f.name, path: f.path, baseSha256: f.baseSha256, sha256: f.sha256 })), content: this.contentOf(c, pm) };
    const job = newJobId(request.kind === "svc-write" ? "svc-write" : "svc-control", new Date(this.clock()));
    this.addStep(c, stage, key, QUEUE_MS + seconds * 1000 + GRACE_MS, job);
    this.handoff.submit(job, request, m.host, "service");
  }

  private contentOf(c: ServiceChange, pm: PlanMember): string {
    if (!this.box) throw new Error("DEPLOYER_CREDENTIAL_ENCRYPTION_KEY is not set: the files cannot be opened");
    const files = pm.files.map((f) => {
      const rec = this.store.serviceConfig(c.service, f.revision)?.body.members.find((m) => installKey(m) === pm.member)?.files.find((x) => x.name === f.name);
      const opened = rec && openFile(rec, this.box!);
      if (!opened?.ok) throw new Error(`${f.name} of ${pm.member} cannot be opened as kept`);
      return { name: f.name, base64: opened.bytes.toString("base64") };
    });
    return JSON.stringify({ files });
  }

  /** A job has ended. Its details stay out of the step: only names and what happened. */
  private judge(c: ServiceChange, stage: Stage, step: ServiceChangeStep, status: ExecutorStatus): void {
    const p = c.progress as ChangeProgress;
    const key = c.currentMember!;
    const result = (status.result ?? {}) as Record<string, unknown>;
    if (status.state === "succeeded") {
      this.closeStep(step, "succeeded", status.message);
      if (stage === "write") p.wrote = true;
      if (stage === "restore") p.wrote = false;
      if (stage === "stop" && !result.alreadyStopped) this.event(c, "node-stopped", key, `${key} stopped (change ${c.kind})`);
      if (stage === "start" && !result.alreadyRunning) this.event(c, "node-started", key, `${key} started (change ${c.kind})`);
      p.remaining.shift();
      p.stableSince = null;
      this.save(c);
      return this.member(c);
    }
    const message = `${stage} on ${key}: ${status.message ?? status.state}`;
    this.closeStep(step, "failed", message);
    if (stage === "stop" && result.stillRunning && result.process) p.stuck = result.process as ProcessPair;
    // Never reached the executor (it stayed offline past expiresAt, too old), or the executor died running it: the state of the host is not known, so a person looks.
    if (result.notRun === true || status.message === INTERRUPTED) return this.stopHere(c, message);
    if (p.rollingBack) return this.stopHere(c, `Rolling back failed: ${message}. This needs a person.`);
    if (stage === "write") return this.rollBack(c, message, { restore: result.rolledBack === false, stopped: true });
    if (stage === "start" && p.wrote) return this.rollBack(c, message, { restore: true, stopped: false });
    return this.stopHere(c, message);
  }

  /** §7: this member's files back from its backup and NiFi started, and the change ends there; members already done stay as they are. */
  private rollBack(c: ServiceChange, why: string, o: { restore: boolean; stopped: boolean }) {
    const p = c.progress as ChangeProgress;
    const pm = this.planMember(c);
    p.rollingBack = true;
    p.remaining = rollbackStages(c.kind as ChangeKind, this.isCluster(c), pm, o.restore, !o.stopped);
    p.stableSince = null;
    p.invalidHigh = false;
    this.save(c, { message: `Rolling back ${pm.member}: ${why}` });
    this.member(c);
  }

  /** A clear failure rolls back what was written; with nothing written there is nothing to go back to, so it just stops (§16.3). */
  private failedWait(c: ServiceChange, step: ServiceChangeStep, message: string) {
    const p = c.progress as ChangeProgress;
    this.closeStep(step, "failed", message);
    if (p.rollingBack) return this.stopHere(c, `Rolling back failed: ${message}. This needs a person.`);
    if (p.wrote) return this.rollBack(c, message, { restore: true, stopped: false });
    return this.stopHere(c, message);
  }

  private waiting(c: ServiceChange, stage: Stage, step: ServiceChangeStep): void {
    const p = c.progress as ChangeProgress;
    const key = c.currentMember!, m = this.member_(c);
    const options = c.options as ChangeOptions;
    const view = this.probe(c);
    if (view) {
      const a = view.answers.get(key);
      if (a && !isRunning(a)) return this.failedWait(c, step, `${key}: NiFi is not running any more`);
      let ready = false;
      if (a && stage === "wait-rest") {
        if (a.rest.state === "no-certificate" || a.rest.state === "no-https") {
          const message = `${key}: its REST API cannot be watched: ${a.rest.error ?? a.rest.state}`;
          this.closeStep(step, "failed", message);
          return this.stopHere(c, message);
        }
        ready = a.rest.state === "ok" || a.rest.state === "partial";
      }
      if (stage === "wait-connected") {
        ready = this.nodeOf(view, m)?.status === "CONNECTED";
        if (!ready) this.nudge(c, step, view, m);
      }
      if (stage === "wait-stable") {
        const s = registered(this.store, c.service)!;
        const up = s.kind === "standalone" ? a?.rest.state === "ok" : Boolean(view.nodes.length) && membersOf(s).every((n) => this.nodeOf(view, n)?.status === "CONNECTED") && view.nodes.some((n) => n.roles.includes(COORDINATOR));
        const invalid = a?.rest.invalidCount;
        const within = p.baseline === null || (typeof invalid === "number" && invalid <= p.baseline + options.invalidTolerance);
        p.invalidHigh = Boolean(up) && !within;
        if (up && within) {
          p.stableSince ??= this.iso();
          ready = this.clock() - Date.parse(p.stableSince) >= options.stableSeconds * 1000;
        } else p.stableSince = null;
        this.save(c);
      }
      if (ready) {
        this.closeStep(step, "succeeded");
        p.remaining.shift();
        p.stableSince = null;
        p.invalidHigh = false;
        p.nudge = null;
        p.nextProbe = null;
        this.save(c);
        return this.member(c);
      }
    }
    if (this.iso() > step.deadline) {
      if (stage === "wait-stable" && p.invalidHigh) return this.failedWait(c, step, `${key}: more invalid components than the ${p.baseline} before it (health check)`);
      const message = `${stage} on ${key} timed out`;
      this.closeStep(step, "timed-out", message);
      this.stopHere(c, `${message}: NiFi is left as it is. Continue, roll back or close.`);
    }
  }

  /** §16.3: a node that stays away may remember being disconnected by hand; another node is asked to connect it. Once, and it decides nothing by itself. */
  private nudge(c: ServiceChange, step: ServiceChangeStep, view: View, m: ServiceMember) {
    const p = c.progress as ChangeProgress;
    if (p.nudge || this.clock() - Date.parse(step.startedAt) < CONNECT_NUDGE_MS || !p.nodeId) return;
    const s = registered(this.store, c.service)!;
    const through = membersOf(s).find((n) => installKey(n) !== installKey(m) && this.nodeOf(view, n)?.status === "CONNECTED");
    if (!through) return;
    const id = newJobId("svc-control", new Date(this.clock()));
    p.nudge = id;
    this.save(c);
    this.store.updateServiceChangeStep(step.change, step.seq, { detail: { ...step.detail, nudge: { job: id, through: installKey(through) } } });
    this.handoff.submit(id, { kind: "svc-control", action: "node-connect", change: c.id, member: installKey(through), nodeId: p.nodeId, timeoutSeconds: 60, expiresAt: this.expiry(), requestedBy: c.createdBy }, through.host, "service");
  }

  private memberDone(c: ServiceChange): void {
    const p = c.progress as ChangeProgress;
    const key = c.currentMember!, pm = this.planMember(c);
    if (p.rollingBack) return this.finish(c, "rolled-back", c.message ?? `${key} rolled back`);
    if (pm.files.length) {
      this.store.setMemberFilesApplied(c.service, key, pm.files.map((f) => ({ file: f.name, path: f.path, sha256: f.sha256, revision: f.revision })), c.id);
      const names = pm.files.map((f) => f.name).join(", ");
      this.event(c, "config-applied", key, c.kind === "overwrite" ? `${names} on ${key} written back` : `Revision ${c.revision} applied to ${key} (${names})`, { revision: c.revision, files: pm.files.map((f) => f.name) });
    }
    p.done.push(key);
    p.remaining = [];
    p.before = null;
    p.nodeId = null;
    p.wrote = false;
    const plan = c.plan as ChangePlan;
    if (plan.members.every((m) => p.done.includes(m.member))) {
      p.pruning = plan.members.filter((m) => m.files.length).map((m) => m.member);
      this.save(c, { phase: "finish", currentMember: null });
      return this.finishing(c);
    }
    if (p.resume) {
      this.save(c, { state: "paused", phase: "gate", currentMember: null, message: "The Deployer restarted: press continue to go on with the next member." });
      return this.event(c, "change-paused", null, c.message!);
    }
    this.save(c, { phase: "gate", currentMember: null, message: null });
    this.gate(c);
  }

  /** §16.3: the old backups go only after a change succeeded. Its failing or not arriving does not undo the change. */
  private finishing(c: ServiceChange): void {
    const p = c.progress as ChangeProgress;
    const open = this.store.runningServiceChangeStep(c.id);
    if (open) {
      const status = open.job ? this.handoff.status(open.job) : undefined;
      const ended = status && FINAL.has(status.state);
      if (!ended && this.iso() <= open.deadline) return;
      this.closeStep(open, ended && status!.state === "succeeded" ? "succeeded" : "failed", status?.message);
    }
    const next = p.pruning.shift();
    if (!next) return this.finish(c, "succeeded", `${c.kind} finished on ${p.done.length} member(s)`);
    this.save(c);
    const job = newJobId("svc-write", new Date(this.clock()));
    this.addStep(c, "prune", next, 60_000, job);
    this.handoff.submit(job, { kind: "svc-write", action: "prune", change: c.id, member: next, expiresAt: this.iso(60_000), requestedBy: c.createdBy }, this.member_(c, next).host, "service");
  }

  /** §8: the kill a person asked for. Whatever comes of it, the change is stopped again, and continuing looks at the host. */
  private killing(c: ServiceChange): void {
    const p = c.progress as ChangeProgress;
    const key = c.currentMember!, m = this.member_(c);
    const open = this.store.runningServiceChangeStep(c.id);
    if (!open) {
      const job = newJobId("svc-control", new Date(this.clock()));
      this.addStep(c, "kill", key, QUEUE_MS + 60_000 + GRACE_MS, job);
      this.handoff.submit(job, { kind: "svc-control", action: "kill", change: c.id, member: key, ...p.stuck, timeoutSeconds: 60, expiresAt: this.expiry(), requestedBy: c.createdBy }, m.host, "service");
      return;
    }
    const status = open.job ? this.handoff.status(open.job) : undefined;
    if (status && FINAL.has(status.state)) {
      const killed = status.state === "succeeded";
      this.closeStep(open, killed ? "succeeded" : "failed", status.message);
      if (killed) p.stuck = null;
      if (killed) this.event(c, "node-stopped", key, `${key} killed by a person's decision`, { killed: (status.result as unknown as { killed?: unknown }).killed ?? null });
      this.save(c, { phase: "member" });
      return this.stopHere(c, killed ? `${key} was killed: continue to go on.` : `The kill on ${key}: ${status.message ?? status.state}`);
    }
    if (this.iso() > open.deadline) {
      this.closeStep(open, "timed-out", `The kill on ${key} timed out`);
      this.save(c, { phase: "member" });
      this.stopHere(c, `The kill on ${key} timed out`);
    }
  }

  /** Whether changes hold a host, or any host: what upgrades of an executor or of the Deployer wait for (§16.3). A stopped one holds nothing at work, so it does not count. */
  working(host?: string): ServiceChange[] {
    return this.store.activeServiceChanges().filter((c) => {
      if (c.state === "stopped") return false;
      if (!host) return true;
      const s = registered(this.store, c.service);
      return Boolean(s) && membersOf(s!).some((m) => m.host === host);
    });
  }
}

/** The stages that take a member back. Without a restart in the plan, only the files. */
function rollbackStages(kind: ChangeKind, cluster: boolean, pm: PlanMember, restore: boolean, running: boolean): Stage[] {
  const restart = kind === "restart" || kind === "rolling-restart" || pm.restart;
  if (!restart) return restore ? ["restore"] : [];
  const start: Stage[] = restore || !running ? ["start"] : [];
  return [...(restore ? (["restore"] as Stage[]) : []), ...(restore && running ? (["stop"] as Stage[]) : []), ...start, "wait-rest", ...(cluster ? (["wait-connected"] as Stage[]) : [])];
}

/** The cluster as the node that knows best says it: one connected by its own account, with a coordinator; else whoever answers. */
function bestTable(answers: Map<string, StateAnswer>): ClusterNode[] {
  const tables = [...answers.values()].flatMap((a) => (a.rest.cluster?.nodes?.length ? [a.rest.cluster] : []));
  const connected = tables.filter((t) => t.nodes.find((n) => n.nodeId === t.self)?.status === "CONNECTED");
  const best = connected.find((t) => t.nodes.some((n) => n.roles.includes(COORDINATOR))) ?? connected[0] ?? tables[0];
  return best?.nodes ?? [];
}

/** A change as pages and tools get it: no file hashes, no working state, no start environment. */
export function changeView(c: ServiceChange, steps?: readonly ServiceChangeStep[]) {
  const { plan, progress, ...rest } = c;
  const p = progress as ChangeProgress;
  const { planHash: _h, ...shown } = planView(plan as ChangePlan);
  return {
    ...rest, plan: shown,
    progress: { done: p.done, remaining: p.remaining, rollingBack: p.rollingBack, canForceKill: c.state === "stopped" && Boolean(p.stuck), canRollBack: c.state === "stopped" && Boolean((plan as ChangePlan).members.find((m) => m.member === c.currentMember)?.files.length) },
    ...(steps ? { steps: steps.map(({ change: _c, ...s }) => s) } : {}),
  };
}

/** A plan as pages and tools get it: without the files' hashes (§16.3: the AI gets none, and no page needs them). */
export function planView(plan: ChangePlan) {
  return { ...plan, members: plan.members.map((m) => ({ ...m, files: m.files.map(({ baseSha256: _b, sha256: _s, ...f }) => f) })) };
}
