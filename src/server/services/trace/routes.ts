// S37 step 5: the business data trace's HTTP side — a service's model (read: deploy-viewer; save: admin), the
// components a step's position can be picked from (a name search on the service's NiFi through its executor), and
// trace_business_data (structured conditions in, the engine's verdicts out). Evidence source adapters are registered
// by steps 6 (provenance) and 7 (e2e_trace); until then a trace says which sources it is missing.

import type { Context, Hono } from "hono";
import type { Permission, Principal } from "../../auth.ts";
import { StoreError, type Actor, type Store } from "../../store.ts";
import type { ServiceProvenance } from "../provenance.ts";
import { dangling, links } from "./channels.ts";
import { TraceEngine, type TraceQuery } from "./engine.ts";
import type { EvidenceAdapter } from "./events.ts";
import { CUES, emptyModel, parseModel, type TraceModel } from "./model.ts";

type Reject = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 429 | 503, code: string, message: string, details?: string[]) => Response;
export interface TraceDeps {
  store: Store;
  provenance: ServiceProvenance;
  authenticate: (c: Context, need: Permission) => Promise<Principal | Response>;
  reject: Reject;
  registered: (id: string) => unknown;
  actorOf: (p: Principal) => Actor;
  adapters: Map<string, EvidenceAdapter>;
}

export const TRACE_SPAN_DAYS = 31;
const DAY = 86400_000;

/** All stored models, each as its service's segment. */
export const allModels = (store: Store): TraceModel[] => store.traceModels().map((r) => ({ ...emptyModel(r.service), ...(r.body as object), service: r.service }));

/** trace_business_data's input: {service, business?, fileName?, emailFrom?, emailSubject?, from?, to?}; the range defaults to the last 24 hours. */
export function parseTraceQuery(service: string, body: unknown, now = new Date()): TraceQuery | { error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const to = b.to ? new Date(String(b.to)) : now;
  const from = b.from ? new Date(String(b.from)) : new Date(to.getTime() - DAY);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) return { error: "from and to are ISO times, from before to (default: the last 24 hours)." };
  if (to.getTime() - from.getTime() > TRACE_SPAN_DAYS * DAY) return { error: `The time range is at most ${TRACE_SPAN_DAYS} days.` };
  const q: TraceQuery = { service, from: from.toISOString(), to: to.toISOString() };
  for (const c of CUES) {
    const v = b[c];
    if (v === undefined || v === null || v === "") continue;
    if (typeof v !== "string" || v.trim().length > 256) return { error: `${c} is a text of at most 256 characters.` };
    q[c] = v.trim();
  }
  if (!CUES.some((c) => q[c])) return { error: `Give at least one clue: ${CUES.join(", ")}.` };
  if (b.business !== undefined && b.business !== null && b.business !== "") {
    if (typeof b.business !== "string") return { error: "business is a business id of the service's model." };
    q.business = b.business;
  }
  return q;
}

export function mountTrace(api: Hono, d: TraceDeps) {
  const engine = new TraceEngine({ models: () => allModels(d.store), adapters: d.adapters });
  const unknown = (c: Context, id: string) => d.reject(c, 404, "service/unknown", `No standalone instance or cluster ${id}.`);

  api.get("/api/services/:id/trace-model", async (c) => {
    const p = await d.authenticate(c, "view");
    if (p instanceof Response) return p;
    const id = c.req.param("id");
    if (!d.registered(id)) return unknown(c, id);
    const stored = d.store.traceModel(id);
    const models = allModels(d.store);
    const mine = (r: { service: string }) => r.service === id;
    return c.json({
      model: stored ? { ...emptyModel(id), ...(stored.body as object), service: id } : emptyModel(id),
      revision: stored?.revision ?? 0, savedAt: stored?.savedAt ?? null, savedBy: stored?.savedBy ?? null, canEdit: p.permissions.includes("admin"),
      health: { dangling: dangling(models).filter(mine), links: links(models).filter((l) => l.from.service === id || l.to.service === id) },
      sources: [...d.adapters.keys()],
    });
  });

  api.put("/api/services/:id/trace-model", async (c) => {
    const p = await d.authenticate(c, "admin");
    if (p instanceof Response) return p;
    const id = c.req.param("id");
    if (!d.registered(id)) return unknown(c, id);
    const body = (await c.req.json().catch(() => null)) as { model?: unknown; revision?: unknown } | null;
    if (!body || !Number.isInteger(body.revision)) return d.reject(c, 400, "trace-model/invalid", "Send {model, revision}: revision is the one the editor loaded (0 for a new model).");
    const got = parseModel(id, body.model);
    if ("errors" in got) return d.reject(c, 400, "trace-model/invalid", `The model has ${got.errors.length} problem(s).`, got.errors);
    try {
      const revision = d.store.saveTraceModel(id, { sources: got.model.sources, businesses: got.model.businesses }, body.revision as number, d.actorOf(p));
      const models = allModels(d.store);
      return c.json({ revision, health: { dangling: dangling(models).filter((x) => x.service === id), links: links(models).filter((l) => l.from.service === id || l.to.service === id) } });
    } catch (error) {
      if (error instanceof StoreError) return d.reject(c, 409, error.code, error.message);
      throw error;
    }
  });

  // A step's position picked by name: NiFi's own component search, through a member's service executor.
  api.get("/api/services/:id/trace-model/positions", async (c) => {
    const p = await d.authenticate(c, "view");
    if (p instanceof Response) return p;
    const id = c.req.param("id");
    if (!d.registered(id)) return unknown(c, id);
    const q = (c.req.query("q") ?? "").trim();
    if (!q || q.length > 100) return d.reject(c, 400, "trace-model/search", "q is 1 to 100 characters of a component's name or id.");
    return c.json(await d.provenance.flowSearch(id, q));
  });

  // trace_business_data (§4.2): the skeleton the page (step 8) and the MCP tool share.
  api.post("/api/services/:id/trace-business-data", async (c) => {
    const p = await d.authenticate(c, "view");
    if (p instanceof Response) return p;
    const id = c.req.param("id");
    if (!d.registered(id)) return unknown(c, id);
    const q = parseTraceQuery(id, await c.req.json().catch(() => ({})));
    if ("error" in q) return d.reject(c, 400, "trace/query", q.error);
    return c.json(await engine.trace(q));
  });
}
