// The Businesses, Register and business-detail pages' calls over a `call(method, path, body)` function (a test can see
// which route each action takes). api.ts binds it to fetch; biz-data.ts is what the pages import.
// Routes: POST registrations/<action> is 7.5; GET businesses is the list the Businesses page needs (not in 7.5). The detail is
// the existing GET flows/<id> (flow-client.ts), with the optional `registration` block (biz-types.ts).

import type { Call } from "./flow-client.ts";
import type { BusinessList, CommitResult, HandoffInput, LinkInput, Preview } from "./biz-types.ts";

export interface BizClient {
  /** Every registered business and shared module. */
  list(): Promise<BusinessList>;
  /** `register preview`: parse the links and string them together; writes nothing. */
  preview(input: { links: LinkInput[]; name?: string; flow?: string; handoffs?: HandoffInput[] }): Promise<Preview>;
  /** `register commit`: the server recomputes the preview and refuses while a gap is open. */
  commit(input: { name: string; links: LinkInput[]; handoffs?: HandoffInput[] }): Promise<CommitResult>;
  /** `register rename`. */
  rename(flow: string, name: string): Promise<{ flow: string; name: string }>;
  /** `register unregister`. */
  unregister(flow: string): Promise<{ removed: string; revisions: { service: string; revision: number }[] }>;
}

/** A write carries a request id so a repeat of the same click is one action (7.5). */
export const requestId = (): string => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `r${Date.now()}${Math.random().toString(16).slice(2)}`);

export function makeBizClient(call: Call, newId: () => string = requestId): BizClient {
  const verb = <T>(action: string, body: Record<string, unknown>, write: boolean) => call<T>("POST", `registrations/${action}`, write ? { ...body, request_id: newId() } : body);
  return {
    list: () => call("GET", "businesses"),
    preview: (input) => verb("preview", input, false),
    commit: (input) => verb("commit", input, true),
    rename: (flow, name) => verb("rename", { flow, name }, true),
    unregister: (flow) => verb("unregister", { flow }, true),
  };
}
