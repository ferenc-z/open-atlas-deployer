// What each environment is running (phase 1, read-only). Two sources, neither needs the Docker
// socket in the Deployer's container (§8.2):
// - the host's container list, written by host/report-state.sh (`docker ps` as JSON lines);
// - each own-built service's /meta/contracts (its BUILD.json), asked over the compose network.
// Compared with the environment's desired versions, that gives one status per component.

import { readFileSync, statSync } from "node:fs";
import type { Component, Environment, Manifest } from "../compose/generate.ts";
import { covering } from "../manifest/version.ts";

export interface Container {
  service: string;
  name: string;
  image: string;
  state: string;
  /** healthy, unhealthy, starting, or absent when the image has no health check. */
  health?: string;
  status: string;
  labels: Record<string, string>;
}

export interface HostState { at: string; stale: boolean; containers: Container[] }

/** docker ps --format '{{json .}}' lines; Labels is "k=v,k=v". */
export function parseDockerPs(text: string): Container[] {
  return text.split("\n").filter((l) => l.trim()).map((line) => {
    const raw = JSON.parse(line) as Record<string, string>;
    const labels: Record<string, string> = {};
    for (const pair of (raw.Labels ?? "").split(",")) {
      const i = pair.indexOf("=");
      if (i > 0) labels[pair.slice(0, i)] = pair.slice(i + 1);
    }
    const health = /\((healthy|unhealthy|health: starting)\)/.exec(raw.Status ?? "")?.[1]?.replace("health: ", "");
    return {
      service: labels["com.docker.compose.service"] ?? raw.Names ?? "",
      name: raw.Names ?? "",
      image: raw.Image ?? "",
      state: raw.State ?? "",
      ...(health ? { health } : {}),
      status: raw.Status ?? "",
      labels,
    };
  });
}

export function readHostState(file: string | undefined, now = Date.now(), staleAfterMs = 5 * 60_000): HostState | undefined {
  if (!file) return undefined;
  try {
    const mtime = statSync(file).mtimeMs;
    return { at: new Date(mtime).toISOString(), stale: now - mtime > staleAfterMs, containers: parseDockerPs(readFileSync(file, "utf8")) };
  } catch {
    return undefined;
  }
}

export type Observation =
  | { kind: "build"; version: string; commit?: string; provides?: Record<string, string> }
  /** Answered, but started without a BUILD.json (a development run). */
  | { kind: "no-build-info" }
  | { kind: "unreachable" };

/**
 * Asks a service for its BUILD.json at /meta/contracts on each of its container ports. Only images
 * we build carry one, so public images are never asked.
 */
export class Observer {
  private cache = new Map<string, { at: number; value: Observation }>();
  private urls: Record<string, string>;
  private fetcher: typeof fetch;
  private now: () => number;
  private ttlMs: number;

  constructor(urls: Record<string, string> = {}, fetcher: typeof fetch = fetch, now: () => number = Date.now, ttlMs = 30_000) {
    this.urls = urls;
    this.fetcher = fetcher;
    this.now = now;
    this.ttlMs = ttlMs;
  }

  /** Drops a cached answer, so the next ask goes to the service (right after a deploy). */
  forget(service: string) { this.cache.delete(service); }

  async observe(c: Component): Promise<Observation | undefined> {
    if (c.type !== "compose-service" || c.source?.kind !== "company-registry") return undefined;
    const hit = this.cache.get(c.service!);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;
    const bases = this.urls[c.service!] ? [this.urls[c.service!]!] : (c.ports ?? []).map((p) => `http://${c.service}:${p.container}`);
    let value: Observation = { kind: "unreachable" };
    for (const base of bases) {
      try {
        const response = await this.fetcher(new URL("/meta/contracts", base), { signal: AbortSignal.timeout(2_000) });
        const body = await response.json().catch(() => undefined) as Record<string, any> | undefined;
        if (response.ok && typeof body?.version === "string") {
          value = { kind: "build", version: body.version, ...(body.commit ? { commit: body.commit } : {}), ...(body.provides ? { provides: body.provides } : {}) };
          break;
        }
        if (response.status === 404 && body?.findings) { value = { kind: "no-build-info" }; break; }
      } catch {
        // try the next port
      }
    }
    this.cache.set(c.service!, { at: this.now(), value });
    return value;
  }
}

/**
 * ok: running, healthy if it has a health check, at the desired version as far as anything says;
 * drift: running another version than desired; down: there but not running or unhealthy;
 * starting; missing: no container; unknown: no host state to say.
 */
export type Verdict = "ok" | "drift" | "down" | "starting" | "missing" | "unknown" | "not-a-service";

export interface ComponentStatus {
  id: string;
  type: string;
  service?: string;
  verdict: Verdict;
  container?: Pick<Container, "name" | "image" | "state" | "health" | "status"> & { version?: string };
  observed?: Observation;
}

export interface AppStatus {
  app: string;
  name: string;
  desired?: string;
  /** appliesFrom of the manifest covering the desired version. */
  manifest?: string;
  /** Worst component verdict among the services. */
  verdict: Verdict;
  components: ComponentStatus[];
}

export interface EnvironmentStatus {
  environment: string;
  host?: { at: string; stale: boolean };
  apps: AppStatus[];
  /** Containers in the project that no registered manifest names. */
  unmanaged: Pick<Container, "service" | "image" | "state" | "status">[];
}

const RANK: Verdict[] = ["not-a-service", "ok", "unknown", "starting", "drift", "missing", "down"];
const worst = (vs: Verdict[]) => vs.reduce<Verdict>((a, b) => (RANK.indexOf(b) > RANK.indexOf(a) ? b : a), "not-a-service");

function verdictFor(desired: string | undefined, container: Container | undefined, host: HostState | undefined, observed: Observation | undefined): Verdict {
  if (!host) return observed?.kind === "build" && desired && observed.version !== desired ? "drift" : "unknown";
  if (!container) return "missing";
  if (container.state !== "running" || container.health === "unhealthy") return "down";
  if (container.health === "starting") return "starting";
  const versions = [container.labels["org.open-atlas.version"], observed?.kind === "build" ? observed.version : undefined].filter(Boolean);
  if (desired && versions.some((v) => v !== desired)) return "drift";
  return "ok";
}

export async function environmentStatus(
  env: Environment,
  apps: { id: string; name: string; manifests: Manifest[] }[],
  host: HostState | undefined,
  observer: Observer,
): Promise<EnvironmentStatus> {
  const byService = new Map((host?.containers ?? []).map((c) => [c.service, c]));
  const named = new Set<string>();
  const out: AppStatus[] = [];
  for (const app of apps) {
    const desired = env.apps[app.id]?.version;
    const latest = app.manifests.at(-1);
    const manifest = desired ? covering(app.manifests, desired) : latest;
    const components = await Promise.all((manifest?.components ?? []).map(async (c): Promise<ComponentStatus> => {
      if (c.type !== "compose-service") return { id: c.id, type: c.type, verdict: "not-a-service" };
      named.add(c.service!);
      const container = byService.get(c.service!);
      const observed = await observer.observe(c);
      return {
        id: c.id, type: c.type, service: c.service,
        verdict: verdictFor(desired, container, host, observed),
        ...(container ? { container: { name: container.name, image: container.image, state: container.state, ...(container.health ? { health: container.health } : {}), status: container.status, ...(container.labels["org.open-atlas.version"] ? { version: container.labels["org.open-atlas.version"] } : {}) } } : {}),
        ...(observed ? { observed } : {}),
      };
    }));
    out.push({
      app: app.id, name: app.name,
      ...(desired ? { desired } : {}),
      ...(manifest ? { manifest: manifest.appliesFrom } : {}),
      verdict: desired ? worst(components.map((c) => c.verdict)) : "unknown",
      components,
    });
  }
  return {
    environment: env.name,
    ...(host ? { host: { at: host.at, stale: host.stale } } : {}),
    apps: out,
    unmanaged: (host?.containers ?? []).filter((c) => !named.has(c.service)).map((c) => ({ service: c.service, image: c.image, state: c.state, status: c.status })),
  };
}
