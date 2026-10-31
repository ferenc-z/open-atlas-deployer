// Environment variables (design §7.2; page redesigned in D37): app cards with each app's state; a status strip that
// says what is on the server, what the Deployer holds, and the one next step; the values grouped (needs attention,
// set, optional and unset) with problems marked on their rows, counts that filter, a search, and editing in the same
// table; history and the comparison with the other environment in their own tabs. Writing goes through a plan.

import { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "./api.ts";
import type { EnvEdit, EnvPlan, EnvView, Fingerprint, RegisteredApp } from "./api.ts";
import { JobPanel } from "./Deploy.tsx";

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("en-US", { hour12: false }) : "—");
const SOURCE: Record<string, string> = { edit: "Edit", import: "Imported from the server", revert: "Back to an old revision" };
const CHANGE: Record<string, string> = { added: "added", removed: "removed", changed: "changed" };
const MASK = "••••••••";

type Fail = { message: string; details: string[] };
const toFail = (e: api.ApiError): Fail => ({ message: e.message, details: e.details ?? [] });

function Failure({ error }: { error: Fail | undefined }) {
  if (!error) return null;
  return <div className="error">{error.message}{error.details.length > 0 && <ul>{error.details.map((d) => <li key={d}>{d}</li>)}</ul>}</div>;
}

/** One app's state in a few words, for its card. */
function stateOf(v: EnvView): { label: string; tone: string; missing: number } {
  const latest = v.revisions[0]?.revision ?? null;
  const missing = v.findings.filter((f) => f.code === "env/referenced-missing").length;
  if (latest === null || v.applied === null) return { label: "Not imported", tone: "warn", missing };
  if (latest !== v.applied) return { label: `Revision ${latest} not written`, tone: "warn", missing };
  return { label: `In sync · revision ${latest}`, tone: "ok", missing };
}

export function EnvPage() {
  const [apps, setApps] = useState<RegisteredApp[] | undefined>();
  const [views, setViews] = useState<Record<string, EnvView | { error: string }>>({});
  const [app, setApp] = useState("");
  const [error, setError] = useState("");
  const loadViews = useCallback((list: RegisteredApp[]) => Promise.all(list.map((a) => api.env(a.id).then((v) => [a.id, v] as const, (e: api.ApiError) => [a.id, { error: e.status === 404 ? "No env file" : "Cannot read" }] as const)))
    .then((pairs) => { const next = Object.fromEntries(pairs); setViews(next); return next; }), []);
  useEffect(() => {
    api.apps().then((d) => {
      setApps(d.apps);
      loadViews(d.apps).then((next) => setApp((a) => a || d.apps.find((x) => { const v = next[x.id]; return v && "deployed" in v && v.deployed; })?.id || d.apps[0]?.id || ""));
    }, (e: Error) => setError(e.message));
  }, [loadViews]);
  if (error) return <p className="error">{error}</p>;
  if (!apps) return <p className="muted">Loading…</p>;
  return (
    <>
      <div className="toolbar">
        <h1>Environment variables</h1>
        <span className="muted">The Deployer is the only maintainer of env files: change them here, then write them to the server through a plan.</span>
      </div>
      <div className="app-cards">
        {apps.map((a) => {
          const v = views[a.id];
          const s = v && "revisions" in v ? stateOf(v) : undefined;
          return (
            <button key={a.id} className={`app-card${a.id === app ? " selected" : ""}`} onClick={() => setApp(a.id)}>
              <strong>{a.name}</strong>
              <span className="muted">{v && "deployed" in v ? (v.deployed ? "Deployed" : "Not deployed") : v && "error" in v ? v.error : "…"}</span>
              {s && <span className={`badge ${s.tone}`}>{s.label}</span>}
              {s && s.missing > 0 && <span className="badge bad">{s.missing} missing</span>}
            </button>
          );
        })}
      </div>
      {app && <EnvApp key={app} app={app} onChanged={() => loadViews(apps)} />}
    </>
  );
}

type Row = {
  key: string;
  group: "attention" | "set" | "optional";
  value?: string;
  secret: boolean;
  present: boolean;
  tags: { label: string; tone: string; title?: string }[];
  comment?: string;
  example?: string;
};

function EnvApp({ app, onChanged }: { app: string; onChanged: () => void }) {
  const [data, setData] = useState<EnvView | undefined>();
  const [revision, setRevision] = useState<number | undefined>();
  const [tab, setTab] = useState<"values" | "history" | "compare">("values");
  const [editing, setEditing] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [job, setJob] = useState<string | undefined>();
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [error, setError] = useState<Fail | undefined>();
  const refresh = useCallback((rev?: number) => {
    setError(undefined);
    api.env(app, rev).then((d) => { setData(d); setRevision(rev); setRevealed({}); }, (e: api.ApiError) => setError(toFail(e)));
  }, [app]);
  useEffect(() => refresh(), [refresh]);

  if (error && !data) return <Failure error={error} />;
  if (!data) return <p className="muted">Loading…</p>;
  const latest = data.revisions[0]?.revision ?? null;
  const shown = data.revision?.revision ?? null;
  const viewingOld = revision !== undefined && revision !== latest;
  const startImport = () => api.importEnv(app).then((r) => setJob(r.job.id), (e: api.ApiError) => setError(toFail(e)));
  const reveal = (key: string) => api.revealEnv(app, shown!, key).then((r) => setRevealed({ ...revealed, [key]: r.value }), (e: api.ApiError) => setError(toFail(e)));
  const revert = (rev: number) => {
    if (!confirm(`Save the values of revision ${rev} as a new revision? It still has to be written to the server to take effect.`)) return;
    api.revertEnv(app, rev, latest).then(() => { refresh(); onChanged(); }, (e: api.ApiError) => setError(toFail(e)));
  };
  const done = () => { refresh(); onChanged(); };

  // The one next step (D37): import, write, or — in sync — edit.
  const notImported = latest === null || data.applied === null;
  const unwritten = !notImported && latest !== data.applied;
  const next = !data.canChange || viewingOld ? null
    : notImported ? { label: "Import from the server", hint: "The Deployer has not read the file on the server yet. Import it first, so nothing on the server is lost when you write.", run: startImport }
    : unwritten ? { label: "Review the plan and write…", hint: `Revision ${latest} is saved but not on the server yet; writing shows which services restart first.`, run: () => setPlanning(true) }
    : { label: "Edit", hint: "The server has the Deployer's latest revision.", run: () => { setTab("values"); setEditing(true); } };

  return (
    <>
      <section className="card env-status">
        <div className="steps3">
          <div className={`step3 ${notImported ? "warn" : "ok"}`}>
            <span className="muted">On the server</span>
            <strong className="mono">{data.file}</strong>
            <span>{data.applied === null ? "Not imported yet" : `Revision ${data.applied}`}</span>
          </div>
          <div className="arrow">→</div>
          <div className={`step3 ${unwritten ? "warn" : notImported ? "" : "ok"}`}>
            <span className="muted">In the Deployer</span>
            <strong>{latest === null ? "No revisions" : `Revision ${latest}`}</strong>
            <span>{unwritten ? "Not written to the server" : notImported ? "—" : "Same as the server"}</span>
          </div>
          <div className="arrow">→</div>
          <div className="step3 next">
            <span className="muted">Next</span>
            {next ? <button className="primary" onClick={next.run}>{next.label}</button> : <span className="muted">{viewingOld ? "Viewing an old revision" : "View only"}</span>}
            {next && <span className="muted small">{next.hint}</span>}
          </div>
        </div>
        <div className="row small">
          {!data.deployed && <span className="badge muted">Not deployed by the Deployer: writing only changes the file</span>}
          {viewingOld && <><span className="badge info">Viewing revision {revision}</span><button className="link" onClick={() => refresh()}>Back to the latest</button></>}
          {data.canChange && !viewingOld && !notImported && <button className="link" onClick={startImport}>Import again</button>}
          {data.canChange && !viewingOld && unwritten && !editing && <button className="link" onClick={() => { setTab("values"); setEditing(true); }}>Edit</button>}
        </div>
      </section>
      {job && <JobPanel id={job} onClose={() => { setJob(undefined); done(); }} />}
      <Failure error={error} />
      {planning && shown !== null && <PlanPanel app={app} revision={latest!} onClose={() => setPlanning(false)} onJob={(id) => { setPlanning(false); setJob(id); }} />}
      <div className="subtabs">
        <button className={tab === "values" ? "active" : ""} onClick={() => setTab("values")}>Values</button>
        <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>History ({data.revisions.length})</button>
        {data.applied !== null && <button className={tab === "compare" ? "active" : ""} onClick={() => setTab("compare")}>Compare with the other environment</button>}
      </div>
      {tab === "values" && <Values data={data} editing={editing} revealed={revealed} reveal={reveal} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); done(); }} />}
      {tab === "history" && (
        <table>
          <thead><tr><th>Revision</th><th>Source</th><th>Who</th><th>When</th><th>Keys changed</th><th>Note</th><th></th></tr></thead>
          <tbody>
            {data.revisions.map((r) => (
              <tr key={r.revision} className={r.revision === shown ? "current" : ""}>
                <td>{r.revision}{r.revision === data.applied && <span className="badge ok">On the server</span>}{r.revision === latest && <span className="badge info">Latest</span>}</td>
                <td>{SOURCE[r.source] ?? r.source}</td>
                <td>{r.savedBy}</td>
                <td className="muted">{when(r.savedAt)}</td>
                <td className="mono">{r.changes.length ? r.changes.map((c) => `${c.key} ${c.secret && c.change === "changed" ? "changed" : CHANGE[c.change]}`).join(", ") : <span className="muted">No changes</span>}</td>
                <td className="muted">{r.note ?? ""}</td>
                <td className="actions">
                  {r.revision !== shown && <button className="link" onClick={() => { refresh(r.revision); setTab("values"); }}>View</button>}
                  {data.canChange && r.revision !== latest && <button className="link" onClick={() => revert(r.revision)}>Go back to this revision</button>}
                </td>
              </tr>
            ))}
            {!data.revisions.length && <tr><td colSpan={7} className="muted">No revisions yet: import the file from the server first.</td></tr>}
          </tbody>
        </table>
      )}
      {tab === "compare" && <Compare app={app} onClose={() => setTab("values")} />}
    </>
  );
}

const GROUPS: { id: Row["group"]; title: string }[] = [
  { id: "attention", title: "Needs attention" },
  { id: "set", title: "Set" },
  { id: "optional", title: "Optional, not set" },
];
type Filter = "all" | "set" | "missing" | "secret" | "unknown" | "optional";

function Values({ data, editing, revealed, reveal, onCancel, onSaved }: { data: EnvView; editing: boolean; revealed: Record<string, string>; reveal: (key: string) => void; onCancel: () => void; onSaved: () => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const schemaKeys = "keys" in data.schema ? data.schema.keys : [];
  const rows = useMemo<Row[]>(() => {
    const byKey = new Map(schemaKeys.map((k) => [k.key, k]));
    const finding = new Map(data.findings.map((f) => [f.key, f]));
    const used = new Set(data.referenced.required);
    const out: Row[] = data.values.map((v) => {
      const f = finding.get(v.key);
      const tags: Row["tags"] = [];
      if (f?.code === "env/renamed") tags.push({ label: "Maybe renamed", tone: "warn", title: f.message });
      if (f?.code === "env/unknown") tags.push({ label: "Unknown", tone: "warn", title: f.message });
      if (used.has(v.key)) tags.push({ label: "Used by containers", tone: "info" });
      if (v.secret) tags.push({ label: "Secret", tone: "muted" });
      return { key: v.key, group: f ? "attention" : "set", value: v.value ?? "", secret: v.secret, present: true, tags, ...(byKey.get(v.key)?.comment ? { comment: byKey.get(v.key)!.comment! } : {}) };
    });
    const present = new Set(data.values.map((v) => v.key));
    const absent = [...new Set([...data.referenced.required, ...schemaKeys.map((k) => k.key)])].filter((k) => !present.has(k));
    for (const key of absent) {
      const k = byKey.get(key);
      const required = used.has(key) || Boolean(k?.required);
      const tags: Row["tags"] = [required ? { label: used.has(key) ? "Missing · containers need it" : "Missing", tone: "bad", ...(finding.get(key) ? { title: finding.get(key)!.message } : {}) } : { label: "Optional", tone: "muted" }];
      out.push({ key, group: required ? "attention" : "optional", secret: data.secrets.includes(key), present: false, tags, ...(k?.comment ? { comment: k.comment } : {}), ...(k?.example ? { example: k.example } : {}) });
    }
    return out;
  }, [data]);
  const counts = {
    all: rows.length,
    set: rows.filter((r) => r.present).length,
    missing: rows.filter((r) => !r.present && r.group === "attention").length,
    secret: rows.filter((r) => r.present && r.secret).length,
    unknown: rows.filter((r) => r.present && r.group === "attention").length,
    optional: rows.filter((r) => r.group === "optional").length,
  };
  const match = (r: Row) => (!query || r.key.toLowerCase().includes(query.toLowerCase()))
    && (filter === "all" || (filter === "set" && r.present) || (filter === "missing" && !r.present && r.group === "attention") || (filter === "secret" && r.present && r.secret) || (filter === "unknown" && r.present && r.group === "attention") || (filter === "optional" && r.group === "optional"));
  const containerMissing = rows.filter((r) => !r.present && r.tags.some((t) => t.label.includes("containers need")));

  // Editing in the same table: values of present rows, missing rows filled in, new rows added, rows removed.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState<{ id: number; key: string; value: string }[]>([]);
  const [note, setNote] = useState("");
  const [saveError, setSaveError] = useState<Fail | undefined>();
  useEffect(() => { if (!editing) { setEdits({}); setRemoved(new Set()); setAdded([]); setNote(""); setSaveError(undefined); } }, [editing]);
  const save = () => {
    setSaveError(undefined);
    const values: EnvEdit[] = [];
    for (const v of data.values) {
      if (removed.has(v.key)) continue;
      const typed = edits[v.key];
      // A secret the page never saw goes back as "keep" unless someone typed a new value.
      if (v.secret && (typed === undefined || typed === "")) values.push({ key: v.key, keep: true });
      else values.push({ key: v.key, value: typed ?? v.value ?? "" });
    }
    for (const r of rows.filter((x) => !x.present)) if (edits[r.key]) values.push({ key: r.key, value: edits[r.key]! });
    for (const a of added) if (a.key.trim()) values.push({ key: a.key.trim(), value: a.value });
    api.saveEnv(data.app, data.revision?.revision ?? null, values, note || undefined).then(onSaved, (e: api.ApiError) => setSaveError(toFail(e)));
  };

  const valueCell = (r: Row) => {
    if (editing && !removed.has(r.key)) {
      return r.secret
        ? <input className="mono" type="password" autoComplete="new-password" value={edits[r.key] ?? ""} onChange={(e) => setEdits({ ...edits, [r.key]: e.target.value })} placeholder={r.present ? "Leave empty to keep" : "Secret"} />
        : <input className="mono" value={edits[r.key] ?? (r.present ? r.value ?? "" : "")} onChange={(e) => setEdits({ ...edits, [r.key]: e.target.value })} placeholder={r.present ? "" : r.example ? `e.g. ${r.example}` : "Not set"} />;
    }
    if (!r.present) return <span className="muted">{r.example ? `e.g. ${r.example}` : "Not set"}</span>;
    if (removed.has(r.key)) return <span className="muted">Will be removed</span>;
    if (r.secret) return revealed[r.key] !== undefined ? revealed[r.key] : <>{MASK}{data.canReveal && <button className="link" onClick={() => reveal(r.key)}> Show</button>}</>;
    return r.value === "" ? <span className="muted">(empty)</span> : r.value;
  };
  const visible = rows.filter(match);
  const chip = (id: Filter, label: string, tone = "") => (
    <button key={id} className={`chip${filter === id ? " active" : ""} ${tone}`} onClick={() => setFilter(filter === id ? "all" : id)}>{label} <strong>{counts[id]}</strong></button>
  );
  return (
    <>
      {containerMissing.length > 0 && (
        <button className="banner bad clickable" onClick={() => setFilter("missing")}>
          The containers need {containerMissing.length} key{containerMissing.length > 1 ? "s" : ""} that {containerMissing.length > 1 ? "are" : "is"} not set: {containerMissing.slice(0, 4).map((r) => r.key).join(", ")}{containerMissing.length > 4 ? "…" : ""}. Deploys and writes are blocked until they are set.
        </button>
      )}
      <div className="row env-filters">
        {chip("all", "All")}
        {chip("set", "Set")}
        {chip("missing", "Missing", "bad")}
        {chip("secret", "Secrets")}
        {chip("unknown", "Unknown or renamed", "warn")}
        {chip("optional", "Optional, not set")}
        <input className="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search keys" />
      </div>
      <table className={`env-values${editing ? " edit" : ""}`}>
        <thead><tr><th>Key</th><th>Value</th><th>Status</th><th>Description</th>{editing && <th></th>}</tr></thead>
        {GROUPS.map((g) => {
          const list = visible.filter((r) => r.group === g.id);
          if (!list.length) return null;
          const folded = g.id === "optional" && !open.optional && filter !== "optional" && !query;
          return (
            <tbody key={g.id}>
              <tr className="group-row"><td colSpan={editing ? 5 : 4}>
                <button className="link" onClick={() => g.id === "optional" && setOpen({ ...open, optional: !open.optional })}>{g.id === "optional" ? (folded ? "▸ " : "▾ ") : ""}{g.title} ({list.length})</button>
              </td></tr>
              {!folded && list.map((r) => (
                <tr key={r.key} className={r.present ? "" : "absent"}>
                  <td className="mono">{r.key}</td>
                  <td className="mono value">{valueCell(r)}</td>
                  <td>{r.tags.map((t) => <span key={t.label} className={`badge ${t.tone}`} title={t.title}>{t.label}</span>)}</td>
                  <td className="muted desc">{r.comment ? <span className={open[r.key] ? "" : "clip1"} title={r.comment} onClick={() => setOpen({ ...open, [r.key]: !open[r.key] })}>{r.comment}</span> : ""}</td>
                  {editing && <td className="actions">{r.present && (removed.has(r.key) ? <button className="link" onClick={() => { const n = new Set(removed); n.delete(r.key); setRemoved(n); }}>Keep</button> : <button className="link danger" onClick={() => setRemoved(new Set([...removed, r.key]))}>Remove</button>)}</td>}
                </tr>
              ))}
            </tbody>
          );
        })}
        {editing && (
          <tbody>
            {added.map((a) => (
              <tr key={a.id}>
                <td><input className="mono" value={a.key} onChange={(e) => setAdded(added.map((x) => (x.id === a.id ? { ...x, key: e.target.value } : x)))} placeholder="NEW_KEY" /></td>
                <td><input className="mono" value={a.value} onChange={(e) => setAdded(added.map((x) => (x.id === a.id ? { ...x, value: e.target.value } : x)))} /></td>
                <td><span className="badge info">New</span></td><td></td>
                <td className="actions"><button className="link danger" onClick={() => setAdded(added.filter((x) => x.id !== a.id))}>Remove</button></td>
              </tr>
            ))}
            <tr><td colSpan={5}><button className="link" onClick={() => setAdded([...added, { id: Date.now(), key: "", value: "" }])}>+ Add a key</button></td></tr>
          </tbody>
        )}
      </table>
      {!visible.length && <p className="muted">No keys match.</p>}
      <details className="small">
        <summary>Details</summary>
        <p className="muted">
          Checked against: {"error" in data.schema ? <span className="error">{data.schema.error}</span> : <>{data.schema.source} ({data.version})</>}.
          {" "}Keys the compose fragment uses: {data.referenced.required.length ? <span className="mono">{data.referenced.required.join(", ")}</span> : "none"}.
          {" "}Values may refer to another app's address as <span className="mono">{"{{app:<id>.url}}"}</span>; it is written in when the file is written.
        </p>
      </details>
      {editing && (
        <div className="edit-bar">
          <span className="muted">Saving creates a new revision; it is written to the server only after you review the plan. Leave a secret empty to keep it.</span>
          <input placeholder="Change note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={save}>Save as a new revision</button>
          <Failure error={saveError} />
        </div>
      )}
    </>
  );
}

function PlanPanel({ app, revision, onClose, onJob }: { app: string; revision: number; onClose: () => void; onJob: (id: string) => void }) {
  const [plan, setPlan] = useState<EnvPlan | undefined>();
  const [error, setError] = useState<Fail | undefined>();
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.planEnv(app, revision).then(setPlan, (e: api.ApiError) => setError(toFail(e))); }, [app, revision]);
  const apply = () => { setBusy(true); api.applyEnv(app, revision).then((r) => onJob(r.job.id), (e: api.ApiError) => { setError(toFail(e)); setBusy(false); }); };
  const blocking = plan?.findings.filter((f) => f.blocking) ?? [];
  return (
    <section className="card panel">
      <div className="toolbar">
        <h2>Write revision {revision}</h2>
        <span className="muted">{plan ? `The server now has ${plan.applied === null ? "a file not yet imported" : `revision ${plan.applied}`}` : ""}</span>
        <button className="link" onClick={onClose}>Close</button>
      </div>
      {plan && (
        <div className="plan">
          {plan.findings.length > 0 && <ul className="findings">{plan.findings.map((f) => <li key={f.code + (f.key ?? "")} className={f.blocking ? "error" : "muted"}>{f.blocking ? "✕ " : "• "}{f.message}</li>)}</ul>}
          <p>
            {plan.changes.length ? <>Changes: <span className="mono">{plan.changes.map((c) => `${c.key} ${c.secret && c.change === "changed" ? "changed" : CHANGE[c.change]}`).join(", ")}</span></> : "No changes."}
          </p>
          <p>{plan.restarts.length ? <>Restarts: <span className="mono">{plan.restarts.join(", ")}</span>. These services are unavailable while restarting, usually a few seconds to a minute; if the health check fails, the old file is put back automatically.</> : "No service restarts."}</p>
          <div className="row"><button className="primary" onClick={apply} disabled={busy || blocking.length > 0}>Confirm write</button></div>
        </div>
      )}
      <Failure error={error} />
    </section>
  );
}

/** §7.2 side-by-side comparison: this environment's fingerprint next to the other Deployer's, fetched in PROD (§6.3) or pasted. */
function Compare({ app, onClose }: { app: string; onClose: () => void }) {
  const [mine, setMine] = useState<Fingerprint | undefined>();
  const [text, setText] = useState("");
  const [error, setError] = useState<Fail | undefined>();
  const [fetched, setFetched] = useState<string | undefined>();
  useEffect(() => { api.fingerprint(app).then(setMine, (e: api.ApiError) => setError(toFail(e))); }, [app]);
  useEffect(() => {
    api.peerFingerprint(app).then((fp) => { setText(JSON.stringify(fp)); setFetched(""); }, (e: api.ApiError) => { if (e.status !== 404) setFetched(e.message); });
  }, [app]);
  let other: Fingerprint | undefined;
  let parseError = "";
  if (text.trim()) {
    try {
      other = JSON.parse(text);
      if (other?.format !== mine?.format || other?.app !== app) parseError = `This is not an environment variable fingerprint of ${app}.`;
    } catch (e) { parseError = `Not valid JSON: ${(e as Error).message}`; }
  }
  const cell = (v: { value?: string; secret?: string | null } | undefined) => (!v ? <span className="muted">(none)</span> : "value" in v ? (v.value || <span className="muted">(empty)</span>) : <span className="muted">{MASK}</span>);
  const same = (a?: { value?: string; secret?: string | null }, b?: { value?: string; secret?: string | null }) => {
    if (!a || !b) return false;
    if ("value" in a || "value" in b) return a.value === b.value;
    return a.secret !== null && a.secret === b.secret ? true : a.secret === null || b.secret === null ? undefined : false;
  };
  const keys = mine && other && !parseError ? [...new Set([...Object.keys(mine.keys), ...Object.keys(other.keys)])].sort() : [];
  return (
    <section className="card panel">
      <div className="toolbar"><h2>Compare with the other environment</h2><span className="muted">Secrets are compared only for equality</span><button className="link" onClick={onClose}>Close</button></div>
      {mine && (
        <details>
          <summary>Fingerprint of this environment ({mine.environment.toUpperCase()}, revision {mine.revision}): copy it and paste it into the other environment's Deployer</summary>
          <div className="row"><button onClick={() => navigator.clipboard?.writeText(JSON.stringify(mine))}>Copy</button></div>
          <pre className="json">{JSON.stringify(mine, null, 2)}</pre>
        </details>
      )}
      {fetched === "" ? <p className="muted">Fingerprint fetched from the UAT Deployer.</p> : <>
        {fetched && <p className="error">Could not fetch the fingerprint from the UAT Deployer: {fetched}. You can paste it by hand.</p>}
        <textarea className="mono" spellCheck={false} rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the other environment's fingerprint (there: Environment variables → Compare with the other environment → Copy)" />
      </>}
      {parseError && <p className="error">{parseError}</p>}
      {keys.length > 0 && mine && other && (
        <table>
          <thead><tr><th>Key</th><th>{mine.environment.toUpperCase()}</th><th>{other.environment.toUpperCase()}</th><th></th></tr></thead>
          <tbody>
            {keys.map((k) => {
              const s = same(mine.keys[k], other!.keys[k]);
              return (
                <tr key={k} className={s === false ? "differs" : ""}>
                  <td className="mono">{k}</td><td className="mono value">{cell(mine.keys[k])}</td><td className="mono value">{cell(other!.keys[k])}</td>
                  <td>{s === true ? <span className="badge ok">Same</span> : s === false ? <span className="badge warn">Different</span> : <span className="badge muted">Cannot compare</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {mine && Object.values(mine.keys).some((v) => "secret" in v && v.secret === null) && <p className="muted">DEPLOYER_COMPARE_KEY is not configured: for secrets, only whether both sides set them is visible.</p>}
      <Failure error={error} />
    </section>
  );
}
