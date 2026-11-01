// How apps are reached (design §7.4, D36). One DNS name per environment; nginx terminates HTTPS and tells apps apart
// by port (https://<domain>:<port>, the apps do not run under sub-paths), forwarding to the app's published port on
// its host. Going through nginx is each app's choice: an app with ingress "direct" is reached at
// http://<its host's address>:<published port>. Apps refer to each other as {{app:<id>.url}}; the Deployer resolves
// that when it writes compose fragments and env files. nginx is kept by operations: the Deployer only generates the
// recommended configuration and keeps its revisions; after a deploy it checks the app's address once and only warns.

import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Environment, Ingress, Manifest } from "../compose/generate.ts";
import { hostIds, hostOf } from "./handoff.ts";

export interface Endpoint {
  app: string;
  kind: Ingress["kind"];
  /** What other apps and people use. */
  url?: string;
  /** nginx only: where it forwards, <host address>:<published port>. */
  upstream?: string;
  /** nginx only: the host binds its ports to loopback, so nginx has to run on it. */
  loopback?: string;
  /** Why no address could be worked out. */
  problem?: string;
}

const hostAddress = (env: Environment, host: string) => env.hosts?.[host]?.address ?? (hostIds(env).length === 1 ? "localhost" : undefined);

/** The host port a component publishes for a container port (the environment's override first). */
function publishedPort(env: Environment, manifest: Manifest, appId: string, component?: string, containerPort?: number): number | undefined {
  const services = manifest.components.filter((c) => c.type === "compose-service" && (!component || c.id === component));
  for (const c of services) {
    for (const p of c.ports ?? []) {
      if (containerPort && p.container !== containerPort) continue;
      const host = env.apps[appId]?.overrides?.[c.id]?.ports?.[String(p.container)] ?? p.host;
      if (host) return host;
    }
  }
  return undefined;
}

/** How an app is reached in this environment, from its ingress setting and the manifest that applies. */
export function endpoint(env: Environment, appId: string, manifest: Manifest | undefined): Endpoint | undefined {
  const ingress = env.apps[appId]?.ingress;
  if (!ingress) return undefined;
  const host = hostOf(env, appId);
  const address = hostAddress(env, host);
  const port = manifest ? publishedPort(env, manifest, appId, ingress.component, ingress.containerPort) : undefined;
  if (!port) return { app: appId, kind: ingress.kind, problem: `${appId} publishes no host port${ingress.component ? ` on ${ingress.component}` : ""}${ingress.containerPort ? ` for container port ${ingress.containerPort}` : ""}` };
  // Ports bound to loopback are only reachable from the host itself: nginx then runs there and forwards to that address.
  const bind = env.hosts?.[host]?.bindIp ?? env.bindIp;
  const loopback = ingress.kind === "nginx" && bind.startsWith("127.");
  if (!address && !loopback) return { app: appId, kind: ingress.kind, problem: `host ${host} has no address in environment.json` };
  if (ingress.kind === "direct") return { app: appId, kind: "direct", url: `http://${address}:${port}` };
  const upstream = `${loopback ? bind : address}:${port}`;
  if (!env.domain) return { app: appId, kind: "nginx", upstream, problem: "the environment has no domain (environment.json domain)" };
  const path = ingress.path ?? "/";
  return { app: appId, kind: "nginx", url: `https://${env.domain}${ingress.port === 443 ? "" : `:${ingress.port}`}${path}`, upstream, ...(loopback ? { loopback: host } : {}) };
}

const REF = /\{\{app:([a-z][a-z0-9-]{0,62})\.(url|origin)\}\}/g;

/** Every {{app:<id>.url|origin}} in a text. */
export function references(text: string): { app: string; part: string }[] {
  return [...text.matchAll(REF)].map((m) => ({ app: m[1]!, part: m[2]! }));
}

/** Replaces the references; what cannot be resolved is listed and left as it was. */
export function resolveReferences(text: string, lookup: (app: string) => Endpoint | undefined): { text: string; unresolved: string[] } {
  const unresolved: string[] = [];
  const out = text.replace(REF, (whole, app: string, part: string) => {
    const e = lookup(app);
    if (!e?.url) { unresolved.push(`${whole}: ${e?.problem ?? `${app} has no ingress in this environment`}`); return whole; }
    return part === "origin" ? new URL(e.url).origin : e.url.replace(/\/$/, "");
  });
  return { text: out, unresolved };
}

/** The recommended nginx configuration for every app behind nginx: one server per port, a location per path. */
export function nginxConfig(env: Environment, manifests: Record<string, Manifest | undefined>): { body: string; sha256: string; problems: string[] } {
  const problems: string[] = [];
  const byPort = new Map<number, { e: Endpoint; ingress: Extract<Ingress, { kind: "nginx" }> }[]>();
  for (const appId of Object.keys(env.apps).sort()) {
    const ingress = env.apps[appId]!.ingress;
    if (ingress?.kind !== "nginx") continue;
    const e = endpoint(env, appId, manifests[appId]);
    if (!e?.upstream || e.problem) { problems.push(`${appId}: ${e?.problem ?? "no address"}`); continue; }
    byPort.set(ingress.port, [...(byPort.get(ingress.port) ?? []), { e, ingress }]);
  }
  const tls = env.nginx ?? {};
  const lines = [
    `# Recommended nginx configuration for environment ${env.name}, generated by Open Atlas Deployer (design §7.4, D36).`,
    "# Kept by operations: apply it on the nginx host; the Deployer never changes nginx. TLS ends here, the apps run plain HTTP.",
    "# Session cookies of every app on this domain must have distinct names: browsers do not separate cookies by port.",
    "",
    "map $http_upgrade $connection_upgrade { default upgrade; '' close; }",
  ];
  for (const [port, entries] of [...byPort.entries()].sort((a, b) => a[0] - b[0])) {
    lines.push("", "server {",
      `    listen ${port} ssl;`,
      `    server_name ${env.domain ?? "<domain>"};`,
      `    ssl_certificate     ${tls.certificate ?? "/etc/nginx/tls/<domain>.crt"};`,
      `    ssl_certificate_key ${tls.certificateKey ?? "/etc/nginx/tls/<domain>.key"};`,
      `    client_max_body_size ${entries.map((x) => x.ingress.maxBodySize).find(Boolean) ?? "100m"};`);
    // Longest path first, so /deploy/ wins over /.
    for (const { e, ingress } of [...entries].sort((a, b) => (b.ingress.path ?? "/").length - (a.ingress.path ?? "/").length)) {
      lines.push("",
        `    # ${e.app}${e.loopback ? ` (ports bound to loopback: nginx must run on host ${e.loopback})` : ""}`,
        `    location ${ingress.path ?? "/"} {`,
        `        proxy_pass http://${e.upstream};`,
        "        proxy_http_version 1.1;",
        "        proxy_set_header Host $http_host;",
        "        proxy_set_header X-Forwarded-Proto https;",
        "        proxy_set_header X-Forwarded-Host $http_host;",
        "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
        "        proxy_set_header Upgrade $http_upgrade;",
        "        proxy_set_header Connection $connection_upgrade;",
        "        # Streams (chat, session events) and long requests: no buffering, OMA reads for up to 600 s.",
        "        proxy_buffering off;",
        "        proxy_read_timeout 600s;",
        "        proxy_send_timeout 600s;",
        "    }");
    }
    lines.push("}");
  }
  const body = `${lines.join("\n")}\n`;
  return { body, sha256: createHash("sha256").update(body).digest("hex"), problems };
}

/** A line diff of two texts, for showing what a new nginx revision changes. */
export function lineDiff(before: string, after: string): string {
  const a = before.split("\n"), b = after.split("\n");
  const m = a.length, n = b.length;
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && a[i] === b[j]) { out.push(`  ${a[i]}`); i++; j++; }
    else if (j < n && (i >= m || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) out.push(`+ ${b[j++]}`);
    else out.push(`- ${a[i++]}`);
  }
  return out.join("\n");
}

export interface IngressCheck { url: string; ok: boolean; status?: number; error?: string; at: string }

/**
 * Reaches the app at its address once. Any answer but nginx's 502–504 means nginx reached the app; trusts the
 * internal CA when one is configured.
 */
export function checkUrl(url: string, ca?: string, timeoutMs = 10_000): Promise<Omit<IngressCheck, "at">> {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = (u.protocol === "https:" ? httpsRequest : httpRequest)(u, { method: "GET", timeout: timeoutMs, ...(ca && u.protocol === "https:" ? { ca } : {}) }, (res) => {
      res.resume();
      const status = res.statusCode ?? 0;
      resolve({ url, ok: status > 0 && ![502, 503, 504].includes(status), status });
    });
    req.on("timeout", () => req.destroy(new Error(`no answer within ${timeoutMs / 1000} s`)));
    req.on("error", (error) => resolve({ url, ok: false, error: error.message }));
    req.end();
  });
}
