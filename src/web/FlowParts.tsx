// Pieces the two flow pages share: the stuck-times editor, the inline rename field, the light badge and the wording.

import { useId, useState } from "react";
import type { Anomaly, FlowCard, Light, UnknownReason } from "../server/services/ops-types.ts";
import "./flows.css";

export const LIGHT_LABEL: Record<Light, string> = { failing: "Failing", attention: "Attention", healthy: "Healthy", unknown: "Unknown" };
export const UNKNOWN_REASON: Record<UnknownReason, string> = { unconfirmed: "Not confirmed yet", "gate-rejected": "Model rejected", "no-evidence": "No data yet", collection: "Collection gap" };
export const ANOMALY_LABEL: Record<Anomaly, string> = {
  "processing-failed": "Processing failed", "invalid-data": "Invalid data", stuck: "Stuck", "handover-lost": "Handover lost",
  "processor-error": "Processor error", "data-dropped": "Data dropped", "e2e-failed": "End-to-end check failed",
};

/** A past anomaly's colour (ops-types.ts Anomaly: handover-lost and data-dropped are failing, the rest attention; a stuck one may have been either, the history does not say). */
export const anomalyLight = (a: Anomaly): Light => (a === "handover-lost" || a === "data-dropped" ? "failing" : "attention");

export const LightPill = ({ light, text }: { light: Light; text?: string }) => <span className={`fl-pill tone-${light}`}>{text ?? LIGHT_LABEL[light]}</span>;

const pad = (n: number) => String(n).padStart(2, "0");
/** "11-19 08:10" from an ISO-like time (shown in the browser's zone). */
export function shortTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export const shortDay = (day: string) => (/^\d{4}-\d{2}-\d{2}/.test(day) ? day.slice(5, 10) : day);

/** "n192 · Customs_Receipt、Customs_Receipt_Retry → c250 · Customs_Publish": the groups, runs of one service together. */
export function groupsText(groups: FlowCard["groups"]): string {
  const runs: { service: string; names: string[] }[] = [];
  for (const g of groups) {
    const last = runs[runs.length - 1];
    if (last && last.service === g.service) last.names.push(g.name); else runs.push({ service: g.service, names: [g.name] });
  }
  return runs.map((r) => `${r.service.split("-")[0]} · ${r.names.join("、")}`).join(" → ");
}

export function StuckEditor({ stuck, canEdit, onSave, showSave }: { stuck: FlowCard["stuck"]; canEdit: boolean; onSave: (attention: number, failing: number) => Promise<void>; showSave: boolean }) {
  const [a, setA] = useState(String(stuck.attentionMinutes));
  const [f, setF] = useState(String(stuck.failingMinutes));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const na = Number(a), nf = Number(f);
  const valid = Number.isInteger(na) && Number.isInteger(nf) && na > 0 && nf > 0;
  const dirty = na !== stuck.attentionMinutes || nf !== stuck.failingMinutes;
  const save = async () => {
    if (!valid || na >= nf) return setError("Attention must come before failing, and both must be whole minutes.");
    setBusy(true); setError("");
    try { await onSave(na, nf); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const id = useId();
  return (
    <div className="fl-stuck">
      <span style={{ fontSize: 14, fontWeight: 600 }}>When is data stuck?</span>
      <div className="fl-row">
        <label htmlFor={`${id}-a`}>Attention after</label>
        <input id={`${id}-a`} className="fl-input num" inputMode="numeric" value={a} disabled={!canEdit} onChange={(e) => setA(e.target.value)} />
        <span>min,</span>
        <label htmlFor={`${id}-f`}>failing after</label>
        <input id={`${id}-f`} className="fl-input num" inputMode="numeric" value={f} disabled={!canEdit} onChange={(e) => setF(e.target.value)} />
        <span>min</span>
        {canEdit && (showSave || dirty) && <button type="button" className="fl-btn small" disabled={busy || !dirty} onClick={() => void save()}>Save</button>}
      </div>
      {error && <span className="fl-error">{error}</span>}
      <span className="fl-muted">{stuck.by === "person" ? "Set by you. " : ""}AI suggests: {stuck.basis}</span>
    </div>
  );
}

export function RenameField({ name, onSave, onCancel }: { name: string; onSave: (name: string) => Promise<void>; onCancel: () => void }) {
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    const v = value.trim();
    if (!v) return setError("The name cannot be empty.");
    setBusy(true); setError("");
    try { await onSave(v); } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return (
    <div className="fl-rename" style={{ flexWrap: "wrap" }}>
      <label htmlFor="flow-name" style={{ position: "absolute", left: -9999 }}>New name</label>
      <input id="flow-name" className="fl-input" value={value} autoFocus onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") onCancel(); }} />
      <button type="button" className="fl-btn primary" style={{ padding: "0 16px" }} disabled={busy} onClick={() => void save()}>Save</button>
      <button type="button" className="fl-btn" onClick={onCancel}>Cancel</button>
      {error && <span className="fl-error" style={{ flex: "1 1 100%" }}>{error}</span>}
    </div>
  );
}
