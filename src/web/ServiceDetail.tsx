// A registered service's page (S23), the same frame for a standalone instance and a cluster: the name and what it runs on,
// its actions (restart, remove, the NiFi UI), then two tabs: Health (default; ServiceHealth.tsx, prototype screen 2) and
// Configuration and changes (start/stop, changes, configuration on one tab). The pages of S37 were pruned after the owner
// turned them down (pages-rethink §9.2) and the Status tab was replaced by Health (§10, step 6a): resolveTab() sends every id
// of a removed page to Health.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import * as api from "./api.ts";
import type { MemberStatus, ServiceConfigView, ServiceStatus } from "./api.ts";
import { memberName, ServiceChanges, useChanges, useDrafts, type ChangeDesk, type Drafts } from "./ServiceChanges.tsx";
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
  configuration: { tab: "config", sub: "configuration" }, changes: { tab: "config", sub: "changes" },
};
/** An id of a page that no longer exists (status, overview, nodes, events, metrics, logs, trace, investigate, tools, …) lands
 *  on Health; "config" and the two old configuration ids are kept. */
export const resolveTab = (id: string): { tab: string; sub?: string } => LEGACY[id] ?? (id === "config" ? { tab: "config" } : { tab: "health" });

/** How a member is named on the charts: a node by address and port, a standalone by host. */
export const memberLabel = (s: ServiceStatus, m: MemberStatus) => (s.kind === "cluster" ? `${m.nodeAddress ?? m.host}:${webPort(m.ports) ?? "?"}` : m.host);

export function ServiceDetail({ id, isAdmin, initialDraft, initialTab, onBack }: { id: string; isAdmin: boolean; initialDraft?: string; initialTab?: string; onBack: () => void }) {
  const [s, setS] = useState<ServiceStatus | undefined>();
  const [cfg, setCfg] = useState<ServiceConfigView | null | undefined>();
  const first = resolveTab(initialDraft ? "changes" : initialTab ?? "health");
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
        onOpenDraft={(draft) => { drafts.choose(draft); drafts.refresh(); go("changes"); }} onOpenConfig={() => go("config")} plan={(r) => desk.plan(r)} />
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
          <span className="fl-muted" style={{ fontSize: 14 }}>{serviceName(s.service)} {s.version} · {cluster ? `cluster, ${s.members.length} nodes` : "standalone"} · {s.environment.toUpperCase()} · {s.members.map((m) => m.host).join(", ")}</span>
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

// Configuration and changes: start and stop a node, what is being done to the service and what was, then its files, and
// the installation facts the Health tab leaves out.
function ConfigAndChanges(l: Loaded) {
  useEffect(() => { if (l.sub) document.getElementById(`cfg-${l.sub}`)?.scrollIntoView?.({ block: "start" }); }, [l.sub, l.desk.active?.id]);
  return (
    <>
      <section id="cfg-control"><NodeControls s={l.s} cfg={l.cfg} desk={l.desk} reload={l.reload} /></section>
      {l.cfg && <section id="cfg-changes"><h2>Changes</h2><ServiceChanges s={l.s} cfg={l.cfg} drafts={l.drafts} desk={l.desk} onSaved={l.saved} onEdit={() => l.open("configuration")} /></section>}
      <section id="cfg-configuration"><h2>Configuration</h2><ServiceConfig cfg={l.cfg} status={l.s} drafts={l.drafts} onReview={() => l.open("changes")} /></section>
      <section id="cfg-install" className="panel">
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
    </>
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
