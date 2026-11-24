// S39 business-registration §7.5 (steps 2, 4): POST /api/registrations/<action>. add, remove, rename, unregister,
// preview (step 4: the chaining on what NiFi has now) and shared (step 4: shared modules) are here; commit and a
// business's declare-handoff wait for step 5 (publishing): they answer register/not-implemented. With `draft` (§7.9)
// add, remove, rename, declare-handoff and preview change the draft only (preview keeps its result there), nothing is
// registered. Drafts: POST /api/registrations/drafts makes one, GET /api/registrations/drafts/<id> reads it;
// GET /api/registrations/modules lists the shared modules. Anyone who can sign in to the Deployer may call it (a
// person's key, the session, the Assistant's key); the check-up's key cannot write, it only reads.

import type { Context, Hono } from "hono";
import type { Permission, Principal } from "../auth.ts";
import type { Actor, RegistrationDraft, Store } from "../store.ts";
import { moduleViews, type RegisterChain } from "./register-chain.ts";
import { RegError, Registrations } from "./registration.ts";

type Reject = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 429 | 503, code: string, message: string, details?: string[]) => Response;
export interface RegistrationRouteDeps {
  registrations: Registrations;
  chains: RegisterChain;
  store: Store;
  authenticate: (c: Context, need: Permission) => Promise<Principal | Response>;
  reject: Reject;
  actorOf: (p: Principal) => Actor;
}

/** Actions that write need a request_id (§7.5): the caller's own string, kept for retries by the MCP layer. */
const WRITES = new Set(["add", "remove", "rename", "unregister", "commit", "declare-handoff", "place-worker"]);
const LATER = new Set(["commit", "declare-handoff"]);
/** preview writes nothing (a draft's keeps its result); shared needs a request_id only with commit: true. */
const ACTIONS = new Set([...WRITES, ...LATER, "preview", "shared"]);
/** What a draft takes now; commit of a draft waits for the publishing (step 5). */
const DRAFTABLE = new Set(["add", "remove", "rename", "declare-handoff", "preview", "place-worker"]);

const draftBody = (d: RegistrationDraft) => ({ draft: d.id, createdBy: d.createdBy, name: d.name, groups: d.groups, handoffs: d.handoffs, places: d.places, preview: d.preview, createdAt: d.createdAt, updatedAt: d.updatedAt });

export function mountRegistrations(api: Hono, d: RegistrationRouteDeps) {
  // Before /:action, which would take "drafts" for an action.
  api.post("/api/registrations/drafts", async (c) => {
    const p = await d.authenticate(c, "view");
    if (p instanceof Response) return p;
    if (p.keyKind === "checkup") return d.reject(c, 403, "auth/forbidden", "The check-up's key only reads: it cannot register businesses.");
    const raw = await c.req.json().catch(() => ({}));
    const b = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    try { return c.json(draftBody(d.registrations.createDraft(d.actorOf(p), b.name))); } catch (error) {
      if (error instanceof RegError) return fail(c, error);
      throw error;
    }
  });

  api.get("/api/registrations/drafts/:id", async (c) => {
    const p = await d.authenticate(c, "view");
    if (p instanceof Response) return p;
    try { return c.json(draftBody(d.registrations.draft(c.req.param("id")))); } catch (error) {
      if (error instanceof RegError) return fail(c, error);
      throw error;
    }
  });

  api.get("/api/registrations/modules", async (c) => {
    const p = await d.authenticate(c, "view");
    if (p instanceof Response) return p;
    return c.json({ modules: moduleViews(d.store) });
  });

  /** One module with the businesses joined to it now (reads its group from NiFi). */
  api.get("/api/registrations/modules/:id", async (c) => {
    const p = await d.authenticate(c, "view");
    if (p instanceof Response) return p;
    try { return c.json(await d.chains.moduleDetail(c.req.param("id"))); } catch (error) {
      if (error instanceof RegError) return fail(c, error);
      throw error;
    }
  });

  api.post("/api/registrations/:action", async (c) => {
    const p = await d.authenticate(c, "view");
    if (p instanceof Response) return p;
    if (p.keyKind === "checkup") return d.reject(c, 403, "auth/forbidden", "The check-up's key only reads: it cannot register businesses.");
    const action = c.req.param("action");
    if (!ACTIONS.has(action)) return d.reject(c, 404, "register/unknown-action", `No action ${action}: add, remove, rename, unregister, preview, shared, place-worker, declare-handoff with a draft (commit is not there yet).`);
    const raw = await c.req.json().catch(() => null);
    const b = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null) as Record<string, unknown> | null;
    if (!b) return fail(c, new RegError("register/bad-request", "The body is a JSON object."));
    const drafted = b.draft !== undefined;
    if (drafted && b.flow !== undefined) return fail(c, new RegError("register/bad-request", "Give draft or flow, not both: a draft is changed apart from a registered business."));
    if (drafted && !DRAFTABLE.has(action) && !LATER.has(action)) return fail(c, new RegError("register/bad-request", `register ${action} takes no draft.`));
    if (LATER.has(action) && !(drafted && DRAFTABLE.has(action))) return fail(c, new RegError("register/not-implemented", `register ${action} is not there yet.`));
    const needsId = WRITES.has(action) || (action === "shared" && b.commit === true);
    if (needsId && (typeof b.request_id !== "string" || !b.request_id.trim() || b.request_id.length > 200)) return fail(c, new RegError("register/bad-request", "request_id is required: any string unique to this command."));
    const actor = d.actorOf(p);
    try {
      if (action === "preview") return c.json(await d.chains.preview(b));
      if (action === "place-worker") return c.json(d.registrations.placeWorker(drafted ? { draft: b.draft } : { flow: b.flow }, b, actor));
      if (action === "shared") {
        if (drafted) return fail(c, new RegError("register/bad-request", "register shared takes no draft: a module is registered on its own."));
        return c.json(await d.chains.shared(b, actor));
      }
      if (drafted) {
        switch (action) {
          case "add": return c.json(await d.registrations.draftAdd(b.draft, b.links, actor));
          case "remove": return c.json(d.registrations.draftRemove(b.draft, b.groups));
          case "rename": return c.json(d.registrations.draftRename(b.draft, b.name));
          default: return c.json(d.registrations.draftDeclareHandoff(b.draft, b, actor));
        }
      }
      switch (action) {
        case "add": return c.json(await d.registrations.add(b.flow, b.links, actor));
        case "remove": return c.json(d.registrations.remove(b.flow, b.groups, actor));
        case "rename": return c.json(d.registrations.rename(b.flow, b.name, actor));
        default:
          if (b.module !== undefined && b.flow === undefined) await d.chains.assertModuleFree(b.module);
          return c.json(d.registrations.unregister({ ...(b.flow !== undefined ? { flow: b.flow } : {}), ...(b.module !== undefined ? { module: b.module } : {}) }, actor));
      }
    } catch (error) {
      if (error instanceof RegError) return fail(c, error);
      throw error;
    }
  });
}

function fail(c: Context, e: RegError): Response {
  return c.json({ error: e.code, message: e.message, ...e.extra }, e.status);
}
