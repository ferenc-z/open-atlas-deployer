// Service ops §16.3: a configuration file as a document that can be edited without disturbing it. Properties files are
// edited line by line over the file's bytes (read as latin1, which maps every byte to one character and back), so
// comments, order, CRLF and bytes in any encoding stay as they are, and no change gives the same bytes back. XML is
// edited as a whole text; what a page or the AI sends back has "(hidden)" where secrets were, and those go back to the
// previous revision's values here. Error messages name keys, tags and lines, never a value.

import { PROFILES } from "./profiles.ts";

export const HIDDEN = "(hidden)";

/** The names discovery hides too (service_executor.py SECRET_PROPERTY). */
export const SECRET_NAME = /pass(word|wd|phrase)?|secret|token|credential|sensitive\.props\.key|\.key$|private/i;

/** Keys the name rule catches but the catalog lists as not sensitive (service_executor.py NOT_SECRET_PROPERTY). Whatever
 *  lands here comes out of hiding, so a test pins the list (testdata/redact/cases.json). */
export const NOT_SECRET_KEYS: ReadonlySet<string> = new Set(PROFILES.flatMap((p) => p.catalog).filter((e) => !e.sensitive && SECRET_NAME.test(e.key)).map((e) => e.key));

export const isSecretKey = (name: string) => SECRET_NAME.test(name) && !NOT_SECRET_KEYS.has(name);

/** A submitted change this module refuses; code is the finding's code. */
export class ConfigDocError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** A file's bytes as text for reading: UTF-8 when they are valid UTF-8, else ISO-8859-1 (what Java properties files are). */
export function decodeText(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return bytes.toString("latin1");
  }
}

// --- properties

/** One key = value of a properties file. A value continued with a backslash spans several physical lines. */
export interface PropertyEntry {
  /** As written (escapes kept); name: with the escapes read, what Java would see. */
  key: string;
  name: string;
  /** As written, with continued lines joined. */
  value: string;
  /** 1-based physical line. */
  line: number;
  /** Physical lines taken. */
  lines: number;
  /** Indentation, key and separator, up to the value. */
  prefix: string;
  /** Whether the prefix has a separator (a key alone has none). */
  separated: boolean;
}

/** The physical lines with their terminators (Java's: \n, \r, \r\n). The last may have none. */
function physicalLines(text: string): { body: string; eol: string }[] {
  const out: { body: string; eol: string }[] = [];
  const re = /\r\n|\r|\n/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push({ body: text.slice(at, m.index), eol: m[0] });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ body: text.slice(at), eol: "" });
  return out;
}

const continues = (line: string) => (/\\*$/.exec(line)![0].length) % 2 === 1;

const unescapeKey = (key: string) =>
  key.replace(/\\(?:u([0-9a-fA-F]{4})|(.))/g, (_all, hex: string | undefined, c: string | undefined) => (hex ? String.fromCharCode(parseInt(hex, 16)) : c === "t" ? "\t" : c === "n" ? "\n" : c === "r" ? "\r" : c === "f" ? "\f" : c!));

function parseEntries(lines: { body: string }[]): PropertyEntry[] {
  const out: PropertyEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const first = lines[i]!.body;
    const start = /^[ \t\f]*/.exec(first)![0].length;
    if (start === first.length || first[start] === "#" || first[start] === "!") continue;
    const line = i + 1;
    let logical = first;
    let taken = 1;
    while (continues(logical) && i + 1 < lines.length) {
      i++;
      taken++;
      logical = logical.slice(0, -1) + lines[i]!.body.replace(/^[ \t\f]+/, "");
    }
    if (continues(logical)) logical = logical.slice(0, -1);
    let end = start;
    while (end < logical.length && !/[=: \t\f]/.test(logical[end]!)) end += logical[end] === "\\" ? 2 : 1;
    end = Math.min(end, logical.length);
    const sep = /^[ \t\f]*[=:]?[ \t\f]*/.exec(logical.slice(end))![0];
    const key = logical.slice(start, end);
    out.push({ key, name: unescapeKey(key), value: logical.slice(end + sep.length), line, lines: taken, prefix: logical.slice(0, end + sep.length), separated: sep !== "" });
  }
  return out;
}

/** The key = value entries of a properties file, by Java's rules (=, : or whitespace; # and ! comments; \ continues). */
export function parsePropertyEntries(text: string): PropertyEntry[] {
  return parseEntries(physicalLines(text));
}

/** A properties file with the values of secret keys hidden (an empty one stays empty). A secret's continued lines
 *  are hidden too and left blank, so line numbers still match the file. */
export function redactProperties(text: string): { text: string; secrets: string[] } {
  const lines = physicalLines(text);
  const secrets: string[] = [];
  for (const e of parseEntries(lines)) {
    if (e.value === "" || !isSecretKey(e.name)) continue;
    secrets.push(e.key);
    lines[e.line - 1]!.body = `${e.prefix}${HIDDEN}`;
    for (let i = 1; i < e.lines; i++) lines[e.line - 1 + i]!.body = "";
  }
  return { text: lines.map((l) => l.body + l.eol).join(""), secrets };
}

export type PropertyChange = { key: string; value: string } | { key: string; unset: true };

/** A new value as a properties file holds it: anything beyond ASCII as \uXXXX, which reads the same whatever the file's
 *  encoding is (NiFi loads these files as ISO-8859-1). Values are otherwise as written, like the ones parsed. */
export function encodeValue(key: string, value: string): string {
  if (value.includes(HIDDEN)) throw new ConfigDocError("config/hidden-value", `${key}: "${HIDDEN}" is a placeholder, not a value`);
  if (/[\x00-\x08\n-\x1f\x7f]/.test(value)) throw new ConfigDocError("config/bad-value", `${key}: the value has a line break or a control character`);
  if (/^[ \t\f]/.test(value)) throw new ConfigDocError("config/bad-value", `${key}: the value starts with whitespace, which Java drops`);
  if (continues(value)) throw new ConfigDocError("config/bad-value", `${key}: the value ends in a backslash, which would continue the line`);
  return value.replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** The line ending most of the file uses (\n when it has none). */
function mainEol(lines: { eol: string }[]): string {
  const count = (eol: string) => lines.filter((l) => l.eol === eol).length;
  return ["\r\n", "\r"].find((eol) => count(eol) > count("\n")) ?? "\n";
}

function dropEntry(text: string, name: string): string {
  const lines = physicalLines(text);
  const same = parseEntries(lines).filter((e) => e.name === name);
  if (!same.length) return text;
  const gone = new Set(same.flatMap((e) => Array.from({ length: e.lines }, (_, i) => e.line - 1 + i)));
  return lines.filter((_, i) => !gone.has(i)).map((l) => l.body + l.eol).join("");
}

/** The key (as written) set to the value (as written). */
function writeEntry(text: string, key: string, value: string): string {
  const lines = physicalLines(text);
  const name = unescapeKey(key);
  const last = parseEntries(lines).filter((e) => e.name === name).at(-1);
  if (!last) {
    const eol = mainEol(lines);
    return !text ? `${key}=${value}${eol}` : lines.at(-1)!.eol ? `${text}${key}=${value}${eol}` : `${text}${eol}${key}=${value}`;
  }
  // Java keeps the last of a repeated key, so that is the one to change.
  if (last.value === value) return text;
  const from = last.line - 1;
  const eol = lines[from + last.lines - 1]!.eol;
  const replaced = { body: `${last.prefix}${last.separated ? "" : "="}${value}`, eol };
  return [...lines.slice(0, from), replaced, ...lines.slice(from + last.lines)].map((l) => l.body + l.eol).join("");
}

function applyChange(text: string, change: PropertyChange): string {
  const { key } = change;
  if (!/^[\x21-\x7e]+$/.test(key) || /[=:\\]/.test(key) || /^[#!]/.test(key)) throw new ConfigDocError("config/bad-key", "A key is plain ASCII without =, :, \\ or a leading # or !");
  return "unset" in change ? dropEntry(text, key) : writeEntry(text, key, encodeValue(key, change.value));
}

/** A properties file with the changes made: only the lines of the changed keys differ, a new key goes at the end, and a
 *  key removed goes with all its lines. No change (or setting what is already there) gives the same bytes. */
export function editProperties(bytes: Buffer, changes: readonly PropertyChange[]): Buffer {
  return Buffer.from(changes.reduce(applyChange, bytes.toString("latin1")), "latin1");
}

/** A key and value exactly as a file has them: the bytes read as latin1, escapes kept. */
export interface WrittenProperty { key: string; value: string }

/** What Java would load from a properties file: by key, the last of a repeated one. */
export function effectiveProperties(bytes: Buffer): Map<string, WrittenProperty> {
  return new Map(parsePropertyEntries(bytes.toString("latin1")).map((e) => [e.name, { key: e.key, value: e.value }]));
}

/** A template with keys removed and set, as written: unlike editProperties nothing is re-encoded, so a value taken from
 *  a file goes back as the same bytes. Keys and values must still fit on the one line they get. */
export function writeProperties(template: Buffer, set: readonly WrittenProperty[], unset: readonly string[] = []): Buffer {
  let text = template.toString("latin1");
  for (const key of unset) text = dropEntry(text, unescapeKey(key));
  for (const { key, value } of set) {
    const parsed = parsePropertyEntries(`${key}=`);
    if (parsed.length !== 1 || parsed[0]!.key !== key) throw new ConfigDocError("config/bad-key", "A key does not read back as one key");
    if (/[\r\n]/.test(value) || continues(value)) throw new ConfigDocError("config/bad-value", `${key}: the value would not stay on one line`);
    text = writeEntry(text, key, value);
  }
  return Buffer.from(text, "latin1");
}

// --- XML

interface XmlSlot {
  kind: "property" | "attribute";
  name: string;
  /** Where the value is in the text. */
  start: number;
  end: number;
}

const SECRET_ATTRIBUTE = /password|passwd|passphrase|pwd|secret|token|credential/i;

/** Every place in an XML file that holds a secret: the text of <property name="...">, in either quoting, with other
 *  attributes, CDATA or comments, and attributes with secret-looking names. Empty values count, so that positions among
 *  same-named ones do not depend on which are set. Commented-out ones count too. */
function xmlSlots(text: string): XmlSlot[] {
  const slots: XmlSlot[] = [];
  for (const m of text.matchAll(/<property\b([^<>]*)>([^<]*(?:(?:<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->)[^<]*)*)<\/property\s*>/g)) {
    const name = /(?:^|\s)name\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(m[1]!);
    const value = name?.[1] ?? name?.[2];
    if (value === undefined || !isSecretKey(value)) continue;
    const start = m.index + "<property".length + m[1]!.length + 1;
    slots.push({ kind: "property", name: value, start, end: start + m[2]!.length });
  }
  const inProperty = (at: number) => slots.some((s) => s.kind === "property" && s.start <= at && at < s.end);
  for (const m of text.matchAll(/(\s)([\w.-]+)(\s*=\s*)(?:"([^"]*)"|'([^']*)')/g)) {
    if (!SECRET_ATTRIBUTE.test(m[2]!) || inProperty(m.index)) continue;
    const start = m.index + m[1]!.length + m[2]!.length + m[3]!.length + 1;
    slots.push({ kind: "attribute", name: m[2]!, start, end: start + (m[4] ?? m[5])!.length });
  }
  return slots.sort((a, b) => a.start - b.start);
}

/** An XML file with secret values hidden; an empty one stays empty. */
export function redactXml(text: string): { text: string; secrets: string[] } {
  const secrets: string[] = [];
  let out = "";
  let at = 0;
  for (const s of xmlSlots(text)) {
    if (text.slice(s.start, s.end).trim() === "") continue;
    secrets.push(s.name);
    out += text.slice(at, s.start) + HIDDEN;
    at = s.end;
  }
  return { text: out + text.slice(at), secrets };
}

/** What was submitted for an XML file, with each "(hidden)" back to the previous value of the same name (the n-th of a
 *  name to the n-th). A "(hidden)" with no such place is refused: a new or renamed one has no value to go back to. */
export function restoreXmlSecrets(submitted: string, previous: string): string {
  const key = (s: XmlSlot) => `${s.kind}:${s.name}`;
  const before = new Map<string, string[]>();
  for (const s of xmlSlots(previous)) before.set(key(s), [...(before.get(key(s)) ?? []), previous.slice(s.start, s.end)]);
  const slots = xmlSlots(submitted);
  const count = new Map<string, number>();
  for (const s of slots) count.set(key(s), (count.get(key(s)) ?? 0) + 1);
  const seen = new Map<string, number>();
  let out = "";
  let at = 0;
  const refuseStray = (part: string) => {
    if (part.includes(HIDDEN)) throw new ConfigDocError("config/hidden-value", `"${HIDDEN}" is only a placeholder for a secret kept from the previous revision, and this one has none`);
  };
  for (const s of slots) {
    const nth = seen.get(key(s)) ?? 0;
    seen.set(key(s), nth + 1);
    const value = submitted.slice(s.start, s.end);
    if (value.trim() !== HIDDEN) continue;
    const old = before.get(key(s));
    if (!old || old.length !== count.get(key(s)) || old[nth]!.trim() === "") throw new ConfigDocError("config/hidden-unmatched", `"${s.name}": "${HIDDEN}" has no value in the previous revision (added or renamed): enter the value`);
    refuseStray(submitted.slice(at, s.start));
    out += submitted.slice(at, s.start) + old[nth];
    at = s.end;
  }
  refuseStray(submitted.slice(at));
  return out + submitted.slice(at);
}

/** An XML file's new bytes from the text submitted for it, in the previous file's encoding. Sending back the redacted
 *  copy unchanged gives the same bytes. A textarea turns CRLF into LF, so a CRLF file stays CRLF when nothing says otherwise. */
export function editXml(previous: Buffer, submitted: string): Buffer {
  const before = decodeText(previous);
  const restored = restoreXmlSecrets(/\r\n/.test(before) && !/(?:^|[^\r])\n/.test(before) && !/\r/.test(submitted) ? submitted.replace(/\n/g, "\r\n") : submitted, before);
  const utf8 = Buffer.from(before, "utf8").equals(previous);
  if (!utf8 && /[^\x00-\xff]/.test(restored)) throw new ConfigDocError("config/bad-value", "The file is ISO-8859-1 and the new text has characters it cannot hold");
  return Buffer.from(restored, utf8 ? "utf8" : "latin1");
}

export interface XmlProblem { line: number; message: string }

/** The first thing keeping a text from being well-formed XML, or null. A small checker, not a parser: tags nest and
 *  match, one root, attributes well written and not repeated, entities written properly, no DTD processing. */
export function xmlProblem(text: string): XmlProblem | null {
  const NAME = /[A-Za-z_:\u0080-￿][\w:.\-\u0080-￿]*/y;
  const name = (from: number) => {
    NAME.lastIndex = from;
    return NAME.exec(text)?.[0];
  };
  const fail = (at: number, message: string): XmlProblem => ({ line: text.slice(0, at).split("\n").length, message });
  const badEntity = (part: string) => /&(?!(?:[A-Za-z_:][\w:.-]*|#[0-9]+|#x[0-9a-fA-F]+);)/.test(part);
  const stack: string[] = [];
  let roots = 0;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    const part = text.slice(i, lt < 0 ? text.length : lt);
    if (!stack.length && part.trim()) return fail(i, "Text outside the root element");
    if (badEntity(part)) return fail(i + part.indexOf("&"), "A bare & (write &amp;)");
    if (lt < 0) break;
    const closing = (mark: string, what: string, from = lt) => {
      const at = text.indexOf(mark, from);
      return at < 0 ? { problem: fail(lt, `${what} is not closed`) } : { end: at + mark.length, at };
    };
    if (text.startsWith("<!--", lt)) {
      const c = closing("-->", "A comment", lt + 4);
      if (c.problem) return c.problem;
      if (text.slice(lt + 4, c.at).includes("--")) return fail(lt, "A comment contains --");
      i = c.end!;
    } else if (text.startsWith("<![CDATA[", lt)) {
      if (!stack.length) return fail(lt, "CDATA outside the root element");
      const c = closing("]]>", "A CDATA section", lt + 9);
      if (c.problem) return c.problem;
      i = c.end!;
    } else if (text.startsWith("<?", lt)) {
      const c = closing("?>", "A processing instruction", lt + 2);
      if (c.problem) return c.problem;
      i = c.end!;
    } else if (text.startsWith("<!DOCTYPE", lt)) {
      if (roots) return fail(lt, "DOCTYPE after the root element");
      let depth = 0;
      let j = lt;
      for (; j < text.length; j++) {
        if (text[j] === "[") depth++;
        else if (text[j] === "]") depth--;
        else if (text[j] === ">" && depth <= 0) break;
      }
      if (j >= text.length) return fail(lt, "DOCTYPE is not closed");
      i = j + 1;
    } else if (text.startsWith("</", lt)) {
      const tag = name(lt + 2);
      if (!tag) return fail(lt, "A closing tag without a name");
      const gt = /^\s*>/.exec(text.slice(lt + 2 + tag.length, lt + 2 + tag.length + 256));
      if (!gt) return fail(lt, `</${tag}> is not closed`);
      if (stack.at(-1) !== tag) return fail(lt, stack.length ? `</${tag}> closes <${stack.at(-1)}>` : `</${tag}> has no opening tag`);
      stack.pop();
      i = lt + 2 + tag.length + gt[0].length;
    } else {
      const tag = name(lt + 1);
      if (!tag) return fail(lt, "A < that starts no tag (write &lt;)");
      if (!stack.length && roots++) return fail(lt, "More than one root element");
      let j = lt + 1 + tag.length;
      const attrs = new Set<string>();
      for (;;) {
        const space = /^\s*/.exec(text.slice(j, j + 4096))![0].length;
        j += space;
        if (j >= text.length) return fail(lt, `<${tag}> is not closed`);
        if (text[j] === ">") {
          stack.push(tag);
          j++;
          break;
        }
        if (text.startsWith("/>", j)) {
          j += 2;
          break;
        }
        const attr = name(j);
        if (!attr || !space) return fail(j, `<${tag}>: an attribute is badly written`);
        if (attrs.has(attr)) return fail(j, `<${tag}>: attribute ${attr} is repeated`);
        attrs.add(attr);
        const eq = /^\s*=\s*/.exec(text.slice(j + attr.length, j + attr.length + 4096));
        const q = eq ? text[j + attr.length + eq[0].length] : undefined;
        if (!eq || (q !== '"' && q !== "'")) return fail(j, `<${tag}>: attribute ${attr} has no quoted value`);
        const open = j + attr.length + eq[0].length + 1;
        const close = text.indexOf(q, open);
        if (close < 0) return fail(j, `<${tag}>: attribute ${attr} is not closed`);
        const value = text.slice(open, close);
        if (value.includes("<")) return fail(j, `<${tag}>: attribute ${attr} contains <`);
        if (badEntity(value)) return fail(j, `<${tag}>: attribute ${attr} has a bare &`);
        j = close + 1;
      }
      i = j;
    }
  }
  if (stack.length) return fail(text.length, `<${stack.at(-1)}> is not closed`);
  if (!roots) return fail(0, "No root element");
  return null;
}
