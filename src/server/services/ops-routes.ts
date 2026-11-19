// pages-rethink §10.2 step 4: the routes behind the MCP verbs that had none (describe, the model, record, look's
// topology / flow-counts / components / model kinds) and the to-do buttons (§10.2.2 #9, #10). The MCP verbs call these
// in-process as the key's principal, like every other tool (mcp.ts), so the page and the AI share one code path.
//
// Who may write (§10.2.3, §10.3 P4, P5): publish_model and record take an administrator, the Deploy Assistant's key
// (dps_) or the check-up's key (dpc_); the Assistant's record writes to-dos only (todos.ts).

import type { Context, Hono } from "hono";
import type { Permission, Principal } from "../auth.ts";
import { isKey } from "../keys.ts";
import type { ExecutorInfo } from "../handoff.ts";
import { StoreError, type Actor, type FlowRecord, type Store } from "../store.ts";
import type { Topology } from "./flowcounts.ts";
import { draftFromSkeleton, gateRejected, ModelError, publishModel, runModel, parseDraft, type ModelDeps } from "./flowmodel.ts";
import { flowCard } from "./flow-views.ts";
import type { Anomaly, FlowStatus, Light, UnknownReason } from "./ops-types.ts";
import { provenanceSupport } from "./provenance.ts";
import { machineLight } from "./rules.ts";
import { skeletonOf } from "./skeleton.ts";
import { serviceStatus } from "./status.ts";
import { opsReads, parseRecord, record, RecordError, todoView, type AnalysisView, type Lights, type TodoView } from "./todos.ts";
import { UNPLACED } from "./trace/model.ts";

type Reject = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 429 | 503, code: string, message: string, details?: string[]) => Response;
type Call = (p: Principal, spec: { method: "GET" | "POST" | "PUT" | "DELETE"; path: string; body?: unknown }) => Promise<{ status: number; body: any }>;

/** §10.2.2: a business row and the business light, until step 3b's (BusinessHooks) replace the stand-in here. */
export interface FlowRow { id: string; name: string; status: FlowStatus; light: Light; sentence: string; services: string[]; anomalies: Anomaly[] }
export interface BusinessLightView { light: Light; reason?: UnknownReason; sentence: string; flows: FlowRow[]; toConfirm: number }
/** Step 3b plugs its business light and business detail in here (联调); without them describe uses the stand-ins below. */
export interface BusinessHooks {
  business?: (service: string, now: Date) => BusinessLightView;
  flowDetail?: (flow: string, service: string, now: Date) => unknown;
}

export interface OpsRouteDeps {
  store: Store;
  executor: (host: string) => ExecutorInfo;
  model: ModelDeps;
  flowSearch: (service: string, q: string) => Promise<unknown>;
  authenticate: (c: Context, need: Permission) => Promise<Principal | Response>;
  reject: Reject;
  registered: (id: string) => unknown;
  actorOf: (p: Principal) => Actor;
  /** One request to this API as a principal (the to-do's "Apply": the configuration draft route, as the person). */
  call: Call;
  hooks?: BusinessHooks;
  now?: () => Date;
}

export type GapCode = "no-model" | "unconfirmed" | "gate-rejected" | "topology-changed" | "no-exit" | "no-stuck-times" | "s2s-unpaired" | "no-counts";
export interface Gap { code: GapCode; text: string; fix: { verb: "publish_model" | "run_model" | "look" | "record"; args?: Record<string, unknown> } }

/** The stand-in business light (before 3b): what is confirmed and what waits; the light is unknown, never guessed. */
export function businessStandIn(store: Store, service: string): BusinessLightView {
  const flows = store.flows(service).filter((f) => f.status !== "ignored");
  const rows: FlowRow[] = flows.map((f) => ({
    id: f.id, name: f.name, status: f.status, light: "unknown", sentence: f.summary,
    services: [...new Set(store.flowSegments(f.id).map((s) => s.service))], anomalies: [],
  }));
  const toConfirm = flows.filter((f) => f.status === "proposed" || f.pending).length;
  const reason: UnknownReason = !flows.length ? "no-evidence" : flows.some((f) => gateRejected(store, f.id)) ? "gate-rejected" : toConfirm ? "unconfirmed" : "no-evidence";
  return { light: "unknown", reason, sentence: !flows.length ? "No business identified yet." : toConfirm ? `${toConfirm} of ${flows.length} businesses wait for a person to confirm them.` : `${flows.length} businesses.`, flows: rows, toConfirm };
}

/** describe's gaps: what keeps the business picture from being right, each with the verb that fixes it. */
export function gapsOf(store: Store, service: string, flows: FlowRecord[], now: Date): Gap[] {
  const gaps: Gap[] = [];
  const m = store.flowModel(service);
  if (!m) gaps.push({ code: "no-model", text: "No business model yet: start from look kind model's draft, replay it, then publish it.", fix: { verb: "run_model", args: { service } } });
  const proposed = flows.filter((f) => f.status === "proposed" || f.pending);
  if (proposed.length) gaps.push({ code: "unconfirmed", text: `${proposed.length} businesses wait for a person (${proposed.slice(0, 5).map((f) => f.name).join(", ")}); a to-do points them to the flows page.`, fix: { verb: "record", args: { service, todos: [{ key: `flows:${service}`, severity: "attention", action: { kind: "confirm-flows", label: "Review flows" } }] } } });
  const rejected = flows.filter((f) => gateRejected(store, f.id));
  if (rejected.length) gaps.push({ code: "gate-rejected", text: `The last model change for ${rejected.map((f) => f.name).join(", ")} failed the replay check: their lights are unknown until a publish passes.`, fix: { verb: "publish_model", args: { service } } });
  const topo = store.latestTopology(service);
  if (m && topo && topo.takenAt > m.publishedAt) gaps.push({ code: "topology-changed", text: `The canvas changed at ${topo.takenAt}, after model revision ${m.revision} (${m.publishedAt}).`, fix: { verb: "look", args: { service, kind: "topology" } } });
  const noExit = (m?.model.segments ?? []).filter((s) => s.role !== "shared" && (!s.exits?.length || s.exits.some((e) => !e.component || e.component === UNPLACED)));
  if (noExit.length) gaps.push({ code: "no-exit", text: `Segments without a placed exit: ${noExit.slice(0, 8).map((s) => s.id).join(", ")} (a drop outside the exits counts as data dropped).`, fix: { verb: "publish_model", args: { service } } });
  const noStuck = flows.filter((f) => f.status !== "ignored" && !f.stuck);
  if (noStuck.length) gaps.push({ code: "no-stuck-times", text: `No stuck times for ${noStuck.slice(0, 8).map((f) => f.name).join(", ")}: the defaults (10 / 60 minutes) are used.`, fix: { verb: "record", args: { service, analysis: { stuckSuggestions: noStuck.slice(0, 8).map((f) => ({ flow: f.id })) } } } });
  const unpaired = skeletonOf(store, now, [service]).questions.filter((q) => q.service === service && (q.kind === "s2s-unpaired" || q.kind === "s2s-name-only"));
  if (unpaired.length) gaps.push({ code: "s2s-unpaired", text: unpaired.slice(0, 5).map((q) => q.text).join(" "), fix: { verb: "look", args: { service, kind: "topology" } } });
  if (!store.hasFlowCounts(service)) gaps.push({ code: "no-counts", text: "No flow counts collected yet: the replay and the idle check have nothing to go on.", fix: { verb: "look", args: { service, kind: "flow-counts" } } });
  return gaps;
}

export function mountOps(api: Hono, d: OpsRouteDeps) {
  const now = () => d.now?.() ?? new Date();
  const reads = opsReads(d.store, now);
  const business = (service: string, at: Date) => d.hooks?.business?.(service, at) ?? businessStandIn(d.store, service);
  const lightsOf = (service: string, at: Date): Lights => ({ machine: machineLight(d.store, d.executor, service, at)?.light ?? "unknown", business: business(service, at).light });
  const unknown = (c: Context, id: string) => d.reject(c, 404, "service/unknown", `No standalone instance or cluster ${id}.`);
  const failed = (c: Context, e: unknown) => {
    if (e instanceof ModelError || e instanceof RecordError) return d.reject(c, e.status, e.code, e.message, e.details);
    if (e instanceof StoreError) return d.reject(c, 409, e.code, e.message, e.details);
    if (e instanceof Error && typeof (e as any).status === "number" && typeof (e as any).code === "string") return d.reject(c, (e as any).status, (e as any).code, e.message);
    throw e;
  };
  /** publish_model and record: an administrator, or an AI key (P4, P5). */
  const writer = async (c: Context): Promise<Principal | Response> => {
    const p = await d.authenticate(c, "view");
    if (p instanceof Response) return p;
    if (p.via === "service" || p.permissions.includes("admin")) return p;
    return d.reject(c, 403, "auth/forbidden", "Only Workbench admins can do this.");
  };

  /** One service as describe gives it. */
  const describeOne = (id: string, flow: string | undefined, at: Date) => {
    const s = serviceStatus(d.store, d.executor, id, at)!;
    const machine = machineLight(d.store, d.executor, id, at)!;
    const biz = business(id, at);
    const flows = d.store.flows(id);
    const m = d.store.flowModel(id);
    const support = provenanceSupport(s.version);
    const f = flow ? d.store.flow(flow) : null;
    return {
      service: { id, kind: s.kind, environment: s.environment, label: `NiFi ${s.version || "?"} · ${s.kind === "cluster" ? `cluster, ${s.members.length} nodes` : "standalone"}`, webUrl: s.webUrl },
      machine, business: biz,
      ...(f ? { flow: d.hooks?.flowDetail?.(f.id, id, at) ?? { flow: flowCard(d.store, f) } } : {}),
      todos: reads.todos(id), analysis: reads.analysis(id, { machine: machine.light, business: biz.light }),
      model: m ? { revision: m.revision, publishedAt: m.publishedAt, sources: m.model.sources } : null,
      provenance: support.supported ? { supported: true } : { supported: false, reason: support.note },
      gaps: gapsOf(d.store, id, flows, at),
    };
  };

  // describe (§10.2.3): one service (and one business), or every service's card.
  api.get("/api/describe", async (c) => {
    const p = await d.authenticate(c, "view");
    if (p instanceof Response) return p;
    const service = c.req.query("service") || undefined, flow = c.req.query("flow") || undefined;
    const at = now();
    if (service) {
      if (!d.registered(service)) return unknown(c, service);
      if (flow && !d.store.flowSegments(flow).some((x) => x.service === service)) return d.reject(c, 404, "flow/unknown", `No business ${flow} in ${service}.`);
      return c.json(describeOne(service, flow, at));
    }
    if (flow) return d.reject(c, 400, "describe/flow-needs-service", "Give service with flow.");
    const ids = [...d.store.standalones(), ...d.store.clusters()].map((x) => x.id).sort();
    const services = ids.map((id) => {
      const one = describeOne(id, undefined, at);
      return {
        id, kind: one.service.kind, environment: one.service.environment, label: one.service.label,
        machine: { light: one.machine.light, sentence: one.machine.sentence },
        business: { light: one.business.light, ...(one.business.reason ? { reason: one.business.reason } : {}), sentence: one.business.sentence, flowCount: one.business.flows.length, toConfirm: one.business.toConfirm },
        todoCount: one.todos.length, gaps: one.gaps.map((g) => g.code),
      };
    });
    return c.json({ services });
  });

  // look kind model: the newest model (base for publish_model) and a draft from the skeleton to start from.
  api.get("/api/services/:id/model", async (c) => {
    const p = await d.authenticate(c, "view");
    if (p instanceof Response) return p;
    const id = c.req.param("id");
    if (!d.registered(id)) return unknown(c, id);
    const m = d.store.flowModel(id);
    return c.json({
      current: m ? { revision: m.revision, publishedAt: m.publishedAt, publishedBy: m.publishedBy, source: m.source, model: m.model } : null,
      base: m?.revision ?? 0,
      draft: draftFromSkeleton(d.store, id, now()),
      flows: d.store.flows(id).map((f) => ({ id: f.id, name: f.name, nameBy: f.nameBy, status: f.status, summary: f.summary, stuck: f.stuck, pending: f.pending ? { kind: f.pending.kind, text: f.pending.text } : null })),
    });
  });

  // look kind topology: the newest canvas snapshot (root groups, links, S2S) and the skeleton's questions about it.
  api.get("/api/services/:id/topology", async (c) => {
    const p = await d.authenticate(c, "view");
    if (p instanceof Response) return p;
    const id = c.req.param("id");
    if (!d.registered(id)) return unknown(c, id);
    const t = d.store.latestTopology(id);
    const sk = skeletonOf(d.store, now(), [id]);
    return c.json({
      takenAt: t?.takenAt ?? null, topology: (t?.body as Topology | undefined) ?? null,
      skeleton: { flows: sk.flows.filter((f) => f.segments.some((s) => s.service === id)), shared: sk.shared.filter((s) => s.service === id), empty: sk.empty.filter((e) => e.service === id), questions: sk.questions.filter((q) => q.service === id) },
    });
  });

  // look kind flow-counts: the 5-minute counts summed per group and S2S port over the window (default the last day); ref: one row's buckets.
  api.get("/api/services/:id/flow-counts", async (c) => {
    const p = await d.authenticate(c, "view");
    if (p instanceof Response) return p;
    const id = c.req.param("id");
    if (!d.registered(id)) return unknown(c, id);
    const to = c.req.query("to") ? new Date(c.req.query("to")!) : now();
    const from = c.req.query("from") ? new Date(c.req.query("from")!) : new Date(to.getTime() - 86_400_000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) return d.reject(c, 400, "flow-counts/range", "from and to are ISO times, from before to.");
    const rows = d.store.flowCounts(id, from.toISOString(), to.toISOString());
    const ref = c.req.query("ref");
    if (ref) {
      const limit = Math.min(2000, Number(c.req.query("limit") ?? 288) || 288);
      const mine = rows.filter((r) => r.ref === ref);
      return c.json({ from: from.toISOString(), to: to.toISOString(), ref, truncated: mine.length > limit, buckets: mine.slice(-limit).map((r) => ({ bucket: r.bucket, kind: r.kind, in: r.flowfilesIn, out: r.flowfilesOut, transferred: r.transferred, bytesIn: r.bytesIn, bytesOut: r.bytesOut, source: r.source })) });
    }
    const sums = new Map<string, { kind: string; ref: string; name: string; in: number; out: number; transferred: number; buckets: number; first: string; last: string }>();
    for (const r of rows) {
      const k = `${r.kind}\0${r.ref}`;
      const s = sums.get(k) ?? { kind: r.kind, ref: r.ref, name: r.name, in: 0, out: 0, transferred: 0, buckets: 0, first: r.bucket, last: r.bucket };
      s.in += r.flowfilesIn; s.out += r.flowfilesOut; s.transferred += r.transferred; s.buckets++;
      if (r.bucket < s.first) s.first = r.bucket;
      if (r.bucket > s.last) { s.last = r.bucket; s.name = r.name; }
      sums.set(k, s);
    }
    return c.json({ from: from.toISOString(), to: to.toISOString(), rows: [...sums.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)) });
  });

  // look kind components: NiFi components (processors, ports, groups) by name or id, through the service executor.
  api.get("/api/services/:id/components", async (c) => {
    const p = await d.authenticate(c, "view");
    if (p instanceof Response) return p;
    const id = c.req.param("id");
    if (!d.registered(id)) return unknown(c, id);
    const q = (c.req.query("q") ?? "").trim();
    if (!q || q.length > 200) return d.reject(c, 400, "components/query", "q is 1 to 200 characters: part of a component's name, or its id.");
    try { return c.json(await d.flowSearch(id, q)); } catch (e) { return failed(c, e); }
  });

  // run_model: the draft replayed against the last 7 days; nothing is saved.
  api.post("/api/services/:id/model/run", async (c) => {
    const p = await d.authenticate(c, "view");
    if (p instanceof Response) return p;
    const id = c.req.param("id");
    if (!d.registered(id)) return unknown(c, id);
    const b = await c.req.json().catch(() => ({})) as { model?: unknown };
    try { return c.json(runModel(d.store, id, parseDraft(d.store, id, b.model).model, now())); } catch (e) { return failed(c, e); }
  });

  // publish_model: the gate, then A8's line (flowmodel.publishModel); a to-do when it is rejected or waits for a person.
  api.post("/api/services/:id/model/publish", async (c) => {
    const p = await writer(c);
    if (p instanceof Response) return p;
    const id = c.req.param("id");
    if (!d.registered(id)) return unknown(c, id);
    const b = await c.req.json().catch(() => ({})) as { base?: unknown; model?: unknown; note?: unknown; source?: unknown };
    if (!Number.isInteger(b.base)) return d.reject(c, 400, "flow-model/base", "base is the revision the draft was made on (look kind model: base; 0 when there is none).");
    if (typeof b.note !== "string" || !b.note.trim() || b.note.length > 2000) return d.reject(c, 400, "flow-model/note", "note says what changed and why (1 to 2000 characters).");
    if (b.source !== undefined && b.source !== "ai" && b.source !== "e2e_trace") return d.reject(c, 400, "flow-model/source", "source is ai or e2e_trace.");
    try {
      return c.json(await publishModel(d.model, { service: id, base: b.base as number, model: b.model, note: b.note.trim(), ...(b.source ? { source: b.source as "ai" | "e2e_trace" } : {}), actor: d.actorOf(p) }));
    } catch (e) { return failed(c, e); }
  });

  // record: the AI's analysis and to-dos (P5: the Assistant's key to-dos only).
  api.post("/api/services/:id/record", async (c) => {
    const p = await writer(c);
    if (p instanceof Response) return p;
    const id = c.req.param("id");
    if (!d.registered(id)) return unknown(c, id);
    try {
      const input = parseRecord(id, await c.req.json().catch(() => ({})));
      const at = now();
      return c.json(record({ store: d.store, actor: d.actorOf(p), scope: p.via === "service" && p.keyKind !== "checkup" ? "todos" : "full", lights: () => lightsOf(id, at), now }, input));
    } catch (e) { return failed(c, e); }
  });

  // #10: a person marks a to-do done or not needed (admin, §10.3).
  api.post("/api/todos/:todo/state", async (c) => {
    const p = await d.authenticate(c, "admin");
    if (p instanceof Response) return p;
    const t = d.store.todo(c.req.param("todo"));
    if (!t) return d.reject(c, 404, "todo/unknown", `No to-do ${c.req.param("todo")}.`);
    const b = await c.req.json().catch(() => ({})) as { state?: unknown };
    if (b.state !== "done" && b.state !== "dismissed") return d.reject(c, 400, "todo/state", "state is done or dismissed.");
    if (!d.store.closeTodo(t.id, b.state, d.actorOf(p))) return d.reject(c, 409, "todo/closed", `To-do ${t.id} is ${t.state} already.`);
    return c.json(todoView(d.store.todo(t.id)!));
  });

  // #9: "Apply the AI's change": the to-do's changes as a configuration draft, made as the person (browser only). The
  // draft route refuses secrets as for the AI (ai: true: the changes are the AI's); again, the same draft.
  api.post("/api/todos/:todo/draft", async (c) => {
    const p = await d.authenticate(c, "view");
    if (p instanceof Response) return p;
    if (isKey(p)) return d.reject(c, 403, "auth/browser-only", "A to-do's change is drafted from the page, not with an API key.");
    const t = d.store.todo(c.req.param("todo"));
    if (!t) return d.reject(c, 404, "todo/unknown", `No to-do ${c.req.param("todo")}.`);
    if (t.state !== "open") return d.reject(c, 409, "todo/closed", `To-do ${t.id} is ${t.state}.`);
    if (t.action?.kind !== "config-change") return d.reject(c, 409, "todo/no-change", "This to-do suggests no configuration change.");
    if (t.draft && d.store.serviceConfigDraft(t.service, t.draft)) return c.json({ draft: t.draft, service: t.service });
    const made = await d.call(p, { method: "POST", path: `/api/services/${encodeURIComponent(t.service)}/config/drafts`, body: { ai: true, changes: t.action.changes, note: t.action.note } });
    if (made.status >= 400) return c.json(made.body, made.status as 400);
    d.store.setTodoDraft(t.id, String(made.body.id));
    return c.json({ draft: String(made.body.id), service: t.service }, 201);
  });
}

export type { AnalysisView, TodoView };
