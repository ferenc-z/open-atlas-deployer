// Screen 3 (prototype Flows.dc.html): confirm the flows the AI found on one service. One card per flow: the diagram, entrance,
// exits, process groups, why it was merged, design risks, the stuck times; then Looks right / Rename / These are two flows /
// Not right, tell the AI. The groups the AI thinks can be ignored come last. Fixed text is English, the AI's text Chinese (C2).

import { useCallback, useEffect, useState } from "react";
import { ask } from "./Confirm.tsx";
import { FlowGraphView } from "./FlowGraphView.tsx";
import { groupsText, RenameField, StuckEditor } from "./FlowParts.tsx";
import type { FlowAction, FlowCard, FlowsReview } from "./flow-types.ts";
import { flowHref, openAskAi } from "./flow-routes.ts";
import { flows } from "./flows-data.ts";
import { usePageFocus } from "./focus.ts";
import "./flows.css";

export function FlowsPage({ service, isAdmin, onBack }: { service: string; isAdmin: boolean; onBack: () => void }) {
  usePageFocus("service", service);
  const [review, setReview] = useState<FlowsReview | undefined>();
  const [error, setError] = useState("");
  const load = useCallback(() => flows.review(service).then((r) => { setReview(r); setError(""); }, (e: Error) => setError(e.message)), [service]);
  useEffect(() => { setReview(undefined); void load(); }, [load]);
  if (!review) return <div className="fl">{error ? <p className="fl-error">{error}</p> : <p className="fl-muted">Loading…</p>}</div>;
  const left = review.flows.filter((c) => c.status !== "confirmed").length;
  return (
    <div className="fl">
      <a href="#" onClick={(e) => { e.preventDefault(); onBack(); }} style={{ fontSize: 14 }}>← {service}</a>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h1>Flows on {service}</h1>
        <p className="fl-lead">{review.intro}</p>
        <div className="fl-legend">
          <span><span className="fl-swatch" style={{ background: "#EEF2F8", border: "1px dashed #C3CCDA" }} />Shaded area = a service</span>
          <span><span className="fl-swatch" style={{ background: "#fff", border: "1px solid #C9C9C2" }} />Box = a process group</span>
          <span><span className="fl-swatch" style={{ background: "#F9F9F7", border: "1px dashed #A3A39C" }} />Dashed box = outside NiFi</span>
        </div>
      </div>
      {error && <p className="fl-error">{error}</p>}
      {review.flows.map((card) => <FlowReviewCard key={card.id} card={card} service={service} canAct={isAdmin} onChanged={load} />)}
      {review.ignored.map((card) => (
        <section key={card.id} className="fl-card dashed">
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 15, fontWeight: 600 }}>AI thinks you can ignore: {card.name}</span>
            <span style={{ fontSize: 14, color: "#3C3C39" }}>{card.summary}</span>
          </div>
          {isAdmin && <button type="button" className="fl-btn" onClick={() => void run(card.id, { kind: "watch" }, setError, load)}>Watch it anyway</button>}
        </section>
      ))}
      {review.allConfirmed
        ? <div className="fl-ok">All confirmed. The business light for {service} now follows these {review.flows.length} flows. When the canvas changes, the AI finds it at the next check-up and asks you again if a flow's boundary changed.</div>
        : <p className="fl-muted" style={{ margin: 0 }}>{left} left to confirm. Until then, the business light for this service stays Unknown.</p>}
    </div>
  );
}

/** Runs one action; a failure goes to the page's error line. */
async function run(flow: string, action: FlowAction, onError: (m: string) => void, reload: () => unknown): Promise<boolean> {
  try { await flows.act(flow, action); onError(""); await reload(); return true; } catch (e) { onError((e as Error).message); return false; }
}

function FlowReviewCard({ card, service, canAct, onChanged }: { card: FlowCard; service: string; canAct: boolean; onChanged: () => unknown }) {
  const [renaming, setRenaming] = useState(false);
  const [telling, setTelling] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [sent, setSent] = useState("");
  const confirmed = card.status === "confirmed";
  const act = (action: FlowAction) => run(card.id, action, setError, onChanged);
  const split = async () => {
    if (!(await ask(`Tell the AI that "${card.name}" is really two flows? It will look at the canvas again and propose a new split.`, { confirm: "Tell the AI" }))) return;
    if (await act({ kind: "split" })) setSent("Sent. The AI will look again at the next check-up.");
  };
  const notRight = async () => {
    if (!note.trim()) return setError("Say what is wrong, so the AI can fix it.");
    if (await act({ kind: "not-right", note: note.trim() })) { setTelling(false); setNote(""); setSent("Sent. Ask AI is open so you can explain more."); openAskAi(); }
  };
  return (
    <section className={`fl-card${confirmed ? " confirmed" : ""}`}>
      <div className="fl-head">
        <div className="fl-title">
          {renaming
            ? <RenameField name={card.name} onCancel={() => setRenaming(false)} onSave={async (name) => { await flowsAct(card.id, { kind: "rename", name }, onChanged); setRenaming(false); }} />
            : <h2><a href={flowHref(card.id, service)} style={{ color: "inherit" }}>{card.name}</a></h2>}
          {card.services.length > 1 && <span className="fl-muted">Spans {card.services.length} services</span>}
        </div>
        {confirmed && <span className="fl-pill big tone-healthy">Confirmed</span>}
      </div>
      <p className="fl-lead" style={{ color: "inherit" }}>{card.summary}</p>
      <FlowGraphView graph={card.graph} />
      <div className="fl-facts">
        <div><span className="k">Entrance</span><span>{card.entries.length ? card.entries.map((e) => e.text).join("、") : "—"}</span></div>
        <div><span className="k">Exits</span><span>{card.exits.length ? card.exits.map((e) => e.text).join("、") : "—"}</span></div>
        <div><span className="k">Process groups</span><span>{groupsText(card.groups)}</span></div>
      </div>
      {card.pending && <div className="fl-risk"><b>To confirm · </b>{card.pending.text}</div>}
      {card.risks.map((r, i) => <div key={i} className="fl-risk"><b>Design risk · </b>{r.text}</div>)}
      {card.reason && <div className="fl-note">{card.reason}</div>}
      <StuckEditor stuck={card.stuck} canEdit={canAct} showSave={false} onSave={async (attentionMinutes, failingMinutes) => { await flowsAct(card.id, { kind: "stuck", attentionMinutes, failingMinutes }, onChanged); }} />
      {error && <p className="fl-error">{error}</p>}
      {sent && <p className="fl-muted" style={{ margin: 0 }}>{sent}</p>}
      {telling && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <label htmlFor={`note-${card.id}`} style={{ fontSize: 14, fontWeight: 600 }}>What is not right?</label>
          <textarea id={`note-${card.id}`} className="fl-input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="比如：Retry 组其实是另一条业务" />
          <div className="fl-actions">
            <button type="button" className="fl-btn primary" onClick={() => void notRight()}>Send to the AI</button>
            <button type="button" className="fl-btn" onClick={() => { setTelling(false); setError(""); }}>Cancel</button>
          </div>
        </div>
      )}
      {canAct && !confirmed && !renaming && !telling && (
        <div className="fl-actions">
          <button type="button" className="fl-btn primary" onClick={() => void act({ kind: "confirm" })}>Looks right</button>
          <button type="button" className="fl-btn" onClick={() => setRenaming(true)}>Rename</button>
          {card.groups.length > 1 && <button type="button" className="fl-btn" onClick={() => void split()}>These are two flows</button>}
          <button type="button" className="fl-btn" onClick={() => { setTelling(true); setSent(""); }}>Not right, tell the AI</button>
        </div>
      )}
      {canAct && confirmed && !renaming && (
        <div className="fl-actions">
          <button type="button" className="fl-btn small" onClick={() => setRenaming(true)}>Rename</button>
        </div>
      )}
    </section>
  );
}

async function flowsAct(flow: string, action: FlowAction, reload: () => unknown) {
  await flows.act(flow, action);
  await reload();
}
