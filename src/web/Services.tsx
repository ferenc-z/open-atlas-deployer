// Service ops pages (phase 1, §11): the managed services (NiFi) of this environment, and taking them over.
// Services: clusters and standalone instances as registered, each with its members' status: the host's service
// executor and whether the installation's NiFi was running at that host's newest discovery (phase 1 has no live
// probes; discovering again brings it up to date). Takeover: discover on each host's service executor, make a draft
// from the newest discoveries (grouped and assessed by rules, P1), edit it, confirm it (which imports each
// installation's configuration files as revision 1). Nothing here changes anything on the hosts.

import { useCallback, useEffect, useState } from "react";
import * as api from "./api.ts";
import type { DiscoveryView, DraftItem, DraftSummary, Finding, HostView, MemberStatus, RegisteredService, ServiceConfigView, ServiceDraft, ServiceStatus, ServiceSummary, Skipped } from "./api.ts";
import { ask } from "./Confirm.tsx";
import { Markdown } from "./Markdown.tsx";

const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { hour12: false }) : "—");
type Problem = { message: string; details: string[] };
const problemOf = (e: unknown): Problem => ({ message: (e as Error).message, details: (e as api.ApiError).details ?? [] });

function ProblemLine({ problem }: { problem: Problem | undefined }) {
  if (!problem) return null;
  return <div className="error">{problem.message}{problem.details.length > 0 && <ul>{problem.details.map((d) => <li key={d}>{d}</li>)}</ul>}</div>;
}

const STATE: Record<MemberStatus["state"], { label: string; tone: string; title: string }> = {
  running: { label: "Running", tone: "ok", title: "Running at the host's newest discovery" },
  stopped: { label: "Stopped", tone: "bad", title: "Found but not running at the host's newest discovery" },
  "not-found": { label: "Not found", tone: "warn", title: "The host's newest discovery did not see this installation (not running, or not in a scanned directory)" },
  unknown: { label: "Not discovered", tone: "muted", title: "No finished discovery on this host yet" },
};

function SummaryBadge({ s }: { s: ServiceSummary | null }) {
  if (!s) return <span className="muted">—</span>;
  const tone = s.running === s.members ? "ok" : s.running === 0 ? "bad" : "warn";
  return <>
    <span className={`badge ${tone}`}>{s.running}/{s.members} running</span>
    {s.executorsOnline < s.members && <span className="badge warn" title="A member's service executor is offline: its state is as of the last discovery">{s.members - s.executorsOnline} executor offline</span>}
    {s.versionsSeen.length > 0 && <span className="badge warn" title="Discovery saw a version different from the registered one">seen {s.versionsSeen.join(", ")}</span>}
  </>;
}

const membersOf = (s: RegisteredService) => (s.kind === "cluster" ? s.nodes : [s.member]);

export function ServicesPage({ onTakeover }: { onTakeover: () => void }) {
  const [list, setList] = useState<{ standalones: RegisteredService[]; clusters: RegisteredService[] } | undefined>();
  const [open, setOpen] = useState<string | undefined>();
  const [error, setError] = useState("");
  const refresh = useCallback(() => { api.services().then(setList, (e: Error) => setError(e.message)); }, []);
  useEffect(() => { refresh(); const t = setInterval(refresh, 15_000); return () => clearInterval(t); }, [refresh]);
  if (!list) return error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>;
  const empty = !list.clusters.length && !list.standalones.length;
  const row = (s: RegisteredService) => (
    <tr key={s.id} className="app" onClick={() => setOpen(s.id)}>
      <td className="mono">{s.id}</td>
      <td>{s.service === "nifi" ? "NiFi" : s.service} <span className="mono">{s.version}</span> <span className="muted">{s.profile}</span></td>
      <td>{s.kind === "cluster" ? `${s.nodes.length} nodes` : "Standalone"}</td>
      <td className="mono small">{membersOf(s).map((m) => <div key={`${m.host}:${m.installDir}`}>{m.host}:{m.installDir}</div>)}</td>
      <td><SummaryBadge s={s.status} /></td>
      <td>{s.configRevision ? `Revision ${s.configRevision}` : <span className="muted">None</span>}</td>
      <td className="muted">{when(s.createdAt)} · {s.createdBy}</td>
    </tr>
  );
  return (
    <>
      <div className="toolbar">
        <h1>Services</h1>
        <span className="muted">The NiFi of this environment taken over by the Deployer: clusters and standalone instances. Whether a member runs is as of its host's newest discovery; phase 1 has no live probes.</span>
        <button className="link" onClick={onTakeover}>Take over more…</button>
      </div>
      {error && <p className="error">{error}</p>}
      {open && <ServiceDetail key={open} id={open} onClose={() => setOpen(undefined)} />}
      {empty ? <section className="card"><p className="muted">Nothing is registered yet. Discover on the hosts and confirm a takeover draft first.</p><button className="primary" onClick={onTakeover}>Open Takeover</button></section> : (
        <table>
          <thead><tr><th>Id</th><th>Service</th><th>Kind</th><th>Installations</th><th>Status</th><th>Configuration</th><th>Taken over</th></tr></thead>
          <tbody>
            {list.clusters.map(row)}
            {list.standalones.map(row)}
          </tbody>
        </table>
      )}
    </>
  );
}

function ServiceDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const [s, setS] = useState<ServiceStatus | undefined>();
  const [cfg, setCfg] = useState<ServiceConfigView | null | undefined>();
  const [error, setError] = useState("");
  const load = useCallback(() => { api.serviceStatus(id).then(setS, (e: Error) => setError(e.message)); }, [id]);
  useEffect(() => { load(); const t = setInterval(load, 10_000); return () => clearInterval(t); }, [load]);
  useEffect(() => { api.serviceConfig(id).then(setCfg, () => setCfg(null)); }, [id]);
  if (!s) return <section className="card panel">{error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}</section>;
  const cluster = s.kind === "cluster";
  return (
    <section className="card panel">
      <div className="toolbar">
        <h2>{cluster ? "Cluster" : "Standalone instance"} <span className="mono">{s.id}</span></h2>
        <SummaryBadge s={s.summary} />
        <button className="link" onClick={onClose}>Close</button>
      </div>
      <table>
        <tbody>
          <tr><th>Service</th><td>{s.service === "nifi" ? "NiFi" : s.service} <span className="mono">{s.version}</span> · profile <span className="mono">{s.profile}</span></td></tr>
          {s.webUrl && <tr><th>NiFi UI</th><td className="mono">{s.webUrl}</td></tr>}
          {cluster && <tr><th>ZooKeeper</th><td className="mono">{s.zookeeper ?? "—"} <span className="muted">root</span> {s.zookeeperRoot ?? "—"} <span className="muted">(external, not managed)</span></td></tr>}
          <tr><th>Configuration</th><td>{s.configRevision ? `Revision ${s.configRevision}` : "None"}</td></tr>
          <tr><th>Taken over</th><td>{when(s.createdAt)} by {s.createdBy}{s.draft && <span className="muted"> · draft <span className="mono">{s.draft}</span></span>}</td></tr>
        </tbody>
      </table>
      <h3>{cluster ? "Nodes" : "Installation"}</h3>
      <table>
        <thead><tr><th>Host</th><th>Install directory</th>{cluster && <th>Node address</th>}<th>User</th><th>Ports</th><th>Service executor</th><th>State</th><th>Seen</th></tr></thead>
        <tbody>
          {s.members.map((m) => (
            <tr key={`${m.host}:${m.installDir}`}>
              <td className="mono">{m.host}</td>
              <td className="mono">{m.installDir}</td>
              {cluster && <td className="mono">{m.nodeAddress ?? "—"}</td>}
              <td className="mono">{m.serviceUser ?? "—"}</td>
              <td className="mono small">{Object.entries(m.ports).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(" · ") || "—"}</td>
              <td>{m.executor.online ? <span className="badge ok">Online</span> : <span className="badge bad" title={m.executor.reason}>Offline</span>} <span className="muted">{m.executor.version ?? ""}</span></td>
              <td><span className={`badge ${STATE[m.state].tone}`} title={STATE[m.state].title}>{STATE[m.state].label}</span></td>
              <td className="muted small">{m.seen ? <>{when(m.seen.at)}{m.seen.version && <> · <span className={m.seen.version === s.version ? "" : "error"}>{m.seen.version}</span></>}{m.seen.pid ? ` · pid ${m.seen.pid}` : ""}</> : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {cfg && (
        <details>
          <summary>Configuration revision {cfg.revision} ({cfg.source}, {when(cfg.savedAt)} by {cfg.savedBy}); secret values hidden</summary>
          {cfg.body.members.map((m) => (
            <div key={`${m.host}:${m.installDir}`} className="panel">
              <h3 className="mono">{m.host}:{m.installDir}</h3>
              {m.missing.length > 0 && <p className="muted">Not there: {m.missing.join(", ")}</p>}
              {m.files.map((f) => (
                <details key={f.name}>
                  <summary><span className="mono">{f.name}</span> <span className="muted small">{f.size} bytes · sha256 {f.sha256.slice(0, 12)}… · modified {when(f.modifiedAt)}{f.secrets.length ? ` · ${f.secrets.length} hidden` : ""}</span></summary>
                  <pre className="json">{f.redacted}</pre>
                </details>
              ))}
            </div>
          ))}
        </details>
      )}
    </section>
  );
}

// Takeover.

const FINAL = new Set(["succeeded", "failed", "refused", "rolled-back"]);
const SEVERITY: Record<Finding["severity"], { tone: string; mark: string }> = { error: { tone: "bad", mark: "✕" }, warning: { tone: "warn", mark: "!" }, info: { tone: "info", mark: "i" } };

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
  const [dirs, setDirs] = useState("");
  const e = host.service!;
  const busy = discovery ? !FINAL.has(discovery.state) : false;
  const start = () => {
    onProblem(undefined);
    const list = dirs.split(/[\s,]+/).map((d) => d.trim()).filter(Boolean);
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
        {r.instances.map((i) => <div key={String(i.installDir)}><span className="mono">{String(i.installDir)}</span> NiFi {String(i.version ?? "?")} {i.running ? <span className="badge ok">running</span> : <span className="badge muted">stopped</span>}{i.cluster?.isNode ? <span className="badge info">node</span> : null}</div>)}
        {!r.instances.length && <span className="muted">No NiFi found</span>}
        {r.dirs.filter((d) => !d.found).map((d) => <div key={d.dir} className="error">{d.dir}: {d.error ?? "no NiFi there"}</div>)}
        {r.skipped.length > 0 && <div className="muted">{r.skipped.length} process(es) of other users not read</div>}
      </> : <span className="muted">—</span>}</td>
      {isAdmin && <td>
        <div className="row">
          <input value={dirs} onChange={(ev) => setDirs(ev.target.value)} placeholder="Extra install directories (optional)" title="Absolute paths of NiFi installations that are not running or not in a common directory, separated by spaces" />
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
        <thead><tr><th>Host</th><th>Install directory</th>{item.kind === "cluster" && <th>Node address</th>}<th>User</th><th>Ports</th></tr></thead>
        <tbody>{members.map((m) => (
          <tr key={`${m.host}:${m.installDir}`}>
            <td className="mono">{m.host}</td><td className="mono">{m.installDir}</td>{item.kind === "cluster" && <td className="mono">{m.nodeAddress ?? "—"}</td>}
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
