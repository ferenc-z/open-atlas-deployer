// Service ops pages (phase 1, §11): the managed services (NiFi) of this environment, and taking them over.
// Services (S23): grouped by environment, a card per cluster or standalone instance (or a table, where a cluster opens
// into its node rows); a card opens the service's detail page (ServiceDetail.tsx). Whether a member runs is as of its
// host's newest discovery (phase 1 has no live probes). Takeover: discover on each host's service executor, make a
// draft from the newest discoveries (grouped and assessed by rules, P1), edit it, confirm it (which imports each
// installation's configuration files as revision 1). Nothing here changes anything on the hosts.

import { Fragment, useCallback, useEffect, useState } from "react";
import * as api from "./api.ts";
import type { DiscoveryView, DraftItem, DraftSummary, Finding, HostView, RegisteredService, ServiceDraft, Skipped } from "./api.ts";
import { ask } from "./Confirm.tsx";
import { Markdown } from "./Markdown.tsx";
import { ServiceDetail } from "./ServiceDetail.tsx";
import { CertBadge, ConfCell, confElsewhere, DifferenceBadge, memberKey, membersOf, serviceName, SEVERITY, STATE, StatusNotes, UpBadge, webPort, when } from "./svc.tsx";
import { Sparkline } from "./Charts.tsx";
import { AlertBadge } from "./Alerts.tsx";

type Problem = { message: string; details: string[] };
const problemOf = (e: unknown): Problem => ({ message: (e as Error).message, details: (e as api.ApiError).details ?? [] });

function ProblemLine({ problem }: { problem: Problem | undefined }) {
  if (!problem) return null;
  return <div className="error">{problem.message}{problem.details.length > 0 && <ul>{problem.details.map((d) => <li key={d}>{d}</li>)}</ul>}</div>;
}

// The environments a service can be in (S14: each environment's Deployer has its own); others found are added after.
const ENVIRONMENTS = ["UAT", "PROD"];
type Layout = "cards" | "table";
const LAYOUT_KEY = "oa.services.layout";
const savedLayout = (): Layout => { try { return localStorage.getItem(LAYOUT_KEY) === "table" ? "table" : "cards"; } catch { return "cards"; } };

const kindLabel = (s: RegisteredService) => (s.kind === "cluster" ? `Cluster · ${s.nodes.length} nodes` : "Standalone");
const where = (m: { host: string; ports: { https?: number | null; http?: number | null } }) => `${m.host}${webPort(m.ports) ? `:${webPort(m.ports)}` : ""}`;

export function ServicesPage({ onTakeover, initialOpen }: { onTakeover: () => void; initialOpen?: string }) {
  const [list, setList] = useState<{ standalones: RegisteredService[]; clusters: RegisteredService[] } | undefined>();
  const [open, setOpen] = useState<string | undefined>(initialOpen);
  const [layout, setLayoutState] = useState<Layout>(savedLayout);
  const [error, setError] = useState("");
  const refresh = useCallback(() => { api.services().then(setList, (e: Error) => setError(e.message)); }, []);
  useEffect(() => { refresh(); const t = setInterval(refresh, 15_000); return () => clearInterval(t); }, [refresh]);
  const setLayout = (l: Layout) => { setLayoutState(l); try { localStorage.setItem(LAYOUT_KEY, l); } catch { /* per-viewer convenience only */ } };
  if (open) return <ServiceDetail key={open} id={open} onBack={() => { setOpen(undefined); refresh(); }} />;
  if (!list) return error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>;
  const all = [...list.clusters, ...list.standalones];
  const envs = [...ENVIRONMENTS, ...new Set(all.map((s) => s.environment.toUpperCase()).filter((e) => !ENVIRONMENTS.includes(e)))];
  return (
    <>
      <div className="toolbar">
        <h1>Services</h1>
        <span className="spacer" />
        <div className="subtabs inline" role="tablist" aria-label="Layout">
          <button className={layout === "cards" ? "active" : ""} onClick={() => setLayout("cards")} aria-selected={layout === "cards"}>Cards</button>
          <button className={layout === "table" ? "active" : ""} onClick={() => setLayout("table")} aria-selected={layout === "table"}>Table</button>
        </div>
        <button className="link" onClick={onTakeover}>Take over more…</button>
      </div>
      <p className="muted page-note">NiFi taken over by the Deployer, by environment. Whether a member runs is live, from its host's service executor's samples (unknown after 3 sampling periods without one, lost when the executor is offline). The trends are the last hour.</p>
      {error && <p className="error">{error}</p>}
      {!all.length && <section className="card"><p className="muted">Nothing is registered yet. Discover on the hosts and confirm a takeover draft first.</p><button className="primary" onClick={onTakeover}>Open Takeover</button></section>}
      {all.length > 0 && envs.map((env) => {
        const here = all.filter((s) => s.environment.toUpperCase() === env);
        const installs = here.reduce((n, s) => n + membersOf(s).length, 0);
        if (!here.length) return (
          <details key={env} className="env-group empty">
            <summary><span className={`env ${env === "PROD" ? "prod" : ""}`}>{env}</span> <span className="muted">No services</span></summary>
            <p className="muted small">Each environment's Deployer registers its own services (S14); {env}'s are on its Deployer.</p>
          </details>
        );
        return (
          <section key={env} className="env-group">
            <div className="env-head"><span className={`env ${env === "PROD" ? "prod" : ""}`}>{env}</span> <span className="muted">{here.length} service{here.length > 1 ? "s" : ""} · {installs} installation{installs > 1 ? "s" : ""}</span></div>
            {layout === "cards"
              ? <div className="svc-cards">{here.map((s) => <ServiceCard key={s.id} s={s} onOpen={() => setOpen(s.id)} />)}</div>
              : <ServiceTable services={here} onOpen={setOpen} />}
          </section>
        );
      })}
    </>
  );
}

function ServiceCard({ s, onOpen }: { s: RegisteredService; onOpen: () => void }) {
  const members = membersOf(s);
  return (
    <button className="svc-card" onClick={onOpen} title={`Open ${s.id}`}>
      <div className="svc-card-head"><strong className="mono">{s.id}</strong><span><AlertBadge s={s.status} /> <UpBadge s={s.status} /></span></div>
      <div className="muted small">{kindLabel(s)} · {serviceName(s.service)} <span className="mono">{s.version}</span> <span className="muted">({s.profile})</span></div>
      <ul className="svc-members mono small">{members.map((m, i) => (
        <li key={memberKey(m)}><span className={`dot ${STATE[s.states[i] ?? "unknown"].tone}`} title={STATE[s.states[i] ?? "unknown"].label} />{where(m)}{s.kind === "cluster" && m.nodeAddress ? <span className="muted"> · {m.nodeAddress}</span> : null}</li>
      ))}</ul>
      {s.trend && (s.trend.heapPct.some((v) => v !== null) || s.trend.queuedCount.some((v) => v !== null)) && <div className="svc-card-trend">
        <Sparkline label="Heap" values={s.trend.heapPct} unit="%" />
        <Sparkline label="Queued" values={s.trend.queuedCount} unit="count" />
      </div>}
      <div className="svc-card-foot">
        <span className="small">{s.configRevision ? <>Config <span className="mono">r{s.configRevision}</span></> : <span className="muted">No configuration</span>}</span>
        <CertBadge s={s.status} only30 />
        <DifferenceBadge s={s.status} cluster={s.kind === "cluster"} />
        <StatusNotes s={s.status} />
      </div>
    </button>
  );
}

function ServiceTable({ services, onOpen }: { services: RegisteredService[]; onOpen: (id: string) => void }) {
  // Clusters open into their node rows in place; folded ones are remembered while the page is open.
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setFolded((was) => { const next = new Set(was); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  return (
    <table className="svc-table">
      <thead><tr><th>Name</th><th>Kind</th><th>Version</th><th>Host and port</th><th>Up</th><th>Configuration</th><th>Differences</th></tr></thead>
      <tbody>{services.map((s) => {
        const cluster = s.kind === "cluster";
        const shut = folded.has(s.id);
        const members = membersOf(s);
        return (
          <Fragment key={s.id}>
            <tr className="app" onClick={() => onOpen(s.id)}>
              <td>{cluster
                ? <button className="link caret" onClick={(e) => { e.stopPropagation(); toggle(s.id); }} aria-expanded={!shut} title={shut ? "Show the nodes" : "Hide the nodes"}>{shut ? "▸" : "▾"}</button>
                : <span className="caret" />}<span className="mono">{s.id}</span></td>
              <td>{kindLabel(s)}</td>
              <td>{serviceName(s.service)} <span className="mono">{s.version}</span></td>
              <td className="mono small">{cluster ? <span className="muted">{members.length} nodes</span> : where(members[0]!)}</td>
              <td><UpBadge s={s.status} /> <AlertBadge s={s.status} /> <CertBadge s={s.status} only30 /> <StatusNotes s={s.status} /></td>
              <td>{s.configRevision ? <span className="mono">r{s.configRevision}</span> : <span className="muted">None</span>}</td>
              <td>{cluster ? <DifferenceBadge s={s.status} cluster /> : <span className="muted">—</span>}</td>
            </tr>
            {cluster && !shut && members.map((m, i) => (
              <tr key={memberKey(m)} className="node-row app" onClick={() => onOpen(s.id)}>
                <td className="mono small"><span className="caret" /><span className="muted">└</span> Node {i + 1}{m.nodeAddress ? <span className="muted"> · {m.nodeAddress}</span> : null}</td>
                <td className="muted small">Node</td>
                <td></td>
                <td className="mono small">{where(m)}</td>
                <td><span className={`badge ${STATE[s.states[i] ?? "unknown"].tone}`} title={STATE[s.states[i] ?? "unknown"].title}>{STATE[s.states[i] ?? "unknown"].label}</span></td>
                <td className="mono small muted" colSpan={2}>{m.installDir}{confElsewhere(m) && <> · conf {confElsewhere(m)}</>}</td>
              </tr>
            ))}
          </Fragment>
        );
      })}</tbody>
    </table>
  );
}

// Takeover.

// The manual step of a takeover (S11, S28): what operations give the monitor certificate's identity in each NiFi.
const MONITOR_POLICIES: [string, string, string][] = [
  ["/flow", "view the user interface", "versions, flow status, bulletins, back pressure"],
  ["/system", "view system diagnostics", "heap, GC, threads, repositories"],
  ["/controller", "view the controller", "cluster nodes and the coordinator"],
  ["/provenance", "query provenance", "FlowFile trace"],
  ["/provenance-data/process-groups/<root group id>", "view provenance (root group, inherited)", "FlowFile trace events"],
  ["/data/process-groups/<root group id>", "view the data (root group, inherited)", "the FlowFile attributes of trace events (on a cluster also every node's identity, see below)"],
];

function MonitorPolicies() {
  return (
    <details className="card">
      <summary>Before the takeover: NiFi policies for each host's monitor certificate (done by operations)</summary>
      <p className="muted small">Each NiFi server's service executor calls its local NiFi with that host's monitor certificate (EXECUTOR_NIFI_CLIENT_CERT). In NiFi, add the certificate's identity as a user and give it these policies, all <strong>read</strong> only (on a cluster once, any node passes it on). Without them the matching numbers or the FlowFile trace stay empty; nothing here writes to NiFi, and content is never read.</p>
      <table>
        <thead><tr><th>Resource</th><th>Policy in the NiFi UI</th><th>For</th></tr></thead>
        <tbody>{MONITOR_POLICIES.map(([resource, policy, why]) => <tr key={resource}><td className="mono small">{resource}</td><td>{policy}</td><td className="muted small">{why}</td></tr>)}</tbody>
      </table>
      <p className="muted small">On a cluster, also give every node's own identity (its certificate's, e.g. CN=node1, OU=NIFI) <strong>view the data</strong> on the root group: a node passes the request on to the node that holds the event as a proxy, and NiFi checks that policy for every identity on the way; without it the attributes stay hidden.</p>
    </details>
  );
}
const FINAL = new Set(["succeeded", "failed", "refused", "rolled-back"]);

export function TakeoverPage({ isAdmin, onRegistered }: { isAdmin: boolean; onRegistered: () => void }) {
  const [hosts, setHosts] = useState<HostView[] | undefined>();
  const [discoveries, setDiscoveries] = useState<Record<string, DiscoveryView | null>>({});
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [open, setOpen] = useState<string | undefined>();
  const [made, setMade] = useState<{ skipped: Skipped[]; missing: string[] } | undefined>();
  const [problem, setProblem] = useState<Problem | undefined>();
  const loadDiscovery = useCallback((host: string) => api.discovery(host).then((d) => setDiscoveries((was) => ({ ...was, [host]: d })), () => setDiscoveries((was) => ({ ...was, [host]: null }))), []);
  const refresh = useCallback(() => {
    api.hosts().then((r) => {
      const withService = r.hosts.filter((h) => h.service);
      setHosts(withService);
      for (const h of withService) void loadDiscovery(h.id);
    }, (e) => setProblem(problemOf(e)));
    api.serviceDrafts().then((r) => setDrafts(r.drafts), (e) => setProblem(problemOf(e)));
  }, [loadDiscovery]);
  useEffect(() => { refresh(); }, [refresh]);
  // While a discovery runs, look again every two seconds.
  const running = Object.values(discoveries).some((d) => d && !FINAL.has(d.state));
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => { for (const [h, d] of Object.entries(discoveries)) if (d && !FINAL.has(d.state)) void loadDiscovery(h); }, 2_000);
    return () => clearInterval(t);
  }, [running, discoveries, loadDiscovery]);

  const makeDraft = () => {
    setProblem(undefined);
    api.createServiceDraft().then((r) => { setMade({ skipped: r.skipped, missing: r.missing }); setOpen(r.draft.id); refresh(); }, (e) => setProblem(problemOf(e)));
  };
  if (!hosts) return problem ? <ProblemLine problem={problem} /> : <p className="muted">Loading…</p>;
  const openDrafts = drafts.filter((d) => d.state === "open");
  const closed = drafts.filter((d) => d.state !== "open");
  return (
    <>
      <div className="toolbar">
        <h1>Takeover</h1>
        <span className="muted">1. Discover on each host's service executor (it only reads). 2. Make a draft: the Deployer groups what it found into clusters and standalone instances and lists differences between nodes and risks. 3. Edit the draft and confirm it: each installation's configuration files are read and kept as revision 1. Nothing on the hosts changes.</span>
      </div>
      <ProblemLine problem={problem} />
      <MonitorPolicies />
      <h2>1 · Discover</h2>
      {!hosts.length ? <p className="muted">No host has a service executor yet: install one on the NiFi servers and issue its token on the Hosts page.</p> : (
        <table>
          <thead><tr><th>Host</th><th>Service executor</th><th>Newest discovery</th><th>Found</th>{isAdmin && <th></th>}</tr></thead>
          <tbody>{hosts.map((h) => <DiscoveryRow key={h.id} host={h} discovery={discoveries[h.id]} isAdmin={isAdmin} onStarted={() => loadDiscovery(h.id)} onProblem={setProblem} />)}</tbody>
        </table>
      )}
      <h2>2 · Draft</h2>
      {isAdmin && <div className="row">
        <button className="primary" onClick={makeDraft} disabled={running || !hosts.length}>Make a draft from the newest discoveries</button>
        <span className="muted">Installations already registered are left out.</span>
      </div>}
      {made && (made.skipped.length > 0 || made.missing.length > 0) && <div className="banner info">
        {made.missing.length > 0 && <div>No finished discovery on: {made.missing.join(", ")}.</div>}
        {made.skipped.length > 0 && <>Left out:<ul>{made.skipped.map((s) => <li key={`${s.host}:${s.installDir}`}><span className="mono">{s.host}:{s.installDir}</span> {s.reason}</li>)}</ul></>}
      </div>}
      {openDrafts.length > 0 && !open && <table>
        <thead><tr><th>Open draft</th><th>From</th><th>Made</th><th>Changed</th></tr></thead>
        <tbody>{openDrafts.map((d) => <tr key={d.id} className="app" onClick={() => setOpen(d.id)}><td className="mono">{d.id}</td><td className="mono">{d.sources.map((s) => s.host).join(", ")}</td><td className="muted">{when(d.createdAt)} · {d.createdBy}</td><td className="muted">{when(d.updatedAt)} · {d.updatedBy}</td></tr>)}</tbody>
      </table>}
      {!openDrafts.length && !open && <p className="muted">No open draft.</p>}
      {open && <DraftPanel key={open} id={open} isAdmin={isAdmin} onClose={() => { setOpen(undefined); setMade(undefined); refresh(); }} onConfirmed={() => { setOpen(undefined); setMade(undefined); refresh(); onRegistered(); }} />}
      {closed.length > 0 && <details>
        <summary>Earlier drafts ({closed.length})</summary>
        <table><tbody>{closed.map((d) => <tr key={d.id} className="app" onClick={() => setOpen(d.id)}><td className="mono">{d.id}</td><td><span className={`badge ${d.state === "confirmed" ? "ok" : "muted"}`}>{d.state === "confirmed" ? "Confirmed" : "Discarded"}</span></td><td className="muted">{when(d.updatedAt)} · {d.updatedBy}</td></tr>)}</tbody></table>
      </details>}
    </>
  );
}

function DiscoveryRow({ host, discovery, isAdmin, onStarted, onProblem }: { host: HostView; discovery: DiscoveryView | null | undefined; isAdmin: boolean; onStarted: () => void; onProblem: (p: Problem | undefined) => void }) {
  // Installations to read as well (not running, or not in a scanned directory): each an install directory, with its
  // conf directory when that is elsewhere and bootstrap.conf's conf.dir does not say so.
  const [dirs, setDirs] = useState<{ install: string; conf: string }[]>([{ install: "", conf: "" }]);
  const e = host.service!;
  const busy = discovery ? !FINAL.has(discovery.state) : false;
  const setDir = (i: number, field: "install" | "conf", value: string) => setDirs(dirs.map((d, j) => (j === i ? { ...d, [field]: value } : d)));
  const start = () => {
    onProblem(undefined);
    const list: api.DiscoverDir[] = dirs.map((d) => ({ install: d.install.trim(), conf: d.conf.trim() })).filter((d) => d.install)
      .map((d) => (d.conf ? { install: d.install, conf: d.conf } : d.install));
    api.discover(host.id, list).then(onStarted, (err) => onProblem(problemOf(err)));
  };
  const r = discovery?.result;
  return (
    <tr>
      <td className="mono">{host.id}</td>
      <td>{e.online ? <span className="badge ok">Online</span> : <span className="badge bad" title={e.reason}>Offline</span>} <span className="muted">{e.heartbeat?.version}{e.heartbeat && !e.heartbeat.isRoot ? ` · runs as ${e.heartbeat.user ?? "a user"}, sees only that user's NiFi` : ""}</span></td>
      <td>{discovery === undefined ? <span className="muted">…</span> : discovery === null ? <span className="muted">None yet</span> : <>
        <span className={`badge ${discovery.state === "succeeded" ? "ok" : FINAL.has(discovery.state) ? "bad" : "info"}`}>{discovery.state}</span> <span className="muted">{when(discovery.finishedAt ?? discovery.startedAt)}</span>
        {discovery.message && discovery.state !== "succeeded" && <div className="error small">{discovery.message}</div>}
      </>}</td>
      <td className="small">{r ? <>
        {r.instances.map((i) => <div key={`${String(i.installDir)}:${String(i.confDir ?? "")}`}><span className="mono">{String(i.installDir)}</span>{typeof i.confDir === "string" && confElsewhere({ installDir: String(i.installDir), confDir: i.confDir }) && <span className="mono muted"> · conf {i.confDir}</span>} NiFi {String(i.version ?? "?")} {i.running ? <span className="badge ok">running</span> : <span className="badge muted">stopped</span>}{i.cluster?.isNode ? <span className="badge info">node</span> : null}</div>)}
        {!r.instances.length && <span className="muted">No NiFi found</span>}
        {r.dirs.filter((d) => !d.found).map((d) => <div key={`${d.dir}:${d.conf ?? ""}`} className="error">{d.dir}{d.conf ? ` (conf ${d.conf})` : ""}: {d.error ?? "no NiFi there"}</div>)}
        {r.skipped.length > 0 && <div className="muted">{r.skipped.length} process(es) of other users not read</div>}
      </> : <span className="muted">—</span>}</td>
      {isAdmin && <td>
        {dirs.map((d, i) => (
          <div className="row" key={i}>
            <input value={d.install} onChange={(ev) => setDir(i, "install", ev.target.value)} placeholder="Install directory (optional)"
              title="Absolute path of a NiFi installation (bin/, lib/) that is not running or not in a scanned directory" />
            <input value={d.conf} onChange={(ev) => setDir(i, "conf", ev.target.value)} placeholder="Conf directory (if elsewhere)"
              title="Where its nifi.properties is, when not <install>/conf and not named by conf.dir in <install>/conf/bootstrap.conf" />
            {dirs.length > 1 && <button className="link" onClick={() => setDirs(dirs.filter((_, j) => j !== i))} title="Remove this row">Remove</button>}
          </div>
        ))}
        <div className="row">
          {dirs.length < 32 && <button className="link" onClick={() => setDirs([...dirs, { install: "", conf: "" }])}>Add another</button>}
          <button onClick={start} disabled={busy || !e.online}>{busy ? "Discovering…" : "Discover"}</button>
        </div>
      </td>}
    </tr>
  );
}

const plain = (item: ServiceDraft["items"][number]): DraftItem => { const { updatedAt: _a, updatedBy: _b, ...rest } = item; return rest as DraftItem; };

function DraftPanel({ id, isAdmin, onClose, onConfirmed }: { id: string; isAdmin: boolean; onClose: () => void; onConfirmed: () => void }) {
  const [d, setD] = useState<ServiceDraft | undefined>();
  const [problem, setProblem] = useState<Problem | undefined>();
  const [busy, setBusy] = useState("");
  const load = useCallback(() => { api.serviceDraft(id).then(setD, (e) => setProblem(problemOf(e))); }, [id]);
  useEffect(() => { load(); }, [load]);
  // While the AI review runs, look again.
  useEffect(() => {
    if (d?.review?.state !== "running") return;
    const t = setInterval(load, 4_000);
    return () => clearInterval(t);
  }, [d?.review?.state, load]);
  const act = (label: string, p: () => Promise<ServiceDraft | void>) => {
    setProblem(undefined); setBusy(label);
    p().then((next) => { if (next) setD(next); else load(); }, (e) => { setProblem(problemOf(e)); load(); }).finally(() => setBusy(""));
  };
  if (!d) return <section className="card panel">{problem ? <ProblemLine problem={problem} /> : <p className="muted">Loading…</p>}</section>;
  const editable = isAdmin && d.state === "open";
  const errors = d.items.flatMap((i) => (i.findings ?? []) as Finding[]).filter((f) => f.severity === "error").length;
  const confirm = async () => {
    const what = d.items.map((i) => `${i.kind === "cluster" ? "cluster" : "standalone"} ${i.id}`).join(", ");
    const question = `Confirm draft ${d.id}? It registers ${what}. Each installation's configuration files are read on its host and kept as revision 1; nothing on the hosts changes.${errors ? ` The draft still has ${errors} error finding(s).` : ""}`;
    if (!(await ask(question, { confirm: "Confirm takeover" }))) return;
    setProblem(undefined); setBusy("confirm");
    api.confirmDraft(d.id).then(() => onConfirmed(), (e) => { setProblem(problemOf(e)); load(); }).finally(() => setBusy(""));
  };
  const discard = async () => {
    if (!(await ask(`Discard draft ${d.id}? Nothing is registered; discover and make a new draft to start again.`, { confirm: "Discard draft", danger: true }))) return;
    act("discard", () => api.discardDraft(d.id));
  };
  const remove = async (item: string) => {
    if (!(await ask(`Remove ${item} from the draft? It is not taken over when the draft is confirmed.`, { confirm: "Remove", danger: true }))) return;
    act("remove", () => api.removeDraftItem(d.id, item));
  };
  // A new id: the item under the new id first would hold the same installations twice, so the old one goes first, and comes back if the new one is refused.
  const rename = (item: ServiceDraft["items"][number], next: string, note: string) => act("save", async () => {
    const was = plain(item);
    const changed = { ...was, id: next, note: note || null } as DraftItem;
    if (next === was.id) return (await api.putDraftItem(d.id, changed)).draft;
    await api.removeDraftItem(d.id, was.id);
    try { return (await api.putDraftItem(d.id, changed)).draft; } catch (e) { await api.putDraftItem(d.id, was).catch(() => undefined); throw e; }
  });
  return (
    <section className="card panel">
      <div className="toolbar">
        <h2>Draft <span className="mono">{d.id}</span></h2>
        <span className={`badge ${d.state === "open" ? "info" : d.state === "confirmed" ? "ok" : "muted"}`}>{d.state}</span>
        <span className="muted">from {d.sources.map((s) => s.host).join(", ")} · {when(d.createdAt)} by {d.createdBy}</span>
        <button className="link" onClick={onClose}>Close</button>
      </div>
      {d.items.map((item) => <DraftItemCard key={item.id} item={item} editable={editable} busy={Boolean(busy)} onRemove={() => remove(item.id)} onSave={(next, note) => rename(item, next, note)} />)}
      {!d.items.length && <p className="muted">The draft has no items.</p>}
      {d.review && <div>
        <h3>AI review <span className={`badge ${d.review.state === "done" ? "ok" : d.review.state === "failed" ? "bad" : "info"}`}>{d.review.state}</span></h3>
        {d.review.text && <Markdown text={d.review.text} />}
        {d.review.error && <p className="error">{d.review.error}</p>}
      </div>}
      <ProblemLine problem={problem} />
      {editable && <div className="row">
        <button className="primary" onClick={confirm} disabled={Boolean(busy) || !d.items.length}>{busy === "confirm" ? "Reading the files…" : "Confirm takeover"}</button>
        <button onClick={() => act("assess", () => api.reassessDraft(d.id))} disabled={Boolean(busy)}>Assess again</button>
        <button onClick={() => act("review", () => api.reviewDraft(d.id))} disabled={Boolean(busy) || d.review?.state === "running"} title="Optional: needs OMA">Ask the AI to explain</button>
        <button className="link danger" onClick={discard} disabled={Boolean(busy)}>Discard draft</button>
      </div>}
    </section>
  );
}

function DraftItemCard({ item, editable, busy, onRemove, onSave }: { item: ServiceDraft["items"][number]; editable: boolean; busy: boolean; onRemove: () => void; onSave: (id: string, note: string) => void }) {
  const [id, setId] = useState(item.id);
  const [note, setNote] = useState(item.note ?? "");
  useEffect(() => { setId(item.id); setNote(item.note ?? ""); }, [item.id, item.note]);
  const members = item.kind === "cluster" ? item.nodes : [item.member];
  const findings = (item.findings ?? []) as Finding[];
  const changed = id !== item.id || note !== (item.note ?? "");
  return (
    <div className="card panel">
      <div className="toolbar">
        <h3>{item.kind === "cluster" ? "Cluster" : "Standalone instance"} <span className="mono">{item.id}</span></h3>
        <span className="muted">NiFi <span className="mono">{item.version}</span> · {item.profile}{item.kind === "cluster" ? ` · ZooKeeper ${item.zookeeper ?? "—"} ${item.zookeeperRoot ?? ""}` : ""}</span>
        {editable && <button className="link danger" onClick={onRemove} disabled={busy}>Remove from draft</button>}
      </div>
      <table>
        <thead><tr><th>Host</th><th>Install directory</th><th>Conf directory</th>{item.kind === "cluster" && <th>Node address</th>}<th>User</th><th>Ports</th></tr></thead>
        <tbody>{members.map((m) => (
          <tr key={memberKey(m)}>
            <td className="mono">{m.host}</td><td className="mono">{m.installDir}</td><ConfCell m={m} />{item.kind === "cluster" && <td className="mono">{m.nodeAddress ?? "—"}</td>}
            <td className="mono">{m.serviceUser ?? "—"}</td>
            <td className="mono small">{Object.entries(m.ports).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(" · ") || "—"}</td>
          </tr>
        ))}</tbody>
      </table>
      {findings.length ? <ul className="findings">{findings.map((f, i) => (
        <li key={i}>
          <span className={`badge ${SEVERITY[f.severity].tone}`}>{SEVERITY[f.severity].mark} {f.severity}</span> <span className="mono small">{f.code}</span> {f.message}
          {f.values && f.values.length > 0 && <ul className="small">{f.values.map((v) => <li key={`${v.host}:${v.installDir}`}><span className="mono">{v.host}:{v.installDir}</span> {v.value ?? <span className="muted">not set</span>}</li>)}</ul>}
        </li>
      ))}</ul> : <p className="ok">No findings</p>}
      {editable && <div className="row">
        <input value={id} onChange={(e) => setId(e.target.value.trim())} placeholder="Id" title="Lowercase letters, digits and dashes: the id it is registered under" style={{ flex: "0 1 220px" }} />
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" />
        <button onClick={() => onSave(id, note)} disabled={busy || !changed || !id}>Save</button>
      </div>}
      {!editable && item.note && <p className="muted">{item.note}</p>}
    </div>
  );
}
