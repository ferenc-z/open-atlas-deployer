// Phase 8 on the home page: the daily brief (D25: shown only here, never pushed) and drift (§7.1: shown, never
// changed back).

import { useEffect, useState, type ReactNode } from "react";
import * as api from "./api.ts";
import type { BriefView, DriftView } from "./api.ts";
import { Markdown, parseMarkdown, renderBlock } from "./Markdown.tsx";

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
  const [full, setFull] = useState(false);
  const load = () => api.brief().then((r) => setBrief(r.brief), () => setBrief(null));
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, []);
  if (brief === undefined) return null;
  const regenerate = () => { setBusy(true); setError(""); api.regenerateBrief().then((r) => { setBrief(r.brief); setBusy(false); }, (e: Error) => { setError(e.message); setBusy(false); }); };
  const f = brief?.facts;
  // Folded, the brief shows its one-sentence summary and the closing "do this first" line (the prompt asks for both);
  // the sections in between open on demand so the platform and app rows below stay in view.
  const blocks = brief?.text ? parseMarkdown(brief.text) : [];
  const paragraphs = blocks.filter((b) => b.kind === "paragraph");
  const summary = paragraphs[0];
  const first = blocks.length > 1 && blocks[blocks.length - 1]!.kind === "paragraph" && blocks[blocks.length - 1] !== summary ? blocks[blocks.length - 1] : undefined;
  const sections = blocks.filter((b) => b.kind === "heading").length;
  const folded = [summary, first].filter((b) => b !== undefined);
  const facts: { key: string; node: ReactNode; muted?: boolean }[] = f ? [
    ...f.failed.map((j) => ({ key: j.job, node: <>Failed · {j.app} {j.version}: {j.diagnosis ?? j.message ?? j.state}</> })),
    ...f.waiting.map((w) => ({ key: `w-${w.job}`, node: <>Waiting for a person · {w.app} {w.version}: {w.step}</> })),
    ...f.drift.map((d) => ({ key: `d-${d.app}-${d.kind}`, node: <>Drift · {d.app}: {d.detail}</> })),
    ...f.promotable.map((p) => ({ key: `p-${p.app}`, node: <>{p.app}: UAT has run {p.uat}, here it is {p.here ?? "—"}</> })),
    ...f.apps.filter((a) => a.newer.length).map((a) => ({ key: a.app, node: <>{a.app}: now {a.desired ?? "—"}, newer versions {a.newer.join(", ")}</> })),
    ...f.apps.filter((a) => a.versionsError).map((a) => ({ key: `e-${a.app}`, node: <>{a.app}: cannot read the version list ({a.versionsError}), so newer versions are unknown</>, muted: true })),
  ] : [];
  const shownFacts = full ? facts : facts.slice(0, 3);
  const more = brief?.text ? blocks.length > folded.length : facts.length > 3;
  return (
    <section className="card panel brief">
      <div className="toolbar">
        <h2>Today's brief{brief ? ` · ${brief.date}` : ""}</h2>
        {brief?.state === "writing" && <span className="badge info">AI is writing</span>}
        {more && <button className="link" onClick={() => setFull(!full)}>{full ? "Fold" : brief?.text ? `Read the full brief${sections ? ` (${sections} sections)` : ""}` : `Show all ${facts.length}`}</button>}
        {canRegenerate && <button className="link" onClick={regenerate} disabled={busy}>{busy ? "Generating…" : "Regenerate"}</button>}
      </div>
      {!brief && <p className="muted">Today's brief has not been generated yet.</p>}
      {brief?.text && (full || !folded.length ? <Markdown blocks={blocks} /> : (
        <div className="md">
          {summary && renderBlock(summary, 0)}
          {first && <div className="brief-first">{renderBlock(first, 1)}</div>}
        </div>
      ))}
      {brief?.message && <p className="muted">{brief.message}</p>}
      {f && !brief?.text && (
        <ul>
          {shownFacts.map((x) => <li key={x.key} className={x.muted ? "muted" : undefined}>{x.node}</li>)}
          {!facts.length && <li className="muted">No newer versions, drift or failed deploys.</li>}
        </ul>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
