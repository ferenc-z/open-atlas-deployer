// The flow pages' wire types: GET /api/services/:id/flows, POST /api/flows/:flow/actions and GET /api/flows/:flow, copied
// from pages-rethink §10.2.2 (6, 7, 8). The enums come from ops-types.ts. When the server side lands these types, import
// them from there and delete this file.

import type { Anomaly, FlowStatus, GateVerdict, Light, UnknownReason } from "../server/services/ops-types.ts";

export type { Anomaly, FlowStatus, GateVerdict, Light, UnknownReason };

// 6 GET /api/services/:id/flows
export interface FlowsReview {
  service: string; intro: string;            // AI writes the "by root group" explanation
  flows: FlowCard[];                         // proposed first
  ignored: FlowCard[];                       // "AI thinks you can ignore" (Watch it anyway)
  shared: { service: string; group: string; name: string }[];
  allConfirmed: boolean;
}
export interface FlowCard {
  id: string; name: string; nameBy: "ai" | "person"; status: FlowStatus; summary: string;
  services: string[]; graph: FlowGraph;
  entries: Endpoint2[]; exits: Endpoint2[];
  groups: { service: string; id: string; name: string }[];
  reason: string | null;
  risks: { text: string; component: string | null }[];
  stuck: StuckTimes;
  pending: { kind: "new" | "gone" | "merge" | "split" | "cross-service"; text: string } | null;
}
export interface Endpoint2 { service: string; component: string; name: string; type: string; relationship?: string; text: string }
export interface StuckTimes { attentionMinutes: number; failingMinutes: number; by: "ai" | "person"; basis: string }
export interface FlowGraph {
  services: { id: string; label: string }[];
  nodes: { id: string; kind: "group" | "external"; service: string | null; label: string; light?: Light }[];
  edges: { from: string; to: string; kind: "data" | "s2s" | "failure" | "retry" | "drop"; label?: string }[];
}

// 7 POST /api/flows/:flow/actions
export type FlowAction =
  | { kind: "confirm" }
  | { kind: "rename"; name: string }
  | { kind: "split"; note?: string }
  | { kind: "not-right"; note: string }
  | { kind: "ignore" } | { kind: "watch" }
  | { kind: "stuck"; attentionMinutes: number; failingMinutes: number };

/** A to-do as the flow actions return it (TodoView, pages-rethink 10.2.2 item 2); 6b only passes it along. */
export interface TodoView {
  id: string; service: string; flow: string | null; source: "analysis" | "chat" | "gate" | "flows"; severity: "failing" | "attention";
  title: string; detail: string; action: unknown; createdAt: string; createdBy: string; draft: string | null;
}

// 8 GET /api/flows/:flow?service=
export interface FlowProblem {
  anomaly: Anomaly; light: Light; service: string; group: string; component: string | null;
  count: number; since: string; latest: string; cause: string | null; advice: string[]; nifiUrl: string | null;
}
export interface FlowDetail {
  flow: FlowCard;
  light: Light; reason?: UnknownReason; sentence: string;
  problems: FlowProblem[];
  last7Days: { day: string; anomaly: Anomaly; text: string }[];
  findBy: { cue: "fileName" | "emailFrom" | "emailSubject"; attribute: string }[];
  history: { at: string; by: "ai" | "person"; text: string; verdict: GateVerdict | null }[];
}
