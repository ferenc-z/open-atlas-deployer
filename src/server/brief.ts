// The daily brief (§10.4, D25, phase 8): once a day the Deployer gathers what changed — new versions, what UAT ran
// that PROD does not run yet, drift, failed deploys — and, when OMA is configured, asks the Deploy Assistant
// (interface B) to write it up. It is shown only on the Deployer's home page, never pushed. Without OMA the page shows
// the gathered facts as they are.

import { compareVersions } from "../manifest/version.ts";
import type { Deployments } from "./deploy.ts";
import type { DriftItem } from "./drift.ts";
import type { EnvironmentStatus } from "./observe.ts";
import { sessionOutcome, type OmaSessions } from "./oma.ts";
import type { PeerStatus } from "./peer.ts";
import type { Store } from "./store.ts";
import type { Versions } from "./versions.ts";

/** The brief's facts, from what the status page, the versions list, UAT and the drift check already know. */
export async function collectFacts(d: { store: Store; deployments: Deployments; status: () => Promise<EnvironmentStatus>; versions: Pick<Versions, "list">; peer?: () => Promise<PeerStatus>; drift: () => Promise<DriftItem[]>; now?: () => number }): Promise<BriefFacts> {
  const now = d.now?.() ?? Date.now();
  const status = await d.status();
  const { deployed } = d.deployments.environment();
  const apps: BriefFacts["apps"] = [];
  for (const a of status.apps) {
    const release = d.store.manifests(a.app).at(-1)?.release;
    const listed: { versions: string[]; error?: string } = release ? await d.versions.list(release.repo, release.tag) : { versions: [] };
    const desired = deployed[a.app] ?? a.desired ?? null;
    apps.push({ app: a.app, desired, verdict: a.verdict, newer: listed.versions.filter((v) => !desired || compareVersions(v, desired) > 0).slice(0, 3), ...(listed.error ? { versionsError: listed.error } : {}) });
  }
  let promotable: BriefFacts["promotable"] = [];
  if (d.peer) {
    try {
      const uat = await d.peer();
      promotable = Object.entries(uat.apps).filter(([app, u]) => u.version !== (deployed[app] ?? null)).map(([app, u]) => ({ app, uat: u.version, here: deployed[app] ?? null }));
    } catch { promotable = []; }
  }
  const since = new Date(now - 24 * 3_600_000).toISOString();
  const jobs = d.store.listJobs({ kind: "deploy", limit: 100 });
  return {
    environment: status.environment, apps, promotable,
    drift: (await d.drift()).map((x) => ({ app: x.app, kind: x.kind, detail: x.detail, since: x.firstSeen })),
    failed: jobs.filter((j) => (j.state === "failed" || j.state === "rolled-back") && (j.finishedAt ?? "") >= since).map((j) => ({ job: j.id, app: j.app, version: j.version, state: j.state, message: j.message, diagnosis: j.diagnosis?.cause ?? null })),
    waiting: jobs.filter((j) => j.state === "running").flatMap((j) => (j.rollout?.steps ?? []).filter((s) => s.state === "waiting").map((s) => ({ job: j.id, app: j.app, version: j.version, step: s.component }))),
  };
}

export interface BriefFacts {
  environment: string;
  /** versionsError: the release tags could not be read, so newer is not known (not "none"). */
  apps: { app: string; desired: string | null; verdict: string; newer: string[]; versionsError?: string }[];
  /** PROD: versions UAT runs that this environment does not. */
  promotable: { app: string; uat: string; here: string | null }[];
  drift: { app: string; kind: string; detail: string; since: string }[];
  failed: { job: string; app: string; version: string; state: string; message: string | null; diagnosis: string | null }[];
  waiting: { job: string; app: string; version: string; step: string }[];
}

export interface Brief {
  date: string;
  generatedAt: string;
  by: string;
  facts: BriefFacts;
  state: "writing" | "done" | "facts-only" | "failed";
  session?: string;
  text?: string;
  message?: string;
}

export function briefPrompt(facts: BriefFacts): string {
  return [
    `Write today's deploy brief for the ${facts.environment.toUpperCase()} environment, for the team to read on the Deployer home page. Use only the facts below and invent nothing; check with the read-only tools if needed.`,
    "Format: a one-sentence summary, then sections as needed: upgrades available, versions UAT has run that are waiting for PROD, environment drift (someone changed the server by hand), deploys that failed or are waiting for a person. At most 5 lines per section, naming the app, version and evidence. Leave out empty sections. End with one line: the single thing to do first.",
    "```json",
    JSON.stringify(facts, null, 1),
    "```",
  ].join("\n");
}

export class Briefs {
  private store: Store;
  private gather: () => Promise<BriefFacts>;
  private oma: OmaSessions | undefined;
  private now: () => number;
  private hour: number;
  private busy = false;

  constructor(store: Store, gather: () => Promise<BriefFacts>, oma: OmaSessions | undefined, options: { now?: () => number; hour?: number } = {}) {
    this.store = store;
    this.gather = gather;
    this.oma = oma;
    this.now = options.now ?? Date.now;
    this.hour = options.hour ?? 8;
  }

  private today(): string {
    const d = new Date(this.now());
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  latest(): Brief | undefined { return this.store.latestBrief<Brief>(); }

  async generate(by: string): Promise<Brief> {
    const facts = await this.gather();
    let brief: Brief = { date: this.today(), generatedAt: new Date(this.now()).toISOString(), by, facts, state: this.oma ? "writing" : "facts-only" };
    if (this.oma) {
      try { brief.session = await this.oma.open(`Deployer daily brief · ${facts.environment} · ${brief.date}`, `brief-${brief.date}`, briefPrompt(facts)); }
      catch (error) { brief = { ...brief, state: "facts-only", message: `Could not ask the AI to write the brief: ${(error as Error).message}` }; }
    }
    this.store.saveBrief(brief.date, brief);
    if (by !== "deployer") this.store.audit({ id: by, via: "workbench" }, "brief.generate", brief.date, null);
    return brief;
  }

  /** Once a day after the configured hour; then follows the session until the Agent has written it. */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const last = this.latest();
      if ((!last || last.date !== this.today()) && new Date(this.now()).getHours() >= this.hour) await this.generate("deployer");
      const current = this.latest();
      if (current?.state === "writing" && current.session && this.oma) {
        const outcome = sessionOutcome(await this.oma.events(current.session));
        if (outcome.error) this.store.saveBrief(current.date, { ...current, state: "failed", message: `OMA session error: ${outcome.error}` });
        else if (outcome.ended && outcome.text) this.store.saveBrief(current.date, { ...current, state: "done", text: outcome.text.slice(0, 8000) });
        else if (this.now() - Date.parse(current.generatedAt) > 15 * 60_000) this.store.saveBrief(current.date, { ...current, state: "facts-only", message: "The AI had not finished after 15 minutes; showing the facts" });
      }
    } finally { this.busy = false; }
  }
}
