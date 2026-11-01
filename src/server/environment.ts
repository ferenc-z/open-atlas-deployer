// The environment settings as revisions in the state database (§10.8, D38 ①): environment.json is imported once as
// revision 1, after that the database is what plans and deploys read. Every save names the revision it was based on,
// is checked here first, and records the paths it changed. A finding names where (at) and what was expected.

const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const NAME = /^[a-z0-9][a-z0-9_-]*$/;
const TOP = new Set(["name", "project", "bindIp", "registries", "requireEvaluation", "hosts", "domain", "nginx", "extraHosts", "apps"]);
const APP = new Set(["version", "host", "ingress", "ca", "uatSoakHours", "overrides", "settings"]);
const HOST = new Set(["address", "bindIp", "project"]);

export interface EnvironmentFinding { at: string; expected: string }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown) => typeof v === "string" && v.trim() !== "";

export function validateEnvironment(value: unknown): EnvironmentFinding[] {
  const out: EnvironmentFinding[] = [];
  const bad = (at: string, expected: string) => out.push({ at, expected });
  if (!isObject(value)) return [{ at: "(document)", expected: "an object" }];
  for (const k of Object.keys(value)) if (!TOP.has(k)) bad(k, `a known setting (${[...TOP].join(", ")})`);
  if (!isText(value.name)) bad("name", "the environment's name, e.g. uat or prod");
  if (typeof value.project !== "string" || !NAME.test(value.project)) bad("project", "a compose project name (lowercase letters, digits, - and _)");
  if (!isText(value.bindIp)) bad("bindIp", "the address published ports bind to, e.g. 127.0.0.1");
  if (!isObject(value.registries) || Object.values(value.registries).some((r) => !isText(r))) bad("registries", "registry name → image prefix, e.g. { \"ghcr\": \"ghcr.io/acme\" }");
  if (value.requireEvaluation !== undefined && typeof value.requireEvaluation !== "boolean") bad("requireEvaluation", "true or false");
  if (value.domain !== undefined && !isText(value.domain)) bad("domain", "the DNS name nginx serves, e.g. uat.example.internal");
  if (value.nginx !== undefined && (!isObject(value.nginx) || Object.values(value.nginx).some((v) => typeof v !== "string"))) bad("nginx", "{ certificate, certificateKey } paths on the nginx host");
  if (value.extraHosts !== undefined && (!Array.isArray(value.extraHosts) || value.extraHosts.some((h) => typeof h !== "string" || !/^[^:\s]+:[^\s]+$/.test(h)))) bad("extraHosts", "\"<name>:<address>\" lines, e.g. uat.example.internal:host-gateway");
  const hosts = isObject(value.hosts) ? value.hosts : undefined;
  if (value.hosts !== undefined && !hosts) bad("hosts", "host name → { address, bindIp?, project? }");
  for (const [id, h] of Object.entries(hosts ?? {})) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) bad(`hosts.${id}`, "a host name of lowercase letters, digits and -");
    if (!isObject(h)) { bad(`hosts.${id}`, "{ address, bindIp?, project? }"); continue; }
    for (const k of Object.keys(h)) if (!HOST.has(k)) bad(`hosts.${id}.${k}`, `a known host setting (${[...HOST].join(", ")})`);
    if (!isText(h.address)) bad(`hosts.${id}.address`, "how other hosts and nginx reach it");
    if (h.bindIp !== undefined && !isText(h.bindIp)) bad(`hosts.${id}.bindIp`, "an address");
    if (h.project !== undefined && (typeof h.project !== "string" || !NAME.test(h.project))) bad(`hosts.${id}.project`, "a compose project name");
  }
  if (!isObject(value.apps)) { bad("apps", "app id → { version, … }"); return out; }
  const seen = new Map<string, string>();
  for (const [id, a] of Object.entries(value.apps)) {
    const at = `apps.${id}`;
    if (!isObject(a)) { bad(at, "{ version, host?, ingress?, … }"); continue; }
    for (const k of Object.keys(a)) if (!APP.has(k)) bad(`${at}.${k}`, `a known app setting (${[...APP].join(", ")})`);
    if (typeof a.version !== "string" || !VERSION.test(a.version)) bad(`${at}.version`, "a version like 1.2.0");
    if (a.host !== undefined && (typeof a.host !== "string" || !hosts || !(a.host in hosts))) bad(`${at}.host`, `one of the hosts (${Object.keys(hosts ?? {}).join(", ") || "none defined"})`);
    if (a.ca !== undefined && typeof a.ca !== "boolean") bad(`${at}.ca`, "true or false");
    if (a.uatSoakHours !== undefined && (typeof a.uatSoakHours !== "number" || a.uatSoakHours < 0)) bad(`${at}.uatSoakHours`, "hours, 0 or more");
    if (a.overrides !== undefined && !isObject(a.overrides)) bad(`${at}.overrides`, "component id → { ports?, volumes? }");
    if (a.settings !== undefined && !isObject(a.settings)) bad(`${at}.settings`, "component id → settings");
    const ingress = a.ingress;
    if (ingress === undefined) continue;
    if (!isObject(ingress) || (ingress.kind !== "nginx" && ingress.kind !== "direct")) { bad(`${at}.ingress`, "{ kind: nginx, port, path? } or { kind: direct }"); continue; }
    if (ingress.kind === "nginx") {
      if (!Number.isInteger(ingress.port) || (ingress.port as number) < 1 || (ingress.port as number) > 65535) bad(`${at}.ingress.port`, "the port nginx listens on for this app");
      if (ingress.path !== undefined && (typeof ingress.path !== "string" || !ingress.path.startsWith("/"))) bad(`${at}.ingress.path`, "a path starting with /");
      const where = `${ingress.port}${ingress.path ?? "/"}`;
      if (seen.has(where)) bad(`${at}.ingress`, `a port and path no other app uses (${seen.get(where)} is already at ${where})`);
      seen.set(where, id);
    }
    if (ingress.containerPort !== undefined && !Number.isInteger(ingress.containerPort)) bad(`${at}.ingress.containerPort`, "a container port");
  }
  if (isText(value.domain) === false && Object.values(value.apps).some((a) => isObject(a) && isObject(a.ingress) && a.ingress.kind === "nginx")) bad("domain", "the DNS name nginx serves: apps go through nginx");
  return out;
}
