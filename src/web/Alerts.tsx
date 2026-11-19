// Phase 2 step 3 (§9.2, §15.3): alerts and the event timeline. A service's Events and alerts tab (open alerts, the
// thresholds with what each means, the timeline, what was resolved), the Overview's problems, the global Alerts page in
// the sidebar and the home page's service health card. Alerts are shown here only, never pushed (S13).

import { useCallback, useEffect, useState } from "react";
import * as api from "./api.ts";
import type { AlertAnalysis, AlertView, GlobalAlert, RegisteredService, TimelineEvent } from "./api.ts";
import { CaseView } from "./CaseBox.tsx";
import { ago, when } from "./svc.tsx";

export const LEVEL: Record<string, { tone: string; title: string }> = {
  CRIT: { tone: "bad", title: "Critical: something is down or about to break" },
  WARN: { tone: "warn", title: "Warning: worth a look before it becomes critical" },
};

export function LevelBadge({ level }: { level: string }) {
  const l = LEVEL[level] ?? { tone: "muted", title: level };
  return <span className={`badge ${l.tone}`} title={l.title}>{level}</span>;
}

/** The open (or resolved) alerts as a table; service: also say whose they are (the global page). */
export function AlertTable({ alerts, onOpen, resolved = false }: { alerts: (AlertView | GlobalAlert)[]; onOpen?: (service: string) => void; resolved?: boolean }) {
  return (
    <table>
      <thead><tr><th>Level</th><th>Alert</th>{onOpen && <th>Service</th>}<th>Where</th><th>What</th><th>{resolved ? "Resolved" : "Since"}</th></tr></thead>
      <tbody>{alerts.map((a) => (
        <tr key={a.id}>
          <td><LevelBadge level={a.level} /></td>
          <td>{a.label}</td>
          {onOpen && <td><button className="link mono" onClick={() => onOpen(a.service)}>{a.service}</button>{"environment" in a && <span className="muted small"> {a.environment.toUpperCase()}</span>}</td>}
          <td className="mono small">{a.memberLabel ?? <span className="muted">whole service</span>}</td>
          <td className="small">{a.text}{a.analysis && <AlertCase service={a.service} analysis={a.analysis} />}</td>
          <td className="muted small" title={`Opened ${when(a.openedAt)}${a.resolvedAt ? `, resolved ${when(a.resolvedAt)}` : ""}`}>{resolved && a.resolvedAt ? ago(a.resolvedAt) : ago(a.openedAt)}</td>
        </tr>
      ))}</tbody>
    </table>
  );
}

/** S37 step 9 (S9): a CRIT alert's own analysis, written back to it; opens to the whole case (follow-up, outcome). */
function AlertCase({ service, analysis }: { service: string; analysis: AlertAnalysis }) {
  return (
    <details className="alert-case">
      <summary><span className="badge info">AI</span> {analysis.state === "running" ? <span className="muted">analysing…</span> : analysis.cause ?? <span className="muted">no answer</span>}</summary>
      <CaseView service={service} id={analysis.case} />
    </details>
  );
}

const KIND: Record<string, { label: string; tone: string }> = {
  "alert-opened": { label: "Alert", tone: "bad" }, "alert-changed": { label: "Alert level", tone: "warn" }, "alert-resolved": { label: "Resolved", tone: "ok" },
  "node-disconnected": { label: "Disconnected", tone: "bad" }, "node-reconnected": { label: "Reconnected", tone: "ok" },
  "process-restarted": { label: "Restarted", tone: "info" }, "version-changed": { label: "Version", tone: "warn" },
  "drift-detected": { label: "Drift", tone: "warn" }, "drift-resolved": { label: "Drift gone", tone: "ok" },
  "taken-over": { label: "Taken over", tone: "info" }, removed: { label: "Removed", tone: "warn" }, "config-imported": { label: "Configuration", tone: "info" }, thresholds: { label: "Thresholds", tone: "muted" },
  "config-saved": { label: "Revision saved", tone: "info" }, "config-applied": { label: "Applied", tone: "ok" }, "config-rolled-back": { label: "Rolled back", tone: "warn" },
  "node-stopped": { label: "Stopped", tone: "warn" }, "node-started": { label: "Started", tone: "info" },
  "change-started": { label: "Change", tone: "info" }, "change-finished": { label: "Change ended", tone: "info" }, "change-stopped": { label: "Change stopped", tone: "bad" },
  "change-paused": { label: "Change paused", tone: "warn" }, "change-resumed": { label: "Change continued", tone: "info" },
};

/** The timeline, newest first: alerts opening and closing next to restarts, connections, configuration and takeover. */
export function Timeline({ events }: { events: TimelineEvent[] }) {
  if (!events.length) return <p className="muted small">Nothing on the timeline yet.</p>;
  return (
    <ol className="timeline">{events.map((e, i) => {
      const k = KIND[e.kind] ?? { label: e.kind, tone: "muted" };
      const tone = e.kind === "alert-opened" || e.kind === "alert-changed" ? (LEVEL[e.level ?? ""]?.tone ?? k.tone) : k.tone;
      return (
        <li key={i} className={`tl-${tone}`}>
          <span className="muted small" title={when(e.at)}>{when(e.at)}</span> <span className={`badge ${tone}`}>{k.label}</span> <span>{e.text}</span>{e.by && <span className="muted small"> by {e.by}</span>}
        </li>
      );
    })}</ol>
  );
}

// The sidebar's Alerts: every service's open alerts, and what closed in the last day.
export function AlertsPage({ onOpen }: { onOpen: (service: string) => void }) {
  const [data, setData] = useState<{ alerts: GlobalAlert[]; open: number } | undefined>();
  const [error, setError] = useState("");
  const load = useCallback(() => { api.alerts("all").then((d) => { setData(d); setError(""); }, (e: Error) => setError(e.message)); }, []);
  useEffect(() => { load(); const t = setInterval(load, 15_000); return () => clearInterval(t); }, [load]);
  if (!data) return error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>;
  const open = data.alerts.filter((a) => a.state === "open");
  const closed = data.alerts.filter((a) => a.state === "resolved");
  return (
    <>
      <div className="toolbar"><h1>Alerts</h1><span className="muted">{open.length} open · {open.filter((a) => a.level === "CRIT").length} critical</span><span className="spacer" /><button onClick={load}>Refresh</button></div>
      <p className="muted page-note">The managed services' health rules (§9.2), checked in this Deployer as samples come in and once a minute. Shown here and on each service's page only; nothing is pushed.</p>
      {error && <p className="error">{error}</p>}
      <section className="card">
        <h2>Open</h2>
        {open.length ? <AlertTable alerts={open} onOpen={onOpen} /> : <p className="muted"><span className="badge ok">No open alerts</span></p>}
      </section>
      {closed.length > 0 && <section className="card">
        <h2>Resolved in the last day</h2>
        <AlertTable alerts={closed} onOpen={onOpen} resolved />
      </section>}
    </>
  );
}

// The home page's service health card: how many run, the open alerts, the worst first.
export function ServiceHealthCard({ onServices, onAlerts }: { onServices: () => void; onAlerts: () => void }) {
  const [list, setList] = useState<RegisteredService[] | undefined>();
  const [open, setOpen] = useState<GlobalAlert[]>([]);
  const load = useCallback(() => {
    api.services().then((l) => setList([...l.clusters, ...l.standalones]), () => setList(undefined));
    api.alerts("open").then((a) => setOpen(a.alerts), () => setOpen([]));
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);
  if (!list?.length) return null;
  const members = list.reduce((n, s) => n + (s.status?.members ?? 0), 0);
  const running = list.reduce((n, s) => n + (s.status?.running ?? 0), 0);
  const crit = open.filter((a) => a.level === "CRIT").length;
  const tone = crit ? "bad" : open.length ? "warn" : running < members ? "warn" : "ok";
  const worst = [...open].sort((a, b) => (a.level === b.level ? (a.openedAt < b.openedAt ? 1 : -1) : a.level === "CRIT" ? -1 : 1)).slice(0, 5);
  return (
    <section className={`card service-health ${tone}`}>
      <div className="toolbar">
        <h2>Services</h2>
        <span className={`badge ${tone}`}>{crit ? `${crit} critical` : open.length ? `${open.length} warning${open.length > 1 ? "s" : ""}` : "Healthy"}</span>
        <span className="muted small">{list.length} service{list.length > 1 ? "s" : ""} · {running}/{members} up · {open.length} open alert{open.length === 1 ? "" : "s"}</span>
        <span className="spacer" />
        <button className="link" onClick={onServices}>Services</button>
        <button className="link" onClick={onAlerts}>All alerts</button>
      </div>
      {worst.length > 0 && <ul className="findings">{worst.map((a) => (
        <li key={a.id}><LevelBadge level={a.level} /> <span className="mono small">{a.service}</span> {a.label}{a.memberLabel ? <span className="muted small"> · {a.memberLabel}</span> : null} <span className="muted small">{ago(a.openedAt)}</span></li>
      ))}</ul>}
    </section>
  );
}

/** The cards' and table's alert count. */
export function AlertBadge({ s }: { s: { alerts?: { open: number; CRIT: number; WARN: number } } | null }) {
  const a = s?.alerts;
  if (!a?.open) return null;
  return <span className={`badge ${a.CRIT ? "bad" : "warn"}`} title={`${a.CRIT} critical, ${a.WARN} warning (Toolbox, Alerts and timeline)`}>{a.open} alert{a.open > 1 ? "s" : ""}</span>;
}
