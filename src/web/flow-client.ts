// The flow pages' three calls (pages-rethink §10.2.2 items 6, 7, 8) over a `call(method, path, body)` function, so a test
// can see which route each action takes. api.ts binds it to fetch; flows-data.ts chooses between it and the sample data.

import type { FlowAction, FlowCard, FlowsReview, TodoView } from "../server/services/ops-types.ts";
import type { BusinessDetail } from "./biz-types.ts";

export type Call = <T>(method: string, path: string, body?: unknown) => Promise<T>;

export interface FlowClient {
  /** 6: the confirmation page of one service. */
  review(service: string): Promise<FlowsReview>;
  /** 8: one flow; `service` is the service the person came from. */
  detail(flow: string, service?: string): Promise<BusinessDetail>;
  /** 7: a person's action on a flow. */
  act(flow: string, action: FlowAction): Promise<{ flow: FlowCard; todo?: TodoView }>;
}

const enc = encodeURIComponent;

export function makeFlowClient(call: Call): FlowClient {
  return {
    review: (service) => call("GET", `services/${enc(service)}/flows`),
    detail: (flow, service) => call("GET", `flows/${enc(flow)}${service ? `?service=${enc(service)}` : ""}`),
    act: (flow, action) => call("POST", `flows/${enc(flow)}/actions`, action),
  };
}
