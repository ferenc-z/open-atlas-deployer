// The overview and service page's wire types: GET /api/services/overview, GET /api/services/:id/page, the analysis calls and
// the to-do calls, copied from pages-rethink §10.2.2 (items 1-5, 9, 10). The enums come from ops-types.ts. When the server
// side lands these types, import them from there and delete this file (like flow-types.ts).

import type { AnalysisState, AnalysisTrigger, Anomaly, FlowStatus, Light, MachineCheck, TodoAction, TodoSource, UnknownReason } from "../server/services/ops-types.ts";

export type { AnalysisState, AnalysisTrigger, Anomaly, FlowStatus, Light, MachineCheck, TodoAction, TodoSource, UnknownReason };

// 1 GET /api/services/overview
export interface ServicesOverview {
  services: ServiceCard[];                  // worst first (the server sorts)
  lastCheckup: { at: string; trigger: AnalysisTrigger; state: AnalysisState } | null;
  running: boolean;                         // a round is running: Check now is greyed
}
export interface ServiceCard {
  id: string; kind: "standalone" | "cluster"; environment: string; label: string;
  machine: { light: Light; sentence: string };
  business: { light: Light; reason?: UnknownReason; sentence: string; flowCount: number; toConfirm: number };
  todoCount: number;
}

// 2 GET /api/services/:id/page
export interface ServicePage {
  service: { id: string; kind: "standalone" | "cluster"; environment: string; label: string; webUrl: string | null };
  machine: MachineLightView;
  business: BusinessLightView;
  analysis: AnalysisView | null;
  todos: TodoView[];
  config: { revision: number | null; lastChange: { at: string; by: string; text: string } | null; activeChange: string | null; drift: boolean };
}
export interface MachineLightView {
  light: Light; sentence: string; asOf: string;
  checks: { check: MachineCheck; light: Light; text: string; member: string | null; since: string | null }[];
  members: { key: string; label: string; state: string; connection: string | null }[];
}
export interface BusinessLightView {
  light: Light; reason?: UnknownReason; sentence: string;
  flows: FlowRow[];
  toConfirm: number;
}
export interface FlowRow { id: string; name: string; status: FlowStatus; light: Light; sentence: string; services: string[]; anomalies: Anomaly[] }
export interface AnalysisView {
  id: number; service: string; trigger: AnalysisTrigger; state: AnalysisState;
  startedAt: string; finishedAt: string | null; stale: boolean;
  summary: string | null;
  lookedAt: string[];
  error: string | null;
}
export interface TodoView {
  id: string; service: string; flow: string | null; source: TodoSource; severity: "failing" | "attention";
  title: string; detail: string; action: TodoAction | null; createdAt: string; createdBy: string;
  draft: string | null;
}
