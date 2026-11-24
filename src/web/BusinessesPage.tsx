// Screen 1b (prototype Businesses.dc.html, S39): every registered business, whichever services it runs on, under the top
// navigation and not under any service. A light, one sentence, the services it runs on, how many groups and who registered it;
// filters by status, by service and "Only mine"; Register a business; the shared modules at the bottom. Only registered
// businesses are watched. Fixed text is English, the AI's sentences Chinese (C2).

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Light } from "../server/services/ops-types.ts";
import type { BusinessRow, SharedModuleRow } from "./biz-types.ts";
import { biz } from "./biz-data.ts";
import { flowHref, openAskAi, registerHref } from "./flow-routes.ts";
import { LIGHT_LABEL } from "./FlowParts.tsx";
import { usePageFocus } from "./focus.ts";
import { businessFilter, countByLight, groupsLine, sortBusinesses, type StatusFilter } from "./biz-view.ts";
import "./ops.css";

export type Me = { id: string; displayName: string };

export function BusinessesPage({ service, me }: { service?: string; me: Me }) {
  usePageFocus("page", "businesses");
  const [data, setData] = useState<{ businesses: BusinessRow[]; shared: SharedModuleRow[] } | undefined>();
  const [error, setError] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [svc, setSvc] = useState(service ?? "");
  const [mine, setMine] = useState(false);
  useEffect(() => setSvc(service ?? ""), [service]);
  const load = useCallback(() => biz.list().then((d) => { setData(d); setError(""); }, (e: Error) => setError(e.message)), []);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 15_000); return () => clearInterval(t); }, [load]);

  const all = useMemo(() => (data ? sortBusinesses(data.businesses) : []), [data]);
  const services = useMemo(() => [...new Set([...all.flatMap((b) => b.services), ...(svc ? [svc] : [])])].sort(), [all, svc]);
  // The chips count what the service and "Only mine" choose, so a chip never promises rows the filters hide.
  const scoped = useMemo(() => all.filter(businessFilter({ status: "all", service: svc, mine, me })), [all, svc, mine, me]);
  const rows = useMemo(() => scoped.filter(businessFilter({ status, service: "", mine: false, me })), [scoped, status, me]);
  const counts = countByLight(scoped);

  if (!data) return <div className="fl ops ops-wide">{error ? <p className="fl-error">{error}</p> : <p className="fl-muted">Loading…</p>}</div>;
  const chips: [StatusFilter, string][] = [["all", `All ${scoped.length}`], ["failing", `Failing ${counts.failing}`], ["attention", `Attention ${counts.attention}`], ["healthy", `Healthy ${counts.healthy}`], ...(counts.unknown > 0 ? [["unknown", `Unknown ${counts.unknown}`] as [StatusFilter, string]] : [])];
  return (
    <div className="fl ops ops-wide">
      <section className="ov-head">
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <h1 style={{ fontSize: 28 }}>Businesses</h1>
          <p className="ov-counts">
            {all.length === 0 ? <>Nothing registered yet</> : counts.failing + counts.attention + counts.unknown === 0 ? <>All healthy</> : <>
              {counts.failing > 0 && <b className="tone-text-failing">{counts.failing} failing</b>}
              {counts.failing > 0 && counts.attention + counts.unknown + counts.healthy > 0 && "　·　"}
              {counts.attention > 0 && <b className="tone-text-attention">{counts.attention} needs attention</b>}
              {counts.attention > 0 && counts.unknown + counts.healthy > 0 && "　·　"}
              {counts.unknown > 0 && <>{counts.unknown} unknown{counts.healthy > 0 && "　·　"}</>}
              {counts.healthy > 0 && <>{counts.healthy} healthy</>}
            </>}
          </p>
          <p className="fl-muted" style={{ fontSize: 14 }}>Every registered business, whichever services it runs on. Only registered businesses are watched.</p>
        </div>
        <a className="fl-btn primary" href={registerHref()}>Register a business</a>
      </section>
      {error && <p className="fl-error">{error}</p>}

      {all.length > 0 && (
        <section className="bz-filters">
          <div role="group" aria-label="Status" className="bz-chips">
            {chips.map(([k, label]) => <button key={k} type="button" aria-pressed={status === k} className={`bz-chip${status === k ? " on" : ""}`} onClick={() => setStatus(k)}>{label}</button>)}
          </div>
          <div className="fl-row">
            <label htmlFor="bz-svc" className="fl-muted" style={{ fontSize: 14 }}>Service</label>
            <select id="bz-svc" className="fl-input" value={svc} onChange={(e) => setSvc(e.target.value)}>
              <option value="">All services</option>
              {services.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <button type="button" aria-pressed={mine} className={`bz-chip sq${mine ? " on" : ""}`} onClick={() => setMine(!mine)}>Only mine</button>
          </div>
        </section>
      )}

      <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {all.length === 0 && <div className="bz-empty">No business is registered yet. Register one by giving the AI the links of the process groups it uses.</div>}
        {all.length > 0 && rows.length === 0 && <div className="bz-empty">No business matches these filters.</div>}
        {rows.map((b) => (
          <a key={b.id} className={`bz-row edge-${b.light}`} href={flowHref(b.id)}>
            <div className="bz-main">
              <div className="bz-name"><b>{b.name}</b><LightPill light={b.light} /></div>
              <span className="bz-text">{b.sentence}</span>
            </div>
            <div className="bz-meta">
              <span>Runs on <b>{b.services.join(" → ") || "—"}</b></span>
              <span>{groupsLine(b)} · registered by {b.registeredBy}</span>
            </div>
            <span className="bz-open">Open →</span>
          </a>
        ))}
      </section>

      <section className="fl-card">
        <div className="fl-head">
          <h2 style={{ fontSize: 18 }}>Shared modules ({data.shared.length})</h2>
          <button type="button" className="fl-linkbtn" style={{ fontSize: 14 }} title="Opens Ask AI" onClick={openAskAi}>Register a shared module</button>
        </div>
        <p className="fl-muted" style={{ fontSize: 14, margin: 0 }}>A shared module is registered once with its entrances and exits; a business whose groups connect to them is linked automatically. Its health is shown as a whole, not split per business.</p>
        {data.shared.length === 0 && <p className="fl-muted" style={{ margin: 0 }}>No shared modules yet.</p>}
        {data.shared.map((m) => (
          <div key={m.id} className="bz-module">
            <span className="n">{m.name}</span>
            <span className="w">{m.service}</span>
            <span className="p">{m.ports}</span>
            <span className="u">Used by {m.usedBy.length ? m.usedBy.map((u) => u.name).join("、") : "no business yet"}</span>
            <LightPill light={m.light} />
          </div>
        ))}
      </section>
    </div>
  );
}

function LightPill({ light }: { light: Light }) {
  return <span className={`fl-pill tone-${light}`}><span className="ops-dot" />{LIGHT_LABEL[light]}</span>;
}
