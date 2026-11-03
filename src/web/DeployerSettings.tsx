// D45: the Deployer's own settings, beside the apps' environment variables. What deployer.env sets wins and is only
// shown; the rest can be set here, one row at a time. The Deployer is wired when it starts, so a saved change waits
// for the next start, which this page can trigger (and then waits for the Deployer to answer again).

import { useCallback, useEffect, useState } from "react";
import * as api from "./api.ts";
import type { DeployerSettingsView, SettingRow } from "./api.ts";
import { ask } from "./Confirm.tsx";

const SOURCE: Record<string, string> = { file: "deployer.env", page: "This page", default: "Default" };
const MASK = "••••••••";

type Fail = { message: string; details: string[] };
const toFail = (e: api.ApiError): Fail => ({ message: e.message, details: e.details ?? [] });

function Failure({ error }: { error: Fail | undefined }) {
  if (!error) return null;
  return <div className="error">{error.message}{error.details.length > 0 && <ul>{error.details.map((d) => <li key={d}>{d}</li>)}</ul>}</div>;
}

/** A summary for the Deployer's card on the Environment variables page. */
export function deployerCardState(v: DeployerSettingsView): { label: string; tone: string } {
  return v.pending ? { label: "Restart to apply", tone: "warn" } : { label: "In effect", tone: "ok" };
}

export function DeployerSettingsPanel({ onChanged }: { onChanged: (v: DeployerSettingsView) => void }) {
  const [data, setData] = useState<DeployerSettingsView | undefined>();
  const [error, setError] = useState<Fail | undefined>();
  const [restarting, setRestarting] = useState(false);
  const show = useCallback((v: DeployerSettingsView) => { setData(v); onChanged(v); }, [onChanged]);
  const load = useCallback(() => api.deployerSettings().then(show, (e: api.ApiError) => setError(toFail(e))), [show]);
  useEffect(() => { load(); }, [load]);
  if (!data) return error ? <Failure error={error} /> : <p className="muted">Loading…</p>;

  const restart = async () => {
    const keys = data.settings.filter((r) => r.pending).map((r) => r.key);
    if (!(await ask(`Restart the Deployer to apply ${keys.join(", ")}? The page is unavailable for a few seconds; it is refused while a job is running.`, { confirm: "Restart the Deployer" }))) return;
    setError(undefined);
    try { await api.restartDeployer(); } catch (e) { setError(toFail(e as api.ApiError)); return; }
    setRestarting(true);
    const before = data.startedAt;
    const until = Date.now() + 90_000;
    const poll = () => api.deployerSettings().then((v) => {
      if (v.startedAt !== before) { setRestarting(false); show(v); return; }
      if (Date.now() < until) setTimeout(poll, 2_000); else { setRestarting(false); setError({ message: "The Deployer has not restarted yet. Check its container on the host (docker compose ps in its directory).", details: [] }); }
    }, () => { if (Date.now() < until) setTimeout(poll, 2_000); else { setRestarting(false); setError({ message: "The Deployer is not answering after 90 seconds. Check its container on the host (docker compose ps, docker compose logs deployer).", details: [] }); } });
    setTimeout(poll, 2_000);
  };

  const groups = [...new Set(data.settings.map((r) => r.group))];
  return (
    <section className="card panel">
      <div className="toolbar">
        <h2>Deployer</h2>
        <span className="muted">The Deployer's own settings. What deployer.env sets wins and is shown here only; the rest can be set here. Tokens are kept sealed and never shown again.</span>
      </div>
      {restarting ? <p className="banner info inline">Restarting the Deployer… this page carries on when it answers again.</p>
        : data.pending && (
          <div className="banner warn inline row">
            <span style={{ flex: 1 }}>Saved changes are not in effect yet: the Deployer reads its settings when it starts.</span>
            {data.canRestart ? <button className="primary" onClick={restart}>Restart the Deployer</button>
              : <span className="muted">This Deployer does not run from its image: restart it where it runs.</span>}
          </div>
        )}
      <Failure error={error} />
      <table className="edit env-values deployer-settings">
        <thead><tr><th>Setting</th><th>In effect</th><th>From</th><th></th></tr></thead>
        {groups.map((g) => (
          <tbody key={g}>
            <tr className="group-row"><td colSpan={4}>{g}</td></tr>
            {g === "Workbench" && <WorkbenchKeyRow data={data} onSaved={load} />}
            {data.settings.filter((r) => r.group === g).map((r) => <SettingLine key={r.key} row={r} onSaved={show} />)}
          </tbody>
        ))}
      </table>
    </section>
  );
}

function Value({ row }: { row: SettingRow }) {
  const secret = row.kind === "secret" || "set" in row;
  if (row.kind === "secret" && row.source === "file") return <span><span className={`badge ${row.set ? "ok" : "bad"}`}>{row.set ? "Set" : "File empty or unreadable"}</span> <span className="mono small muted">{row.value}</span></span>;
  if (secret) return row.set ? <span className="mono">{MASK}</span> : <span className="muted">Not set</span>;
  return row.value !== undefined && row.value !== "" ? <span className="mono">{row.value}</span> : <span className="muted">Not set</span>;
}

function SettingLine({ row, onSaved }: { row: SettingRow; onSaved: (v: DeployerSettingsView) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<Fail | undefined>();
  const secret = row.kind === "secret";
  const save = (value: string | null) => {
    setError(undefined);
    api.saveDeployerSettings([{ key: row.key, value }]).then((v) => { setEditing(false); onSaved(v); }, (e: api.ApiError) => setError(toFail(e)));
  };
  const remove = async () => {
    if (await ask(`Remove the value of ${row.key} set on this page?${row.kind === "secret" ? "" : " The default applies (or nothing) at the next start."}`, { confirm: "Remove", danger: true })) save(null);
  };
  const begin = () => { setText(secret ? "" : row.pending?.value ?? (row.source === "page" ? row.value ?? "" : "")); setError(undefined); setEditing(true); };
  return (
    <tr>
      <td><span className="mono">{row.key}</span><br /><span className="small muted">{row.help}</span></td>
      <td>
        {editing ? (
          <div className="row">
            <input className="mono" type={secret ? "password" : "text"} autoComplete="off" spellCheck={false} placeholder={secret ? "Paste the token" : row.kind === "ids" ? "id1, id2" : ""} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && text.trim()) save(text); if (e.key === "Escape") setEditing(false); }} style={{ flex: 1 }} autoFocus />
            <button className="primary" disabled={!text.trim()} onClick={() => save(text)}>Save</button>
            <button onClick={() => setEditing(false)}>Cancel</button>
          </div>
        ) : <Value row={row} />}
        {row.pending && !editing && (
          <div className="small"><span className="badge warn">At the next start</span> {row.pending.cleared ? "removed" : row.pending.set ? <span className="mono">{MASK}</span> : <span className="mono">{row.pending.value}</span>}</div>
        )}
        <Failure error={error} />
      </td>
      <td className="muted small">{row.source ? SOURCE[row.source] : "—"}{row.updatedBy && row.source !== "file" ? <><br />by {row.updatedBy}</> : null}</td>
      <td className="actions">
        {row.locked ? <span className="small muted" title={row.locked}>{row.kind === "fixed" ? "deployer.env only" : "In deployer.env"}</span> : !editing && (
          <>
            <button className="link" onClick={begin}>{row.source === "page" || row.pending ? "Change" : "Set"}</button>
            {(row.source === "page" || (row.pending && !row.pending.cleared)) && <button className="link" onClick={remove}>Remove</button>}
          </>
        )}
      </td>
    </tr>
  );
}

/** The Workbench API key has its own place (§15.6 ③): checked against Workbench and in effect at once. */
function WorkbenchKeyRow({ data, onSaved }: { data: DeployerSettingsView; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<Fail | undefined>();
  const k = data.workbenchKey;
  const save = () => { setError(undefined); api.setWorkbenchKey(text.trim()).then(() => { setEditing(false); setText(""); onSaved(); }, (e: api.ApiError) => setError(toFail(e))); };
  return (
    <tr>
      <td><span className="mono">Workbench API key</span><br /><span className="small muted">From Workbench Administration → API keys; checked against Workbench and in effect at once.</span></td>
      <td>
        {editing ? (
          <div className="row">
            <input className="mono" type="password" autoComplete="off" placeholder="Paste the key" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && text.trim()) save(); if (e.key === "Escape") setEditing(false); }} style={{ flex: 1 }} autoFocus />
            <button className="primary" disabled={!text.trim()} onClick={save}>Check and save</button>
            <button onClick={() => setEditing(false)}>Cancel</button>
          </div>
        ) : k.source ? <span className="mono">{MASK}</span> : <span className="badge bad">Not set</span>}
        <Failure error={error} />
      </td>
      <td className="muted small">{k.source === "file" ? "DEPLOYER_WORKBENCH_API_KEY_FILE" : k.source === "page" ? "This page" : "—"}</td>
      <td className="actions">
        {!k.canSet.ok ? <span className="small muted" title={k.canSet.reason}>{k.source === "file" ? "In deployer.env" : "Cannot be kept sealed"}</span>
          : !editing && <button className="link" onClick={() => { setError(undefined); setEditing(true); }}>{k.source ? "Change" : "Set"}</button>}
      </td>
    </tr>
  );
}
