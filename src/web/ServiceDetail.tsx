// A registered service's page (S23), the same frame for a standalone instance and a cluster: a summary line that
// stays the same in every phase (name, up, findings; version, environment, ZooKeeper, configuration revision; the
// NiFi UI on the right), then tabs. Phase 1 has Overview, Nodes and Configuration; later phases add theirs to TABS
// (Metrics, Logs, Events and alerts, FlowFile trace, Changes) and a tab without data yet is not shown.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import * as api from "./api.ts";
import type { ServiceConfigView, ServiceStatus } from "./api.ts";
import { ServiceConfig } from "./ServiceConfig.tsx";
import { ConfCell, memberKey, serviceName, SEVERITY, STATE, StatusNotes, UpBadge, webPort, when } from "./svc.tsx";

type Loaded = { s: ServiceStatus; cfg: ServiceConfigView | null | undefined };
type Tab = { id: string; label: string; shown: (l: Loaded) => boolean; render: (l: Loaded) => ReactNode };

const TABS: Tab[] = [
  { id: "overview", label: "Overview", shown: () => true, render: (l) => <Overview {...l} /> },
  { id: "nodes", label: "Nodes", shown: () => true, render: (l) => <Nodes s={l.s} /> },
  { id: "configuration", label: "Configuration", shown: () => true, render: (l) => <ServiceConfig cfg={l.cfg} status={l.s} /> },
];

export function ServiceDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [s, setS] = useState<ServiceStatus | undefined>();
  const [cfg, setCfg] = useState<ServiceConfigView | null | undefined>();
  const [tab, setTab] = useState("overview");
  const [error, setError] = useState("");
  const load = useCallback(() => { api.serviceStatus(id).then(setS, (e: Error) => setError(e.message)); }, [id]);
  useEffect(() => { load(); const t = setInterval(load, 10_000); return () => clearInterval(t); }, [load]);
  useEffect(() => { api.serviceConfig(id).then(setCfg, () => setCfg(null)); }, [id]);
  const back = <button className="link" onClick={onBack}>← Services</button>;
  if (!s) return <>{back}{error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}</>;
  const cluster = s.kind === "cluster";
  const loaded = { s, cfg };
  const tabs = TABS.filter((t) => t.shown(loaded));
  const current = tabs.find((t) => t.id === tab) ?? tabs[0]!;
  const f = s.summary.findings;
  return (
    <>
      {back}
      <section className="card svc-summary">
        <div className="svc-summary-main">
          <div className="svc-summary-line">
            <h1 className="mono">{s.id}</h1>
            <span className="badge info">{cluster ? `Cluster · ${s.members.length} nodes` : "Standalone"}</span>
            <UpBadge s={s.summary} />
            {cluster && s.summary.differences > 0 && <span className="badge warn" title="Configuration differences between the nodes found at takeover">{s.summary.differences} node difference{s.summary.differences > 1 ? "s" : ""}</span>}
            {f.error > 0 && <span className="badge bad" title="Takeover findings (phase 1 has no alerts)">{f.error} error{f.error > 1 ? "s" : ""}</span>}
            {f.warning > 0 && <span className="badge warn" title="Takeover findings (phase 1 has no alerts)">{f.warning} warning{f.warning > 1 ? "s" : ""}</span>}
            <StatusNotes s={s.summary} />
          </div>
          <div className="svc-summary-facts muted small">
            <span>{serviceName(s.service)} <span className="mono">{s.version}</span> ({s.profile})</span>
            <span>Environment <strong>{s.environment.toUpperCase()}</strong></span>
            {cluster && <span title="An external dependency, not managed (S22)">ZooKeeper <span className="mono">{s.zookeeper ?? "—"}{s.zookeeperRoot ?? ""}</span></span>}
            <span>Configuration {s.configRevision ? <span className="mono">r{s.configRevision}</span> : "none"}</span>
          </div>
        </div>
        <div className="svc-summary-actions">
          {s.webUrl && <a className="button" href={s.webUrl} target="_blank" rel="noreferrer" title={s.webUrl}>NiFi UI ↗</a>}
        </div>
      </section>
      <div className="subtabs" role="tablist">
        {tabs.map((t) => <button key={t.id} role="tab" aria-selected={t.id === current.id} className={t.id === current.id ? "active" : ""} onClick={() => setTab(t.id)}>{t.label}</button>)}
      </div>
      {current.render(loaded)}
    </>
  );
}

// Overview: key numbers, the nodes, what the takeover found, the timeline; a block without data is left out.
function Overview({ s }: Loaded) {
  const cluster = s.kind === "cluster";
  return (
    <div className="panel">
      <div className="metrics">
        <div className="metric"><span className="muted small">{cluster ? "Nodes" : "Installations"}</span><strong>{s.summary.members}</strong><span className="small muted">{s.summary.running} up · {s.summary.executorsOnline} executor{s.summary.executorsOnline === 1 ? "" : "s"} online</span></div>
      </div>
      <div>
        <h3>{cluster ? "Nodes" : "Installation"}</h3>
        <table>
          <thead><tr><th>{cluster ? "Node" : "Host"}</th><th>Host and port</th><th>State</th><th>Seen</th></tr></thead>
          <tbody>{s.members.map((m) => (
            <tr key={memberKey(m)}>
              <td className="mono">{cluster ? m.nodeAddress ?? m.host : m.host}</td>
              <td className="mono">{m.host}{webPort(m.ports) ? `:${webPort(m.ports)}` : ""}</td>
              <td><span className={`badge ${STATE[m.state].tone}`} title={STATE[m.state].title}>{STATE[m.state].label}</span></td>
              <td className="muted small">{m.seen ? <>{when(m.seen.at)}{m.seen.pid ? ` · pid ${m.seen.pid}` : ""}</> : "—"}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {s.findings.length > 0 && <div>
        <h3>Found at takeover</h3>
        <ul className="findings card">{s.findings.map((f, i) => (
          <li key={i}>
            <span className={`badge ${SEVERITY[f.severity].tone}`}>{SEVERITY[f.severity].mark} {f.severity}</span> <span className="mono small">{f.code}</span> {f.message}
            {f.values && f.values.length > 0 && <ul className="small">{f.values.map((v) => <li key={`${v.host}:${v.installDir}`}><span className="mono">{v.host}:{v.installDir}</span> {v.value ?? <span className="muted">not set</span>}</li>)}</ul>}
          </li>
        ))}</ul>
      </div>}
      {s.events.length > 0 && <div>
        <h3>Timeline</h3>
        <ol className="timeline">{s.events.map((e, i) => (
          <li key={i}><span className="muted small">{when(e.at)}</span> <span>{e.text}</span> <span className="muted small">by {e.by}</span></li>
        ))}</ol>
      </div>}
    </div>
  );
}

function Nodes({ s }: { s: ServiceStatus }) {
  const cluster = s.kind === "cluster";
  return (
    <table>
      <thead><tr><th>Host</th><th>Install directory</th><th>Conf directory</th>{cluster && <th>Node address</th>}<th>User</th><th>Ports</th><th>Service executor</th><th>State</th><th>Seen</th></tr></thead>
      <tbody>
        {s.members.map((m) => (
          <tr key={memberKey(m)}>
            <td className="mono">{m.host}</td>
            <td className="mono">{m.installDir}</td>
            <ConfCell m={m} />
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
  );
}
