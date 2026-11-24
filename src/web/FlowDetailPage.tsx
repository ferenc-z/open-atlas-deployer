// Screen 4 (prototype Business.dc.html): one flow. The verdict on the left and the diagram on the right; Problems now beside
// Last 7 days; "About this flow" folded (S39: who registered it and when, the shared modules it uses, the registered groups,
// the registration history, Add or remove groups / Rename / Unregister). Deployer does not change the canvas: a problem's fix
// is made in NiFi (Open in NiFi); groups are added and removed by telling Ask AI.

import { useCallback, useEffect, useState } from "react";
import { FlowGraphView } from "./FlowGraphView.tsx";
import { ANOMALY_LABEL, groupsText, LightPill, RenameField, shortDay, shortTime, StuckEditor, UNKNOWN_REASON } from "./FlowParts.tsx";
import type { FlowDetail, Light } from "../server/services/ops-types.ts";
import type { BusinessDetail, RegDraft } from "./biz-types.ts";
import type { ApiError } from "./api.ts";
import { draftChanges, refusalOf } from "./biz-view.ts";
import { Refusal } from "./RegisterPage.tsx";
import { ask } from "./Confirm.tsx";
import { biz } from "./biz-data.ts";
import { businessesHref, openAskAi } from "./flow-routes.ts";
import { flows } from "./flows-data.ts";
import { usePageFocus } from "./focus.ts";
import "./flows.css";

const WORD: Record<Light, string> = { failing: "Failing", attention: "Attention", healthy: "Healthy", unknown: "Unknown" };
const ICON: Record<Light, string> = { failing: "#B3261E", attention: "#C98A1B", healthy: "#1E6B34", unknown: "#4F4F4B" };
const CUE: Record<FlowDetail["findBy"][number]["cue"], string> = { fileName: "File name", emailFrom: "Email sender", emailSubject: "Email subject" };

function LightIcon({ light }: { light: Light }) {
  const c = ICON[light];
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      {light === "failing" && <path d="M15 9l-6 6M9 9l6 6" />}
      {light === "attention" && <path d="M12 7v6M12 16.5v.5" />}
      {light === "healthy" && <path d="M8 12.5l3 3 5-6" />}
      {light === "unknown" && <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17v.5" />}
    </svg>
  );
}

export function FlowDetailPage({ flow, service, isAdmin, onBack, onOpenService }: { flow: string; service?: string; isAdmin: boolean; onBack: () => void; onOpenService: (service: string) => void }) {
  usePageFocus("flow", flow);
  usePageFocus("service", service);
  const [d, setD] = useState<BusinessDetail | undefined>();
  const [error, setError] = useState("");
  const [about, setAbout] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const load = useCallback(() => flows.detail(flow, service).then((v) => { setD(v); setError(""); }, (e: Error) => setError(e.message)), [flow, service]);
  useEffect(() => { setD(undefined); void load(); }, [load]);
  // The drafts the assistant made to change this business (7.9): read every few seconds, so a draft made in the Ask AI drawer shows up here.
  const [drafts, setDrafts] = useState<RegDraft[]>([]);
  const [refusal, setRefusal] = useState<{ draft: string; r: ReturnType<typeof refusalOf>; empty: boolean } | undefined>();
  const [confirmed, setConfirmed] = useState("");
  const [working, setWorking] = useState(false);
  const loadDrafts = useCallback(() => biz.draftsOf(flow).then((r) => setDrafts(r.drafts), () => undefined), [flow]);
  useEffect(() => { void loadDrafts(); const t = setInterval(() => void loadDrafts(), 3000); return () => clearInterval(t); }, [loadDrafts]);
  if (!d) return <div className="fl wide">{error ? <p className="fl-error">{error}</p> : <p className="fl-muted">Loading…</p>}</div>;
  const f = d.flow;
  const reg = d.registration;
  const lead = d.problems[0];
  const confirmChanges = async (draft: RegDraft) => {
    setWorking(true); setRefusal(undefined); setError(""); setConfirmed("");
    try {
      const r = await biz.commit(draft.draft);
      setConfirmed(`Changes confirmed: ${r.name} now has ${r.preview.groups.length} ${r.preview.groups.length === 1 ? "group" : "groups"}.`);
      await Promise.all([load(), loadDrafts()]);
    } catch (e) {
      const x = e as ApiError;
      setRefusal({ draft: draft.draft, r: refusalOf({ ...(x.code ? { code: x.code } : {}), message: x.message, body: x.body }, "Confirm changes"), empty: x.code === "register/empty" });
    } finally { setWorking(false); }
  };
  const discard = async (draft: RegDraft) => {
    if (!(await ask("Discard these changes? The business stays as it is registered now.", { confirm: "Discard", danger: true }))) return;
    try { await biz.discardDraft(draft.draft); setRefusal(undefined); await loadDrafts(); } catch (e) { setError((e as Error).message); }
  };
  const unregister = async () => {
    if (!(await ask(`Unregister “${f.name}”? Deployer stops watching it and its problems close. NiFi is not touched. Its registration history is deleted with it.`, { confirm: "Unregister", danger: true }))) return;
    try { await biz.unregister(f.id); onBack(); } catch (e) { setError((e as Error).message); }
  };
  // The registration history: the server's merged rows (7.7 item 8); an older server only has the model history.
  const changes = reg?.changes ?? d.history.map((h) => ({ at: h.at, by: h.by === "ai" ? "AI" : "You", text: h.text + (h.verdict && h.verdict !== "published" ? ` (${h.verdict})` : "") }));
  const groups = reg?.groups ?? f.groups.map((g) => ({ service: g.service, id: g.id, name: g.name, how: "", nifiUrl: null as string | null }));
  const border = d.light === "unknown" ? "" : d.light;
  const stateWord = d.light === "unknown" && d.reason ? UNKNOWN_REASON[d.reason] : lead ? ANOMALY_LABEL[lead.anomaly] : null;
  return (
    <div className="fl wide">
      <div className="fl-row" style={{ gap: "6px 14px" }}>
        <a href={businessesHref()} onClick={(e) => { e.preventDefault(); onBack(); }}>← All businesses</a>
        {f.services.length > 0 && <span className="fl-muted" style={{ fontSize: 14 }}>runs on</span>}
        {f.services.map((s) => <a key={s} href="#" onClick={(e) => { e.preventDefault(); onOpenService(s); }}>{s}</a>)}
      </div>
      {error && <p className="fl-error">{error}</p>}
      {confirmed && <p role="status" style={{ margin: 0, color: "#1E6B34", fontWeight: 600 }}>{confirmed}</p>}
      {reg && drafts.map((dr) => {
        const changes = draftChanges(dr, { name: f.name, reg });
        const mine = refusal?.draft === dr.draft ? refusal : undefined;
        return (
          <section key={dr.draft} className="fl-card bz-draft" aria-label="Changes waiting for you">
            <h3 style={{ margin: 0 }}>Changes waiting for you</h3>
            <span className="fl-muted" style={{ fontSize: 14 }}>The assistant prepared these from your conversation. Nothing changes until you confirm.</span>
            {changes.length === 0 ? <span>The draft is the same as the registered business.</span> : <ul style={{ margin: 0, paddingLeft: 18 }}>{changes.map((c, i) => <li key={i}>{c}</li>)}</ul>}
            <div className="fl-row" style={{ gap: 10 }}>
              <button type="button" className="fl-btn primary" disabled={working || changes.length === 0} onClick={() => void confirmChanges(dr)}>{working ? "Confirming…" : "Confirm changes"}</button>
              <button type="button" className="fl-btn" disabled={working} onClick={() => void discard(dr)}>Discard</button>
            </div>
            {mine && (mine.empty
              ? <div className="rg-problem" role="alert"><b>Not confirmed</b><span>These changes take away every group. To stop watching this business, unregister it instead.</span><div className="fl-row"><button type="button" className="fl-btn small" style={{ borderColor: "#E8B4AE", color: "#B3261E" }} onClick={() => void unregister()}>Unregister…</button></div></div>
              : <Refusal r={mine.r} />)}
          </section>
        );
      })}

      <section className={`fl-top ${border}`}>
        <div className="left">
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 12 }}>
            <h1>{f.name}</h1>
            {f.services.length > 1 && <span className="fl-muted" style={{ fontSize: 14 }}>Spans {f.services.length} services · {f.services.join(" → ")}</span>}
          </div>
          <div className="fl-light">
            <LightIcon light={d.light} />
            <span className={`word ${d.light}`}>{WORD[d.light]}</span>
            {stateWord && <LightPill light={d.light} text={stateWord} />}
          </div>
          <p className="fl-sentence">{d.sentence}</p>
        </div>
        <div className="right">
          <span className="fl-muted" style={{ fontWeight: 600 }}>How the data flows</span>
          <FlowGraphView graph={f.graph} />
          <span className="fl-muted" style={{ fontSize: 12 }}>Scroll sideways to see the whole flow · shaded = a service · box = a process group · dashed = outside NiFi · red dashed = where data is lost · purple dashed = a handoff you described (NiFi can't see it)</span>
        </div>
      </section>

      <div className="fl-cols">
        <section className="main">
          <h3>Problems now ({d.problems.length})</h3>
          {d.problems.length === 0 && <div className="fl-problem"><span style={{ fontSize: 15 }}>No problems right now.</span></div>}
          {d.problems.map((p, i) => (
            <div key={i} className="fl-problem">
              <div className="fl-row" style={{ gap: 10 }}>
                <LightPill light={p.light} text={ANOMALY_LABEL[p.anomaly]} />
                <span style={{ fontSize: 16, fontWeight: 600 }}>{p.title}</span>
                <span className="fl-muted">{p.count} {p.count === 1 ? "occurrence" : "occurrences"} · {p.service} · {p.group} · since {shortTime(p.since)}, latest {shortTime(p.latest)}</span>
              </div>
              {p.cause && <p><b>Cause · </b>{p.cause}</p>}
              {p.advice.length > 0 && (
                <div className="fl-advice">
                  <span style={{ fontWeight: 600 }}>AI advice</span>
                  {p.advice.map((a, n) => <span key={n}>{n + 1}. {a}</span>)}
                </div>
              )}
              {p.nifiUrl && (
                <div className="fl-row" style={{ gap: 10 }}>
                  <a className="fl-btn primary" href={p.nifiUrl} target="_blank" rel="noopener noreferrer">Open in NiFi</a>
                  <span className="fl-muted">Deployer does not change the canvas; make this change in NiFi.</span>
                </div>
              )}
            </div>
          ))}
        </section>
        <section className="fl-card side">
          <h3>Last 7 days</h3>
          {d.last7Days.map((h, i) => (
            <div key={i} className="fl-day">
              <span className="fl-muted" style={{ flex: "0 0 auto" }}>{shortDay(h.day)}</span>
              {h.anomaly === "other-drop" ? <span className="fl-pill tone-neutral">{ANOMALY_LABEL[h.anomaly]}</span> : <LightPill light={h.light} text={ANOMALY_LABEL[h.anomaly]} />}
              <span className="text">{h.text}</span>
            </div>
          ))}
          <span className="fl-muted">{d.last7Days.length === 0 ? "No problems in the last 7 days." : "No problems on the other days."}</span>
        </section>
      </div>

      <section className="fl-card fl-about">
        <button type="button" aria-expanded={about} onClick={() => setAbout(!about)}>
          <span className="t">About this flow</span><span className="s">{about ? "Hide" : "Show"}</span>
        </button>
        {about && (
          <div className="body">
            <div className="fl-facts">
              <div><span className="k">Entrance</span><span>{f.entries.length ? f.entries.map((e) => e.text).join("、") : "—"}</span></div>
              <div><span className="k">Exits</span><span>{f.exits.length ? f.exits.map((e) => e.text).join("、") : "—"}</span></div>
              <div>
                <span className="k">Find a file by</span>
                {d.findBy.length === 0 ? <span>—</span> : d.findBy.map((c, i) => (
                  <button key={i} type="button" className="fl-linkbtn" title="Opens Ask AI" onClick={openAskAi}>{CUE[c.cue]} (attribute {c.attribute})</button>
                ))}
              </div>
              {reg && <div><span className="k">Registered</span><span>{reg.by} · {shortTime(reg.at)} · no approval needed</span></div>}
              {reg && <div><span className="k">Shared modules</span><span>{reg.shared.length ? reg.shared.map((m) => m.name).join("、") : "None"}</span></div>}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>Registered process groups ({groups.length})</span>
              {groups.map((g) => (
                <div key={`${g.service}:${g.id}`} className="bz-group">
                  <span style={{ fontWeight: 600 }}>{g.name}</span>
                  <span className="fl-muted" style={{ fontSize: 14 }}>{g.service}</span>
                  <span className="how">{g.how}</span>
                  {g.nifiUrl && <a href={g.nifiUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13 }}>Open in NiFi</a>}
                </div>
              ))}
              <span className="fl-muted">Add and remove groups by telling Ask AI, for example "add Invoice_Archive on n112" (pasting its link works too).</span>
            </div>
            <StuckEditor stuck={f.stuck} canEdit={isAdmin} showSave onSave={async (attentionMinutes, failingMinutes) => { await flows.act(f.id, { kind: "stuck", attentionMinutes, failingMinutes }); await load(); }} />
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>Design risks ({f.risks.length})</span>
              {f.risks.length === 0 && <span className="fl-muted">None found.</span>}
              {f.risks.map((r, i) => <div key={i} className="fl-risk">{r.text}</div>)}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>Registration history</span>
              {changes.length === 0 && <span className="fl-muted">Nothing recorded yet.</span>}
              {changes.map((h, i) => (
                <span key={i} style={{ fontSize: 14, color: "#3C3C39" }}>{shortTime(h.at)} · {h.by} · {h.text}{"quote" in h && h.quote ? ` · “${h.quote}”` : ""}</span>
              ))}
            </div>
            {renaming
              ? <RenameField name={f.name} onCancel={() => setRenaming(false)} onSave={async (name) => { await biz.rename(f.id, name); setRenaming(false); await load(); }} />
              : (
                <div className="fl-actions">
                  <button type="button" className="fl-btn small" title="Opens Ask AI" onClick={openAskAi}>Add or remove groups</button>
                  <button type="button" className="fl-btn small" onClick={() => setRenaming(true)}>Rename</button>
                  <button type="button" className="fl-btn small" style={{ borderColor: "#E8B4AE", color: "#B3261E" }} onClick={() => void unregister()}>Unregister</button>
                </div>
              )}
          </div>
        )}
      </section>
    </div>
  );
}
