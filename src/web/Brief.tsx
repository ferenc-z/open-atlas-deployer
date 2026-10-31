// Phase 8 on the home page: the daily brief (D25: shown only here, never pushed) and drift (§7.1: shown, never
// changed back).

import { useEffect, useState } from "react";
import * as api from "./api.ts";
import type { BriefView, DriftView } from "./api.ts";

const KIND: Record<string, string> = { version: "Version", fragment: "compose fragment", env: "env file" };
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { hour12: false });

export function DriftBanner() {
  const [drift, setDrift] = useState<DriftView[]>([]);
  useEffect(() => { api.drift().then((r) => setDrift(r.drift), () => setDrift([])); }, []);
  if (!drift.length) return null;
  return (
    <div className="banner warn">
      <strong>Drift found: the server differs from the Deployer's records (nothing is changed back automatically)</strong>
      <ul>{drift.map((d) => <li key={d.key}>{d.app} · {KIND[d.kind] ?? d.kind}: {d.detail} <span className="muted">(since {when(d.firstSeen)})</span></li>)}</ul>
    </div>
  );
}

export function BriefCard({ canRegenerate }: { canRegenerate: boolean }) {
  const [brief, setBrief] = useState<BriefView | null | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = () => api.brief().then((r) => setBrief(r.brief), () => setBrief(null));
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, []);
  if (brief === undefined) return null;
  const regenerate = () => { setBusy(true); setError(""); api.regenerateBrief().then((r) => { setBrief(r.brief); setBusy(false); }, (e: Error) => { setError(e.message); setBusy(false); }); };
  const f = brief?.facts;
  return (
    <section className="card panel brief">
      <div className="toolbar">
        <h2>Today's brief{brief ? ` · ${brief.date}` : ""}</h2>
        {brief?.state === "writing" && <span className="badge info">AI is writing</span>}
        {canRegenerate && <button className="link" onClick={regenerate} disabled={busy}>{busy ? "Generating…" : "Regenerate"}</button>}
      </div>
      {!brief && <p className="muted">Today's brief has not been generated yet.</p>}
      {brief?.text && <pre className="report">{brief.text}</pre>}
      {brief?.message && <p className="muted">{brief.message}</p>}
      {f && !brief?.text && (
        <ul>
          {f.apps.filter((a) => a.newer.length).map((a) => <li key={a.app}>{a.app}: now {a.desired ?? "—"}, newer versions {a.newer.join(", ")}</li>)}
          {f.apps.filter((a) => a.versionsError).map((a) => <li key={`e-${a.app}`} className="muted">{a.app}: cannot read the version list ({a.versionsError}), so newer versions are unknown</li>)}
          {f.promotable.map((p) => <li key={`p-${p.app}`}>{p.app}: UAT has run {p.uat}, here it is {p.here ?? "—"}</li>)}
          {f.drift.map((d) => <li key={`d-${d.app}-${d.kind}`}>Drift · {d.app}: {d.detail}</li>)}
          {f.failed.map((j) => <li key={j.job}>Failed · {j.app} {j.version}: {j.diagnosis ?? j.message ?? j.state}</li>)}
          {f.waiting.map((w) => <li key={`w-${w.job}`}>Waiting for a person · {w.app} {w.version}: {w.step}</li>)}
          {!f.apps.some((a) => a.newer.length || a.versionsError) && !f.promotable.length && !f.drift.length && !f.failed.length && !f.waiting.length && <li className="muted">No newer versions, drift or failed deploys.</li>}
        </ul>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
