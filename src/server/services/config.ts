// Service ops §6 step 5, §7: a service's configuration as the Deployer keeps it. Confirming a takeover imports each
// installation's configuration files (svc-read) as revision 1, the way D38 imports environment.json; from then on the
// database is what counts. Files hold passwords and keys, so each is kept sealed whole (SecretBox, like env secrets) and
// beside it a redacted copy for the pages: secret values read "(hidden)". Layering a cluster into a common layer and
// node overrides (§7) is for configuration management; revision 1 keeps every installation's files as they were.

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
/** A configuration revision's body: one entry per installation (a standalone's one, each node of a cluster). */
export interface ServiceConfigBody { members: ConfigMember[] }

const formatOf = (name: string): ConfigFileRecord["format"] => (/\.(properties|conf)$/.test(name) ? "properties" : /\.xml$/.test(name) ? "xml" : "other");

/** A file's bytes as they are kept: sealed whole, with a redacted copy. */
export function sealFile(f: Pick<ConfigFileRecord, "name" | "path" | "modifiedAt">, raw: Buffer, box: SecretBox): ConfigFileRecord {
  const text = decodeText(raw);
  const format = formatOf(f.name);
  const { text: redacted, secrets } = format === "properties" ? redactProperties(text) : format === "xml" ? redactXml(text) : { text, secrets: [] };
  return { name: f.name, path: f.path, sha256: createHash("sha256").update(raw).digest("hex"), size: raw.length, modifiedAt: f.modifiedAt, format, sealed: box.seal(raw.toString("base64")), sealedAs: "base64", redacted, secrets };
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

/** A revision as the pages get it: without the sealed copies. */
export function withoutSealed(body: ServiceConfigBody): { members: (Omit<ConfigMember, "files"> & { files: Omit<ConfigFileRecord, "sealed" | "sealedAs">[] })[] } {
  return { members: body.members.map((m) => ({ ...m, files: m.files.map(({ sealed: _s, sealedAs: _a, ...f }) => f) })) };
}
