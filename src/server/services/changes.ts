// Service ops §7, §8, §16.3: the change engine. A change (applying a revision, overwriting drift, a restart, a rolling
// restart, a start or a stop) is planned, then carried out one member at a time by tick(), which looks only at the
// database: the change, its steps, and the executor jobs they wait for. Nothing lives in memory, so a Deployer restart
// loses nothing, and the executors know no flow: each job is one thing to do, and each is safe to repeat. Before a
// member is touched the cluster is looked at afresh (svc-state): ordinary nodes go first and the primary node and the
// coordinator last, since those roles move while it rolls. A step that fails for a clear reason rolls that member back
// and stops; a step past its deadline just stops, since what happened on the host is not known. Going on (continue)
// always compares with what the hosts have first. mode "full" (S31) shares the tables, the lock and the routes: every node
// stopped one by one, every node backed up, every file written, every node started at once, and the cluster waited for.
// Its rule above the others: no node starts while the nodes' files are a mix of old and new.

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
export const DEFAULT_TIMEOUTS = { disconnect: 60, offload: 900, stop: 120, rest: 600, connect: 600, write: 120, start: 300, stable: 300, gate: 180, compose: 900 };
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
const ELECTION_WAIT = "nifi.cluster.flow.election.max.wait.time";
const UNIT_SECONDS: [RegExp, number][] = [[/^(ns|nano)/, 1e-9], [/^(ms|milli)/, 1e-3], [/^s/, 1], [/^m/, 60], [/^h/, 3600], [/^d/, 86400], [/^w/, 604800]];
/** A NiFi duration ("5 mins") in seconds; null when it is not one. */
function durationSeconds(text: string | undefined): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/i.exec(text?.trim() ?? "");
  const unit = m && UNIT_SECONDS.find(([re]) => re.test(m[2]!.toLowerCase()));
  return m && unit ? Number(m[1]) * unit[1] : null;
}

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
  /** The rest is a full change's: whether a node has been touched, the jobs sent at once, what the last look saw (nothing secret, no hash), and what the cluster is still short of. */
  touched?: boolean; batch?: Batch | null; seen?: Seen | null; composing?: string | null;
  /** The Deployer restarted before any file was written: the jobs executors had taken are let end, then the nodes are looked at, then it pauses (step 14b). */
  settling?: boolean; settleFailed?: string[];
}
interface Batch { stage: string; members: string[]; ended: Record<string, "ok" | "failed" | "unknown">; why: string[] }
interface Seen { at: string; members: Record<string, { running: boolean | null; files: "old" | "new" | "mixed" | "changed" | "unknown"; status: string | null }>; coordinator: boolean; primary: boolean }
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
  const encrypted: Record<string, number> = {};
  for (const s of store.latestServiceSamples(service.id)) {
    const body = s.body as { host?: { memory?: { totalBytes?: unknown } }; flow?: { encrypted?: unknown } };
    const total = body.host?.memory?.totalBytes;
    const m = members.find((x) => installKey(x) === s.member);
    if (m && typeof total === "number") memory[m.host] = total;
    // P15: how many enc{…} values the flow holds. An older executor's samples have no flow: not known.
    const n = body.flow?.encrypted;
    if (m && typeof n === "number" && Number.isInteger(n) && n >= 0) encrypted[s.member] = n;
  }
  return { profile: profileById(service.profile), version: service.version, kind: service.kind, others, memory, encrypted };
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
  private capabilityFindings(service: Registered, kind: ChangeKind, chosen: ServiceMember[], writes: boolean, full: boolean): { findings: ConfigFinding[]; executors: ChangePlan["executors"] } {
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
      if (service.kind === "cluster" && kind !== "start" && !full && control && !control.operatorCert) error("change/no-operator-cert", `${m.host}: the service executor has no operator certificate (EXECUTOR_NIFI_OPERATOR_CERT): it cannot disconnect a node.`, key);
      if (kind !== "stop" && !m.startEnvironment) out.push({ severity: "warning", code: "change/no-start-env", message: `${key}: no start environment is known (it never ran under the Deployer's eye): NiFi starts with what its own scripts set.`, member: key, introduced: true });
    }
    return { findings: out, executors };
  }

  async plan(id: string, req: ChangeRequest): Promise<ChangePlan> {
    const service = registered(this.store, id);
    if (!service) throw new ChangeError(404, "service/unknown", `No standalone instance or cluster ${id}.`);
    if (!CHANGE_KINDS.includes(req.kind as ChangeKind)) throw new ChangeError(400, "service-change/invalid", `kind is one of ${CHANGE_KINDS.join(", ")}.`);
    const kind = req.kind as ChangeKind;
    const parsed = this.options(req.options, service);
    let options = parsed.options;
    const problems = parsed.problems;
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
    const electionWaits: (number | null)[] = [];
    const waitsOf = (m: CheckMember) => {
      const bytes = m.files.find((f) => f.name === "nifi.properties")?.bytes;
      if (bytes) electionWaits.push(durationSeconds(effectiveProperties(bytes).get(ELECTION_WAIT)?.value));
    };
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
        const openedTarget = openMembers(target.body.members, box), openedBase = openMembers(base, box);
        for (const m of [...openedTarget, ...openedBase]) waitsOf(m);
        const checked = checkConfig({ ...context, profile: context.profile, members: openedTarget, base: openedBase });
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
          waitsOf(opened(targets));
          waitsOf(basis);
          if (change.mode === "full") {
            mode = "full";
            for (const f of change.fullBecause) if (!fullBecause.some((x) => x.file === f.file && x.key === f.key)) fullBecause.push(f);
          }
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
    const full = mode === "full";
    const capability = this.capabilityFindings(service, kind, chosen, writes, full);
    found.push(...capability.findings);
    if (full) {
      // S31: the whole cluster or nothing, and no node is disconnected first, so nothing to offload.
      if (chosen.length < membersOf(service).length) found.push({ severity: "error", code: "config/full-needs-all-members", message: "This change stops and starts the whole cluster, so it cannot be limited to some members.", introduced: true });
      if (options.offload) found.push({ severity: "warning", code: "change/full-no-offload", message: "Offload does not apply: the whole cluster stops, and nothing is disconnected first.", introduced: true });
      // §16.3: long enough for the flow election to end by waiting, under the old settings or the new (rolling back waits too).
      const asked = (req.options as { timeouts?: { compose?: unknown } } | undefined)?.timeouts?.compose;
      const wait = Math.max(0, ...electionWaits.map((x) => x ?? 300));
      const compose = asked !== undefined ? options.timeouts.compose : Math.min(TIMEOUT_MAX, Math.max(DEFAULT_TIMEOUTS.compose, Math.ceil(wait) + 600));
      options = { ...options, offload: false, timeouts: { ...options.timeouts, compose } };
    }

    const planned = (writes && !full ? chosen.filter((m) => files.get(installKey(m))?.length) : chosen).map((m): PlanMember => {
      const key = installKey(m), own = files.get(key) ?? [];
      const restart = full || kind === "restart" || kind === "rolling-restart" || own.some((f) => f.restart);
      const stages: Stage[] = full ? ["stop", ...(own.length ? (["write"] as Stage[]) : []), "start"] : stagesFor(kind, cluster, { restart, files: own }, options.offload);
      return { member: key, host: m.host, restart, files: own, stages, ...(differences.has(key) ? { differences: differences.get(key)! } : {}) };
    });
    const hash = createHash("sha256").update(JSON.stringify({ kind, revision, mode, fullBecause, options, members: planned.map((m) => ({ member: m.member, restart: m.restart, files: m.files.map((f) => [f.name, f.path, f.baseSha256, f.sha256, f.revision]) })) })).digest("hex");
    return {
      service: id, kind, revision, mode, fullBecause, restart: planned.some((m) => m.restart), members: planned,
      order: full ? "The whole cluster: every node stopped one by one (ordinary nodes first, the primary node and the coordinator last), every file written, then all started at once." : cluster && planned.length > 1 ? "One node at a time: ordinary nodes first, the primary node and the coordinator last, decided each round." : "As listed.",
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
    if (c.mode === "full") Object.assign(p, { batch: null, composing: null, settling: false, settleFailed: [] });
    this.save(c, { state: "running", phase: c.mode === "full" || c.currentMember ? "reconcile" : "gate", ...(c.mode === "full" ? { currentMember: null } : {}), message: null });
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
    for (const step of this.openSteps(c)) this.closeStep(step, "failed", `Stopped by ${actor.id}`);
    this.stopHere(c, `Stopped by ${actor.id}`);
    return this.store.serviceChange(id, change)!;
  }

  /** §7: this member back to its backup and started, by a person, after a stop. */
  rollback(id: string, change: string, actor: Actor): ServiceChange {
    const c = this.mine(id, change);
    if (c.mode === "full") return this.rollbackFull(c, actor);
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
  close(id: string, change: string, actor: Actor, filesMayBeMixed = false): ServiceChange {
    const c = this.mine(id, change);
    if (c.state !== "stopped" && c.state !== "paused") throw new ChangeError(409, "service-change/state", `This change is ${c.state}: only a stopped or paused change is closed.`);
    const p = c.progress as ChangeProgress;
    // §16.3: a full change may leave the nodes with old and new values side by side; closing that takes saying so.
    const mixed = c.mode === "full" && p.wrote;
    if (mixed && !filesMayBeMixed) throw new ChangeError(409, "service-change/files-mixed", "Writing the files has begun and they are not back: the nodes may hold old and new values side by side. Close only if you accept that (filesMayBeMixed), or continue or roll back.");
    this.store.audit(actor, "service.change-closed", `${id}/${change}`, { member: c.currentMember, done: p.done, ...(mixed ? { filesMayBeMixed: true } : {}) });
    this.finish(c, "closed", `Closed by ${actor.id} with things as they are${c.currentMember ? ` (${c.currentMember} was in the middle of it)` : ""}${mixed ? ": the nodes' files may be a mix of old and new" : ""}`);
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
      for (const step of this.openSteps(c)) this.closeStep(step, "failed", (error as Error).message);
      this.stopHere(c, (error as Error).message);
    }
  }

  private advance(c: ServiceChange) {
    if (c.state !== "running") return;
    if (c.mode === "full") return this.advanceFull(c);
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
    p.batch = null;
    this.save(c, { state: "stopped", message });
    this.event(c, "change-stopped", c.currentMember, `Change stopped: ${message}`);
  }

  private finish(c: ServiceChange, state: "succeeded" | "rolled-back" | "closed", message: string) {
    const p = c.progress as ChangeProgress;
    this.dropProbes(p);
    p.remaining = [];
    p.batch = null;
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

  private openSteps(c: ServiceChange) { return this.store.serviceChangeSteps(c.id).filter((s) => s.state === "running"); }

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
    const left = plan.members.filter((m) => !done.includes(m.member));
    return left.reduce((a, b) => (this.weight(s, view, b.member) < this.weight(s, view, a.member) ? b : a));
  }

  private weight(s: Registered, view: View, key: string) {
    const roles = this.nodeOf(view, membersOf(s).find((m) => installKey(m) === key)!)?.roles ?? [];
    return (roles.includes(PRIMARY) ? 1 : 0) + (roles.includes(COORDINATOR) ? 2 : 0);
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
    if (stage === "disconnect" || stage === "offload") {
      // Step 14 on 2.5.0: once disconnected, a node answers its own cluster endpoints with 404 ("Only a node connected to a
      // cluster can process the request"), so it cannot confirm its own disconnect. Another member asks and watches; the
      // gate has just seen every other member CONNECTED. A one-node cluster has nobody else and goes through itself.
      const through = membersOf(registered(this.store, c.service)!).find((n) => installKey(n) !== key) ?? m;
      const job = newJobId("svc-control", new Date(this.clock()));
      const step = this.addStep(c, stage, key, QUEUE_MS + seconds * 1000 + GRACE_MS, job);
      this.store.updateServiceChangeStep(step.change, step.seq, { detail: { ...step.detail, through: installKey(through) } });
      this.handoff.submit(job, { ...control, member: installKey(through), action: stage === "disconnect" ? "node-disconnect" : "node-offload", nodeId: p.nodeId }, through.host, "service");
      return;
    }
    if (stage === "stop") request = { ...control, action: "stop", ...who };
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

  // --- the whole cluster (S31, §8, §16.3) ------------------------------------------------------------------------------

  /** Phases: gate, check, stopping, backup, write, verify, start, compose, finish; rolling back: stopping, restore, verify, start, compose; and reconcile, kill. */
  private advanceFull(c: ServiceChange): void {
    const p = c.progress as ChangeProgress;
    if (p.resume && c.phase !== "kill" && c.phase !== "finish") {
      // The Deployer restarted. Before any file was written a person chooses; after that, service comes first and it goes
      // on, unless a deadline passed meanwhile: then what happened is not known, and it stops with nothing rolled back.
      if (!p.wrote && !p.rollingBack) return this.pauseFull(c);
      const late = this.openSteps(c).filter((s) => this.iso() > s.deadline);
      if (late.length) {
        for (const s of this.openSteps(c)) this.closeStep(s, "timed-out", "The Deployer was away past its deadline");
        return this.stopHere(c, `The Deployer was away past the deadline of ${[...new Set(late.map((s) => s.step))].join(", ")}: nothing is rolled back by itself. Look at the nodes, then continue, roll back or close.`);
      }
      p.resume = false;
      this.save(c);
    }
    if (c.phase === "gate") this.fullGate(c);
    else if (c.phase === "check") this.fullCheck(c);
    else if (c.phase === "stopping") this.fullStopping(c);
    else if (c.phase === "backup") this.fullBackup(c);
    else if (c.phase === "write") this.fullWrite(c);
    else if (c.phase === "restore") this.fullRestore(c);
    else if (c.phase === "verify") this.fullVerify(c);
    else if (c.phase === "start") this.fullStart(c);
    else if (c.phase === "compose") this.fullCompose(c);
    else if (c.phase === "reconcile") this.fullReconcile(c);
    else if (c.phase === "finish") this.finishing(c);
    else if (c.phase === "kill") this.killing(c);
  }

  /**
   * The Deployer restarted before any file was written: a person chooses. But a job an executor took before the restart
   * goes on there (step 14b: a stop did), so first each such job is let end and its step gets what the executor says,
   * then the nodes are looked at for the page, then it pauses. One not taken yet is called back. A stop that failed or is
   * past its deadline stops the change, as it would have without the restart.
   */
  private pauseFull(c: ServiceChange) {
    const p = c.progress as ChangeProgress;
    if (!p.settling) {
      this.dropProbes(p); // asked before the restart: an old story
      Object.assign(p, { settling: true, nextProbe: null, batch: null });
      this.save(c);
    }
    let waiting = false;
    const failed = (p.settleFailed ??= []);
    for (const s of this.openSteps(c)) {
      const status = s.job ? this.handoff.status(s.job) : undefined;
      if (!s.job || (!this.handoff.taken(s.job) && !FINAL.has(status?.state ?? ""))) {
        this.closeStep(s, "failed", s.job ? "The Deployer restarted before an executor took it" : "The Deployer restarted");
        continue;
      }
      const result = (status?.result ?? {}) as Record<string, unknown>;
      if (status && FINAL.has(status.state)) {
        if (status.state === "succeeded") {
          this.closeStep(s, "succeeded", status.message);
          if (s.step === "stop" && !result.alreadyStopped) this.event(c, "node-stopped", s.member, `${s.member} stopped (the whole cluster stops)`);
        } else {
          const message = `${s.step} on ${s.member}: ${status.message ?? status.state}`;
          this.closeStep(s, "failed", message);
          if (s.step === "stop") {
            if (result.stillRunning && result.process) { p.stuck = result.process as ProcessPair; c.currentMember = s.member; } // the kill button's
            failed.push(message);
          }
        }
      } else if (this.iso() > s.deadline) {
        const message = `${s.step} on ${s.member} timed out`;
        this.closeStep(s, "timed-out", message);
        if (s.step === "stop") failed.push(`${message}: it may still be running there`);
      } else waiting = true;
    }
    this.save(c);
    if (waiting) return;
    const view = this.probe(c);
    if (!view) return;
    this.note(c, view);
    Object.assign(p, { settling: false, settleFailed: [], resume: false });
    if (failed.length) return this.stopHere(c, `The Deployer restarted, and then ${failed.join("; ")}.`);
    this.save(c, { state: "paused", currentMember: null, message: "The Deployer restarted before any file was written: continue, or roll back to start what was stopped." });
    this.event(c, "change-paused", null, c.message!);
  }

  private rollbackFull(c: ServiceChange, actor: Actor): ServiceChange {
    if (c.state !== "stopped" && c.state !== "paused") throw new ChangeError(409, "service-change/state", `This change is ${c.state}: only a stopped or paused change is rolled back.`);
    const p = c.progress as ChangeProgress;
    Object.assign(p, { resume: false, settling: false, settleFailed: [], stuck: null, intent: "rollback", rollingBack: true, batch: null, composing: null, probes: {}, nextProbe: null, stableSince: null, invalidHigh: false });
    this.save(c, { state: "running", phase: "reconcile", currentMember: null, message: "Rolling back the whole cluster, by a person's decision" });
    this.store.audit(actor, "service.change-rollback", `${c.service}/${c.id}`, { member: null });
    this.advanceSafely(c);
    return this.store.serviceChange(c.service, c.id)!;
  }

  /** The one automatic rollback (§16.3): whatever runs stopped, the files back when any was written, everything started. It is not tried again. */
  private rollBackFull(c: ServiceChange, why: string): void {
    const p = c.progress as ChangeProgress;
    Object.assign(p, { rollingBack: true, intent: "rollback", batch: null, composing: null, stableSince: null, invalidHigh: false, nextProbe: null });
    this.save(c, { phase: "stopping", currentMember: null, message: `Rolling back the whole cluster: ${why}` });
    this.fullStopping(c);
  }

  private fullService(c: ServiceChange) {
    const s = registered(this.store, c.service);
    if (!s) throw new Error(`${c.service} is no longer registered`);
    return s;
  }

  private filesOf(pm: PlanMember) { return pm.files.map((f) => ({ name: f.name, path: f.path, baseSha256: f.baseSha256, sha256: f.sha256 })); }

  /** What this look saw, kept for the page: the views themselves hold start environments and go. */
  private note(c: ServiceChange, view: View) {
    const p = c.progress as ChangeProgress;
    const s = this.fullService(c);
    const members: Seen["members"] = {};
    for (const pm of (c.plan as ChangePlan).members) {
      const a = view.answers.get(pm.member), m = membersOf(s).find((x) => installKey(x) === pm.member);
      const stand = a && fileStand(pm, a);
      members[pm.member] = {
        running: a ? isRunning(a) : null, status: (m && this.nodeOf(view, m)?.status) ?? null,
        files: !stand ? "unknown" : stand.changed.length ? "changed" : stand.written ? "new" : stand.old ? "old" : "mixed",
      };
    }
    p.seen = { at: this.iso(), members, coordinator: view.nodes.some((n) => n.roles.includes(COORDINATOR)), primary: view.nodes.some((n) => n.roles.includes(PRIMARY)) };
    this.save(c);
  }

  /** A step's look over all the members, held open until it is complete. Returns the view when all have answered; past the deadline it says so through `late`. */
  private look(c: ServiceChange, step: ServiceChangeStep, late: (message: string) => void): View | null {
    const view = this.probe(c);
    if (view && !view.problems.size) {
      this.note(c, view);
      return view;
    }
    if (view) this.note(c, view);
    if (this.iso() > step.deadline) late(view ? [...view.problems].map(([k, v]) => `${k}: ${v}`).join("; ") : "svc-state was not answered");
    return null;
  }

  /** Jobs sent to several members at once, each its own step. Ended when all have ended, since nothing else may run beside them. */
  private runBatch(c: ServiceChange, seconds: number, request: (pm: PlanMember, m: ServiceMember) => Record<string, unknown>, succeeded?: (key: string, status: ExecutorStatus) => void): Batch | null {
    const p = c.progress as ChangeProgress;
    const b = p.batch!;
    const open = this.openSteps(c);
    for (const key of b.members) {
      if (b.ended[key] || open.some((s) => s.member === key)) continue;
      const m = this.member_(c, key);
      const body = { ...request(this.planMember(c, key), m), change: c.id, member: key, expiresAt: this.expiry(), requestedBy: c.createdBy };
      const job = newJobId((body as { kind?: unknown }).kind === "svc-write" ? "svc-write" : "svc-control", new Date(this.clock()));
      this.addStep(c, b.stage, key, QUEUE_MS + seconds * 1000 + GRACE_MS, job); // written first, as in dispatch
      this.handoff.submit(job, body, m.host, "service");
    }
    for (const step of open) {
      const key = step.member!;
      const status = step.job ? this.handoff.status(step.job) : undefined;
      if (status && FINAL.has(status.state)) {
        if (status.state === "succeeded") {
          this.closeStep(step, "succeeded", status.message);
          b.ended[key] = "ok";
          succeeded?.(key, status);
        } else {
          const message = `${b.stage} on ${key}: ${status.message ?? status.state}`;
          this.closeStep(step, "failed", message);
          const result = (status.result ?? {}) as Record<string, unknown>;
          b.ended[key] = result.notRun === true || status.message === INTERRUPTED ? "unknown" : "failed";
          b.why.push(message);
        }
      } else if (this.iso() > step.deadline) {
        const message = `${b.stage} on ${key} timed out`;
        this.closeStep(step, "timed-out", message);
        b.ended[key] = "unknown";
        b.why.push(message);
      }
    }
    this.save(c);
    return b.members.every((k) => b.ended[k]) ? b : null;
  }

  /** How a batch ended: true when all went well. A clear failure rolls back; an executor gone or a job lost stops, since the hosts are not known; while rolling back, any stops. */
  private batchWent(c: ServiceChange, b: Batch): boolean {
    const p = c.progress as ChangeProgress;
    const states = Object.values(b.ended);
    p.batch = null;
    if (states.every((x) => x === "ok")) return true;
    const why = b.why.join("; ");
    if (p.rollingBack) this.stopHere(c, `Rolling back failed: ${why}. This needs a person.`);
    else if (states.includes("unknown")) this.stopHere(c, `${why}: what the hosts did is not known. Look at them, then continue, roll back or close.`);
    else this.rollBackFull(c, why);
    return false;
  }

  private toBatch(c: ServiceChange, phase: string, members: string[]) {
    const p = c.progress as ChangeProgress;
    p.batch = { stage: phase, members, ended: {}, why: [] };
    this.save(c, { phase, currentMember: null });
  }

  /** §16.3 the check: nothing has been touched, and a failure here ends the change. Going on after a stop has touched things: that stops instead. */
  private refuseFull(c: ServiceChange, message: string) {
    const p = c.progress as ChangeProgress;
    if (p.touched) return this.stopHere(c, message);
    this.finish(c, "closed", `${message} Nothing was touched.`);
  }

  private fullGate(c: ServiceChange): void {
    const p = c.progress as ChangeProgress;
    const s = this.fullService(c);
    const step = this.openSteps(c)[0] ?? this.addStep(c, "gate", null, (c.options as ChangeOptions).timeouts.gate * 1000);
    const refuse = (message: string) => { this.closeStep(step, "failed", message); this.refuseFull(c, message); };
    const plan = c.plan as ChangePlan;
    const members = membersOf(s);
    if (members.length !== plan.members.length || !members.every((m) => plan.members.some((pm) => pm.member === installKey(m)))) return refuse("The cluster's members are not the plan's any more.");
    const offline = members.map((m) => this.handoff.executor(m.host, "service")).find((e) => !e.online);
    if (offline) return refuse(`The service executor of ${offline.host} is offline.`);
    const view = this.look(c, step, (why) => refuse(`Cannot look at every node: ${why}.`));
    if (!view) return;
    const warnings: string[] = [];
    for (const pm of plan.members) {
      const a = view.answers.get(pm.member)!;
      const changed = fileStand(pm, a).changed;
      if (changed.length) return refuse(`${pm.member}: ${changed.join(", ")} changed on the host since the plan: look at the plan again.`);
      if (a.rest.state === "no-certificate" || a.rest.state === "no-https") return refuse(`${pm.member}: its REST API cannot be watched: ${a.rest.error ?? a.rest.state}.`);
      this.keepStartSettings(c, pm.member, a);
      const m = this.member_(c, pm.member);
      if (!m.startEnvironment) return refuse(`${pm.member}: no start environment is known, and it would not come back the way it runs.`);
      if (!isRunning(a)) warnings.push(`${pm.member} is not running`);
      else if (this.nodeOf(view, m)?.status !== "CONNECTED") warnings.push(`${pm.member} is not connected`);
    }
    const counts = [...view.answers.values()].map((x) => x.rest.invalidCount).filter((n): n is number => typeof n === "number");
    if (!p.touched) p.baseline = counts.length ? Math.max(...counts) : null;
    this.closeStep(step, "succeeded", undefined, { baseline: p.baseline, ...(warnings.length ? { warnings } : {}) });
    this.toBatch(c, "check", plan.members.map((m) => m.member));
    this.fullCheck(c);
  }

  private fullCheck(c: ServiceChange): void {
    const seconds = (c.options as ChangeOptions).timeouts.write;
    const b = this.runBatch(c, seconds, (pm) => ({ kind: "svc-write", action: "check", files: this.filesOf(pm), flowFile: true }));
    if (!b) return;
    (c.progress as ChangeProgress).batch = null;
    if (Object.values(b.ended).some((x) => x !== "ok")) return this.refuseFull(c, `${b.why.join("; ")}.`);
    this.save(c, { phase: "stopping" });
    this.fullStopping(c);
  }

  /** One at a time, each confirmed gone; the roles are read afresh for each. Never kills and never starts by itself: a stop that fails stops the change. */
  private fullStopping(c: ServiceChange): void {
    const p = c.progress as ChangeProgress;
    const options = c.options as ChangeOptions;
    const failing = (message: string) => this.stopHere(c, p.rollingBack ? `Rolling back failed: ${message}. This needs a person.` : message);
    const open = this.openSteps(c)[0];
    if (open?.step === "stop") {
      const key = open.member!;
      const status = open.job ? this.handoff.status(open.job) : undefined;
      if (status && FINAL.has(status.state)) {
        const result = (status.result ?? {}) as Record<string, unknown>;
        if (status.state !== "succeeded") {
          const message = `stop on ${key}: ${status.message ?? status.state}`;
          this.closeStep(open, "failed", message);
          if (result.stillRunning && result.process) p.stuck = result.process as ProcessPair;
          return failing(message);
        }
        this.closeStep(open, "succeeded", status.message);
        if (!result.alreadyStopped) this.event(c, "node-stopped", key, `${key} stopped (the whole cluster stops)`);
        p.nextProbe = null;
        this.save(c, { currentMember: null });
        return this.fullStopping(c);
      }
      if (this.iso() > open.deadline) {
        const message = `stop on ${key} timed out`;
        this.closeStep(open, "timed-out", message);
        return failing(`${message}: it may still be running there.`);
      }
      return;
    }
    const s = this.fullService(c);
    const step = open ?? this.addStep(c, "look", null, options.timeouts.gate * 1000);
    const view = this.look(c, step, (why) => { this.closeStep(step, "failed", why); failing(`Cannot look at every node: ${why}`); });
    if (!view) return;
    const running = (c.plan as ChangePlan).members.map((m) => m.member).filter((k) => isRunning(view.answers.get(k)!));
    for (const k of running) this.keepStartSettings(c, k, view.answers.get(k)!);
    this.closeStep(step, "succeeded", undefined, { running });
    if (!running.length) {
      if (p.rollingBack) {
        if (!p.wrote) return this.toVerify(c);
        this.toBatch(c, "restore", (c.plan as ChangePlan).members.map((m) => m.member));
        return this.fullRestore(c);
      }
      this.toBatch(c, "backup", (c.plan as ChangePlan).members.map((m) => m.member));
      return this.fullBackup(c);
    }
    const key = running.reduce((a, b) => (this.weight(s, view, b) < this.weight(s, view, a) ? b : a));
    const m = this.member_(c, key);
    p.touched = true;
    this.save(c, { currentMember: key });
    const job = newJobId("svc-control", new Date(this.clock()));
    this.addStep(c, "stop", key, QUEUE_MS + options.timeouts.stop * 1000 + GRACE_MS, job);
    this.handoff.submit(job, { kind: "svc-control", action: "stop", change: c.id, member: key, serviceUser: m.serviceUser, env: m.startEnvironment ?? {}, timeoutSeconds: options.timeouts.stop, expiresAt: this.expiry(), requestedBy: c.createdBy }, m.host, "service");
  }

  /** Every member's, the flow file with them, and none written until all are there. */
  private fullBackup(c: ServiceChange): void {
    const seconds = (c.options as ChangeOptions).timeouts.write;
    const b = this.runBatch(c, seconds, (pm) => ({ kind: "svc-write", action: "backup", files: this.filesOf(pm), flowFile: true }));
    if (!b || !this.batchWent(c, b)) return;
    const writers = (c.plan as ChangePlan).members.filter((m) => m.files.length).map((m) => m.member);
    (c.progress as ChangeProgress).wrote = true;
    this.toBatch(c, "write", writers);
    this.fullWrite(c);
  }

  private fullWrite(c: ServiceChange): void {
    const seconds = (c.options as ChangeOptions).timeouts.write;
    const b = this.runBatch(c, seconds, (pm) => ({ kind: "svc-write", action: "apply", files: this.filesOf(pm), content: this.contentOf(c, pm) }));
    if (!b || !this.batchWent(c, b)) return;
    this.toVerify(c);
  }

  private fullRestore(c: ServiceChange): void {
    const seconds = (c.options as ChangeOptions).timeouts.write;
    const b = this.runBatch(c, seconds, () => ({ kind: "svc-write", action: "restore" }));
    if (!b || !this.batchWent(c, b)) return;
    (c.progress as ChangeProgress).wrote = false;
    this.toVerify(c);
  }

  private toVerify(c: ServiceChange) {
    (c.progress as ChangeProgress).nextProbe = null;
    this.save(c, { phase: "verify", currentMember: null });
    this.fullVerify(c);
  }

  /** The hard rule (§8): no node starts while the nodes' files are a mix. Asked of the hosts, right before starting, on every way here. */
  private fullVerify(c: ServiceChange): void {
    const p = c.progress as ChangeProgress;
    const plan = c.plan as ChangePlan;
    const step = this.openSteps(c)[0] ?? this.addStep(c, "verify", null, (c.options as ChangeOptions).timeouts.gate * 1000);
    const failing = (message: string) => {
      this.closeStep(step, "failed", message);
      if (p.rollingBack) return this.stopHere(c, `Rolling back failed: ${message}. No node was started. This needs a person.`);
      this.rollBackFull(c, message);
    };
    const view = this.look(c, step, (why) => { this.closeStep(step, "failed", why); this.stopHere(c, `${p.rollingBack ? "Rolling back failed: " : ""}Cannot look at every node before starting them: ${why}. No node was started.`); });
    if (!view) return;
    const off = plan.members.filter((pm) => { const stand = fileStand(pm, view.answers.get(pm.member)!); return !(p.rollingBack ? stand.old : stand.written); }).map((pm) => pm.member);
    if (off.length) return failing(`${off.join(", ")} ${off.length > 1 ? "do" : "does"} not have the ${p.rollingBack ? "old" : "new"} files after all`);
    const down = plan.members.map((m) => m.member).filter((k) => !isRunning(view.answers.get(k)!));
    this.closeStep(step, "succeeded", undefined, { start: down });
    if (!down.length) return this.toCompose(c);
    this.toBatch(c, "start", down);
    this.fullStart(c);
  }

  /** All at once: the flow election waits for enough candidates or for its whole time (§16.3), and one by one only makes it longer. */
  private fullStart(c: ServiceChange): void {
    const seconds = (c.options as ChangeOptions).timeouts.start;
    const b = this.runBatch(c, seconds, (_pm, m) => ({ kind: "svc-control", action: "start", serviceUser: m.serviceUser, env: m.startEnvironment ?? {}, limits: m.startLimits ?? null, timeoutSeconds: seconds }), (key, status) => {
      if (!(status.result as unknown as { alreadyRunning?: unknown }).alreadyRunning) this.event(c, "node-started", key, `${key} started (the whole cluster starts)`);
    });
    if (!b || !this.batchWent(c, b)) return;
    this.toCompose(c);
  }

  private toCompose(c: ServiceChange) {
    const p = c.progress as ChangeProgress;
    p.stableSince = null;
    p.nextProbe = null;
    p.composing = "not looked yet";
    this.save(c, { phase: "compose", currentMember: null });
    this.fullCompose(c);
  }

  /** §16.3: processes up, a coordinator and a primary node, every member in the table and connected, no more invalid components than before, and all of that for a while. Not answering yet is waiting; a process gone is a failed start. */
  private fullCompose(c: ServiceChange): void {
    const p = c.progress as ChangeProgress;
    const options = c.options as ChangeOptions;
    const s = this.fullService(c);
    const members = membersOf(s);
    const step = this.openSteps(c)[0] ?? this.addStep(c, "compose", null, options.timeouts.compose * 1000);
    const view = this.probe(c);
    if (view) {
      this.note(c, view);
      const gone = [...view.answers].filter(([, a]) => !isRunning(a)).map(([k]) => k);
      if (gone.length) return this.composeFailed(c, step, `${gone.join(", ")}: NiFi is not running any more`);
      const blind = [...view.answers].find(([, a]) => a.rest.state === "no-certificate" || a.rest.state === "no-https");
      if (blind) {
        const message = `${blind[0]}: its REST API cannot be watched: ${blind[1].rest.error ?? blind[1].rest.state}`;
        this.closeStep(step, "failed", message);
        return this.stopHere(c, message);
      }
      const invalid = Math.max(-1, ...[...view.answers.values()].map((a) => (typeof a.rest.invalidCount === "number" ? a.rest.invalidCount : -1)));
      let short: string | null = null;
      if (view.problems.size) short = `no answer from ${[...view.problems.keys()].join(", ")}`;
      else if (!view.nodes.some((n) => n.roles.includes(COORDINATOR))) short = "no cluster coordinator";
      else if (!view.nodes.some((n) => n.roles.includes(PRIMARY))) short = "no primary node";
      else if (view.nodes.length !== members.length) short = `${view.nodes.length} of ${members.length} nodes in the cluster`;
      else {
        const away = members.filter((m) => this.nodeOf(view, m)?.status !== "CONNECTED").map(installKey);
        if (away.length) short = `${away.join(", ")} not connected`;
        else if (p.baseline !== null && (invalid < 0 || invalid > p.baseline + options.invalidTolerance)) short = invalid < 0 ? "no count of invalid components" : `${invalid} invalid components, ${p.baseline} before`;
      }
      p.invalidHigh = short?.includes("invalid components") ?? false;
      p.composing = short;
      p.stableSince = short ? null : p.stableSince ?? this.iso();
      this.save(c);
      if (!short && this.clock() - Date.parse(p.stableSince!) >= options.stableSeconds * 1000) {
        this.closeStep(step, "succeeded");
        return this.fullComposed(c);
      }
    }
    if (this.iso() > step.deadline) {
      const message = `The cluster did not come together in time: ${p.composing}`;
      if (p.composing?.startsWith("no answer from")) {
        this.closeStep(step, "timed-out", message);
        return this.stopHere(c, `${p.rollingBack ? "Rolling back failed: " : ""}${message}: the hosts are not known. Nothing more is done by itself.`);
      }
      this.composeFailed(c, step, message, "timed-out");
    }
  }

  private composeFailed(c: ServiceChange, step: ServiceChangeStep, message: string, state: "failed" | "timed-out" = "failed") {
    const p = c.progress as ChangeProgress;
    this.closeStep(step, state, message);
    if (p.rollingBack) return this.stopHere(c, `Rolling back failed: ${message}. This needs a person.`);
    this.rollBackFull(c, message);
  }

  private fullComposed(c: ServiceChange): void {
    const p = c.progress as ChangeProgress;
    const plan = c.plan as ChangePlan;
    p.composing = null;
    p.stableSince = null;
    if (p.rollingBack) return this.finish(c, "rolled-back", c.message ?? "The whole cluster rolled back");
    p.done = plan.members.map((m) => m.member);
    p.pruning = [...p.done];
    p.wrote = false;
    const writers = plan.members.filter((m) => m.files.length);
    const events = writers.map((pm) => {
      const names = pm.files.map((f) => f.name);
      return { service: c.service, member: pm.member, at: this.iso(), kind: "config-applied", detail: { text: c.kind === "overwrite" ? `${names.join(", ")} on ${pm.member} written back` : `Revision ${c.revision} applied to ${pm.member} (${names.join(", ")})`, change: c.id, by: c.createdBy, revision: c.revision, files: names } };
    });
    Object.assign(c, { phase: "finish", currentMember: null, message: null });
    this.store.setFullChangeApplied(c, writers.map((pm) => ({ member: pm.member, files: pm.files.map((f) => ({ file: f.name, path: f.path, sha256: f.sha256, revision: f.revision })) })), events);
    this.finishing(c);
  }

  /** Continue and rollback look at all the members first (§16.3) and go from what they have. */
  private fullReconcile(c: ServiceChange): void {
    const p = c.progress as ChangeProgress;
    const plan = c.plan as ChangePlan;
    const step = this.openSteps(c)[0] ?? this.addStep(c, "reconcile", null, (c.options as ChangeOptions).timeouts.gate * 1000);
    const refuse = (message: string) => { this.closeStep(step, "failed", message); this.stopHere(c, message); };
    const view = this.look(c, step, (why) => refuse(`Cannot look at every node: ${why}.`));
    if (!view) return;
    const stands = plan.members.map((pm) => ({ pm, a: view.answers.get(pm.member)!, stand: fileStand(pm, view.answers.get(pm.member)!) }));
    const changed = stands.flatMap((x) => x.stand.changed.map((f) => `${x.pm.member}: ${f}`));
    if (changed.length) return refuse(`${changed.join(", ")} changed on the host since the plan: this needs a person. Close the change and plan again.`);
    const allOld = stands.every((x) => x.stand.old), allNew = stands.every((x) => x.stand.written);
    const up = stands.filter((x) => isRunning(x.a)).map((x) => x.pm.member);
    if (!allOld && !allNew && up.length) return refuse(`The nodes' files are a mix of old and new and ${up.join(", ")} ${up.length > 1 ? "are" : "is"} running: this needs a person.`);
    this.closeStep(step, "succeeded", undefined, { files: allNew ? "new" : allOld ? "old" : "mixed", running: up });
    p.nextProbe = null;
    if (p.intent === "rollback") {
      p.wrote = p.wrote || !allOld;
      if (!p.wrote) return this.toVerify(c);
      this.save(c, { phase: "stopping" });
      return this.fullStopping(c);
    }
    if (allNew) { p.wrote = true; return this.toVerify(c); }
    if (allOld) { p.wrote = false; this.save(c, { phase: "gate" }); return this.fullGate(c); }
    p.wrote = true; // a write cut short: only the rest of it (every backup was there before the first write)
    this.toBatch(c, "write", stands.filter((x) => x.pm.files.length && !x.stand.written).map((x) => x.pm.member));
    this.fullWrite(c);
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

/** Where a member's planned files stand. A new file svc-state does not list yet tells nothing, either way. */
function fileStand(pm: Pick<PlanMember, "files">, a: StateAnswer) {
  const out = { old: true, written: true, changed: [] as string[] };
  for (const f of pm.files) {
    if (!a.files.some((x) => x.name === f.name) && f.baseSha256 === null) continue;
    const live = liveHash(a, f);
    if (live !== f.baseSha256) out.old = false;
    if (live !== f.sha256) out.written = false;
    if (live !== f.baseSha256 && live !== f.sha256) out.changed.push(f.name);
  }
  return out;
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

/**
 * How long a plan can take at most, each step at its timeout, in seconds; a job's time in the queue is not counted, nor is
 * rolling back. mode full: from the first stop to the cluster formed (§16.3), which is how long the service can be down.
 */
export function longestSeconds(plan: Pick<ChangePlan, "mode" | "members" | "options">): number {
  const t = plan.options.timeouts;
  if (plan.mode === "full") return plan.members.length * t.stop + 2 * t.write + t.gate + t.start + t.compose; // stopped one by one; backup and write; verify; started at once
  return plan.members.reduce((total, m) => total + m.stages.reduce((n, stage) => n + t[STAGE_TIMEOUT[stage]], 0), 0);
}

/** A change as pages and tools get it: no file hashes, no working state, no start environment. */
export function changeView(c: ServiceChange, steps?: readonly ServiceChangeStep[]) {
  const { plan, progress, ...rest } = c;
  const p = progress as ChangeProgress;
  const { planHash: _h, ...shown } = planView(plan as ChangePlan);
  return {
    ...rest, plan: shown,
    progress: {
      done: p.done, remaining: p.remaining, rollingBack: p.rollingBack, canForceKill: c.state === "stopped" && Boolean(p.stuck), stuck: c.state === "stopped" ? p.stuck : null,
      canRollBack: c.mode === "full" ? c.state === "stopped" || c.state === "paused" : c.state === "stopped" && Boolean((plan as ChangePlan).members.find((m) => m.member === c.currentMember)?.files.length),
      ...(c.mode === "full" ? { wrote: p.wrote, seen: p.seen ?? null, composing: p.composing ?? null } : {}),
    },
    ...(steps ? { steps: steps.map(({ change: _c, ...s }) => s) } : {}),
  };
}

/** A plan as pages and tools get it: without the files' hashes (§16.3: the AI gets none, and no page needs them). */
export function planView(plan: ChangePlan) {
  return { ...plan, longestSeconds: longestSeconds(plan), members: plan.members.map((m) => ({ ...m, files: m.files.map(({ baseSha256: _b, sha256: _s, ...f }) => f) })) };
}
