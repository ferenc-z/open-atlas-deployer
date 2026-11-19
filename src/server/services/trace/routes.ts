// S37 step 5: the business data trace's HTTP side. The models are v2 (flow_models, ops step 2), written only through
// publish_model (services/flowmodel.ts); GET trace-model and the e2e import route went with it (§10.2.5).
// trace_business_data takes structured conditions and returns the engine's verdicts; evidence source adapters are
// registered in app.ts.

import type { Context, Hono } from "hono";
import type { Permission, Principal } from "../../auth.ts";
import type { Actor, Store } from "../../store.ts";
import type { ServiceProvenance } from "../provenance.ts";
import { TraceEngine, type TraceQuery } from "./engine.ts";
import type { EvidenceAdapter } from "./events.ts";
import { stuckContextFrom } from "./flowstate.ts";
import { CUES, toTraceModel, type TraceModel } from "./model.ts";

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

/** Every service's newest v2 model (§10.2.4), as the engine's v1 shape (a segment is a business). */
export const allModels = (store: Store): TraceModel[] => store.flowModels().map((r) => toTraceModel({ ...r.model, service: r.service }));

/** B4: a segment's allowed time is its business's stuck time ("attention"), when the business has one. */
export const stuckSeconds = (store: Store) => (service: string, segment: string): number | undefined => {
  const flow = store.flowModel(service)?.model.segments.find((s) => s.id === segment)?.flow;
  return (flow && store.flow(flow)?.stuck?.attentionS) || undefined;
};

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
  const engine = new TraceEngine({ models: () => allModels(d.store), adapters: d.adapters, stuckContext: stuckContextFrom(d.store), stuckSeconds: stuckSeconds(d.store) });
  const unknown = (c: Context, id: string) => d.reject(c, 404, "service/unknown", `No standalone instance or cluster ${id}.`);

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
