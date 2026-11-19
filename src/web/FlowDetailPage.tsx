// Screen 4 (prototype Business.dc.html): one flow. The verdict on the left and the diagram on the right; Problems now beside
// Last 7 days; "About this flow" folded. Deployer does not change the canvas: a problem's fix is made in NiFi (Open in NiFi).

import { useCallback, useEffect, useState } from "react";
import { FlowGraphView } from "./FlowGraphView.tsx";
import { ANOMALY_LABEL, groupsText, LightPill, RenameField, shortDay, shortTime, StuckEditor, UNKNOWN_REASON } from "./FlowParts.tsx";
import type { FlowDetail, Light } from "../server/services/ops-types.ts";
import { flowHref, openAskAi } from "./flow-routes.ts";
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

export function FlowDetailPage({ flow, service, isAdmin, onBack, onOpenFlow }: { flow: string; service?: string; isAdmin: boolean; onBack: (service: string) => void; onOpenFlow: (flow: string, service: string) => void }) {
  usePageFocus("flow", flow);
  usePageFocus("service", service);
  const [d, setD] = useState<FlowDetail | undefined>();
  const [error, setError] = useState("");
  const [about, setAbout] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const load = useCallback(() => flows.detail(flow, service).then((v) => { setD(v); setError(""); }, (e: Error) => setError(e.message)), [flow, service]);
  useEffect(() => { setD(undefined); void load(); }, [load]);
  if (!d) return <div className="fl wide">{error ? <p className="fl-error">{error}</p> : <p className="fl-muted">Loading…</p>}</div>;
  const f = d.flow;
  const home = service ?? f.services[0] ?? "";
  const others = f.services.filter((s) => s !== home);
  const lead = d.problems[0];
  const border = d.light === "unknown" ? "" : d.light;
  const stateWord = d.light === "unknown" && d.reason ? UNKNOWN_REASON[d.reason] : lead ? ANOMALY_LABEL[lead.anomaly] : null;
  return (
    <div className="fl wide">
      <div className="fl-row" style={{ gap: "6px 14px" }}>
        <a href="#" onClick={(e) => { e.preventDefault(); onBack(home); }}>← {home}</a>
        {others.length > 0 && <span className="fl-muted" style={{ fontSize: 14 }}>also on</span>}
        {others.map((s) => <a key={s} href={flowHref(f.id, s)} onClick={(e) => { e.preventDefault(); onOpenFlow(f.id, s); }}>{s}</a>)}
      </div>
      {error && <p className="fl-error">{error}</p>}

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
          <span className="fl-muted" style={{ fontSize: 12 }}>Scroll sideways to see the whole flow · shaded = a service · box = a process group · dashed = outside NiFi · red dashed = where data is lost</span>
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
              <LightPill light={h.light} text={ANOMALY_LABEL[h.anomaly]} />
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
              <div><span className="k">Process groups</span><span>{groupsText(f.groups)}</span></div>
              <div>
                <span className="k">Find a file by</span>
                {d.findBy.length === 0 ? <span>—</span> : d.findBy.map((c, i) => (
                  <button key={i} type="button" className="fl-linkbtn" title="Opens Ask AI" onClick={openAskAi}>{CUE[c.cue]} (attribute {c.attribute})</button>
                ))}
              </div>
            </div>
            <StuckEditor stuck={f.stuck} canEdit={isAdmin} showSave onSave={async (attentionMinutes, failingMinutes) => { await flows.act(f.id, { kind: "stuck", attentionMinutes, failingMinutes }); await load(); }} />
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>Design risks ({f.risks.length})</span>
              {f.risks.length === 0 && <span className="fl-muted">None found.</span>}
              {f.risks.map((r, i) => <div key={i} className="fl-risk">{r.text}</div>)}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>Model history</span>
              {d.history.map((h, i) => (
                <span key={i} style={{ fontSize: 14, color: "#3C3C39" }}>{shortDay(h.at.slice(0, 10))} · {h.by === "ai" ? "AI" : "You"} · {h.text}{h.verdict && h.verdict !== "published" ? ` (${h.verdict})` : ""}</span>
              ))}
            </div>
            {isAdmin && (renaming
              ? <RenameField name={f.name} onCancel={() => setRenaming(false)} onSave={async (name) => { await flows.act(f.id, { kind: "rename", name }); setRenaming(false); await load(); }} />
              : <div><button type="button" className="fl-btn small" onClick={() => setRenaming(true)}>Rename</button></div>)}
          </div>
        )}
      </section>
    </div>
  );
}
