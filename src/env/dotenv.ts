// Env files (design §7.2): reading and writing them the way docker compose reads them, reading an app's
// .env.example (or the Deployer's template) as the list of keys it expects, and checking a set of values
// against both that list and the ${KEY} references in the app's compose fragment.
// Pure: no files, no secrets handling — callers decide what is masked.

import type { Manifest } from "../compose/generate.ts";

export const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ParsedEnv { values: Record<string, string>; errors: string[] }

/** Parses an env file as compose does: bare, 'single' (literal) and "double" (escapes) quoted values, inline # comments on bare values. */
export function parseEnv(text: string): ParsedEnv {
  const values: Record<string, string> = {};
  const errors: string[] = [];
  const src = text.replace(/\r\n?/g, "\n");
  let i = 0;
  let line = 1;
  while (i < src.length) {
    const end = src.indexOf("\n", i) === -1 ? src.length : src.indexOf("\n", i);
    const raw = src.slice(i, end);
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) { i = end + 1; line++; continue; }
    const m = /^\s*(?:export\s+)?([^=\s]+)\s*=\s*/.exec(raw);
    if (!m || !KEY.test(m[1]!)) {
      errors.push(`Line ${line} is not KEY=value: ${trimmed.slice(0, 60)}`);
      i = end + 1; line++; continue;
    }
    const key = m[1]!;
    let j = i + m[0].length;
    const quote = src[j];
    if (quote === "'" || quote === '"') {
      let value = "";
      j++;
      let closed = false;
      while (j < src.length) {
        const ch = src[j]!;
        if (ch === quote) { closed = true; j++; break; }
        if (quote === '"' && ch === "\\" && j + 1 < src.length) {
          const next = src[j + 1]!;
          value += ({ n: "\n", t: "\t", r: "\r", "\\": "\\", '"': '"', $: "$" } as Record<string, string>)[next] ?? `\\${next}`;
          j += 2;
          continue;
        }
        if (ch === "\n") line++;
        value += ch;
        j++;
      }
      if (!closed) errors.push(`The quotes of ${key} are not closed`);
      values[key] = value;
      const rest = src.indexOf("\n", j) === -1 ? src.length : src.indexOf("\n", j);
      const tail = src.slice(j, rest).trim();
      if (tail && !tail.startsWith("#")) errors.push(`${key} has more text after its quotes: ${tail.slice(0, 40)}`);
      i = rest + 1; line++;
      continue;
    }
    let value = src.slice(j, end);
    const comment = /\s#/.exec(value);
    if (comment) value = value.slice(0, comment.index);
    values[key] = value.trim();
    i = end + 1; line++;
  }
  return { values, errors };
}

const BARE = /^[A-Za-z0-9_.,:/@+=%^-]*$/;

/** One value as compose reads it back unchanged: bare when safe, else 'literal', else "escaped". */
export function quote(value: string): string {
  if (BARE.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t").replace(/\$/g, "\\$")}"`;
}

/** The env file the Deployer writes: keys in the example's order, then the rest alphabetically. */
export function serializeEnv(values: Record<string, string>, header: string, order: string[] = []): string {
  const keys = [...order.filter((k) => k in values), ...Object.keys(values).filter((k) => !order.includes(k)).sort()];
  return [...header.split("\n").map((l) => `# ${l}`.trimEnd()), ...keys.map((k) => `${k}=${quote(values[k]!)}`)].join("\n") + "\n";
}

export interface ExampleKey { key: string; required: boolean; example: string; comment?: string }

/** An .env.example: `KEY=value` lines are keys to set, `#KEY=` lines are known optional keys. */
export function parseExample(text: string): ExampleKey[] {
  const out = new Map<string, ExampleKey>();
  let comment: string[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    const set = /^(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    const optional = /^#\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    const m = set ?? optional;
    if (m) {
      let example = m[2]!;
      let note: string | undefined;
      const hash = /\s+#\s*(.*)$/.exec(example);
      if (hash) { note = hash[1]; example = example.slice(0, hash.index); }
      example = example.trim().replace(/^(['"])(.*)\1$/, "$2");
      const desc = note ?? (comment.length ? comment.join(" ") : undefined);
      if (!out.has(m[1]!) || set) out.set(m[1]!, { key: m[1]!, required: Boolean(set), example, ...(desc ? { comment: desc } : {}) });
      continue;
    }
    if (!line) { comment = []; continue; }
    if (line.startsWith("#")) comment.push(line.replace(/^#+\s?/, ""));
  }
  return [...out.values()];
}

/** Keys the app's compose fragment reads from its env file: ${KEY} and ${KEY:?…} must be set, ${KEY:-…} need not. */
export function referencedKeys(manifest: Manifest): { required: string[]; optional: string[] } {
  const required = new Set<string>();
  const optional = new Set<string>();
  const scan = (s: string) => {
    for (const m of s.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?([-?+])[^}]*)?\}/g)) {
      (m[2] === undefined || m[2] === "?" ? required : optional).add(m[1]!);
    }
  };
  for (const c of manifest.components) {
    for (const v of Object.values((c as { environment?: Record<string, string> }).environment ?? {})) scan(v);
    for (const v of Object.values((c as { settings?: Record<string, string> }).settings ?? {})) scan(v);
  }
  for (const k of required) optional.delete(k);
  return { required: [...required].sort(), optional: [...optional].sort() };
}

export interface EnvFinding { code: string; key: string; message: string; blocking: boolean; suggestion?: string }

function distance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]!;
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = d[j]!;
      d[j] = Math.min(d[j]! + 1, d[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return d[b.length]!;
}

/** A key from the example that an unknown key was probably renamed from (or to). */
function similar(key: string, candidates: string[]): string | undefined {
  const tail = (k: string) => k.split("_").slice(-2).join("_");
  let best: { key: string; score: number } | undefined;
  for (const c of candidates) {
    const d = distance(key, c);
    const close = d <= Math.max(2, Math.floor(Math.min(key.length, c.length) / 5)) || (tail(key) === tail(c) && tail(c).includes("_"));
    if (close && (!best || d < best.score)) best = { key: c, score: d };
  }
  return best?.key;
}

/**
 * Checks values against the example and the fragment's references. Only an unset ${KEY} the fragment
 * needs blocks (compose would start the service with an empty value); the rest are shown to decide on.
 */
export function checkEnv(present: string[], example: ExampleKey[] | null, referenced: { required: string[] }): EnvFinding[] {
  const findings: EnvFinding[] = [];
  const set = new Set(present);
  for (const key of referenced.required) {
    if (!set.has(key)) findings.push({ code: "env/referenced-missing", key, blocking: true, message: `The compose fragment uses \${${key}}, which the env file does not have.` });
  }
  if (!example) return findings;
  const known = new Map(example.map((e) => [e.key, e]));
  const missing = example.filter((e) => e.required && !set.has(e.key)).map((e) => e.key);
  const unset = example.filter((e) => !set.has(e.key)).map((e) => e.key);
  for (const key of missing) {
    if (!referenced.required.includes(key)) findings.push({ code: "env/missing", key, blocking: false, message: `.env.example requires ${key}.` });
  }
  for (const key of present) {
    if (known.has(key)) continue;
    const was = similar(key, unset);
    findings.push({
      code: was ? "env/renamed" : "env/unknown", key, blocking: false,
      message: was ? `${key} is not in .env.example; it may have been renamed to ${was}.` : `${key} is not in .env.example: the app may no longer use it.`,
      ...(was ? { suggestion: was } : {}),
    });
  }
  return findings;
}

export type KeyChange = { key: string; change: "added" | "removed" | "changed"; secret: boolean };

/** What changed between two sets of values; secrets are only named, never their values. */
export function changedKeys(before: Record<string, string>, after: Record<string, string>, secrets: string[]): KeyChange[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.flatMap((key): KeyChange[] => {
    const secret = secrets.includes(key);
    if (!(key in before)) return [{ key, change: "added", secret }];
    if (!(key in after)) return [{ key, change: "removed", secret }];
    return before[key] === after[key] ? [] : [{ key, change: "changed", secret }];
  });
}

/** Services that read a changed key: the ones given the whole env file, and those whose environment names the key. */
export function affectedServices(manifest: Manifest, changed: string[]): string[] {
  const out: string[] = [];
  for (const c of manifest.components) {
    if (c.type !== "compose-service" || !c.service) continue;
    const env = Object.values((c as { environment?: Record<string, string> }).environment ?? {}).join("\n");
    if ((c as { envFile?: boolean }).envFile || changed.some((k) => new RegExp(`\\$\\{${k}(?:[:}?+-])`).test(env))) out.push(c.service);
  }
  return out;
}
