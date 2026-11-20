// SAMPLE DATA for the overview and service page, until the server routes (§10.2.2 items 1-5, 9, 10) exist. Taken from the
// prototype (Main.dc.html, Service.dc.html); the numbers, file names and group names are made up. It answers like the real
// client does and keeps the person's actions in memory. ops-data.ts switches between this and the real routes.

import { LIGHT_ORDER } from "../server/services/ops-types.ts";
import type { OpsClient } from "./ops-client.ts";
import type { FlowRow, Light, MachineLightView, ServiceCard, ServicePage, ServicesOverview, TodoView } from "../server/services/ops-types.ts";

/** Today at hh:mm in the browser's zone, as an ISO string. */
const today = (hhmm: string, daysAgo = 0): string => {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(h!, m!, 0, 0);
  return d.toISOString();
};

const light = (l: Light, sentence: string) => ({ light: l, sentence });
const flow = (id: string, name: string, l: Light, sentence: string, anomalies: FlowRow["anomalies"] = [], services: string[] = []): FlowRow => ({ id, name, status: "confirmed", light: l, sentence, services, anomalies });

const cards: ServiceCard[] = [
  { id: "c250-prod", kind: "cluster", environment: "prod", label: "NiFi 2.5.0 · cluster, 2 nodes",
    machine: light("failing", "节点 2 在 09:42 掉线：数据盘写满（98%）。"),
    business: { ...light("failing", "发票入库有 7 个文件被丢掉（丢在 n112 那一段）；订单同步有 420 个文件卡住。"), flowCount: 3, toConfirm: 0 }, todoCount: 3 },
  { id: "n112-edge", kind: "standalone", environment: "prod", label: "NiFi 1.12.1 · standalone",
    machine: light("healthy", "一切正常。"),
    business: { ...light("failing", "发票入库：今天 7 个文件在 ConvertRecord 转换失败后被丢掉了，找不回来。"), flowCount: 3, toConfirm: 0 }, todoCount: 1 },
  { id: "n200-test", kind: "standalone", environment: "uat", label: "NiFi 2.0.0 · standalone",
    machine: light("attention", "HTTPS 证书 12 天后过期（12 月 1 日）。"),
    business: { ...light("healthy", "没有异常。"), flowCount: 2, toConfirm: 0 }, todoCount: 1 },
  { id: "n192-legacy", kind: "standalone", environment: "uat", label: "NiFi 1.9.2 · standalone",
    machine: light("healthy", "一切正常。"),
    business: { ...light("unknown", "AI 找到 2 条业务流程，等你确认后开始看业务健康。"), reason: "unconfirmed", flowCount: 0, toConfirm: 2 }, todoCount: 0 },
];

type Check = MachineLightView["checks"][number];
const check = (c: Check["check"], l: Light, text: string, member: string | null = null): Check => ({ check: c, light: l, text, member, since: l === "healthy" ? null : today("09:42") });

const c250Todos = (): TodoView[] => [
  { id: "td_sample1", service: "c250-prod", flow: null, source: "analysis", severity: "failing",
    title: "清理节点 2 的内容归档，把归档保留期从 7 天改成 3 天", detail: "这是磁盘写满的直接原因。改完后归档约占数据盘 40%。",
    action: { kind: "config-change", label: "Apply the AI's change", note: "只改 nifi.properties 里的一项，两个节点都改。", changes: [{ file: "nifi.properties", key: "nifi.content.repository.archive.max.retention.period", value: "3 days" }] },
    createdAt: today("09:43"), createdBy: "ai", draft: null },
  { id: "td_sample2", service: "c250-prod", flow: null, source: "analysis", severity: "failing",
    title: "归档清理后，重启节点 2，让它重新加入集群", detail: "重启前会先过集群检查，节点 1 不受影响。节点 2 回来后，卡住的 420 个文件会接着处理。",
    action: { kind: "member-control", label: "Restart node 2", member: "oa-nifi-02", action: "restart" },
    createdAt: today("09:43"), createdBy: "ai", draft: null },
  { id: "td_sample3", service: "c250-prod", flow: "flw_orders", source: "chat", severity: "attention",
    title: "节点 2 恢复后，确认 PO-20261119-0832.csv 已经写进 Oracle", detail: "来自你和 AI 的对话。节点 2 回来后 AI 会再查一次，查到了就自己清掉这一项。",
    action: null, createdAt: today("10:05"), createdBy: "ferenc", draft: null },
];

const c250Page = (): ServicePage => ({
  service: { id: "c250-prod", kind: "cluster", environment: "prod", label: "NiFi 2.5.0 · cluster, 2 nodes · oa-nifi-01, oa-nifi-02", webUrl: "https://oa-nifi-01:8443/nifi" },
  machine: {
    light: "failing", sentence: "节点 2 在 09:42 掉线，数据盘写满了。节点 1 还在，正独自处理全部数据。", asOf: today("10:14"),
    checks: [
      check("process", "failing", "1 of 2 online · node 2 down", "oa-nifi-02"),
      check("disk", "failing", "Node 2 data disk 98%", "oa-nifi-02"),
      check("heap", "healthy", "Node 1 heap 62%"),
      check("collection", "healthy", "Collected 10:14"),
      check("coordinator", "healthy", "Primary and coordinator present"),
      check("certificate", "healthy", "210 days left"),
    ],
    members: [{ key: "n1", label: "oa-nifi-01", state: "running", connection: "connected" }, { key: "n2", label: "oa-nifi-02", state: "stopped", connection: "disconnected" }],
  },
  business: {
    light: "failing", sentence: "发票入库丢了文件，订单同步有文件卡住。", toConfirm: 0,
    flows: [
      flow("flw_invoice", "发票入库", "failing", "今天 7 个文件在 n112 的 ConvertRecord 转换失败后被丢掉了，找不回来。", ["data-dropped"], ["n112-edge", "c250-prod"]),
      flow("flw_orders", "订单同步", "attention", "420 个文件卡在「写进 Oracle」前面，最早的已经等了 34 分钟。", ["stuck"]),
      flow("flw_stock", "库存回传", "healthy", "没有异常。"),
    ],
  },
  analysis: {
    id: 41, service: "c250-prod", trigger: "machine-red", state: "done", startedAt: today("09:43"), finishedAt: today("09:44"), stale: false,
    summary: "节点 2 的数据盘被 NiFi 的内容归档写满了：归档默认留 7 天，这三天订单多，3 天里从 61% 涨到 98%，09:41 写不进去，节点 2 随即掉线。原本分给节点 2 的订单文件停在它的队列里，所以订单同步有 420 个卡住了；数据没有丢，节点 2 恢复后会接着处理。\n\n另外，发票入库丢了 7 个文件，丢在 n112 那一段，和这次故障无关，见那条业务。",
    lookedAt: ["节点 2 数据盘：3 天从 61% 涨到 98%，其中内容归档占 71%", "节点 2 日志 09:41：No space left on device，随后进程退出", "订单同步：420 个文件停在「写进 Oracle」前面，最早的 09:40 进队"],
    error: null,
  },
  todos: c250Todos(),
  config: { revision: 14, lastChange: { at: today("11:20", 2), by: "ferenc", text: "heap 4g → 6g" }, activeChange: null, drift: false },
});

/** The other services get a short page built from their card. */
function plainPage(card: ServiceCard): ServicePage {
  const ok = (c: Check["check"], text: string) => check(c, "healthy", text);
  return {
    service: { id: card.id, kind: card.kind, environment: card.environment, label: card.label, webUrl: null },
    machine: {
      light: card.machine.light, sentence: card.machine.sentence, asOf: today("10:14"),
      checks: [ok("process", "Running"), ok("disk", "Data disk 41%"), ok("heap", "Heap 55%"), ok("collection", "Collected 10:14"), ok("coordinator", "Not a cluster"), card.machine.light === "attention" ? check("certificate", "attention", "12 days left") : ok("certificate", "210 days left")],
      members: [{ key: "m1", label: card.id, state: "running", connection: null }],
    },
    business: {
      light: card.business.light, ...(card.business.reason ? { reason: card.business.reason } : {}), sentence: card.business.sentence, toConfirm: card.business.toConfirm,
      flows: card.business.flowCount ? [flow(`flw_${card.id}_1`, "示例业务", card.business.light, card.business.sentence, card.business.light === "failing" ? ["data-dropped"] : [])] : [],
    },
    analysis: null,
    todos: [],
    config: { revision: 3, lastChange: null, activeChange: null, drift: false },
  };
}

/** Worst first (the worse of the two lights), then by id: what the server does for GET /api/services/overview. */
export function sortCards(list: ServiceCard[]): ServiceCard[] {
  const worst = (c: ServiceCard) => Math.min(LIGHT_ORDER[c.machine.light], LIGHT_ORDER[c.business.light]);
  return [...list].sort((a, b) => worst(a) - worst(b) || a.id.localeCompare(b.id));
}

/** The mock keeps what the person did in memory: the c250 page, the running analysis, the check-up round. */
export function makeMockOpsClient(): OpsClient {
  const pages = new Map<string, ServicePage>([["c250-prod", c250Page()]]);
  const pageOf = (id: string): ServicePage => {
    let p = pages.get(id);
    if (!p) {
      const card = cards.find((c) => c.id === id);
      if (!card) throw new Error(`No service ${id}.`);
      p = plainPage(card);
      pages.set(id, p);
    }
    return p;
  };
  let lastCheckup: ServicesOverview["lastCheckup"] = { at: today("10:00"), trigger: "schedule", state: "done" };
  let roundLeft = 0;       // overview calls until the round ends
  let analysisLeft = 0;    // analysis calls until it ends
  let nextAnalysis = 100;

  return {
    async overview() {
      if (roundLeft > 0 && --roundLeft === 0) lastCheckup = { at: new Date().toISOString(), trigger: "check-now", state: "done" };
      const services = cards.map((c) => ({ ...c, todoCount: pages.get(c.id)?.todos.length ?? c.todoCount }));
      return { services: sortCards(services), lastCheckup, running: roundLeft > 0 };
    },
    async page(service) { return structuredClone(pageOf(service)); },
    async checkService(service) {
      const p = pageOf(service);
      if (p.analysis?.state === "running") throw new Error("An analysis of this service is already running.");
      analysisLeft = 2;
      p.analysis = { id: nextAnalysis++, service, trigger: "check-now", state: "running", startedAt: new Date().toISOString(), finishedAt: null, stale: false, summary: null, lookedAt: [], error: null };
      return structuredClone(p.analysis);
    },
    async checkAll() {
      roundLeft = 2;
      lastCheckup = { at: new Date().toISOString(), trigger: "check-now", state: "running" };
      return { run: "run_sample", services: cards.map((c) => c.id) };
    },
    async analysis(id) {
      const p = [...pages.values()].find((x) => x.analysis?.id === id);
      if (!p?.analysis) throw new Error(`No analysis ${id}.`);
      if (p.analysis.state === "running" && --analysisLeft <= 0) p.analysis = { ...p.analysis, state: "done", finishedAt: new Date().toISOString(), summary: "重新看过了：和上次一样，没有新的变化。", lookedAt: ["节点 2 数据盘仍是 98%"] };
      return structuredClone(p.analysis);
    },
    async draftTodo(todo) {
      const t = [...pages.values()].flatMap((p) => p.todos).find((x) => x.id === todo);
      if (!t) throw new Error(`No to-do ${todo}.`);
      if (t.action?.kind !== "config-change") throw new Error("This to-do has no configuration change.");
      t.draft = t.draft ?? "draft-sample-1";
      return { draft: t.draft, service: t.service };
    },
    async todoState(todo) {
      for (const p of pages.values()) {
        const i = p.todos.findIndex((x) => x.id === todo);
        if (i >= 0) return structuredClone(p.todos.splice(i, 1)[0]!);
      }
      throw new Error(`No to-do ${todo}.`);
    },
  };
}

export const mockOpsClient = makeMockOpsClient();
