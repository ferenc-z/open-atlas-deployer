// pages-rethink §10.2.2 #3, #4, #5 (step 5): Look again now on a service, Check now over all services, and following
// one analysis. Every signed-in user may start one (§10.3); a running one answers 409 with what runs.

import type { Context, Hono } from "hono";
import type { Permission, Principal } from "../auth.ts";
import type { Store } from "../store.ts";
import { AnalysisError, type Analyses } from "./analyses.ts";
import { analysisView } from "./todos.ts";

type Reject = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 429 | 503, code: string, message: string, details?: string[]) => Response;
export interface AnalysisRouteDeps {
  store: Store;
  /** None: the two POSTs answer 503; reading an analysis still works. */
  analyses?: Analyses;
  authenticate: (c: Context, need: Permission) => Promise<Principal | Response>;
  reject: Reject;
  registered: (id: string) => unknown;
}

export function mountAnalyses(api: Hono, d: AnalysisRouteDeps) {
  const unavailable = (c: Context) => d.reject(c, 503, "analysis/unavailable", "The AI check-up is not configured (DEPLOYER_OMA_CHECKUP_AGENT and the OMA connection).");
  const failed = (c: Context, e: unknown) => {
    if (!(e instanceof AnalysisError)) throw e;
    return c.json({ error: e.code, message: e.message, ...(e.analysis ? { analysis: e.analysis } : {}), ...(e.run ? { run: e.run } : {}) }, e.status);
  };

  // #3: 202 the running analysis; 409 analysis/running with the one that runs.
  api.post("/api/services/:id/analyses", async (c) => {
    const p = await d.authenticate(c, "view");
    if (p instanceof Response) return p;
    const id = c.req.param("id");
    if (!d.registered(id)) return d.reject(c, 404, "service/unknown", `No standalone instance or cluster ${id}.`);
    if (!d.analyses) return unavailable(c);
    try { return c.json(d.analyses.view(d.analyses.checkNow(id, p.id)), 202); } catch (e) { return failed(c, e); }
  });

  // #4: 202 { run, services }.
  api.post("/api/analyses", async (c) => {
    const p = await d.authenticate(c, "view");
    if (p instanceof Response) return p;
    if (!d.analyses) return unavailable(c);
    try { return c.json(d.analyses.round(p.id), 202); } catch (e) { return failed(c, e); }
  });

  // #5: one analysis (running → done / failed).
  api.get("/api/analyses/:analysis", async (c) => {
    const p = await d.authenticate(c, "view");
    if (p instanceof Response) return p;
    const n = Number(c.req.param("analysis"));
    const a = Number.isInteger(n) && n > 0 ? d.store.analysis(n) : null;
    if (!a) return d.reject(c, 404, "analysis/unknown", `No analysis ${c.req.param("analysis")}.`);
    return c.json(d.analyses ? d.analyses.view(a) : analysisView(a, new Date()));
  });
}
