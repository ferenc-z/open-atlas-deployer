// Screen 1 (prototype Main.dc.html): the managed services as one card each. Machine light and business light (with the flow
// count) on a line each, one sentence from the AI under each; the bar on the card's top has the worse light's colour; the
// worst service comes first (the server sorts). Above: how many are failing / need attention / wait for the person, when the
// AI last checked, and Check now. Fixed text is English, the AI's sentences Chinese (C2).

import { useCallback, useEffect, useState } from "react";
import { LightBadge } from "./OpsParts.tsx";
import { ops } from "./ops-data.ts";
import { businessLabel, cardLight, clock, nextLine, summaryParts, TRIGGER_TEXT } from "./ops-view.ts";
import type { Light, ServiceCard, ServicesOverview } from "../server/services/ops-types.ts";

export function OverviewPage({ onOpen, onTakeover }: { onOpen: (id: string) => void; onTakeover: () => void }) {
  const [data, setData] = useState<ServicesOverview | undefined>();
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const load = useCallback(() => ops.overview().then((d) => { setData(d); setError(""); }, (e: Error) => setError(e.message)), []);
  const running = data?.running ?? false;
  useEffect(() => { void load(); const t = setInterval(() => void load(), running ? 3_000 : 15_000); return () => clearInterval(t); }, [load, running]);
  const checkNow = async () => {
    setStarting(true);
    try { await ops.checkAll(); setError(""); await load(); } catch (e) { setError((e as Error).message); } finally { setStarting(false); }
  };
  if (!data) return <div className="fl ops ops-wide">{error ? <p className="fl-error">{error}</p> : <p className="fl-muted">Loading…</p>}</div>;
  const { failing, attention, waiting } = summaryParts(data.services);
  const last = data.lastCheckup;
  return (
    <div className="fl ops ops-wide">
      <section className="ov-head">
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <h1 style={{ fontSize: 28 }}>Managed services</h1>
          <p className="ov-counts">
            {failing + attention + waiting === 0
              ? <>All healthy · nothing waiting for you</>
              : <>
                {failing > 0 && <b className="tone-text-failing">{failing} failing</b>}
                {failing > 0 && (attention > 0 || waiting > 0) && "　·　"}
                {attention > 0 && <b className="tone-text-attention">{attention} needs attention</b>}
                {attention > 0 && waiting > 0 && "　·　"}
                {waiting > 0 && <>{waiting} waiting for you</>}
              </>}
          </p>
        </div>
        <div className="ov-check">
          <span>{data.running || last?.state === "running" ? "AI check-up running…" : last ? `AI check-up ${clock(last.at)} · ${TRIGGER_TEXT[last.trigger]}` : "No AI check-up yet"}</span>
          <button type="button" className="fl-btn" disabled={data.running || starting} onClick={() => void checkNow()}>Check now</button>
        </div>
      </section>
      {error && <p className="fl-error">{error}</p>}
      {data.services.length === 0
        ? <section className="fl-card"><p className="fl-muted" style={{ margin: 0 }}>Nothing is registered yet. Discover on the hosts and confirm a takeover draft first.</p><div><button type="button" className="fl-btn primary" onClick={onTakeover}>Open Takeover</button></div></section>
        : <section className="ov-grid">{data.services.map((s) => <Card key={s.id} s={s} onOpen={() => onOpen(s.id)} />)}</section>}
      <p className="fl-muted" style={{ margin: 0 }}>
        Failing first, then needs attention, then healthy. Lights come from rules (every minute); the sentences come from the latest AI analysis.{" "}
        <a href="#" onClick={(e) => { e.preventDefault(); onTakeover(); }}>Take over more…</a>
      </p>
    </div>
  );
}

function Card({ s, onOpen }: { s: ServiceCard; onOpen: () => void }) {
  const next = nextLine(s);
  return (
    <a href="#" className={`ov-card edge-${cardLight(s)}`} onClick={(e) => { e.preventDefault(); onOpen(); }} title={`Open ${s.id}`}>
      <div className="ov-card-head">
        <span className="ov-name">{s.id}</span>
        <span className="fl-muted">{s.environment.toUpperCase()} · {s.label}</span>
      </div>
      <div className="ov-lines">
        <div className="ov-line"><span className="ov-kind">Machine</span><LightBadge light={s.machine.light} /><span className="ov-text">{s.machine.sentence}</span></div>
        <div className="ov-line"><span className="ov-kind">{businessLabel(s)}</span><LightBadge light={s.business.light} /><span className="ov-text">{s.business.sentence}</span></div>
      </div>
      {next && <div className="ov-next"><span>{next}</span><span className="ov-open">Open →</span></div>}
    </a>
  );
}

const TONE: Record<Light, string> = { failing: "bad", attention: "warn", healthy: "ok", unknown: "muted" };
const LIGHT_TEXT: Record<Light, string> = { failing: "Failing", attention: "Needs attention", healthy: "Healthy", unknown: "Unknown" };

/** D53: the platform Overview's right-column Services card, from the same GET /api/services/overview as the page above:
 *  each service's worse light and its to-do count, worst first; the links open the service or the managed-services overview. */
export function ServicesSummaryCard({ onServices, onOpen }: { onServices: () => void; onOpen: (id: string) => void }) {
  const [data, setData] = useState<ServicesOverview | undefined>();
  const load = useCallback(() => ops.overview().then(setData, () => setData(undefined)), []);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 30_000); return () => clearInterval(t); }, [load]);
  if (!data?.services.length) return null;
  const { failing, attention, waiting } = summaryParts(data.services);
  const unknown = data.services.filter((s) => cardLight(s) === "unknown").length;
  const tone = failing ? "bad" : attention ? "warn" : unknown ? "muted" : "ok";
  const todos = data.services.reduce((n, s) => n + s.todoCount, 0);
  return (
    <section className="card">
      <div className="toolbar">
        <h2>Services</h2>
        <span className={`badge ${tone}`}>{failing ? `${failing} failing` : attention ? `${attention} need${attention === 1 ? "s" : ""} attention` : unknown ? `${unknown} unknown` : "Healthy"}</span>
        <span className="muted small">{data.services.length} service{data.services.length === 1 ? "" : "s"} · {todos} to-do{todos === 1 ? "" : "s"}{waiting ? ` · ${waiting} waiting for you` : ""}</span>
        <span className="spacer" />
        <button className="link" onClick={onServices}>All services</button>
      </div>
      <ul className="findings">{data.services.slice(0, 5).map((s) => {
        const light = cardLight(s);
        return (
          <li key={s.id}><span className={`badge ${TONE[light]}`}>{LIGHT_TEXT[light]}</span> <button className="link mono small" onClick={() => onOpen(s.id)}>{s.id}</button>
            {s.todoCount > 0 && <span className="muted small"> · {s.todoCount} to-do{s.todoCount === 1 ? "" : "s"}</span>}</li>
        );
      })}</ul>
    </section>
  );
}
