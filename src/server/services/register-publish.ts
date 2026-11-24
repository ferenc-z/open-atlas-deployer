// S39 step 5 (business-registration §4.2, §4.3 step 5, §7.3, §7.5): a registration takes effect. Registering a business
// (commit, of a draft or of links), changing one (add, remove, declare-handoff, place-worker), registering a shared
// module (shared with commit) and unregistering chain the registration again (chain() on what NiFi has now), refuse
// while a gap is open (register/gaps-open: the gaps the change makes; a business keeps the ones it had), write the
// chain into the models of every service it touches and publish them all in one transaction, after the registration
// gate (register-gate.ts) judged them together. No approval: a registration is in effect when it is written. The models
// stay per service (§4.2); a business's segments carry its id, a shared module's segment its module id (§7.2), a told
// hand-over is an exit with `declared` (§7.3), and two registered groups joined on the canvas name the same canvas
// channel (port:<id> / link:<id>) on both sides, so the trace follows the data across (trace/channels.ts).

import { randomBytes } from "node:crypto";
import { newFlowId, type Actor, type FlowRecord, type RegistrationDraft, type RegistrationDraftHandoff, type Store, type WorkerPlace } from "../store.ts";
import type { ChainHandoff, ChainModule, ChainModuleEndpoint, Preview, PreviewGap, PreviewSegment } from "./chain.ts";
import { topologyFingerprint, type Topology } from "./flowcounts.ts";
import { segIdOf } from "./flowmodel.ts";
import { handoffsOf, toChain, type RegisterChain, type SharedPlan } from "./register-chain.ts";
import { registrationGate, type GateReg, type GateResult } from "./register-gate.ts";
import { NAME_MAX, RegError, handoffNames, type RegisteredGroup, type Registrations } from "./registration.ts";
import { parseModelV2, WHOLE, type Channel, type CueMapping, type Endpoint, type Exit, type ModelV2, type Segment, type Step } from "./trace/model.ts";

/** One business written from its chain: its id, name and the told hand-overs the chain used. */
export interface FlowBuild { flow: string; name: string; preview: Preview; handoffs: ChainHandoff[] }
interface Built { service: string; seg: Segment }
/** A start of a business (not a hand-over from another segment): the trace may begin there by file name. */
const START_CUES: CueMapping[] = [{ cue: "fileName", key: "filename" }];

/** A channel key of the chain (s2s:<service>/<port>, mq:<exchange>/<key>, port:/link:/declared:<id>) as an endpoint's channel. */
export function channelOf(key: string, side: "entry" | "exit"): Channel {
  const cut = (rest: string) => { const i = rest.indexOf("/"); return [rest.slice(0, i), rest.slice(i + 1)] as const; };
  if (key.startsWith("s2s:")) { const [service, port] = cut(key.slice(4)); return side === "exit" ? { type: "s2s", service, port } : { type: "s2s", port }; }
  if (key.startsWith("mq:")) { const [exchange, routingKey] = cut(key.slice(3)); return { type: "mq", exchange, routingKey }; }
  return { type: "external", system: key };
}

/** A shared module's segment (role shared, module id) from its registered endpoints. */
export function moduleSegment(m: Pick<ChainModule, "id" | "name" | "group" | "entries" | "exits">): Segment {
  const step: Step = { id: "g", name: m.group.name, position: { kind: "process-group", id: m.group.id, name: m.group.name } };
  const entries: Endpoint[] = m.entries.map((e) => ({ id: e.id, step: "g", channel: e.channel }));
  return {
    id: segIdOf(m.group.id, WHOLE), name: m.name, match: [], steps: [step],
    entries: entries.length ? entries : [{ id: "in", step: "g", channel: { type: "external", system: m.name } }],
    exits: m.exits.map((e: ChainModuleEndpoint): Exit => ({ id: e.id, step: "g", channel: e.channel, component: e.component ?? e.id, ...(e.relationship ? { relationship: e.relationship } : {}), ...(e.when?.length ? { when: e.when } : {}) })),
    group: m.group, slice: WHOLE, role: "shared", module: m.id,
  };
}

/** The segments a business's chain makes: one per registered group (or slice), and the modules it passes through. */
export function segmentsOf(b: FlowBuild, modules: Map<string, Pick<ChainModule, "id" | "name" | "entries" | "exits">>): Built[] {
  const p = b.preview;
  const out: Built[] = [];
  for (const s of p.segments) {
    if (s.role === "shared") {
      const m = s.module ? modules.get(s.module) : undefined;
      if (m) out.push({ service: s.service, seg: moduleSegment({ ...m, group: s.group }) });
      continue;
    }
    out.push({ service: s.service, seg: segmentOf(b, s) });
  }
  return out;
}

function segmentOf(b: FlowBuild, s: PreviewSegment): Segment {
  const p = b.preview;
  const steps: Step[] = s.steps.length
    ? s.steps.map((w, i) => ({ id: `w${i + 1}`, name: w, position: { kind: "worker", id: w, name: w } }))
    : [{ id: "g", name: s.group.name, position: { kind: "process-group", id: s.group.id, name: s.group.name } }];
  const first = steps[0]!.id, last = steps[steps.length - 1]!.id;
  const entries: Endpoint[] = [];
  const seenIn = new Set<string>();
  const addIn = (key: string, start: boolean) => {
    if (seenIn.has(key)) return;
    seenIn.add(key);
    entries.push({ id: key.startsWith("declared:") ? `declared-${key.slice(9)}` : `in-${entries.length + 1}`, step: first, channel: channelOf(key, "entry"), ...(start ? { cues: START_CUES } : {}) });
  };
  for (const e of p.entries) if (e.segment === s.id) addIn(e.channel ?? e.label, true);
  for (const e of p.edges) {
    if (e.to !== s.id) continue;
    if (e.kind === "declared" && e.handoff) addIn(`declared:${e.handoff}`, false);
    else if (e.channel) addIn(e.channel, false);
  }
  if (!entries.length) addIn(s.group.name, true);

  const exits: Exit[] = [];
  const seenOut = new Set<string>();
  const addOut = (x: Omit<Exit, "id" | "step">, id?: string) => {
    const k = `${x.channel.type}:${x.channel.service ?? ""}/${x.channel.port ?? x.channel.system ?? `${x.channel.exchange}/${x.channel.routingKey}`}|${x.component}`;
    if (seenOut.has(k)) return;
    seenOut.add(k);
    exits.push({ id: id ?? `out-${exits.length + 1}`, step: last, ...x });
  };
  const declared = (h: ChainHandoff) => addOut({ channel: { type: "external", system: `declared:${h.id}` }, component: h.from.component, ...(h.from.relationship ? { relationship: h.from.relationship } : {}),
    declared: { handoff: h.id, to: h.to, quote: h.quote, ...(h.by ? { by: h.by } : {}), ...(h.at ? { at: h.at } : {}) } }, `declared-${h.id}`);
  // A module that hands this business's data back (its exit leads to one of the business's segments) is on its path;
  // one it only feeds (errors, audit, dead letters) is a side road.
  const back = new Set(p.edges.filter((e) => e.kind === "shared-exit" && p.segments.some((x) => x.id === e.to && x.role === "segment")).map((e) => e.from));
  const rank = new Map<string, number>();
  for (const e of p.edges) {
    if (e.from !== s.id) continue;
    if (e.kind === "declared") { const h = b.handoffs.find((x) => x.id === e.handoff); if (h) declared(h); continue; }
    if (!e.channel) continue;
    const n = exits.length;
    addOut({ channel: channelOf(e.channel, "exit"), component: e.component ?? s.steps[s.steps.length - 1] ?? s.group.id });
    if (exits.length > n) rank.set(exits[n]!.id, e.kind === "shared-entry" ? (back.has(e.to) ? 1 : 3) : 0);
  }
  for (const x of p.exits) {
    if (x.segment !== s.id) continue;
    if (x.channel?.startsWith("declared:")) { const h = b.handoffs.find((y) => y.id === x.channel!.slice(9)); if (h) declared(h); continue; }
    if (x.component) addOut({ channel: { type: "external", system: x.label }, component: x.component });
  }
  // The trace follows the first exit the data is found behind, and ends at the first one leaving NiFi: the business's
  // own hand-overs first, then a module on its path, then where it leaves NiFi (told or written), side roads last.
  exits.sort((a, c) => (rank.get(a.id) ?? 2) - (rank.get(c.id) ?? 2));
  return { id: segIdOf(s.group.id, s.slice), name: s.group.name, match: [], steps, entries, exits, group: s.group, slice: s.slice, role: "segment", flow: b.flow };
}

/** The new model of every service touched: the segments built here in, the replaced ones (the businesses and modules
 *  rebuilt or dropped, anything else on a group now written) out. Every model is checked as a publish would be. */
export function buildModels(current: ModelV2[], built: Built[], drop: { flows: Set<string>; modules: Set<string> }): ModelV2[] {
  const mine = new Map<string, Segment[]>();
  for (const x of built) {
    const list = mine.get(x.service) ?? [];
    if (!list.some((s) => s.id === x.seg.id)) list.push(x.seg);
    mine.set(x.service, list);
  }
  const dropped = (s: Segment) => Boolean((s.flow && drop.flows.has(s.flow)) || (s.module && drop.modules.has(s.module)));
  const touched = new Set([...mine.keys(), ...current.filter((m) => m.segments.some(dropped)).map((m) => m.service)]);
  const out: ModelV2[] = [];
  for (const service of touched) {
    const cur = current.find((m) => m.service === service);
    const segs = mine.get(service) ?? [];
    const keep = (cur?.segments ?? []).filter((s) => !dropped(s) && !segs.some((n) => n.id === s.id || (n.group.id === s.group.id && (n.slice === WHOLE || s.slice === WHOLE || n.slice === s.slice))));
    const model: ModelV2 = { version: 2, service, sources: cur?.sources ?? [], segments: [...keep, ...segs] };
    const parsed = parseModelV2(service, model);
    if ("errors" in parsed) throw new Error(`The registration's model of ${service} is not valid: ${parsed.errors.slice(0, 5).join("; ")}`);
    // A service whose segments come out the same gets no new revision (only what the change touches is published).
    if (cur && same(cur, model)) continue;
    out.push(model);
  }
  return out;
}

const same = (a: ModelV2, b: ModelV2) => {
  const key = (m: ModelV2) => JSON.stringify([...m.segments].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)));
  return key(a) === key(b);
};

/** A gap as the same gap in another preview of the business (segment ids differ between previews). */
function gapKey(p: Preview, g: PreviewGap): string {
  const s = p.segments.find((x) => x.id === g.segment);
  return [g.kind, s ? `${s.service}/${s.group.id}/${s.slice}` : "", g.component ?? "", g.neighbor ? `${g.neighbor.service}/${g.neighbor.group?.id ?? ""}/${g.neighbor.port ?? ""}` : "",
    g.worker ? `${g.worker.schedule}/${g.worker.name}` : "", g.kind === "disconnected" ? (g.segments ?? []).map((id) => p.segments.find((x) => x.id === id)?.group.id).sort().join(",") : ""].join("|");
}

interface FlowState { groups: { service: string; group: string; slice?: string; link: string | null }[]; handoffs: RegistrationDraftHandoff[]; places: WorkerPlace[] }

export interface PublishDeps { store: Store; registrations: Registrations; chains: RegisterChain; now?: () => Date }

export class RegisterPublisher {
  private d: PublishDeps;
  constructor(d: PublishDeps) { this.d = d; }
  private get store() { return this.d.store; }

  // --- the chain and the gaps ------------------------------------------------------------------------------------

  private chain(flow: string, name: string, s: FlowState, modules?: ChainModule[]): Promise<Preview> {
    return this.d.chains.chainOf(s.groups.map((g) => ({ service: g.service, group: g.group, slice: g.slice ?? WHOLE, link: g.link })),
      { name, flow, handoffs: s.handoffs.map(toChain), placements: s.places, ...(modules ? { modules } : {}) });
  }

  private stateOf(flow: string): FlowState {
    return {
      groups: this.store.flowRegistrations({ owner: flow }).map((r) => ({ service: r.service, group: r.groupId, slice: r.slice, link: r.link })),
      handoffs: this.store.flowHandoffs(flow), places: this.store.workerPlaces(flow),
    };
  }

  /** A change to a registered business may not open a gap; the gaps it already had (the canvas changed since) do not
   *  hold it up, so they can be answered one at a time. */
  private async newGaps(flow: string, name: string, after: Preview, before: () => Promise<Preview>): Promise<void> {
    if (!after.gaps.length) return;
    let had: Set<string>;
    try { const b = await before(); had = new Set(b.gaps.map((g) => gapKey(b, g))); } catch { had = new Set(); }
    const fresh = after.gaps.filter((g) => !had.has(gapKey(after, g)));
    if (fresh.length) throw gapsOpen(after, fresh, { flow, name });
  }

  // --- the publish -----------------------------------------------------------------------------------------------

  /** The registrations after the action: the store's, with these owners' replaced (null: gone). */
  private regsAfter(over: Map<string, GateReg[] | null>): GateReg[] {
    const all: GateReg[] = this.store.flowRegistrations().filter((r) => !over.has(r.owner))
      .map((r) => ({ owner: r.owner, role: r.role, service: r.service, groupId: r.groupId, groupName: r.groupName, slice: r.slice, link: r.link }));
    for (const rows of over.values()) if (rows) all.push(...rows);
    return all;
  }

  /** Builds every touched service's model, runs the gate over them, and in one transaction publishes them all, writes
   *  the businesses' rows and segments and then `write` (the registration's own rows, with the revisions). */
  private publish(o: { op: string; actor: Actor; builds: FlowBuild[]; extra?: Built[]; dropFlows?: string[]; dropModules?: string[];
    modules?: ChainModule[]; regs: Map<string, GateReg[] | null>; own: string[] }, write: (revisions: Map<string, number>) => void): { revisions: { service: string; revision: number }[]; gate: GateResult } {
    const store = this.store;
    const now = this.d.now?.() ?? new Date();
    const current = store.flowModels();
    const mods = new Map<string, Pick<ChainModule, "id" | "name" | "entries" | "exits">>(store.sharedModules().map((m) => [m.id, { id: m.id, name: m.name, entries: m.entries as ChainModuleEndpoint[], exits: m.exits as ChainModuleEndpoint[] }]));
    for (const m of o.modules ?? []) mods.set(m.id, m);
    const built = [...o.builds.flatMap((b) => segmentsOf(b, mods)), ...(o.extra ?? [])];
    const models = buildModels(current.map((m) => m.model), built, {
      flows: new Set([...o.builds.map((b) => b.flow), ...(o.dropFlows ?? [])]),
      modules: new Set([...built.map((x) => x.seg.module).filter((x): x is string => Boolean(x)), ...(o.dropModules ?? [])]),
    });
    const gate = registrationGate({
      base: current.map((m) => m.model), draft: models, regs: this.regsAfter(o.regs), own: new Set(o.own), now,
      topology: (s) => (store.latestTopology(s)?.body as Topology | undefined) ?? null,
      counts: (s, from, to) => store.flowCounts(s, from, to).map((r) => ({ kind: r.kind, ref: r.ref, bucket: r.bucket, in: r.flowfilesIn, out: r.flowfilesOut, moved: r.transferred })),
      names: (f) => o.builds.find((b) => b.flow === f)?.name ?? store.flow(f)?.name ?? f,
    });
    if (gate.verdict === "rejected") {
      const failed = gate.checks.filter((c) => !c.ok);
      throw new RegError("register/gate-rejected", `The registration is not in effect: the gate refused it (${failed.map((c) => `${c.check}: ${c.text}`).join("; ")}). Take each problem back to the owner.`,
        { checks: gate.checks, problems: gate.problems, regressions: gate.regressions });
    }
    const revisions = new Map<string, number>();
    store.flowTransaction(() => store.flowOp(o.op, () => {
      for (const m of models) {
        const base = current.find((x) => x.service === m.service)?.revision ?? 0;
        revisions.set(m.service, store.insertFlowModel(m.service, base, m, "register", o.actor, gate.checks, topologyFingerprint(store.latestTopology(m.service)?.body as Topology | undefined)));
      }
      const at = now.toISOString();
      for (const b of o.builds) {
        const was = store.flow(b.flow);
        const row: FlowRecord = was ? { ...was, name: b.name, nameBy: "person" } : {
          id: b.flow, name: b.name, nameBy: "person", status: "confirmed", summary: "", reason: null, risks: [], pendings: [], stuck: null,
          createdAt: at, confirmedAt: at, confirmedBy: o.actor.id, updatedAt: at,
        };
        store.putFlow(row);
        const order = b.preview.layers.flat().map((id) => b.preview.segments.find((s) => s.id === id)).filter((s): s is PreviewSegment => Boolean(s) && s!.role === "segment")
          .map((s) => ({ service: s.service, segment: segIdOf(s.group.id, s.slice) }));
        store.setFlowSegments(b.flow, order);
      }
      // A business from before the registrations whose segment a registered group replaced loses that segment.
      const rebuilt = new Set(o.builds.map((b) => b.flow));
      for (const m of models) {
        const ids = new Set(m.segments.map((s) => s.id));
        for (const f of store.flows(m.service)) {
          if (rebuilt.has(f.id)) continue;
          const segs = store.flowSegments(f.id);
          const left = segs.filter((s) => s.service !== m.service || ids.has(s.segment));
          if (left.length !== segs.length) store.setFlowSegments(f.id, left);
        }
      }
      write(revisions);
    }));
    return { revisions: [...revisions].map(([service, revision]) => ({ service, revision })), gate };
  }

  private regRows(flow: string, p: Preview): GateReg[] {
    return p.groups.filter((g) => g.state === "ok").map((g) => ({ owner: flow, role: "segment" as const, service: g.service, groupId: g.group.id, groupName: g.group.name, slice: g.slice, link: g.link }));
  }

  // --- the actions -----------------------------------------------------------------------------------------------

  /** commit (§7.5, §7.9): a draft (its groups, told hand-overs, worker places and name) or links become a business. */
  async commit(b: Record<string, unknown>, actor: Actor) {
    const reg = this.d.registrations;
    let name: string, groups: RegisteredGroup[], handoffs: RegistrationDraftHandoff[], places: WorkerPlace[] = [], draft: string | null = null;
    if (b.draft !== undefined) {
      if (b.links !== undefined) throw new RegError("register/bad-request", "A draft is committed with its own groups: add links to the draft first.");
      const d = reg.draft(b.draft);
      if (d.flow) return this.commitChanges(d, b, actor);
      draft = d.id;
      name = nameOf(b.name ?? d.name);
      if (!d.groups.length) throw new RegError("register/empty", "The draft has no group yet: add a link first.");
      groups = d.groups.map((g) => ({ service: g.service, group: g.group, link: g.link }));
      handoffs = d.handoffs; places = d.places;
      // Somebody may have registered one of them since it went into the draft.
      const asks = d.groups.filter((g) => g.link).map((g) => ({ link: g.link!, service: g.service }));
      if (asks.length) await reg.stage(asks, d.id, []);
    } else {
      name = nameOf(b.name);
      groups = (await reg.stage(b.links, "commit", [])).added;
      handoffs = handoffsOf(b.handoffs).map((h) => ({ id: /^hof_[0-9a-f]{12}$/.test(h.id) ? h.id : `hof_${randomBytes(6).toString("hex")}`, from: h.from, to: h.to, quote: h.quote, declaredBy: actor.id, declaredAt: new Date().toISOString() }));
    }
    if (!groups.length) throw new RegError("register/empty", "Nothing to register: every group given is registered by this business already.");
    const flow = newFlowId();
    const state: FlowState = { groups: groups.map((g) => ({ service: g.service, group: g.group.id, link: g.link })), handoffs, places };
    const preview = await this.chain(flow, name, state);
    if (preview.gaps.length) throw gapsOpen(preview, preview.gaps, { name });
    const shown = new Map(preview.groups.map((g) => [`${g.service}\0${g.group.id}`, g]));
    const rows: RegisteredGroup[] = groups.map((g) => ({ ...g, group: { ...g.group, name: shown.get(`${g.service}\0${g.group.id}`)?.group.name ?? g.group.name, path: shown.get(`${g.service}\0${g.group.id}`)?.group.path || g.group.path } }));
    const { revisions, gate } = this.publish({ op: opId(), actor, builds: [{ flow, name, preview, handoffs: state.handoffs.map(toChain) }], regs: new Map([[flow, this.regRows(flow, preview)]]), own: [flow, ...moduleIds(preview)] }, (rev) => {
      reg.addStaged(flow, rows, actor, "register", rev, name);
      for (const h of handoffs) this.store.putFlowHandoff(flow, h);
      for (const p of places) this.store.setWorkerPlace(flow, p.schedule, p.worker, { service: p.service, group: p.group, quote: p.quote, placedBy: p.placedBy, placedAt: p.placedAt });
      if (draft) this.store.deleteRegistrationDraft(draft);
    });
    return { flow, name, revisions, verdict: "published" as const, preview, gate: gate.checks, ...(draft ? { draft } : {}) };
  }

  /** commit of a draft of a business's changes (step 6, §7.9): the business becomes what the draft says (groups, told
   *  hand-overs, worker places, name), chained, gated and published as one change; only gaps it opens refuse it. */
  private async commitChanges(d: RegistrationDraft, b: Record<string, unknown>, actor: Actor) {
    const reg = this.d.registrations;
    const flow = reg.flowOf(d.flow);
    const name = nameOf(b.name ?? d.name ?? flow.name);
    if (!d.groups.length) throw new RegError("register/empty", "The draft has no group left: unregister the business instead.");
    const before = this.stateOf(flow.id);
    const k = (service: string, group: string) => `${service}\0${group}`;
    const had = new Map(before.groups.map((g) => [k(g.service, g.group), g]));
    const asks = d.groups.filter((g) => !had.has(k(g.service, g.group.id)) && g.link).map((g) => ({ link: g.link!, service: g.service }));
    // Somebody may have registered one of the new groups since it went into the draft.
    const added = asks.length ? (await reg.stage(asks, flow.id, [])).added : [];
    const state: FlowState = { groups: d.groups.map((g) => ({ service: g.service, group: g.group.id, slice: had.get(k(g.service, g.group.id))?.slice, link: g.link })), handoffs: d.handoffs, places: d.places };
    const sameAs = JSON.stringify([state.groups.map((g) => k(g.service, g.group)).sort(), d.handoffs, d.places]) === JSON.stringify([[...had.keys()].sort(), before.handoffs, before.places]);
    if (sameAs && name === flow.name) {
      this.store.deleteRegistrationDraft(d.id);
      return { flow: flow.id, name, revisions: [], published: false, gate: [] as GateResult["checks"], draft: d.id, unchanged: true };
    }
    const preview = await this.chain(flow.id, name, state);
    await this.newGaps(flow.id, name, preview, () => this.chain(flow.id, flow.name, before));
    let out!: ReturnType<Registrations["applyDraft"]>;
    const { revisions, gate } = this.publish({ op: opId(), actor, builds: [{ flow: flow.id, name, preview, handoffs: d.handoffs.map(toChain) }], regs: new Map([[flow.id, this.regRows(flow.id, preview)]]), own: [flow.id] }, (rev) => {
      out = reg.applyDraft(d, added, actor, rev, flow.name, name);
      this.store.deleteRegistrationDraft(d.id);
    });
    return { flow: flow.id, name, ...out, revisions, verdict: "published" as const, published: true, preview, gate: gate.checks, draft: d.id };
  }

  /** add (§7.5): groups join a registered business; told hand-overs may come with them (handoffs, as in preview). */
  async add(b: Record<string, unknown>, actor: Actor) {
    const reg = this.d.registrations;
    const flow = reg.flowOf(b.flow);
    const { added, unchanged } = await reg.stage(b.links, flow.id, []);
    const before = this.stateOf(flow.id);
    const groups = [...before.groups, ...added.map((a) => ({ service: a.service, group: a.group.id, link: a.link }))];
    const told = (handoffsOf(b.handoffs)).map((h) => reg.handoffFor(groups, before.handoffs, { from: h.from, to: h.to, quote: h.quote }, actor, "business").handoff!);
    if (!added.length && !told.length) return { flow: flow.id, added, unchanged, revisions: [], published: false };
    const state: FlowState = { ...before, groups, handoffs: [...before.handoffs, ...told] };
    const preview = await this.chain(flow.id, flow.name, state);
    await this.newGaps(flow.id, flow.name, preview, () => this.chain(flow.id, flow.name, before));
    const { revisions, gate } = this.publish({ op: opId(), actor, builds: [{ flow: flow.id, name: flow.name, preview, handoffs: state.handoffs.map(toChain) }], regs: new Map([[flow.id, this.regRows(flow.id, preview)]]), own: [flow.id] }, (rev) => {
      reg.addStaged(flow.id, added, actor, "add-group", rev);
      for (const h of told) reg.writeHandoff(flow.id, { handoff: h }, actor, rev);
    });
    return { flow: flow.id, added, unchanged, revisions, published: true, preview, gate: gate.checks };
  }

  /** remove (§7.5): groups leave a registered business, with the told hand-overs and worker places on them. */
  async remove(b: Record<string, unknown>, actor: Actor) {
    const reg = this.d.registrations;
    const { flow, wanted } = reg.removing(b.flow, b.groups);
    const name = this.store.flow(flow)!.name;
    const before = this.stateOf(flow);
    const gone = (service: string, group: string | null) => wanted.some((w) => w.service === service && w.group === group);
    const state: FlowState = {
      groups: before.groups.filter((g) => !gone(g.service, g.group)),
      handoffs: before.handoffs.filter((h) => !wanted.some((w) => handoffNames(h, w.service, w.group))),
      places: before.places.filter((p) => !(p.service && gone(p.service, p.group))),
    };
    const preview = await this.chain(flow, name, state);
    await this.newGaps(flow, name, preview, () => this.chain(flow, name, before));
    let out!: ReturnType<Registrations["remove"]>;
    const { revisions, gate } = this.publish({ op: opId(), actor, builds: [{ flow, name, preview, handoffs: state.handoffs.map(toChain) }], regs: new Map([[flow, this.regRows(flow, preview)]]), own: [flow] },
      (rev) => { out = reg.remove(flow, b.groups, actor, rev); });
    return { ...out, revisions, published: true, preview, gate: gate.checks };
  }

  /** declare-handoff of a registered business (§7.3, §7.5): kept, replaced or removed, then published. */
  async declareHandoff(b: Record<string, unknown>, actor: Actor) {
    const reg = this.d.registrations;
    const flow = reg.flowOf(b.flow);
    const before = this.stateOf(flow.id);
    const got = reg.handoffFor(before.groups, before.handoffs, b, actor, "business");
    const handoffs = got.removed ? before.handoffs.filter((h) => h.id !== got.removed) : [...before.handoffs.filter((h) => h.id !== got.handoff!.id), got.handoff!];
    const state: FlowState = { ...before, handoffs };
    const preview = await this.chain(flow.id, flow.name, state);
    await this.newGaps(flow.id, flow.name, preview, () => this.chain(flow.id, flow.name, before));
    const { revisions, gate } = this.publish({ op: opId(), actor, builds: [{ flow: flow.id, name: flow.name, preview, handoffs: handoffs.map(toChain) }], regs: new Map([[flow.id, this.regRows(flow.id, preview)]]), own: [flow.id] },
      (rev) => reg.writeHandoff(flow.id, got, actor, rev));
    return { flow: flow.id, ...(got.handoff ? { handoff: got.handoff } : { removed: got.removed }), revisions, published: true, preview, gate: gate.checks };
  }

  /** place-worker of a registered business (§7.8 6): the chain uses it at once. */
  async placeWorker(b: Record<string, unknown>, actor: Actor) {
    const reg = this.d.registrations;
    const flow = reg.flowOf(b.flow);
    const { plan } = reg.placeWorker({ flow: b.flow }, b, actor, { plan: true });
    const before = this.stateOf(flow.id);
    const state: FlowState = { ...before, places: reg.placesAfter(plan!) };
    const preview = await this.chain(flow.id, flow.name, state);
    await this.newGaps(flow.id, flow.name, preview, () => this.chain(flow.id, flow.name, before));
    const { revisions, gate } = this.publish({ op: opId(), actor, builds: [{ flow: flow.id, name: flow.name, preview, handoffs: before.handoffs.map(toChain) }], regs: new Map([[flow.id, this.regRows(flow.id, preview)]]), own: [flow.id] },
      (rev) => reg.writeWorkerPlace(plan!, actor, rev));
    return { flow: flow.id, schedule: plan!.schedule, worker: plan!.worker, place: plan!.place, revisions, published: true, preview, gate: gate.checks };
  }

  /** unregister (§7.5): the business (or module) and its registered groups go; its services publish models without them. */
  async unregister(b: Record<string, unknown>, actor: Actor) {
    const reg = this.d.registrations;
    if ((b.flow === undefined) === (b.module === undefined)) throw new RegError("register/bad-request", "Give flow or module, one of them.");
    if (b.module !== undefined) await this.d.chains.assertModuleFree(b.module);
    const owner = b.flow !== undefined ? reg.flowOf(b.flow).id : String(b.module);
    let out!: ReturnType<Registrations["unregister"]>;
    const target = b.flow !== undefined ? { flow: b.flow } : { module: b.module };
    if (b.module !== undefined && !this.store.sharedModule(owner)) return reg.unregister(target, actor); // register/not-found
    const { revisions } = this.publish({ op: opId(), actor, builds: [], ...(b.flow !== undefined ? { dropFlows: [owner] } : { dropModules: [owner] }), regs: new Map([[owner, null]]), own: [] },
      (rev) => { out = reg.unregister(target, actor, rev); });
    return { ...out, revisions, published: true };
  }

  /** shared with commit (§7.2, §7.8 1): the module is registered, its segment written, and every business joined to it
   *  (and the one it is taken from) chained again and published with it, in one transaction. */
  async shared(b: Record<string, unknown>, actor: Actor) {
    const chains = this.d.chains;
    if (b.commit !== true) return chains.shared(b, actor);
    const plan: SharedPlan = await chains.sharedPlan(b);
    const modules = [...chains.modules(plan.id), plan.module];
    const flows = [...new Set([...plan.users.map((u) => u.flow), ...(plan.takeover ? [plan.takeover.flow] : [])])].filter((f) => this.store.flow(f));
    const builds: FlowBuild[] = [];
    const regs = new Map<string, GateReg[] | null>([[plan.id, [{ owner: plan.id, role: "shared", service: plan.service, groupId: plan.group.id, groupName: plan.group.name, slice: WHOLE, link: plan.link }]]]);
    const users: { flow: string; name: string; joined: boolean; gaps: number; preview: Preview }[] = [];
    for (const f of flows) {
      const row = this.store.flow(f)!;
      const before = this.stateOf(f);
      const state: FlowState = { ...before, groups: before.groups.filter((g) => !(g.service === plan.service && g.group === plan.group.id)) };
      if (!state.groups.length) continue;
      const preview = await this.chain(f, row.name, state, modules);
      await this.newGaps(f, row.name, preview, () => this.chain(f, row.name, before));
      builds.push({ flow: f, name: row.name, preview, handoffs: state.handoffs.map(toChain) });
      regs.set(f, this.regRows(f, preview));
      users.push({ flow: f, name: row.name, joined: preview.segments.some((s) => s.module === plan.id), gaps: preview.gaps.length, preview });
    }
    const extra: Built[] = [{ service: plan.service, seg: moduleSegment(plan.module) }];
    const { revisions, gate } = this.publish({ op: opId(), actor, builds, extra, modules: [plan.module], dropModules: [plan.id], regs, own: [plan.id, ...flows] },
      (rev) => chains.sharedWrite(plan, actor, rev));
    return { module: plan.id, name: plan.name, revisions, published: true, preview: { ...plan.preview, segments: plan.preview.segments.map((s) => ({ ...s, module: plan.id })) }, users, gate: gate.checks, ...(plan.takeover ? { takeover: plan.takeover } : {}) };
  }
}

const opId = () => `op_${randomBytes(6).toString("hex")}`;
const moduleIds = (p: Preview) => p.segments.map((s) => s.module).filter((x): x is string => Boolean(x));

function nameOf(v: unknown): string {
  if (typeof v !== "string" || !v.trim() || v.trim().length > NAME_MAX) throw new RegError("register/bad-request", `name is 1 to ${NAME_MAX} characters: the business's name (the owner says it).`);
  return v.trim();
}

/** §7.8 3: a gap open refuses the registration; each one is to be registered, told (declare-handoff) or placed (place-worker). */
function gapsOpen(p: Preview, gaps: PreviewGap[], who: { flow?: string; name: string }): RegError {
  return new RegError("register/gaps-open", `${who.name ? `"${who.name}": ` : ""}${gaps.length} gap${gaps.length > 1 ? "s are" : " is"} open: register the group, tell the hand-over (declare-handoff, to: {system} when it leaves NiFi) or place the worker, then try again. ${gaps.slice(0, 3).map((g) => g.text).join(" ")}`,
    { gaps, preview: p, ...(who.flow ? { flow: who.flow } : {}) });
}
