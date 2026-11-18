// S37 step 8 (pages-rethink §3, §4.2): the Data trace tab — what a business person reports as "my data did not arrive".
// Clues in (business, file name, email sender and subject, a time range, the last 24 hours by default), the engine's
// answer out as an end-to-end step strip put together across services: each step's state, node, time, evidence source
// and whether it is inferred, the step where the data stopped highlighted, the verdict's message as the engine wrote it,
// its context (queue, back pressure, downstream) and actions as buttons, and evidence cards with a deep link into NiFi (Q5).
// A sentence in the box on top is turned into conditions by the Deploy Assistant (Q6: only the sentence, the business
// names and the time are sent); the conditions fill the fields below, nothing is traced until the person presses Trace.
// Without an answer in 5 seconds the form is simply what is there.

import { useEffect, useRef, useState } from "react";
import * as api from "./api.ts";
import type { HandoverResult, NlConditions, ServiceStatus, StepResult, TraceInput, TraceResult, Verdict, VerdictAction } from "./api.ts";
import { when } from "./svc.tsx";

/** A datetime-local value (the browser's zone) for a time. */
const localInput = (t: number) => { const d = new Date(t); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const iso = (local: string) => new Date(local).toISOString();
const CLUES = [{ id: "fileName", label: "File name" }, { id: "emailFrom", label: "Email sender" }, { id: "emailSubject", label: "Email subject" }] as const;
const KIND_TONE: Record<Verdict["kind"], string> = { completed: "ok", failed: "bad", stuck: "warn", "handover-lost": "bad", insufficient: "info", "in-progress": "info" };
const STATE_MARK: Record<StepResult["state"], string> = { done: "✔", failed: "✖", started: "…", none: "?", "not-reached": "·" };
const STATE_TONE: Record<StepResult["state"], string> = { done: "ok", failed: "bad", started: "warn", none: "info", "not-reached": "muted" };
const minutes = (sec: number) => (sec % 60 === 0 ? `${sec / 60} min` : `${sec} s`);

/** Opens another service's page on a tab (Services.tsx listens); on this service's own page the tab is just switched. */
export function openService(id: string, tab: string) { window.dispatchEvent(new CustomEvent("oa:open-service", { detail: { id, tab } })); }

/** Q5: a link to the component in the service's NiFi UI: its process group and the component, from NiFi's own search. */
async function nifiLink(service: string, component: string): Promise<string> {
  const [st, found] = await Promise.all([api.serviceStatus(service), api.searchPositions(service, component).catch(() => undefined)]);
  if (!st.webUrl) throw new Error(`${service} has no NiFi UI address.`);
  const hit = found?.results.find((r) => r.id === component);
  const u = new URL(st.webUrl);
  if (!u.pathname.endsWith("/")) u.pathname += "/";
  if (hit?.kind === "process-group") u.searchParams.set("processGroupId", hit.id);
  else { if (hit?.groupId) u.searchParams.set("processGroupId", hit.groupId); u.searchParams.set("componentIds", component); }
  return u.toString();
}

export function DataTrace({ s, open }: { s: ServiceStatus; open: (tab: string) => void }) {
  const [businesses, setBusinesses] = useState<{ id: string; name: string }[]>([]);
  const [sentence, setSentence] = useState("");
  const [nl, setNl] = useState<{ state: "asking" } | { state: "done"; ms: number } | { state: "fallback"; reason: string } | undefined>();
  const [form, setForm] = useState({ business: "", fileName: "", emailFrom: "", emailSubject: "", from: localInput(Date.now() - 86400_000), to: localInput(Date.now()) });
  const [filled, setFilled] = useState<Set<string>>(new Set());
  const [answer, setAnswer] = useState<api.TraceAnswer | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const seq = useRef(0);
  useEffect(() => { api.traceModel(s.id).then((v) => setBusinesses(v.model.businesses.map((b) => ({ id: b.id, name: b.name }))), () => undefined); }, [s.id]);

  // Q6: every pause in typing asks once (a newer sentence makes an older answer stale).
  useEffect(() => {
    const text = sentence.trim();
    if (text.length < 3) { setNl(undefined); return; }
    const mine = ++seq.current;
    setNl({ state: "asking" });
    const timer = setTimeout(() => {
      api.traceParse(s.id, text).then((r) => {
        if (mine !== seq.current) return;
        if ("fallback" in r) { setNl({ state: "fallback", reason: r.fallback }); return; }
        apply(r.conditions);
        setNl({ state: "done", ms: r.ms });
      }, (e: Error) => { if (mine === seq.current) setNl({ state: "fallback", reason: e.message }); });
    }, 900);
    return () => clearTimeout(timer);
  }, [sentence, s.id]);

  const apply = (c: NlConditions) => {
    setForm((f) => ({
      business: c.business ?? "", fileName: c.fileName ?? "", emailFrom: c.emailFrom ?? "", emailSubject: c.emailSubject ?? "",
      from: c.from ? localInput(Date.parse(c.from)) : f.from, to: c.to ? localInput(Date.parse(c.to)) : f.to,
    }));
    setFilled(new Set(Object.entries(c).filter(([, v]) => v).map(([k]) => k)));
  };
  const set = (k: keyof typeof form, v: string) => { setForm((f) => ({ ...f, [k]: v })); setFilled((x) => { const n = new Set(x); n.delete(k); return n; }); };
  const hasClue = CLUES.some((c) => form[c.id].trim());
  const run = async () => {
    setBusy(true); setError(""); setAnswer(undefined);
    const q: TraceInput = { from: iso(form.from), to: iso(form.to) };
    if (form.business) q.business = form.business;
    for (const c of CLUES) if (form[c.id].trim()) q[c.id] = form[c.id].trim();
    try { setAnswer(await api.traceBusinessData(s.id, q)); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const mark = (k: string) => (filled.has(k) ? "from-ai" : "");

  return (
    <div className="panel">
      <p className="muted small">
        Follows one piece of business data from what the person knows: the business, a file name, the email's sender or subject, and roughly when. Services are joined by their business models
        (Site-to-Site, MQ); each step comes from the evidence source named on it. Only reads.
      </p>
      <section className="card">
        <label className="field">Say it in a sentence
          <input value={sentence} onChange={(e) => setSentence(e.target.value)} placeholder="e.g. 昨天下午张三发的主题带“发票”的邮件，下游没收到" maxLength={300} />
          <span className="muted small">
            {!nl && "The Deploy Assistant reads the sentence into the conditions below. Only the sentence, this service's business names and the current time are sent, no data; nothing is traced until you press Trace."}
            {nl?.state === "asking" && "Reading the sentence…"}
            {nl?.state === "done" && `Read in ${(nl.ms / 1000).toFixed(1)} s. Check the highlighted conditions below, change what is wrong, then press Trace.`}
            {nl?.state === "fallback" && `Could not read the sentence (${nl.reason}) — fill in the form below.`}
          </span>
        </label>
      </section>
      <section className="card trace-form">
        <h3>Conditions</h3>
        <div className="row wrap">
          <label className="field">Business
            <select value={form.business} onChange={(e) => set("business", e.target.value)} className={mark("business")}>
              <option value="">(any, ask them all)</option>
              {businesses.map((b) => <option key={b.id} value={b.id}>{b.name || b.id}</option>)}
            </select>
          </label>
          {CLUES.map((c) => <label key={c.id} className="field">{c.label}<input value={form[c.id]} className={mark(c.id)} onChange={(e) => set(c.id, e.target.value)} maxLength={256} /></label>)}
        </div>
        <div className="row wrap">
          <label className="field">From<input type="datetime-local" value={form.from} className={mark("from")} onChange={(e) => set("from", e.target.value)} /></label>
          <label className="field">To<input type="datetime-local" value={form.to} className={mark("to")} onChange={(e) => set("to", e.target.value)} /></label>
          <button className="primary" disabled={busy || !hasClue || !form.from || !form.to} onClick={() => void run()}>{busy ? "Tracing…" : "Trace"}</button>
        </div>
        {!hasClue && <p className="muted small">Give at least one clue: a file name, the email sender or the subject.</p>}
        {businesses.length === 0 && <p className="muted small">This service has no business model yet (Business model tab); the trace can only look for the clue at the places other services' models lead to.</p>}
      </section>
      {error && <p className="error">{error}</p>}
      {answer && <Answer s={s} a={answer} open={open} />}
    </div>
  );
}

function Answer({ s, a, open }: { s: ServiceStatus; a: api.TraceAnswer; open: (tab: string) => void }) {
  return (
    <>
      {a.notFound && <section className="card"><p><span className={`badge ${a.notFound.insufficient ? "info" : "warn"}`}>{a.notFound.insufficient ? "Insufficient evidence" : "Not found"}</span> {a.notFound.message}</p>
        {a.notFound.missing.map((m, i) => <p key={i} className="muted small">{m.source}: {m.message}</p>)}</section>}
      {a.traces.length > 1 && <p className="muted small">{a.traces.length} traces match{a.truncated ? " (more were left out: narrow the time range or the clues)" : ""}; the newest first.</p>}
      {a.traces.map((t, i) => <TraceCard key={`${t.start.key.value}-${i}`} s={s} t={t} open={open} first={i === 0} />)}
      {a.notes.length > 0 && <ul className="muted small">{a.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
    </>
  );
}

function TraceCard({ s, t, open, first }: { s: ServiceStatus; t: TraceResult; open: (tab: string) => void; first: boolean }) {
  const v = t.verdict;
  return (
    <details className="card trace-card" open={first}>
      <summary><span className={`badge ${KIND_TONE[v.kind]}`}>{v.kind}</span>{v.inferred && <span className="badge info" title="Matched by file name and time, not by an id the evidence confirms">inferred</span>} <b>{t.start.entry}</b> <span className="muted small">{t.start.key.name} = {t.start.key.value} · {when(t.start.at)}</span></summary>
      <VerdictBox s={s} v={v} open={open} />
      {t.segments.map((seg, i) => {
        const here = seg.service === v.service && seg.business === v.business && v.kind !== "completed";
        // After an inferred hand-over, everything further on rests on the guess.
        const inferred = t.segments.slice(0, i).some((x) => x.handover?.state === "inferred");
        return (
          <div key={i} className="trace-seg">
            <h4>{seg.service} · {seg.businessName} <span className="muted small">{seg.key.name} = {seg.key.value}</span></h4>
            <ol className="trace-steps">{seg.steps.map((st) => <Step key={st.step} service={seg.service} st={st} stop={here && st.step === v.step} inferred={inferred} />)}</ol>
            {seg.handover && <Handover h={seg.handover} />}
          </div>
        );
      })}
    </details>
  );
}

function VerdictBox({ s, v, open }: { s: ServiceStatus; v: Verdict; open: (tab: string) => void }) {
  const [note, setNote] = useState("");
  const c = v.context;
  return (
    <div className={`trace-verdict tone-${KIND_TONE[v.kind]}`}>
      <p>{v.message}</p>
      {v.at && <p className="muted small">At {when(v.at)} · {v.service} · {v.business}{v.step ? ` · ${v.step}` : ""}</p>}
      {v.allowed && <p className="small">Allowed here: {minutes(v.allowed.seconds)} <span className="muted">({v.allowed.by === "model" ? "set in the business model" : v.allowed.by === "default" ? "the default" : `from ${v.allowed.by}'s history`})</span></p>}
      {c && (
        <p className="small">
          {c.queue ? <>Queue {c.queue.name ? `“${c.queue.name}” ` : ""}{c.queue.flowFilesQueued !== undefined ? `${c.queue.flowFilesQueued} FlowFiles, ` : ""}{c.queue.percent}% full{c.queue.backpressure ? <> <span className="badge bad">back pressure</span></> : ""}. </> : <span className="muted">No queue reading. </span>}
          {c.downstream ? <>Next component {c.downstream.name ?? c.downstream.id}: {c.downstream.running === null ? "state unknown" : c.downstream.running ? "running" : <span className="badge bad">not running{c.downstream.runStatus ? ` (${c.downstream.runStatus})` : ""}</span>}. </> : null}
          {c.notes.length > 0 && <span className="muted">{c.notes.join(" ")}</span>}
        </p>
      )}
      <div className="row wrap">
        {(v.actions ?? []).map((a, i) => <ActionButton key={i} a={a} s={s} open={open} onNote={setNote} />)}
        {v.service && v.at && (
          <button onClick={() => (v.service === s.id ? open("logs") : openService(v.service, "logs"))}>Look into this node at that time → Logs</button>
        )}
      </div>
      {v.service && v.at && <p className="muted small">The Investigate page is not available yet, so this goes to Logs: set the time range around {when(v.at)}.</p>}
      {note && <p className="error small">{note}</p>}
    </div>
  );
}

function ActionButton({ a, s, open, onNote }: { a: VerdictAction; s: ServiceStatus; open: (tab: string) => void; onNote: (n: string) => void }) {
  if (a.kind === "edit-model") {
    return <button title={`Channel ${a.channel}`} onClick={() => (a.service === s.id ? open("trace-model") : openService(a.service, "trace-model"))}>Edit {a.service}'s business model</button>;
  }
  return <button onClick={() => void go(a.service, a.component, a.url, onNote)}>Open in NiFi ↗</button>;
}

async function go(service: string, component: string, url: string | undefined, onNote: (n: string) => void) {
  try { window.open(url ?? (await nifiLink(service, component)), "_blank", "noopener"); onNote(""); } catch (e) { onNote((e as Error).message); }
}

function Step({ service, st, stop, inferred }: { service: string; st: StepResult; stop: boolean; inferred: boolean }) {
  const [note, setNote] = useState("");
  const node = st.events.find((e) => e.ref?.node)?.ref?.node;
  return (
    <li className={`trace-step tone-${STATE_TONE[st.state]}${stop ? " stop" : ""}`}>
      <div><span className="mark">{STATE_MARK[st.state]}</span> <b>{st.name || st.step}</b>{stop && <span className="badge bad">stopped here</span>}{inferred && <span className="badge info">inferred</span>}</div>
      <div className="muted small">{st.state === "done" ? "done" : st.state === "not-reached" ? "not reached" : st.state === "none" ? "no evidence" : st.state}{st.at ? ` · ${when(st.at)}` : ""}</div>
      <div className="muted small">{[node && `node ${node}`, st.source && `from ${st.source}`].filter(Boolean).join(" · ")}</div>
      {st.missing?.map((m, i) => <div key={i} className="muted small">{m.source}: {m.message}</div>)}
      {st.events.length > 0 && (
        <details className="small">
          <summary>{st.events.length} evidence</summary>
          {st.events.map((e, i) => (
            <div key={i} className="trace-evidence">
              <div>{when(e.at)} · <span className="badge">{e.state}</span> {e.position.name ?? e.position.id} · {e.source}{e.ref?.node ? ` · ${e.ref.node}` : ""}{e.ref?.eventId !== undefined ? ` · event ${e.ref.eventId}` : ""}</div>
              <div className="muted">{e.key.name} = {e.key.value}{Object.keys(e.attrs).length ? ` · ${Object.entries(e.attrs).slice(0, 6).map(([k, v]) => `${k}=${v}`).join(", ")}` : ""}</div>
              {e.position.kind !== "worker" && e.position.id && <button className="link" onClick={() => void go(service, e.position.id, e.ref?.url, setNote)}>Open in NiFi ↗</button>}
            </div>
          ))}
          {note && <p className="error small">{note}</p>}
        </details>
      )}
      {st.events.length === 0 && st.position.kind !== "worker" && st.position.id && <button className="link small" onClick={() => void go(service, st.position.id, undefined, setNote)}>Open in NiFi ↗</button>}
    </li>
  );
}

function Handover({ h }: { h: HandoverResult }) {
  const to = !h.to ? "" : "system" in h.to ? h.to.system : `${h.to.service} · ${h.to.entry}`;
  const tone = h.state === "confirmed" ? "ok" : h.state === "inferred" ? "info" : h.state === "outside" ? "muted" : "bad";
  return <p className="trace-handover small">↓ {h.channel.toUpperCase()} {to ? `to ${to}` : "(no receiving entry)"} <span className={`badge ${tone}`}>{h.state}</span>{h.state === "inferred" && <span className="muted"> same file name in a time window, not confirmed</span>}{h.note ? <span className="muted"> {h.note}</span> : null}</p>;
}
