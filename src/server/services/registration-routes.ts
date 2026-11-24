// S39 business-registration §7.5 (steps 2, 4, 5): POST /api/registrations/<action>. preview (the chaining on what NiFi
// has now); commit, add, remove, declare-handoff, place-worker, shared with commit and unregister take effect at once
// (step 5, register-publish.ts: chained, gaps refused, gated, every touched service's model published together); rename
// changes the name only. With `draft` (§7.9) add, remove, rename, declare-handoff, place-worker and preview change the
// draft only (preview keeps its result there), and commit makes the draft a business. Drafts: POST /api/registrations/drafts makes one, GET /api/registrations/drafts/<id> reads it;
// GET /api/registrations/modules lists the shared modules. Anyone who can sign in to the Deployer may call it (a
// person's key, the session, the Assistant's key); the check-up's key cannot write, it only reads. Step 6: a draft
// may copy a registered business (drafts with flow), and its commit applies the changes; the Assistant's key changes
// drafts only and never commits or unregisters (register/person-only, 403): a person does that on the page.

import type { Context, Hono } from "hono";
import type { Permission, Principal } from "../auth.ts";
import type { Actor, RegistrationDraft, Store } from "../store.ts";
import { moduleViews, type RegisterChain } from "./register-chain.ts";
import type { RegisterPublisher } from "./register-publish.ts";
import { RegError, Registrations } from "./registration.ts";

type Reject = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 429 | 503, code: string, message: string, details?: string[]) => Response;
export interface RegistrationRouteDeps {
  registrations: Registrations;
  chains: RegisterChain;
  publisher: RegisterPublisher;
  store: Store;
  authenticate: (c: Context, need: Permission) => Promise<Principal | Response>;
  reject: Reject;
  actorOf: (p: Principal) => Actor;
}

/** Actions that write need a request_id (§7.5): the caller's own string, kept for retries by the MCP layer. */
const WRITES = new Set(["add", "remove", "rename", "unregister", "commit", "declare-handoff", "place-worker"]);
/** preview writes nothing (a draft's keeps its result); shared needs a request_id only with commit: true. */
const ACTIONS = new Set([...WRITES, "preview", "shared"]);
/** What a draft takes (commit makes it a business). */
const DRAFTABLE = new Set(["add", "remove", "rename", "declare-handoff", "preview", "place-worker", "commit"]);

/** §7.9 (step 6): the Assistant's key changes drafts only; a person commits them on the page (a draft of a business's
 *  changes too), and unregisters. shared with commit stays open to it: the owner agrees in the conversation first. */
const isAssistant = (p: Principal) => p.via === "service" && p.keyKind !== "checkup";
function personOnly(action: string, drafted: boolean): RegError | null {
  if (action === "commit" || action === "unregister") return new RegError("register/person-only", `register ${action} is done by a person on the page${action === "commit" ? " (Register / confirm the changes)" : " (Unregister on the business's page)"}: tell the owner it is ready, do not do it.`);
  if (WRITES.has(action) && !drafted) return new RegError("register/person-only", `Change a registered business through a draft: make one with action draft and flow, change the draft (${action} with draft), and the owner confirms it on the page.`);
  return null;
}

const draftBody = (d: RegistrationDraft) => ({ draft: d.id, flow: d.flow, createdBy: d.createdBy, name: d.name, groups: d.groups, handoffs: d.handoffs, places: d.places, preview: d.preview, createdAt: d.createdAt, updatedAt: d.updatedAt });

export function mountRegistrations(api: Hono, d: RegistrationRouteDeps) {
  // Before /:action, which would take "drafts" for an action.
  api.post("/api/registrations/drafts", async (c) => {
    const p = await d.authenticate(c, "view");
    if (p instanceof Response) return p;
    if (p.keyKind === "checkup") return d.reject(c, 403, "auth/forbidden", "The check-up's key only reads: it cannot register businesses.");
    const raw = await c.req.json().catch(() => ({}));
    const b = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    try { return c.json(draftBody(d.registrations.createDraft(d.actorOf(p), b.name, b.flow))); } catch (error) {
      if (error instanceof RegError) return fail(c, error);
      throw error;
    }
  });

  // S39 step 8: the open drafts that change one registered business (the assistant makes them; the business page shows them).
  api.get("/api/registrations/drafts", async (c) => {
    const p = await d.authenticate(c, "view");
    if (p instanceof Response) return p;
    const flow = c.req.query("flow");
    if (!flow) return fail(c, new RegError("register/bad-request", "Give ?flow=<business id>."));
    return c.json({ drafts: d.store.registrationDraftsOf(flow).map(draftBody) });
  });

  /** A person throws a draft away (the assistant's key does not: it only changes drafts). */
  api.delete("/api/registrations/drafts/:id", async (c) => {
    const p = await d.authenticate(c, "view");
    if (p instanceof Response) return p;
    if (isAssistant(p) || p.keyKind === "checkup") return d.reject(c, 403, "register/person-only", "A person discards a draft on the page.");
    try { d.registrations.draft(c.req.param("id")); } catch (error) {
      if (error instanceof RegError) return fail(c, error);
      throw error;
    }
    d.store.deleteRegistrationDraft(c.req.param("id"));
    return c.json({ discarded: c.req.param("id") });
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
    if (!ACTIONS.has(action)) return d.reject(c, 404, "register/unknown-action", `No action ${action}: preview, commit, add, remove, rename, declare-handoff, place-worker, shared, unregister.`);
    const raw = await c.req.json().catch(() => null);
    const b = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null) as Record<string, unknown> | null;
    if (!b) return fail(c, new RegError("register/bad-request", "The body is a JSON object."));
    const drafted = b.draft !== undefined;
    if (drafted && b.flow !== undefined) return fail(c, new RegError("register/bad-request", "Give draft or flow, not both: a draft is changed apart from a registered business."));
    if (drafted && !DRAFTABLE.has(action)) return fail(c, new RegError("register/bad-request", `register ${action} takes no draft.`));
    const refused = isAssistant(p) ? personOnly(action, drafted) : null;
    if (refused) return fail(c, refused);
    const needsId = WRITES.has(action) || (action === "shared" && b.commit === true);
    if (needsId && (typeof b.request_id !== "string" || !b.request_id.trim() || b.request_id.length > 200)) return fail(c, new RegError("register/bad-request", "request_id is required: any string unique to this command."));
    const actor = d.actorOf(p);
    try {
      if (action === "preview") return c.json(await d.chains.preview(b));
      if (action === "commit") return c.json(await d.publisher.commit(b, actor));
      if (action === "shared") {
        if (drafted) return fail(c, new RegError("register/bad-request", "register shared takes no draft: a module is registered on its own."));
        return c.json(await d.publisher.shared(b, actor));
      }
      if (drafted) {
        switch (action) {
          case "add": return c.json(await d.registrations.draftAdd(b.draft, b.links, actor));
          case "remove": return c.json(d.registrations.draftRemove(b.draft, b.groups));
          case "rename": return c.json(d.registrations.draftRename(b.draft, b.name));
          case "place-worker": return c.json(d.registrations.placeWorker({ draft: b.draft }, b, actor));
          default: return c.json(d.registrations.draftDeclareHandoff(b.draft, b, actor));
        }
      }
      // A registered business: changed, chained again and published (step 5); rename changes only its name.
      switch (action) {
        case "add": return c.json(await d.publisher.add(b, actor));
        case "remove": return c.json(await d.publisher.remove(b, actor));
        case "rename": return c.json(d.registrations.rename(b.flow, b.name, actor));
        case "declare-handoff": return c.json(await d.publisher.declareHandoff(b, actor));
        case "place-worker": return c.json(await d.publisher.placeWorker(b, actor));
        default: return c.json(await d.publisher.unregister(b, actor));
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
