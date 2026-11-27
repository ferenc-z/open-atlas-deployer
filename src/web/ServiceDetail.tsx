// A registered service's page (S23), the same frame for a standalone instance and a cluster: the name and what it runs on,
// its actions (restart, remove, the NiFi UI), then two tabs: Health (default; ServiceHealth.tsx, prototype screen 2) and
// Configuration and changes (start/stop, changes, configuration on one tab). The pages of S37 were pruned after the owner
// turned them down (pages-rethink §9.2) and the Status tab was replaced by Health (§10, step 6a): resolveTab() sends every id
// of a removed page to Health.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import * as api from "./api.ts";
import type { MemberStatus, ServiceConfigView, ServiceStatus } from "./api.ts";
import { ChangeHistory, Drift, DraftsPage, memberName, PendingBar, PinnedChange, Revisions, useChanges, useDrafts, type ChangeDesk, type Drafts } from "./ServiceChanges.tsx";
import { ServiceConfig } from "./ServiceConfig.tsx";
import { ask } from "./Confirm.tsx";
import { NginxAddress } from "./Nginx.tsx";
import { ServiceHealth } from "./ServiceHealth.tsx";
import { ago, ConfCell, daysLeft, daysText, certTone, memberKey, serviceName, SEVERITY, STATE, webPort, when } from "./svc.tsx";
import "./ops.css";

type Loaded = { s: ServiceStatus; cfg: ServiceConfigView | null | undefined; reload: () => void; drafts: Drafts; desk: ChangeDesk; saved: () => void; open: (tab: string) => void; sub: string | undefined };
type Tab = { id: string; label: string; render: (l: Loaded) => ReactNode };

/** The tab ids of the old layout and where they went (a tab, and the part of it to show). Any link, `initialTab` or
 *  `oa:open-service` event that still names one of these lands in the new place. */
const LEGACY: Record<string, { tab: string; sub?: string }> = {
  configuration: { tab: "config", sub: "files" }, changes: { tab: "config", sub: "changes" },
  // The pages inside Configuration and changes can be named directly.
  files: { tab: "config", sub: "files" }, certs: { tab: "config", sub: "certs" }, drafts: { tab: "config", sub: "drafts" }, revs: { tab: "config", sub: "revs" }, drift: { tab: "config", sub: "drift" },
};
/** An id of a page that no longer exists (status, overview, nodes, events, metrics, logs, trace, investigate, tools, …) lands
 *  on Health; "config" and the two old configuration ids are kept. */
export const resolveTab = (id: string): { tab: string; sub?: string } => LEGACY[id] ?? (id === "config" ? { tab: "config" } : { tab: "health" });

/** How a member is named on the charts: a node by address and port, a standalone by host. */
export const memberLabel = (s: ServiceStatus, m: MemberStatus) => (s.kind === "cluster" ? `${m.nodeAddress ?? m.host}:${webPort(m.ports) ?? "?"}` : m.host);

export function ServiceDetail({ id, isAdmin, initialDraft, initialTab, onBack }: { id: string; isAdmin: boolean; initialDraft?: string; initialTab?: string; onBack: () => void }) {
  const [s, setS] = useState<ServiceStatus | undefined>();
  const [cfg, setCfg] = useState<ServiceConfigView | null | undefined>();
  const first = resolveTab(initialDraft ? "drafts" : initialTab ?? "health");
  const [tab, setTab] = useState(first.tab);
  const [sub, setSub] = useState<string | undefined>(first.sub);
  const go = useCallback((target: string) => { const r = resolveTab(target); setTab(r.tab); setSub(r.sub); }, []);
  const [error, setError] = useState("");
  const load = useCallback(() => { api.serviceStatus(id).then(setS, (e: Error) => setError(e.message)); }, [id]);
  useEffect(() => { load(); const t = setInterval(load, 10_000); return () => clearInterval(t); }, [load]);
  const loadCfg = useCallback(() => { api.serviceConfig(id).then(setCfg, () => setCfg(null)); }, [id]);
  useEffect(loadCfg, [loadCfg]);
  const drafts = useDrafts(id, initialDraft);
  const desk0 = useChanges(id, () => { loadCfg(); load(); });
  // Asking for a plan shows it, from wherever it was asked: pinned on top of every Configuration and changes page, so only
  // Health has to move.
  const desk: ChangeDesk = { ...desk0, plan: (request) => { desk0.plan(request); if (tab !== "config") go("changes"); } };
  const back = <button className="link" onClick={onBack}>← Managed services</button>;
  const remove = async () => {
    if (!(await ask(`Remove ${id} from operations? Deployer stops watching it and its alerts close. NiFi keeps running and no file on the hosts is touched. The history stays, but the name ${id} is not used again: to manage it again, take it over under a new name.`, { confirm: "Remove", danger: true }))) return;
    try { await api.removeService(id); onBack(); } catch (e) { setError((e as Error).message); }
  };
  if (!s) return <div className="fl ops">{back}{error ? <p className="fl-error">{error}</p> : <p className="fl-muted">Loading…</p>}</div>;
  const cluster = s.kind === "cluster";
  const loaded: Loaded = { s, cfg, reload: load, drafts, desk, open: go, sub, saved: () => { loadCfg(); load(); drafts.refresh(); } };
  const driftCount = s.members.reduce((n, m) => n + m.configDrift.length, 0);
  const tabs: Tab[] = [
    { id: "health", label: "Health", render: () => (
      <ServiceHealth id={id} isAdmin={isAdmin} canDraft={Boolean(cfg?.canDraft)} busy={Boolean(desk.active)}
        onOpenDraft={(draft) => { drafts.choose(draft); drafts.refresh(); go("drafts"); }} onOpenConfig={() => go("config")} plan={(r) => desk.plan(r)} />
    ) },
    { id: "config", label: "Configuration and changes", render: (l) => <ConfigAndChanges {...l} /> },
  ];
  const current = tabs.find((t) => t.id === tab) ?? tabs[0]!;
  return (
    <div className="fl ops">
      <div className="sv-head">
        {back}
        {error && <p className="fl-error">{error}</p>}
        <div className="line">
          <h1 className="mono">{s.id}</h1>
          <span className="fl-muted" style={{ fontSize: 14 }}>{serviceName(s.service)} {s.version} · {cluster ? `cluster, ${s.members.length} nodes` : "standalone"} · {s.environment.toUpperCase()} · {[...new Set(s.members.map((m) => m.host))].join(", ")}</span>
          <span style={{ flex: 1 }} />
          <span className="acts">
            {desk.active ? <button className={`change-now state-${desk.active.state}`} onClick={() => go("changes")} title="Open the change on the Configuration and changes tab">Change {desk.active.state}{desk.active.mode !== "full" && desk.active.plan.members.length > 1 ? ` · ${desk.active.progress.done.length}/${desk.active.plan.members.length} nodes` : ""}</button>
              : cfg?.canDraft && <button className="fl-btn small" onClick={() => desk.plan({ kind: cluster ? "rolling-restart" : "restart" })} title={cluster ? "Restart every node, one at a time. Shows the plan first." : "Stop and start NiFi. Shows the plan first."}>{cluster ? "Rolling restart" : "Restart"}</button>}
            {isAdmin && <button className="fl-btn small" style={{ color: "#B3261E" }} onClick={remove} disabled={Boolean(desk.active)} title={desk.active ? "A change holds this service: finish or close it first" : "Stop managing this service (NiFi is not touched)"}>Remove</button>}
            {s.webUrl && <a className="fl-btn small" href={s.webUrl} target="_blank" rel="noreferrer" title={s.webUrl}>NiFi UI ↗</a>}
          </span>
        </div>
        <div className="sv-tabs" role="tablist">
          {tabs.map((t) => <button key={t.id} type="button" role="tab" aria-selected={t.id === current.id} onClick={() => go(t.id)}>{t.label}{t.id === "config" && driftCount > 0 && <span className="badge warn" title="Files on the hosts are not what is kept">{driftCount}</span>}{t.id === "config" && desk.active && <span className={`badge ${desk.active.state === "running" ? "info" : "bad"}`}>{desk.active.state}</span>}</button>)}
        </div>
      </div>
      {current.render(loaded)}
    </div>
  );
}

// Configuration and changes (S41): four status tiles on top, a running change pinned under them, and a page at a time on the
// left (Files, Certificates, Drafts, Changes, Revisions; Drift only while a host differs). `sub` picks the page.
function ConfigAndChanges(l: Loaded) {
  const { s, cfg, desk, drafts } = l;
  const driftCount = s.members.reduce((n, m) => n + m.configDrift.length, 0);
  const pending = s.members.reduce((n, m) => n + m.configPending.length, 0);
  const sub = l.sub === "drift" || ["files", "certs", "drafts", "changes", "revs"].includes(l.sub ?? "") ? l.sub! : "files";
  const soonest = s.certs.filter((c) => c.notAfter).sort((a, b) => (a.notAfter! < b.notAfter! ? -1 : 1))[0];
  const days = soonest ? daysLeft(soonest.notAfter!) : null;
  const certKind = days === null ? "muted" : certTone(days, s.summary.certDays);
  const last = desk.list.find((c) => c.finishedAt);
  const running = desk.active;
  const tiles: { id: string; label: string; value: string; note: string; tone: string }[] = [
    { id: "revs", label: "Kept", value: cfg ? `r${cfg.revision}` : "Not kept yet", note: !cfg ? "no configuration is kept" : pending > 0 ? `not on ${pending} file${pending > 1 ? "s" : ""} on the hosts yet` : driftCount > 0 ? "hosts differ from it (drift)" : "on all hosts", tone: !cfg ? "muted" : pending > 0 ? "info" : driftCount > 0 ? "warn" : "ok" },
    { id: "drafts", label: "Drafts", value: drafts.list.length ? `${drafts.list.length} open` : "None", note: drafts.list.length ? "review and save" : "edit a key to start one", tone: drafts.list.length ? "info" : "muted" },
    { id: "certs", label: "Certificates", value: days === null ? "Not read" : days < 0 ? `Expired ${-days}d ago` : `Expire in ${days}d`, note: soonest ? `soonest: ${soonest.store}` : "no certificate read yet", tone: certKind },
    { id: "changes", label: "Changes", value: running ? (CHANGE_RUNNING[running.state] ?? running.state) : "Nothing running", note: running ? (running.mode !== "full" && running.plan.members.length > 1 ? `${running.progress.done.length} of ${running.plan.members.length} nodes done` : "holds the service") : last ? `last: ${last.kind} ${last.state}` : "none so far", tone: running ? "info" : "muted" },
  ];
  const views: { id: string; label: string; count?: string }[] = [
    { id: "files", label: "Files" },
    { id: "certs", label: "Certificates", ...(days !== null && days <= (s.summary.certDays?.warn ?? 30) ? { count: daysText(days) } : {}) },
    { id: "drafts", label: "Drafts", ...(drafts.list.length ? { count: String(drafts.list.length) } : {}) },
    { id: "changes", label: "Changes", ...(running ? { count: running.state } : {}) },
    { id: "revs", label: "Revisions", ...(cfg ? { count: `r${cfg.revision}` } : {}) },
    ...(driftCount > 0 || sub === "drift" ? [{ id: "drift", label: "Drift", count: String(driftCount) }] : []),
  ];
  const showBar = drafts.list.length > 0 && sub !== "drafts" && !running;
  const barDraft = drafts.active ?? drafts.list[0];
  const review = () => { if (barDraft) drafts.choose(barDraft.id); l.open("drafts"); };
  return (
    <div className="cfg-page">
      <div className="cfg-tiles">{tiles.map((t) => (
        <button key={t.id} className={`cfg-tile tone-${t.tone}`} onClick={() => l.open(t.id)}>
          <span className="cfg-tile-label">{t.label}</span><strong>{t.value}</strong><span className="muted small">{t.note}</span>
        </button>
      ))}</div>
      {cfg && <PinnedChange s={s} cfg={cfg} desk={desk} full={sub === "changes"} onOpen={() => l.open("changes")} />}
      <div className="cfg-body">
        <nav className="cfg-nav" aria-label="Configuration and changes">{views.map((v) => (
          <button key={v.id} aria-current={v.id === sub ? "page" : undefined} onClick={() => l.open(v.id)}><span>{v.label}</span>{v.count && <span className="muted small">{v.count}</span>}</button>
        ))}</nav>
        <div className="cfg-main">
          {sub === "files" && <>
            <ServiceConfig cfg={cfg} status={s} drafts={drafts} />
            <InstallPanel s={s} reload={l.reload} />
          </>}
          {sub === "certs" && <CertsPage s={s} />}
          {sub === "drafts" && (cfg ? <DraftsPage s={s} cfg={cfg} drafts={drafts} onSaved={l.saved} onEdit={() => l.open("files")} /> : <p className="muted">No configuration is kept for this service yet.</p>)}
          {sub === "changes" && <>
            {cfg && <PendingBar s={s} cfg={cfg} desk={desk} />}
            <NodeControls s={s} cfg={cfg} desk={desk} reload={l.reload} />
            {cfg && <ChangeHistory s={s} desk={desk} canSteer={cfg.canDraft} />}
          </>}
          {sub === "revs" && cfg && <>
            <PendingBar s={s} cfg={cfg} desk={desk} />
            <Revisions s={s} cfg={cfg} desk={desk} onSaved={l.saved} />
          </>}
          {sub === "revs" && !cfg && <p className="muted">No configuration is kept for this service yet.</p>}
          {sub === "drift" && cfg && <Drift s={s} cfg={cfg} desk={desk} onSaved={l.saved} />}
        </div>
      </div>
      {showBar && barDraft && <div className="cfg-draftbar">
        <span>{drafts.list.length === 1 ? `${barDraft.id} · ${barDraft.changes.length} change${barDraft.changes.length === 1 ? "" : "s"} · not saved as a revision yet` : `${drafts.list.length} open drafts · not saved as revisions yet`}</span>
        <button onClick={review}>Review →</button>
      </div>}
    </div>
  );
}

const CHANGE_RUNNING: Record<string, string> = { running: "Running", paused: "Paused", stopped: "Stopped, waiting" };

/** Certificates: what each node's keystore and truststore hold now. The certificate library and uploading come later. */
function CertsPage({ s }: { s: ServiceStatus }) {
  const cluster = s.kind === "cluster";
  const name = (key: string) => (cluster ? memberName(s, key) : (s.members.find((m) => m.key === key)?.host ?? key));
  const rows = [...s.certs].sort((a, b) => (a.member === b.member ? 0 : a.member < b.member ? -1 : 1));
  return (
    <section className="panel">
      <h3>Certificates in use</h3>
      {!rows.length ? <p className="muted">No certificate has been read from the hosts yet.</p> : <table className="props">
        <thead><tr>{cluster && <th>Node</th>}<th>Store</th><th>Subject</th><th>Expires</th></tr></thead>
        <tbody>{rows.map((c, i) => {
          const d = c.notAfter ? daysLeft(c.notAfter) : null;
          return (
            <tr key={i}>
              {cluster && <td className="mono">{name(c.member)}</td>}
              <td className="mono small">{c.store}</td>
              <td className="mono small">{c.subject ?? "—"}</td>
              <td>{c.error ? <span className="badge warn" title={c.error}>unreadable</span> : d !== null ? <span className={`badge ${certTone(d, s.summary.certDays)}`} title={when(c.notAfter)}>{daysText(d)}</span> : "—"}</td>
            </tr>
          );
        })}</tbody>
      </table>}
      <p className="muted small">Coming soon: a certificate library, so one certificate can be kept once, checked, and rolled out to several services, and uploading a new one here.</p>
    </section>
  );
}

/** The installation facts the Health tab leaves out: the address behind nginx, what was found at takeover, the directories. */
function InstallPanel({ s, reload }: { s: ServiceStatus; reload: () => void }) {
  const l = { s, reload };
  return (
      <section className="panel">
        <NginxAddress s={l.s} onChanged={l.reload} />
        {l.s.findings.length > 0 && <div>
          <h3>Found at takeover</h3>
          <ul className="findings card">{l.s.findings.map((f, i) => (
            <li key={i}>
              <span className={`badge ${SEVERITY[f.severity].tone}`}>{SEVERITY[f.severity].mark} {f.severity}</span> <span className="mono small">{f.code}</span> {f.message}
              {f.values && f.values.length > 0 && <ul className="small">{f.values.map((v) => <li key={`${v.host}:${v.installDir}`}><span className="mono">{v.host}:{v.installDir}</span> {v.value ?? <span className="muted">not set</span>}</li>)}</ul>}
            </li>
          ))}</ul>
        </div>}
        <details>
          <summary><strong>{l.s.kind === "cluster" ? "Nodes" : "Installation"} in detail</strong> <span className="muted small">directories, user, ports, executor, certificate</span></summary>
          <InstallDetails s={l.s} />
        </details>
      </section>
  );
}

function StateBadge({ m }: { m: MemberStatus }) {
  const st = STATE[m.state];
  const why = m.source === "discovery" ? " (as of the host's newest discovery: no sample yet)" : m.source === "executor" ? ` (${m.executor.reason ?? "executor offline"})` : "";
  return <span className={`badge ${st.tone}`} title={`${st.title}${why}`}>{st.label}</span>;
}

/** Starting and stopping one node or installation (§8): each button shows a plan first. An admin says what it starts with if that is not known. */
function NodeControls({ s, cfg, desk, reload }: Pick<Loaded, "s" | "cfg" | "desk" | "reload">) {
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ member: string; ok: string; dropped: string[] } | null>(null);
  const [error, setError] = useState("");
  const cluster = s.kind === "cluster";
  const canAct = Boolean(cfg?.canDraft) && !desk.active;
  const save = async (member: string) => {
    const environment: Record<string, string> = {};
    for (const line of text.split("\n").map((x) => x.trim()).filter(Boolean)) {
      const at = line.indexOf("=");
      if (at < 1) { setError(`Not NAME=value: ${line.slice(0, 40)}`); return; }
      environment[line.slice(0, at).trim()] = line.slice(at + 1);
    }
    setBusy(true); setError("");
    try {
      const out = await api.setMemberStart(s.id, member, environment);
      setNote({ member, ok: out.kept.join(", "), dropped: out.dropped });
      setEditing(null); setText("");
      reload();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="panel node-controls">
      <h3>Start and stop</h3>
      <p className="muted small">Each button shows a plan first; nothing happens until you confirm it. {cluster ? "One node at a time: the others keep running. To restart them all, use Rolling restart at the top of the page." : ""}{desk.active ? ` Change ${desk.active.id} holds this service for now.` : ""}</p>
      {s.members.map((m) => {
        const request = { members: [m.key] };
        return (
          <div key={m.key} className="node-control">
            <div className="node-control-main">
              <span className="mono">{cluster ? memberName(s, m.key) : m.host}</span>
              <StateBadge m={m} />
              {m.live?.pid ? <span className="muted small">pid {m.live.pid}</span> : null}
              {canAct && <div className="row node-control-buttons">
                {m.state !== "running" && <button onClick={() => desk.plan({ kind: "start", ...request })}>Start</button>}
                {m.state !== "stopped" && <button onClick={() => desk.plan({ kind: "restart", ...request })}>Restart</button>}
                {m.state !== "stopped" && <button onClick={() => desk.plan({ kind: "stop", ...request })}>Stop</button>}
              </div>}
            </div>
            <div className="small">
              <span className="muted">Starts with: </span>
              {m.startEnvironment?.length ? <span className="mono">{m.startEnvironment.join(", ")}</span> : <span className="muted">no known environment, only what NiFi's own scripts set</span>}
              {cfg?.canReveal && !desk.active && editing !== m.key && <> · <button className="link" onClick={() => { setEditing(m.key); setText(""); setError(""); setNote(null); }}>{m.startEnvironment?.length ? "Replace" : "Set"}</button></>}
            </div>
            {note?.member === m.key && <p className="small ok">Kept: {note.ok || "nothing"}.{note.dropped.length > 0 && <span className="error"> Left out: {note.dropped.join(", ")}.</span>}</p>}
            {editing === m.key && <div className="plan">
              <label className="field">Start environment<textarea rows={4} className="mono" value={text} onChange={(e) => setText(e.target.value)} placeholder={"JAVA_HOME=/usr/lib/jvm/java-21\nNIFI_HOME=/opt/nifi"} />
                <span className="muted small">One NAME=value a line. Needed only for a NiFi the Deployer has never seen running: each time it stops a running NiFi, it reads this from the process instead and replaces what you enter. Only the names NiFi needs are kept and anything that looks like a secret is left out; the values are not shown again. Empty forgets what is kept.</span></label>
              <div className="row"><button className="primary" onClick={() => void save(m.key)} disabled={busy}>Save</button><button onClick={() => setEditing(null)}>Cancel</button></div>
            </div>}
          </div>
        );
      })}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function InstallDetails({ s }: { s: ServiceStatus }) {
  const cluster = s.kind === "cluster";
  const soonest = (m: MemberStatus) => s.certs.filter((c) => c.member === m.key && c.notAfter).sort((a, b) => (a.notAfter! < b.notAfter! ? -1 : 1))[0];
  const unread = (m: MemberStatus) => s.certs.filter((c) => c.member === m.key && c.error).length;
  return (
    <>
    <table>
      <thead><tr><th>Host</th><th>Install directory</th><th>Conf directory</th>{cluster && <th>Node address</th>}<th>User</th><th>Ports</th><th>Service executor</th><th>State</th><th>Certificate</th><th>As of</th></tr></thead>
      <tbody>
        {s.members.map((m) => {
          const c = soonest(m), bad = unread(m), days = c ? daysLeft(c.notAfter!) : null;
          const version = m.live?.version ?? m.seen?.version;
          return (
            <tr key={memberKey(m)}>
              <td className="mono">{m.host}</td>
              <td className="mono">{m.installDir}</td>
              <ConfCell m={m} />
              {cluster && <td className="mono">{m.nodeAddress ?? "—"}</td>}
              <td className="mono">{m.serviceUser ?? "—"}</td>
              <td className="mono small">{Object.entries(m.ports).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(" · ") || "—"}</td>
              <td>{m.executor.online ? <span className="badge ok">Online</span> : <span className="badge bad" title={m.executor.reason}>Offline</span>} <span className="muted">{m.executor.version ?? ""}</span></td>
              <td><StateBadge m={m} /></td>
              <td>{days !== null && c ? <span className={`badge ${certTone(days, s.summary.certDays)}`} title={`${c.subject ?? "?"} (${c.store}), ${when(c.notAfter)}`}>{daysText(days)}</span> : <span className="muted">—</span>}{bad > 0 && <span className="badge warn" title={s.certs.filter((x) => x.member === m.key && x.error).map((x) => `${x.store}: ${x.error}`).join("\n")}>{bad} unreadable</span>}</td>
              <td className="muted small" title={m.asOf ? when(m.asOf) : undefined}>{m.asOf ? <>{ago(m.asOf)}{version && <> · <span className={version === s.version ? "" : "error"}>{version}</span></>}{m.live?.pid ? ` · pid ${m.live.pid}` : m.seen?.pid ? ` · pid ${m.seen.pid}` : ""}</> : "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
    </>
  );
}
