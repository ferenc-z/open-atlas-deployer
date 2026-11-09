// Service ops §7, §16.3: drift, when a file on a host is no longer what the Deployer says it should be. The collector
// reports each file's fingerprint in its samples (service_member_files.actual_*); a member's state follows from those.
// To see what differs, the file is read from the host (svc-read), compared here with what is kept, and let go: what is
// answered has its secrets hidden, a changed one only named. Adopting keeps the host's file as a new revision and changes
// nothing on the host; overwriting the host is a change (§16.3), which later steps make.

import { createHash } from "node:crypto";
import type { Handoff } from "../handoff.ts";
import { newJobId } from "../handoff.ts";
import type { SecretBox } from "../secretbox.ts";
import type { ServiceMemberFile } from "../store.ts";
import { openFile, sealFile, type ConfigFileRecord, type ConfigLayers, type ConfigMember, type ReadFile, type ServiceConfigBody } from "./config.ts";
import { ConfigDocError, effectiveProperties, writeProperties, type WrittenProperty } from "./configdoc.ts";
import { fileDiffs, type FileDiff } from "./configedit.ts";
import { confDirOf, installKey, type ServiceMember } from "./draft.ts";
import { layerFile, layerValue, renderBody, splitBody } from "./layers.ts";
import { redactText } from "./redact.ts";
import type { MemberStatus, ServiceStatus } from "./status.ts";

/** actual_sha256 of a file that is gone from the host. */
export const FILE_MISSING = "missing";

export type DriftFileState = "same" | "changed" | "missing" | "unknown";
export interface DriftFile { name: string; path: string; state: DriftFileState; revision: number; expectedSha256: string; actualSha256: string | null; actualAt: string | null }
export interface MemberDrift { member: string; state: "same" | "drift" | "unknown"; reason: string | null; asOf: string | null; files: DriftFile[] }
export interface ServiceDrift { service: string; known: boolean; drifted: boolean; members: MemberDrift[] }
/** One file's differences from what is kept: sha256 is what the host has now, which adopting must name. */
export type LiveDiff = FileDiff & { path: string; sha256: string | null };
export interface LiveDifferences { member: string; files: LiveDiff[] }

export const fileState = (f: Pick<ServiceMemberFile, "expectedSha256" | "actualSha256">): DriftFileState =>
  (f.actualSha256 === null ? "unknown" : f.actualSha256 === FILE_MISSING ? "missing" : f.actualSha256 === f.expectedSha256 ? "same" : "changed");
export const hasDrifted = (f: Pick<ServiceMemberFile, "expectedSha256" | "actualSha256">) => ["changed", "missing"].includes(fileState(f));

const SHA256 = /^[0-9a-f]{64}$/;

/** What a sample says of its files: by name the hash, FILE_MISSING, or null when it could not tell. Null as a whole: it says nothing (an executor from before 0.9.0, or the collector failed). */
export function fingerprintsOf(sample: Record<string, unknown>): Map<string, string | null> | null {
  if (!Array.isArray(sample.files)) return null;
  const out = new Map<string, string | null>();
  for (const f of sample.files as { name?: unknown; sha256?: unknown; missing?: unknown }[]) {
    if (!f || typeof f.name !== "string") continue;
    out.set(f.name, f.missing === true ? FILE_MISSING : typeof f.sha256 === "string" && SHA256.test(f.sha256) ? f.sha256 : null);
  }
  return out;
}

/** One member's drift. A newest sample too old, or an executor gone, cannot tell; what was last seen stays visible. */
export function memberDrift(m: Pick<MemberStatus, "key" | "source" | "state" | "asOf" | "executor">, rows: readonly ServiceMemberFile[]): MemberDrift {
  const files = rows.filter((f) => f.member === m.key).map((f): DriftFile => ({ name: f.file, path: f.path, state: fileState(f), revision: f.revision, expectedSha256: f.expectedSha256, actualSha256: f.actualSha256 === FILE_MISSING ? null : f.actualSha256, actualAt: f.actualAt }));
  const fresh = m.source === "samples" && (m.state === "running" || m.state === "stopped");
  const asOf = files.reduce<string | null>((at, f) => (f.actualAt && (!at || f.actualAt > at) ? f.actualAt : at), null);
  const base = { member: m.key, asOf, files };
  if (!fresh) return { ...base, state: "unknown", reason: m.executor.online ? "No fresh sample of this member." : "The service executor is offline." };
  if (files.some((f) => f.state === "changed" || f.state === "missing")) return { ...base, state: "drift", reason: null };
  if (files.some((f) => f.state === "unknown")) return { ...base, state: "unknown", reason: "The newest sample has no fingerprint of a file: the service executor is too old (before 0.9.0, upgrade it) or could not read the file." };
  return { ...base, state: "same", reason: null };
}

export function serviceDrift(status: Pick<ServiceStatus, "id" | "members">, rows: readonly ServiceMemberFile[]): ServiceDrift {
  const members = status.members.map((m) => memberDrift(m, rows));
  return { service: status.id, known: members.length > 0 && members.every((m) => m.state !== "unknown"), drifted: members.some((m) => m.state === "drift"), members };
}

export class DriftError extends Error {
  readonly status: 404 | 409;
  readonly code: string;
  readonly details: string[];
  constructor(status: 404 | 409, code: string, message: string, details: string[] = []) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface LiveReadOptions { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> }
export interface LiveFile { name: string; path: string; bytes: Buffer | null; modifiedAt: string; sha256: string | null }

const isFinal = (state: string | undefined) => state === "succeeded" || state === "failed" || state === "refused" || state === "rolled-back";

/** Reads some of a member's files from its host, where they were imported from. rows: all the member's. The content is handed over once and kept nowhere here. */
export async function readLive(handoff: Handoff, m: ServiceMember, rows: readonly ServiceMemberFile[], names: readonly string[], requestedBy: string, o: LiveReadOptions = {}): Promise<LiveFile[]> {
  const executor = handoff.executor(m.host, "service");
  if (!executor.online) throw new DriftError(409, "drift/executor", `The service executor of ${m.host} is offline: the file cannot be read.`, executor.reason ? [executor.reason] : []);
  const bootstrapFile = rows.find((f) => f.file === "bootstrap.conf")?.path;
  const request = { kind: "svc-read", installDir: m.installDir, confDir: confDirOf(m), ...(bootstrapFile ? { bootstrapFile } : {}), files: [...names], timeoutSeconds: 30, requestedBy };
  const missing = handoff.missing(m.host, request, "service");
  if (missing.length) throw new DriftError(409, "drift/executor", `The service executor of ${m.host} is too old to read this: upgrade it.`, missing);
  const id = newJobId("svc-read");
  handoff.submit(id, request, m.host, "service");
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const end = Date.now() + (o.timeoutMs ?? 30_000);
  while (!isFinal(handoff.status(id)?.state) && Date.now() < end) await sleep(o.pollMs ?? 200);
  const status = handoff.status(id);
  const content = handoff.envContent(id);
  if (status?.state !== "succeeded") throw new DriftError(409, "drift/read", `${installKey(m)}: ${status ? `${status.state}${status.message ? `: ${status.message}` : ""}` : "not read in time (is the service executor running?)"}`);
  if (!content) throw new DriftError(409, "drift/read", `${installKey(m)}: the files did not arrive`);
  let sent: { files: ReadFile[] };
  try { sent = JSON.parse(content); } catch { throw new DriftError(409, "drift/read", `${installKey(m)}: unreadable answer`); }
  return names.map((name): LiveFile => {
    const row = rows.find((f) => f.file === name)!;
    const f = sent.files.find((x) => x.name === name);
    if (!f) return { name, path: row.path, bytes: null, modifiedAt: row.appliedAt, sha256: null };
    if (f.path !== row.path) throw new DriftError(409, "drift/read", `${name} was read at ${f.path}, not at ${row.path} where it was imported from.`);
    const bytes = Buffer.from(f.content, "base64");
    if (createHash("sha256").update(bytes).digest("hex") !== f.sha256) throw new DriftError(409, "drift/read", `${f.path} does not match its sha256`);
    return { name, path: f.path, bytes, modifiedAt: f.modifiedAt, sha256: f.sha256 };
  });
}

const shell = (m: ServiceMember, files: ConfigFileRecord[]): ConfigMember => ({ host: m.host, installDir: m.installDir, confDir: confDirOf(m), missing: [], files });

/** How the files read from the host differ from what each should be, secrets hidden. A file back to what is kept is left out. */
export function liveDifferences(m: ServiceMember, live: readonly LiveFile[], expected: (name: string) => ConfigFileRecord | undefined, box: SecretBox): LiveDifferences {
  const member = installKey(m);
  const files = live.flatMap((f): LiveDiff[] => {
    const kept = expected(f.name);
    const now = f.bytes ? sealFile({ name: f.name, path: f.path, modifiedAt: f.modifiedAt }, f.bytes, box) : undefined;
    return fileDiffs([shell(m, kept ? [kept] : [])], [shell(m, now ? [now] : [])], box).flatMap((d) => d.files).map((d) => ({ ...d, diff: redactText(d.diff), path: f.path, sha256: f.sha256 }));
  });
  return { member, files };
}

function adoptIntoLayers(layers: ConfigLayers, member: string, name: string, raw: Buffer, box: SecretBox) {
  const own = (layers.nodes[member] ??= {});
  const common = layers.common[name];
  if (!common) { own[name] = { replace: layerFile(name, raw, box) }; return; }
  const opened = openFile({ ...common, path: "", modifiedAt: "" }, box);
  if (!opened.ok) throw new ConfigDocError(opened.code, opened.message);
  const template = opened.bytes;
  if (template.equals(raw)) { delete own[name]; return; }
  // By key when that gives back these very bytes; a comment or a moved line takes the whole file.
  if (common.format === "properties") {
    const was = effectiveProperties(template), now = effectiveProperties(raw);
    const set: WrittenProperty[] = [...now].filter(([k, v]) => was.get(k)?.value !== v.value || was.get(k)?.key !== v.key).map(([, v]) => v);
    const unset = [...was].filter(([k]) => !now.has(k)).map(([, v]) => v.key);
    let same = false;
    try { same = writeProperties(template, set, unset).equals(raw); } catch (error) { if (!(error instanceof ConfigDocError)) throw error; }
    if (same) { own[name] = { set: set.map((v) => layerValue(v, box)), unset }; return; }
  }
  own[name] = { replace: layerFile(name, raw, box) };
}

/** The next revision's body with one member's file as the host has it: a standalone's file, a cluster node's override (split into layers first, as a first edit is). */
export function adoptedBody(base: ServiceConfigBody, kind: "standalone" | "cluster", member: string, file: LiveFile & { bytes: Buffer }, box: SecretBox): { split: ServiceConfigBody | null; body: ServiceConfigBody } {
  const sha256 = createHash("sha256").update(file.bytes).digest("hex");
  if (kind === "standalone") {
    return { split: null, body: { members: base.members.map((m) => (installKey(m) !== member ? m : { ...m, files: m.files.map((f) => (f.name === file.name ? sealFile({ name: f.name, path: f.path, modifiedAt: file.modifiedAt }, file.bytes, box) : f)) })) } };
  }
  const split = splitBody(base, box);
  const layers = structuredClone(split.layers!);
  adoptIntoLayers(layers, member, file.name, file.bytes, box);
  if (!Object.keys(layers.nodes[member] ?? {}).length) delete layers.nodes[member];
  const body = renderBody(split.members, layers, box);
  const rendered = body.members.find((m) => installKey(m) === member)?.files.find((f) => f.name === file.name);
  if (rendered?.sha256 !== sha256) throw new ConfigDocError("config/layer-mismatch", `${file.name} does not come out of the layers as the host has it`);
  return { split: base.layers ? null : split, body };
}
