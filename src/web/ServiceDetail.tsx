// A registered service's page (S23), the same frame for a standalone instance and a cluster: a summary line that
// stays the same in every phase (name, up, findings, soonest certificate; version, environment, ZooKeeper,
// configuration revision; the NiFi UI on the right), then two tabs: Status (default) and Configuration and changes
// (start/stop, changes, configuration on one tab). The pages of S37 were pruned after the owner turned them down
// (pages-rethink §9.2): resolveTab() sends every id of a removed page to Status.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import * as api from "./api.ts";
import type { MemberStatus, ServiceBulletin, ServiceConfigView, ServiceStatus } from "./api.ts";
import { memberName, ServiceChanges, useChanges, useDrafts, type ChangeDesk, type Drafts } from "./ServiceChanges.tsx";
import { ServiceConfig } from "./ServiceConfig.tsx";
import { ask } from "./Confirm.tsx";
import { NginxAddress } from "./Nginx.tsx";
import { ServiceNow } from "./ServiceNow.tsx";
import { AlertBadge } from "./Alerts.tsx";
import { ago, CertBadge, certTone, ConfCell, daysLeft, daysText, fmtBytes, fmtNumber, memberKey, serviceName, SEVERITY, STATE, StatusNotes, UpBadge, webPort, when } from "./svc.tsx";

type Loaded = { s: ServiceStatus; cfg: ServiceConfigView | null | undefined; reload: () => void; drafts: Drafts; desk: ChangeDesk; saved: () => void; open: (tab: string) => void; sub: string | undefined };
type Tab = { id: string; label: string; shown: (l: Loaded) => boolean; render: (l: Loaded) => ReactNode };

/** The tab ids of the old layout and where they went (a tab, and the part of it to show). Any link, `initialTab` or
 *  `oa:open-service` event that still names one of these lands in the new place. */
const LEGACY: Record<string, { tab: string; sub?: string }> = {
  configuration: { tab: "config", sub: "configuration" }, changes: { tab: "config", sub: "changes" },
};
/** An id of a page that no longer exists (overview, nodes, events, metrics, logs, trace, trace-model, data-trace,
 *  investigate, tools, "tools:logs", …) lands on Status; "config" and the two old configuration ids are kept. */
export const resolveTab = (id: string): { tab: string; sub?: string } => LEGACY[id] ?? (id === "config" ? { tab: "config" } : { tab: "status" });

const TABS: Tab[] = [
  { id: "status", label: "Status", shown: () => true, render: (l) => <><ServiceNow s={l.s} canAct={Boolean(l.cfg?.canDraft) && !l.desk.active} plan={(r) => l.desk.plan(r)} open={l.open} /><StatusDetails {...l} /></> },
  { id: "config", label: "Configuration and changes", shown: () => true, render: (l) => <ConfigAndChanges {...l} /> },
];

/** How a member is named on the charts: a node by address and port, a standalone by host. */
export const memberLabel = (s: ServiceStatus, m: MemberStatus) => (s.kind === "cluster" ? `${m.nodeAddress ?? m.host}:${webPort(m.ports) ?? "?"}` : m.host);

export function ServiceDetail({ id, isAdmin, initialDraft, initialTab, onBack }: { id: string; isAdmin: boolean; initialDraft?: string; initialTab?: string; onBack: () => void }) {
  const [s, setS] = useState<ServiceStatus | undefined>();
  const [cfg, setCfg] = useState<ServiceConfigView | null | undefined>();
  const first = resolveTab(initialDraft ? "changes" : initialTab ?? "status");
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
  // Asking for a plan shows it, from wherever it was asked.
  const desk: ChangeDesk = { ...desk0, plan: (request) => { desk0.plan(request); go("changes"); } };
  const back = <button className="link" onClick={onBack}>← Services</button>;
  const remove = async () => {
    if (!(await ask(`Remove ${id} from operations? Deployer stops watching it and its alerts close. NiFi keeps running and no file on the hosts is touched. The history stays, but the name ${id} is not used again: to manage it again, take it over under a new name.`, { confirm: "Remove", danger: true }))) return;
    try { await api.removeService(id); onBack(); } catch (e) { setError((e as Error).message); }
  };
  if (!s) return <>{back}{error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}</>;
  const cluster = s.kind === "cluster";
  const loaded: Loaded = { s, cfg, reload: load, drafts, desk, open: go, sub, saved: () => { loadCfg(); load(); drafts.refresh(); } };
  const tabs = TABS.filter((t) => t.shown(loaded));
  const driftCount = s.members.reduce((n, m) => n + m.configDrift.length, 0);
  const current = tabs.find((t) => t.id === tab) ?? tabs[0]!;
  const f = s.summary.findings;
  return (
    <>
      {back}
      {error && <p className="error">{error}</p>}
      <section className="card svc-summary">
        <div className="svc-summary-main">
          <div className="svc-summary-line">
            <h1 className="mono">{s.id}</h1>
            <span className="badge info">{cluster ? `Cluster · ${s.members.length} nodes` : "Standalone"}</span>
            <UpBadge s={s.summary} />
            <CertBadge s={s.summary} />
            <AlertBadge s={s.summary} />
            {cluster && s.summary.differences > 0 && <span className="badge warn" title="Configuration differences between the nodes found at takeover">{s.summary.differences} node difference{s.summary.differences > 1 ? "s" : ""}</span>}
            {f.error > 0 && <span className="badge bad" title="Takeover findings (listed on Status)">{f.error} error{f.error > 1 ? "s" : ""}</span>}
            {f.warning > 0 && <span className="badge warn" title="Takeover findings (listed on Status)">{f.warning} warning{f.warning > 1 ? "s" : ""}</span>}
            <StatusNotes s={s.summary} />
          </div>
          <div className="svc-summary-facts muted small">
            <span>{serviceName(s.service)} <span className="mono">{s.version}</span> ({s.profile})</span>
            <span>Environment <strong>{s.environment.toUpperCase()}</strong></span>
            {cluster && <span title="An external dependency, not managed (S22)">ZooKeeper <span className="mono">{s.zookeeper ?? "—"}{s.zookeeperRoot ?? ""}</span></span>}
            <span>Configuration {s.configRevision ? <span className="mono">r{s.configRevision}</span> : "none"}</span>
            <span title={`Sampled every ${s.summary.period} s; a member without a sample for 3 periods is unknown`}>As of {s.summary.asOf ? ago(s.summary.asOf) : "—"}</span>
          </div>
        </div>
        <div className="svc-summary-actions">
          {desk.active ? <button className={`change-now state-${desk.active.state}`} onClick={() => go("changes")} title="Open the change on the Configuration and changes tab">Change {desk.active.state}{desk.active.mode !== "full" && desk.active.plan.members.length > 1 ? ` · ${desk.active.progress.done.length}/${desk.active.plan.members.length} nodes` : ""}</button>
            : cfg?.canDraft && <button onClick={() => desk.plan({ kind: cluster ? "rolling-restart" : "restart" })} title={cluster ? "Restart every node, one at a time. Shows the plan first." : "Stop and start NiFi. Shows the plan first."}>{cluster ? "Rolling restart" : "Restart"}</button>}
          {isAdmin && <button className="danger" onClick={remove} disabled={Boolean(desk.active)} title={desk.active ? "A change holds this service: finish or close it first" : "Stop managing this service (NiFi is not touched)"}>Remove</button>}
          {s.webUrl && <a className="button" href={s.webUrl} target="_blank" rel="noreferrer" title={s.webUrl}>NiFi UI ↗</a>}
        </div>
      </section>
      <div className="subtabs" role="tablist">
        {tabs.map((t) => <button key={t.id} role="tab" aria-selected={t.id === current.id} className={t.id === current.id ? "active" : ""} onClick={() => go(t.id)}>{t.label}{t.id === "config" && driftCount > 0 && <span className="badge warn" title="Files on the hosts are not what is kept">{driftCount}</span>}{t.id === "config" && desk.active && <span className={`badge ${desk.active.state === "running" ? "info" : "bad"}`}>{desk.active.state}</span>}</button>)}
      </div>
      {current.render(loaded)}
    </>
  );
}

// Configuration and changes: start and stop a node, what is being done to the service and what was, then its files.
function ConfigAndChanges(l: Loaded) {
  useEffect(() => { if (l.sub) document.getElementById(`cfg-${l.sub}`)?.scrollIntoView?.({ block: "start" }); }, [l.sub, l.desk.active?.id]);
  return (
    <>
      <section id="cfg-control"><NodeControls s={l.s} cfg={l.cfg} desk={l.desk} reload={l.reload} /></section>
      {l.cfg && <section id="cfg-changes"><h2>Changes</h2><ServiceChanges s={l.s} cfg={l.cfg} drafts={l.drafts} desk={l.desk} onSaved={l.saved} onEdit={() => l.open("configuration")} /></section>}
      <section id="cfg-configuration"><h2>Configuration</h2><ServiceConfig cfg={l.cfg} status={l.s} drafts={l.drafts} onReview={() => l.open("changes")} /></section>
    </>
  );
}

const everyText = (seconds: number) => (seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`);

const queuePct = (q: { percentUseCount?: number; percentUseBytes?: number }) => Math.max(q.percentUseCount ?? 0, q.percentUseBytes ?? 0);

function Congested({ s }: { s: ServiceStatus }) {
  const bp = s.summary.backpressure;
  if (!bp?.top.length) return null;
  return (
    <div>
      <h3>Most congested queues</h3>
      <table>
        <thead><tr><th>Connection</th><th>Group</th><th>From → to</th><th>Full</th><th>Queued</th></tr></thead>
        <tbody>{bp.top.map((q, i) => (
          <tr key={q.id ?? i}>
            <td>{q.name || <span className="muted mono small">{q.id ?? "?"}</span>}</td>
            <td>{q.group ?? "—"}</td>
            <td className="small">{q.sourceName ?? "?"} → {q.destinationName ?? "?"}</td>
            <td className="mono small"><span className={`badge ${queuePct(q) >= 100 ? "bad" : queuePct(q) >= 80 ? "warn" : "muted"}`} title={`objects ${q.percentUseCount ?? 0} %, size ${q.percentUseBytes ?? 0} %`}>{queuePct(q)} %</span></td>
            <td className="mono small">{fmtNumber(q.flowFilesQueued ?? null, 0)} · {fmtBytes(q.bytesQueued ?? null)}</td>
          </tr>
        ))}</tbody>
      </table>
      <p className="muted small">The fullest {bp.top.length} of {fmtNumber(bp.connections, 0)} connections (flow-wide), as of {when(bp.at)}; read every {everyText(bp.everySeconds)}, only this summary is kept.</p>
    </div>
  );
}

function StateBadge({ m }: { m: MemberStatus }) {
  const st = STATE[m.state];
  const why = m.source === "discovery" ? " (as of the host's newest discovery: no sample yet)" : m.source === "executor" ? ` (${m.executor.reason ?? "executor offline"})` : "";
  return <span className={`badge ${st.tone}`} title={`${st.title}${why}`}>{st.label}</span>;
}

// Status, below the to-dos (what the old Overview and Nodes showed that the to-dos do not): congested queues,
// certificates, the nginx address, what the takeover found, the newest bulletins, and each installation's facts.
function StatusDetails({ s, reload }: Loaded) {
  const [bulletins, setBulletins] = useState<ServiceBulletin[] | undefined>();
  useEffect(() => { api.serviceBulletins(s.id, 10).then((r) => setBulletins(r.bulletins), () => setBulletins([])); }, [s.id, s.summary.asOf]);
  return (
    <div className="panel">
      <Congested s={s} />
      <Certificates s={s} />
      <NginxAddress s={s} onChanged={reload} />
      {s.findings.length > 0 && <div>
        <h3>Found at takeover</h3>
        <ul className="findings card">{s.findings.map((f, i) => (
          <li key={i}>
            <span className={`badge ${SEVERITY[f.severity].tone}`}>{SEVERITY[f.severity].mark} {f.severity}</span> <span className="mono small">{f.code}</span> {f.message}
            {f.values && f.values.length > 0 && <ul className="small">{f.values.map((v) => <li key={`${v.host}:${v.installDir}`}><span className="mono">{v.host}:{v.installDir}</span> {v.value ?? <span className="muted">not set</span>}</li>)}</ul>}
          </li>
        ))}</ul>
      </div>}
      {bulletins && bulletins.length > 0 && <div>
        <h3>Newest bulletins</h3>
        <table>
          <thead><tr><th>Time</th><th>Level</th><th>Node</th><th>Source</th><th>Message</th></tr></thead>
          <tbody>{bulletins.map((b) => (
            <tr key={`${b.node}:${b.id}:${b.at}`}>
              <td className="muted small">{when(b.at)}</td>
              <td><span className={`badge ${b.level === "ERROR" ? "bad" : b.level === "WARNING" || b.level === "WARN" ? "warn" : "muted"}`}>{b.level ?? "?"}</span></td>
              <td className="mono small">{b.node}</td>
              <td className="small">{b.source ?? b.category ?? "—"}</td>
              <td className="small">{b.message}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>}
      <details>
        <summary><strong>{s.kind === "cluster" ? "Nodes" : "Installation"} in detail</strong> <span className="muted small">directories, user, ports, executor, certificate</span></summary>
        <InstallDetails s={s} />
      </details>
    </div>
  );
}

// S27: every certificate the collector read, soonest expiry first; stores it could not read with the reason.
function Certificates({ s }: { s: ServiceStatus }) {
  if (!s.certs.length) return null;
  const label = (key: string) => { const m = s.members.find((x) => x.key === key); return m ? memberLabel(s, m) : key; };
  const rows = [...s.certs].sort((a, b) => (a.notAfter ?? "~") < (b.notAfter ?? "~") ? -1 : 1);
  return (
    <div>
      <h3>Certificates</h3>
      <p className="muted small">Read by each host's service executor from nifi.properties' keystore and truststore (and its own monitor certificate) about once an hour; only the newest reading is kept. {s.summary.certDays.warn} days or less is a warning, {s.summary.certDays.crit} days or less critical (the thresholds on Events and alerts).</p>
      <table>
        <thead><tr><th>{s.kind === "cluster" ? "Node" : "Host"}</th><th>Store</th><th>Subject</th><th>Issuer</th><th>Expires</th><th>Left</th><th>Read</th></tr></thead>
        <tbody>{rows.map((c, i) => {
          const days = c.notAfter ? daysLeft(c.notAfter) : null;
          return (
            <tr key={i}>
              <td className="mono small">{label(c.member)}</td>
              <td className="small"><span title={c.path ?? undefined}>{c.store}</span>{c.type ? <span className="muted"> {c.type}</span> : null}{c.alias ? <span className="muted mono"> {c.alias}{c.chain && c.chain > 1 ? ` #${c.chain}` : ""}</span> : null}</td>
              {c.error ? <td colSpan={4} className="error small">Could not read: {c.error}</td> : <>
                <td className="mono small">{c.subject}</td>
                <td className="mono small muted">{c.issuer}</td>
                <td className="small">{c.notAfter ? new Date(c.notAfter).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "—"}</td>
                <td>{days !== null ? <span className={`badge ${certTone(days, s.summary.certDays)}`}>{daysText(days)}</span> : "—"}</td>
              </>}
              <td className="muted small" title={when(c.readAt)}>{ago(c.readAt)}</td>
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
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
