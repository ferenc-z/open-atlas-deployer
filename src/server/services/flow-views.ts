// pages-rethink §10.2.2 #6 and #7 (ops step 2): the flows page (FlowsReview) and a business's card (FlowCard), with the
// flow graph (FlowGraph, B5) made from the model: services as areas, groups as boxes, the world outside NiFi as
// external nodes, S2S / failure / retry / drop edges (§10.3: a drop goes to an external node, edge kind drop; a node's
// second line is `detail`). Step 3 adds the lights and the drops (FlowDetail #8) through GraphExtras.

import type { FlowRecord, Store } from "../store.ts";
import { DEFAULT_STUCK, pendingView } from "./flowmodel.ts";
import type { Endpoint2, FlowCard, FlowGraph, FlowsReview, FlowStatus, Light, StuckTimes } from "./ops-types.ts";
import { skeletonOf, type Skeleton } from "./skeleton.ts";
import { links } from "./trace/channels.ts";
import { toTraceModel, WHOLE, type Endpoint, type ModelV2, type Segment } from "./trace/model.ts";

/** What step 3 adds to the graph: node lights, and drops outside an exit (B3 data-dropped). */
export interface GraphExtras {
  lights?: Map<string, Light>;
  drops?: { service: string; segment: string; count: number; relationship?: string | null }[];
}

const FAILURE = /error|fail|exception|retry|错误|异常|失败/i;
export const DEFAULT_INTRO = "按 root 下的流程组识别业务：一般一个组就是一件事；输出只接到另一个组的合成一条，互不相连的几片分开，几条业务共用的环节单列，7 天没有流量的放在可忽略里。";

interface Member { service: string; seq: number; s: Segment }

function members(store: Store, flow: string, models: Map<string, ModelV2 | null>): Member[] {
  const model = (svc: string) => {
    if (!models.has(svc)) models.set(svc, store.flowModel(svc)?.model ?? null);
    return models.get(svc)!;
  };
  return store.flowSegments(flow).map((r) => ({ service: r.service, seq: r.seq, s: model(r.service)?.segments.find((x) => x.id === r.segment) })).filter((m): m is Member => Boolean(m.s));
}

const nodeId = (service: string, segment: string) => `${service}/${segment}`;

function endpointText(side: "entry" | "exit", e: Endpoint): string {
  const c = e.channel;
  if (c.type === "s2s") return side === "entry" ? `经 S2S 端口 ${c.port} 收到` : `经 S2S 送到 ${c.service} 的端口 ${c.port}`;
  if (c.type === "mq") return side === "entry" ? `从 MQ ${c.exchange} / ${c.routingKey} 收到` : `发到 MQ ${c.exchange} / ${c.routingKey}`;
  return side === "entry" ? `从 ${c.system} 进来` : `送到 ${c.system}`;
}

/** The units of the skeleton a segment sits on (graph edges come from the skeleton's links and S2S pairs). */
function unitIds(sk: Skeleton, service: string, s: Segment): Set<string> {
  const all = [...sk.flows.flatMap((f) => f.segments), ...sk.shared].filter((u) => u.service === service && u.group.id === s.group.id);
  return new Set((s.slice === WHOLE ? all : all.filter((u) => u.fragment === s.slice || u.fragment === null)).map((u) => u.id));
}

export function flowGraph(store: Store, flow: string, extras: GraphExtras = {}, ctx: { skeleton?: Skeleton; models?: Map<string, ModelV2 | null> } = {}): FlowGraph {
  const models = ctx.models ?? new Map<string, ModelV2 | null>();
  const sk = ctx.skeleton ?? skeletonOf(store, new Date());
  const ms = members(store, flow, models);
  const g: FlowGraph = { services: [], nodes: [], edges: [] };
  const edge = (e: FlowGraph["edges"][number]) => { if (!g.edges.some((x) => x.from === e.from && x.to === e.to && x.kind === e.kind)) g.edges.push(e); };
  for (const svc of [...new Set(ms.map((m) => m.service))]) g.services.push({ id: svc, label: svc });
  const light = (id: string) => extras.lights?.get(id);
  for (const m of ms) {
    const id = nodeId(m.service, m.s.id);
    const steps = m.s.steps.map((x) => x.name);
    g.nodes.push({ id, kind: "group", service: m.service, label: m.s.group.name || m.s.id, ...(steps.length > 1 ? { detail: steps.slice(0, 3).join(" → ") + (steps.length > 3 ? " …" : "") } : {}), ...(light(id) ? { light: light(id)! } : {}) });
  }
  const units = new Map(ms.map((m) => [nodeId(m.service, m.s.id), unitIds(sk, m.service, m.s)]));
  const all = [...new Set(ms.map((m) => m.service))].map((svc) => models.get(svc)).filter((m): m is ModelV2 => Boolean(m));
  const ch = links(all.map(toTraceModel));
  // Between the business's segments: root-level links (data; back to an earlier one: retry), S2S pairs, channels.
  for (const a of ms) for (const b of ms) {
    if (a === b) continue;
    const ia = nodeId(a.service, a.s.id), ib = nodeId(b.service, b.s.id);
    const ua = units.get(ia)!, ub = units.get(ib)!;
    const e = sk.edges.find((x) => ua.has(x.from) && ub.has(x.to));
    const c = ch.find((l) => l.from.service === a.service && l.from.business === a.s.id && l.to.service === b.service && l.to.business === b.s.id);
    if (!e && !c) continue;
    const s2s = e?.kind === "s2s" || c?.channel.startsWith("s2s:");
    const port = c?.channel.startsWith("s2s:") ? c.channel.split("/").slice(1).join("/") : undefined;
    edge({ from: ia, to: ib, kind: s2s ? "s2s" : b.seq < a.seq ? "retry" : "data", ...(port ? { label: port } : c?.channel.startsWith("mq:") ? { label: c.channel.slice(3) } : {}) });
  }
  // Shared steps the business feeds (an error handling group: failure).
  for (const m of ms) {
    const ua = units.get(nodeId(m.service, m.s.id))!;
    for (const sh of sk.shared.filter((x) => x.service === m.service && sk.edges.some((e) => ua.has(e.from) && e.to === x.id))) {
      const id = `${m.service}/shared:${sh.group.id}`;
      if (!g.nodes.some((n) => n.id === id)) g.nodes.push({ id, kind: "group", service: m.service, label: sh.group.name, detail: "公共环节" });
      edge({ from: nodeId(m.service, m.s.id), to: id, kind: FAILURE.test(sh.group.name) ? "failure" : "data" });
    }
  }
  // The outside: entries and exits not joined to another segment of the business.
  const joinedIn = (m: Member, e: Endpoint) => ch.some((l) => l.to.service === m.service && l.to.business === m.s.id && l.to.endpoint === e.id && ms.some((x) => x.service === l.from.service && x.s.id === l.from.business));
  const joinedOut = (m: Member, e: Endpoint) => ch.some((l) => l.from.service === m.service && l.from.business === m.s.id && l.from.endpoint === e.id && ms.some((x) => x.service === l.to.service && x.s.id === l.to.business));
  const fedBySegment = (m: Member) => g.edges.some((e) => e.to === nodeId(m.service, m.s.id) && e.kind !== "retry");
  for (const m of ms) {
    const id = nodeId(m.service, m.s.id);
    for (const e of m.s.entries) {
      if (joinedIn(m, e) || (e.channel.type !== "external" && fedBySegment(m)) || (e.channel.type === "external" && fedBySegment(m) && /待 AI/.test(e.channel.system ?? ""))) continue;
      const ext = `ext:${id}:in:${e.id}`;
      g.nodes.push({ id: ext, kind: "external", service: null, label: e.channel.type === "external" ? e.channel.system! : e.channel.type === "mq" ? `MQ ${e.channel.exchange}` : `S2S ${e.channel.port}`, detail: e.channel.type === "mq" ? e.channel.routingKey! : e.channel.type });
      edge({ from: ext, to: id, kind: e.channel.type === "s2s" ? "s2s" : "data" });
    }
    for (const e of m.s.exits) {
      if (joinedOut(m, e)) continue;
      const ext = `ext:${id}:out:${e.id}`;
      g.nodes.push({ id: ext, kind: "external", service: null, label: e.channel.type === "external" ? e.channel.system! : e.channel.type === "mq" ? `MQ ${e.channel.exchange}` : `${e.channel.service} · ${e.channel.port}`, detail: e.channel.type === "mq" ? e.channel.routingKey! : e.channel.type });
      edge({ from: id, to: ext, kind: e.channel.type === "s2s" ? "s2s" : "data", ...(e.relationship ? { label: e.relationship } : {}) });
    }
  }
  for (const d of extras.drops ?? []) {
    const from = nodeId(d.service, d.segment);
    if (!g.nodes.some((n) => n.id === from)) continue;
    const id = `drop:${from}`;
    g.nodes.push({ id, kind: "external", service: null, label: "Dropped", detail: `Dropped · ${d.count} 个` });
    edge({ from, to: id, kind: "drop", ...(d.relationship ? { label: d.relationship } : {}) });
  }
  return g;
}

const endpoint2 = (m: Member, side: "entry" | "exit", e: Endpoint & { component?: string; relationship?: string }): Endpoint2 => {
  const step = m.s.steps.find((s) => s.id === e.step);
  return {
    service: m.service, component: e.component ?? step?.position.id ?? "", name: step?.position.name ?? step?.name ?? e.id, type: e.channel.type,
    ...(e.relationship ? { relationship: e.relationship } : {}), text: endpointText(side, e),
  };
};

export function stuckOf(f: FlowRecord): StuckTimes {
  return f.stuck
    ? { attentionMinutes: Math.round(f.stuck.attentionS / 60), failingMinutes: Math.round(f.stuck.failingS / 60), by: f.stuck.by, basis: f.stuck.basis }
    : { ...DEFAULT_STUCK, by: "ai", basis: "AI 还没给建议，先用默认值" };
}

export function flowCard(store: Store, f: FlowRecord, extras: GraphExtras = {}, ctx: { skeleton?: Skeleton; models?: Map<string, ModelV2 | null> } = {}): FlowCard {
  const models = ctx.models ?? new Map<string, ModelV2 | null>();
  const sk = ctx.skeleton ?? skeletonOf(store, new Date());
  const ms = members(store, f.id, models);
  const graph = flowGraph(store, f.id, extras, { skeleton: sk, models });
  const ext = (side: "in" | "out") => new Set(graph.edges.filter((e) => (side === "in" ? e.from : e.to).startsWith("ext:")).map((e) => (side === "in" ? e.from : e.to)));
  const ins = ext("in"), outs = ext("out");
  return {
    id: f.id, name: f.name, nameBy: f.nameBy, status: f.status, summary: f.summary,
    services: [...new Set(ms.map((m) => m.service))], graph,
    entries: ms.flatMap((m) => m.s.entries.filter((e) => ins.has(`ext:${nodeId(m.service, m.s.id)}:in:${e.id}`)).map((e) => endpoint2(m, "entry", e))),
    exits: ms.flatMap((m) => m.s.exits.filter((e) => outs.has(`ext:${nodeId(m.service, m.s.id)}:out:${e.id}`)).map((e) => endpoint2(m, "exit", e))),
    groups: ms.map((m) => ({ service: m.service, id: m.s.group.id, name: m.s.group.name })),
    reason: f.reason, risks: f.risks.map((r) => ({ text: r.text, component: r.component ?? null })), stuck: stuckOf(f),
    pending: pendingView(f.pendings),
  };
}

/** #6 GET /api/services/:id/flows. intro: the AI's (step 4's analysis) when there is one. */
export function flowsReview(store: Store, service: string, intro?: string | null): FlowsReview {
  const ctx = { skeleton: skeletonOf(store, new Date()), models: new Map<string, ModelV2 | null>() };
  const rows = store.flows(service);
  const cards = rows.map((f) => flowCard(store, f, {}, ctx));
  const order = (s: FlowStatus) => (s === "proposed" ? 0 : s === "gone" ? 1 : 2);
  const flows = cards.filter((c) => c.status !== "ignored").sort((a, b) => order(a.status) - order(b.status) || (a.pending ? 0 : 1) - (b.pending ? 0 : 1));
  const model = store.flowModel(service)?.model;
  return {
    service, intro: intro ?? DEFAULT_INTRO, flows, ignored: cards.filter((c) => c.status === "ignored"),
    shared: (model?.segments ?? []).filter((s) => s.role === "shared").map((s) => ({ service, group: s.group.id, name: s.group.name })),
    allConfirmed: flows.length > 0 && flows.every((c) => c.status === "confirmed" && !c.pending),
  };
}
