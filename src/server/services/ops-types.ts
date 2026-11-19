// Shared by the server and the web pages: the enums, constants and HTTP view types of the managed-service pages redo
// (pages-rethink 10.2.1, 10.2.2, 10.3). Types and constants only; the string literals are the wire values, so neither
// side translates them. The server builds these (page-views.ts, flow-views.ts, business.ts, todos.ts, rules.ts), the web imports them.

import type { Cue } from "./trace/model.ts";

/** 灯的四种状态（A3、原型"状态四种"）。机器灯、业务灯、单条业务、单项检查都用它。 */
export type Light = "failing" | "attention" | "healthy" | "unknown";
export const LIGHT_ORDER: Record<Light, number> = { failing: 0, attention: 1, unknown: 2, healthy: 3 }; // 排序：最差在前

/** 机器灯的六项检查（C1）。 */
export type MachineCheck = "process" | "disk" | "heap" | "certificate" | "coordinator" | "collection";
// process: 单机进程不在 / 集群任一节点掉线或断开 → failing
// disk: 三个仓库所在盘 ≥85% attention、≥95% failing
// heap: 持续 10 分钟 ≥85% attention；日志 OutOfMemoryError → failing
// certificate: 30 天内 attention；7 天内或已过期 failing；读不到证书 → unknown
// coordinator: 集群无主节点或协调节点 → failing（单机恒 healthy）
// collection: 采集断超过 5 分钟 → unknown（机器灯整体 unknown，除非别的项已 failing）

/** 业务异常（B3）。灯：handover-lost、data-dropped → failing；processing-failed、invalid-data、processor-error → attention；
 *  stuck 按该业务的两个卡住时间；e2e-failed 见待定 P3。 */
export type Anomaly = "processing-failed" | "invalid-data" | "stuck" | "handover-lost" | "processor-error" | "data-dropped" | "e2e-failed";

/** 业务灯不是 healthy/failing/attention 时说明为什么（只在 unknown 时有值）。 */
export type UnknownReason = "unconfirmed" | "gate-rejected" | "no-evidence" | "collection";

/** 业务确认状态（A4、A8）。gone：画布上已没有，业务不删，等人确认。 */
export type FlowStatus = "proposed" | "confirmed" | "ignored" | "gone";

/** publish_model 闸门结论（C3）。 */
export type GateVerdict = "published" | "needs-confirmation" | "rejected";

/** 单条追踪结论（沿用 trace/engine.ts 的 VerdictKind，加 dropped）。 */
export type TraceVerdict = "completed" | "failed" | "dropped" | "stuck" | "handover-lost" | "insufficient" | "in-progress";

/** AI 分析的触发原因（A1）。flows-feedback：人在流程确认页点了 These are two flows / Not right。 */
export type AnalysisTrigger = "schedule" | "machine-red" | "user-visit" | "check-now" | "flows-feedback";
export type AnalysisState = "running" | "done" | "failed";

/** PUT /api/services/:id/thresholds 认的名字（3a）；set-threshold.overrides 的键只能是这些。 */
export const THRESHOLD_KEYS = ["collectionMinutes", "repoDiskWarnPct", "repoDiskCritPct", "heapPct", "heapMinutes", "oomMinutes", "zkErrors", "zkMinutes", "certWarnDays", "certCritDays"] as const;

/** 待办来源、状态、建议动作。 */
export type TodoSource = "analysis" | "chat" | "gate" | "flows";
export type TodoState = "open" | "done" | "dismissed";
export type TodoAction =
  | { kind: "config-change"; label: string; changes: ConfigChange[]; note: string }        // 人点了才由 Deployer 以本人身份建草稿（见 10.2.2 第 9 条）
  | { kind: "member-control"; label: string; member: string; action: "start" | "stop" | "restart" }
  | { kind: "set-threshold"; label: string; overrides: Record<string, number> }             // C1"个别服务单独改界线"，走现有 PUT /thresholds（admin）
  | { kind: "confirm-flows"; label: string }                                                 // 跳流程确认页
  | { kind: "open-nifi"; label: string; url: string; component?: string };                   // 改画布的事只给链接
/** 与 draft_service_config 的 changes 同形：{file,key,value} | {file,key,unset:true} | {file,xml…}（照 mcp.ts 现有 schema）；
 *  current：现值（AI 写进去的，弹窗 "Now" 列，没有就不显示）。 */
export type ConfigChange = Record<string, unknown> & { current?: string };

// ---- HTTP views (§10.2.2) ----

// 1 GET /api/services/overview
export interface ServicesOverview {
  services: ServiceCard[];                  // worst first (the server sorts)
  lastCheckup: { at: string; trigger: AnalysisTrigger; state: AnalysisState } | null;
  running: boolean;                         // a round is running: Check now is greyed
}
export interface ServiceCard {
  id: string; kind: "standalone" | "cluster"; environment: string;
  /** §10.3: the whole subtitle ("NiFi 2.5.0 · cluster, 2 nodes"); the name is id. */
  label: string;
  machine: { light: Light; sentence: string };
  business: { light: Light; reason?: UnknownReason; sentence: string; flowCount: number; toConfirm: number; confirmedAt?: string };
  todoCount: number;
  nextCheckAt?: string; aiHasPlan?: boolean;
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
export interface MachineCheckRow { check: MachineCheck; light: Light; text: string; member: string | null; since: string | null }
export interface MachineLightView {
  light: Light; sentence: string; asOf: string;
  checks: MachineCheckRow[];
  members: { key: string; label: string; state: string; connection: string | null }[];
}
export interface FlowRow { id: string; name: string; status: FlowStatus; light: Light; sentence: string; services: string[]; anomalies: Anomaly[] }
export interface BusinessLightView {
  light: Light; reason?: UnknownReason; sentence: string;
  flows: FlowRow[]; toConfirm: number;
  /** §10.3: when a person last confirmed one of them (the business card's "you confirmed them on …"). */
  confirmedAt?: string;
}
/** The newest analysis. */
export interface AnalysisView {
  id: number; service: string; trigger: AnalysisTrigger; state: AnalysisState;
  startedAt: string; finishedAt: string | null; stale: boolean; summary: string | null; lookedAt: string[]; error: string | null;
}
/** A to-do as the pages, describe and the flow actions show it. */
export interface TodoView {
  id: string; service: string; flow: string | null; source: TodoSource; severity: "failing" | "attention";
  title: string; detail: string; action: TodoAction | null; createdAt: string; createdBy: string; draft: string | null;
}
/** The two lights now, to tell whether an analysis is out of date. */
export interface Lights { machine: Light; business: Light }

// 6 GET /api/services/:id/flows
export interface FlowsReview {
  service: string; intro: string;            // the "by root group" explanation
  flows: FlowCard[];                         // proposed first
  ignored: FlowCard[];                       // "AI thinks you can ignore" (Watch it anyway)
  shared: { service: string; group: string; name: string }[];
  allConfirmed: boolean;
}
export interface Endpoint2 { service: string; component: string; name: string; type: string; relationship?: string; text: string }
export interface StuckTimes { attentionMinutes: number; failingMinutes: number; by: "ai" | "person"; basis: string }
export interface FlowGraph {
  services: { id: string; label: string }[];
  /** detail: the node's second line (§10.3), e.g. "Dropped · 7 个". */
  nodes: { id: string; kind: "group" | "external"; service: string | null; label: string; detail?: string; light?: Light }[];
  edges: { from: string; to: string; kind: "data" | "s2s" | "failure" | "retry" | "drop"; label?: string }[];
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

// 7 POST /api/flows/:flow/actions
export type FlowAction =
  | { kind: "confirm" }
  | { kind: "rename"; name: string }
  | { kind: "split"; note?: string }
  | { kind: "not-right"; note: string }
  | { kind: "ignore" } | { kind: "watch" }
  | { kind: "stuck"; attentionMinutes: number; failingMinutes: number };

// 8 GET /api/flows/:flow?service=
export interface FlowProblem {
  anomaly: Anomaly; light: Light; title: string; service: string; group: string; component: string | null;
  count: number; since: string; latest: string; cause: string | null; advice: string[]; nifiUrl: string | null;
}
export interface FlowDetail {
  flow: FlowCard;
  light: Light; reason?: UnknownReason; sentence: string;
  problems: FlowProblem[];
  last7Days: { day: string; anomaly: Anomaly; light: Light; text: string }[];
  findBy: { cue: Cue; attribute: string }[];
  history: { at: string; by: "ai" | "person"; text: string; verdict: GateVerdict | null }[];
}
