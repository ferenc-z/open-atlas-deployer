// Shared by the server and the web pages: the enums and constants of the managed-service pages redo (pages-rethink 10.2.1).
// Types and constants only; the string literals are the wire values, so neither side translates them.

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

/** 待办来源、状态、建议动作。 */
export type TodoSource = "analysis" | "chat" | "gate" | "flows";
export type TodoState = "open" | "done" | "dismissed";
export type TodoAction =
  | { kind: "config-change"; label: string; changes: ConfigChange[]; note: string }        // 人点了才由 Deployer 以本人身份建草稿（见 10.2.2 第 9 条）
  | { kind: "member-control"; label: string; member: string; action: "start" | "stop" | "restart" }
  | { kind: "set-threshold"; label: string; overrides: Record<string, number> }             // C1"个别服务单独改界线"，走现有 PUT /thresholds（admin）
  | { kind: "confirm-flows"; label: string }                                                 // 跳流程确认页
  | { kind: "open-nifi"; label: string; url: string; component?: string };                   // 改画布的事只给链接
/** 与 draft_service_config 的 changes 同形：{file,key,value} | {file,key,unset:true} | {file,xml…}（照 mcp.ts 现有 schema）。 */
export type ConfigChange = Record<string, unknown>;
