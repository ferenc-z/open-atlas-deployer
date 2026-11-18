// S37 step 5 (§4.2.0 layer 3, T3/T7): the generic trace engine. Find the start at an entry by a business clue (T7),
// follow the correlation key step by step through the segment, across hand-overs by the channel type's rule (S2S:
// the receiver pairs the sender's event, falling back to "same file name in a time window" marked inferred; MQ: the
// key travels in an attribute), switch to another evidence source when one has nothing or cannot answer, and align
// what was seen with the expected path: completed / failed / stuck / handover-lost / insufficient evidence (plus
// in-progress while a step is still within its time). Nothing here depends on a NiFi version.

import { channelKey, channelLabel, targetsOf } from "./channels.ts";
import { canByKey, type AdapterAnswer, type ChannelType, type CorrelationKey, type EvidenceAdapter, type ObservedEvent, type Position } from "./events.ts";
import { DEFAULT_MAX_SECONDS, matches, type Business, type Cue, type Endpoint, type Step, type TraceModel } from "./model.ts";

export type VerdictKind = "completed" | "failed" | "stuck" | "handover-lost" | "insufficient" | "in-progress";
export const VERDICTS: readonly VerdictKind[] = ["completed", "failed", "stuck", "handover-lost", "insufficient", "in-progress"];

/** The structured trace conditions (§4.2): a service, optionally a business, clues, a time range (required). */
export interface TraceQuery { service: string; business?: string; fileName?: string; emailFrom?: string; emailSubject?: string; from: string; to: string }

export interface Missing { source: string; reason: "unavailable" | "expired" | "error" | "incapable"; message: string; earliest?: string }
export type StepState = "done" | "failed" | "started" | "none" | "not-reached";
export interface StepResult { step: string; name: string; position: Position; state: StepState; at?: string; source?: string; events: ObservedEvent[]; missing?: Missing[] }
export interface HandoverResult {
  exit: string; channel: ChannelType; to: { service: string; business: string; entry: string } | { system: string } | null;
  state: "confirmed" | "inferred" | "lost" | "insufficient" | "outside"; source?: string; key?: CorrelationKey; missing?: Missing[]; note?: string;
}
export interface Segment { service: string; business: string; businessName: string; key: CorrelationKey; steps: StepResult[]; handover?: HandoverResult }
export interface Verdict {
  kind: VerdictKind; inferred: boolean; service: string; business: string; step?: string; at?: string; message: string;
  /** stuck / in-progress: the time the step was allowed and where it came from ("model", an adapter id, "default"; T10). */
  allowed?: { seconds: number; by: string };
  /** stuck (T11): the connection the data waits in and its downstream component, from the newest collected sample. */
  context?: StuckContext;
  /** What the page offers next (T12: complete another service's model; T13: open the component in NiFi). */
  actions?: VerdictAction[];
}
export type VerdictAction = { kind: "edit-model"; service: string; channel: string } | { kind: "open-nifi"; service: string; component: string; url?: string };

/** T11: where stuck data waits — the queue of the connection into the step and whether its component runs. Every part
 *  is from the collector's newest back pressure reading (the fullest queues only), so a part it does not have is
 *  null with a note, never guessed. */
export interface StuckContext {
  at: string | null;
  queue: { name?: string | null; flowFilesQueued?: number; bytesQueued?: number; percent: number; backpressure: boolean } | null;
  downstream: { id: string; name?: string | null; running: boolean | null; runStatus?: string } | null;
  notes: string[];
}
export interface StuckAsk { service: string; /** the step the data was last seen at (none: it never started) */ from?: Position; /** the step it waits for */ to: Position }
export interface TraceResult { start: { key: CorrelationKey; at: string; entry: string; cue: Cue }; segments: Segment[]; verdict: Verdict }
export interface TraceAnswer { query: TraceQuery; traces: TraceResult[]; truncated: boolean; notFound?: { insufficient: boolean; message: string; missing: Missing[] }; notes: string[] }

export interface EngineDeps {
  /** Every service's model (segments are joined across all of them). */
  models: () => TraceModel[];
  adapters: Map<string, EvidenceAdapter>;
  now?: () => Date;
  /** T11: the queue and downstream state of a stuck step (flowstate.ts reads the collected samples). */
  stuckContext?: (q: StuckAsk) => StuckContext | undefined | Promise<StuckContext | undefined>;
}

/** T9: the sources of a model that names none — every adapter that can answer for the service, those asked by named
 *  business keys first (e2e_trace), then those that take any indexed key (provenance) to fill the gaps; registration
 *  order within each. */
export function autoSources(adapters: Map<string, EvidenceAdapter>, service: string): string[] {
  const usable = [...adapters.values()].map((a) => ({ a, c: a.capabilities(service) }))
    .filter(({ c }) => c.byKey === "*" || c.byKey.length > 0 || c.byPosition || c.handover.length > 0);
  return [...usable.filter((x) => x.c.byKey !== "*"), ...usable.filter((x) => x.c.byKey === "*")].map((x) => x.a.id);
}

export const TRACE_MAX = 20;
const SEGMENTS_MAX = 8;
const KEYS_MAX = 10;
const EVENTS_KEPT = 5;
/** T3: the S2S receiver is looked for this long around the sender's SEND. */
export const S2S_WINDOW_MS = 2 * 60_000;
const DONE = new Set(["end", "success", "sent", "received", "dropped"]);

type Asked = { events: ObservedEvent[]; source?: string; missing: Missing[] };
const iso = (ms: number) => new Date(ms).toISOString();
const t = (s: string) => new Date(s).getTime();

export class TraceEngine {
  private deps: EngineDeps;
  private now: () => Date;
  constructor(deps: EngineDeps) { this.deps = deps; this.now = deps.now ?? (() => new Date()); }

  private sources(service: string): EvidenceAdapter[] {
    const m = this.deps.models().find((x) => x.service === service);
    const ids = m?.sources?.length ? m.sources : autoSources(this.deps.adapters, service);
    return ids.map((id) => this.deps.adapters.get(id)).filter((a): a is EvidenceAdapter => Boolean(a));
  }

  /** T10: the step's own maxSeconds, else the first source's allowance (e2e_trace: its P95), else the default. */
  private async allowed(service: string, b: Business, step: Step): Promise<{ seconds: number; by: string }> {
    if (step.maxSeconds) return { seconds: step.maxSeconds, by: "model" };
    for (const a of this.sources(service)) {
      if (!a.allowance) continue;
      try {
        const s = await a.allowance({ service, business: b.id, step: step.id, position: step.position });
        if (typeof s === "number" && Number.isFinite(s) && s > 0) return { seconds: Math.ceil(s), by: a.id };
      } catch { /* a source without an answer has no opinion */ }
    }
    return { seconds: DEFAULT_MAX_SECONDS, by: "default" };
  }

  /** T11: the stuck step's queue and downstream state, when the deps can read them; never fails the trace. */
  private async stuck(q: StuckAsk): Promise<StuckContext | undefined> {
    if (!this.deps.stuckContext) return undefined;
    try { return await this.deps.stuckContext(q); } catch { return undefined; }
  }

  /** Asks the service's sources in order until one has events; the others' gaps are kept as missing. */
  private async ask(service: string, can: (a: EvidenceAdapter) => boolean, call: (a: EvidenceAdapter) => Promise<AdapterAnswer> | undefined, what: string): Promise<Asked> {
    const missing: Missing[] = [];
    // S37 step 9: a source that cannot be asked this (e.g. a key its NiFi does not index) is skipped quietly; only when
    // every source was such is it said.
    const incapable: Missing[] = [];
    let asked = 0;
    const usable = this.sources(service).filter(can);
    if (!usable.length) return { events: [], missing: [{ source: "-", reason: "incapable", message: `No evidence source of ${service} can ${what}.` }] };
    for (const a of usable) {
      let answer: AdapterAnswer | undefined;
      try { answer = await call(a); } catch (error) { asked++; missing.push({ source: a.id, reason: "error", message: (error as Error).message }); continue; }
      if (!answer) continue;
      if (answer.events.length) return { events: answer.events, source: a.id, missing };
      if (answer.missing?.reason === "incapable") { incapable.push({ source: a.id, ...answer.missing }); continue; }
      asked++;
      if (answer.missing) missing.push({ source: a.id, ...answer.missing });
    }
    return { events: [], missing: asked ? missing : incapable };
  }

  private byKey(service: string, key: CorrelationKey, from: string, to: string, position?: Position) {
    return this.ask(service, (a) => Boolean(a.byKey) && canByKey(a.capabilities(service), key.name),
      (a) => a.byKey!({ service, key, from, to, ...(position ? { position } : {}) }), `be asked by ${key.name}`);
  }

  async trace(q: TraceQuery): Promise<TraceAnswer> {
    const models = this.deps.models();
    const model = models.find((m) => m.service === q.service);
    const notes: string[] = [];
    if (!model || !model.businesses.length) return { query: q, traces: [], truncated: false, notFound: { insufficient: true, message: `${q.service} has no business model yet: define its businesses first.`, missing: [] }, notes };
    for (const id of model.sources ?? []) if (!this.deps.adapters.has(id)) notes.push(`Evidence source ${id} is not available in this Deployer.`);
    const businesses = model.businesses.filter((b) => !q.business || b.id === q.business);
    if (q.business && !businesses.length) return { query: q, traces: [], truncated: false, notFound: { insufficient: true, message: `${q.service} has no business ${q.business}.`, missing: [] }, notes };
    const cues = (["fileName", "emailFrom", "emailSubject"] as Cue[]).filter((c) => q[c]);
    const starts: { business: Business; entry: Endpoint; cue: Cue; event: ObservedEvent }[] = [];
    const missing: Missing[] = [];
    let mapped = 0;
    const outside = new Set<string>();
    for (const b of businesses) for (const entry of b.entries) for (const m of entry.cues ?? []) {
      if (!cues.includes(m.cue)) continue;
      mapped++;
      if (entry.channel.type === "external" && entry.channel.system) outside.add(entry.channel.system);
      const step = b.steps.find((s) => s.id === entry.step)!;
      const got = await this.byKey(q.service, { name: m.key, value: q[m.cue]! }, q.from, q.to, step.position);
      missing.push(...got.missing);
      for (const e of got.events) {
        if (!matches(b.match, e.attrs)) continue;
        if (!starts.some((s) => s.business.id === b.id && s.event.key.name === e.key.name && s.event.key.value === e.key.value)) starts.push({ business: b, entry, cue: m.cue, event: e });
      }
    }
    if (!mapped) return { query: q, traces: [], truncated: false, notFound: { insufficient: true, message: `No entry of ${q.service}'s model maps the clues given (${cues.join(", ") || "none"}): add a cue mapping to an entry.`, missing: [] }, notes };
    if (!starts.length) {
      const insufficient = missing.length > 0;
      // T13: an external entry is the edge of what NiFi saw; say what did not arrive there and where to look.
      const clue = cues.map((c) => `${c} ${q[c]}`).join(", ");
      const edge = outside.size ? ` ${q.service} received no email or file matching ${clue} between ${q.from} and ${q.to} at ${[...outside].join(", ")}: check that it was sent to the location NiFi watches.` : "";
      return { query: q, traces: [], truncated: false, notFound: { insufficient, message: insufficient ? "Nothing found at the entries, and some evidence could not be read: the result is not conclusive." : `Nothing found at the entries in this time range.${edge}`, missing }, notes };
    }
    starts.sort((a, b) => t(a.event.at) - t(b.event.at));
    const traces: TraceResult[] = [];
    for (const s of starts.slice(0, TRACE_MAX)) {
      const segments: Segment[] = [];
      const verdict = await this.walk(models, q.service, s.business, s.entry.step, s.event.key, s.event.at, segments, false);
      traces.push({ start: { key: s.event.key, at: s.event.at, entry: s.entry.id, cue: s.cue }, segments, verdict });
    }
    return { query: q, traces, truncated: starts.length > TRACE_MAX, notes };
  }

  /** Follows one segment from a step on, then its exit's hand-over into the next segment. */
  private async walk(models: TraceModel[], service: string, b: Business, fromStep: string, key: CorrelationKey, since: string, segments: Segment[], inferred: boolean): Promise<Verdict> {
    const seg: Segment = { service, business: b.id, businessName: b.name, key, steps: [] };
    segments.push(seg);
    const now = this.now().getTime();
    const end = (kind: VerdictKind, message: string, step?: StepResult, extra: Partial<Verdict> = {}): Verdict => ({ kind, inferred, service, business: b.id, ...(step ? { step: step.step } : {}), ...(step?.at ? { at: step.at } : {}), message, ...extra });
    // T11: a stuck verdict says where the data waits (queue, back pressure, whether the component downstream runs).
    const stuckEnd = async (message: string, r: StepResult, allowed: { seconds: number; by: string }, ask: StuckAsk) => {
      const context = await this.stuck(ask);
      return end("stuck", `${message}${context ? ` ${describeStuck(context)}` : ""}`, r, { allowed, ...(context ? { context } : {}) });
    };
    const from = iso(t(since) - 60_000), to = iso(now);
    let keys: CorrelationKey[] = [key];
    const startIdx = b.steps.findIndex((s) => s.id === fromStep);
    b.steps.slice(0, startIdx).forEach((s) => seg.steps.push({ step: s.id, name: s.name, position: s.position, state: "not-reached", events: [] }));
    let last: StepResult | undefined, lastStep: Step | undefined;
    for (const step of b.steps.slice(startIdx)) {
      const events: ObservedEvent[] = [];
      const miss: Missing[] = [];
      let source: string | undefined;
      for (const k of keys) {
        const got = await this.byKey(service, k, from, to, step.position);
        miss.push(...got.missing);
        source ??= got.source;
        for (const e of got.events) if (!events.some((x) => x.key.value === e.key.value && x.at === e.at && x.state === e.state && x.source === e.source)) events.push(e);
      }
      events.sort((x, y) => t(x.at) - t(y.at));
      for (const e of events) for (const c of e.children ?? []) if (keys.length < KEYS_MAX && !keys.some((k) => k.name === c.name && k.value === c.value)) keys.push(c);
      const failed = events.find((e) => e.state === "failure");
      const done = events.filter((e) => DONE.has(e.state));
      const state: StepState = failed ? "failed" : done.length ? "done" : events.length ? "started" : "none";
      const at = (failed ?? done[done.length - 1] ?? events[events.length - 1])?.at;
      const r: StepResult = { step: step.id, name: step.name, position: step.position, state, ...(at ? { at } : {}), ...(source ? { source } : {}), events: events.slice(-EVENTS_KEPT), ...(miss.length && !events.length ? { missing: miss } : {}) };
      seg.steps.push(r);
      if (state === "failed") { this.rest(seg, b, step); return end("failed", `Failed at ${step.name}${failed!.attrs.error ? `: ${failed!.attrs.error}` : ""}.`, r); }
      if (state === "started") {
        this.rest(seg, b, step);
        const allowed = await this.allowed(service, b, step);
        if (now - t(at!) > allowed.seconds * 1000) return stuckEnd(`Started ${step.name} but did not finish within ${allowed.seconds} s.`, r, allowed, { service, to: step.position });
        return end("in-progress", `In ${step.name}, still within its expected time.`, r, { allowed });
      }
      if (state === "none") {
        this.rest(seg, b, step);
        // Some source could not answer for this step (expired, unavailable, incapable): absence proves nothing.
        if (miss.length)
          return end("insufficient", `No evidence at ${step.name}: ${miss.map((m) => `${m.source}: ${m.message}`).join("; ")}`, r);
        const allowed = lastStep ? await this.allowed(service, b, lastStep) : { seconds: DEFAULT_MAX_SECONDS, by: "default" };
        const over = last?.at ? now - t(last.at) > allowed.seconds * 1000 : true;
        if (over) return stuckEnd(`Last seen at ${lastStep?.name ?? "the start"}; it never reached ${step.name}.`, last ?? r, allowed, { service, ...(lastStep ? { from: lastStep.position } : {}), to: step.position });
        return end("in-progress", `On its way to ${step.name}, still within the expected time.`, last ?? r, { allowed });
      }
      last = r; lastStep = step;
      keys = keys.slice(0, KEYS_MAX);
    }
    // Every step done: leave through an exit (or end here).
    const attrsAt = (stepId: string) => Object.assign({}, ...seg.steps.filter((s) => s.step === stepId).flatMap((s) => s.events.map((e) => e.attrs))) as Record<string, string>;
    const exits = b.exits.filter((x) => matches(x.when, attrsAt(x.step)));
    if (!exits.length) return end("completed", `Completed ${b.name}${b.exits.length ? " (no exit condition matched: it ends here)" : ""}.`, last);
    if (segments.length >= SEGMENTS_MAX) return end("insufficient", `Followed ${SEGMENTS_MAX} segments; stopped (a loop between models?).`, last);
    let lost: HandoverResult | undefined;
    let danglingTo: VerdictAction | undefined;
    for (const exit of exits) {
      const stepR = seg.steps.find((s) => s.step === exit.step)!;
      const sent = [...stepR.events].reverse().find((e) => e.state === "sent") ?? stepR.events[stepR.events.length - 1]!;
      if (exit.channel.type === "external") {
        seg.handover = { exit: exit.id, channel: "external", to: { system: exit.channel.system! }, state: "outside" };
        // T13: NiFi's part ends here; say when and by what it left, and send the reader downstream.
        const by = stepR.position.name ?? stepR.name;
        const open: VerdictAction = { kind: "open-nifi", service, component: stepR.position.id, ...(sent.ref?.url ? { url: sent.ref.url } : {}) };
        return end("completed", `Completed ${b.name}: pushed to ${exit.channel.system} at ${sent.at} by ${by} (${sent.state}). The NiFi part is fine; check in ${exit.channel.system} that it arrived.`, stepR, { actions: [open] });
      }
      const targets = targetsOf(models, { service, business: b.id, endpoint: exit.id });
      if (!targets.length) {
        // T12: dangling — the model is incomplete; name the channel and whose model lacks the entry.
        const channel = channelKey(service, exit, "exit")!;
        const owner = exit.channel.type === "s2s" ? exit.channel.service! : undefined;
        const note = owner
          ? `${service} sends through exit ${exit.id} to ${channelLabel(channel)}, but ${owner}'s model has no entry on input port ${exit.channel.port}: add it to ${owner}'s model.`
          : `${service} sends through exit ${exit.id} to ${channelLabel(channel)}, but no service's model has an entry on that channel: add it to the receiving service's model.`;
        lost ??= { exit: exit.id, channel: exit.channel.type, to: null, state: "insufficient", note };
        if (owner) danglingTo ??= { kind: "edit-model", service: owner, channel };
        continue;
      }
      for (const link of targets) {
        const tm = models.find((m) => m.service === link.to.service)!;
        const tb = tm.businesses.find((x) => x.id === link.to.business)!;
        const entry = tb.entries.find((x) => x.id === link.to.endpoint)!;
        const tstep = tb.steps.find((s) => s.id === entry.step)!;
        const h = await this.handover(exit, entry, sent, key, link.to.service, tstep.position);
        const found = h.events.find((e) => matches(tb.match, e.attrs));
        const to = { service: link.to.service, business: tb.id, entry: entry.id };
        if (found) {
          seg.handover = { exit: exit.id, channel: exit.channel.type, to, state: h.inferred ? "inferred" : "confirmed", ...(h.source ? { source: h.source } : {}), key: found.key, ...(h.note ? { note: h.note } : {}) };
          return this.walk(models, link.to.service, tb, entry.step, found.key, found.at, segments, inferred || h.inferred);
        }
        const insufficient = h.missing.length > 0;
        if (!lost || (lost.state === "lost" && insufficient)) lost = { exit: exit.id, channel: exit.channel.type, to, state: insufficient ? "insufficient" : "lost", ...(h.missing.length ? { missing: h.missing } : {}), ...(h.note ? { note: h.note } : {}) };
      }
    }
    seg.handover = lost!;
    if (lost!.state === "insufficient" && lost!.to === null) return end("insufficient", `Insufficient evidence: the model is incomplete. ${lost!.note}`, last, danglingTo ? { actions: [danglingTo] } : {});
    if (lost!.state === "insufficient") return end("insufficient", `Left ${b.name}, but the hand-over cannot be followed: ${lost!.note ?? lost!.missing?.map((m) => `${m.source}: ${m.message}`).join("; ")}`, last);
    const where = lost!.to && "service" in lost!.to ? lost!.to.service : "?";
    const sentAt = seg.steps.find((s) => s.step === lost!.exit)?.at ?? seg.steps.find((s) => s.step === exits.find((x) => x.id === lost!.exit)?.step)?.at ?? "?";
    return end("handover-lost", `Sent from ${b.name} at ${sentAt} but ${where} never received it.`, last);
  }

  /** The steps after a stop, marked not reached. */
  private rest(seg: Segment, b: Business, stop: Step) {
    for (const s of b.steps.slice(b.steps.indexOf(stop) + 1)) seg.steps.push({ step: s.id, name: s.name, position: s.position, state: "not-reached", events: [] });
  }

  /** The channel type's rule for carrying the key across a hand-over (T2, T3). */
  private async handover(exit: Endpoint, entry: Endpoint, sent: ObservedEvent, key: CorrelationKey, service: string, position: Position): Promise<Asked & { inferred: boolean; note?: string }> {
    if (exit.channel.type === "s2s") {
      const from = iso(t(sent.at) - S2S_WINDOW_MS), to = iso(t(sent.at) + S2S_WINDOW_MS);
      const paired = await this.ask(service, (a) => Boolean(a.handover) && a.capabilities(service).handover.includes("s2s"), (a) => a.handover!({ service, channel: "s2s", sent, position, from, to }), "pair an S2S hand-over");
      if (paired.events.length) return { ...paired, inferred: false };
      // T3: one step down — the same file name at the receiving port within the window, marked inferred.
      const name = sent.attrs.filename;
      if (!name) return { ...paired, inferred: false, note: "Could not pair the S2S hand-over, and the sent data has no filename to infer it by." };
      const guess = await this.ask(service, (a) => Boolean(a.byPosition) && a.capabilities(service).byPosition, (a) => a.byPosition!({ service, position, from, to, where: { name: "filename", value: name } }), "be asked by position and time");
      // Lost only when some source could look and found nothing; if neither way could be asked at all, it is insufficient.
      const all = [...paired.missing, ...guess.missing];
      const missing = guess.events.length ? [] : all.every((m) => m.reason === "incapable") && all.length >= 2 ? all : all.filter((m) => m.reason !== "incapable");
      return { events: guess.events, ...(guess.source ? { source: guess.source } : {}), missing, inferred: guess.events.length > 0, ...(guess.events.length ? { note: `Paired by the same file name ${name} within ${S2S_WINDOW_MS / 60000} minutes (inferred, not confirmed).` } : {}) };
    }
    // MQ: the key travels in an attribute (default correlation_id); the endpoint may name another one.
    const attr = exit.keyAttribute ?? entry.keyAttribute ?? "correlation_id";
    const value = sent.attrs[attr] ?? (key.name === attr ? key.value : undefined);
    if (!value) return { events: [], missing: [{ source: "-", reason: "unavailable", message: `The sent data carries no ${attr} to follow over MQ.` }], inferred: false };
    const got = await this.byKey(service, { name: attr, value }, iso(t(sent.at) - 60_000), iso(this.now().getTime()), position);
    return { ...got, inferred: false };
  }
}

/** T11: one sentence on where stuck data waits, from what the collector had (parts it did not have are said so). */
export function describeStuck(c: StuckContext): string {
  const parts: string[] = [];
  if (c.queue) {
    const q = c.queue;
    parts.push(`The queue${q.name ? ` ${q.name}` : ""} holds ${q.flowFilesQueued ?? "?"} flowfiles (${Math.round(q.percent)} % of its threshold${q.backpressure ? ", back pressure on" : ""})`);
  }
  if (c.downstream && c.downstream.running !== null)
    parts.push(`${c.downstream.name ?? c.downstream.id} is ${c.downstream.running ? "running" : (c.downstream.runStatus ?? "not running").toLowerCase()}`);
  const said = parts.length ? `${parts.join("; ")}${c.at ? ` (as of ${c.at})` : ""}.` : "";
  return [said, ...c.notes].filter(Boolean).join(" ");
}
