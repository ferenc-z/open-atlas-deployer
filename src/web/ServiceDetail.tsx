// A registered service's page (S23), the same frame for a standalone instance and a cluster: a summary line that
// stays the same in every phase (name, up, findings, soonest certificate; version, environment, ZooKeeper,
// configuration revision; the NiFi UI on the right), then tabs. Phase 2 step 2 adds Metrics and live states; later
// steps add theirs to TABS (Logs, Events and alerts, FlowFile trace, Changes) and a tab without data yet is not shown.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import * as api from "./api.ts";
import type { Field, MemberStatus, MetricsView, Range, ServiceBulletin, ServiceConfigView, ServiceStatus } from "./api.ts";
import { LineChart, type Series } from "./Charts.tsx";
import { ServiceConfig } from "./ServiceConfig.tsx";
import { ago, CertBadge, certTone, ConfCell, daysLeft, daysText, fmtBytes, fmtNumber, memberKey, serviceName, SEVERITY, STATE, StatusNotes, UpBadge, webPort, when } from "./svc.tsx";

type Loaded = { s: ServiceStatus; cfg: ServiceConfigView | null | undefined };
type Tab = { id: string; label: string; shown: (l: Loaded) => boolean; render: (l: Loaded) => ReactNode };

const TABS: Tab[] = [
  { id: "overview", label: "Overview", shown: () => true, render: (l) => <Overview {...l} /> },
  { id: "metrics", label: "Metrics", shown: (l) => l.s.members.some((m) => m.live), render: (l) => <Metrics s={l.s} /> },
  { id: "nodes", label: "Nodes", shown: () => true, render: (l) => <Nodes s={l.s} /> },
  { id: "configuration", label: "Configuration", shown: () => true, render: (l) => <ServiceConfig cfg={l.cfg} status={l.s} /> },
];

/** How a member is named on the charts: a node by address and port, a standalone by host. */
export const memberLabel = (s: ServiceStatus, m: MemberStatus) => (s.kind === "cluster" ? `${m.nodeAddress ?? m.host}:${webPort(m.ports) ?? "?"}` : m.host);

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
            <CertBadge s={s.summary} />
            {cluster && s.summary.differences > 0 && <span className="badge warn" title="Configuration differences between the nodes found at takeover">{s.summary.differences} node difference{s.summary.differences > 1 ? "s" : ""}</span>}
            {f.error > 0 && <span className="badge bad" title="Takeover findings (alerts come in phase 2 step 3)">{f.error} error{f.error > 1 ? "s" : ""}</span>}
            {f.warning > 0 && <span className="badge warn" title="Takeover findings (alerts come in phase 2 step 3)">{f.warning} warning{f.warning > 1 ? "s" : ""}</span>}
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

const pctText = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${fmtNumber(v)} %`);
const live = (m: MemberStatus, f: Field) => m.live?.point?.[f] ?? null;
const sum = (s: ServiceStatus, f: Field) => { const v = s.members.map((m) => live(m, f)).filter((x): x is number => x !== null); return v.length ? v.reduce((a, b) => a + b, 0) : null; };
const highest = (s: ServiceStatus, f: Field) => { const v = s.members.map((m) => live(m, f)).filter((x): x is number => x !== null); return v.length ? Math.max(...v) : null; };

function StateBadge({ m }: { m: MemberStatus }) {
  const st = STATE[m.state];
  const why = m.source === "discovery" ? " (as of the host's newest discovery: no sample yet)" : m.source === "executor" ? ` (${m.executor.reason ?? "executor offline"})` : "";
  return <span className={`badge ${st.tone}`} title={`${st.title}${why}`}>{st.label}</span>;
}

// Overview: key numbers, the nodes, certificates, what the takeover found, the newest bulletins, the timeline.
function Overview({ s }: Loaded) {
  const cluster = s.kind === "cluster";
  const [bulletins, setBulletins] = useState<ServiceBulletin[] | undefined>();
  useEffect(() => { api.serviceBulletins(s.id, 10).then((r) => setBulletins(r.bulletins), () => setBulletins([])); }, [s.id, s.summary.asOf]);
  const sampled = s.members.some((m) => m.live?.point);
  const connected = s.members.filter((m) => m.live?.connection === "CONNECTED").length;
  return (
    <div className="panel">
      <div className="metrics">
        <div className="metric"><span className="muted small">{cluster ? "Nodes" : "Installations"}</span><strong>{s.summary.running}/{s.summary.members} up</strong><span className="small muted">{cluster ? `${connected} connected · ` : ""}{s.summary.executorsOnline} executor{s.summary.executorsOnline === 1 ? "" : "s"} online</span></div>
        {sampled && <>
          <div className="metric" title="The fullest node's heap"><span className="muted small">Heap used</span><strong>{pctText(highest(s, "heapPct"))}</strong><span className="small muted">highest node</span></div>
          <div className="metric"><span className="muted small">Queued</span><strong>{fmtNumber(sum(s, "queuedCount"), 0)}</strong><span className="small muted">{fmtBytes(sum(s, "queuedBytes"))}</span></div>
          <div className="metric" title="Connections at their back pressure threshold, flow-wide"><span className="muted small">Back pressure</span><strong>{fmtNumber(highest(s, "bpFull"), 0)}</strong><span className="small muted">fullest {pctText(highest(s, "bpMaxPct"))}</span></div>
          <div className="metric"><span className="muted small">Threads</span><strong>{fmtNumber(sum(s, "threads"), 0)}</strong><span className="small muted">{fmtNumber(sum(s, "activeThreads"), 0)} active</span></div>
          <div className="metric" title="The fullest repository disk of any node"><span className="muted small">Repository disk</span><strong>{pctText(Math.max(highest(s, "repoContentPct") ?? 0, highest(s, "repoFlowfilePct") ?? 0, highest(s, "repoProvenancePct") ?? 0))}</strong><span className="small muted">fullest</span></div>
        </>}
      </div>
      <div>
        <h3>{cluster ? "Nodes" : "Installation"}</h3>
        <table>
          <thead><tr><th>{cluster ? "Node" : "Host"}</th><th>Host and port</th><th>State</th>{cluster && <th>Cluster</th>}<th>Heap</th><th>Queued</th><th>As of</th></tr></thead>
          <tbody>{s.members.map((m) => (
            <tr key={memberKey(m)}>
              <td className="mono">{cluster ? m.nodeAddress ?? m.host : m.host}</td>
              <td className="mono">{m.host}{webPort(m.ports) ? `:${webPort(m.ports)}` : ""}</td>
              <td><StateBadge m={m} />{m.live?.nifi && m.live.nifi !== "ok" && <span className="muted small" title="The collector's verdict on the REST API"> REST {m.live.nifi}</span>}</td>
              {cluster && <td>{m.live?.connection ? <span className={`badge ${m.live.connection === "CONNECTED" ? "ok" : "bad"}`} title={`In the coordinator's view${m.live.roles.length ? `; ${m.live.roles.join(", ")}` : ""}`}>{m.live.connection.toLowerCase()}</span> : <span className="muted">—</span>}{m.live?.roles.includes("Cluster Coordinator") && <span className="muted small"> coordinator</span>}</td>}
              <td className="mono small">{pctText(live(m, "heapPct"))}</td>
              <td className="mono small">{fmtNumber(live(m, "queuedCount"), 0)}</td>
              <td className="muted small" title={m.asOf ? when(m.asOf) : undefined}>{m.asOf ? <>{ago(m.asOf)}{m.live?.pid ? ` · pid ${m.live.pid}` : m.seen?.pid ? ` · pid ${m.seen.pid}` : ""}</> : "—"}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <Certificates s={s} />
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
      {s.events.length > 0 && <div>
        <h3>Timeline</h3>
        <ol className="timeline">{s.events.map((e, i) => (
          <li key={i}><span className="muted small">{when(e.at)}</span> <span>{e.text}</span> <span className="muted small">by {e.by}</span></li>
        ))}</ol>
      </div>}
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
      <p className="muted small">Read by each host's service executor from nifi.properties' keystore and truststore (and its own monitor certificate) about once an hour; only the newest reading is kept. 30 days or less is a warning, 7 days or less critical.</p>
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
                <td>{days !== null ? <span className={`badge ${certTone(days)}`}>{daysText(days)}</span> : "—"}</td>
              </>}
              <td className="muted small" title={when(c.readAt)}>{ago(c.readAt)}</td>
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}

// Metrics (§15.3): one chart per number, a line per node, over 1 hour / 6 hours / 2 days (raw samples) or 30 days (5-minute rollups).
const RANGES: { id: Range; label: string }[] = [{ id: "1h", label: "1 hour" }, { id: "6h", label: "6 hours" }, { id: "2d", label: "2 days" }, { id: "30d", label: "30 days" }];
const CHARTS: { group: string; charts: { field: Field; title: string; max?: number; note?: string }[] }[] = [
  { group: "JVM", charts: [{ field: "heapPct", title: "Heap used", max: 100 }, { field: "heapUsed", title: "Heap used (bytes)" }, { field: "gcMsPerMin", title: "GC time" }, { field: "threads", title: "JVM threads" }] },
  { group: "Flow", charts: [{ field: "queuedCount", title: "Queued flowfiles" }, { field: "queuedBytes", title: "Queued bytes" }, { field: "bpFull", title: "Connections at back pressure", note: "No back pressure data (an executor before step 2 does not collect it)" }, { field: "activeThreads", title: "Active threads" }] },
  { group: "Repositories", charts: [{ field: "repoContentPct", title: "Content repository disk", max: 100 }, { field: "repoFlowfilePct", title: "FlowFile repository disk", max: 100 }, { field: "repoProvenancePct", title: "Provenance repository disk", max: 100 }] },
  { group: "Host", charts: [{ field: "cpuPct", title: "Process CPU (100 % = one core)" }, { field: "rss", title: "Process RSS" }, { field: "load1", title: "Host load (1 min)" }, { field: "memPct", title: "Host memory used", max: 100 }, { field: "diskPct", title: "Fullest disk", max: 100 }] },
];

function Metrics({ s }: { s: ServiceStatus }) {
  const [range, setRange] = useState<Range>("1h");
  const [view, setView] = useState<MetricsView | undefined>();
  const [error, setError] = useState("");
  const load = useCallback(() => { api.serviceMetrics(s.id, range).then((v) => { setView(v); setError(""); }, (e: Error) => setError(e.message)); }, [s.id, range]);
  useEffect(() => { setView(undefined); load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);
  const from = view ? Date.parse(view.from) : 0, to = view ? Date.parse(view.to) : 0;
  const series = (f: Field): Series[] => !view ? [] : s.members.map((m) => {
    const got = view.members.find((x) => x.member === m.key);
    return { name: memberLabel(s, m), at: got ? got.at.map((a) => Date.parse(a)) : [], values: got?.values[f] ?? [] };
  });
  return (
    <div className="panel">
      <div className="range-bar">
        <div className="subtabs inline" role="tablist" aria-label="Time range">
          {RANGES.map((r) => <button key={r.id} role="tab" aria-selected={range === r.id} className={range === r.id ? "active" : ""} onClick={() => setRange(r.id)}>{r.label}</button>)}
        </div>
        {view && <span className="muted small">{view.source === "samples" ? `From the raw samples (kept 2 days), averaged over ${view.step >= 60 ? `${Math.round(view.step / 60)} min` : `${view.step} s`}` : `From the 5-minute rollups (kept 30 days), averaged over ${Math.round(view.step / 3600)} h`}. Sampled every {s.summary.period} s.</span>}
      </div>
      {error && <p className="error">{error}</p>}
      {!view && !error && <p className="muted">Loading…</p>}
      {view && CHARTS.map((g) => (
        <section key={g.group} className="chart-section">
          <h3>{g.group}</h3>
          <div className="charts">{g.charts.map((c) => (
            <LineChart key={c.field} title={c.title} unit={view.fields[c.field].unit} series={series(c.field)} from={from} to={to} {...(c.max ? { max: c.max } : {})} {...(c.note ? { note: c.note } : {})} />
          ))}</div>
        </section>
      ))}
      {view && s.kind === "cluster" && <p className="muted small">Back pressure is flow-wide (the root group's status), so every node shows the same. A node's queue and active threads are its share in the coordinator's view.</p>}
    </div>
  );
}

function Nodes({ s }: { s: ServiceStatus }) {
  const cluster = s.kind === "cluster";
  const soonest = (m: MemberStatus) => s.certs.filter((c) => c.member === m.key && c.notAfter).sort((a, b) => (a.notAfter! < b.notAfter! ? -1 : 1))[0];
  const unread = (m: MemberStatus) => s.certs.filter((c) => c.member === m.key && c.error).length;
  return (
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
              <td>{days !== null && c ? <span className={`badge ${certTone(days)}`} title={`${c.subject ?? "?"} (${c.store}), ${when(c.notAfter)}`}>{daysText(days)}</span> : <span className="muted">—</span>}{bad > 0 && <span className="badge warn" title={s.certs.filter((x) => x.member === m.key && x.error).map((x) => `${x.store}: ${x.error}`).join("\n")}>{bad} unreadable</span>}</td>
              <td className="muted small" title={m.asOf ? when(m.asOf) : undefined}>{m.asOf ? <>{ago(m.asOf)}{version && <> · <span className={version === s.version ? "" : "error"}>{version}</span></>}{m.live?.pid ? ` · pid ${m.live.pid}` : m.seen?.pid ? ` · pid ${m.seen.pid}` : ""}</> : "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
