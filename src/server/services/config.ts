// Service ops §6 step 5, §7: a service's configuration as the Deployer keeps it. Confirming a takeover imports each
// installation's configuration files (svc-read) as revision 1, the way D38 imports environment.json; from then on the
// database is what counts. Files hold passwords and keys, so each is kept sealed whole (SecretBox, like env secrets) and
// beside it a redacted copy for the pages: secret values read "(hidden)". Layering a cluster into a common layer and
// node overrides (§7) is services/layers.ts; revision 1 keeps every installation's files as they were.

import { createHash } from "node:crypto";
import type { SecretBox } from "../secretbox.ts";
import { decodeText, redactProperties, redactXml } from "./configdoc.ts";

export { isSecretKey, redactProperties, redactXml, SECRET_NAME } from "./configdoc.ts";

/** One file as the executor sent it over the content channel (svc-read). */
export interface ReadFile { name: string; path: string; sha256: string; size: number; modifiedAt: string; content: string }

export interface ConfigFileRecord {
  name: string;
  path: string;
  sha256: string;
  size: number;
  modifiedAt: string;
  format: "properties" | "xml" | "other";
  /** The whole file, sealed (SecretBox): its bytes in base64 when sealedAs says so; else, in revisions from before it,
   *  the bytes read as UTF-8, which is not always the file: see openFile. */
  sealed: string;
  sealedAs?: "base64";
  /** The file with secret values replaced by "(hidden)", for the pages and the AI. */
  redacted: string;
  /** Keys (properties) or property names (XML) whose values were hidden. */
  secrets: string[];
}

/** confDir: where the files were read (each file also carries its own path); absent in revisions imported before it was kept. */
export interface ConfigMember { host: string; installDir: string; confDir?: string; files: ConfigFileRecord[]; missing: string[] }
/** A file of a cluster's layers: kept like a member's file, but belonging to no path. */
export type LayerFile = Omit<ConfigFileRecord, "path" | "modifiedAt">;
/** A node's value for a key, both as written in the file (bytes read as latin1); a secret's is sealed on its own. */
export type LayerValue = { key: string; value: string } | { key: string; sealed: string };
/** What a node has of a file on top of the common layer, or instead of it (replace: no common copy of this file). */
export type NodeFileLayer = { set: LayerValue[]; unset: string[] } | { replace: LayerFile };
/** How a cluster's files are made (§16.3): common holds each file's template, nodes (by installKey) what differs. */
export interface ConfigLayers { common: Record<string, LayerFile>; nodes: Record<string, Record<string, NodeFileLayer>> }
/** A configuration revision's body: one entry per installation (a standalone's one, each node of a cluster), each with
 *  its files as rendered, complete; layers (a cluster, once edited) is what they were rendered from. */
export interface ServiceConfigBody { members: ConfigMember[]; layers?: ConfigLayers }

const formatOf = (name: string): ConfigFileRecord["format"] => (/\.(properties|conf)$/.test(name) ? "properties" : /\.xml$/.test(name) ? "xml" : "other");

/** A file's bytes as they are kept: sealed whole, with a redacted copy. */
export function sealFile(f: Pick<ConfigFileRecord, "name" | "path" | "modifiedAt">, raw: Buffer, box: SecretBox): ConfigFileRecord {
  const text = decodeText(raw);
  const format = formatOf(f.name);
  const { text: redacted, secrets } = format === "properties" ? redactProperties(text) : format === "xml" ? redactXml(text) : { text, secrets: [] };
  return { name: f.name, path: f.path, sha256: createHash("sha256").update(raw).digest("hex"), size: raw.length, modifiedAt: f.modifiedAt, format, sealed: box.seal(raw.toString("base64")), sealedAs: "base64", redacted, secrets };
}

/** A file's text with its secrets hidden, the way a new kept copy would have it. */
export function redactedText(name: string, raw: Buffer): string {
  const text = decodeText(raw), format = formatOf(name);
  return format === "properties" ? redactProperties(text).text : format === "xml" ? redactXml(text).text : text;
}

/** One read file as it is kept, checked against its hash. */
export function importFile(f: ReadFile, box: SecretBox): ConfigFileRecord {
  const raw = Buffer.from(f.content, "base64");
  if (createHash("sha256").update(raw).digest("hex") !== f.sha256) throw new Error(`${f.path} does not match its sha256`);
  return sealFile(f, raw, box);
}

export type OpenedFile = { ok: true; bytes: Buffer } | { ok: false; code: "config/reimport"; message: string };

/** A kept file's bytes, for editing and writing back. A revision from before raw bytes were sealed may have lost some
 *  (bytes that were not UTF-8): when the hash says so the file cannot be edited or written back, only imported again. */
export function openFile(f: ConfigFileRecord, box: SecretBox): OpenedFile {
  const refused = { ok: false as const, code: "config/reimport" as const, message: `${f.name} was imported by an older version and cannot be edited as kept: take the service over again to import it` };
  let bytes: Buffer;
  try {
    const opened = box.open(f.sealed);
    bytes = f.sealedAs === "base64" ? Buffer.from(opened, "base64") : Buffer.from(opened, "utf8");
  } catch {
    return refused;
  }
  return createHash("sha256").update(bytes).digest("hex") === f.sha256 ? { ok: true, bytes } : refused;
}

/** A kept file as text, for comparing on the server; unseal opens the sealed copy (SecretBox.open). */
export function sealedText(f: Pick<ConfigFileRecord, "sealed" | "sealedAs">, unseal: (sealed: string) => string): string {
  const opened = unseal(f.sealed);
  return f.sealedAs === "base64" ? decodeText(Buffer.from(opened, "base64")) : opened;
}

type Unsealed<T> = Omit<T, "sealed" | "sealedAs">;
const unsealed = <T extends { sealed: string; sealedAs?: "base64" }>({ sealed: _s, sealedAs: _a, ...f }: T): Unsealed<T> => f;

export type LayerValueView = { key: string; value: string } | { key: string; hidden: true };
export type NodeFileLayerView = { set: LayerValueView[]; unset: string[] } | { replace: Unsealed<LayerFile> };
export interface ConfigLayersView { common: Record<string, Unsealed<LayerFile>>; nodes: Record<string, Record<string, NodeFileLayerView>> }

const layerView = (l: NodeFileLayer): NodeFileLayerView => "replace" in l
  ? { replace: unsealed(l.replace) }
  : { set: l.set.map((v) => ("sealed" in v ? { key: v.key, hidden: true as const } : { key: v.key, value: decodeText(Buffer.from(v.value, "latin1")) })), unset: l.unset };

/** A revision as the pages get it: without the sealed copies, in the members and in the layers. */
export function withoutSealed(body: ServiceConfigBody): { members: (Omit<ConfigMember, "files"> & { files: Unsealed<ConfigFileRecord>[] })[]; layers?: ConfigLayersView } {
  const members = body.members.map((m) => ({ ...m, files: m.files.map(unsealed) }));
  if (!body.layers) return { members };
  return { members, layers: {
    common: Object.fromEntries(Object.entries(body.layers.common).map(([name, f]) => [name, unsealed(f)])),
    nodes: Object.fromEntries(Object.entries(body.layers.nodes).map(([node, files]) => [node, Object.fromEntries(Object.entries(files).map(([name, l]) => [name, layerView(l)]))])),
  } };
}
