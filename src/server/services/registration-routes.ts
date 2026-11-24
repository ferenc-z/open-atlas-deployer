// S39 business-registration §7.5 (step 2): POST /api/registrations/<action>. add, remove, rename and unregister are
// here; preview and commit wait for step 3 (the chaining), declare-handoff and shared for step 4: they answer
// register/not-implemented. Anyone who can sign in to the Deployer may call it (a person's key, the session, the Assistant's
// key); the check-up's key cannot, it only reads.

import type { Context, Hono } from "hono";
import type { Permission, Principal } from "../auth.ts";
import type { Actor } from "../store.ts";
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

export function mountRegistrations(api: Hono, d: RegistrationRouteDeps) {
  api.post("/api/registrations/:action", async (c) => {
    const p = await d.authenticate(c, "view");
    if (p instanceof Response) return p;
    if (p.keyKind === "checkup") return d.reject(c, 403, "auth/forbidden", "The check-up's key only reads: it cannot register businesses.");
    const action = c.req.param("action");
    if (!ACTIONS.has(action)) return d.reject(c, 404, "register/unknown-action", `No action ${action}: add, remove, rename, unregister (preview, commit, declare-handoff and shared are not there yet).`);
    const raw = await c.req.json().catch(() => null);
    const b = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null) as Record<string, unknown> | null;
    if (!b) return fail(c, new RegError("register/bad-request", "The body is a JSON object."));
    if (LATER.has(action)) return fail(c, new RegError("register/not-implemented", `register ${action} is not there yet.`));
    if (typeof b.request_id !== "string" || !b.request_id.trim() || b.request_id.length > 200) return fail(c, new RegError("register/bad-request", "request_id is required: any string unique to this command."));
    const actor = d.actorOf(p);
    try {
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
