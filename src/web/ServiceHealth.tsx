// Screen 2 (prototype Service.dc.html), the service page's Health tab: the machine card (big, six checks) and the business card
// (the flows, each a link to the flow page of 6b), the AI analysis (the reason, what it looked at, when and why), For you
// (the to-dos, at most one main button each) and the configuration summary. The AI only drafts: Apply the AI's change opens
// the draft and the three steps, and only a click goes on into the Deployer's own draft -> diff -> rolling restart flow.
// Ask AI is the one button at the page's bottom right (App); "Ask about this" gives it the to-do as context.
// Fixed text is English, the AI's text Chinese (C2).

import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "./api.ts";
import type { ChangeKind } from "./api.ts";
import { ask } from "./Confirm.tsx";
import { ANOMALY_LABEL, LIGHT_LABEL, UNKNOWN_REASON } from "./FlowParts.tsx";
import { BigLight, LightBadge } from "./OpsParts.tsx";
import { flowHref, flowsHref, openAskAi } from "./flow-routes.ts";
import { usePageFocus } from "./focus.ts";
import { ops } from "./ops-data.ts";
import type { AnalysisView, FlowRow, MachineCheck, ServicePage, TodoView } from "../server/services/ops-types.ts";
import { actionLabel, changeRow, clock, TRIGGER_TEXT } from "./ops-view.ts";
import { shortTime } from "./FlowParts.tsx";

const MARK = { failing: "✕", attention: "!", healthy: "✓", unknown: "?" } as const;
const CHECK_NAME = (check: MachineCheck, cluster: boolean) => ({ process: cluster ? "Nodes" : "Process", disk: "Disk", heap: "Memory", certificate: "Certificate", coordinator: "Cluster", collection: "Collection" })[check];
// The order the prototype shows them in.
const CHECK_ORDER: MachineCheck[] = ["process", "disk", "heap", "collection", "coordinator", "certificate"];

export type HealthProps = {
  id: string;
  isAdmin: boolean;
  /** The person may make configuration drafts and start changes (cfg.canDraft). */
  canDraft: boolean;
  /** A change holds the service: no new plan can start. */
  busy: boolean;
  /** Opens a configuration draft on the Configuration and changes tab. */
  onOpenDraft: (draft: string) => void;
  onOpenConfig: () => void;
  /** Asks for a plan (a node restart); the page shows it. */
  plan: (request: { kind: ChangeKind; members: string[] }) => void;
};

export function ServiceHealth(p: HealthProps) {
  const [page, setPage] = useState<ServicePage | undefined>();
  const [error, setError] = useState("");
  const load = useCallback(() => ops.page(p.id).then((d) => { setPage(d); setError(""); }, (e: Error) => setError(e.message)), [p.id]);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 15_000); return () => clearInterval(t); }, [load]);

  // A running analysis is polled until it ends; then the page is read again (the to-dos may have changed).
  const running = page?.analysis?.state === "running" ? page.analysis.id : undefined;
  useEffect(() => {
    if (running === undefined) return;
    const t = setInterval(() => { ops.analysis(running).then((a) => { if (a.state !== "running") void load(); }, () => undefined); }, 3_000);
    return () => clearInterval(t);
  }, [running, load]);

  // What Ask AI knows: the analysis on the page, and a to-do the person asked about.
  const [asked, setAsked] = useState<string | undefined>();
  usePageFocus("analysis", page?.analysis ? String(page.analysis.id) : undefined);
  usePageFocus("todo", asked);
  useEffect(() => {
    const on = () => setAsked(undefined);
    window.addEventListener("oa:assistant-closed", on);
    return () => window.removeEventListener("oa:assistant-closed", on);
  }, []);

  if (!page) return error ? <p className="fl-error">{error}</p> : <p className="fl-muted">Loading…</p>;
  const cluster = page.service.kind === "cluster";
  return (
    <>
      {error && <p className="fl-error">{error}</p>}
      <section className="sv-two">
        <MachineCard page={page} cluster={cluster} />
        <BusinessCard page={page} />
      </section>
      <AnalysisSection service={page.service.id} analysis={page.analysis} onChanged={load} onError={setError} />
      <TodoSection page={page} {...p} onChanged={load} onError={setError} onAsk={(id) => { setAsked(id); openAskAi(); }} />
      <section className="sv-plain" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <h2 style={{ fontSize: 16 }}>Configuration and changes</h2>
          <span style={{ fontSize: 14, color: "#3C3C39" }}>{configLine(page.config)}</span>
          {page.config.drift && <span style={{ fontSize: 13, color: "#8A5300" }}>Files on the hosts differ from the revision kept here (config drift).</span>}
          {page.config.activeChange && <span style={{ fontSize: 13, color: "#5B5B57" }}>A change is under way.</span>}
        </div>
        <a href="#" style={{ fontSize: 14, fontWeight: 600 }} onClick={(e) => { e.preventDefault(); p.onOpenConfig(); }}>Open →</a>
      </section>
    </>
  );
}

function configLine(c: ServicePage["config"]): string {
  if (c.revision === null) return "No configuration kept yet.";
  const last = c.lastChange ? ` · last change ${shortTime(c.lastChange.at).slice(0, 5)}: ${c.lastChange.text} (${c.lastChange.by})` : "";
  return `Revision r${c.revision}${last}`;
}

function MachineCard({ page, cluster }: { page: ServicePage; cluster: boolean }) {
  const m = page.machine;
  const checks = [...m.checks].sort((a, b) => CHECK_ORDER.indexOf(a.check) - CHECK_ORDER.indexOf(b.check));
  return (
    <div className={`sv-card sv-machine edge-${m.light}`}>
      <div className="sv-title"><b>Machine</b><span>rules · refreshed {clock(m.asOf)}</span></div>
      <BigLight light={m.light} size={32} />
      <p className="sv-sentence">{m.sentence}</p>
      <div className="sv-checks">
        {checks.map((c) => (
          <div key={c.check} className={`sv-check tone-${c.light}`} title={c.member ? `${LIGHT_LABEL[c.light]} · ${c.member}` : LIGHT_LABEL[c.light]}>
            <span className={`mark tone-text-${c.light}`} aria-label={LIGHT_LABEL[c.light]}>{MARK[c.light]}</span>
            <div><small>{CHECK_NAME(c.check, cluster)}</small><strong className={`tone-text-${c.light}`}>{c.text}</strong></div>
          </div>
        ))}
      </div>
      {m.members.length > 0 && <div className="sv-members">{m.members.map((n) => <span key={n.key}>{n.label}: {n.state}{n.connection ? ` · ${n.connection}` : ""}</span>)}</div>}
    </div>
  );
}

/** What the flow's pill says: the first anomaly's name, else the light. */
const flowPill = (f: FlowRow) => (f.light !== "healthy" && f.anomalies[0] ? ANOMALY_LABEL[f.anomalies[0]] : LIGHT_LABEL[f.light]);

function BusinessCard({ page }: { page: ServicePage }) {
  const b = page.business;
  const id = page.service.id;
  return (
    <div className={`sv-card sv-business edge-${b.light}`}>
      <div className="sv-title"><b>Business{b.flows.length > 0 ? ` · ${b.flows.length} ${b.flows.length === 1 ? "flow" : "flows"}` : ""}</b><span>is the data right?</span></div>
      <BigLight light={b.light} size={28} />
      {b.light === "unknown" && <p className="sv-sentence" style={{ fontSize: 15 }}>{b.reason && b.reason !== "unconfirmed" ? `${UNKNOWN_REASON[b.reason]}. ` : ""}{b.sentence}</p>}
      <div className="sv-flows">
        {b.flows.map((f) => (
          <a key={f.id} className="sv-flow" href={flowHref(f.id, id)}>
            <span className={`dot d-${f.light}`} />
            <span className="body">
              <span className="name"><b>{f.name}</b><span className={`fl-pill tone-${f.light}`}>{flowPill(f)}</span>{f.services.length > 1 && <span className="fl-muted" style={{ fontSize: 12 }}>Spans {f.services.length} services</span>}</span>
              <span className="text">{f.sentence}</span>
            </span>
            <span style={{ fontSize: 13, color: "#1F4FB8", paddingTop: 2 }}>›</span>
          </a>
        ))}
        {b.flows.length === 0 && <p className="fl-muted" style={{ margin: 0 }}>No confirmed flows yet.</p>}
        {b.toConfirm > 0 && <a className="sv-flow" href={flowsHref(id)}><span className="dot d-unknown" /><span className="body"><span className="name"><b>{b.toConfirm} {b.toConfirm === 1 ? "flow" : "flows"} to confirm</b></span><span className="text">The AI found {b.toConfirm === 1 ? "it" : "them"} on the canvas; the business light waits for you.</span></span><span style={{ fontSize: 13, color: "#1F4FB8", paddingTop: 2 }}>›</span></a>}
      </div>
      <div className="sv-foot">The AI found these flows on the canvas. If one is wrong, open it and tell the AI.</div>
    </div>
  );
}

function AnalysisSection({ service, analysis, onChanged, onError }: { service: string; analysis: AnalysisView | null; onChanged: () => unknown; onError: (m: string) => void }) {
  const [starting, setStarting] = useState(false);
  const again = async () => {
    setStarting(true);
    try { await ops.checkService(service); onError(""); } catch (e) { onError((e as Error).message); } finally { setStarting(false); await onChanged(); }
  };
  const running = analysis?.state === "running";
  return (
    <section className="sv-plain">
      <div className="sv-plain-head">
        <div><h2 style={{ fontSize: 18, display: "inline" }}>AI analysis</h2>
          {analysis && <span className="meta">{clock(analysis.finishedAt ?? analysis.startedAt)} · started by {TRIGGER_TEXT[analysis.trigger]}{analysis.stale && <> · <b className="tone-text-attention">out of date</b></>}</span>}
        </div>
        <button type="button" className="fl-btn small" disabled={starting || running} onClick={() => void again()}>Look again now</button>
      </div>
      {!analysis && <p className="fl-muted" style={{ margin: 0 }}>No AI analysis of this service yet.</p>}
      {analysis?.state === "running" && <p className="fl-muted" style={{ margin: 0 }}>The AI is looking at this service…</p>}
      {analysis?.state === "failed" && <p className="fl-error" style={{ margin: 0 }}>The analysis failed{analysis.error ? `: ${analysis.error}` : "."}</p>}
      {analysis?.state === "done" && analysis.summary && <p className="sv-summary">{analysis.summary}</p>}
      {analysis?.state === "done" && analysis.lookedAt.length > 0 && (
        <div className="sv-looked"><b>What the AI looked at</b>{analysis.lookedAt.map((l, i) => <span key={i}>· {l}</span>)}</div>
      )}
    </section>
  );
}

type TodoProps = HealthProps & { page: ServicePage; onChanged: () => unknown; onError: (m: string) => void; onAsk: (todo: string) => void };

function TodoSection(p: TodoProps) {
  const [dialog, setDialog] = useState<TodoView | undefined>();
  const todos = p.page.todos;
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h2 style={{ fontSize: 18 }}>For you ({todos.length})</h2>
      {todos.length === 0 && <p className="fl-muted" style={{ margin: 0 }}>Nothing is waiting for you.</p>}
      {todos.map((t, i) => <TodoCard key={t.id} t={t} n={i + 1} {...p} onApply={() => setDialog(t)} />)}
      {dialog && <ApplyDialog t={dialog} cluster={p.page.service.kind === "cluster"} onClose={() => setDialog(undefined)} onCreated={() => { setDialog(undefined); void p.onChanged(); }} />}
    </section>
  );
}

function TodoCard(p: TodoProps & { t: TodoView; n: number; onApply: () => void }) {
  const { t } = p;
  const a = t.action;
  const [busy, setBusy] = useState(false);
  const guard = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); p.onError(""); await p.onChanged(); } catch (e) { p.onError((e as Error).message); } finally { setBusy(false); }
  };
  const setThreshold = async () => {
    if (a?.kind !== "set-threshold") return;
    const text = Object.entries(a.overrides).map(([k, v]) => `${k} = ${v}`).join(", ");
    if (!(await ask(`Change this service's limits (${text})? This is the same change as on the thresholds API; it takes effect at the next check.`, { confirm: "Change limits" }))) return;
    await guard(async () => { await api.putThresholds(t.service, a.overrides); await ops.todoState(t.id, "done"); });
  };
  const main = (() => {
    if (!a) return null;
    switch (a.kind) {
      case "config-change":
        if (t.draft) return null;
        return <button type="button" className="fl-btn primary" disabled={!p.canDraft || busy} title={p.canDraft ? "Shows the change and the steps first" : "You can see this change but not make it"} onClick={p.onApply}>{actionLabel(a)}</button>;
      case "member-control":
        return <button type="button" className="fl-btn" disabled={!p.canDraft || p.busy || busy} title="Shows a plan first" onClick={() => p.plan({ kind: a.action, members: [a.member] })}>{actionLabel(a)}</button>;
      case "set-threshold":
        return <button type="button" className="fl-btn" disabled={!p.isAdmin || busy} onClick={() => void setThreshold()}>{actionLabel(a)}</button>;
      case "confirm-flows":
        return <a className="fl-btn" href={flowsHref(t.service)}>{actionLabel(a)}</a>;
      case "open-nifi":
        return <a className="fl-btn" href={a.url} target="_blank" rel="noreferrer">{actionLabel(a)} ↗</a>;
    }
  })();
  return (
    <div className="sv-todo">
      <div className="sv-todo-title"><span className={`n ${t.severity}`}>{p.n}</span><span>{t.title}</span></div>
      <p>{t.detail}</p>
      {a?.kind === "config-change" && t.draft && <div className="ok">Draft created. Review it in Configuration and changes, then roll it out. <button type="button" className="fl-btn small" onClick={() => p.onOpenDraft(t.draft!)}>Open the draft</button></div>}
      <div className="acts">
        {main}
        <button type="button" className="fl-linkbtn" title="Opens Ask AI with this item as context" onClick={() => p.onAsk(t.id)}>Ask about this</button>
        {p.isAdmin && <>
          <button type="button" className="fl-linkbtn" disabled={busy} onClick={() => void guard(() => ops.todoState(t.id, "done"))}>Mark done</button>
          <button type="button" className="fl-linkbtn" disabled={busy} onClick={() => void guard(() => ops.todoState(t.id, "dismissed"))}>Not needed</button>
        </>}
        <span className="fl-muted" style={{ fontSize: 12 }}>{t.source === "chat" ? `From your chat with the AI · ${t.createdBy}` : t.source === "flows" ? "From the flows" : t.source === "gate" ? "From a rejected model" : `AI · ${shortTime(t.createdAt)}`}</span>
      </div>
    </div>
  );
}

/** "Change drafted by the AI": what changes and the three steps. Only the button makes the draft (nothing is saved or restarted by it). */
function ApplyDialog({ t, cluster, onClose, onCreated }: { t: TodoView; cluster: boolean; onClose: () => void; onCreated: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { const d = ref.current; if (d && !d.open) d.showModal(); }, []);
  if (t.action?.kind !== "config-change") return null;
  const rows = t.action.changes.map(changeRow);
  const showNow = rows.some((r) => r.now !== undefined);
  const create = async () => {
    setBusy(true);
    try { await ops.draftTodo(t.id); onCreated(); } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return (
    <dialog ref={ref} className="ops-dialog" aria-label="Change drafted by the AI" onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }} onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="body">
        <h2>Change drafted by the AI</h2>
        <table>
          <thead><tr><th>Setting</th>{showNow && <th>Now</th>}<th>Change to</th></tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i}><td>{r.setting}{r.file && <small>{r.file}{cluster ? " · all nodes" : ""}</small>}</td>{showNow && <td>{r.now ?? "-"}</td>}<td style={{ fontWeight: 700 }}>{r.to}</td></tr>)}</tbody>
        </table>
        {t.action.note && <p style={{ margin: 0, fontSize: 14, color: "#3C3C39", lineHeight: 1.6 }}>{t.action.note}</p>}
        <div className="next">
          <b>Next</b>
          <span>1. Create a configuration draft (nothing changes yet)</span>
          <span>2. Review the difference in Configuration and changes and save it as a revision</span>
          <span>3. {cluster ? "Rolling restart: one node at a time, each after a cluster check" : "Restart, after you confirm the plan"}</span>
        </div>
        {error && <div className="err">{error}</div>}
        <div className="acts">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void create()}>Create draft</button>
        </div>
      </div>
    </dialog>
  );
}
