// pages-rethink §10.2.2 #1, #2, #8 (ops step 3b): the services overview, a service's page and a business's detail.
// Read only, for every signed-in user and key with view.

import type { Context, Hono } from "hono";
import type { Permission, Principal } from "../auth.ts";
import type { ExecutorInfo } from "../handoff.ts";
import type { Store } from "../store.ts";
import { flowDetail, servicePage, servicesOverview, type PageSources } from "./page-views.ts";

type Reject = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 429 | 503, code: string, message: string, details?: string[]) => Response;
export interface PageRouteDeps {
  store: Store;
  executor: (host: string) => ExecutorInfo;
  authenticate: (c: Context, need: Permission) => Promise<Principal | Response>;
  reject: Reject;
  /** Step 4 (to-dos, analyses) and step 5 (the next checkup); none until they are wired. */
  sources?: PageSources;
}

export function mountPages(api: Hono, d: PageRouteDeps) {
  api.get("/api/services/overview", async (c) => {
    const p = await d.authenticate(c, "view");
    if (p instanceof Response) return p;
    return c.json(servicesOverview(d.store, d.executor, d.sources));
  });

  api.get("/api/services/:id/page", async (c) => {
    const p = await d.authenticate(c, "view");
    if (p instanceof Response) return p;
    const page = servicePage(d.store, d.executor, c.req.param("id"), d.sources);
    return page ? c.json(page) : d.reject(c, 404, "service/unknown", `No standalone instance or cluster ${c.req.param("id")}.`);
  });

  // ?service= says which service the business was opened from; the detail is the same from every one of them (B1).
  api.get("/api/flows/:flow", async (c) => {
    const p = await d.authenticate(c, "view");
    if (p instanceof Response) return p;
    const detail = flowDetail(d.store, c.req.param("flow"));
    return detail ? c.json(detail) : d.reject(c, 404, "flow/unknown", `No business ${c.req.param("flow")}.`);
  });
}
