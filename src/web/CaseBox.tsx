// S37 step 9 (pages-rethink §4.4, Q4): "Let the AI analyse" on the Investigate and Data trace tabs, and a CRIT alert's
// own analysis. The page's result goes to the Deploy Assistant only when a person presses the button; the answer comes
// back in three parts (likely cause, evidence, next steps) and the person can go on asking in the same session. Every
// analysis is a case: the outcome a person writes is kept with it, and the Assistant reads earlier cases of the same
// service and rule. What the AI proposes to change is a card: a configuration draft opens on the Changes section, a start,
// stop or restart shows its plan there; a person confirms it (S9, D7).

import { useCallback, useEffect, useState } from "react";
import * as api from "./api.ts";
import type { CaseProposal, ChangeKind, ServiceCase } from "./api.ts";
import { ask } from "./Confirm.tsx";
import { Markdown } from "./Markdown.tsx";
import { ago, when } from "./svc.tsx";

export type PlanChange = (r: { kind: ChangeKind; members: string[] }) => void;
const CONFIDENCE: Record<string, string> = { high: "ok", medium: "warn", low: "info" };

/** Opens a configuration draft on its service's Changes section (App.tsx listens). */
export function openDraft(service: string, draft: string) { window.dispatchEvent(new CustomEvent("oa:open-service-draft", { detail: { id: service, draft } })); }

/** The case's state, polled while the assistant answers. */
function useCase(service: string, id: number | undefined) {
  const [c, setC] = useState<ServiceCase | undefined>();
  const [error, setError] = useState("");
  const load = useCallback(() => { if (id !== undefined) api.serviceCase(service, id).then(setC, (e: Error) => setError(e.message)); }, [service, id]);
  useEffect(load, [load]);
  useEffect(() => {
    if (c?.state !== "running") return;
    const t = setInterval(load, 2_000);
    return () => clearInterval(t);
  }, [c?.state, load]);
  return { c, setC, error, setError };
}

/** The button and, once pressed, the case. `start` makes the case from what the page shows. */
export function AnalyseBox({ s, start, plan, canAct, label = "Let the AI analyse" }: { s: api.ServiceStatus; start: () => Promise<ServiceCase>; plan?: PlanChange | undefined; canAct?: boolean; label?: string }) {
  const [id, setId] = useState<number | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const go = async () => {
    if (id !== undefined && !(await ask("Ask the assistant again? The earlier analysis stays as a case of this service.", { confirm: "Analyse again" }))) return;
    setBusy(true); setError("");
    try { setId((await start()).id); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <section className="card ai-case">
      <div className="row wrap">
        <button className="primary" disabled={busy} onClick={() => void go()}>{busy ? "Asking…" : id === undefined ? label : "Analyse again"}</button>
        <span className="muted small">Sends this page's result (secrets hidden) to the Deploy Assistant. It may read more with read-only tools and changes nothing; what it proposes, you confirm.</span>
      </div>
      {error && <p className="error small">{error}</p>}
      {id !== undefined && <CaseView key={id} service={s.id} id={id} plan={plan} canAct={canAct} />}
    </section>
  );
}

/** One case: the three-part answer, the cards, the conversation, the outcome. */
export function CaseView({ service, id, plan, canAct }: { service: string; id: number; plan?: PlanChange | undefined; canAct?: boolean | undefined }) {
  const { c, setC, error, setError } = useCase(service, id);
  const [question, setQuestion] = useState("");
  const [outcome, setOutcome] = useState<string | undefined>();
  if (!c) return error ? <p className="error small">{error}</p> : <p className="muted small">Loading the case…</p>;
  const first = c.answer;
  const busy = c.state === "running";
  const send = async () => {
    try { setC(await api.askCase(service, c.id, question.trim())); setQuestion(""); setError(""); } catch (e) { setError((e as Error).message); }
  };
  const save = async () => {
    try { setC(await api.caseOutcome(service, c.id, outcome ?? "")); setOutcome(undefined); setError(""); } catch (e) { setError((e as Error).message); }
  };
  return (
    <div className="case">
      <p className="muted small">Case #{c.id} · {c.title} · {when(c.requestedAt)}{c.requestedBy === "deployer" ? " · started by the Deployer (CRIT alert)" : ""}</p>
      {busy && !first && !c.text && <p className="muted">The assistant is analysing… ({ago(c.turnAt)})</p>}
      {c.state === "failed" && <p className="error small">{c.error}</p>}
      {first && (
        <div className="case-answer">
          <h4>Likely cause {first.confidence && <span className={`badge ${CONFIDENCE[first.confidence] ?? "info"}`}>{first.confidence}</span>}</h4>
          <p>{first.cause}</p>
          <h4>Evidence</h4>
          {first.evidence.length ? <ul className="small">{first.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul> : <p className="muted small">None given.</p>}
          <h4>Next steps</h4>
          {first.next.length ? <ol className="small">{first.next.map((e, i) => <li key={i}>{e}</li>)}</ol> : <p className="muted small">None given.</p>}
          {first.proposals.length > 0 && <div className="row wrap">{first.proposals.map((p, i) => <ProposalCard key={i} service={service} p={p} plan={plan} canAct={canAct} />)}</div>}
        </div>
      )}
      {!first && c.text && <div className="case-answer"><p className="muted small">The answer was not in the three-part form:</p><Markdown text={c.text} /></div>}
      {c.messages.map((m, i) => (
        <div key={i} className={`case-msg case-${m.role}`}>
          <span className="muted small">{m.role === "person" ? m.by ?? "you" : "Assistant"} · {when(m.at)}</span>
          {m.role === "assistant" ? <Markdown text={m.text} /> : <p>{m.text}</p>}
        </div>
      ))}
      {busy && (first || c.text) && <p className="muted small">The assistant is answering… ({ago(c.turnAt)})</p>}
      {c.session && c.state !== "running" && (
        <div className="row wrap">
          <input className="grow" value={question} maxLength={2000} placeholder="Ask a follow-up question…" onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && question.trim()) void send(); }} />
          <button disabled={!question.trim()} onClick={() => void send()}>Ask</button>
        </div>
      )}
      <div className="case-outcome">
        <h4>Outcome</h4>
        {outcome === undefined ? (
          <p className="small">{c.outcome ? <>{c.outcome.text} <span className="muted">— {c.outcome.by}, {when(c.outcome.at)}</span></> : <span className="muted">Not written yet: what it really was and what was done, for the next time this happens.</span>}{" "}
            <button className="link" onClick={() => setOutcome(c.outcome?.text ?? "")}>{c.outcome ? "Edit" : "Write"}</button></p>
        ) : (
          <div>
            <textarea rows={3} maxLength={4000} value={outcome} onChange={(e) => setOutcome(e.target.value)} placeholder="e.g. Downstream SFTP password expired; renewed it, queue drained by 10:40." />
            <div className="row"><button className="primary" onClick={() => void save()}>Save outcome</button><button onClick={() => setOutcome(undefined)}>Cancel</button></div>
          </div>
        )}
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

const KIND_TEXT: Record<Exclude<CaseProposal["kind"], "config">, string> = { start: "Start", stop: "Stop", restart: "Restart" };

function ProposalCard({ service, p, plan, canAct }: { service: string; p: CaseProposal; plan?: PlanChange | undefined; canAct?: boolean | undefined }) {
  if (p.kind === "config") {
    return (
      <div className="card proposal">
        <b>Configuration draft</b> <span className="mono small">{p.draft}</span>
        {p.label && <p className="small">{p.label}</p>}
        <button onClick={() => openDraft(service, p.draft)}>Review the draft on Changes</button>
      </div>
    );
  }
  return (
    <div className="card proposal">
      <b>{KIND_TEXT[p.kind]}</b> <span className="mono small">{p.members.join(", ")}</span>
      {p.label && <p className="small">{p.label}</p>}
      {plan && canAct ? <button onClick={() => plan({ kind: p.kind, members: p.members })} title="Shows the plan on the Changes section; nothing runs until you confirm it there">Show the plan on Changes</button>
        : <p className="muted small">Needs the right to change this service, and no change running.</p>}
    </div>
  );
}

/** Earlier cases of the service (and rule): the runbook the assistant reads too. */
export function EarlierCases({ service, rule }: { service: string; rule?: string | undefined }) {
  const [cases, setCases] = useState<Awaited<ReturnType<typeof api.serviceCases>>["cases"]>([]);
  useEffect(() => { api.serviceCases(service, { ...(rule ? { rule } : {}), limit: 10 }).then((r) => setCases(r.cases), () => setCases([])); }, [service, rule]);
  if (!cases.length) return null;
  return (
    <details className="card">
      <summary><b>Earlier cases</b> <span className="muted small">{cases.length}{rule ? ` of ${rule}` : ""}</span></summary>
      <ul className="small">
        {cases.map((c) => (
          <li key={c.id}>
            <span className="muted">#{c.id} {when(c.requestedAt)} · {c.kind}{c.rule ? ` · ${c.rule}` : ""}</span> {c.answer?.cause ?? c.error ?? "(no answer)"}
            {c.outcome && <div>Outcome: {c.outcome.text} <span className="muted">— {c.outcome.by}</span></div>}
          </li>
        ))}
      </ul>
    </details>
  );
}
