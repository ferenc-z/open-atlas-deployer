// Pure helpers of the Businesses and Register pages (kept apart from the components so they can be tested).

import { LIGHT_ORDER } from "../server/services/ops-types.ts";
import type { Light } from "../server/services/ops-types.ts";
import type { BusinessRow, EdgeKindP, GapKind, HandoffInput, LinkInput, ModuleDetail, ModuleView, Preview, PreviewEdge, PreviewGap, PreviewSegment, RegDraft, RegistrationInfo, SharedModuleRow } from "./biz-types.ts";

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

/** Groups the server could not use: NiFi no longer has them (a group somebody else holds is refused when it is added). */
export function groupProblems(p: Preview): string[] {
  return p.groups.filter((g) => g.state === "missing").map((g) => `${g.service} · ${g.group.name}: not found on that service`);
}

/** Registering waits for every question to be answered, every group to be usable, and a name. */
export const canRegister = (p: Preview | undefined, name: string): boolean => p !== undefined && p.segments.length > 0 && p.gaps.length === 0 && groupProblems(p).length === 0 && name.trim() !== "";

/** A gap where the group has no known source (its data comes in from somewhere the person must say); the others are about where data goes out: an exit nobody receives, an S2S or MQ nobody takes. */
export const isIncoming = (kind: GapKind): boolean => kind === "entry-unregistered" || kind === "disconnected";

/** `dir` is for a part not joined to the rest (disconnected): the data goes out of this part into `from`, or comes in from it (the default). */
export interface GapAnswer { from: string; component: string; quote: string; system: string; dir?: "in" | "out" }
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
  if (gap.kind === "disconnected" && a.dir === "out") return source && component ? { from: { service: mine.service, group: mine.group.id, component }, to: { service: source.service, group: source.group.id }, quote } : null;
  return source && component ? { from: { service: source.service, group: source.group.id, component }, to: { service: mine.service, group: mine.group.id }, quote } : null;
}

// ---- The Register page on a draft (7.9) ----

/** True while the groups the preview was made from are not the draft's groups any more (the AI changed them since). */
export function previewStale(d: RegDraft): boolean {
  if (!d.preview) return d.groups.length > 0;
  const was = new Set(d.preview.groups.map((g) => `${g.service}\0${g.group.id}`));
  return was.size !== new Set(d.groups.map((g) => `${g.service}\0${g.group.id}`)).size || d.groups.some((g) => !was.has(`${g.service}\0${g.group.id}`));
}

/** The one sentence a refused Register becomes, for the person to paste to the assistant (its input cannot be pre-filled). */
export function tellAiText(why: { code?: string; message: string; gaps?: PreviewGap[]; problems?: { text: string }[] }, button = "Register"): string {
  if (why.code === "register/gate-rejected" && why.problems?.length) return `点 ${button} 被闸门拒绝了，问题是：${why.problems.map((p) => p.text).join("；")}。请帮我看看怎么处理，处理好了我再点。`;
  if (why.code === "register/gaps-open" && why.gaps?.length) return `点 ${button} 被拒绝了，还有 ${why.gaps.length} 个地方接不上：${why.gaps.map((g) => g.text).join("；")}。请帮我逐个处理。`;
  return `点 ${button} 被拒绝了：${why.message} 请帮我看看怎么处理。`;
}

/** A refused commit as the page keeps it: the server's sentence, the lines under it, and the sentence for the assistant. */
export function refusalOf(x: { code?: string; message: string; body?: Record<string, unknown> }, button = "Register"): { code?: string; message: string; lines: string[]; tell: string } {
  const body = x.body ?? {};
  return {
    ...(x.code ? { code: x.code } : {}), message: x.message, lines: refusalLines(body),
    tell: tellAiText({ ...(x.code ? { code: x.code } : {}), message: x.message, ...(Array.isArray(body.gaps) ? { gaps: body.gaps as PreviewGap[] } : {}), ...(Array.isArray(body.problems) ? { problems: body.problems as { text: string }[] } : {}) }, button),
  };
}

/** What a refused commit lists on the page, from the server's answer (gaps, or the gate's problems). */
export function refusalLines(body: Record<string, unknown>): string[] {
  const problems = Array.isArray(body.problems) ? (body.problems as { text?: string }[]).map((p) => p.text ?? "") : [];
  const gaps = Array.isArray(body.gaps) ? (body.gaps as PreviewGap[]).map((g) => g.text) : [];
  return [...problems, ...gaps].filter(Boolean);
}

// ---- Shared modules (the Businesses page) ----

const MODULE_LIGHT: Record<ModuleView["health"]["light"], Light> = { ok: "healthy", idle: "unknown", attention: "attention", unknown: "unknown" };

/** One row of the shared-module list; `detail` (who is joined now) comes later, so the row says nothing about users until then. */
export function moduleRow(m: ModuleView, detail?: ModuleDetail): SharedModuleRow {
  const ports = [m.entries.length ? `In: ${m.entries.map((e) => e.text).join("、")}` : "", m.exits.length ? `Out: ${m.exits.map((e) => e.text).join("、")}` : ""].filter(Boolean).join(" · ");
  return {
    id: m.id, name: m.name, service: [...new Set(m.groups.map((g) => g.service))].join(", "), ports: ports || "No ports described",
    ...(detail ? { usedBy: detail.users.map((u) => ({ id: u.flow, name: u.name })) } : {}),
    light: MODULE_LIGHT[m.health.light], health: m.health.text,
  };
}

// ---- A draft of changes to a registered business (the business page) ----

/** What a modification draft changes against the business as registered: groups added and removed, the name, the hand-overs told. */
export function draftChanges(d: RegDraft, now: { name: string; reg: RegistrationInfo }): string[] {
  const key = (s: string, g: string) => `${s}\0${g}`;
  const had = new Map(now.reg.groups.map((g) => [key(g.service, g.id), g]));
  const has = new Map(d.groups.map((g) => [key(g.service, g.group.id), g]));
  const out: string[] = [];
  for (const [k, g] of has) if (!had.has(k)) out.push(`Add group ${g.group.name} (${g.service})`);
  for (const [k, g] of had) if (!has.has(k)) out.push(`Remove group ${g.name} (${g.service})`);
  if (d.name && d.name !== now.name) out.push(`Rename to “${d.name}”`);
  const was = new Map(now.reg.handoffs.map((h) => [h.id, h]));
  for (const h of d.handoffs) {
    const old = was.get(h.id);
    if (!old) out.push(`Add a handoff you described: “${h.quote}”`);
    else if (old.quote !== h.quote || JSON.stringify(old.to) !== JSON.stringify(h.to) || old.from.component !== h.from.component) out.push(`Change a handoff you described: “${h.quote}”`);
  }
  for (const h of now.reg.handoffs) if (!d.handoffs.some((x) => x.id === h.id)) out.push(`Remove a handoff you described: “${h.quote}”`);
  return out;
}
