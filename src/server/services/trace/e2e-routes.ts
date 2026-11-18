// S37 step 7 (T6, T8, T9): the HTTP side of the e2e_trace evidence source — a service's Graph and graph token
// (read: deploy-viewer; change: admin, T15), a check that Studio answers, and the model import from the schedule
// definitions. The import does not save: it returns the merged model for the editor, which saves it with PUT
// /api/services/:id/trace-model like any hand edit.

import type { Context, Hono } from "hono";
import type { Permission, Principal } from "../../auth.ts";
import type { Actor, Store } from "../../store.ts";
import { E2E_ID, E2eError, type E2eTraceSource } from "./e2e-trace.ts";
import { emptyModel, type TraceModel } from "./model.ts";

type Reject = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 429 | 503, code: string, message: string, details?: string[]) => Response;
export interface E2eRouteDeps {
  store: Store;
  source: E2eTraceSource;
  authenticate: (c: Context, need: Permission) => Promise<Principal | Response>;
  reject: Reject;
  registered: (id: string) => unknown;
  actorOf: (p: Principal) => Actor;
}

const GRAPH = /^[A-Za-z0-9_.\- ]{1,100}(\/[A-Za-z0-9_.\- ]{1,100})?$/;

export function mountE2eTrace(api: Hono, d: E2eRouteDeps) {
  const unknown = (c: Context, id: string) => d.reject(c, 404, "service/unknown", `No standalone instance or cluster ${id}.`);
  const failed = (c: Context, error: unknown) => {
    if (error instanceof E2eError) return c.json({ error: { code: error.code, message: error.message } }, error.status);
    return c.json({ error: { code: "e2e/studio", message: `Studio: ${(error as Error).message}` } }, 502);
  };
  const view = (id: string, p: Principal) => ({
    canEdit: p.permissions.includes("admin"),
    prerequisites: d.source.prerequisites(),
    canIssue: d.source.canIssue(),
    e2e_trace: d.source.config(id),
  });

  api.get("/api/services/:id/trace-sources", async (c) => {
    const p = await d.authenticate(c, "view");
    if (p instanceof Response) return p;
    const id = c.req.param("id");
    if (!d.registered(id)) return unknown(c, id);
    return c.json(view(id, p));
  });

  // {graph, token?}: a pasted graph token (oat_v1.), or none to have the Builder MCP issue one for the graph.
  api.put(`/api/services/:id/trace-sources/${E2E_ID}`, async (c) => {
    const p = await d.authenticate(c, "admin");
    if (p instanceof Response) return p;
    const id = c.req.param("id");
    if (!d.registered(id)) return unknown(c, id);
    const body = (await c.req.json().catch(() => null)) as { graph?: unknown; token?: unknown } | null;
    const graph = typeof body?.graph === "string" ? body.graph.trim() : "";
    if (!GRAPH.test(graph)) return d.reject(c, 400, "e2e/graph", "graph is the Studio graph's name, or workspace/name.");
    const token = typeof body?.token === "string" && body.token.trim() ? body.token.trim() : undefined;
    if (token !== undefined && !/^oat_v1\.[A-Za-z0-9._~+/=-]{10,2000}$/.test(token)) return d.reject(c, 400, "e2e/token", "token is a Studio graph token (oat_v1.…), or leave it out to have one issued.");
    try {
      const { issued } = await d.source.configure(id, graph, token, d.actorOf(p));
      return c.json({ ...view(id, p), issued, check: await d.source.check(id) });
    } catch (error) { return failed(c, error); }
  });

  api.delete(`/api/services/:id/trace-sources/${E2E_ID}`, async (c) => {
    const p = await d.authenticate(c, "admin");
    if (p instanceof Response) return p;
    const id = c.req.param("id");
    if (!d.registered(id)) return unknown(c, id);
    d.source.remove(id, d.actorOf(p));
    return c.json(view(id, p));
  });

  api.post(`/api/services/:id/trace-sources/${E2E_ID}/check`, async (c) => {
    const p = await d.authenticate(c, "view");
    if (p instanceof Response) return p;
    const id = c.req.param("id");
    if (!d.registered(id)) return unknown(c, id);
    if (!d.source.config(id)) return d.reject(c, 409, "e2e/not-configured", `${id} has no e2e_trace source.`);
    return c.json(await d.source.check(id));
  });

  // T6: schedule_header + schedule_detail → businesses, merged into the stored model (same id replaced), not saved.
  api.post("/api/services/:id/trace-model/import-e2e", async (c) => {
    const p = await d.authenticate(c, "admin");
    if (p instanceof Response) return p;
    const id = c.req.param("id");
    if (!d.registered(id)) return unknown(c, id);
    const stored = d.store.traceModel(id);
    const current: TraceModel = stored ? { ...emptyModel(id), ...(stored.body as object), service: id } : emptyModel(id);
    try {
      const got = await d.source.importModel(id, current);
      return c.json({ ...got, revision: stored?.revision ?? 0 });
    } catch (error) { return failed(c, error); }
  });
}
