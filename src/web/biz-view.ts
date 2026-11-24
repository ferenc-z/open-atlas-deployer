// Pure helpers of the Businesses and Register pages (kept apart from the components so they can be tested).

import { LIGHT_ORDER } from "../server/services/ops-types.ts";
import type { Light } from "../server/services/ops-types.ts";
import type { BusinessRow, EdgeKindP, GapKind, HandoffInput, LinkInput, Preview, PreviewEdge, PreviewGap, PreviewSegment } from "./biz-types.ts";

// ---- The Businesses page ----

export type StatusFilter = "all" | Light;

/** Worst first, then by name. */
export const sortBusinesses = (rows: BusinessRow[]): BusinessRow[] => [...rows].sort((a, b) => LIGHT_ORDER[a.light] - LIGHT_ORDER[b.light] || a.name.localeCompare(b.name));

export function countByLight(rows: BusinessRow[]): Record<Light, number> {
  const n: Record<Light, number> = { failing: 0, attention: 0, healthy: 0, unknown: 0 };
  for (const r of rows) n[r.light]++;
  return n;
}

/** Status, service ("" = all) and "Only mine" (the person registered it: by id when the row has one, else by name). */
export const businessFilter = (f: { status: StatusFilter; service: string; mine: boolean; me: { id: string; displayName: string } }) => (b: BusinessRow): boolean =>
  (f.status === "all" || b.light === f.status) && (f.service === "" || b.services.includes(f.service)) && (!f.mine || (b.registeredById ? b.registeredById === f.me.id : b.registeredBy === f.me.displayName));

/** "3 groups" and, when the owner described any handoff, "· 1 handoff you described". */
export function groupsLine(b: Pick<BusinessRow, "groupCount" | "handoffCount">): string {
  const groups = `${b.groupCount} ${b.groupCount === 1 ? "group" : "groups"}`;
  return b.handoffCount > 0 ? `${groups} · ${b.handoffCount} ${b.handoffCount === 1 ? "handoff" : "handoffs"} you described` : groups;
}

// ---- The Register page ----

/** The lines the person pasted: one link a line; `link service=<id>` gives Deployer the hint it asks for (7.6). Blank lines and repeats go. */
export function parseLinks(text: string, already: LinkInput[] = []): LinkInput[] {
  const key = (l: LinkInput) => (typeof l === "string" ? l : l.link);
  const seen = new Set(already.map(key));
  const out: LinkInput[] = [];
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line) continue;
    const hint = /^(\S+)\s+service=(\S+)$/u.exec(line);
    const link: LinkInput = hint ? { link: hint[1]!, service: hint[2]! } : line;
    if (seen.has(key(link))) continue;
    seen.add(key(link));
    out.push(link);
  }
  return out;
}

/** How an edge of the chain is drawn: grey = seen on the canvas or in the schedule definitions, blue = S2S, green = a shared module, purple dashed = a handoff the owner described. */
export function edgeLook(kind: EdgeKindP): { color: string; dashed: boolean } {
  if (kind === "s2s") return { color: "#1F4FB8", dashed: false };
  if (kind === "shared-entry" || kind === "shared-exit") return { color: "#1E6B34", dashed: false };
  if (kind === "declared") return { color: "#6B4FBF", dashed: true };
  return { color: "#6B6B66", dashed: false };
}

const KIND_WORD: Record<EdgeKindP, string> = { link: "Canvas connection", s2s: "S2S", mq: "MQ", schedule: "Schedule", "shared-entry": "Into a shared module", "shared-exit": "Out of a shared module", declared: "You described" };

/** The words under a connector: what kind of connection, where (`via`), and the owner's own words for a described handoff. */
export function edgeText(e: PreviewEdge): string {
  const base = e.via ? `${KIND_WORD[e.kind]} · ${e.via}` : KIND_WORD[e.kind];
  const quote = e.kind === "declared" && e.quote ? ` · “${e.quote}”` : "";
  return `${base}${e.inferred ? " · inferred" : ""}${quote}`;
}

export interface ChainLayer { segments: PreviewSegment[]; /** the connections that arrive at this layer from the layers before it */ arriving: { edge: PreviewEdge; from: PreviewSegment; to: PreviewSegment }[] }

/** The segments column by column (`layers`; one the server did not list goes last), each with the connections arriving at it. */
export function chainOf(p: Preview): ChainLayer[] {
  const byId = new Map(p.segments.map((s) => [s.id, s]));
  const listed = new Set<string>();
  const columns: PreviewSegment[][] = [];
  for (const layer of p.layers) {
    const col = layer.map((id) => byId.get(id)).filter((s): s is PreviewSegment => s !== undefined && !listed.has(s.id));
    col.forEach((s) => listed.add(s.id));
    if (col.length) columns.push(col);
  }
  const rest = p.segments.filter((s) => !listed.has(s.id));
  if (rest.length) columns.push(rest);
  return columns.map((segments) => ({
    segments,
    arriving: p.edges.filter((e) => segments.some((s) => s.id === e.to)).flatMap((edge) => { const from = byId.get(edge.from), to = byId.get(edge.to); return from && to ? [{ edge, from, to }] : []; }),
  }));
}

/** The line over the right panel: "5 groups · 4 connected · 1 to ask", or "· all connected · 2 services". */
export function summaryOf(p: Preview): string {
  const groups = p.groups.length || p.segments.length;
  const services = new Set(p.segments.map((s) => s.service)).size;
  const open = p.gaps.length;
  const noun = `${groups} ${groups === 1 ? "group" : "groups"}`;
  if (open === 0) return `${noun} · all connected · ${services} ${services === 1 ? "service" : "services"}`;
  const stuck = new Set(p.gaps.map((g) => g.segment)).size;
  return `${noun} · ${Math.max(0, groups - stuck)} connected · ${open} to ask`;
}

/** Groups the server could not use: not found, held by another business, or inside one that is. */
export function groupProblems(p: Preview): string[] {
  return p.groups.flatMap((g) => {
    const where = `${g.service} · ${g.group.name}`;
    if (g.state === "missing") return [`${where}: not found on that service`];
    if (g.state === "taken") return [`${where}: already registered${g.takenBy ? ` by ${g.takenBy.name}` : ""}`];
    if (g.state === "nested") return [`${where}: overlaps a group that is already registered`];
    return [];
  });
}

/** Registering waits for every question to be answered, every group to be usable, and a name. */
export const canRegister = (p: Preview | undefined, name: string): boolean => p !== undefined && p.segments.length > 0 && p.gaps.length === 0 && groupProblems(p).length === 0 && name.trim() !== "";

/** A gap where the group has no known source: the person says where its data comes from (the others are about where it goes). */
export const isIncoming = (kind: GapKind): boolean => kind !== "exit-unregistered";

export interface GapAnswer { from: string; component: string; quote: string; system: string }
/** The answered gap as the `handoffs` entry of the next preview: data from `from` (a segment) into the gap's segment, or out of NiFi (`system`). Null while something is missing. */
export function handoffOf(p: Preview, gap: PreviewGap, a: GapAnswer): HandoffInput | null {
  const mine = p.segments.find((s) => s.id === gap.segment);
  const quote = a.quote.trim();
  if (!mine || !quote) return null;
  if (!isIncoming(gap.kind)) {
    const component = a.component.trim();
    const system = a.system.trim();
    return component && system ? { from: { service: mine.service, group: mine.group.id, component }, to: { system }, quote } : null;
  }
  const source = p.segments.find((s) => s.id === a.from);
  const component = a.component.trim();
  return source && component ? { from: { service: source.service, group: source.group.id, component }, to: { service: mine.service, group: mine.group.id }, quote } : null;
}
