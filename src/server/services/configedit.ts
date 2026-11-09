// Service ops §7, §16.3: editing a configuration. A draft is a list of changes, not a copy of the files: a key set or
// removed, a secret's new value (sealed before it is stored), or an XML file's whole text (sealed too: what someone typed
// in it may be a password). Applying them to a revision gives the next revision's body: a standalone's files directly, a
// cluster's through its layers (split on the first edit, services/layers.ts). Checks are configcheck.ts; nothing here
// refuses on a finding, only on a change that cannot be made. What reaches a page never holds a secret: changeView shows
// a secret's change as hidden, and fileDiffs compares secrets here and names only the keys.

import type { SecretBox } from "../secretbox.ts";
import { lineDiff } from "../ingress.ts";
import { openFile, redactedText, sealFile, type ConfigFileRecord, type ConfigLayers, type ConfigMember, type LayerFile, type ServiceConfigBody } from "./config.ts";
import { checkConfig, openMembers, type ChangeAssessment, type CheckInput, type ConfigFinding } from "./configcheck.ts";
import { ConfigDocError, decodeText, editProperties, editXml, effectiveProperties, encodeValue, HIDDEN, isSecretKey, parsePropertyEntries, redactXml, xmlSecrets } from "./configdoc.ts";
import { installKey } from "./draft.ts";
import { layerFile, layerValue, renderBody, splitBody } from "./layers.ts";
import { PROFILES } from "./profiles.ts";

interface Where { file: string; member: string | null }
/** One change as a draft keeps it. member null: a standalone's one member, or a cluster's common layer. secret: the new
 *  value, sealed. sealed: an XML file's new bytes (base64), sealed, its "(hidden)" already back to their values. */
export type DraftChange =
  | (Where & { key: string; value: string })
  | (Where & { key: string; unset: true })
  | (Where & { key: string; secret: string })
  | (Where & { sealed: string });

/** A change as the pages get it. */
export type DraftChangeView =
  | (Where & { key: string; value: string })
  | (Where & { key: string; unset: true })
  | (Where & { key: string; hidden: true })
  | (Where & { text: string });

const MAX_CHANGES = 500;
const MAX_TEXT = 4 << 20;

const refuse = (code: string, message: string): never => { throw new ConfigDocError(code, message); };

function bytesOf(f: Pick<ConfigFileRecord, "name" | "sha256" | "sealed" | "sealedAs">, box: SecretBox): Buffer {
  const opened = openFile(f as ConfigFileRecord, box);
  if (!opened.ok) throw new ConfigDocError(opened.code, opened.message);
  return opened.bytes;
}

const textBytes = (c: { sealed: string }, box: SecretBox) => Buffer.from(box.open(c.sealed), "base64");

function memberOf(body: ServiceConfigBody, member: string): ConfigMember {
  return body.members.find((m) => installKey(m) === member) ?? refuse("config/unknown-member", `${member} is not a member of this service`);
}

/** The record a change at this place edits, in a body already split when it is a cluster's. */
function recordAt(body: ServiceConfigBody, kind: "standalone" | "cluster", file: string, member: string | null): Pick<ConfigFileRecord, "name" | "sha256" | "sealed" | "sealedAs" | "format"> {
  if (kind === "standalone" || member !== null) {
    const m = member === null ? body.members[0]! : memberOf(body, member);
    return m.files.find((f) => f.name === file) ?? refuse("config/unknown-file", `${installKey(m)} has no ${file}`);
  }
  const common = body.layers?.common[file];
  if (common) return common;
  if (body.members.some((m) => m.files.some((f) => f.name === file))) return refuse("config/no-common-copy", `${file} differs between the nodes as a whole, or only some have it: change it on each node`);
  return refuse("config/unknown-file", `This service has no ${file}`);
}

const sameWhere = (a: Where, b: Where) => a.file === b.file && a.member === b.member;

/**
 * What was submitted, checked and as a draft keeps it. previous: the draft's changes so far, so that sending back what the
 * page shows keeps them: a secret shown as hidden, and in XML text each "(hidden)", which stands for the draft's own new
 * value if it has one, else the revision's. Refuses what cannot be made ((hidden) as a value, a key that does not read back
 * as one key, a file that cannot be edited as kept); what is merely wrong is left to the findings.
 */
export function acceptChanges(raw: unknown, base: ServiceConfigBody, kind: "standalone" | "cluster", box: SecretBox, previous: readonly DraftChange[] = []): DraftChange[] {
  if (!Array.isArray(raw)) return refuse("config/bad-change", "changes is a list");
  if (raw.length > MAX_CHANGES) return refuse("config/bad-change", `At most ${MAX_CHANGES} changes in a draft`);
  const edited = kind === "cluster" ? splitBody(base, box) : base;
  return raw.map((entry): DraftChange => {
    const c = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    if (typeof c.file !== "string" || !c.file) return refuse("config/bad-change", "Each change names its file");
    if (c.member !== undefined && c.member !== null && typeof c.member !== "string") return refuse("config/bad-change", "member is a member's key, or null");
    const where: Where = { file: c.file, member: (c.member as string | null | undefined) ?? null };
    const record = recordAt(edited, kind, where.file, where.member);
    if (c.text !== undefined) {
      if (typeof c.text !== "string" || c.text.length > MAX_TEXT) return refuse("config/bad-change", "text is the file's text, at most 4 MiB");
      if (record.format !== "xml") return refuse("config/not-editable", `${where.file} is changed key by key, not as text`);
      const own = previous.find((p) => "sealed" in p && sameWhere(p, where)) as { sealed: string } | undefined;
      const bytes = editXml(own ? textBytes(own, box) : bytesOf(record, box), c.text);
      return { ...where, sealed: box.seal(bytes.toString("base64")) };
    }
    if (typeof c.key !== "string" || !c.key) return refuse("config/bad-change", "A change gives a key, or the text of an XML file");
    if (record.format !== "properties") return refuse("config/not-editable", `${where.file} is changed as a whole text, not key by key`);
    const key = c.key;
    const parsed = parsePropertyEntries(`${key}=`);
    if (parsed.length !== 1 || parsed[0]!.key !== key) return refuse("config/bad-key", "A key does not read back as one key");
    if (c.hidden === true) {
      const kept = previous.find((p) => "secret" in p && p.key === key && sameWhere(p, where));
      return kept ?? refuse("config/hidden-unmatched", `${key}: this draft has no new value to keep: enter the value`);
    }
    if (c.unset === true) return { ...where, key, unset: true };
    const value = c.secret ?? c.value;
    if (typeof value !== "string") return refuse("config/bad-change", `${key}: give value, secret or unset`);
    encodeValue(key, value);
    return c.secret !== undefined || isSecretKey(parsed[0]!.name) ? { ...where, key, secret: box.seal(value) } : { ...where, key, value };
  });
}

const CATALOG_SECRETS: ReadonlySet<string> = new Set(PROFILES.flatMap((p) => p.catalog).filter((e) => e.sensitive).map((e) => e.key));
const secretName = (key: string) => {
  const name = parsePropertyEntries(`${key}=`)[0]?.name ?? key;
  return isSecretKey(name) || CATALOG_SECRETS.has(name);
};

/** What the AI submitted that names a secret (§16.3): a person enters those on the page. Looked at before acceptChanges, which would seal it. */
export function secretSubmitted(raw: unknown): string | null {
  for (const entry of Array.isArray(raw) ? raw : []) {
    const c = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    if (c.secret !== undefined || c.hidden === true) return typeof c.key === "string" ? c.key : String(c.file);
    if (typeof c.key === "string" && secretName(c.key)) return c.key;
  }
  return null;
}

/** An XML change that alters a secret's value, adds one or takes one away; text that keeps each "(hidden)" does none of these. */
export function xmlSecretChanged(changes: readonly DraftChange[], base: ServiceConfigBody, kind: "standalone" | "cluster", box: SecretBox): string | null {
  const edited = kind === "cluster" ? splitBody(base, box) : base;
  const secrets = (bytes: Buffer) => JSON.stringify(xmlSecrets(decodeText(bytes)).map((s) => [s.name, s.value]));
  for (const c of changes) {
    if ("sealed" in c && secrets(bytesOf(recordAt(edited, kind, c.file, c.member), box)) !== secrets(textBytes(c, box))) return c.file;
  }
  return null;
}

/** A kept change as the pages get it: no secret, and XML text with its secrets hidden. */
export function changeView(c: DraftChange, box: SecretBox | undefined): DraftChangeView {
  const where = { file: c.file, member: c.member };
  if ("sealed" in c) return { ...where, text: box ? redactXml(decodeText(textBytes(c, box))).text : HIDDEN };
  if ("secret" in c) return { ...where, key: c.key, hidden: true };
  return c;
}

/** A change for the audit trail: where and what kind, no value. */
export function changeSummary(c: DraftChange): Record<string, unknown> {
  const where = { file: c.file, member: c.member };
  if ("sealed" in c) return { ...where, op: "text" };
  return { ...where, key: c.key, op: "unset" in c ? "unset" : "secret" in c ? "secret" : "set" };
}

function editedBytes(bytes: Buffer, c: DraftChange, box: SecretBox): Buffer {
  if ("sealed" in c) return textBytes(c, box);
  if ("unset" in c) return editProperties(bytes, [{ key: c.key, unset: true }]);
  return editProperties(bytes, [{ key: c.key, value: "secret" in c ? box.open(c.secret) : c.value }]);
}

function applyToLayers(layers: ConfigLayers, c: DraftChange, box: SecretBox) {
  const common: LayerFile | undefined = layers.common[c.file];
  if (c.member === null) {
    if (!common) return refuse("config/no-common-copy", `${c.file} differs between the nodes as a whole, or only some have it: change it on each node`);
    layers.common[c.file] = layerFile(c.file, editedBytes(bytesOf(common, box), c, box), box);
    return;
  }
  const own = (layers.nodes[c.member] ??= {});
  const mine = own[c.file];
  if (mine && "replace" in mine) {
    own[c.file] = { replace: layerFile(c.file, editedBytes(bytesOf(mine.replace, box), c, box), box) };
    return;
  }
  if (!common) return refuse("config/unknown-file", `${c.member} has no ${c.file}`);
  if ("sealed" in c) {
    const replace = layerFile(c.file, textBytes(c, box), box);
    if (replace.sha256 === common.sha256) delete own[c.file];
    else own[c.file] = { replace };
    return;
  }
  const set = (mine?.set ?? []).filter((v) => v.key !== c.key);
  const unset = (mine?.unset ?? []).filter((k) => k !== c.key);
  if ("unset" in c) {
    if (parsePropertyEntries(bytesOf(common, box).toString("latin1")).some((e) => e.key === c.key)) unset.push(c.key);
  } else {
    set.push(layerValue({ key: c.key, value: encodeValue(c.key, "secret" in c ? box.open(c.secret) : c.value) }, box));
  }
  if (set.length || unset.length) own[c.file] = { set, unset };
  else delete own[c.file];
}

/** A change to the common layer that a node does not get, because it keeps its own (§16.5 step 2): said, not refused. */
function overridden(layers: ConfigLayers, changes: readonly DraftChange[]): ConfigFinding[] {
  const out: ConfigFinding[] = [];
  for (const c of changes) {
    if (c.member !== null) continue;
    const key = "sealed" in c ? undefined : c.key;
    for (const [node, files] of Object.entries(layers.nodes)) {
      const own = files[c.file];
      if (!own) continue;
      if ("replace" in own || own.set.some((v) => v.key === key) || own.unset.includes(key ?? "")) {
        const what = key ? `${key} (${c.file})` : c.file;
        out.push({ severity: "warning", code: "config/node-override", file: c.file, ...(key ? { key } : {}), member: node, introduced: true, message: `${what} changes in the common layer, but ${node} has its own and stays as it is.` });
      }
    }
  }
  return out;
}

/** The next revision's body. split: a cluster's first edit, the revision to keep first (the same files in layers). */
export function applyChanges(base: ServiceConfigBody, kind: "standalone" | "cluster", changes: readonly DraftChange[], box: SecretBox): { split: ServiceConfigBody | null; body: ServiceConfigBody; findings: ConfigFinding[] } {
  if (kind === "cluster") {
    const split = splitBody(base, box);
    const layers = structuredClone(split.layers!);
    for (const c of changes) {
      if (c.member !== null) memberOf(split, c.member);
      applyToLayers(layers, c, box);
    }
    return { split: base.layers ? null : split, body: renderBody(split.members, layers, box), findings: overridden(layers, changes) };
  }
  const member = base.members[0]!;
  const bytes = new Map<string, Buffer>();
  for (const c of changes) {
    if (c.member !== null && c.member !== installKey(member)) return refuse("config/unknown-member", `${c.member} is not this instance`);
    const f = member.files.find((x) => x.name === c.file) ?? refuse("config/unknown-file", `${installKey(member)} has no ${c.file}`);
    bytes.set(c.file, editedBytes(bytes.get(c.file) ?? bytesOf(f, box), c, box));
  }
  const files = member.files.map((f) => {
    const next = bytes.get(f.name);
    return next && !next.equals(bytesOf(f, box)) ? sealFile(f, next, box) : f;
  });
  return { split: null, body: { members: [{ ...member, files }] }, findings: [] };
}

/** Whether a revision would differ from another in any file. */
export function sameFiles(a: readonly ConfigMember[], b: readonly ConfigMember[]): boolean {
  const hashes = (ms: readonly ConfigMember[]) => JSON.stringify(ms.map((m) => [installKey(m), m.files.map((f) => [f.name, f.sha256])]));
  return hashes(a) === hashes(b);
}

export type CheckContext = Pick<CheckInput, "profile" | "version" | "kind" | "others" | "memory">;

/** A draft's outcome on its base revision: the bodies to keep, its findings and what it means. No profile: nothing to check against. */
export function outcomeOf(base: ServiceConfigBody, changes: readonly DraftChange[], box: SecretBox, context: Omit<CheckContext, "profile"> & { profile: CheckContext["profile"] | undefined }): { split: ServiceConfigBody | null; body: ServiceConfigBody; findings: ConfigFinding[]; change: ChangeAssessment | null } {
  const { split, body, findings } = applyChanges(base, context.kind, changes, box);
  if (!context.profile) return { split, body, findings, change: null };
  const checked = checkConfig({ ...context, profile: context.profile, members: openMembers(body.members, box), base: openMembers(base.members, box) });
  return { split, body, findings: [...checked.findings, ...findings], change: checked.change };
}

// --- comparing

export interface FileDiff {
  name: string;
  change: "added" | "removed" | "content";
  /** Changed lines of the redacted text with some around them; "+ ", "- " or "  " first, "..." where lines are left out. */
  diff: string;
  /** Secrets whose values differ: only their names. In text they read "(hidden)" on both sides. */
  secretsChanged: string[];
  /** false: a side could not be opened (config/reimport), so the kept redacted copy is compared and secrets are not. */
  opened: boolean;
}
export interface MemberDiff { member: string; files: FileDiff[] }

const CONTEXT = 2;

function compact(diff: string): string {
  const lines = diff.split("\n");
  const keep = new Set<number>();
  lines.forEach((l, i) => {
    if (l.startsWith("  ")) return;
    for (let j = i - CONTEXT; j <= i + CONTEXT; j++) keep.add(j);
  });
  const out: string[] = [];
  let left = false;
  lines.forEach((l, i) => {
    if (keep.has(i)) {
      if (left) out.push("...");
      left = false;
      out.push(l);
    } else left = true;
  });
  if (left && out.length) out.push("...");
  return out.join("\n");
}

function secretsOf(name: string, format: ConfigFileRecord["format"], bytes: Buffer): Map<string, string> {
  if (format === "properties") return new Map([...effectiveProperties(bytes)].filter(([k]) => isSecretKey(k)).map(([, v]) => [v.key, v.value]));
  if (format !== "xml") return new Map();
  // The n-th of a name to the n-th: same-named properties are told apart by position, as they are when restored.
  const seen = new Map<string, string[]>();
  for (const s of xmlSecrets(decodeText(bytes))) seen.set(s.name, [...(seen.get(s.name) ?? []), s.value]);
  return new Map([...seen].map(([k, v]) => [k, JSON.stringify(v)]));
}

function fileDiff(name: string, before: ConfigFileRecord | undefined, after: ConfigFileRecord | undefined, box: SecretBox | undefined): FileDiff {
  const open = (f: ConfigFileRecord | undefined) => {
    if (!f || !box) return undefined;
    const o = openFile(f, box);
    return o.ok ? o.bytes : undefined;
  };
  const was = open(before), now = open(after);
  const opened = (!before || !!was) && (!after || !!now);
  // Redacted anew when it can be: a kept copy from an older version may hide or show other keys than a new one would.
  const text = (f: ConfigFileRecord | undefined, bytes: Buffer | undefined) => (!f ? "" : opened && bytes ? redactedText(f.name, bytes) : f.redacted);
  const format = (after ?? before)!.format;
  const a = was && opened ? secretsOf(name, format, was) : new Map<string, string>(), b = now && opened ? secretsOf(name, format, now) : new Map<string, string>();
  const secretsChanged = opened ? [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k)) : [];
  return { name, change: !before ? "added" : !after ? "removed" : "content", diff: compact(lineDiff(text(before, was), text(after, now))), secretsChanged, opened };
}

/** What differs between two revisions' members, per member and file. Nothing here holds a secret or a hash of one. */
export function fileDiffs(from: readonly ConfigMember[], to: readonly ConfigMember[], box: SecretBox | undefined, member?: string): MemberDiff[] {
  const keys = [...new Set([...to, ...from].map(installKey))].filter((k) => !member || k === member);
  return keys.flatMap((key) => {
    const a = from.find((m) => installKey(m) === key)?.files ?? [], b = to.find((m) => installKey(m) === key)?.files ?? [];
    const names = [...new Set([...b, ...a].map((f) => f.name))].sort();
    const files = names.flatMap((name) => {
      const before = a.find((f) => f.name === name), after = b.find((f) => f.name === name);
      return before?.sha256 === after?.sha256 ? [] : [fileDiff(name, before, after, box)];
    });
    return files.length ? [{ member: key, files }] : [];
  });
}

/** A kept value as a person reads it (admin, one key at a time). index: which of same-named XML secrets. Undefined: no such key. */
export function revealValue(f: ConfigFileRecord, key: string, box: SecretBox, index = 0): { value: string; count: number } | undefined {
  const bytes = bytesOf(f, box);
  if (f.format === "properties") {
    const v = effectiveProperties(bytes).get(key) ?? [...effectiveProperties(bytes).values()].find((e) => e.key === key);
    return v && { value: decodeText(Buffer.from(v.value, "latin1")), count: 1 };
  }
  const found = f.format === "xml" ? xmlSecrets(decodeText(bytes)).filter((s) => s.name === key) : [];
  const hit = found[index];
  return hit && { value: hit.value.trim(), count: found.length };
}
