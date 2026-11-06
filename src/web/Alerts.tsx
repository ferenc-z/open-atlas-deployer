// Phase 2 step 3 (§9.2, §15.3): alerts and the event timeline. A service's Events and alerts tab (open alerts, the
// thresholds with what each means, the timeline, what was resolved), the Overview's problems, the global Alerts page in
// the sidebar and the home page's service health card. Alerts are shown here only, never pushed (S13).

import { useCallback, useEffect, useState } from "react";
import * as api from "./api.ts";
import type { AlertView, GlobalAlert, RegisteredService, ServiceStatus, Thresholds, ThresholdsView, TimelineEvent } from "./api.ts";
import { ask } from "./Confirm.tsx";
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
          <td className="small">{a.text}</td>
          <td className="muted small" title={`Opened ${when(a.openedAt)}${a.resolvedAt ? `, resolved ${when(a.resolvedAt)}` : ""}`}>{resolved && a.resolvedAt ? ago(a.resolvedAt) : ago(a.openedAt)}</td>
        </tr>
      ))}</tbody>
    </table>
  );
}

const KIND: Record<string, { label: string; tone: string }> = {
  "alert-opened": { label: "Alert", tone: "bad" }, "alert-changed": { label: "Alert level", tone: "warn" }, "alert-resolved": { label: "Resolved", tone: "ok" },
  "node-disconnected": { label: "Disconnected", tone: "bad" }, "node-reconnected": { label: "Reconnected", tone: "ok" },
  "process-restarted": { label: "Restarted", tone: "info" }, "version-changed": { label: "Version", tone: "warn" },
  "taken-over": { label: "Taken over", tone: "info" }, "config-imported": { label: "Configuration", tone: "info" }, thresholds: { label: "Thresholds", tone: "muted" },
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

/** The Overview's problem area: the open alerts (none: says so). */
export function OpenAlerts({ s }: { s: ServiceStatus }) {
  const [alerts, setAlerts] = useState<AlertView[] | undefined>();
  useEffect(() => { api.serviceAlerts(s.id).then((r) => setAlerts(r.alerts.filter((a) => a.state === "open")), () => setAlerts([])); }, [s.id, s.summary.asOf, s.summary.alerts.open]);
  if (!alerts) return null;
  return (
    <div>
      <h3>Problems</h3>
      {alerts.length ? <AlertTable alerts={alerts} /> : <p className="muted small"><span className="badge ok">No open alerts</span> The health rules run as samples come in and once a minute.</p>}
    </div>
  );
}

// The Events and alerts tab.
export function EventsAndAlerts({ s }: { s: ServiceStatus }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.serviceAlerts>> | undefined>();
  const [events, setEvents] = useState<TimelineEvent[] | undefined>();
  const [error, setError] = useState("");
  const load = useCallback(() => {
    api.serviceAlerts(s.id).then((d) => { setData(d); setError(""); }, (e: Error) => setError(e.message));
    api.serviceEvents(s.id).then((r) => setEvents(r.events), () => setEvents([]));
  }, [s.id]);
  useEffect(() => { load(); const t = setInterval(load, 15_000); return () => clearInterval(t); }, [load]);
  if (!data) return error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>;
  const open = data.alerts.filter((a) => a.state === "open");
  const resolved = data.alerts.filter((a) => a.state === "resolved").slice(0, 50);
  return (
    <div className="panel">
      <div>
        <h3>Open alerts</h3>
        <p className="muted small">At most one per rule and node (or for the whole service); it closes by itself when the rule no longer holds. A rule that cannot tell (no fresh sample) leaves its alert as it is. Not pushed anywhere (S13).</p>
        {open.length ? <AlertTable alerts={open} /> : <p className="muted small"><span className="badge ok">None</span></p>}
      </div>
      <div>
        <h3>Timeline</h3>
        {events ? <Timeline events={events} /> : <p className="muted">Loading…</p>}
      </div>
      {resolved.length > 0 && <details>
        <summary><strong>Resolved alerts</strong> <span className="muted small">{resolved.length} most recent</span></summary>
        <AlertTable alerts={resolved} resolved />
      </details>}
      <ThresholdForm id={s.id} view={data.thresholds} rules={data.rules} canEdit={data.canEdit} onSaved={load} />
    </div>
  );
}

function ThresholdForm({ id, view, rules, canEdit, onSaved }: { id: string; view: ThresholdsView; rules: Awaited<ReturnType<typeof api.serviceAlerts>>["rules"]; canEdit: boolean; onSaved: () => void }) {
  const keys = Object.keys(view.info) as (keyof Thresholds)[];
  const initial = () => Object.fromEntries(keys.map((k) => [k, String(view.effective[k])])) as Record<keyof Thresholds, string>;
  const [values, setValues] = useState(initial);
  const [error, setError] = useState<{ message: string; details: string[] } | undefined>();
  useEffect(() => setValues(initial()), [view]); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = keys.filter((k) => values[k] !== String(view.effective[k]));
  const save = async (asked: Partial<Record<keyof Thresholds, number | null>>, question: string) => {
    if (!(await ask(question, { confirm: "Save the thresholds" }))) return;
    setError(undefined);
    api.putThresholds(id, asked).then(onSaved, (e: api.ApiError) => setError({ message: e.message, details: e.details ?? [] }));
  };
  const submit = () => {
    const asked = Object.fromEntries(keys.map((k) => [k, values[k].trim() === "" ? null : Number(values[k])])) as Partial<Record<keyof Thresholds, number | null>>;
    save(asked, `Change ${changed.map((k) => `${view.info[k].label} to ${values[k] || `the default (${view.defaults[k]})`}`).join(", ")}? The alerts of ${id} follow at once.`);
  };
  const reset = () => save({}, `Put every threshold of ${id} back to the profile's defaults?`);
  const byRule = [...new Set(keys.map((k) => view.info[k].rule))];
  return (
    <div>
      <h3>Thresholds</h3>
      <p className="muted small">The profile gives the defaults; an admin can change them for this service only (kept in its thresholds column, audited, and on the timeline). Rules without a number here (executor lost aside: process down, node disconnected, no coordinator, versions differ, no monitor certificate, certificate unreadable, no samples) open as soon as a fresh sample shows them. Leave a field empty for the default.</p>
      <table className="edit thresholds">
        <thead><tr><th>Rule</th><th>Threshold</th><th>Value</th><th>Default</th></tr></thead>
        <tbody>{byRule.map((rule) => keys.filter((k) => view.info[k].rule === rule).map((k, i, all) => {
          const info = view.info[k];
          const overridden = k in view.overrides;
          return (
            <tr key={k}>
              {i === 0 && <td rowSpan={all.length}><strong>{rules[rule]?.label ?? rule}</strong> {rules[rule]?.levels.map((l) => <LevelBadge key={l} level={l} />)}<br /><span className="small muted">{rules[rule]?.description}</span></td>}
              <td><span>{info.label}</span> <span className="mono small muted">{k}</span><br /><span className="small muted">{info.description} ({info.min}–{info.max} {info.unit})</span></td>
              <td className="nowrap">
                {canEdit
                  ? <input className="mono" type="number" min={info.min} max={info.max} step="1" value={values[k]} placeholder={String(view.defaults[k])} onChange={(e) => setValues({ ...values, [k]: e.target.value })} style={{ width: 90 }} aria-label={info.label} />
                  : <span className="mono">{view.effective[k]}</span>} <span className="muted small">{info.unit}</span>
                {overridden && <span className="badge info" title="Set for this service">set</span>}
              </td>
              <td className="mono small muted">{view.defaults[k]}</td>
            </tr>
          );
        }))}</tbody>
      </table>
      {error && <div className="error">{error.message}{error.details.length > 0 && <ul>{error.details.map((d) => <li key={d}>{d}</li>)}</ul>}</div>}
      {canEdit
        ? <div className="row">
            <button className="primary" disabled={!changed.length} onClick={submit}>Save {changed.length ? `${changed.length} change${changed.length > 1 ? "s" : ""}` : ""}</button>
            {changed.length > 0 && <button onClick={() => setValues(initial())}>Undo</button>}
            {Object.keys(view.overrides).length > 0 && <button className="link" onClick={reset}>Back to the defaults</button>}
          </div>
        : <p className="muted small">Only Workbench admins change thresholds.</p>}
    </div>
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
      <p className="muted page-note">The managed services' health rules (§9.2), checked in this Deployer as samples come in and once a minute. Shown here and on each service's page only; nothing is pushed. Thresholds are on each service's Events and alerts tab.</p>
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
  return <span className={`badge ${a.CRIT ? "bad" : "warn"}`} title={`${a.CRIT} critical, ${a.WARN} warning (Events and alerts)`}>{a.open} alert{a.open > 1 ? "s" : ""}</span>;
}
