// Service ops S24: a configuration revision as the Configuration tab shows it. Each properties file of each
// installation is parsed into rows (key, value, line, the catalog section, and whether it differs from the shipped
// default); a cluster's files are also compared node by node, the differences first and by how much they matter.
// Secret values stay hidden: rows carry the redacted "(hidden)", and when the caller can open the sealed copies, nodes
// are compared on the real values but only labelled "value A" / "value B", never shown (like the takeover findings).

import { sealedText, type ConfigFileRecord, type ServiceConfigBody } from "./config.ts";
import { parsePropertyEntries } from "./configdoc.ts";
import { catalogFor, profile as profileById, sectionOf, SECTIONS, type CatalogEntry, type Section } from "./profiles.ts";

const HIDDEN = "(hidden)";

export interface PropertyLine { key: string; value: string; line: number }

/** The key = value entries of a properties file, with 1-based line numbers. */
export function parseProperties(text: string): PropertyLine[] {
  return parsePropertyEntries(text).map((e) => ({ key: e.key, value: e.value.trimEnd(), line: e.line }));
}

/** default: the shipped value; changed: set to something else; hidden: a secret (not compared); unknown: not in the catalog. */
export type RowStatus = "default" | "changed" | "hidden" | "unknown";
export interface PropertyRow extends PropertyLine { section: Section; status: RowStatus }

export type CatalogView = Pick<CatalogEntry, "key" | "file" | "type" | "default" | "scope" | "restart" | "sensitive" | "section" | "description" | "note" | "grouping">;

const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? "").trim() === (b ?? "").trim();

export function rowsOf(file: Pick<ConfigFileRecord, "name" | "redacted">, catalog: Map<string, CatalogView>): PropertyRow[] {
  return parseProperties(file.redacted).map((l) => {
    const e = catalog.get(`${file.name}:${l.key}`);
    const status: RowStatus = l.value === HIDDEN ? "hidden" : !e ? "unknown" : e.default === null ? (l.value === "" ? "default" : "changed") : same(l.value, e.default) ? "default" : "changed";
    return { ...l, section: e ? e.section : file.name === "bootstrap.conf" && /^java\.arg\./.test(l.key) ? sectionOf(l.key, file.name) : "Other", status };
  });
}

export type Severity = "error" | "warning" | "info";
/** One key across a cluster's nodes, in the members' order; from: the file's value, the catalog default (left out), or not set at all. */
export interface CompareRow { key: string; section: Section; severity: Severity | null; values: { value: string | null; from: "file" | "default" | "unset" }[] }
export interface FileCompare { name: string; format: ConfigFileRecord["format"]; rows: CompareRow[]; differing: number; identical: boolean }

const RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/** The severity of a difference: a key the nodes must agree on is an error when secret or grouping, else a warning;
 *  a per-node key is expected to differ (info); a key the catalog does not know is a warning. */
const severityOf = (e: CatalogView | undefined): Severity => (!e ? "warning" : e.scope === "node" ? "info" : e.sensitive || e.grouping ? "error" : "warning");

function compareFile(name: string, files: (ConfigFileRecord | undefined)[], catalog: Map<string, CatalogView>, unseal?: (sealed: string) => string): FileCompare {
  const format = files.find(Boolean)?.format ?? "other";
  const identical = files.every((f) => f && f.sha256 === files[0]?.sha256);
  if (format !== "properties") return { name, format, rows: [], differing: identical ? 0 : 1, identical };
  const shown = files.map((f) => new Map((f ? parseProperties(f.redacted) : []).map((l) => [l.key, l.value])));
  const real = unseal ? files.map((f) => { try { return f ? new Map(parseProperties(sealedText(f, unseal)).map((l) => [l.key, l.value])) : undefined; } catch { return undefined; } }) : [];
  const keys: string[] = [];
  for (const m of shown) for (const k of m.keys()) if (!keys.includes(k)) keys.push(k);
  const rows = keys.map((key): CompareRow => {
    const e = catalog.get(`${name}:${key}`);
    const hidden = shown.some((m) => m.get(key) === HIDDEN);
    const values = shown.map((m, i) => {
      if (m.has(key)) return { value: m.get(key)!, from: "file" as const, real: hidden ? real[i]?.get(key) : m.get(key)! };
      return e && e.default !== null ? { value: e.default, from: "default" as const, real: e.default } : { value: null, from: "unset" as const, real: null };
    });
    let differs: boolean;
    if (hidden) {
      // Secrets: compared on the opened values when there are, labelled; else only whether each node has one.
      const comparable = values.every((v) => v.real !== undefined);
      const labels = new Map<string, string>();
      const label = (v: string | null | undefined) => (v === null || v === undefined || v === "" ? "(empty)" : labels.get(v) ?? (labels.set(v, `value ${String.fromCharCode(65 + labels.size)}`), labels.get(v)!));
      differs = comparable ? new Set(values.map((v) => v.real ?? "")).size > 1 : new Set(values.map((v) => v.from)).size > 1;
      return { key, section: e?.section ?? "Other", severity: differs ? severityOf(e) : null, values: values.map((v) => ({ value: comparable && differs ? label(v.real) : v.value, from: v.from })) };
    }
    differs = new Set(values.map((v) => (v.value ?? "").trim())).size > 1;
    return { key, section: e?.section ?? "Other", severity: differs ? severityOf(e) : null, values: values.map(({ value, from }) => ({ value, from })) };
  });
  rows.sort((a, b) => (a.severity ? RANK[a.severity] : 9) - (b.severity ? RANK[b.severity] : 9));
  return { name, format, rows, differing: rows.filter((r) => r.severity).length, identical };
}

export interface ConfigView {
  sections: readonly Section[];
  /** The profile's catalog for the service's version, keyed by file:key in the rows. */
  catalog: CatalogView[];
  /** Per member (the body's order), per properties file: the rows. */
  rows: { host: string; installDir: string; files: Record<string, PropertyRow[]> }[];
  /** A cluster's files compared across its nodes (null for a standalone instance). */
  compare: FileCompare[] | null;
}

/** The view of one revision of a service with the given profile and version. */
export function configView(body: ServiceConfigBody, profileId: string, version: string, kind: "standalone" | "cluster", unseal?: (sealed: string) => string): ConfigView {
  const prof = profileById(profileId);
  const catalog: CatalogView[] = (prof ? catalogFor(prof, version) : []).map(({ key, file, type, default: d, scope, restart, sensitive, section, description, note, grouping }) =>
    ({ key, file, type, default: d, scope, restart, sensitive, section, description, ...(note ? { note } : {}), ...(grouping ? { grouping } : {}) }));
  const byKey = new Map(catalog.map((e) => [`${e.file}:${e.key}`, e]));
  const rows = body.members.map((m) => ({
    host: m.host, installDir: m.installDir,
    files: Object.fromEntries(m.files.filter((f) => f.format === "properties").map((f) => [f.name, rowsOf(f, byKey)])),
  }));
  let compare: FileCompare[] | null = null;
  if (kind === "cluster") {
    const names: string[] = [];
    for (const m of body.members) for (const f of m.files) if (!names.includes(f.name)) names.push(f.name);
    compare = names.map((n) => compareFile(n, body.members.map((m) => m.files.find((f) => f.name === n)), byKey, unseal));
  }
  return { sections: SECTIONS, catalog, rows, compare };
}
