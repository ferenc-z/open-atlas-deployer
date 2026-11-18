// S37 step 4 (pages-rethink §3, §4.3): the "Investigate" tab. A starting point (a to-do, an alert, or a node and a
// window chosen by hand) runs GET /api/services/:id/investigate; the evidence comes back as cards worked out by the
// Deployer (no AI: step 9 adds "Let the AI analyse"). Each item opens to its raw content (log lines, bulletin messages,
// events, the curve against the same hours a day before) and, for a component, links into NiFi with it selected.

import { useCallback, useEffect, useState } from "react";
import * as api from "./api.ts";
import type { AlertView, EvidenceCard, EvidenceItem, Investigation, ServiceHealth } from "./api.ts";
import { LineChart } from "./Charts.tsx";
import { ago, when } from "./svc.tsx";

/** Where an investigation starts: the Status tab's to-dos set it before opening this tab. */
export interface InvestigateStart { member?: string | undefined; from: string; to: string; focus?: string | undefined; label?: string }
let pending: InvestigateStart | null = null;
/** Opens the next Investigate tab on this starting point (the Status tab's "Investigate" button). */
export function investigateFrom(start: InvestigateStart) { pending = start; }

const HOUR = 3_600_000;
const BEFORE = 30 * 60_000;
const SPANS = [1, 6, 24];
const WEIGHT: Record<EvidenceCard["weight"], { label: string; tone: string }> = { high: { label: "Look here", tone: "bad" }, medium: { label: "Some", tone: "warn" }, low: { label: "Little", tone: "info" }, none: { label: "Nothing", tone: "muted" } };

/** A window around something that started at `since` and may have ended: from half an hour before (at most a day back), to its end or now. */
export function windowAround(since: string, until?: string | null, now = Date.now()): { from: string; to: string } {
  const to = until ? Math.min(now, Date.parse(until) + 10 * 60_000) : now;
  const from = Math.max(to - 24 * HOUR + 60_000, Math.min(Date.parse(since) - BEFORE, to - HOUR));
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}
const toInput = (iso: string) => { const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };
const fromInput = (v: string) => (v ? new Date(v).toISOString() : "");

export function Investigate({ s }: { s: api.ServiceStatus }) {
  const [start] = useState<InvestigateStart | null>(() => { const p = pending; pending = null; return p; });
  const now = Date.now();
  const [member, setMember] = useState(start?.member ?? "");
  const [from, setFrom] = useState(start?.from ?? new Date(now - HOUR).toISOString());
  const [to, setTo] = useState(start?.to ?? new Date(now).toISOString());
  const [focus, setFocus] = useState(start?.focus ?? "");
  const [label, setLabel] = useState(start?.label ?? "");
  const [result, setResult] = useState<Investigation | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [health, setHealth] = useState<ServiceHealth | undefined>();
  const [alerts, setAlerts] = useState<AlertView[]>([]);

  const run = useCallback((q: InvestigateStart) => {
    setBusy(true); setError("");
    api.investigateService(s.id, q).then((r) => { setResult(r); setBusy(false); }, (e: Error) => { setError(e.message); setBusy(false); });
  }, [s.id]);
  useEffect(() => { if (start) run(start); }, [start, run]);
  useEffect(() => {
    api.serviceHealth(s.id).then(setHealth, () => undefined);
    const since = Date.now() - 24 * HOUR;
    api.serviceAlerts(s.id).then((r) => setAlerts(r.alerts.filter((a) => a.state === "open" || Date.parse(a.resolvedAt ?? a.openedAt) >= since).slice(0, 8)), () => undefined);
  }, [s.id]);

  const pick = (q: InvestigateStart) => { setMember(q.member ?? ""); setFrom(q.from); setTo(q.to); setFocus(q.focus ?? ""); setLabel(q.label ?? ""); run(q); };
  const todos = (health?.todos ?? []).filter((t) => t.rule !== "preventive-risk");
  const memberOf = (m: string) => (m && m !== "*" ? m : undefined);

  return (
    <div className="panel">
      <section className="card">
        <h3>Start from</h3>
        <div className="row wrap">
          {todos.map((t) => (
            <button key={t.id} title={t.evidence.join("\n")} onClick={() => pick({ member: memberOf(t.member), ...windowAround(t.since), focus: t.rule, label: `To-do ${t.rule}${t.memberLabel ? ` on ${t.memberLabel}` : ""}` })}>
              To-do: {t.rule}{t.memberLabel ? ` · ${t.memberLabel}` : ""}
            </button>
          ))}
          {alerts.map((a) => (
            <button key={a.id} title={a.text} onClick={() => pick({ member: memberOf(a.member), ...windowAround(a.openedAt, a.resolvedAt), focus: a.rule, label: `Alert ${a.level} ${a.label}${a.memberLabel ? ` on ${a.memberLabel}` : ""}` })}>
              Alert {a.state === "open" ? "" : "(resolved) "}{a.level} {a.label}{a.memberLabel ? ` · ${a.memberLabel}` : ""} · {ago(a.openedAt)}
            </button>
          ))}
          {!todos.length && !alerts.length && <span className="muted small">No to-do and no alert of the last 24 hours: choose a node and a window.</span>}
        </div>
        <div className="row wrap">
          <label>{s.kind === "cluster" ? "Node" : "Member"}{" "}
            <select value={member} onChange={(e) => setMember(e.target.value)}>
              <option value="">{s.kind === "cluster" ? "All nodes" : "The installation"}</option>
              {s.members.map((m) => <option key={m.key} value={m.key}>{s.kind === "cluster" ? `${m.nodeAddress ?? m.host}:${m.ports.https ?? m.ports.http ?? "?"}` : m.host}</option>)}
            </select>
          </label>
          <label>From <input type="datetime-local" value={toInput(from)} onChange={(e) => setFrom(fromInput(e.target.value))} /></label>
          <label>To <input type="datetime-local" value={toInput(to)} onChange={(e) => setTo(fromInput(e.target.value))} /></label>
          {SPANS.map((h) => <button key={h} onClick={() => { const t = Date.now(); setTo(new Date(t).toISOString()); setFrom(new Date(t - h * HOUR).toISOString()); }}>Last {h} h</button>)}
          <button className="primary" disabled={busy || !from || !to} onClick={() => { setLabel(""); run({ member: member || undefined, from, to, focus: focus || undefined }); }}>{busy ? "Investigating…" : "Investigate"}</button>
        </div>
        <p className="muted small">The Deployer gathers the evidence itself from what it keeps (no AI): at most 24 hours at a time; metrics and logs are compared with the same hours a day before, changes from 24 hours before the window.</p>
      </section>
      {error && <p className="error">{error}</p>}
      {result && <Result r={result} label={label} />}
    </div>
  );
}

function Result({ r, label }: { r: Investigation; label: string }) {
  return (
    <div>
      <p className="small">
        {label && <><strong>{label}</strong> · </>}
        {r.memberLabel ? <span className="mono">{r.memberLabel}</span> : "All members"} · {when(r.from)} – {when(r.to)}
        <span className="muted"> · compared with {when(r.baseline.from)} – {when(r.baseline.to)}; changes from {when(r.changesFrom)}</span>
      </p>
      {r.notes.length > 0 && <ul className="small muted">{r.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
      {r.cards.map((c) => <Card key={c.kind} c={c} r={r} />)}
    </div>
  );
}

function Card({ c, r }: { c: EvidenceCard; r: Investigation }) {
  const w = WEIGHT[c.weight];
  return (
    <details className={`card evidence evidence-${c.weight}`} open={c.weight === "high" || c.weight === "medium"}>
      <summary>
        <span className={`badge ${w.tone}`}>{w.label}</span> <strong>{c.title}</strong> <span className="small">{c.summary}</span>
      </summary>
      {c.items.length ? <ul className="evidence-items">{c.items.map((x, i) => <Item key={i} x={x} r={r} />)}</ul> : null}
      {c.more ? <p className="muted small">… and {c.more} more.</p> : null}
    </details>
  );
}

function Item({ x, r }: { x: EvidenceItem; r: Investigation }) {
  const hasRaw = Boolean(x.raw?.length || x.curves);
  const head = (
    <>
      {x.at && <span className="mono small muted" title={x.at}>{when(x.at)}</span>}{" "}
      <span className="small">{x.text}</span>
      {x.nifiUrl && <>{" "}<a className="small" href={x.nifiUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>Open in NiFi ↗</a></>}
    </>
  );
  if (!hasRaw) return <li>{head}</li>;
  return (
    <li>
      <details>
        <summary>{head}</summary>
        {x.curves && <LineChart title={String(x.detail?.field ?? "")} unit={x.curves.unit} series={x.curves.series} from={Date.parse(r.from)} to={Date.parse(r.to)} note="“a day before” is the same hours a day earlier, shifted onto the window." />}
        {x.raw?.length ? <pre className="raw small">{x.raw.join("\n\n")}</pre> : null}
      </details>
    </li>
  );
}
