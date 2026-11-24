// S39 step 4 (business-registration §7.2, §7.5, §7.8 1): the registration's preview and its shared modules.
//   - preview: the groups of a draft, of a registered business (plus links to add) or of links alone, read from NiFi now
//     (nifi-groups: exactly those groups, one hop out), chained by chain() with the e2e_trace schedules, the shared
//     modules registered and the told hand-overs. A draft keeps the last preview.
//   - shared: a group made a shared module: its entries (input ports: canvas, S2S), its exits (output ports, S2S, an
//     end, with a split condition `when`), kept on shared_modules and written into the models by the publish (step 5,
//     register-publish.ts: sharedPlan here reads and checks, sharedWrite writes inside the publish's transaction). A
//     group another business has moves out of it with takeover: true (§7.8 1); every business joined to the module by
//     its ports gets a line in its history and is chained and published again.
//   - a module still joined to a business cannot be unregistered (register/module-in-use).
// Who uses a module is told by the canvas: a registered group on the other side of one of its declared ports (the
// module's one hop out), or an S2S sender / receiver in the services' latest topologies. MQ users are not seen here.

import { randomBytes } from "node:crypto";
import type { Actor, RegistrationDraftHandoff, SharedModule, Store, WorkerPlace } from "../store.ts";
import { chain, sendersOf, type ChainHandoff, type ChainModule, type ChainModuleEndpoint, type ChainService, type Preview } from "./chain.ts";
import type { Topology } from "./flowcounts.ts";
import { addressOf } from "./skeleton.ts";
import { CONDITION_OPS, type Condition } from "./trace/model.ts";
import { GROUPS_PER_READ, NAME_MAX, QUOTE_MAX, RegError, linkAsks, resolveLink, serviceAddresses, type GroupInfo, type GroupReader, type Registrations, type Taken } from "./registration.ts";

type Row = Record<string, string | number | null>;
export interface ScheduleRows { headers: Row[]; details: Row[] }
export interface RegisterChainDeps {
  store: Store;
  registrations: Registrations;
  reader?: GroupReader;
  /** e2e_trace's schedule_header / schedule_detail rows through a service's e2e source; null when it has none. */
  schedules?: (service: string) => Promise<ScheduleRows | null>;
}
/** A business joined to a module, and by what (port names, S2S). */
export interface ModuleUser { flow: string; name: string; via: string[] }
/** register shared, checked and read (sharedPlan), before anything is written. module: the module as chain() takes it. */
export interface SharedPlan {
  id: string; mod: SharedModule | null; name: string; service: string; group: { id: string; name: string }; path: string; link: string | null;
  entries: ChainModuleEndpoint[]; exits: ChainModuleEndpoint[]; users: ModuleUser[]; takeover: { flow: string; name: string } | null;
  preview: Preview; module: ChainModule;
}
interface GroupRef { service: string; group: string; slice?: string; link?: string | null }
interface Port { id: string; name: string; remote?: boolean }

const ENDPOINTS_MAX = 50;
const CONDITIONS_MAX = 10;
const portOf = (e: ChainModuleEndpoint): string | undefined => {
  const m = e.channel?.type === "external" ? /^port:(.+)$/.exec(e.channel.system ?? "") : null;
  return m?.[1];
};
const crumbs = (info: GroupInfo): string => [...(info.path ?? []).map((p) => p.name), info.name ?? info.id].join(" / ");

/** Two nifi-groups answers of one service as one topology (a link between groups read apart is a neighbor in each). */
export function mergeTopology(a: Topology | null, b: Topology | null): Topology | null {
  if (!a) return b;
  if (!b) return a;
  const seen = new Set(a.groups.map((g) => g.id));
  return {
    ...a,
    groups: [...a.groups, ...b.groups.filter((g) => !seen.has(g.id))],
    links: [...a.links, ...b.links], s2sIn: [...a.s2sIn, ...b.s2sIn], s2sOut: [...a.s2sOut, ...b.s2sOut],
    ends: [...(a.ends ?? []), ...(b.ends ?? [])], neighbors: [...(a.neighbors ?? []), ...(b.neighbors ?? [])],
    missing: [...(a.missing ?? []), ...(b.missing ?? [])], nested: { ...(a.nested ?? {}), ...(b.nested ?? {}) },
  };
}

/** A group's link in NiFi's UI from the service's web address ({id} for the group). */
function linkTemplate(webUrl: string | null | undefined, version: string | null | undefined): string | null {
  if (!webUrl) return null;
  let base = webUrl.replace(/\/+$/, "");
  try { if (new URL(base).pathname === "" || new URL(base).pathname === "/") base = `${base}/nifi`; } catch { return null; }
  return /^1\./.test(String(version ?? "")) ? `${base}/?processGroupId={id}&componentIds=` : `${base}/#/process-groups/{id}`;
}

export const toChain = (h: RegistrationDraftHandoff): ChainHandoff => ({ id: h.id, from: h.from, to: h.to, quote: h.quote, by: h.declaredBy, at: h.declaredAt });

/** preview's handoffs: told hand-overs not committed yet, in declare-handoff's shape. */
export function handoffsOf(v: unknown): ChainHandoff[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 50) throw new RegError("register/bad-request", "handoffs is a list of at most 50 {from, to, quote}.");
  return v.map((h, i): ChainHandoff => {
    const f = h?.from, t = h?.to;
    if (!f || typeof f.service !== "string" || typeof f.group !== "string" || typeof f.component !== "string" || !f.component.trim()) throw new RegError("register/bad-request", "A hand-over's from is {service, group, component, relationship?}.");
    if (!t || (typeof t.system !== "string" && (typeof t.service !== "string" || typeof t.group !== "string"))) throw new RegError("register/bad-request", "A hand-over's to is {service, group} or {system}.");
    if (typeof h.quote !== "string" || !h.quote.trim() || h.quote.length > QUOTE_MAX) throw new RegError("register/bad-request", `A hand-over's quote is the owner's words, 1 to ${QUOTE_MAX} characters.`);
    return {
      id: typeof h.id === "string" && h.id ? h.id : `new${i + 1}`,
      from: { service: f.service, group: f.group.toLowerCase(), component: f.component.trim(), ...(typeof f.relationship === "string" && f.relationship ? { relationship: f.relationship } : {}) },
      to: typeof t.system === "string" && t.system.trim() ? { system: t.system.trim() } : { service: t.service, group: t.group.toLowerCase() },
      quote: h.quote.trim(),
    };
  });
}

function conditions(v: unknown): Condition[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || !v.length || v.length > CONDITIONS_MAX) throw new RegError("register/bad-request", `when is a list of 1 to ${CONDITIONS_MAX} {attr, op, value?} (all of them hold).`);
  return v.map((c): Condition => {
    if (!c || typeof c.attr !== "string" || !c.attr.trim() || !(CONDITION_OPS as readonly string[]).includes(c.op) || (c.op !== "exists" && typeof c.value !== "string"))
      throw new RegError("register/bad-request", `A condition is {attr, op: ${CONDITION_OPS.join("|")}, value} (exists takes no value).`);
    return { attr: c.attr.trim(), op: c.op, ...(c.op !== "exists" ? { value: c.value as string } : {}) };
  });
}
const whenText = (w: Condition[] | undefined) => (w?.length ? `（当 ${w.map((c) => `${c.attr} ${c.op}${c.value !== undefined ? ` ${c.value}` : ""}`).join(" 且 ")}）` : "");
function endpointText(e: ChainModuleEndpoint): string {
  const c = e.channel;
  const what = c.type === "s2s" ? `S2S ${c.service ? `${c.service}/` : ""}${c.port}` : c.type === "mq" ? `MQ ${c.exchange}/${c.routingKey}` : portOf(e) ? `端口 ${e.step ?? portOf(e)}` : `${e.step ?? e.component ?? c.system}（写出 NiFi）`;
  return `${what}${e.relationship ? ` ${e.relationship}` : ""}${whenText(e.when)}`;
}

export class RegisterChain {
  private d: RegisterChainDeps;
  constructor(d: RegisterChainDeps) { this.d = d; }

  private reader(): GroupReader {
    if (!this.d.reader) throw new RegError("register/executor-old", "This Deployer cannot read groups from the service executor yet.");
    return this.d.reader;
  }

  /** nifi-groups on exactly these groups (GROUPS_PER_READ at a time), the answers' topologies put together. */
  async scan(service: string, ids: string[]): Promise<{ groups: Map<string, GroupInfo>; topology: Topology | null }> {
    const groups = new Map<string, GroupInfo>();
    let topology: Topology | null = null;
    const all = [...new Set(ids.map((x) => x.toLowerCase()))];
    for (let i = 0; i < all.length; i += GROUPS_PER_READ) {
      const s = await this.reader().scan(service, all.slice(i, i + GROUPS_PER_READ));
      for (const g of s.groups) groups.set(g.id.toLowerCase(), g);
      topology = mergeTopology(topology, s.topology);
    }
    return { groups, topology };
  }

  /** Every managed service (S2S pairs by address over all of them), no topology yet. */
  private services(): ChainService[] {
    const addresses = serviceAddresses(this.d.store);
    return [...this.d.store.standalones(), ...this.d.store.clusters()].map((s) => ({ id: s.id, addresses: [...(addresses.get(s.id) ?? [])], linkTemplate: linkTemplate(s.webUrl, s.version) }));
  }

  /** The registered shared modules in chain()'s shape (one per registered group of a module). */
  modules(except?: string): ChainModule[] {
    const out: ChainModule[] = [];
    for (const m of this.d.store.sharedModules()) {
      if (m.id === except) continue;
      for (const r of this.d.store.flowRegistrations({ owner: m.id })) {
        out.push({ id: m.id, name: m.name, service: r.service, group: { id: r.groupId, name: r.groupName }, link: r.link, entries: m.entries as ChainModuleEndpoint[], exits: m.exits as ChainModuleEndpoint[] });
      }
    }
    return out;
  }

  /** The schedule definitions through the e2e sources of these services (the environment's, read once each, merged). */
  private async scheduleRows(services: string[], notes: string[]): Promise<ScheduleRows | undefined> {
    if (!this.d.schedules) return undefined;
    const headers = new Map<string, Row>(), details = new Map<string, Row>();
    let any = false;
    for (const s of services) {
      let got: ScheduleRows | null;
      try { got = await this.d.schedules(s); } catch (error) { notes.push(`${s} 的 e2e_trace schedule 定义没读到（${(error as Error).message}），这次没按 schedule 串。`); continue; }
      if (!got) continue;
      any = true;
      for (const h of got.headers) headers.set(String(h.schedule_id), h);
      for (const r of got.details) details.set(`${r.schedule_id}|${r.schedule_seq}|${r.worker_id}`, r);
    }
    return any ? { headers: [...headers.values()], details: [...details.values()] } : undefined;
  }

  /** chain() on what NiFi has now for these groups. */
  async chainOf(groups: GroupRef[], o: { name?: string; flow?: string; handoffs?: ChainHandoff[]; placements?: WorkerPlace[]; modules?: ChainModule[] } = {}): Promise<Preview> {
    const services = this.services();
    const byService = new Map<string, string[]>();
    for (const g of groups) byService.set(g.service, [...(byService.get(g.service) ?? []), g.group]);
    // The registered groups and the groups around them (an S2S sender in a whole-canvas topology is named by the unit
    // under root, an ancestor of the registered group: not an unregistered sender).
    const near = new Set<string>();
    for (const [svc, ids] of byService) {
      const s = services.find((x) => x.id === svc);
      if (!s) continue;
      s.topology = (await this.scan(svc, ids)).topology;
      for (const g of s.topology?.groups ?? []) {
        if (!ids.includes(g.id)) continue;
        near.add(`${svc}\0${g.id}`);
        for (const p of g.path ?? []) near.add(`${svc}\0${p.id}`);
      }
    }
    const notes: string[] = [];
    const schedules = await this.scheduleRows([...byService.keys()], notes);
    const senders = sendersOf(services.map((s) => ({ service: s.id, topology: (this.d.store.latestTopology(s.id)?.body as Topology | undefined) ?? null })))
      .filter((x) => !near.has(`${x.service}\0${x.group.id}`));
    const p = chain({
      name: o.name ?? "", ...(o.flow ? { flow: o.flow } : {}),
      groups: groups.map((g) => ({ service: g.service, group: g.group, slice: g.slice ?? "*", link: g.link ?? null })),
      services, modules: o.modules ?? this.modules(), handoffs: o.handoffs ?? [], senders, ...(schedules ? { schedules } : {}),
      placements: (o.placements ?? []).map((x) => ({ schedule: x.schedule, worker: x.worker, service: x.service, group: x.group, quote: x.quote })),
    });
    if (!schedules && !notes.length) notes.push(this.d.schedules ? "这些服务没有配置 e2e_trace 或没读到 schedule 定义，这次只按画布串，没有 schedule 这部分。" : "这个 Deployer 没接 e2e_trace，这次只按画布串，没有 schedule 这部分。");
    p.notes.push(...notes);
    return p;
  }

  /** register preview (§7.5): a draft's groups (the preview is kept on the draft), a business's (plus links), or links. */
  async preview(b: Record<string, unknown>): Promise<Preview> {
    const store = this.d.store;
    const told = handoffsOf(b.handoffs);
    if (b.name !== undefined && (typeof b.name !== "string" || b.name.length > NAME_MAX)) throw new RegError("register/bad-request", `name is at most ${NAME_MAX} characters.`);
    if (b.draft !== undefined) {
      const d = this.d.registrations.draft(b.draft);
      if (b.links !== undefined) throw new RegError("register/bad-request", "A draft is previewed with its own groups: add links with register add and the draft.");
      if (!d.groups.length) throw new RegError("register/empty", "The draft has no group yet: add a link first.");
      const p = await this.chainOf(d.groups.map((g) => ({ service: g.service, group: g.group.id, link: g.link })),
        { name: (b.name as string | undefined) ?? d.name ?? "", ...(d.flow ? { flow: d.flow } : {}), handoffs: [...d.handoffs.map(toChain), ...told], placements: d.places });
      store.putRegistrationDraft({ ...this.d.registrations.draft(d.id), preview: p });
      return p;
    }
    const groups: GroupRef[] = [];
    let name = (b.name as string | undefined) ?? "", flow: string | undefined, handoffs = told;
    if (b.flow !== undefined) {
      const f = typeof b.flow === "string" ? store.flow(b.flow) : null;
      if (!f) throw new RegError("register/not-found", `No business ${String(b.flow)}.`);
      flow = f.id;
      name ||= f.name;
      for (const r of store.flowRegistrations({ owner: f.id })) groups.push({ service: r.service, group: r.groupId, slice: r.slice, link: r.link });
      handoffs = [...store.flowHandoffs(f.id).map(toChain), ...told];
    }
    if (b.links !== undefined || !groups.length) {
      const { added } = await this.d.registrations.stage(b.links, flow ?? "preview", []);
      groups.push(...added.map((a) => ({ service: a.service, group: a.group.id, link: a.link })));
    }
    return this.chainOf(groups, { name, ...(flow ? { flow, placements: store.workerPlaces(flow) } : {}), handoffs });
  }

  // --- shared modules ------------------------------------------------------------------------------------------------

  /** The module's entries: its input ports (an S2S one, or a 1.x root remote port feeding it, is an S2S entry too), or MQ. */
  private entriesOf(v: unknown, service: string, info: GroupInfo, t: Topology | null): ChainModuleEndpoint[] {
    if (!Array.isArray(v) || !v.length || v.length > ENDPOINTS_MAX) throw new RegError("register/bad-request", `entries is a list of 1 to ${ENDPOINTS_MAX} {service?, port} or {service?, mq: {exchange, routingKey}}.`);
    const ins = (Array.isArray(info.inputPorts) ? info.inputPorts : []) as Port[];
    const out: ChainModuleEndpoint[] = [];
    for (const x of v as Record<string, unknown>[]) {
      if (!x || typeof x !== "object") throw new RegError("register/bad-request", "An entry is {service?, port} or {service?, mq}.");
      if (x.service !== undefined && x.service !== service) throw new RegError("register/bad-request", `An entry is on the module's own service (${service}).`);
      const mq = x.mq as Record<string, unknown> | undefined;
      if (mq !== undefined) {
        if (!mq || typeof mq.exchange !== "string" || !mq.exchange || typeof mq.routingKey !== "string" || !mq.routingKey) throw new RegError("register/bad-request", "mq is {exchange, routingKey}.");
        out.push({ id: `mq-${out.length + 1}`, channel: { type: "mq", exchange: mq.exchange, routingKey: mq.routingKey } });
        continue;
      }
      const p = this.port(ins, x.port, "input", info);
      if (p.remote) { out.push({ id: `s2s-${p.id.slice(0, 8)}`, step: p.name, channel: { type: "s2s", port: p.name }, component: p.id }); continue; }
      out.push({ id: `port-${p.id.slice(0, 8)}`, step: p.name, channel: { type: "external", system: `port:${p.id}` }, component: p.id });
      // NiFi 1.x: remote ports are on root only; one connected to this port hands the module what it gets over S2S.
      for (const n of t?.neighbors ?? []) {
        if (n.group === info.id && n.side === "in" && n.port.id === p.id && n.other.kind === "port" && n.other.remote)
          out.push({ id: `s2s-${n.other.id.slice(0, 8)}`, step: p.name, channel: { type: "s2s", port: n.other.name }, component: p.id });
      }
    }
    return out;
  }

  /** The module's exits: an output port (an RPG beside it makes an S2S exit too), an RPG port in it, or an end (MQ with mq). */
  private exitsOf(v: unknown, service: string, info: GroupInfo, t: Topology | null): ChainModuleEndpoint[] {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > ENDPOINTS_MAX) throw new RegError("register/bad-request", `exits is a list of at most ${ENDPOINTS_MAX} {service?, component, relationship?, when?, mq?}.`);
    const outs = (Array.isArray(info.outputPorts) ? info.outputPorts : []) as Port[];
    const s2s = (Array.isArray(info.s2sOut) ? info.s2sOut : []) as Topology["s2sOut"];
    const ends = (Array.isArray(info.ends) ? info.ends : []) as NonNullable<Topology["ends"]>;
    const addresses = serviceAddresses(this.d.store);
    const target = (urls: string[]) => [...addresses].find(([, set]) => urls.some((u) => set.has(addressOf(u) ?? "")))?.[0];
    const out: ChainModuleEndpoint[] = [];
    for (const x of v as Record<string, unknown>[]) {
      if (!x || typeof x !== "object") throw new RegError("register/bad-request", "An exit is {service?, component, relationship?, when?, mq?}.");
      if (x.service !== undefined && x.service !== service) throw new RegError("register/bad-request", `An exit is on the module's own service (${service}).`);
      if (typeof x.component !== "string" || !x.component.trim()) throw new RegError("register/bad-request", "An exit's component is the output port, RPG port or writing processor (id or name) the data leaves by.");
      if (x.relationship !== undefined && (typeof x.relationship !== "string" || !x.relationship)) throw new RegError("register/bad-request", "relationship is a relationship name.");
      const when = conditions(x.when);
      const more = { ...(x.relationship ? { relationship: x.relationship as string } : {}), ...(when ? { when } : {}) };
      const c = x.component.trim();
      const id = () => `exit-${out.length + 1}`;
      const mq = x.mq as Record<string, unknown> | undefined;
      if (mq !== undefined && (!mq || typeof mq.exchange !== "string" || !mq.exchange || typeof mq.routingKey !== "string" || !mq.routingKey)) throw new RegError("register/bad-request", "mq is {exchange, routingKey}.");
      const port = outs.find((p) => p.id === c) ?? one(outs.filter((p) => p.name === c), c);
      if (port && !mq) {
        out.push({ id: id(), step: port.name, channel: { type: "external", system: `port:${port.id}` }, component: port.id, ...more });
        for (const n of t?.neighbors ?? []) {
          if (n.group !== info.id || n.side !== "out" || n.port.id !== port.id || n.other.kind !== "rpg") continue;
          const to = target(n.other.targets ?? []);
          if (to) out.push({ id: id(), step: port.name, channel: { type: "s2s", service: to, port: n.other.port?.name ?? n.other.name }, component: port.id, ...more });
        }
        continue;
      }
      const rpg = s2s.find((o) => o.ref === c || (o.sources ?? []).some((s) => s.id === c)) ?? one(s2s.filter((o) => o.name === c || (o.sources ?? []).some((s) => s.name === c)), c);
      if (rpg && !mq) {
        const to = target(rpg.targets);
        if (!to) throw new RegError("register/bad-request", `The S2S of ${c} goes to ${rpg.targets.join(", ")}, not a managed service: the module's exit there leaves NiFi (name the writing processor, or register that NiFi first).`);
        out.push({ id: id(), step: rpg.name, channel: { type: "s2s", service: to, port: rpg.name }, component: rpg.sources?.[0]?.id ?? rpg.ref, ...more });
        continue;
      }
      const end = ends.find((e) => e.id === c) ?? one(ends.filter((e) => e.name === c), c);
      if (end) {
        out.push({ id: id(), step: end.name, channel: mq ? { type: "mq", exchange: mq.exchange as string, routingKey: mq.routingKey as string } : { type: "external", system: end.name }, component: end.id, ...more });
        continue;
      }
      throw new RegError("register/port-missing", `${info.name ?? info.id} has no output port, RPG port or writing processor ${c}.`, {
        candidates: [...outs.map((p) => ({ component: p.id, name: p.name, kind: "output-port" })), ...s2s.map((o) => ({ component: o.ref, name: o.name, kind: "s2s" })), ...ends.map((e) => ({ component: e.id, name: e.name, kind: "end" }))],
      });
    }
    return out;
  }

  private port(ports: Port[], v: unknown, side: "input", info: GroupInfo): Port {
    if (typeof v !== "string" || !v.trim()) throw new RegError("register/bad-request", `An entry's port is the module's ${side} port (id or name).`);
    const c = v.trim();
    const p = ports.find((x) => x.id === c) ?? one(ports.filter((x) => x.name === c), c);
    if (!p) throw new RegError("register/port-missing", `${info.name ?? info.id} has no ${side} port ${c}.`, { candidates: ports.map((x) => ({ component: x.id, name: x.name, ...(x.remote ? { remote: true } : {}) })) });
    return p;
  }

  /** The businesses joined to a module: a registered group across one of its declared ports (canvas), an S2S sender to
   *  its entry or the receiver of its S2S exit (the services' latest topologies). Exact registered groups only. */
  usersOf(m: ChainModule, t: Topology | null): ModuleUser[] {
    const store = this.d.store;
    const users = new Map<string, ModuleUser>();
    const own = (service: string, group: string) => store.flowRegistrations({ service }).find((r) => r.groupId === group && r.role === "segment")?.owner;
    const add = (flow: string | undefined, via: string) => {
      if (!flow) return;
      const u = users.get(flow) ?? { flow, name: store.flow(flow)?.name ?? flow, via: [] };
      if (!u.via.includes(via)) u.via.push(via);
      users.set(flow, u);
    };
    const ins = new Set(m.entries.map(portOf).filter(Boolean)), outs = new Set(m.exits.map((e) => portOf(e) ?? e.component).filter(Boolean));
    for (const n of t?.neighbors ?? []) {
      if (n.group !== m.group.id || n.other.kind !== "group" || !(n.side === "in" ? ins : outs).has(n.port.id)) continue;
      add(own(m.service, n.other.id), n.side === "in" ? `${n.other.name} → ${n.port.name}` : `${n.port.name} → ${n.other.name}`);
    }
    const addresses = serviceAddresses(store);
    const mine = addresses.get(m.service) ?? new Set<string>();
    const latest = [...store.standalones(), ...store.clusters()].map((s) => ({ service: s.id, topology: (store.latestTopology(s.id)?.body as Topology | undefined) ?? null }));
    const s2sIn = new Set(m.entries.filter((e) => e.channel.type === "s2s").map((e) => e.channel.port));
    for (const x of sendersOf(latest)) {
      if (s2sIn.has(x.port) && x.targets.some((u) => mine.has(addressOf(u) ?? ""))) add(own(x.service, x.group.id), `S2S ${x.service} → ${m.service}/${x.port}`);
    }
    for (const e of m.exits) {
      if (e.channel.type !== "s2s" || !e.channel.service) continue;
      const t2 = latest.find((l) => l.service === e.channel.service)?.topology;
      for (const p of t2?.s2sIn ?? []) if (p.name === e.channel.port) add(own(e.channel.service, p.group), `S2S ${m.service} → ${e.channel.service}/${p.name}`);
    }
    return [...users.values()];
  }

  /** The module's own preview: one shared segment, its entries and exits, ports with connections it does not declare. */
  private modulePreview(m: ChainModule, info: GroupInfo, t: Topology | null, path: string): Preview {
    const seg = "m1";
    const declared = new Set([...m.entries, ...m.exits].map((e) => portOf(e) ?? e.component));
    const notes: string[] = [];
    for (const n of t?.neighbors ?? []) {
      if (n.group !== m.group.id || declared.has(n.port.id)) continue;
      notes.push(`${n.side === "in" ? "输入" : "输出"}端口 ${n.port.name} 连着 ${n.other.name}，没有列为模块的${n.side === "in" ? "入口" : "出口"}。`);
    }
    if (m.exits.length > 1 && m.exits.some((e) => !e.when?.length)) notes.push("模块有几个出口，其中有的没写分流条件：按业务追数据时，没条件的出口对所有数据都算。");
    return {
      name: m.name,
      groups: [{ ref: "g1", service: m.service, group: { id: m.group.id, name: m.group.name, path }, slice: "*", link: m.link ?? null, state: "ok", segment: seg }],
      segments: [{ id: seg, service: m.service, group: m.group, slice: "*", role: "shared", module: m.id, origin: "topology", steps: [], link: m.link ?? null }],
      layers: [[seg]], edges: [],
      entries: m.entries.map((e) => ({ segment: seg, label: endpointText(e), ...(e.channel.type !== "external" ? { channel: e.channel.type === "s2s" ? `s2s:${m.service}/${e.channel.port}` : `mq:${e.channel.exchange}/${e.channel.routingKey}` } : {}), ...(e.component ? { component: e.component } : {}) })),
      exits: m.exits.map((e) => ({ segment: seg, label: endpointText(e), ...(e.component ? { component: e.component } : {}) })),
      gaps: [], notes: [...notes, ...(info.exists ? [] : ["组不在 NiFi 上了。"])],
    };
  }

  /** register shared (§7.5, §7.8 1) without commit: the module's preview and who would use it. */
  async shared(b: Record<string, unknown>, _actor: Actor) {
    const p = await this.sharedPlan(b);
    return { ...p.preview, users: p.users, ...(p.takeover ? { takeover: p.takeover } : {}) };
  }

  /** A shared module checked and read, nothing written: its id (new or the one changed), endpoints, the businesses
   *  joined to it by its ports and the business it is taken from (takeover). */
  async sharedPlan(b: Record<string, unknown>): Promise<SharedPlan> {
    const store = this.d.store;
    let mod: SharedModule | null = null;
    if (b.module !== undefined) {
      mod = typeof b.module === "string" ? store.sharedModule(b.module) : null;
      if (!mod) throw new RegError("register/not-found", `No shared module ${String(b.module)}.`);
    }
    const name = typeof b.name === "string" && b.name.trim() ? b.name.trim() : mod?.name;
    if (!name || name.length > NAME_MAX) throw new RegError("register/bad-request", `name is 1 to ${NAME_MAX} characters.`);
    const asks = linkAsks(b.links);
    if (asks.length !== 1) throw new RegError("register/bad-request", "A shared module is one group: give one link (another shared part is another module).");
    const r = resolveLink(store, asks[0]!);

    // Who has the group now; a business that has exactly this group gives it up with takeover (§7.8 1).
    let takeover: { flow: string; name: string } | null = null;
    try { await this.d.registrations.stage([asks[0]], mod?.id ?? "shm:new", []); } catch (error) {
      if (!(error instanceof RegError) || error.code !== "register/group-taken") throw error;
      const taken = (error.extra.taken ?? []) as Taken[];
      const movable = taken.length === 1 && taken[0]!.relation === "same" && taken[0]!.by.kind === "flow";
      if (!movable) throw error;
      if (b.takeover !== true) throw new RegError("register/group-taken", `${error.message} With takeover: true it leaves "${taken[0]!.by.name}" and becomes this module; that business is joined to the module by its ports.`, { ...error.extra, takeover: true });
      takeover = { flow: taken[0]!.by.id, name: taken[0]!.by.name };
      if (!store.flowRegistrations({ owner: takeover.flow }).some((x) => !(x.service === r.service && x.groupId === r.groupId)))
        throw new RegError("register/empty", `"${takeover.name}" has no other group: the whole business would be the module. Unregister it first, or register the module only when another business shares the group.`);
    }

    const { groups, topology } = await this.scan(r.service, [r.groupId]);
    const info = groups.get(r.groupId);
    if (!info?.exists) throw new RegError("register/group-missing", `This group does not exist in NiFi: ${r.groupId} (${r.service}).`, { groups: [{ service: r.service, group: r.groupId, link: r.link }] });
    const entries = this.entriesOf(b.entries, r.service, info, topology);
    const exits = this.exitsOf(b.exits, r.service, info, topology);
    const path = crumbs(info);
    const draft: ChainModule = { id: mod?.id ?? "new", name, service: r.service, group: { id: r.groupId, name: info.name ?? r.groupId }, link: r.link, entries, exits };
    const users = this.usersOf(draft, topology);
    const preview = this.modulePreview(draft, info, topology, path);
    const id = mod?.id ?? `shm_${randomBytes(6).toString("hex")}`;
    return { id, mod, name, service: r.service, group: draft.group, path, link: r.link, entries, exits, users, takeover, preview,
      module: { ...draft, id } };
  }

  /** Writes a shared module (inside the publish's transaction, step 5): its registration and endpoints, the line in its
   *  history and in each joined business's (with the revisions the publish made). */
  sharedWrite(p: SharedPlan, actor: Actor, revisions?: Map<string, number>) {
    const store = this.d.store;
    const rev = (s: string) => revisions?.get(s) ?? null;
    const verdict = (s: string) => (revisions?.has(s) ? "published" as const : null);
    const ports = `入口 ${p.entries.map(endpointText).join("、")}${p.exits.length ? `；出口 ${p.exits.map(endpointText).join("、")}` : "；没有出口"}`;
    store.flowTransaction(() => {
      if (p.takeover) store.removeFlowRegistration(p.takeover.flow, p.service, p.group.id);
      const same = p.mod ? store.flowRegistrations({ owner: p.mod.id }).some((o) => o.service === p.service && o.groupId === p.group.id) : false;
      if (p.mod && !same) store.removeFlowRegistrations(p.mod.id);
      store.putSharedModule({ id: p.id, name: p.name, createdBy: actor.id, entries: p.entries, exits: p.exits });
      if (!same) store.addFlowRegistrations([{ owner: p.id, role: "shared", service: p.service, groupId: p.group.id, groupName: p.group.name, groupPath: p.path, slice: "*", link: p.link, registeredBy: actor.id }]);
      store.addFlowChange({ flow: p.id, service: p.service, by: actor.id, kind: "shared", revision: rev(p.service), verdict: verdict(p.service),
        text: `${p.mod ? "改了" : "登记了"}公共模块"${p.name}"：组"${p.group.name}"（${p.path}）${p.takeover ? `，原属业务"${p.takeover.name}"` : ""}；${ports}` });
      if (p.takeover) {
        store.addFlowChange({ flow: p.takeover.flow, service: p.service, by: actor.id, kind: "shared", revision: rev(p.service), verdict: verdict(p.service), text: `组"${p.group.name}"移出本业务，转成公共模块"${p.name}"，本业务按端口接上它` });
        store.auditFlow(actor, p.takeover.flow, "register-shared");
      }
      for (const u of p.users) {
        if (u.flow === p.takeover?.flow) continue;
        store.addFlowChange({ flow: u.flow, service: p.service, by: actor.id, kind: "shared", revision: rev(p.service), verdict: verdict(p.service), text: `按端口接上公共模块"${p.name}"（${u.via.join("、")}）` });
      }
    });
  }

  /** The businesses joined to a module now (its group read from NiFi). */
  async moduleUsers(id: unknown): Promise<{ mod: SharedModule; users: ModuleUser[] }> {
    const mod = typeof id === "string" ? this.d.store.sharedModule(id) : null;
    if (!mod) throw new RegError("register/not-found", `No shared module ${String(id)}.`);
    const users = new Map<string, ModuleUser>();
    for (const m of this.modules().filter((x) => x.id === mod.id)) {
      const { topology } = await this.scan(m.service, [m.group.id]);
      for (const u of this.usersOf(m, topology)) users.set(u.flow, u);
    }
    return { mod, users: [...users.values()] };
  }

  /** GET …/modules/<id>: the module's view and who uses it now. */
  async moduleDetail(id: string) {
    const { mod, users } = await this.moduleUsers(id);
    return { ...moduleViews(this.d.store).find((v) => v.id === mod.id)!, users };
  }

  /** register/module-in-use when a business is still joined to the module (unregister asks this first). */
  async assertModuleFree(id: unknown) {
    const { mod, users: list } = await this.moduleUsers(id);
    if (list.length) {
      throw new RegError("register/module-in-use", `The shared module "${mod.name}" is still joined to ${list.map((u) => `"${u.name}"`).join(", ")}: take those businesses off it first (their groups or connections), then unregister it.`, { users: list });
    }
  }
}

/** §7.2 ②: how long the module's own health looks back. */
export const MODULE_HEALTH_MINUTES = 60;
export type ModuleLight = "ok" | "idle" | "attention" | "unknown";
export interface ModuleHealth { light: ModuleLight; minutes: number; flowfilesIn: number; flowfilesOut: number; text: string }

/** A module's health is the module's own (§7.2 ②): its groups' counts in the last hour, never split over the businesses
 *  that use it. In and nothing out on a module with exits is attention; no counts at all is unknown. */
export function moduleHealth(store: Store, m: SharedModule, now = new Date()): ModuleHealth {
  const since = new Date(now.getTime() - MODULE_HEALTH_MINUTES * 60_000).toISOString();
  let rows = 0, inN = 0, outN = 0;
  for (const r of store.flowRegistrations({ owner: m.id })) {
    for (const t of store.flowCountTotals(r.service, since)) {
      if (t.kind !== "group" || t.ref !== r.groupId) continue;
      rows++; inN += t.flowfilesIn; outN += t.flowfilesOut;
    }
  }
  const base = { minutes: MODULE_HEALTH_MINUTES, flowfilesIn: inN, flowfilesOut: outN };
  if (!rows) return { ...base, light: "unknown", text: `最近 ${MODULE_HEALTH_MINUTES} 分钟没有这个模块的组的计数（执行器还没按组读到它）。` };
  if (!inN && !outN) return { ...base, light: "idle", text: `最近 ${MODULE_HEALTH_MINUTES} 分钟没有数据经过。` };
  if (inN && !outN && m.exits.length) return { ...base, light: "attention", text: `最近 ${MODULE_HEALTH_MINUTES} 分钟进了 ${inN} 条，没有出。` };
  return { ...base, light: "ok", text: `最近 ${MODULE_HEALTH_MINUTES} 分钟进 ${inN} 条、出 ${outN} 条。` };
}

/** The shared modules as describe and the pages read them: one object each, its health is the module's own (§7.2). */
export function moduleViews(store: Store, service?: string, now = new Date()) {
  const models = store.flowModels();
  return store.sharedModules().map((m) => ({
    id: m.id, name: m.name,
    groups: store.flowRegistrations({ owner: m.id }).map((r) => ({ service: r.service, group: { id: r.groupId, name: r.groupName, path: r.groupPath }, link: r.link })),
    // Step 5: where the published models have it (role shared, its module id): the segment the trace passes through.
    segments: models.flatMap((x) => x.model.segments.filter((s) => s.module === m.id).map((s) => ({ service: x.service, segment: s.id, revision: x.revision }))),
    entries: (m.entries as ChainModuleEndpoint[]).map((e) => ({ id: e.id, text: endpointText(e) })),
    exits: (m.exits as ChainModuleEndpoint[]).map((e) => ({ id: e.id, text: endpointText(e), ...(e.when ? { when: e.when } : {}) })),
    health: moduleHealth(store, m, now),
    createdBy: m.createdBy, updatedAt: m.updatedAt,
  })).filter((v) => !service || v.groups.some((g) => g.service === service));
}

/** The one item named c, or none; two with the name is the caller's to say by id. */
function one<T extends { id?: string; ref?: string }>(xs: T[], c: string): T | undefined {
  if (xs.length > 1) throw new RegError("register/bad-request", `More than one component is named ${c}: give its id (${xs.map((x) => x.id ?? x.ref).join(", ")}).`);
  return xs[0];
}
