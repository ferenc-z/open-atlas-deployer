// S37 step 5: the business data trace's HTTP side. A service's model is read here (deploy-viewer); it is written by the e2e_trace
// import (e2e-routes.ts) and, from S38 on, by the AI through MCP tools (pages-rethink §9.1 A4, A9): the hand-edit PUT, the
// position search and the sentence-to-conditions route were removed (§9.2). trace_business_data takes structured
// conditions and returns the engine's verdicts; evidence source adapters are registered in app.ts.

import type { Context, Hono } from "hono";
import type { Permission, Principal } from "../../auth.ts";
import type { Actor, Store } from "../../store.ts";
import type { ServiceProvenance } from "../provenance.ts";
import { dangling, links } from "./channels.ts";
import { TraceEngine, type TraceQuery } from "./engine.ts";
import type { EvidenceAdapter } from "./events.ts";
import { stuckContextFrom } from "./flowstate.ts";
import { CUES, emptyModel, type TraceModel } from "./model.ts";

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
  const engine = new TraceEngine({ models: () => allModels(d.store), adapters: d.adapters, stuckContext: stuckContextFrom(d.store) });
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
