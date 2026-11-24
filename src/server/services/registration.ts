// S39 business-registration §7.1, §7.5, §7.6 (step 2): a business registers the process groups it runs through. This
// module holds the link parsing (NiFi 1.x and 2.x UI addresses -> group id and managed service), the checks that
// precede a registration (the group exists, nobody else has it) and the registration's own actions: add, remove,
// rename, unregister. preview and shared (step 4) are in register-chain.ts; commit and the publishing of every change
// (step 5) in register-publish.ts, which checks with these first and writes with them inside its transaction. The
// routes (registration-routes.ts) only translate a RegError into HTTP.

import { randomBytes } from "node:crypto";
import { StoreError, type Actor, type FlowRegistration, type RegistrationDraft, type RegistrationDraftGroup, type RegistrationDraftHandoff, type Store, type WorkerPlace } from "../store.ts";
import { memberAddresses } from "./skeleton.ts";
import type { ServiceMember } from "./draft.ts";
import type { Topology } from "./flowcounts.ts";

/** §7.4: the most groups one nifi-groups read asks for. */
export const GROUPS_PER_READ = 20;
/** §7.5: links per request. */
export const LINKS_MAX = 20;
export const NAME_MAX = 200;
export const QUOTE_MAX = 2000;
/** §7.9: a draft id; short enough and made of the characters Workbench allows in a page context ([\w .:@/-]{1,64}). */
export const DRAFT_ID = /^rgd_[0-9a-f]{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** §7.5 error codes, with the HTTP status each one answers with. */
export type RegisterCode =
  | "register/bad-request" | "register/bad-link" | "register/root-group" | "register/unknown-address" | "register/ambiguous-address"
  | "register/group-missing" | "register/executor-old" | "register/executor-offline" | "register/group-taken" | "register/not-found"
  | "register/empty" | "register/not-implemented" | "register/bad-handoff" | "register/port-missing" | "register/module-in-use"
  | "register/gaps-open" | "register/gate-rejected" | "register/person-only";
const STATUS: Record<RegisterCode, 400 | 403 | 404 | 409 | 501 | 503> = {
  "register/person-only": 403, "register/bad-request": 400, "register/bad-handoff": 400, "register/bad-link": 400, "register/root-group": 400, "register/unknown-address": 400, "register/ambiguous-address": 400,
  "register/group-missing": 404, "register/not-found": 404, "register/port-missing": 404, "register/group-taken": 409, "register/empty": 409, "register/module-in-use": 409,
  "register/gaps-open": 409, "register/gate-rejected": 409,
  "register/executor-old": 503, "register/executor-offline": 503, "register/not-implemented": 501,
};

export class RegError extends Error {
  readonly code: RegisterCode;
  readonly status: 400 | 403 | 404 | 409 | 501 | 503;
  /** More of the answer than the message (the services to choose from, who has the group...). */
  readonly extra: Record<string, unknown>;
  constructor(code: RegisterCode, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.status = STATUS[code];
    this.extra = extra;
  }
}

// --- the "read a group now" the executor does (step 1, §7.4) -------------------------------------------------

/** One group as the service executor's nifi-groups read gives it (§7.4); an absent group is exists: false. */
export interface GroupInfo {
  id: string;
  exists: boolean;
  name?: string;
  /** root to the parent group. */
  path?: { id: string; name: string }[];
  [more: string]: unknown;
}

/** One nifi-groups answer: the groups, and the scoped topology of exactly those groups (§7.4, scope "groups"; the
 *  chaining's input, step 3). */
export interface GroupScan { groups: GroupInfo[]; topology: Topology | null }

/** Reads groups of a managed service through the first usable member's service executor (job kind nifi-groups, at most
 *  GROUPS_PER_READ ids). Throws RegError register/executor-old (no nifi-groups@1 in the heartbeat) or register/executor-offline
 *  (no member answers). read gives the groups only, scan the topology with them. Step 1 provides the real one; tests pass a fake. */
export interface GroupReader {
  read(service: string, ids: string[]): Promise<GroupInfo[]>;
  scan(service: string, ids: string[]): Promise<GroupScan>;
}

// --- links (§7.6) ---------------------------------------------------------------------------------------------

export interface ParsedLink { link: string; groupId: string; version: "1.x" | "2.x"; address: string }

/** The group a NiFi UI address points at. 2.x first (…/nifi/#/process-groups/<id>, with /Processor/<id>, /bulk/…, /edit
 *  after it), then 1.x (…/nifi/?processGroupId=<id>&componentIds=…). root is refused: only groups are registered. */
export function parseLink(link: string): ParsedLink {
  let url: URL;
  try { url = new URL(link.trim()); } catch { throw new RegError("register/bad-link", `Not an address: ${link}`); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new RegError("register/bad-link", `Not an http(s) address: ${link}`);
  let id: string | undefined, version: "1.x" | "2.x" = "2.x";
  const two = /^#\/process-groups\/([0-9a-f-]{36}|root)(?:[\/?]|$)/i.exec(url.hash);
  if (two) id = two[1];
  else {
    const one = url.searchParams.get("processGroupId");
    if (one) { id = one; version = "1.x"; }
  }
  if (id === undefined) throw new RegError("register/bad-link", `No process group in this address (a NiFi 1.x link has ?processGroupId=…, a 2.x link #/process-groups/…): ${link}`);
  if (id.toLowerCase() === "root") throw new RegError("register/root-group", "This link is the root canvas: the whole canvas is not registered. Open the group the business runs in, and copy that link.");
  if (!UUID.test(id)) throw new RegError("register/bad-link", `The group id in this address is not an id: ${link}`);
  return { link: link.trim(), groupId: id.toLowerCase(), version, address: addressKey(url) };
}

/** host:port as the member address set has it: lower case, no trailing dot, the scheme's port when none. */
function addressKey(url: URL): string {
  return `${url.hostname.toLowerCase().replace(/\.$/, "")}:${url.port || (url.protocol === "http:" ? "80" : "443")}`;
}

/** host:port of an address's service entry (webUrl), or null. */
function webKey(webUrl: string | null | undefined): string | null {
  if (!webUrl) return null;
  try { return addressKey(new URL(webUrl)); } catch { return null; }
}

/** Every managed service's addresses: its members' (host, node address, nifi.web.https.host with the HTTPS and HTTP port) and
 *  the service's web address. Any node of a cluster is the cluster. */
export function serviceAddresses(store: Store): Map<string, Set<string>> {
  const members: { service: string; m: ServiceMember }[] = [
    ...store.standalones().map((s) => ({ service: s.id, m: s.member })),
    ...store.clusters().flatMap((c) => c.nodes.map((m) => ({ service: c.id, m }))),
  ];
  const out = memberAddresses(store, members, { http: true });
  for (const s of [...store.standalones(), ...store.clusters()]) {
    const web = webKey(s.webUrl);
    const set = out.get(s.id) ?? new Set<string>();
    if (web) set.add(web);
    out.set(s.id, set);
  }
  return out;
}

export interface LinkAsk { link: string; service?: string }
export interface ResolvedLink extends ParsedLink { service: string }

/** The links of a request: 1 to LINKS_MAX strings or {link, service?}. */
export function linkAsks(v: unknown): LinkAsk[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > LINKS_MAX) throw new RegError("register/bad-request", `links is a list of 1 to ${LINKS_MAX} links.`);
  return v.map((x): LinkAsk => {
    if (typeof x === "string" && x.trim()) return { link: x };
    if (x && typeof x === "object" && typeof (x as LinkAsk).link === "string" && (x as LinkAsk).link.trim()) {
      const s = (x as LinkAsk).service;
      if (s !== undefined && (typeof s !== "string" || !s)) throw new RegError("register/bad-request", "A link's service is a service id.");
      return s === undefined ? { link: (x as LinkAsk).link } : { link: (x as LinkAsk).link, service: s };
    }
    throw new RegError("register/bad-request", "Each link is a string or {link, service?}.");
  });
}

/** Which managed service an address belongs to; with a service hint, only the group id is taken from the link. */
export function resolveLink(store: Store, ask: LinkAsk, addresses = serviceAddresses(store)): ResolvedLink {
  const parsed = parseLink(ask.link);
  const known = [...addresses.keys()].sort();
  if (ask.service !== undefined) {
    if (!known.includes(ask.service)) throw new RegError("register/unknown-address", `No managed service ${ask.service}.`, { services: known });
    return { ...parsed, service: ask.service };
  }
  const hits = [...addresses].filter(([, set]) => set.has(parsed.address)).map(([id]) => id).sort();
  if (hits.length === 1) return { ...parsed, service: hits[0]! };
  if (hits.length > 1) throw new RegError("register/ambiguous-address", `The address ${parsed.address} belongs to more than one managed service (${hits.join(", ")}): say which one.`, { services: hits });
  throw new RegError("register/unknown-address", `The address ${parsed.address} is not a managed service's (a proxy, a load balancer or another name for it?): say which service the link is of.`, { address: parsed.address, services: known });
}

// --- the registration -------------------------------------------------------------------------------------------

export interface RegisteredGroup { service: string; group: { id: string; name: string; path: string }; link: string | null }
const crumbs = (info: GroupInfo): string => [...(info.path ?? []).map((p) => p.name), info.name ?? info.id].join(" / ");

/** Who has a group a person wants: the business or module, and how the two groups lie to each other. */
export interface Taken {
  service: string; group: { id: string; name: string };
  relation: "same" | "inside" | "contains";
  by: { kind: "flow" | "module"; id: string; name: string; registeredBy: string };
}

export interface RegisterResult { flow: string; added: RegisteredGroup[]; unchanged: RegisteredGroup[]; revisions: { service: string; revision: number }[]; published: boolean }
/** A business's place-worker, checked, before it is written (the publish chains with it first, step 5). */
export interface WorkerPlan { flow: string; schedule: string; worker: string; place: WorkerPlace | null; had: WorkerPlace | null; groupName: string }

/** Whether a told hand-over starts or ends on a group. */
export const handoffNames = (h: RegistrationDraftHandoff, service: string, group: string) =>
  (h.from.service === service && h.from.group === group) || ("group" in h.to && h.to.service === service && h.to.group === group);

export class Registrations {
  private store: Store;
  private reader: GroupReader | undefined;

  constructor(store: Store, reader?: GroupReader) {
    this.store = store;
    this.reader = reader;
  }

  private async read(service: string, ids: string[]): Promise<Map<string, GroupInfo>> {
    if (!this.reader) throw new RegError("register/executor-old", "This Deployer cannot read groups from the service executor yet.");
    const out = new Map<string, GroupInfo>();
    for (let i = 0; i < ids.length; i += GROUPS_PER_READ) {
      for (const g of await this.reader.read(service, ids.slice(i, i + GROUPS_PER_READ))) out.set(g.id.toLowerCase(), g);
    }
    return out;
  }

  private ownerOf(owner: string): { kind: "flow" | "module"; id: string; name: string } {
    const f = this.store.flow(owner);
    if (f) return { kind: "flow", id: owner, name: f.name };
    const m = this.store.sharedModule(owner);
    return { kind: owner.startsWith("shm_") ? "module" : "flow", id: owner, name: m?.name ?? owner };
  }

  flowOf(id: unknown) {
    if (typeof id !== "string" || !id) throw new RegError("register/bad-request", "flow is a business id (flw_…).");
    const f = this.store.flow(id);
    if (!f) throw new RegError("register/not-found", `No business ${id}.`);
    return f;
  }

  /** One flow_changes row per service the action touched (§7.1); with the publish's revisions (step 5) every service it
   *  published a model of gets one too, with that revision. */
  private log(flow: string, kind: "register" | "add-group" | "remove-group" | "rename" | "unregister" | "place-worker" | "declare-handoff", actor: Actor, text: (service: string) => string, services: string[], revisions?: Map<string, number>) {
    const all = [...new Set([...services, ...(revisions?.keys() ?? [])])];
    for (const service of all.length ? all : ["-"]) this.store.addFlowChange({ flow, service, by: actor.id, kind, text: text(service), revision: revisions?.get(service) ?? null, verdict: revisions?.has(service) ? "published" : null });
  }

  /** add: the groups of these links join the business. Refused when a link's group is missing or somebody else has it. */
  async add(flowId: unknown, links: unknown, actor: Actor): Promise<RegisterResult> {
    const flow = this.flowOf(flowId);
    const { added, unchanged } = await this.stage(links, flow.id, []);
    this.store.flowTransaction(() => this.addStaged(flow.id, added, actor, "add-group"));
    return { flow: flow.id, added, unchanged, revisions: [], published: false };
  }

  /** Writes staged groups as the business's (register: the first ones of a commit). Call inside flowTransaction. */
  addStaged(flow: string, added: RegisteredGroup[], actor: Actor, kind: "register" | "add-group", revisions?: Map<string, number>, name?: string) {
    const rows: Omit<FlowRegistration, "registeredAt">[] = added.map((a) => ({ owner: flow, role: "segment", service: a.service, groupId: a.group.id, groupName: a.group.name, groupPath: a.group.path, slice: "*", link: a.link, registeredBy: actor.id }));
    try { this.store.addFlowRegistrations(rows); } catch (error) {
      if (error instanceof StoreError && error.code === "flow-registrations/taken") throw new RegError("register/group-taken", error.message, { options: TAKEN_OPTIONS });
      throw error;
    }
    const services = [...new Set(added.map((a) => a.service))];
    const groups = (s: string) => added.filter((a) => a.service === s).map((a) => `"${a.group.name}"（${a.group.path}）`).join("、");
    this.log(flow, kind, actor, (s) => kind === "register"
      ? `登记了业务"${name ?? flow}"${groups(s) ? `，本服务上的组${groups(s)}` : "，本服务上的公共模块"}`
      : groups(s) ? `登记了组${groups(s)}` : "加组后重新串联，本服务的模型随之更新", services, revisions);
    this.store.auditFlow(actor, flow, kind === "register" ? "register-commit" : "register-add");
  }

  /** The groups of these links, read from NiFi and checked: they exist, and nobody but the owner (ownKey: a business, or a
   *  draft, which owns ownGroups) has them or one around or inside them. Writes nothing. */
  async stage(links: unknown, ownKey: string, ownGroups: RegistrationDraftGroup[]): Promise<{ added: RegisteredGroup[]; unchanged: RegisteredGroup[] }> {
    const addresses = serviceAddresses(this.store);
    const resolved = this.dedupe(linkAsks(links).map((a) => resolveLink(this.store, a, addresses)));
    const byService = new Map<string, ResolvedLink[]>();
    for (const r of resolved) byService.set(r.service, [...(byService.get(r.service) ?? []), r]);

    // Read the new groups, and the groups already registered in the same services: whether one lies inside another is
    // told by the path the read gives (the registration keeps names only).
    const infos = new Map<string, Map<string, GroupInfo>>();
    for (const [service, rs] of byService) {
      const ask = new Set(rs.map((r) => r.groupId));
      for (const e of this.store.flowRegistrations({ service })) ask.add(e.groupId);
      for (const g of ownGroups) if (g.service === service) ask.add(g.group.id);
      infos.set(service, await this.read(service, [...ask]));
    }
    const missing = resolved.filter((r) => infos.get(r.service)?.get(r.groupId)?.exists !== true);
    if (missing.length) throw new RegError("register/group-missing", `${missing.length === 1 ? "This group does" : "These groups do"} not exist in NiFi: ${missing.map((m) => `${m.groupId} (${m.service})`).join(", ")}. Was it deleted, or is the link of another instance?`, { groups: missing.map((m) => ({ service: m.service, group: m.groupId, link: m.link })) });

    const taken: Taken[] = [];
    const added: RegisteredGroup[] = [], unchanged: RegisteredGroup[] = [];
    for (const r of resolved) {
      const map = infos.get(r.service)!, info = map.get(r.groupId)!;
      const shown: RegisteredGroup = { service: r.service, group: { id: r.groupId, name: info.name ?? r.groupId, path: crumbs(info) }, link: r.link };
      const ancestors = new Set((info.path ?? []).map((p) => p.id.toLowerCase()));
      let already = false;
      const there = [...this.store.flowRegistrations({ service: r.service }),
        ...ownGroups.filter((g) => g.service === r.service).map((g) => ({ owner: ownKey, groupId: g.group.id, groupName: g.group.name, registeredBy: g.addedBy }))];
      for (const e of there) {
        const other = map.get(e.groupId);
        const relation: Taken["relation"] | null = e.groupId === r.groupId ? "same" : ancestors.has(e.groupId) ? "inside"
          : other?.exists && (other.path ?? []).some((p) => p.id.toLowerCase() === r.groupId) ? "contains" : null;
        if (!relation) continue;
        if (e.owner === ownKey) { if (relation !== "contains") already = true; continue; }
        taken.push({ service: r.service, group: { id: e.groupId, name: e.groupName }, relation, by: { ...this.ownerOf(e.owner), registeredBy: e.registeredBy } });
      }
      if (already) { unchanged.push(shown); continue; }
      added.push(shown);
    }
    if (taken.length) throw takenError(taken);
    return { added, unchanged };
  }

  private dedupe(rs: ResolvedLink[]): ResolvedLink[] {
    const seen = new Set<string>();
    return rs.filter((r) => { const k = `${r.service}\0${r.groupId}`; if (seen.has(k)) return false; seen.add(k); return true; });
  }

  /** The groups remove would take out (checked: they are the business's, and not all of them). */
  removing(flowId: unknown, groups: unknown): { flow: string; wanted: { service: string; group: string }[] } {
    const flow = this.flowOf(flowId);
    if (!Array.isArray(groups) || groups.length < 1 || groups.length > LINKS_MAX
      || !groups.every((g) => g && typeof g === "object" && typeof g.service === "string" && typeof g.group === "string")) {
      throw new RegError("register/bad-request", `groups is a list of 1 to ${LINKS_MAX} {service, group}.`);
    }
    const mine = this.store.flowRegistrations({ owner: flow.id });
    const wanted = groups.map((g: { service: string; group: string }) => ({ service: g.service, group: g.group.toLowerCase() }));
    const rows = wanted.map((w) => mine.filter((m) => m.service === w.service && m.groupId === w.group));
    const lost = wanted.filter((_, i) => !rows[i]!.length);
    if (lost.length) throw new RegError("register/not-found", `The business has no registered group ${lost.map((l) => `${l.group} (${l.service})`).join(", ")}.`);
    const gone = new Set(wanted.map((w) => `${w.service}\0${w.group}`));
    if (mine.every((m) => gone.has(`${m.service}\0${m.groupId}`))) throw new RegError("register/empty", "That would take every group out of the business: unregister it instead.");
    return { flow: flow.id, wanted };
  }

  /** remove: these groups leave the business (and the told hand-overs and worker places on them). The last one cannot
   *  (unregister does that). With the publish's revisions inside its transaction (step 5). */
  remove(flowId: unknown, groups: unknown, actor: Actor, revisions?: Map<string, number>): { flow: string; removed: { service: string; group: string }[]; droppedHandoffs: string[]; revisions: { service: string; revision: number }[]; published: boolean } {
    const { flow, wanted } = this.removing(flowId, groups);
    const mine = this.store.flowRegistrations({ owner: flow });
    const removed: { service: string; group: string; name: string }[] = [];
    const dropped: string[] = [];
    this.store.flowTransaction(() => {
      for (const w of wanted) {
        const name = mine.find((m) => m.service === w.service && m.groupId === w.group)!.groupName;
        if (this.store.removeFlowRegistration(flow, w.service, w.group)) removed.push({ ...w, name });
        // A worker placed in a group that leaves is asked about again; a told hand-over naming it goes with it.
        for (const p of this.store.workerPlaces(flow)) if (p.service === w.service && p.group === w.group) this.store.setWorkerPlace(flow, p.schedule, p.worker, null);
        for (const h of this.store.flowHandoffs(flow)) if (handoffNames(h, w.service, w.group) && this.store.deleteFlowHandoff(h.id)) dropped.push(h.id);
      }
      this.log(flow, "remove-group", actor, (s) => removed.some((r) => r.service === s) ? `去掉了组${removed.filter((r) => r.service === s).map((r) => `"${r.name}"`).join("、")}` : "删组后重新串联，本服务的模型随之更新",
        [...new Set(removed.map((r) => r.service))], revisions);
      this.store.auditFlow(actor, flow, "register-remove");
    });
    return { flow, removed: removed.map(({ service, group }) => ({ service, group })), droppedHandoffs: dropped, revisions: [...(revisions ?? [])].map(([service, revision]) => ({ service, revision })), published: Boolean(revisions) };
  }

  /** rename: only the business's name (kept as a person's, the AI does not change it). */
  rename(flowId: unknown, name: unknown, actor: Actor): { flow: string; name: string } {
    const flow = this.flowOf(flowId);
    if (typeof name !== "string" || !name.trim() || name.trim().length > NAME_MAX) throw new RegError("register/bad-request", `name is 1 to ${NAME_MAX} characters.`);
    const next = name.trim();
    this.store.flowTransaction(() => {
      this.store.putFlow({ ...flow, name: next, nameBy: "person" });
      const services = [...new Set(this.store.flowRegistrations({ owner: flow.id }).map((r) => r.service))];
      this.log(flow.id, "rename", actor, () => `改名为"${next}"（原名"${flow.name}"）`, services.length ? services : [this.store.flowSegments(flow.id)[0]?.service ?? "-"]);
      this.store.auditFlow(actor, flow.id, "register-rename");
    });
    return { flow: flow.id, name: next };
  }

  // --- drafts (§7.9): the same actions on a draft; nothing is registered, nothing is published ---------------------

  /** A new draft, empty or (flow, step 6) a copy of a registered business: its groups, told hand-overs, worker places and
   *  name. Changes to a business go through such a draft, so a person confirms them on the page (commit, §7.9). */
  createDraft(actor: Actor, name?: unknown, flowId?: unknown): RegistrationDraft {
    if (name !== undefined && name !== null) this.checkName(name);
    const given = name === undefined || name === null ? null : String(name).trim();
    if (flowId === undefined || flowId === null) return this.store.createRegistrationDraft(actor.id, given);
    const flow = this.flowOf(flowId);
    const groups: RegistrationDraftGroup[] = this.store.flowRegistrations({ owner: flow.id }).filter((r) => r.role === "segment")
      .map((r) => ({ service: r.service, group: { id: r.groupId, name: r.groupName, path: r.groupPath ?? "" }, link: r.link, addedBy: r.registeredBy, addedAt: r.registeredAt }));
    return this.store.createRegistrationDraft(actor.id, given ?? flow.name, { flow: flow.id, groups, handoffs: this.store.flowHandoffs(flow.id), places: this.store.workerPlaces(flow.id) });
  }

  draft(id: unknown): RegistrationDraft {
    if (typeof id !== "string" || !DRAFT_ID.test(id)) throw new RegError("register/bad-request", "draft is a draft id (rgd_…).");
    const d = this.store.registrationDraft(id);
    if (!d) throw new RegError("register/not-found", `No registration draft ${id} (a draft nobody touched for a day is gone).`);
    return d;
  }

  async draftAdd(id: unknown, links: unknown, actor: Actor): Promise<{ draft: string; added: RegisteredGroup[]; unchanged: RegisteredGroup[] }> {
    const d = this.draft(id);
    // A draft of a business's changes owns what the business has registered too.
    const { added, unchanged } = await this.stage(links, d.flow ?? d.id, d.groups);
    const at = new Date().toISOString();
    const fresh = this.draft(d.id);
    this.store.putRegistrationDraft({ ...fresh, groups: [...fresh.groups, ...added.map((a): RegistrationDraftGroup => ({ service: a.service, group: a.group, link: a.link, addedBy: actor.id, addedAt: at }))] });
    return { draft: d.id, added, unchanged };
  }

  /** A group leaving the draft takes the spoken hand-overs that name it. */
  draftRemove(id: unknown, groups: unknown): { draft: string; removed: { service: string; group: string }[]; droppedHandoffs: string[] } {
    const d = this.draft(id);
    if (!Array.isArray(groups) || groups.length < 1 || groups.length > LINKS_MAX
      || !groups.every((g) => g && typeof g === "object" && typeof g.service === "string" && typeof g.group === "string")) {
      throw new RegError("register/bad-request", `groups is a list of 1 to ${LINKS_MAX} {service, group}.`);
    }
    const wanted = groups.map((g: { service: string; group: string }) => ({ service: g.service, group: g.group.toLowerCase() }));
    const lost = wanted.filter((w) => !d.groups.some((g) => g.service === w.service && g.group.id === w.group));
    if (lost.length) throw new RegError("register/not-found", `The draft has no group ${lost.map((l) => `${l.group} (${l.service})`).join(", ")}.`);
    const gone = (service: string, group: string) => wanted.some((w) => w.service === service && w.group === group.toLowerCase());
    const dropped = d.handoffs.filter((h) => gone(h.from.service, h.from.group) || ("group" in h.to && gone(h.to.service, h.to.group)));
    this.store.putRegistrationDraft({
      ...d,
      groups: d.groups.filter((g) => !gone(g.service, g.group.id)),
      handoffs: d.handoffs.filter((h) => !dropped.includes(h)),
      places: d.places.filter((p) => !(p.service && p.group && gone(p.service, p.group))),
    });
    return { draft: d.id, removed: wanted, droppedHandoffs: dropped.map((h) => h.id) };
  }

  draftRename(id: unknown, name: unknown): { draft: string; name: string } {
    const d = this.draft(id);
    const next = this.checkName(name);
    this.store.putRegistrationDraft({ ...d, name: next });
    return { draft: d.id, name: next };
  }

  /** Keeps (or replaces, or removes) a spoken hand-over of the draft. From and to must be groups of the draft; to may be the
   *  outside ({system}). Whether the component is in the group is not known before the chaining (step 3). */
  draftDeclareHandoff(id: unknown, b: Record<string, unknown>, actor: Actor): { draft: string; handoff?: RegistrationDraftHandoff; removed?: string } {
    const d = this.draft(id);
    const got = this.handoffFor(d.groups.map((g) => ({ service: g.service, group: g.group.id })), d.handoffs, b, actor, "draft");
    if (got.removed) {
      this.store.putRegistrationDraft({ ...d, handoffs: d.handoffs.filter((h) => h.id !== got.removed) });
      return { draft: d.id, removed: got.removed };
    }
    this.store.putRegistrationDraft({ ...d, handoffs: [...d.handoffs.filter((h) => h.id !== got.handoff!.id), got.handoff!] });
    return { draft: d.id, handoff: got.handoff! };
  }

  /** declare-handoff's checks over a registration's groups and its told hand-overs (a draft's or a business's): the hand-over
   *  to keep (a new id, or the one replaced), or the id to remove. Writes nothing. */
  handoffFor(groups: { service: string; group: string }[], handoffs: RegistrationDraftHandoff[], b: Record<string, unknown>, actor: Actor, what: "draft" | "business"): { handoff?: RegistrationDraftHandoff; removed?: string } {
    const d = { groups: groups.map((g) => ({ service: g.service, group: { id: g.group } })), handoffs };
    const find = (v: unknown, why: string): number => {
      const i = typeof v === "string" ? d.handoffs.findIndex((h) => h.id === v) : -1;
      if (i < 0) throw new RegError("register/not-found", `The ${what} has no hand-over ${String(v)} (${why}).`);
      return i;
    };
    if (b.remove !== undefined) return { removed: d.handoffs[find(b.remove, "remove")]!.id };
    const own = (service: unknown, group: unknown, role: string) => {
      if (typeof service !== "string" || typeof group !== "string" || !d.groups.some((g) => g.service === service && g.group.id === group.toLowerCase()))
        throw new RegError("register/bad-handoff", `The ${role} is not a group of this ${what}: add its link first.`);
      return { service, group: group.toLowerCase() };
    };
    const from = b.from as Record<string, unknown> | undefined, to = b.to as Record<string, unknown> | undefined;
    if (!from || typeof from !== "object" || !to || typeof to !== "object") throw new RegError("register/bad-request", "from is {service, group, component, relationship?}, to is {service, group} or {system}.");
    if (typeof from.component !== "string" || !from.component.trim()) throw new RegError("register/bad-request", "from.component is the component (id or name) the data leaves from.");
    if (from.relationship !== undefined && (typeof from.relationship !== "string" || !from.relationship)) throw new RegError("register/bad-request", "from.relationship is a relationship name.");
    if (typeof b.quote !== "string" || !b.quote.trim() || b.quote.length > QUOTE_MAX) throw new RegError("register/bad-request", `quote is the owner's own words, 1 to ${QUOTE_MAX} characters.`);
    const fromG = own(from.service, from.group, "from");
    let target: RegistrationDraftHandoff["to"];
    if (typeof to.system === "string" && to.system.trim()) target = { system: to.system.trim() };
    else target = own(to.service, to.group, "to");
    const at = new Date().toISOString();
    const handoff: RegistrationDraftHandoff = {
      id: b.replace !== undefined ? d.handoffs[find(b.replace, "replace")]!.id : `hof_${randomBytes(6).toString("hex")}`,
      from: { ...fromG, component: from.component.trim(), ...(from.relationship !== undefined ? { relationship: from.relationship as string } : {}) },
      to: target, quote: b.quote.trim(), declaredBy: actor.id, declaredAt: at,
    };
    return { handoff };
  }

  /** A business's told hand-over kept, replaced or removed, with the publish's revisions. Call inside flowTransaction. */
  writeHandoff(flow: string, got: { handoff?: RegistrationDraftHandoff; removed?: string }, actor: Actor, revisions?: Map<string, number>) {
    if (got.removed) this.store.deleteFlowHandoff(got.removed);
    if (got.handoff) this.store.putFlowHandoff(flow, got.handoff);
    const h = got.handoff;
    const to = h ? ("system" in h.to ? `NiFi 外的 ${h.to.system}` : `${h.to.service} 的组 ${h.to.group}`) : "";
    this.log(flow, "declare-handoff", actor, () => h ? `记了口头交接 ${h.id}：${h.from.service} 的组 ${h.from.group} 交给${to}（负责人说："${h.quote}"）` : `去掉了口头交接 ${got.removed}`,
      h ? [h.from.service] : [], revisions);
    this.store.auditFlow(actor, flow, "register-declare-handoff");
  }

  /** place-worker (§7.8 6): where a schedule's worker runs, in the owner's words, when its worker_name matches no
   *  registered group: a group of the business (or draft), or outside: true (not in NiFi); remove: true forgets it.
   *  The chaining uses it from then on (chain() placements) and stops asking. */
  placeWorker(target: { flow?: unknown; draft?: unknown }, b: Record<string, unknown>, actor: Actor, o: { plan?: boolean } = {}): { flow?: string; draft?: string; schedule: string; worker: string; place: WorkerPlace | null; plan?: WorkerPlan } {
    const schedule = typeof b.schedule === "number" ? String(b.schedule) : typeof b.schedule === "string" ? b.schedule.trim() : "";
    const worker = typeof b.worker === "string" ? b.worker.trim() : "";
    if (!schedule || schedule.length > NAME_MAX || !worker || worker.length > NAME_MAX) throw new RegError("register/bad-request", "schedule is the schedule_id (or its name), worker its worker_name (the gap's worker says both).");
    const drafted = target.draft !== undefined;
    const d = drafted ? this.draft(target.draft) : null;
    const flow = drafted ? null : this.flowOf(target.flow);
    const groups = d ? d.groups.map((g) => ({ service: g.service, id: g.group.id, name: g.group.name }))
      : this.store.flowRegistrations({ owner: flow!.id }).map((r) => ({ service: r.service, id: r.groupId, name: r.groupName }));
    let place: WorkerPlace | null = null;
    if (b.remove !== true) {
      if (typeof b.quote !== "string" || !b.quote.trim() || b.quote.length > QUOTE_MAX) throw new RegError("register/bad-request", `quote is the owner's own words, 1 to ${QUOTE_MAX} characters.`);
      let service: string | null = null, group: string | null = null;
      if (b.outside === true) { if (b.group !== undefined) throw new RegError("register/bad-request", "Give group or outside: true, not both."); }
      else {
        const g = b.group as Record<string, unknown> | undefined;
        if (!g || typeof g.service !== "string" || typeof g.group !== "string") throw new RegError("register/bad-request", "group is {service, group} (a group of this registration), or outside: true when the worker is not in NiFi.");
        const hit = groups.find((x) => x.service === g.service && x.id === (g.group as string).toLowerCase());
        if (!hit) throw new RegError("register/bad-handoff", `The worker's group is not a group of this ${drafted ? "draft" : "business"}: add its link first.`);
        service = hit.service; group = hit.id;
      }
      place = { schedule, worker, service, group, quote: b.quote.trim(), placedBy: actor.id, placedAt: new Date().toISOString() };
    }
    const same = (p: WorkerPlace) => p.schedule === schedule && p.worker.toLowerCase() === worker.toLowerCase();
    if (d) {
      const rest = d.places.filter((p) => !same(p));
      if (!place && rest.length === d.places.length) throw new RegError("register/not-found", `The draft has no place for ${worker} of schedule ${schedule}.`);
      this.store.putRegistrationDraft({ ...d, places: place ? [...rest, place] : rest });
      return { draft: d.id, schedule, worker, place };
    }
    const had = this.store.workerPlaces(flow!.id).find(same);
    if (!place && !had) throw new RegError("register/not-found", `The business has no place for ${worker} of schedule ${schedule}.`);
    const plan: WorkerPlan = { flow: flow!.id, schedule, worker, place, had: had ?? null, groupName: place?.group ? groups.find((x) => x.service === place!.service && x.id === place!.group)!.name : "" };
    if (o.plan) return { ...plan, plan };
    this.store.flowTransaction(() => this.writeWorkerPlace(plan, actor));
    return { flow: flow!.id, schedule, worker, place };
  }

  /** The business's worker places after a place-worker plan. */
  placesAfter(plan: WorkerPlan): WorkerPlace[] {
    const rest = this.store.workerPlaces(plan.flow).filter((p) => !(p.schedule === plan.had?.schedule && p.worker === plan.had.worker));
    return plan.place ? [...rest, plan.place] : rest;
  }

  /** Writes a place-worker plan of a business (with the publish's revisions). Call inside flowTransaction. */
  writeWorkerPlace(plan: WorkerPlan, actor: Actor, revisions?: Map<string, number>) {
    const { flow, schedule, worker, place, had } = plan;
    if (had) this.store.setWorkerPlace(flow, had.schedule, had.worker, null);
    if (place) this.store.setWorkerPlace(flow, schedule, worker, { service: place.service, group: place.group, quote: place.quote, placedBy: place.placedBy, placedAt: place.placedAt });
    this.log(flow, "place-worker", actor, () => place ? `schedule ${schedule} 的 worker ${worker} ${place.group ? `在组"${plan.groupName}"` : "不在 NiFi 上"}（负责人说："${place.quote}"）` : `去掉了 schedule ${schedule} 的 worker ${worker} 的位置`,
      [place?.service ?? had?.service ?? "-"].filter((s) => s !== "-" || !revisions?.size), revisions);
    this.store.auditFlow(actor, flow, "register-place-worker");
  }

  /** Writes what a draft of a business's changes (step 6) changes: the groups added (staged) and gone, the told hand-overs
   *  and worker places kept, replaced or gone, the name. With the publish's revisions; call inside flowTransaction. */
  applyDraft(d: RegistrationDraft, added: RegisteredGroup[], actor: Actor, revisions: Map<string, number>, oldName: string, name: string) {
    const flow = d.flow!;
    if (added.length) this.addStaged(flow, added, actor, "add-group", revisions);
    const keep = new Set(d.groups.map((g) => `${g.service}\0${g.group.id}`));
    const gone = this.store.flowRegistrations({ owner: flow }).filter((r) => r.role === "segment" && !keep.has(`${r.service}\0${r.groupId}`)).map((r) => ({ service: r.service, group: r.groupId }));
    const removed = gone.length ? this.remove(flow, gone, actor, revisions).removed : [];
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const told: string[] = [], untold: string[] = [];
    const nowTold = this.store.flowHandoffs(flow);
    for (const h of nowTold) if (!d.handoffs.some((x) => x.id === h.id)) { this.writeHandoff(flow, { removed: h.id }, actor, revisions); untold.push(h.id); }
    for (const h of d.handoffs) {
      const was = nowTold.find((x) => x.id === h.id);
      if (!was || !same([was.from, was.to, was.quote], [h.from, h.to, h.quote])) { this.writeHandoff(flow, { handoff: h }, actor, revisions); told.push(h.id); }
    }
    const key = (p: WorkerPlace) => `${p.schedule}\0${p.worker.toLowerCase()}`;
    const nowPlaced = this.store.workerPlaces(flow);
    let placed = 0;
    for (const p of nowPlaced) if (!d.places.some((x) => key(x) === key(p))) { this.writeWorkerPlace({ flow, schedule: p.schedule, worker: p.worker, place: null, had: p, groupName: "" }, actor, revisions); placed++; }
    for (const p of d.places) {
      const had = nowPlaced.find((x) => key(x) === key(p)) ?? null;
      if (had && same([had.service, had.group, had.quote], [p.service, p.group, p.quote])) continue;
      const groupName = d.groups.find((g) => g.service === p.service && g.group.id === p.group)?.group.name ?? "";
      this.writeWorkerPlace({ flow, schedule: p.schedule, worker: p.worker, place: p, had, groupName }, actor, revisions);
      placed++;
    }
    if (name !== oldName) {
      this.log(flow, "rename", actor, () => `改名为"${name}"（原名"${oldName}"）`, [...new Set(d.groups.map((g) => g.service))]);
      this.store.auditFlow(actor, flow, "register-rename");
    }
    return { added, removed, handoffs: { told, removed: untold }, places: placed, renamed: name !== oldName };
  }

  private checkName(name: unknown): string {
    if (typeof name !== "string" || !name.trim() || name.trim().length > NAME_MAX) throw new RegError("register/bad-request", `name is 1 to ${NAME_MAX} characters.`);
    return name.trim();
  }

  /** unregister: a business (or a shared module) and all its registered groups go; flow_segments and handoffs with it. */
  unregister(target: { flow?: unknown; module?: unknown }, actor: Actor, revisions?: Map<string, number>): { removed: { flow?: string; module?: string; groups: number }; revisions: { service: string; revision: number }[]; published: boolean } {
    const published = { revisions: [...(revisions ?? [])].map(([service, revision]) => ({ service, revision })), published: Boolean(revisions) };
    if ((target.flow === undefined) === (target.module === undefined)) throw new RegError("register/bad-request", "Give flow or module, one of them.");
    if (target.flow !== undefined) {
      const flow = this.flowOf(target.flow);
      const mine = this.store.flowRegistrations({ owner: flow.id });
      const services = [...new Set([...mine.map((r) => r.service), ...(mine.length ? [] : this.store.flowSegments(flow.id).map((s) => s.service))])];
      let groups = 0;
      this.store.flowTransaction(() => {
        this.log(flow.id, "unregister", actor, (s) => `注销了业务"${flow.name}"，去掉本服务上的${mine.filter((r) => r.service === s).length} 个组`, services, revisions);
        groups = this.store.removeFlowRegistrations(flow.id);
        this.store.deleteFlow(flow.id);
        this.store.auditFlow(actor, flow.id, "register-unregister");
      });
      return { removed: { flow: flow.id, groups }, ...published };
    }
    const id = typeof target.module === "string" ? target.module : "";
    const mod = id ? this.store.sharedModule(id) : null;
    if (!mod) throw new RegError("register/not-found", `No shared module ${String(target.module)}.`);
    const mine = this.store.flowRegistrations({ owner: mod.id });
    let groups = 0;
    this.store.flowTransaction(() => {
      this.log(mod.id, "unregister", actor, (s) => `注销了公共模块"${mod.name}"，去掉本服务上的${mine.filter((r) => r.service === s).length} 个组`, [...new Set(mine.map((r) => r.service))], revisions);
      groups = this.store.removeFlowRegistrations(mod.id);
      this.store.deleteSharedModule(mod.id);
    });
    return { removed: { module: mod.id, groups }, ...published };
  }
}

/** §7.1 the two ways out of a group two businesses want. */
const TAKEN_OPTIONS = [
  { kind: "shared", text: "把这个组改登成公共模块，两条业务都按端口接上。" },
  { kind: "slice", text: "组里有互不相连的几片时，各业务登记各自的片。" },
];

function takenError(taken: Taken[]): RegError {
  const first = taken[0]!;
  const rel = first.relation === "same" ? "is registered" : first.relation === "inside" ? `lies inside "${first.group.name}", which is registered` : `contains "${first.group.name}", which is registered`;
  return new RegError("register/group-taken", `This group ${rel} by ${first.by.kind === "module" ? "the shared module" : "the business"} "${first.by.name}" (${first.by.registeredBy}). Make it a shared module, or split it by slice.`, { taken, options: TAKEN_OPTIONS });
}

