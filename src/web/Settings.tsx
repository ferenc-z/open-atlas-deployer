// D38: the environment settings (hosts, domain, registries, each app's version, host, ingress, overrides), kept as
// revisions in the state database. An administrator edits the whole JSON, checks it (findings and the diff), and saves
// it on the revision it was read at; nothing is deployed by saving. environment.json was only the first revision.

import { useCallback, useEffect, useState } from "react";
import * as api from "./api.ts";
import type { EnvironmentCheck, EnvironmentView } from "./api.ts";

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { hour12: false });

export function SettingsPage() {
  const [data, setData] = useState<EnvironmentView | undefined>();
  const [text, setText] = useState("");
  const [editing, setEditing] = useState(false);
  const [check, setCheck] = useState<EnvironmentCheck | undefined>();
  const [note, setNote] = useState("");
  const [error, setError] = useState<{ message: string; details: string[] } | undefined>();
  const load = useCallback((revision?: number) => {
    api.environmentSettings(revision).then((d) => { setData(d); setText(JSON.stringify(d.environment, null, 2)); setCheck(undefined); setEditing(false); setError(undefined); },
      (e: api.ApiError) => setError({ message: e.message, details: e.details }));
  }, []);
  useEffect(() => load(), [load]);
  if (!data) return error ? <p className="error">{error.message}</p> : <p className="muted">Loading…</p>;

  const parsed = (): unknown => { try { return JSON.parse(text); } catch (e) { setError({ message: `Not valid JSON: ${(e as Error).message}`, details: [] }); return undefined; } };
  const validate = () => { setError(undefined); const v = parsed(); if (v !== undefined) api.checkEnvironment(data.revision, v).then(setCheck, (e: api.ApiError) => setError({ message: e.message, details: e.details })); };
  const save = () => {
    setError(undefined);
    const v = parsed();
    if (v !== undefined) api.saveEnvironment(data.revision, v, note || undefined).then(() => { setNote(""); load(); }, (e: api.ApiError) => setError({ message: e.message, details: e.details }));
  };
  const old = data.revision !== data.latest;
  return (
    <>
      <div className="toolbar">
        <h1>Environment settings</h1>
        <span className="muted">Hosts, domain, registries and each app's version, host and ingress for {String(data.environment.name ?? "").toUpperCase()}. Saved as revisions; a change takes effect at the next deploy.</span>
        <a className="button" href={api.environmentExportUrl(data.revision)}>Export revision {data.revision}</a>
      </div>
      {data.fileDiffers && !old && <p className="banner warn">{data.file} differs from revision {data.latest}. The Deployer read that file once, on its first start, and does not read it again: make changes here.</p>}
      <section className="card panel">
        <div className="toolbar">
          <h2>{old ? `Revision ${data.revision} (the newest is ${data.latest})` : `Revision ${data.revision}`}</h2>
          <span className="muted">{data.source === "import" ? "Imported" : "Saved"} by {data.savedBy} at {when(data.savedAt)}{data.note ? `: ${data.note}` : ""}</span>
          {old && <button className="link" onClick={() => load()}>Back to the newest</button>}
          {data.canSave && !old && !editing && <button onClick={() => setEditing(true)}>Edit</button>}
        </div>
        <textarea className="mono settings" spellCheck={false} rows={24} readOnly={!editing} value={text} onChange={(e) => { setText(e.target.value); setCheck(undefined); }} />
        {editing && (
          <div className="row">
            <button onClick={validate}>Check</button>
            <input placeholder="Why (kept with the revision)" value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: 1 }} />
            <button className="primary" onClick={save}>Save as revision {data.latest + 1}</button>
            <button onClick={() => load()}>Cancel</button>
          </div>
        )}
        {check && (
          <div className="plan">
            {check.findings.length ? <ul className="findings">{check.findings.map((f) => <li key={f.at + f.expected} className="error">✕ {f.at}: {f.expected}</li>)}</ul> : <p className="small">No findings.</p>}
            <p className="small">Changes: <span className="mono">{check.changes.join(", ") || "none"}</span></p>
            {check.diff && <pre className="diff">{check.diff.split("\n").map((l, i) => <span key={i} className={l.startsWith("+ ") ? "add" : l.startsWith("- ") ? "del" : ""}>{l}{"\n"}</span>)}</pre>}
          </div>
        )}
        {error && <div className="error">{error.message}{error.details.length > 0 && <ul>{error.details.map((d) => <li key={d}>{d}</li>)}</ul>}</div>}
      </section>
      <h3>Revisions</h3>
      <table>
        <thead><tr><th>Revision</th><th>Saved</th><th>Who</th><th>Changed</th><th>Note</th><th></th></tr></thead>
        <tbody>
          {data.revisions.map((r) => (
            <tr key={r.revision} className={r.revision === data.revision ? "current" : ""}>
              <td>{r.revision}{r.revision === data.latest && <span className="badge info">Newest</span>}</td>
              <td className="muted">{when(r.savedAt)}</td>
              <td>{r.savedBy}<span className="muted"> {r.via}</span></td>
              <td className="mono small">{r.changes.join(", ")}</td>
              <td className="muted">{r.note ?? ""}</td>
              <td className="actions">{r.revision !== data.revision && <button className="link" onClick={() => load(r.revision)}>View</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
