// Service ops §6 step 5, §7: a service's configuration as the Deployer keeps it. Confirming a takeover imports each
// installation's configuration files (svc-read) as revision 1, the way D38 imports environment.json; from then on the
// database is what counts. Files hold passwords and keys, so each is kept sealed whole (SecretBox, like env secrets) and
// beside it a redacted copy for the pages: secret values read "(hidden)". Layering a cluster into a common layer and
// node overrides (§7) is for configuration management; revision 1 keeps every installation's files as they were.

import { createHash } from "node:crypto";
import type { SecretBox } from "../secretbox.ts";

/** One file as the executor sent it over the content channel (svc-read). */
export interface ReadFile { name: string; path: string; sha256: string; size: number; modifiedAt: string; content: string }

export interface ConfigFileRecord {
  name: string;
  path: string;
  sha256: string;
  size: number;
  modifiedAt: string;
  format: "properties" | "xml" | "other";
  /** The whole file, sealed (SecretBox). */
  sealed: string;
  /** The file with secret values replaced by "(hidden)", for the pages and the AI. */
  redacted: string;
  /** Keys (properties) or property names (XML) whose values were hidden. */
  secrets: string[];
}

/** confDir: where the files were read (each file also carries its own path); absent in revisions imported before it was kept. */
export interface ConfigMember { host: string; installDir: string; confDir?: string; files: ConfigFileRecord[]; missing: string[] }
/** A configuration revision's body: one entry per installation (a standalone's one, each node of a cluster). */
export interface ServiceConfigBody { members: ConfigMember[] }

/** The names discovery hides too (service_executor.py SECRET_PROPERTY). */
export const SECRET_NAME = /pass(word|wd|phrase)?|secret|token|credential|sensitive\.props\.key|\.key$|private/i;

const HIDDEN = "(hidden)";

/** A properties file with the values of secret-looking keys hidden (an empty one stays empty). */
export function redactProperties(text: string): { text: string; secrets: string[] } {
  const secrets: string[] = [];
  const out = text.split("\n").map((line) => {
    const m = /^(\s*)([^#!\s=:][^=:\s]*)(\s*[=:]\s*)(.*?)(\r?)$/.exec(line);
    if (!m || !SECRET_NAME.test(m[2]!) || m[4] === "") return line;
    secrets.push(m[2]!);
    return `${m[1]}${m[2]}${m[3]}${HIDDEN}${m[5]}`;
  });
  return { text: out.join("\n"), secrets };
}

/** An XML file with secret values hidden: <property name="...Password">x</property> and password="x" attributes. */
export function redactXml(text: string): { text: string; secrets: string[] } {
  const secrets: string[] = [];
  let out = text.replace(/(<property\s+name\s*=\s*"([^"]*)"\s*>)([^<]*)(<\/property>)/g, (all, open: string, name: string, value: string, close: string) => {
    if (!SECRET_NAME.test(name) || value.trim() === "") return all;
    secrets.push(name);
    return `${open}${HIDDEN}${close}`;
  });
  out = out.replace(/(\s)([\w.-]*(?:[Pp]assword|[Ss]ecret|[Tt]oken)[\w.-]*)(\s*=\s*")([^"]+)(")/g, (_all, sp: string, name: string, eq: string, _v: string, q: string) => {
    secrets.push(name);
    return `${sp}${name}${eq}${HIDDEN}${q}`;
  });
  return { text: out, secrets };
}

const formatOf = (name: string): ConfigFileRecord["format"] => (/\.(properties|conf)$/.test(name) ? "properties" : /\.xml$/.test(name) ? "xml" : "other");

/** One read file as it is kept: checked against its hash, sealed whole, and redacted. */
export function importFile(f: ReadFile, box: SecretBox): ConfigFileRecord {
  const raw = Buffer.from(f.content, "base64");
  if (createHash("sha256").update(raw).digest("hex") !== f.sha256) throw new Error(`${f.path} does not match its sha256`);
  const text = raw.toString("utf8");
  const format = formatOf(f.name);
  const { text: redacted, secrets } = format === "properties" ? redactProperties(text) : format === "xml" ? redactXml(text) : { text, secrets: [] };
  return { name: f.name, path: f.path, sha256: f.sha256, size: raw.length, modifiedAt: f.modifiedAt, format, sealed: box.seal(text), redacted, secrets };
}

/** A revision as the pages get it: without the sealed copies. */
export function withoutSealed(body: ServiceConfigBody): { members: (Omit<ConfigMember, "files"> & { files: Omit<ConfigFileRecord, "sealed">[] })[] } {
  return { members: body.members.map((m) => ({ ...m, files: m.files.map(({ sealed: _s, ...f }) => f) })) };
}
