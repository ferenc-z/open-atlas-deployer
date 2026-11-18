// S37 step 3 (pages-rethink §3, §4.1): the "Status" tab, the service page's default. It renders GET /api/services/:id/health
// as it is (the to-do engine in rules.ts decides; nothing is worked out here): the verdict, the to-dos with their next-step
// buttons, the node strip with Start/Restart/Stop, the preventive risks (INFO to-dos of the preventive-risk rule) and the
// newest changes and restarts from the timeline.

import { useCallback, useEffect, useState } from "react";
import * as api from "./api.ts";
import type { ServiceHealth, Todo, TodoAction } from "./api.ts";
import { Timeline } from "./Alerts.tsx";
import { STATE, ago, fmtNumber, when } from "./svc.tsx";
import type { ChangeKind } from "./api.ts";
import { investigateFrom, windowAround } from "./Investigate.tsx";

type Props = { s: api.ServiceStatus; canAct: boolean; plan: (r: { kind: ChangeKind; members: string[] }) => void; open: (tab: string) => void };

const VERDICT = {
  ok: { label: "Normal", tone: "ok", text: "Nothing needs doing." },
  attention: { label: "Needs attention", tone: "warn", text: "" },
  critical: { label: "Critical", tone: "bad", text: "" },
} as const;
const SEV: Record<Todo["severity"], { label: string; tone: string }> = { CRIT: { label: "Critical", tone: "bad" }, WARN: { label: "Warning", tone: "warn" }, INFO: { label: "Notice", tone: "info" } };
// What the Timeline calls a change or a restart (the rest of it stays on Events and alerts).
const CHANGES = new Set(["process-restarted", "node-stopped", "node-started", "version-changed", "config-saved", "config-applied", "config-rolled-back", "change-started", "change-finished", "change-stopped", "change-paused", "change-resumed"]);
const CONTROL = new Set<string>(["start", "stop", "restart"]);

export function ServiceNow({ s, canAct, plan, open }: Props) {
  const [h, setH] = useState<ServiceHealth | undefined>();
  const [error, setError] = useState("");
  const load = useCallback(() => { api.serviceHealth(s.id).then((v) => { setH(v); setError(""); }, (e: Error) => setError(e.message)); }, [s.id]);
  // The service status reloads every 10 s: take the newest health each time it moves.
  useEffect(load, [s.summary.asOf, load]);
  if (!h) return error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>;
  const v = VERDICT[h.verdict];
  const risks = h.todos.filter((t) => t.rule === "preventive-risk");
  const todos = h.todos.filter((t) => t.rule !== "preventive-risk");
  const recent = s.events.filter((e) => CHANGES.has(e.kind)).slice(0, 5);
  return (
    <div className="panel">
      {error && <p className="error">{error}</p>}
      <section className={`card verdict verdict-${h.verdict}`}>
        <span className={`badge ${v.tone}`}>{v.label}</span>{" "}
        <strong>{h.verdict === "ok" ? v.text : `${todos.length} to-do${todos.length === 1 ? "" : "s"}${h.counts.CRIT ? `, ${h.counts.CRIT} critical` : ""}${risks.length ? ` · ${risks.length} preventive risk${risks.length === 1 ? "" : "s"}` : ""}`}</strong>
        <span className="muted small"> · as of {ago(h.asOf)}</span>
      </section>
      <div>
        <h3>To do</h3>
        {!todos.length ? <p className="muted small">Nothing needs a person right now.</p> : <ul className="todos">{todos.map((t) => <TodoRow key={t.id} t={t} canAct={canAct} plan={plan} open={open} />)}</ul>}
      </div>
      <div>
        <h3>{s.kind === "cluster" ? "Nodes" : "Installation"}</h3>
        <table>
          <thead><tr><th>{s.kind === "cluster" ? "Node" : "Host"}</th><th>State</th>{s.kind === "cluster" && <th>Cluster</th>}<th>Heap</th><th>Queued</th><th>Version</th>{canAct && <th></th>}</tr></thead>
          <tbody>{h.members.map((m) => {
            const st = STATE[m.state as keyof typeof STATE];
            return (
              <tr key={m.key}>
                <td className="mono">{m.label}</td>
                <td><span className={`badge ${st?.tone ?? "muted"}`} title={st?.title}>{st?.label ?? m.state}</span></td>
                {s.kind === "cluster" && <td>{m.connection ? <span className={`badge ${m.connection === "CONNECTED" ? "ok" : "bad"}`}>{m.connection.toLowerCase()}</span> : <span className="muted">—</span>}</td>}
                <td className="mono small">{m.heapPct === null ? "—" : `${fmtNumber(m.heapPct)} %`}</td>
                <td className="mono small">{fmtNumber(m.queuedCount, 0)}</td>
                <td className="mono small">{m.version ?? "—"}</td>
                {canAct && <td className="nowrap"><div className="row">
                  {m.state !== "running" && <button onClick={() => plan({ kind: "start", members: [m.key] })}>Start</button>}
                  {m.state !== "stopped" && <button onClick={() => plan({ kind: "restart", members: [m.key] })}>Restart</button>}
                  {m.state !== "stopped" && <button onClick={() => plan({ kind: "stop", members: [m.key] })}>Stop</button>}
                </div></td>}
              </tr>
            );
          })}</tbody>
        </table>
        <p className="muted small">Each button shows a plan first; nothing happens until you confirm it.</p>
      </div>
      {risks.length > 0 && <div>
        <h3>Preventive risks</h3>
        <p className="muted small">Trends, not faults yet: if they continue, the limit is reached within the time shown.</p>
        <ul className="todos">{risks.map((t) => <TodoRow key={t.id} t={t} canAct={canAct} plan={plan} open={open} />)}</ul>
      </div>}
      <div>
        <h3>Recent changes and restarts</h3>
        {recent.length ? <Timeline events={recent} /> : <p className="muted small">None on the timeline yet.</p>}
        <p className="muted small">All of it on Events and alerts and Changes.</p>
      </div>
    </div>
  );
}

function TodoRow({ t, canAct, plan, open }: { t: Todo; canAct: boolean; plan: Props["plan"]; open: Props["open"] }) {
  const sev = SEV[t.severity];
  // The engine's `since` is steady only for what has an alert; the preventive risk and incomplete collection take the sample time.
  const steady = t.rule !== "preventive-risk" && t.rule !== "collection-incomplete";
  return (
    <li className={`card todo todo-${t.severity.toLowerCase()}`}>
      <div className="row wrap">
        <span className={`badge ${sev.tone}`}>{sev.label}</span>
        <strong>{t.rule}</strong>
        {t.memberLabel && <span className="mono small">{t.memberLabel}</span>}
        {steady && <span className="muted small" title={when(t.since)}>since {ago(t.since)}</span>}
      </div>
      <p className="small">{t.cause}</p>
      {t.evidence.length > 0 && <ul className="small">{t.evidence.slice(0, 3).map((e, i) => <li key={i}>{e}</li>)}</ul>}
      {t.actions.length > 0 && <div className="row wrap">{t.actions.map((a, i) => <ActionButton key={i} t={t} a={a} canAct={canAct} plan={plan} open={open} />)}</div>}
    </li>
  );
}

function ActionButton({ t, a, canAct, plan, open }: { t: Todo; a: TodoAction; canAct: boolean; plan: Props["plan"]; open: Props["open"] }) {
  const target = a.target ?? {};
  switch (a.kind) {
    case "open-nifi": return typeof target.url === "string" ? <a className="button" href={target.url} target="_blank" rel="noreferrer">{a.label} ↗</a> : null;
    case "member-control": {
      const action = String(target.action ?? "");
      if (!canAct || !CONTROL.has(action) || typeof target.member !== "string") return null;
      return <button onClick={() => plan({ kind: action as ChangeKind, members: [target.member as string] })} title="Shows a plan first">{a.label}</button>;
    }
    // S37 step 4: the Investigate tab, on this to-do's member and a window from half an hour before it started.
    case "investigate": return <button onClick={() => { investigateFrom({ member: typeof target.member === "string" ? target.member : t.member !== "*" ? t.member : undefined, ...windowAround(t.since), focus: t.rule, label: `To-do ${t.rule}${t.memberLabel ? ` on ${t.memberLabel}` : ""}` }); open("investigate"); }}>{a.label}</button>;
    case "metrics": return <button onClick={() => open("metrics")}>{a.label}</button>;
    case "draft-config": case "config-diff": return <button onClick={() => open("configuration")}>{a.label}</button>;
    default: return null;
  }
}
