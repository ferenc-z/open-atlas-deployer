// Service ops §7, §16.3: checking a configuration, for drafts, saves and plans alike. Works on the files' bytes (the caller
// opens them: openBody) and answers in findings: keys this version does not have, values of the wrong type or range, a
// cluster's nodes disagreeing on a scope "cluster" key, port conflicts, a heap too big for the machine, XML that is not
// well-formed. Given what each member has now (base), it also says what the change means (assessChange): which files
// change, whether a restart is needed and why, and whether the cluster can take it node by node (rolling) or has to stop
// and start as a whole (full, S31). Nothing here refuses anything: drafts and saves carry the findings, and only a plan
// stops, on an error this change introduced (blockingFindings). No finding holds a secret: values are compared here on
// the server and secret ones reach the output as labels only. Values are compared as written, escapes kept.

import type { SecretBox } from "../secretbox.ts";
import { portConflicts, portsTaken, type Finding, type RegisteredMember } from "./assess.ts";
import { openFile, type ConfigMember, type ServiceConfigBody } from "./config.ts";
import { decodeText, effectiveProperties, isSecretKey, xmlProblem } from "./configdoc.ts";
import { installKey, type DraftItem, type ServiceMember, type ServicePorts } from "./draft.ts";
import { catalogFor, PROFILES, type CatalogEntry, type ServiceProfile } from "./profiles.ts";

/** A finding of the check. introduced: this change brought it (always true without a base to compare with). */
export type ConfigFinding = Omit<Finding, "file"> & { file?: string; member?: string; introduced: boolean };
type Found = Omit<ConfigFinding, "introduced">;

/** A file to check. bytes null: the kept copy cannot be opened (openFile: config/reimport), only its hash is known. */
export interface CheckFile { name: string; sha256: string; bytes: Buffer | null }
export interface CheckMember { host: string; installDir: string; confDir?: string | null; files: CheckFile[] }

export type ChangeMode = "rolling" | "full";
/** format: the bytes differ but the meaning does not (comments, order, layout). keys: the keys or properties that changed. */
export interface FileChange { name: string; change: "added" | "removed" | "content" | "format"; restart: boolean; reasons: string[]; keys: string[] }
export interface MemberChange { member: string; files: FileChange[] }
export interface ChangeAssessment {
  /** A standalone has no such choice and is always "rolling" here; its own flow does not look at this. */
  mode: ChangeMode;
  /** What makes it full; a change of a file that cannot be opened has no key. */
  fullBecause: { file: string; key?: string }[];
  restart: boolean;
  /** Only members and files that change, in the order given. */
  members: MemberChange[];
}

export interface CheckInput {
  profile: ServiceProfile;
  version: string;
  kind: "standalone" | "cluster";
  /** What the configuration would be. */
  members: CheckMember[];
  /** What each member has now (by installation; in a rolling change members can be on different revisions). */
  base?: CheckMember[];
  /** Installations of other services, for the port check. */
  others?: RegisteredMember[];
  /** Each host's memory, from its latest sample; a host without one is skipped and said so. */
  memory?: Record<string, number | null | undefined>;
  /** How much of the machine's memory a heap may take (default 80). */
  heapMaxPct?: number;
  /** P15: by member (installation), how many encrypted values (enc{…}) its flow holds, from its latest sample; absent: not known. */
  encrypted?: Record<string, number | null | undefined>;
}

const HEAP_MAX_PCT = 80;
const ORDER = { error: 0, warning: 1, info: 2 } as const;
/** Changing these needs the flow's secrets migrated, which is not done here (P15). */
const FLOW_ENCRYPTION = new Set(["nifi.sensitive.props.key", "nifi.sensitive.props.algorithm"]);
const ZOOKEEPER = new Set(["nifi.zookeeper.connect.string", "nifi.zookeeper.root.node", "Connect String", "Root Node"]);

const isProperties = (name: string) => /\.(properties|conf)$/.test(name);
const isXml = (name: string) => name.endsWith(".xml");
const shown = (written: string) => decodeText(Buffer.from(written, "latin1"));
const fileOf = (m: CheckMember, name: string) => m.files.find((f) => f.name === name);
const entryOf = (profile: ServiceProfile, key: string, file: string): CatalogEntry | undefined => profile.catalog.find((e) => e.key === key && e.file === file);

/** A kept revision's members, opened for checking. */
export function openMembers(members: readonly ConfigMember[], box: SecretBox): CheckMember[] {
  return members.map((m) => ({
    host: m.host, installDir: m.installDir, confDir: m.confDir,
    files: m.files.map((f) => {
      const opened = openFile(f, box);
      return { name: f.name, sha256: f.sha256, bytes: opened.ok ? opened.bytes : null };
    }),
  }));
}
export const openBody = (body: ServiceConfigBody, box: SecretBox): CheckMember[] => openMembers(body.members, box);

// --- values

const DURATION = /^\d+(\.\d+)?\s*(ns|nanos?|nanoseconds?|ms|millis?|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?)$/i;

/** What is wrong with a value of the catalog's type, or null. Empty is fine: many shipped keys are, and it says "not set".
 *  Says nothing of the value itself, which may be anyone's secret. */
function typeProblem(type: CatalogEntry["type"], value: string): string | null {
  const v = value.trim();
  if (v === "") return null;
  switch (type) {
    case "boolean": return /^(true|false)$/i.test(v) ? null : "is not true or false";
    case "integer": return /^\d+$/.test(v) ? null : "is not a whole number";
    case "port": return /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 65535 ? null : "is not a port (1-65535)";
    case "duration": return DURATION.test(v) ? null : 'is not a duration (such as "5 mins")';
    case "host": return /^[^\s/]+$/.test(v) ? null : "is not a host name or address";
    case "url":
      try {
        new URL(v);
        return null;
      } catch {
        return "is not a URL";
      }
    default: return null;
  }
}

const portOf = (written: string | undefined) => {
  const m = written === undefined ? null : /(?:^|:)(\d{1,5})\/?$/.exec(written.trim());
  const n = m ? Number(m[1]) : 0;
  return n >= 1 && n <= 65535 ? n : null;
};

/** The ports a member's files take, the way discovery reads them (service_executor.py): a cluster's only count on a node. */
function portsOf(m: CheckMember): ServicePorts {
  const read = (name: string) => {
    const f = fileOf(m, name);
    return f?.bytes ? effectiveProperties(f.bytes) : new Map<string, { value: string }>();
  };
  const props = read("nifi.properties"), boot = read("bootstrap.conf");
  const value = (key: string) => props.get(key)?.value;
  const node = value("nifi.cluster.is.node")?.trim().toLowerCase() === "true";
  return {
    https: portOf(value("nifi.web.https.port")), http: portOf(value("nifi.web.http.port")), remoteInput: portOf(value("nifi.remote.input.socket.port")),
    clusterProtocol: node ? portOf(value("nifi.cluster.node.protocol.port")) : null, loadBalance: node ? portOf(value("nifi.cluster.load.balance.port")) : null,
    management: portOf(boot.get("management.server.address")?.value),
  };
}

function portFindings(input: CheckInput, members: CheckMember[]): Found[] {
  const asMember = (m: CheckMember): ServiceMember => ({ host: m.host, installDir: m.installDir, confDir: m.confDir ?? null, serviceUser: null, startEnvironment: null, ports: portsOf(m) });
  const nodes = members.filter((m) => fileOf(m, "nifi.properties")?.bytes).map(asMember);
  if (!nodes.length) return [];
  const base = { id: "this", service: input.profile.service, profile: input.profile.id, version: input.version, webUrl: null };
  const item: DraftItem = input.kind === "cluster" ? { ...base, kind: "cluster", zookeeper: null, zookeeperRoot: null, nodes } : { ...base, kind: "standalone", member: nodes[0]! };
  const out: Found[] = [...(portConflicts([item], input.others ?? []).get("this") ?? [])];
  // portConflicts looks between installations; one can also give the same port to two of its own uses.
  for (const m of nodes) {
    const seen = new Map<number, string>();
    for (const { name, port } of portsTaken(input.profile.id, m.ports)) {
      const first = seen.get(port);
      if (first) out.push({ severity: "error", code: "ports/conflict", member: installKey(m), message: `${installKey(m)} uses port ${port} for both ${first} and ${name}.` });
      else seen.set(port, name);
    }
  }
  return out;
}

const HEAP_UNIT: Record<string, number> = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };
const heapBytes = (size: string) => {
  const m = /^(\d+)([kmgt]?)$/i.exec(size.trim());
  return m ? Number(m[1]) * HEAP_UNIT[m[2]!.toLowerCase()]! : null;
};

function heapFindings(input: CheckInput, m: CheckMember): Found[] {
  const f = fileOf(m, "bootstrap.conf");
  if (!f?.bytes) return [];
  const member = installKey(m), file = "bootstrap.conf", out: Found[] = [];
  // bootstrap.conf numbers its java.arg.N freely: the heap is wherever -Xms and -Xmx are.
  const flag = (x: "ms" | "mx") => {
    const hit = [...effectiveProperties(f.bytes!)].filter(([k, v]) => /^java\.arg\./.test(k) && v.value.trim().startsWith(`-X${x}`)).at(-1);
    if (!hit) return null;
    const bytes = heapBytes(hit[1].value.trim().slice(4));
    if (bytes === null) out.push({ severity: "error", code: "config/bad-value", file, key: hit[0], member, message: `${member}: ${hit[0]} (${file}): the heap size is not a size (such as 4g).` });
    return bytes;
  };
  const min = flag("ms"), max = flag("mx");
  if (min !== null && max !== null && min > max) out.push({ severity: "error", code: "config/heap-order", file, member, message: `${member}: the initial heap (-Xms) is above the maximum (-Xmx); the JVM will not start.` });
  if (max === null) return out;
  const total = input.memory?.[m.host];
  if (!total) {
    out.push({ severity: "info", code: "config/heap-not-checked", file, member, message: `${member}: the heap was not checked against the machine's memory: no sample from ${m.host} yet.` });
    return out;
  }
  const pct = input.heapMaxPct ?? HEAP_MAX_PCT, used = Math.round((max / total) * 100);
  if (max > total) out.push({ severity: "error", code: "config/heap-too-large", file, member, message: `${member}: the maximum heap is more than the machine's memory (${used}%).` });
  else if ((max / total) * 100 > pct) out.push({ severity: "warning", code: "config/heap-too-large", file, member, message: `${member}: the maximum heap is ${used}% of the machine's memory, above ${pct}%.` });
  return out;
}

function memberFindings(input: CheckInput, m: CheckMember): Found[] {
  const member = installKey(m), out: Found[] = [];
  const here = new Map(catalogFor(input.profile, input.version).map((e) => [`${e.file}:${e.key}`, e]));
  for (const f of m.files) {
    if (!f.bytes) {
      out.push({ severity: "error", code: "config/reimport", file: f.name, member, message: `${member}: ${f.name} was imported by an older version and cannot be edited or written back as kept: take the service over again to import it.` });
      continue;
    }
    if (isXml(f.name)) {
      const problem = xmlProblem(decodeText(f.bytes));
      if (problem) out.push({ severity: "error", code: "config/xml-malformed", file: f.name, member, message: `${member}: ${f.name} line ${problem.line}: ${problem.message}.` });
    }
    if (!isProperties(f.name)) continue;
    for (const [key, { value }] of effectiveProperties(f.bytes)) {
      const e = here.get(`${f.name}:${key}`);
      if (!e) {
        if (PROFILES.some((p) => entryOf(p, key, f.name))) out.push({ severity: "warning", code: "config/not-in-version", file: f.name, key, member, message: `${member}: ${key} (${f.name}) does not exist in NiFi ${input.version}; it has no effect.` });
        continue;
      }
      const problem = typeProblem(e.type, value);
      if (problem) out.push({ severity: "error", code: "config/bad-value", file: f.name, key, member, message: `${member}: ${key} (${f.name}) ${problem}.` });
      if (key === "nifi.flow.configuration.file" && input.profile.major >= 2 && /\.xml(\.gz)?\s*$/i.test(value)) out.push({ severity: "error", code: "config/not-in-version", file: f.name, key, member, message: `${member}: ${key} points at an XML flow; NiFi 2.x keeps the flow only as JSON (flow.json.gz).` });
    }
  }
  return [...out, ...heapFindings(input, m)];
}

// --- a cluster's nodes against each other

function withoutComments(text: string): string {
  return text.replace(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->/g, (m) => (m.startsWith("<!--") ? "" : m));
}

/** The named <property> values of an XML file, comments aside, in either quoting. */
function xmlProperties(bytes: Buffer, names: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of withoutComments(decodeText(bytes)).matchAll(/<property\b([^<>]*)>([^<]*)<\/property\s*>/g)) {
    const name = /(?:^|\s)name\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(m[1]!);
    const value = name?.[1] ?? name?.[2];
    if (value !== undefined && names.includes(value)) out.set(value, m[2]!.trim());
  }
  return out;
}

/** The nodes' values of one key, with secrets told apart by labels only. */
function differs(members: CheckMember[], values: string[], secret: boolean) {
  const labels = new Map<string, string>();
  const label = (v: string) => labels.get(v) ?? (labels.set(v, `value ${String.fromCharCode(65 + labels.size)}`), labels.get(v)!);
  return members.map((m, i) => ({ host: m.host, installDir: m.installDir, value: !secret ? values[i]! : values[i] ? label(values[i]!) : "(empty)" }));
}

function clusterFindings(input: CheckInput, members: CheckMember[]): Found[] {
  const out: Found[] = [];
  const opened = (name: string) => members.filter((m) => fileOf(m, name)?.bytes);
  for (const e of catalogFor(input.profile, input.version)) {
    if (e.scope !== "cluster") continue;
    const nodes = opened(e.file);
    if (nodes.length < 2) continue;
    const values = nodes.map((m) => effectiveProperties(fileOf(m, e.file)!.bytes!).get(e.key)?.value ?? e.default ?? "");
    if (new Set(values).size < 2) continue;
    const secret = e.sensitive || isSecretKey(e.key);
    out.push({
      severity: secret || e.grouping ? "error" : "warning", code: "config/cluster-differs", file: e.file, key: e.key,
      message: `${e.key} (${e.file}) differs between the nodes${e.note ? `: ${e.note}` : "."}`,
      values: differs(nodes, secret ? values : values.map(shown), secret),
    });
  }
  for (const [file, names] of Object.entries(input.profile.notRollingXml)) {
    const nodes = opened(file);
    if (nodes.length < 2) continue;
    const props = nodes.map((m) => xmlProperties(fileOf(m, file)!.bytes!, names));
    for (const key of names) {
      const values = props.map((p) => p.get(key) ?? "");
      if (new Set(values).size < 2) continue;
      out.push({ severity: "error", code: "config/cluster-differs", file, key, message: `${key} (${file}) differs between the nodes.`, values: differs(nodes, values, false) });
    }
  }
  return out;
}

// --- what a change means

const xmlMeaning = (bytes: Buffer) => withoutComments(decodeText(bytes)).replace(/>\s+</g, "><").trim();
/** logback.xml reloads itself while NiFi runs, if the running one was told to: it is the file now in place that counts. */
const scans = (bytes: Buffer) => /<configuration\b[^<>]*\bscan\s*=\s*(?:"true"|'true')/i.test(withoutComments(decodeText(bytes)));

function changedKeys(before: Buffer | undefined, after: Buffer | undefined): string[] {
  const a = before ? effectiveProperties(before) : new Map<string, { value: string }>();
  const b = after ? effectiveProperties(after) : new Map<string, { value: string }>();
  return [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k)?.value !== b.get(k)?.value);
}

function fileChange(profile: ServiceProfile, before: CheckFile | undefined, after: CheckFile | undefined, full: ChangeAssessment["fullBecause"]): FileChange | null {
  const name = (after ?? before)!.name;
  if (before && after && before.sha256 === after.sha256) return null;
  const was = before?.bytes ?? undefined, now = after?.bytes ?? undefined;
  const change: FileChange["change"] = !before ? "added" : !after ? "removed" : "content";
  const addFull = (key?: string) => { if (!full.some((x) => x.file === name && x.key === key)) full.push({ file: name, ...(key ? { key } : {}) }); };
  if ((before && !was) || (after && !now)) {
    addFull();
    return { name, change, restart: true, reasons: [`${name} cannot be opened to compare (imported by an older version): taken as needing a restart.`], keys: [] };
  }
  if (isProperties(name)) {
    const keys = changedKeys(was, now);
    if (!keys.length) return { name, change: before && after ? "format" : change, restart: false, reasons: [], keys };
    const reasons: string[] = [];
    let restart = false;
    for (const key of keys) {
      const e = entryOf(profile, key, name);
      if (e?.rolling === false) addFull(key);
      if (!e) reasons.push(`${key}: not in the catalog, taken as needing a restart.`);
      else if (e.restart) reasons.push(`${key}: needs a restart.`);
      restart ||= !e || e.restart;
    }
    return { name, change, restart, reasons, keys };
  }
  const watched = profile.notRollingXml[name] ?? [];
  const keys: string[] = [];
  if (watched.length) {
    const a = was ? xmlProperties(was, watched) : new Map<string, string>(), b = now ? xmlProperties(now, watched) : new Map<string, string>();
    for (const key of watched) if (a.get(key) !== b.get(key)) { keys.push(key); addFull(key); }
  }
  if (isXml(name) && was && now && xmlMeaning(was) === xmlMeaning(now)) return { name, change: "format", restart: false, reasons: [], keys };
  if (name === "logback.xml" && was && now && scans(was)) return { name, change, restart: false, reasons: ["logback.xml has scan on: NiFi reloads it without a restart."], keys };
  return { name, change, restart: true, reasons: [`${name} ${change === "added" ? "is new" : change === "removed" ? "is gone" : "changed"}: needs a restart.`], keys };
}

/** What going from base to members means: per member the files that change, whether to restart, and rolling or full (S31):
 *  any member changing any key that cannot roll makes the whole change full, ordinary keys with it. */
export function assessChange(input: Pick<CheckInput, "profile" | "kind" | "members"> & { base: CheckMember[] }): ChangeAssessment {
  const base = new Map(input.base.map((m) => [installKey(m), m]));
  const full: ChangeAssessment["fullBecause"] = [];
  const members: MemberChange[] = [];
  for (const m of input.members) {
    const was = base.get(installKey(m));
    const names = [...new Set([...m.files.map((f) => f.name), ...(was?.files ?? []).map((f) => f.name)])].sort();
    const files = names.flatMap((name) => fileChange(input.profile, was && fileOf(was, name), fileOf(m, name), full) ?? []);
    if (files.length) members.push({ member: installKey(m), files });
  }
  const cluster = input.kind === "cluster";
  return { mode: cluster && full.length ? "full" : "rolling", fullBecause: cluster ? full : [], restart: members.some((m) => m.files.some((f) => f.restart)), members };
}

/**
 * P15 (owner 2026-11-10): the flow's secrets are not migrated. The executor counts the flow's encrypted values (enc{…},
 * never the values) in its samples: none on every member changing the key, and nothing is said; some, and the warning
 * says what will happen and how it is done by hand; not known (no sample yet, an older executor), and it says "may".
 */
function migrationFinding(input: CheckInput, change: ChangeAssessment, file: string, key: string): Found | null {
  const members = change.members.filter((m) => m.files.some((f) => f.name === file && f.keys.includes(key))).map((m) => m.member);
  const counts = members.map((m) => input.encrypted?.[m]);
  const known = counts.filter((n): n is number => typeof n === "number");
  if (known.length === counts.length && known.every((n) => n === 0)) return null;
  const command = key === "nifi.sensitive.props.key" ? "set-sensitive-properties-key" : "set-sensitive-properties-algorithm";
  const how = input.version.startsWith("1.")
    ? `with every node stopped, migrate the flow with the NiFi toolkit's encrypt-config.sh outside the Deployer (this version's nifi.sh may have no ${command}: 1.12.1 has none; not tried here), then adopt the files here as drift`
    : `with every node stopped, run bin/nifi.sh ${command} on each node outside the Deployer (it re-encrypts the flow and writes nifi.properties), start them, then adopt the files here as drift`;
  const most = known.length ? Math.max(...known) : 0;
  const message = most > 0
    ? `${key}: the flow holds ${most} encrypted value${most > 1 ? "s" : ""} (enc{…}), which stay encrypted the old way: they are not migrated. NiFi will not start with the new setting, and the change rolls back by itself. To change it: ${how}.`
    : `${key}: whether the flow holds encrypted values is not known (${known.length ? "not every member's" : "no member's"} service executor has said yet; an older one never does). If it holds any, they stay encrypted the old way: NiFi will not start with the new setting, and the change rolls back by itself. To change it then: ${how}.`;
  return { severity: "warning", code: "config/sensitive-key-migration", file, key, message };
}

function changeFindings(input: CheckInput & { base: CheckMember[] }, change: ChangeAssessment): Found[] {
  const out: Found[] = [];
  const once = new Set<string>();
  const first = (code: string, file: string, key: string) => {
    const id = `${code}|${file}|${key}`;
    if (once.has(id)) return false;
    once.add(id);
    return true;
  };
  for (const { file, key } of change.fullBecause) {
    out.push({ severity: "warning", code: "config/not-rolling-safe", file, ...(key ? { key } : {}), message: key
      ? `${key} (${file}) cannot change node by node: nodes with the old and the new value cannot share a cluster. The whole change stops and starts the whole cluster.`
      : `${file} cannot be compared, so it may hold a key that cannot change node by node: the whole change stops and starts the whole cluster.` });
  }
  for (const { file, key, member } of change.members.flatMap((m) => m.files.flatMap((f) => f.keys.map((key) => ({ file: f.name, key, member: m.member }))))) {
    const e = entryOf(input.profile, key, file);
    if (FLOW_ENCRYPTION.has(key) && first("config/sensitive-key-migration", file, key)) {
      const migration = migrationFinding(input, change, file, key);
      if (migration) out.push(migration);
    }
    if (input.kind === "cluster" && ZOOKEEPER.has(key) && first("config/zookeeper-state", file, key)) out.push({ severity: "warning", code: "config/zookeeper-state", file, key, message: `${key} (${file}): component state kept in ZooKeeper may not be found at the new place.` });
    if (!e && isProperties(file) && first("config/unknown-key", file, key)) out.push({ severity: "info", code: "config/unknown-key", file, key, message: `${key} (${file}) is not in the ${input.profile.id} catalog: it cannot be checked, and changing it counts as needing a restart.` });
    if (key === "nifi.cluster.is.node") {
      const read = (m: CheckMember | undefined) => {
        const f = m && fileOf(m, file);
        return f?.bytes ? (effectiveProperties(f.bytes).get(key)?.value ?? e?.default ?? "").trim().toLowerCase() === "true" : null;
      };
      const was = read(input.base.find((m) => installKey(m) === member)), now = read(input.members.find((m) => installKey(m) === member));
      // Written out or left to the default is the same thing, and an empty value is not "true" either.
      if (was !== null && now !== null && was !== now) out.push({ severity: "error", code: "config/no-conversion", file, key, member, message: `${member}: ${key} changes: a standalone instance and a cluster node do not convert into each other. To change the form, remove the service and take it over again.` });
    }
  }
  return out;
}

// --- all of it

const idOf = (f: Found) => [f.code, f.file, f.key, f.member, f.code === "ports/conflict" ? f.message : ""].join("|");

function stateFindings(input: CheckInput, members: CheckMember[]): Found[] {
  return [...members.flatMap((m) => memberFindings(input, m)), ...(input.kind === "cluster" ? clusterFindings(input, members) : []), ...portFindings(input, members)];
}

/** The findings of a configuration, worst first, and what the change means when there is a base. Same code, same key and
 *  same member as in the base counts as already there, whatever the values now: such a finding is shown but not introduced. */
export function checkConfig(input: CheckInput): { findings: ConfigFinding[]; change: ChangeAssessment | null } {
  const known = new Set(input.base ? stateFindings(input, input.base).map(idOf) : []);
  const state: ConfigFinding[] = stateFindings(input, input.members).map((f) => ({ ...f, introduced: !known.has(idOf(f)) }));
  const change = input.base ? assessChange({ ...input, base: input.base }) : null;
  const caused: ConfigFinding[] = change ? changeFindings({ ...input, base: input.base! }, change).map((f) => ({ ...f, introduced: true })) : [];
  return { findings: [...state, ...caused].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]), change };
}

/** What stops a plan (§16.2): errors this change brought. What was already there shows and does not block. */
export const blockingFindings = (findings: readonly ConfigFinding[]) => findings.filter((f) => f.severity === "error" && f.introduced);
