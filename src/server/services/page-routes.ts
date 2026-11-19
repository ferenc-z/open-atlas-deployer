// pages-rethink §10.2.2 #1, #2, #8 (ops step 3b): the services overview, a service's page and a business's detail.
// Read only, for every signed-in user and key with view.

import type { Context, Hono } from "hono";
import type { Permission, Principal } from "../auth.ts";
import type { ExecutorInfo } from "../handoff.ts";
import { isKey } from "../keys.ts";
import type { AnalysisRecord, Store } from "../store.ts";
import type { Visited } from "./analyses.ts";
import type { Light } from "./ops-types.ts";
import { flowDetail, servicePage, servicesOverview, type PageSources } from "./page-views.ts";
import type { AnalysisView } from "./todos.ts";

type Reject = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 429 | 503, code: string, message: string, details?: string[]) => Response;
export interface PageRouteDeps {
  store: Store;
  executor: (host: string) => ExecutorInfo;
  authenticate: (c: Context, need: Permission) => Promise<Principal | Response>;
  reject: Reject;
  /** Step 4 (to-dos, analyses) and step 5 (the next checkup); none until they are wired. */
  sources?: PageSources;
  /** Step 5 (A1 user-visit): a person saw these services; the analyses decide whether one is due (deduplicated there). */
  visit?: (seen: Visited[], by: string) => AnalysisRecord[];
  /** The analysis as the page shows it, for one a visit just started. */
  view?: (a: AnalysisRecord) => AnalysisView;
}

export function mountPages(api: Hono, d: PageRouteDeps) {
  api.get("/api/services/overview", async (c) => {
    const p = await d.authenticate(c, "view");
    if (p instanceof Response) return p;
    const overview = servicesOverview(d.store, d.executor, d.sources);
    if (d.visit && !isKey(p)) {
      const latest = (id: string, m: Light, b: Light) => d.sources?.analyses?.latest(id, { machine: m, business: b }) ?? null;
      d.visit(overview.services.map((s) => ({ service: s.id, machine: s.machine.light, business: s.business.light, analysis: latest(s.id, s.machine.light, s.business.light) })), p.id);
    }
    return c.json(overview);
  });

  api.get("/api/services/:id/page", async (c) => {
    const p = await d.authenticate(c, "view");
    if (p instanceof Response) return p;
    const page = servicePage(d.store, d.executor, c.req.param("id"), d.sources);
    if (!page) return d.reject(c, 404, "service/unknown", `No standalone instance or cluster ${c.req.param("id")}.`);
    // A1 user-visit: only people's visits count, not the AI's keys.
    if (d.visit && !isKey(p)) {
      const started = d.visit([{ service: page.service.id, machine: page.machine.light, business: page.business.light, analysis: page.analysis }], p.id)[0];
      if (started && d.view) page.analysis = d.view(started);
    }
    return c.json(page);
  });

  // ?service= says which service the business was opened from; the detail is the same from every one of them (B1).
  api.get("/api/flows/:flow", async (c) => {
    const p = await d.authenticate(c, "view");
    if (p instanceof Response) return p;
    const detail = flowDetail(d.store, c.req.param("flow"));
    return detail ? c.json(detail) : d.reject(c, 404, "flow/unknown", `No business ${c.req.param("flow")}.`);
  });
}
