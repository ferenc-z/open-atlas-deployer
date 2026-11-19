// The flow diagram's data side (prototype README "流程图", pages-rethink B5): a FlowGraph (structure only) becomes the
// input of ELK (`layered`, left to right), and ELK's answer becomes boxes and paths in absolute pixels for FlowGraphView.
// No React and no elkjs import here, so the conversion is unit-testable; flowlayout.ts runs ELK.

import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api.js";
import type { FlowGraph, Light } from "../server/services/ops-types.ts";

export type EdgeKind = FlowGraph["edges"][number]["kind"];

/** Edge look: the colour, whether it is dashed, and the label an edge of that kind gets when the graph gives none. */
export const EDGE_STYLE: Record<EdgeKind, { color: string; dash: string | null; label: string | null }> = {
  data: { color: "#6B6B66", dash: null, label: null },
  s2s: { color: "#1F4FB8", dash: null, label: "S2S" },
  failure: { color: "#8A5300", dash: null, label: "failure" },
  retry: { color: "#8A5300", dash: null, label: "retry" },
  drop: { color: "#B3261E", dash: "6 6", label: "failure" },
};

export const SERVICE_ID = (id: string) => `svc:${id}`;
const NODE_ID = (id: string) => `n:${id}`;
const EDGE_ID = (i: number) => `e:${i}`;

const LINE_HEIGHT = 20;
const CJK = /[⺀-鿿＀-￯]/u;
/** Rough text width at 14px: a CJK character about 14, any other about 7.5. */
export function textWidth(text: string, size = 14): number {
  let w = 0;
  for (const ch of text) w += CJK.test(ch) ? size : size * 0.54;
  return w;
}

/** A node's text lines: the label (bold) and, when the graph gives one, the second line `detail` (§10.3). */
export const nodeLines = (label: string, detail?: string) => (detail ? [label, detail] : [label]);

/** Box size from the text, so the box holds it without the SVG measuring anything. */
export function nodeSize(kind: "group" | "external", label: string, detail: string | undefined, hasLightLine: boolean): { width: number; height: number } {
  const lines = nodeLines(label, detail);
  const widest = Math.max(...lines.map((l) => textWidth(l)));
  const width = Math.round(Math.min(Math.max(widest + 32, kind === "group" ? 180 : 140), 300));
  const inner = width - 32;
  const rows = lines.reduce((n, l) => n + Math.max(1, Math.ceil(textWidth(l) / inner)), 0) + (hasLightLine ? 1 : 0);
  return { width, height: Math.max(kind === "group" ? 72 : 56, rows * LINE_HEIGHT + 24) };
}

const edgeLabel = (e: FlowGraph["edges"][number]): string | null => e.label ?? EDGE_STYLE[e.kind].label;

export const LAYOUT_OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.spacing.nodeNode": "36",
  "elk.layered.spacing.nodeNodeBetweenLayers": "72",
  "elk.layered.spacing.edgeNodeBetweenLayers": "24",
  "elk.padding": "[top=8,left=8,bottom=8,right=8]",
} as const;
const SERVICE_PADDING = "[top=30,left=16,bottom=16,right=16]";

/**
 * FlowGraph -> ELK input. A service is a compound node holding its groups; an external node, and a group whose service is
 * not listed, sits at the top level. Edges are all declared at the top (hierarchyHandling INCLUDE_CHILDREN routes them
 * across the service boxes). An edge to or from a node the graph does not have is left out.
 */
export function toElk(graph: FlowGraph): ElkNode {
  const known = new Set(graph.services.map((s) => s.id));
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const toNode = (n: FlowGraph["nodes"][number]): ElkNode => ({ id: NODE_ID(n.id), ...nodeSize(n.kind, n.label, n.detail, n.kind === "group" && n.light !== undefined) });
  const children: ElkNode[] = graph.services.map((s) => ({
    id: SERVICE_ID(s.id),
    labels: [{ text: s.label }],
    layoutOptions: { "elk.padding": SERVICE_PADDING },
    children: graph.nodes.filter((n) => n.kind === "group" && n.service === s.id).map(toNode),
  }));
  for (const n of graph.nodes) if (!(n.kind === "group" && n.service !== null && known.has(n.service))) children.push(toNode(n));
  const edges: ElkExtendedEdge[] = [];
  graph.edges.forEach((e, i) => {
    if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) return;
    const text = edgeLabel(e);
    edges.push({ id: EDGE_ID(i), sources: [NODE_ID(e.from)], targets: [NODE_ID(e.to)], ...(text ? { labels: [{ text, width: Math.round(textWidth(text, 13)) + 8, height: 16 }] } : {}) });
  });
  return { id: "root", layoutOptions: { ...LAYOUT_OPTIONS }, children, edges };
}

export interface LaidNode { id: string; kind: "group" | "external"; label: string; detail?: string; light?: Light; x: number; y: number; width: number; height: number; dropTarget: boolean }
export interface LaidService { id: string; label: string; x: number; y: number; width: number; height: number }
export interface LaidEdge { id: string; kind: EdgeKind; from: string; to: string; path: string; label: { text: string; x: number; y: number; width: number; height: number } | null }
export interface Laid { width: number; height: number; services: LaidService[]; nodes: LaidNode[]; edges: LaidEdge[] }

type Container = ElkExtendedEdge & { container?: string };

/** ELK's output -> absolute boxes and paths (a child's position is relative to its parent; an edge's, to its `container`). */
export function fromElk(graph: FlowGraph, laid: ElkNode): Laid {
  const origin = new Map<string, { x: number; y: number }>([["root", { x: 0, y: 0 }]]);
  const services: LaidService[] = [], nodes: LaidNode[] = [];
  const meta = new Map(graph.nodes.map((n) => [NODE_ID(n.id), n]));
  const serviceMeta = new Map(graph.services.map((s) => [SERVICE_ID(s.id), s]));
  const dropTargets = new Set(graph.edges.filter((e) => e.kind === "drop").map((e) => NODE_ID(e.to)));
  const walk = (n: ElkNode, ox: number, oy: number) => {
    for (const c of n.children ?? []) {
      const x = ox + (c.x ?? 0), y = oy + (c.y ?? 0);
      origin.set(c.id, { x, y });
      const s = serviceMeta.get(c.id);
      if (s) services.push({ id: s.id, label: s.label, x, y, width: c.width ?? 0, height: c.height ?? 0 });
      const m = meta.get(c.id);
      if (m) nodes.push({ id: m.id, kind: m.kind, label: m.label, ...(m.detail ? { detail: m.detail } : {}), ...(m.light ? { light: m.light } : {}), x, y, width: c.width ?? 0, height: c.height ?? 0, dropTarget: dropTargets.has(c.id) });
      walk(c, x, y);
    }
  };
  walk(laid, 0, 0);
  const edges: LaidEdge[] = [];
  for (const e of (laid.edges ?? []) as Container[]) {
    const index = Number(e.id.slice(2));
    const source = graph.edges[index];
    const section = e.sections?.[0];
    if (!source || !section) continue;
    const o = origin.get(e.container ?? "root") ?? { x: 0, y: 0 };
    const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
    const path = points.map((p, i) => `${i === 0 ? "M" : "L"} ${round(o.x + p.x)} ${round(o.y + p.y)}`).join(" ");
    const l = e.labels?.[0];
    edges.push({ id: e.id, kind: source.kind, from: source.from, to: source.to, path, label: l && l.text ? { text: l.text, x: round(o.x + (l.x ?? 0)), y: round(o.y + (l.y ?? 0)), width: l.width ?? 0, height: l.height ?? 0 } : null });
  }
  return { width: Math.ceil(laid.width ?? 0), height: Math.ceil(laid.height ?? 0), services, nodes, edges };
}
const round = (n: number) => Math.round(n * 10) / 10;
