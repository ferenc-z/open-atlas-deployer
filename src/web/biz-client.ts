// The Businesses, Register and business-detail pages' calls over a `call(method, path, body)` function (a test can see
// which route each action takes). api.ts binds it to fetch; biz-data.ts is what the pages import.
// Routes: GET businesses and GET registrations/modules[/<id>] are the lists; the Register page works on a draft
// (POST registrations/drafts, GET/DELETE registrations/drafts/<id>, POST registrations/<action> with `draft`, business-registration.md 7.5, 7.9);
// the business page finds the drafts that change it with GET registrations/drafts?flow=.

import type { Call } from "./flow-client.ts";
import type { BusinessRow, CommitResult, HandoffInput, LinkInput, ModuleDetail, ModuleView, RegDraft } from "./biz-types.ts";

export interface BizClient {
  /** Every registered business. */
  businesses(): Promise<{ businesses: BusinessRow[] }>;
  /** The shared modules, each with its own health. */
  modules(): Promise<{ modules: ModuleView[] }>;
  /** One module with the businesses joined to it now (the server reads NiFi for this: a little slow). */
  module(id: string): Promise<ModuleDetail>;

  /** A new registration draft; with `flow`, a copy of that business whose commit applies the changes. */
  createDraft(input?: { name?: string; flow?: string }): Promise<RegDraft>;
  draft(id: string): Promise<RegDraft>;
  /** The open drafts that change one business. */
  draftsOf(flow: string): Promise<{ drafts: RegDraft[] }>;
  discardDraft(id: string): Promise<{ discarded: string }>;
  /** The fallback's calls (no AI): the AI does the same through the `register` verb. */
  addLinks(draft: string, links: LinkInput[]): Promise<unknown>;
  preview(draft: string): Promise<unknown>;
  declareHandoff(draft: string, handoff: HandoffInput): Promise<unknown>;
  placeWorker(draft: string, place: { schedule: string; worker: string; quote: string; group?: { service: string; group: string }; outside?: boolean }): Promise<unknown>;
  /** The person's own: commit a draft (a new business, or the changes to a registered one). */
  commit(draft: string, name?: string): Promise<CommitResult>;
  /** `register rename`. */
  rename(flow: string, name: string): Promise<{ flow: string; name: string }>;
  /** `register unregister`. */
  unregister(flow: string): Promise<{ removed: string; revisions: { service: string; revision: number }[] }>;
}

const enc = encodeURIComponent;

/** A write carries a request id so a repeat of the same click is one action (7.5). */
export const requestId = (): string => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `r${Date.now()}${Math.random().toString(16).slice(2)}`);

export function makeBizClient(call: Call, newId: () => string = requestId): BizClient {
  const write = <T>(action: string, body: Record<string, unknown>) => call<T>("POST", `registrations/${action}`, { ...body, request_id: newId() });
  return {
    businesses: () => call("GET", "businesses"),
    modules: () => call("GET", "registrations/modules"),
    module: (id) => call("GET", `registrations/modules/${enc(id)}`),
    createDraft: (input = {}) => call("POST", "registrations/drafts", input),
    draft: (id) => call("GET", `registrations/drafts/${enc(id)}`),
    draftsOf: (flow) => call("GET", `registrations/drafts?flow=${enc(flow)}`),
    discardDraft: (id) => call("DELETE", `registrations/drafts/${enc(id)}`),
    addLinks: (draft, links) => write("add", { draft, links }),
    preview: (draft) => call("POST", "registrations/preview", { draft }),
    declareHandoff: (draft, handoff) => write("declare-handoff", { draft, ...handoff }),
    placeWorker: (draft, place) => write("place-worker", { draft, ...place }),
    commit: (draft, name) => write("commit", { draft, ...(name ? { name } : {}) }),
    rename: (flow, name) => write("rename", { flow, name }),
    unregister: (flow) => write("unregister", { flow }),
  };
}
