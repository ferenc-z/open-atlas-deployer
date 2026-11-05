// Service ops §6 steps 3 and 5: taking over what discovery found. A draft is made from each host's newest discovery
// (assess.ts groups and assesses by rules, P1); an administrator edits it and confirms it, which reads every
// installation's configuration files on its host (svc-read on the service executor's read channel), imports them as
// revision 1 and registers the items, in one transaction. The AI review is optional: without OMA, taking over works
// the same.

import { randomBytes } from "node:crypto";
import type { Handoff } from "../handoff.ts";
import { newJobId } from "../handoff.ts";
import { sessionOutcome, type OmaSessions } from "../oma.ts";
import type { SecretBox } from "../secretbox.ts";
import { StoreError, type Actor, type Store } from "../store.ts";
import { assessItems, groupDiscoveries, reviewPrompt, type Discovered, type RegisteredMember, type Skipped } from "./assess.ts";
import { importFile, type ConfigMember, type ReadFile, type ServiceConfigBody } from "./config.ts";
import type { DraftItem, ServiceDraft, ServiceMember } from "./draft.ts";

export class TakeoverError extends Error {
  readonly status: 400 | 404 | 409 | 503;
  readonly code: string;
  readonly details: string[];
  constructor(status: 400 | 404 | 409 | 503, code: string, message: string, details: string[] = []) { super(message); this.status = status; this.code = code; this.details = details; }
}

export interface TakeoverOptions {
  store: Store;
  handoff: Handoff;
  /** Seals the imported files; without it nothing can be confirmed. */
  box?: SecretBox;
  /** The Onboarding Assessor's sessions, for the optional AI review. */
  oma?: OmaSessions;
  environment: () => string;
  hosts: () => string[];
  /** How long a confirmation waits for the files to be read (default 60 s), and how often it looks. */
  readTimeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** The settings key of the HMAC key discovery fingerprints secrets with (so nodes can be compared, P1). */
export const FINGERPRINT_KEY = "service.fingerprint-key";
const SYSTEM: Actor = { id: "deployer", via: "cli" };
const install = (m: Pick<ServiceMember, "host" | "installDir">) => `${m.host}:${m.installDir.replace(/\/+$/, "")}`;

export class Takeover {
  private o: TakeoverOptions;
  private sleep: (ms: number) => Promise<void>;
  /** Drafts being confirmed now: a second confirmation of one waits for nothing, it is refused. */
  private confirming = new Set<string>();

  constructor(o: TakeoverOptions) {
    this.o = o;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** The key the service executors fingerprint secret values with; made on first use, never shown. */
  fingerprintKey(): string {
    const kept = this.o.store.setting(FINGERPRINT_KEY);
    if (kept) return kept;
    const key = randomBytes(24).toString("base64url");
    this.o.store.setSetting(FINGERPRINT_KEY, key, SYSTEM);
    return key;
  }

  /** The instances of each host's newest succeeded discovery; the hosts without one are named. */
  discoveries(hosts?: string[]): { found: Discovered[]; sources: { job: string; host: string }[]; missing: string[] } {
    const found: Discovered[] = [], sources: { job: string; host: string }[] = [], missing: string[] = [];
    for (const host of hosts ?? this.o.hosts()) {
      const id = this.o.store.latestExecutorJob(host, "service", "svc-discover");
      const job = id ? this.o.store.executorJob(id) : undefined;
      const result = job?.status?.state === "succeeded" ? (job.status.result as unknown as { instances?: Record<string, any>[] }) : undefined;
      if (!id || !result) { missing.push(host); continue; }
      sources.push({ job: id, host });
      for (const instance of result.instances ?? []) found.push({ job: id, host, instance });
    }
    return { found, sources, missing };
  }

  /** The discoveries behind a draft's members (by the job each member names). */
  private foundFor(items: DraftItem[]): Discovered[] {
    const out: Discovered[] = [];
    const jobs = new Map<string, Record<string, any>[]>();
    for (const item of items) {
      for (const m of item.kind === "cluster" ? item.nodes : [item.member]) {
        const ref = m.discovery;
        if (!ref) continue;
        if (!jobs.has(ref.job)) {
          const job = this.o.store.executorJob(ref.job);
          jobs.set(ref.job, job?.status?.state === "succeeded" ? ((job.status.result as unknown as { instances?: Record<string, any>[] }).instances ?? []) : []);
        }
        const instance = jobs.get(ref.job)!.find((i) => String(i.installDir).replace(/\/+$/, "") === ref.installDir.replace(/\/+$/, ""));
        if (instance) out.push({ job: ref.job, host: ref.host, instance });
      }
    }
    return out;
  }

  private registered(): RegisteredMember[] {
    const s = this.o.store;
    return [
      ...s.standalones().map((x) => ({ service: x.service, profile: x.profile, member: x.member })),
      ...s.clusters().flatMap((c) => c.nodes.map((n) => ({ service: c.service, profile: c.profile, member: n }))),
    ];
  }

  private registeredIds(): string[] {
    return [...this.o.store.standalones().map((x) => x.id), ...this.o.store.clusters().map((x) => x.id)];
  }

  /** A new draft from the newest discoveries of the given hosts (all of the environment's by default). */
  createDraft(actor: Actor, hosts?: string[]): { draft: ServiceDraft; skipped: Skipped[]; missing: string[] } {
    const known = this.o.hosts();
    const unknown = (hosts ?? []).filter((h) => !known.includes(h));
    if (unknown.length) throw new TakeoverError(404, "host/unknown", `Not hosts of this environment: ${unknown.join(", ")}.`);
    const { found, sources, missing } = this.discoveries(hosts);
    if (!sources.length) throw new TakeoverError(409, "draft/no-discovery", "No host has a finished discovery yet: discover first.", missing);
    const { items, skipped } = groupDiscoveries(found, { registered: (h, d) => this.o.store.serviceUsing(h, d), takenIds: this.registeredIds() });
    if (!items.length) throw new TakeoverError(409, "draft/nothing-new", "Discovery found nothing that is not registered already.", skipped.map((s) => `${s.host}:${s.installDir}: ${s.reason}`));
    const draft = this.o.store.createServiceDraft(this.o.environment(), sources, assessItems(items, found, this.registered()), actor);
    return { draft, skipped, missing };
  }

  /** The rules again over the draft as it is now (after an edit, or a new discovery of the same installations). */
  reassess(draftId: string, actor: Actor): ServiceDraft {
    const draft = this.draft(draftId);
    const items = draft.items.map(({ updatedAt: _a, updatedBy: _b, ...i }) => i as DraftItem);
    this.o.store.reassessServiceDraft(draftId, assessItems(items, this.foundFor(items), this.registered()), actor);
    return this.o.store.serviceDraft(draftId)!;
  }

  /** An edited item, with the draft assessed again. */
  putItem(draftId: string, item: DraftItem, actor: Actor): { result: "added" | "changed"; draft: ServiceDraft } {
    const result = this.o.store.putServiceDraftItem(draftId, item, actor);
    return { result, draft: this.reassess(draftId, actor) };
  }

  removeItem(draftId: string, itemId: string, actor: Actor): ServiceDraft {
    this.o.store.removeServiceDraftItem(draftId, itemId, actor);
    return this.reassess(draftId, actor);
  }

  draft(id: string): ServiceDraft {
    const d = this.o.store.serviceDraft(id);
    if (!d) throw new TakeoverError(404, "draft/unknown", `No takeover draft ${id}.`);
    return d;
  }

  /**
   * Confirms a draft (§6 step 5): every installation's configuration files are read on its host (svc-read), checked
   * against what discovery fingerprinted (the assessment was made on those), sealed, and imported as revision 1 while
   * the items are registered, in one transaction. Nothing on the hosts changes.
   */
  async confirm(draftId: string, actor: Actor): Promise<{ draft: ServiceDraft; registered: string[]; reads: string[] }> {
    if (!this.o.box) throw new TakeoverError(503, "confirm/no-key", "DEPLOYER_CREDENTIAL_ENCRYPTION_KEY is not set: the imported files hold secrets and cannot be kept unsealed.");
    const draft = this.draft(draftId);
    if (draft.state !== "open") throw new TakeoverError(409, "draft/closed", `Takeover draft ${draftId} is ${draft.state}.`);
    if (!draft.items.length) throw new TakeoverError(409, "draft/empty", `Takeover draft ${draftId} has no items.`);
    if (this.confirming.has(draftId)) throw new TakeoverError(409, "confirm/running", `Takeover draft ${draftId} is being confirmed already.`);
    const members = draft.items.flatMap((item) => (item.kind === "cluster" ? item.nodes : [item.member]).map((m) => ({ item: item.id, m })));
    const used = members.map(({ m }) => [m, this.o.store.serviceUsing(m.host, m.installDir)] as const).filter(([, s]) => s);
    if (used.length) throw new TakeoverError(409, "service/install-used", "An installation is already registered.", used.map(([m, s]) => `${install(m)} is in ${s}`));
    const offline = [...new Set(members.map(({ m }) => m.host))].map((h) => this.o.handoff.executor(h, "service")).filter((e) => !e.online || !e.heartbeat?.kinds?.includes("svc-read"));
    if (offline.length) throw new TakeoverError(409, "confirm/executor", "The service executor of a host is offline or cannot read files (upgrade it).", offline.map((e) => `${e.host}: ${e.online ? `version ${e.heartbeat?.version} has no svc-read` : e.reason}`));

    this.confirming.add(draftId);
    try {
      const reads = members.map(({ item, m }) => {
        const id = newJobId("svc-read");
        this.o.handoff.submit(id, { kind: "svc-read", installDir: m.installDir, timeoutSeconds: 30, requestedBy: actor.id, draft: draftId }, m.host, "service");
        return { id, item, m };
      });
      this.o.store.audit(actor, "service.draft-reading", draftId, { reads: reads.map((r) => ({ job: r.id, installation: install(r.m) })) });
      const end = Date.now() + (this.o.readTimeoutMs ?? 60_000);
      while (reads.some((r) => !isFinal(this.o.handoff.status(r.id)?.state)) && Date.now() < end) await this.sleep(this.o.pollMs ?? 250);

      const problems: string[] = [];
      const byItem = new Map<string, ConfigMember[]>();
      const found = new Map(this.foundFor(draft.items).map((d) => [`${d.host}:${String(d.instance.installDir).replace(/\/+$/, "")}`, d]));
      for (const r of reads) {
        const status = this.o.handoff.status(r.id);
        const content = this.o.handoff.envContent(r.id);
        if (status?.state !== "succeeded") { problems.push(`${install(r.m)}: ${status ? `${status.state}${status.message ? `: ${status.message}` : ""}` : "not read in time (is the service executor running?)"}`); continue; }
        if (!content) { problems.push(`${install(r.m)}: the files did not arrive`); continue; }
        let sent: { files: ReadFile[] };
        try { sent = JSON.parse(content); } catch { problems.push(`${install(r.m)}: unreadable answer`); continue; }
        // The assessment was made on what discovery saw: a file changed since then needs a new discovery and draft.
        const seen = new Map(((found.get(install(r.m))?.instance.files ?? []) as { name: string; sha256: string }[]).map((f) => [f.name, f.sha256]));
        const changed = sent.files.filter((f) => seen.has(f.name) && seen.get(f.name) !== f.sha256).map((f) => f.name);
        if (changed.length) { problems.push(`${install(r.m)}: changed since discovery: ${changed.join(", ")}; discover again and make a new draft`); continue; }
        try {
          const files = sent.files.map((f) => importFile(f, this.o.box!));
          const missing = ((status.result as unknown as { missing?: string[] }).missing ?? []);
          byItem.set(r.item, [...(byItem.get(r.item) ?? []), { host: r.m.host, installDir: r.m.installDir, files, missing }]);
        } catch (error) { problems.push(`${install(r.m)}: ${(error as Error).message}`); }
      }
      if (problems.length) throw new TakeoverError(409, "confirm/read", "The configuration could not be imported from every installation; nothing was registered.", problems);
      const configs: Record<string, ServiceConfigBody> = Object.fromEntries([...byItem].map(([item, ms]) => [item, { members: ms }]));
      try {
        const registered = this.o.store.confirmServiceDraft(draftId, configs, actor, draft.updatedAt);
        return { draft: this.o.store.serviceDraft(draftId)!, registered, reads: reads.map((r) => r.id) };
      } catch (error) {
        if (error instanceof StoreError) throw new TakeoverError(409, error.code, error.message, error.details);
        throw error;
      }
    } finally {
      this.confirming.delete(draftId);
    }
  }

  /** Asks the Onboarding Assessor to explain the findings (P1, optional): 503 without OMA, and taking over goes on. */
  async review(draftId: string, actor: Actor): Promise<ServiceDraft> {
    if (!this.o.oma) throw new TakeoverError(503, "review/unavailable", "The AI review needs OMA (DEPLOYER_OMA_ASSESSOR_AGENT and the OMA connection); the rules' findings and confirming work without it.");
    const draft = this.draft(draftId);
    if (draft.state !== "open") throw new TakeoverError(409, "draft/closed", `Takeover draft ${draftId} is ${draft.state}.`);
    if (draft.review?.state === "running") return draft;
    const requestedAt = new Date().toISOString();
    try {
      const session = await this.o.oma.open(`Deployer takeover assessment · ${draftId}`, draftId, reviewPrompt(draftId, draft.environment, draft.items));
      this.o.store.setServiceDraftReview(draftId, { state: "running", session, requestedAt, requestedBy: actor.id });
    } catch (error) {
      this.o.store.setServiceDraftReview(draftId, { state: "failed", session: null, requestedAt, requestedBy: actor.id, finishedAt: new Date().toISOString(), error: (error as Error).message });
    }
    this.o.store.audit(actor, "service.draft-review", draftId, null);
    return this.o.store.serviceDraft(draftId)!;
  }

  /** A draft with its AI review brought up to date (one look at the session while it runs). */
  async withReview(draftId: string): Promise<ServiceDraft> {
    const draft = this.draft(draftId);
    const r = draft.review;
    if (!this.o.oma || r?.state !== "running" || !r.session) return draft;
    try {
      const outcome = sessionOutcome(await this.o.oma.events(r.session));
      if (outcome.error) this.o.store.setServiceDraftReview(draftId, { ...r, state: "failed", finishedAt: new Date().toISOString(), error: outcome.error });
      else if (outcome.ended && outcome.text) this.o.store.setServiceDraftReview(draftId, { ...r, state: "done", finishedAt: new Date().toISOString(), text: outcome.text });
    } catch { /* OMA unreachable for now: the review stays running, the draft is still usable. */ }
    return this.o.store.serviceDraft(draftId)!;
  }
}

const isFinal = (state: string | undefined) => state === "succeeded" || state === "failed" || state === "refused" || state === "rolled-back";
