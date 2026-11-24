// S39 business-registration §7.5 (step 2): POST /api/registrations/<action>. add, remove, rename and unregister are
// here; preview and commit wait for step 3 (the chaining), declare-handoff and shared for step 4: they answer
// register/not-implemented, except what a draft (§7.9) can take now: with `draft` the actions add, remove, rename and
// declare-handoff change the draft only, nothing is registered. Drafts: POST /api/registrations/drafts makes one,
// GET /api/registrations/drafts/<id> reads it. Anyone who can sign in to the Deployer may call it (a person's key, the
// session, the Assistant's key); the check-up's key cannot, it only reads.

import type { Context, Hono } from "hono";
import type { Permission, Principal } from "../auth.ts";
import type { Actor, RegistrationDraft } from "../store.ts";
import { RegError, Registrations } from "./registration.ts";

type Reject = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 429 | 503, code: string, message: string, details?: string[]) => Response;
export interface RegistrationRouteDeps {
  registrations: Registrations;
  authenticate: (c: Context, need: Permission) => Promise<Principal | Response>;
  reject: Reject;
  actorOf: (p: Principal) => Actor;
}

/** Actions that write need a request_id (§7.5): the caller's own string, kept for retries by the MCP layer. */
const WRITES = new Set(["add", "remove", "rename", "unregister", "commit", "declare-handoff", "shared"]);
const LATER = new Set(["preview", "commit", "declare-handoff", "shared"]);
const ACTIONS = new Set([...WRITES, ...LATER]);
/** What a draft takes now; preview and commit of a draft wait for the chaining (step 3). */
const DRAFTABLE = new Set(["add", "remove", "rename", "declare-handoff"]);

const draftBody = (d: RegistrationDraft) => ({ draft: d.id, createdBy: d.createdBy, name: d.name, groups: d.groups, handoffs: d.handoffs, preview: d.preview, createdAt: d.createdAt, updatedAt: d.updatedAt });

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

  api.post("/api/registrations/:action", async (c) => {
    const p = await d.authenticate(c, "view");
    if (p instanceof Response) return p;
    if (p.keyKind === "checkup") return d.reject(c, 403, "auth/forbidden", "The check-up's key only reads: it cannot register businesses.");
    const action = c.req.param("action");
    if (!ACTIONS.has(action)) return d.reject(c, 404, "register/unknown-action", `No action ${action}: add, remove, rename, unregister, declare-handoff with a draft (preview, commit and shared are not there yet).`);
    const raw = await c.req.json().catch(() => null);
    const b = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null) as Record<string, unknown> | null;
    if (!b) return fail(c, new RegError("register/bad-request", "The body is a JSON object."));
    const drafted = b.draft !== undefined;
    if (drafted && b.flow !== undefined) return fail(c, new RegError("register/bad-request", "Give draft or flow, not both: a draft is changed apart from a registered business."));
    if (drafted && !DRAFTABLE.has(action) && !LATER.has(action)) return fail(c, new RegError("register/bad-request", `register ${action} takes no draft.`));
    if (LATER.has(action) && !(drafted && DRAFTABLE.has(action))) return fail(c, new RegError("register/not-implemented", `register ${action} is not there yet.`));
    if (typeof b.request_id !== "string" || !b.request_id.trim() || b.request_id.length > 200) return fail(c, new RegError("register/bad-request", "request_id is required: any string unique to this command."));
    const actor = d.actorOf(p);
    try {
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
        default: return c.json(d.registrations.unregister({ ...(b.flow !== undefined ? { flow: b.flow } : {}), ...(b.module !== undefined ? { module: b.module } : {}) }, actor));
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
