// Service ops §9.3: what looks like a password, a token or a key is hidden before log lines and bulletins reach the AI.
// The same rules as the service executor's REDACT (service_executor.py), which already applies them to the WARN/ERROR
// summary; searched lines, the last lines of a file, a tail and bulletins come raw from the executor and NiFi, so the
// MCP tools pass them through here. The pages show people with deploy-viewer the raw text (§9.3 only asks it for the AI).

const RULES: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[private key hidden]"],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [hidden]"],
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, "[token hidden]"],
  [/((?:pass(?:word|wd|phrase)?|pwd|secret|token|credentials?|api[_-]?key|access[_-]?key|private[_-]?key|sensitive\.props\.key)[\w.-]*["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi, "$1[hidden]"],
  [/(\w+:\/\/[^/\s:@]+:)[^@\s/]+@/gi, "$1[hidden]@"],
];

/** One text with secret-looking parts hidden. */
export function redactText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}

/** Every string inside a JSON value redacted (objects' keys stay as they are). */
export function redactStrings<T>(value: T): T {
  if (typeof value === "string") return redactText(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactStrings(v)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactStrings(v)])) as T;
  return value;
}

/** S28: names of FlowFile attributes whose values are hidden from the AI (the value says nothing about its secrecy). */
const SECRET_NAME = /pass(word|wd|phrase)?|pwd|secret|token|credential|api[_.-]?key|access[_.-]?key|private|auth|session|cookie|\.key$|^key$/i;

/** A provenance answer for the AI: attributes ({name, value, previousValue}) with secret-looking names hidden, then
 *  every string as redactStrings does. */
export function redactProvenance<T>(value: T): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const hide = typeof o.name === "string" && ("value" in o || "previousValue" in o) && SECRET_NAME.test(o.name);
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, hide && (k === "value" || k === "previousValue") && x !== null && x !== undefined ? "[hidden]" : walk(x)]));
    }
    return v;
  };
  return redactStrings(walk(value) as T);
}
