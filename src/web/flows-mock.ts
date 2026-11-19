// SAMPLE DATA for the flow pages, for unit tests. Taken from the prototype
// (Flows.dc.html, Business.dc.html); the numbers, file names and group names are made up. It answers like the real
// client does and keeps the person's actions in memory. used by unit tests only (the pages call the real routes).

import type { FlowClient } from "./flow-client.ts";
import type { FlowAction, FlowCard, FlowDetail, FlowGraph, FlowsReview, StuckTimes } from "../server/services/ops-types.ts";

// A "name\ndescription" text becomes label + detail (the graph's second line).
const lines = (text: string) => { const [label = "", ...rest] = text.split("\n"); return rest.length ? { label, detail: rest.join(" ") } : { label }; };
const ext = (id: string, text: string) => ({ id, kind: "external" as const, service: null, ...lines(text) });
const grp = (id: string, service: string, text: string, light?: FlowGraph["nodes"][number]["light"]) => ({ id, kind: "group" as const, service, ...lines(text), ...(light ? { light } : {}) });
const ai = (basis: string, a: number, f: number): StuckTimes => ({ attentionMinutes: a, failingMinutes: f, by: "ai", basis });

const crm: FlowCard = {
  id: "flw_crm", name: "客户主数据同步", nameBy: "ai", status: "proposed",
  summary: "每天凌晨 2 点从 CRM 的 FTP 取客户文件，清洗、去重后写进 MDM 数据库。",
  services: ["n192-legacy"],
  graph: {
    services: [{ id: "n192-legacy", label: "n192-legacy" }],
    nodes: [ext("ftp", "CRM 的 FTP\n/crm/out，每天 02:00"), grp("load", "n192-legacy", "CRM_Customer_Load\n取文件 → 清洗 → 去重 → 写库"), ext("mdm", "MDM 数据库\nMDM.customer"), ext("gone", "丢弃\n自动终止，数据消失")],
    edges: [{ from: "ftp", to: "load", kind: "data" }, { from: "load", to: "mdm", kind: "data" }, { from: "load", to: "gone", kind: "drop", label: "failure" }],
  },
  entries: [{ service: "n192-legacy", component: "c1", name: "GetFTP", type: "GetFTP", text: "GetFTP（/crm/out）" }],
  exits: [{ service: "n192-legacy", component: "c2", name: "PutDatabaseRecord", type: "PutDatabaseRecord", relationship: "success", text: "PutDatabaseRecord（MDM.customer）" }],
  groups: [{ service: "n192-legacy", id: "g1", name: "CRM_Customer_Load" }],
  reason: null,
  risks: [{ text: "PutDatabaseRecord 的 failure 是自动终止：写库失败的客户数据会直接消失（图中红色虚线）。建议连到错误处理。", component: "c2" }],
  stuck: ai("每天一个大文件，通常 12 分钟处理完，最慢的一次 21 分钟。", 30, 120),
  pending: { kind: "new", text: "AI 新发现的业务，等你确认。" },
};

const receipt: FlowCard = {
  id: "flw_receipt", name: "报关单回执", nameBy: "ai", status: "proposed",
  summary: "每 5 分钟从海关接口取回执，按报关单号匹配，经 S2S 送到 c250 补齐字段，再发到 Kafka 的 customs.receipt。匹配失败的回执进重试组，重试后送回来。",
  services: ["n192-legacy", "c250-prod"],
  graph: {
    services: [{ id: "n192-legacy", label: "n192-legacy" }, { id: "c250-prod", label: "c250-prod" }],
    nodes: [ext("api", "海关回执接口\n每 5 分钟取一次"), grp("recv", "n192-legacy", "Customs_Receipt\n取回执 → 按单号匹配"), grp("retry", "n192-legacy", "Customs_Receipt_Retry\n重试 3 次后送回"), grp("pub", "c250-prod", "Customs_Publish\n补齐字段 → 发 Kafka"), ext("kafka", "Kafka\ncustoms.receipt")],
    edges: [
      { from: "api", to: "recv", kind: "data" }, { from: "recv", to: "pub", kind: "s2s" }, { from: "pub", to: "kafka", kind: "data" },
      { from: "recv", to: "retry", kind: "failure", label: "failure" }, { from: "retry", to: "recv", kind: "retry", label: "retry" },
    ],
  },
  entries: [{ service: "n192-legacy", component: "c3", name: "InvokeHTTP", type: "InvokeHTTP", text: "n192 · InvokeHTTP（海关回执接口）" }],
  exits: [{ service: "c250-prod", component: "c4", name: "PublishKafka", type: "PublishKafka", relationship: "success", text: "c250 · PublishKafka（customs.receipt）" }],
  groups: [{ service: "n192-legacy", id: "g2", name: "Customs_Receipt" }, { service: "n192-legacy", id: "g3", name: "Customs_Receipt_Retry" }, { service: "c250-prod", id: "g4", name: "Customs_Publish" }],
  reason: "为什么连成一条：n192 的 Customs_Receipt 用 S2S 发到 c250 的输入端口 Receipt_In，c250 上接这个端口的只有 Customs_Publish；两边每小时的收发数对得上。Customs_Receipt_Retry 没有自己的起点，只接这条流程的失败数据。",
  risks: [],
  stuck: ai("一条回执通常 1 分钟内走完，最慢的 5% 在 4 分钟左右。", 10, 60),
  pending: { kind: "cross-service", text: "两段跨服务合成一条，等你确认。" },
};

const tmp: FlowCard = {
  id: "flw_tmp", name: "test_tmp", nameBy: "ai", status: "ignored", summary: "30 天没有任何数据进出，名字像临时测试。不算进业务健康。",
  services: ["n192-legacy"],
  graph: { services: [{ id: "n192-legacy", label: "n192-legacy" }], nodes: [grp("t", "n192-legacy", "test_tmp")], edges: [] },
  entries: [], exits: [], groups: [{ service: "n192-legacy", id: "g5", name: "test_tmp" }], reason: null, risks: [], stuck: ai("没有流量，没有建议值。", 30, 120), pending: null,
};

const invoice: FlowCard = {
  id: "flw_invoice", name: "发票入库", nameBy: "ai", status: "confirmed",
  summary: "供应商经 HTTPS 推发票到 n112，校验、转换后经 S2S 送到 c250，存进对象存储并登记发票库。",
  services: ["n112-edge", "c250-prod"],
  graph: {
    services: [{ id: "n112-edge", label: "n112-edge" }, { id: "c250-prod", label: "c250-prod" }],
    nodes: [
      ext("sup", "供应商推送\nHTTPS /invoices"), grp("receive", "n112-edge", "Invoice_Receive\n收发票 → 校验 → 转换", "failing"), ext("gone", "丢弃\nConvertRecord 失败后自动终止"),
      grp("store", "c250-prod", "Invoice_Store\n存文件 → 登记发票库", "healthy"), ext("s3", "对象存储\ninvoices/"), ext("db", "发票库\ninvoice 表"),
    ],
    edges: [
      { from: "sup", to: "receive", kind: "data" }, { from: "receive", to: "store", kind: "s2s" }, { from: "receive", to: "gone", kind: "drop", label: "failure" },
      { from: "store", to: "s3", kind: "data" }, { from: "store", to: "db", kind: "data" },
    ],
  },
  entries: [{ service: "n112-edge", component: "c5", name: "ListenHTTP", type: "ListenHTTP", text: "n112 · ListenHTTP（/invoices，供应商推送）" }],
  exits: [
    { service: "c250-prod", component: "c6", name: "PutS3Object", type: "PutS3Object", relationship: "success", text: "c250 · PutS3Object（invoices/）" },
    { service: "c250-prod", component: "c7", name: "PutDatabaseRecord", type: "PutDatabaseRecord", relationship: "success", text: "c250 · PutDatabaseRecord（发票库）" },
  ],
  groups: [{ service: "n112-edge", id: "g6", name: "Invoice_Receive" }, { service: "c250-prod", id: "g7", name: "Invoice_Store" }],
  reason: null,
  risks: [{ text: "Invoice_Receive 里 ConvertRecord 的 failure 是自动终止：格式不对的发票会直接消失，今天的丢失就是这个原因。建议连到 Common_Errors。", component: "c8" }],
  stuck: ai("这条业务一份文件通常 2 分钟内走完，最慢的 5% 在 6 分钟左右。", 10, 60),
  pending: null,
};
invoice.stuck.by = "person";

const state = new Map<string, FlowCard>([crm, receipt, tmp, invoice].map((c) => [c.id, structuredClone(c)]));
const byService = (service: string) => [...state.values()].filter((c) => c.services.includes(service));

const delay = <T>(v: T): Promise<T> => new Promise((r) => setTimeout(() => r(structuredClone(v)), 120));

function review(service: string): FlowsReview {
  const cards = byService(service);
  const flows = cards.filter((c) => c.status !== "ignored").sort((a, b) => Number(b.status === "proposed") - Number(a.status === "proposed"));
  return {
    service,
    intro: service === "n192-legacy"
      ? "AI 看了 root 下的 4 个流程组：CRM_Customer_Load 自己是一件事；Customs_Receipt 经 S2S 接到 c250 的 Customs_Publish，两段合成一件事；Customs_Receipt_Retry 只接回执失败的数据，算进那一条；test_tmp 30 天没有流量。请看图确认数据流向对不对。"
      : `AI 看了 ${service} root 下的流程组，按下面几条业务划分。请看图确认数据流向对不对。`,
    flows, ignored: cards.filter((c) => c.status === "ignored"), shared: [],
    allConfirmed: flows.every((c) => c.status === "confirmed"),
  };
}

function detail(flow: string): FlowDetail {
  const card = state.get(flow);
  if (!card) throw Object.assign(new Error("No such flow"), { status: 404 });
  if (flow !== "flw_invoice") return { flow: card, light: "healthy", sentence: "没有异常。", problems: [], last7Days: [], findBy: [{ cue: "fileName", attribute: "filename" }], history: [{ at: "2026-11-15T09:00:00Z", by: "ai", text: "AI found this flow", verdict: "published" }] };
  return {
    flow: card, light: "failing",
    sentence: "今天 08:10 起，有 7 个发票文件在 n112 的 ConvertRecord 转换失败后被丢掉了，找不回来。c250 那一段没有异常。",
    problems: [{
      anomaly: "data-dropped", light: "failing", title: "7 个发票文件被丢掉了", service: "n112-edge", group: "Invoice_Receive", component: "c8", count: 7, since: "2026-11-19T08:10:00", latest: "2026-11-19T10:02:00",
      cause: "这 7 个文件用了新的税号格式（18 位，带字母），转换规则只认 15 位数字，所以转换失败；而 ConvertRecord 的 failure 设成了自动终止，失败的文件直接被丢弃，没有进错误处理。",
      advice: ["在 NiFi 里把 ConvertRecord 的 failure 连到 Common_Errors，以后转换失败的不会再丢。", "把转换规则改成也认新税号格式。", "请发件方重发这 7 个文件（文件名问 AI）。"],
      nifiUrl: "https://n112.example/nifi/",
    }],
    last7Days: [
      { day: "2026-11-19", anomaly: "data-dropped", light: "failing", text: "7 个文件被丢掉，见上面。" },
      { day: "2026-11-17", anomaly: "stuck", light: "attention", text: "c250 写发票库超时，140 个文件最久等了 38 分钟，之后数据库恢复，自己处理完了。" },
    ],
    findBy: [{ cue: "fileName", attribute: "filename" }],
    history: [
      { at: "2026-11-18T10:00:00", by: "ai", text: "Invoice_Store 里加了一个 UpdateAttribute（组内变化，回放通过，自动生效）", verdict: "published" },
      { at: "2026-11-15T10:00:00", by: "person", text: "You confirmed this flow and the stuck times", verdict: null },
      { at: "2026-11-15T09:00:00", by: "ai", text: "AI found this flow", verdict: "published" },
    ],
  };
}

function act(flow: string, a: FlowAction) {
  const card = state.get(flow);
  if (!card) throw Object.assign(new Error("No such flow"), { status: 404 });
  switch (a.kind) {
    case "confirm": card.status = "confirmed"; card.pending = null; break;
    case "rename": card.name = a.name; card.nameBy = "person"; break;
    case "ignore": card.status = "ignored"; break;
    case "watch": card.status = "proposed"; break;
    case "stuck":
      if (a.attentionMinutes >= a.failingMinutes) throw Object.assign(new Error("Attention must come before failing"), { status: 400 });
      card.stuck = { ...card.stuck, attentionMinutes: a.attentionMinutes, failingMinutes: a.failingMinutes, by: "person" };
      break;
    case "split": case "not-right": break;   // the real server records the feedback and starts an analysis
  }
  return { flow: card };
}

export const mockFlowClient: FlowClient = {
  review: async (service) => delay(review(service)),
  detail: async (flow) => delay(detail(flow)),
  act: async (flow, a) => delay(act(flow, a)),
};
