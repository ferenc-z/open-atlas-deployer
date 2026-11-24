// pages-rethink §10.2.2 #1, #2, #8 with §10.3 (ops step 3b): the services overview, a service's page and a business's
// detail. The lights are the rules' (machine: rules.ts, business: business.ts); the AI's analysis and the to-dos are
// step 4's tables (todos.ts, which owns TodoView and AnalysisView), read here through PageSources (left out: none);
// opsPageSources / opsBusinessHooks wire steps 3b and 4 together.

import type { ExecutorInfo } from "../handoff.ts";
import type { Store } from "../store.ts";
import type { BusinessRow, RegistrationInfo } from "../../web/biz-types.ts";
import { ANOMALY_LABEL, anomalyText, businessLight, flowLight } from "./business.ts";
import { flowCard, type GraphExtras } from "./flow-views.ts";
import { LIGHT_ORDER, type AnalysisState, type AnalysisTrigger, type AnalysisView, type Anomaly, type FlowNote, type BusinessLightView, type FlowCard, type FlowDetail, type FlowProblem, type FlowRow, type GateVerdict, type Light, type Lights, type ServiceCard, type ServicePage, type ServicesOverview, type TodoView, type UnknownReason } from "./ops-types.ts";
import type { BusinessHooks } from "./ops-routes.ts";
import { machineLight } from "./rules.ts";
import { opsReads, type AiSentences } from "./todos.ts";
import { CUES, type Cue } from "./trace/model.ts";


/** What step 4 (and 5) give the pages: the to-dos and the AI's analyses. Left out, there are none. */
export interface PageSources {
  todos?: { open(service: string): TodoView[] };
  analyses?: {
    /** The newest analysis; lights: the two lights now, which tell whether it is out of date. */
    latest(service: string, lights?: Lights): AnalysisView | null;
    lastCheckup(): ServicesOverview["lastCheckup"];
    running(): boolean;
    /** The next scheduled checkup (A1, step 5), if one is set. */
    nextCheckAt?(): string | null;
    /** The AI's sentences beside the lights while they hold (todos.ts aiSentences); left out, the rules' sentences show. */
    sentences?(service: string, lights: Lights, flowLights: Record<string, string>): AiSentences;
  };
}

/** The page's sentences: the AI's where it has one that still holds, else the rules'. */
function withAi<M extends { light: Light; sentence: string }, B extends { light: Light; sentence: string; flows: FlowRow[] }>(src: PageSources, service: string, machine: M, business: B): { machine: M; business: B } {
  const ai = src.analyses?.sentences?.(service, { machine: machine.light, business: business.light }, Object.fromEntries(business.flows.map((f) => [f.id, f.light])));
  if (!ai) return { machine, business };
  return {
    machine: ai.machine ? { ...machine, sentence: ai.machine } : machine,
    business: { ...business, ...(ai.business ? { sentence: ai.business } : {}), flows: business.flows.map((f) => (ai.flows[f.id] ? { ...f, sentence: ai.flows[f.id]! } : f)) },
  };
}

/** Step 4's tables as the pages read them; step 5's next scheduled check-up (checkup-schedule.ts) when given. */
export function opsPageSources(store: Store, nextCheckAt?: () => string | null): PageSources {
  const reads = opsReads(store);
  return {
    todos: { open: (service) => reads.todos(service) },
    analyses: {
      latest: (service, lights) => reads.analysis(service, lights), lastCheckup: () => reads.lastCheckup(), running: () => reads.running(),
      sentences: (service, lights, flowLights) => reads.sentences(service, lights, flowLights),
      ...(nextCheckAt ? { nextCheckAt: () => { const n = nextCheckAt(); return n && Date.parse(n) > Date.now() ? n : null; } } : {}),
    },
  };
}

/** Step 3b's business light and business detail for describe (step 4). */
export const opsBusinessHooks = (store: Store): BusinessHooks => ({
  business: (service) => businessLight(store, service),
  flowDetail: (flow, _service, now) => flowDetail(store, flow, now),
});

type Executor = (host: string) => ExecutorInfo;
const DAY = 86_400_000;

function services(store: Store) {
  return [...store.clusters(), ...store.standalones()].map((s) => ({
    id: s.id, kind: s.kind, environment: s.environment, webUrl: s.webUrl ?? null,
    label: s.kind === "cluster" ? `NiFi ${s.version} · cluster, ${s.nodes.length} node${s.nodes.length === 1 ? "" : "s"}` : `NiFi ${s.version} · standalone`,
  }));
}

/** #1 GET /api/services/overview: worst first (the worse of the two lights), then by id. */
export function servicesOverview(store: Store, executor: Executor, src: PageSources = {}, now: Date = new Date()): ServicesOverview {
  const cards: ServiceCard[] = [];
  const next = src.analyses?.nextCheckAt?.() ?? null;
  for (const s of services(store)) {
    const rules = machineLight(store, executor, s.id, now);
    if (!rules) continue;
    const { machine: m, business: b } = withAi(src, s.id, rules, businessLight(store, s.id));
    const todos = src.todos?.open(s.id) ?? [];
    const latest = src.analyses?.latest(s.id, { machine: m.light, business: b.light }) ?? null;
    cards.push({
      id: s.id, kind: s.kind, environment: s.environment, label: s.label,
      machine: { light: m.light, sentence: m.sentence },
      business: { light: b.light, ...(b.reason ? { reason: b.reason } : {}), sentence: b.sentence, flowCount: b.flows.length, toConfirm: b.toConfirm, ...(b.confirmedAt ? { confirmedAt: b.confirmedAt } : {}) },
      businesses: businessCounts(registeredRows(store, s.id, b)),
      todoCount: todos.length,
      ...(next ? { nextCheckAt: next } : {}),
      ...(src.todos ? { aiHasPlan: todos.some((t) => t.source === "analysis" && t.action !== null) || Boolean(latest && latest.state === "done" && todos.some((t) => t.action)) } : {}),
    });
  }
  const worst = (c: ServiceCard) => Math.min(LIGHT_ORDER[c.machine.light], LIGHT_ORDER[c.business.light]);
  cards.sort((a, b) => worst(a) - worst(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { services: cards, lastCheckup: src.analyses?.lastCheckup() ?? null, running: src.analyses?.running() ?? false };
}

/** #2 GET /api/services/:id/page; undefined for an unknown service. */
export function servicePage(store: Store, executor: Executor, id: string, src: PageSources = {}, now: Date = new Date()): ServicePage | undefined {
  const s = services(store).find((x) => x.id === id);
  const rules = s && machineLight(store, executor, id, now);
  if (!s || !rules) return undefined;
  const change = store.serviceChanges(id, 1)[0];
  const ORDER = { failing: 0, attention: 1 } as const;
  const { machine, business } = withAi(src, id, rules, businessLight(store, id));
  return {
    service: { id, kind: s.kind, environment: s.environment, label: s.label, webUrl: s.webUrl },
    machine, business,
    analysis: src.analyses?.latest(id, { machine: machine.light, business: business.light }) ?? null,
    // S39 step 8: the registered businesses that run here, listed (as "affected") only while the machine is not healthy.
    ...affectedOf(registeredRows(store, id, business), machine.light),
    todos: [...(src.todos?.open(id) ?? [])].sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || (a.createdAt < b.createdAt ? -1 : 1)),
    config: {
      revision: store.serviceConfig(id)?.revision ?? null,
      lastChange: change ? { at: change.finishedAt ?? change.createdAt, by: change.createdBy, text: `${change.mode === "rolling" ? "Rolling" : "Full"} ${change.kind}${change.revision !== null ? ` to r${change.revision}` : ""}: ${change.state}` } : null,
      activeChange: store.activeServiceChange(id)?.id ?? null,
      // §10.3 (P2): config-drift lights nothing; the summary says whether its alert is open.
      drift: store.serviceAlerts({ service: id, state: "open", limit: 200 }).some((a) => a.rule === "config-drift"),
    },
  };
}

const nifiLink = (webUrl: string | null, group: string, component: string | null) => {
  if (!webUrl) return null;
  const base = webUrl.replace(/\/+$/, "");
  return `${/\/nifi$/.test(base) ? base : `${base}/nifi`}/?processGroupId=${encodeURIComponent(group)}${component ? `&componentIds=${encodeURIComponent(component)}` : ""}`;
};

/** #8 GET /api/flows/:flow: the business's light and its problems now (open anomalies), the anomalies of the last 7
 *  days by day, the clues it can be found by and its model history. The graph carries the lights and the drops. */
export function flowDetail(store: Store, flow: string, now: Date = new Date()): FlowDetail | undefined {
  const f = store.flow(flow);
  if (!f) return undefined;
  const l = flowLight(store, f);
  const web = new Map(services(store).map((s) => [s.id, s.webUrl] as const));
  const models = new Map<string, ReturnType<Store["flowModel"]>>();
  const model = (svc: string) => { if (!models.has(svc)) models.set(svc, store.flowModel(svc)); return models.get(svc)?.model ?? null; };
  const segment = (svc: string, id: unknown) => model(svc)?.segments.find((s) => s.id === id);
  // The graph: a segment's light is its worst open anomaly; drops outside the exits go to a Dropped node.
  const lights = new Map<string, Light>();
  for (const a of l.anomalies) {
    const key = `${a.service}/${String(a.detail.segment ?? "")}`;
    lights.set(key, lights.has(key) && LIGHT_ORDER[lights.get(key)!] <= LIGHT_ORDER[a.light] ? lights.get(key)! : a.light);
  }
  const drops = new Map<string, NonNullable<GraphExtras["drops"]>[number]>();
  for (const a of l.anomalies.filter((x) => x.anomaly === "data-dropped")) {
    const key = `${a.service}/${String(a.detail.segment ?? "")}`;
    const was = drops.get(key);
    if (was) { was.count += a.count; if (was.relationship !== a.detail.relationship) was.relationship = null; }
    else drops.set(key, { service: a.service, segment: String(a.detail.segment ?? ""), count: a.count, relationship: (a.detail.relationship as string | null) ?? null });
  }
  const card = flowCard(store, f, { lights, drops: [...drops.values()] });
  const problems: FlowProblem[] = l.anomalies.map((a) => {
    const seg = segment(a.service, a.detail.segment);
    const component = typeof a.detail.component === "string" ? a.detail.component : null;
    return {
      anomaly: a.anomaly, light: a.light, title: anomalyText(a), service: a.service, group: seg?.group.name ?? String(a.detail.segment ?? a.ref), component,
      count: a.count, since: a.firstAt, latest: a.lastAt, cause: null, advice: [], nifiUrl: seg ? nifiLink(web.get(a.service) ?? null, seg.group.id, component) : null,
    };
  });
  // Last 7 days: each day an anomaly was open, the worst light and its sentences that day.
  const since = new Date(now.getTime() - 7 * DAY);
  // Other drops (owner 2026-11-20) are listed too, light healthy: they light nothing. Their text keeps NiFi's details and the count.
  const days = new Map<string, { day: string; anomaly: Anomaly | FlowNote; light: Light; texts: Set<string> }>();
  for (const a of store.flowAnomalies({ flow, since: since.toISOString() })) {
    const start = Math.max(Date.parse(a.firstAt), since.getTime()), end = a.closedAt ? Date.parse(a.closedAt) : now.getTime();
    for (let t = Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth(), new Date(start).getUTCDate()); t <= end; t += DAY) {
      const day = new Date(t).toISOString().slice(0, 10), key = `${day}\0${a.anomaly}`;
      const d = days.get(key) ?? { day, anomaly: a.anomaly, light: a.light, texts: new Set<string>() };
      if (LIGHT_ORDER[a.light] < LIGHT_ORDER[d.light]) d.light = a.light;
      d.texts.add(a.anomaly === "other-drop" ? anomalyText(a) : anomalyText(a).replace(/ \(\d+\+?\)$/, ""));
      days.set(key, d);
    }
  }
  const last7Days = [...days.values()].sort((a, b) => (a.day > b.day ? -1 : a.day < b.day ? 1 : LIGHT_ORDER[a.light] - LIGHT_ORDER[b.light]))
    .map((d) => ({ day: d.day, anomaly: d.anomaly, light: d.light, text: [...d.texts].slice(0, 3).join("; ") || ANOMALY_LABEL[d.anomaly] }));
  // Find a file by: the cue mappings of the business's entries (T7).
  const findBy: FlowDetail["findBy"] = [];
  for (const s of store.flowSegments(flow)) for (const e of segment(s.service, s.segment)?.entries ?? []) for (const c of e.cues ?? []) {
    if (CUES.includes(c.cue) && !findBy.some((x) => x.cue === c.cue && x.attribute === c.key)) findBy.push({ cue: c.cue, attribute: c.key });
  }
  return {
    flow: card, light: l.light, ...(l.reason ? { reason: l.reason } : {}), sentence: l.sentence, problems, last7Days, findBy,
    history: store.flowChanges({ flow, limit: 100 }).map((c) => ({ at: c.at, by: c.by === "ai" ? "ai" as const : "person" as const, text: c.text, verdict: c.verdict })),
  };
}

// ---- S39 step 8: what the Businesses page and the business detail read of the registration ----------------------------

/** The registered businesses (the owners of segment registrations). */
const registeredIds = (store: Store): Set<string> => new Set(store.flowRegistrations().filter((r) => r.role === "segment").map((r) => r.owner));

/** The registered businesses that run on a service as the lights see them (FlowRow), worst first. */
export function registeredRows(store: Store, service: string, view: BusinessLightView = businessLight(store, service)): FlowRow[] {
  const ids = registeredIds(store);
  return view.flows.filter((f) => ids.has(f.id));
}

/** GET /api/businesses: every registered business, its light and what the list shows of the registration. */
export function businessList(store: Store): BusinessRow[] {
  const regs = store.flowRegistrations().filter((r) => r.role === "segment");
  const owners = [...new Set(regs.map((r) => r.owner))];
  const rows = new Map<string, FlowRow>();
  for (const svc of new Set(regs.map((r) => r.service))) for (const f of registeredRows(store, svc)) rows.set(f.id, f);
  return owners.map((id) => {
    const mine = regs.filter((r) => r.owner === id);
    const first = mine[0]!;
    const row = rows.get(id);
    return {
      id, name: store.flow(id)?.name ?? id, light: row?.light ?? "unknown", sentence: row?.sentence ?? "Not known yet: no data has been read for it.",
      anomalies: row?.anomalies ?? [], services: row?.services?.length ? row.services : [...new Set(mine.map((r) => r.service))],
      groupCount: new Set(mine.map((r) => `${r.service}\0${r.groupId}`)).size, handoffCount: store.flowHandoffs(id).length,
      registeredBy: first.registeredBy, registeredById: first.registeredBy, registeredAt: first.registeredAt,
    };
  });
}

/** The history as the page shows it: the rows of one registration action (`op`) read as one. */
export function mergedChanges(store: Store, flow: string): RegistrationInfo["changes"] {
  const out: RegistrationInfo["changes"] = [];
  const byOp = new Map<string, RegistrationInfo["changes"][number]>();
  for (const c of store.flowChanges({ flow, limit: 200 })) {
    const by = c.by === "ai" ? "AI" : c.by;
    if (!c.op) { out.push({ at: c.at, by, text: c.text }); continue; }
    const have = byOp.get(c.op);
    if (!have) { const row = { at: c.at, by, text: c.text }; byOp.set(c.op, row); out.push(row); }
    else if (!have.text.split("；").includes(c.text)) have.text += `；${c.text}`;
  }
  return out;
}

/** The registration block of the business detail (web/biz-types.ts RegistrationInfo). */
export function registrationInfo(store: Store, flow: string, card: FlowCard): RegistrationInfo | undefined {
  const regs = store.flowRegistrations({ owner: flow }).filter((r) => r.role === "segment");
  if (!regs.length) return undefined;
  const web = new Map(services(store).map((s) => [s.id, s.webUrl] as const));
  const models = new Map<string, ReturnType<Store["flowModel"]>>();
  const mine = store.flowSegments(flow);
  const stepsOf = (service: string, group: string) => {
    if (!models.has(service)) models.set(service, store.flowModel(service));
    const seg = models.get(service)?.model.segments.find((s) => s.group.id === group && mine.some((x) => x.service === service && x.segment === s.id));
    return seg ? seg.steps.map((s) => s.name).slice(0, 3).join(" → ") : "";
  };
  const seen = new Set<string>();
  const groups: RegistrationInfo["groups"] = [];
  for (const r of regs) {
    const key = `${r.service}\0${r.groupId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    groups.push({ service: r.service, id: r.groupId, name: r.groupName, ...(r.groupPath ? { path: r.groupPath } : {}), how: stepsOf(r.service, r.groupId), nifiUrl: nifiLink(web.get(r.service) ?? null, r.groupId, null) });
  }
  return {
    by: regs[0]!.registeredBy, at: regs[0]!.registeredAt, groups,
    shared: card.graph.nodes.filter((n) => n.module).map((n) => ({ id: String(n.module), name: n.label })),
    handoffs: store.flowHandoffs(flow).map((h) => ({ id: h.id, from: h.from, to: h.to, quote: h.quote })),
    changes: mergedChanges(store, flow),
  };
}

export const businessCounts = (rows: FlowRow[]) => ({ count: rows.length, failing: rows.filter((f) => f.light === "failing").length, attention: rows.filter((f) => f.light === "attention").length });
const affectedOf = (rows: FlowRow[], machine: Light) => ({ businessCount: rows.length, affected: machine === "healthy" ? [] : rows });
