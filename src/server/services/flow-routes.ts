// pages-rethink §10.2.2 #6, #7 (ops step 2): the flows page and a person's actions on a business. A person's name is
// never changed by the AI afterwards (A8); "These are two flows" and "Not right" are kept as feedback (the analysis
// they trigger is step 5's).

import type { Context, Hono } from "hono";
import type { Permission, Principal } from "../auth.ts";
import type { Actor, FlowRecord, Store } from "../store.ts";
import { confirmFlow, ModelError, type ModelDeps } from "./flowmodel.ts";
import { flowCard, flowsReview } from "./flow-views.ts";
import { STUCK_MINUTES_MAX } from "./trace/model.ts";

type Reject = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 429 | 503, code: string, message: string, details?: string[]) => Response;
export interface FlowRouteDeps {
  store: Store;
  model: ModelDeps;
  authenticate: (c: Context, need: Permission) => Promise<Principal | Response>;
  reject: Reject;
  registered: (id: string) => unknown;
  actorOf: (p: Principal) => Actor;
  /** Step 5: split and not-right start a flows-feedback analysis of the services the business runs in. */
  feedback?: (flow: FlowRecord, services: string[], kind: "split" | "not-right", note: string | null, by: string) => unknown;
}

export type FlowAction =
  | { kind: "confirm" } | { kind: "rename"; name: string } | { kind: "split"; note?: string } | { kind: "not-right"; note: string }
  | { kind: "ignore" } | { kind: "watch" } | { kind: "stuck"; attentionMinutes: number; failingMinutes: number };

export function parseFlowAction(body: unknown): FlowAction | { error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, any>;
  const note = (v: unknown, need: boolean) => (typeof v === "string" && v.trim() && v.length <= 2000 ? v.trim() : need ? null : undefined);
  switch (b.kind) {
    case "confirm": case "ignore": case "watch": return { kind: b.kind };
    case "rename": return typeof b.name === "string" && b.name.trim() && b.name.length <= 200 ? { kind: "rename", name: b.name.trim() } : { error: "name is 1 to 200 characters." };
    case "split": { const n = note(b.note, false); return n === null ? { error: "note is at most 2000 characters." } : { kind: "split", ...(n ? { note: n } : {}) }; }
    case "not-right": { const n = note(b.note, true); return n ? { kind: "not-right", note: n } : { error: "note says what is not right (at most 2000 characters)." }; }
    case "stuck": {
      const a = b.attentionMinutes, f = b.failingMinutes;
      const ok = (v: unknown) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= STUCK_MINUTES_MAX;
      return ok(a) && ok(f) && a < f ? { kind: "stuck", attentionMinutes: a, failingMinutes: f } : { error: "attentionMinutes < failingMinutes, whole minutes from 1 to 30 days." };
    }
    default: return { error: "kind is confirm, rename, split, not-right, ignore, watch or stuck." };
  }
}

/** Applies a person's action (all but confirm here; confirm goes through the gate, flowmodel.confirmFlow). */
export function applyFlowAction(store: Store, f: FlowRecord, a: Exclude<FlowAction, { kind: "confirm" }>, actor: Actor): FlowRecord {
  const service = store.flowSegments(f.id)[0]?.service ?? "-";
  const change = (kind: Parameters<Store["addFlowChange"]>[0]["kind"], text: string) => store.addFlowChange({ flow: f.id, service, by: actor.id, kind, text, revision: null, verdict: null });
  let next = f;
  store.flowTransaction(() => {
    if (a.kind === "rename") { next = { ...f, name: a.name, nameBy: "person" }; change("renamed", `改名为"${a.name}"`); }
    if (a.kind === "split") { change("split-asked", `人说这其实是两条业务${a.note ? `：${a.note}` : ""}`); }
    if (a.kind === "not-right") { change("not-right", `人说不对：${a.note}`); }
    if (a.kind === "ignore") { next = { ...f, status: "ignored" }; change("ignored", "不用管"); }
    if (a.kind === "watch") { next = { ...f, status: "confirmed", confirmedAt: new Date().toISOString(), confirmedBy: actor.id }; change("watched", "还是要盯着"); }
    if (a.kind === "stuck") {
      next = { ...f, stuck: { attentionS: a.attentionMinutes * 60, failingS: a.failingMinutes * 60, by: "person", basis: "人设的值" } };
      change("stuck", `卡住时间改为超过 ${a.attentionMinutes} 分钟提醒、超过 ${a.failingMinutes} 分钟算出故障`);
    }
    if (next !== f) store.putFlow(next);
    store.auditFlow(actor, f.id, a.kind);
  });
  return store.flow(f.id) ?? next;
}

export function mountFlows(api: Hono, d: FlowRouteDeps) {
  api.get("/api/services/:id/flows", async (c) => {
    const p = await d.authenticate(c, "view");
    if (p instanceof Response) return p;
    const id = c.req.param("id");
    if (!d.registered(id)) return d.reject(c, 404, "service/unknown", `No standalone instance or cluster ${id}.`);
    return c.json(flowsReview(d.store, id));
  });

  api.post("/api/flows/:flow/actions", async (c) => {
    const p = await d.authenticate(c, "admin");
    if (p instanceof Response) return p;
    const f = d.store.flow(c.req.param("flow"));
    if (!f) return d.reject(c, 404, "flow/unknown", `No business ${c.req.param("flow")}.`);
    const a = parseFlowAction(await c.req.json().catch(() => null));
    if ("error" in a) return d.reject(c, 400, "flow/action", a.error);
    const actor = d.actorOf(p);
    if (a.kind === "confirm") {
      try {
        const { result, removed } = await confirmFlow(d.model, f.id, actor);
        if (result?.verdict === "rejected") return d.reject(c, 409, "flow/gate-rejected", "The change cannot take effect: the model fails the replay check now.", result.reasons);
        if (removed) return c.json({ flow: null, removed: true });
      } catch (error) {
        if (error instanceof ModelError) return d.reject(c, error.status, error.code, error.message, error.details);
        throw error;
      }
      return c.json({ flow: flowCard(d.store, d.store.flow(f.id)!) });
    }
    const next = applyFlowAction(d.store, f, a, actor);
    if (d.feedback && (a.kind === "split" || a.kind === "not-right")) {
      const services = [...new Set(d.store.flowSegments(f.id).map((s) => s.service))].filter((s) => d.registered(s));
      if (services.length) d.feedback(next, services, a.kind, a.note ?? null, actor.id);
    }
    return c.json({ flow: flowCard(d.store, next) });
  });
}
