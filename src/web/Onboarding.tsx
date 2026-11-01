// Phase 7 page (design §10.5): assessments. Start one from a repository (or a new version of a registered app),
// follow the Onboarding Assessor's progress, read and edit its draft, validate, trial-deploy in UAT, register.

import { useEffect, useState, type FormEvent } from "react";
import * as api from "./api.ts";
import { Markdown } from "./Markdown.tsx";
import type { AssessmentView } from "./api.ts";

const STATE: Record<string, { label: string; tone: string }> = {
  assessing: { label: "Assessing", tone: "info" }, ready: { label: "Assessed", tone: "ok" }, failed: { label: "Failed", tone: "bad" },
  trial: { label: "Trial deploy", tone: "warn" }, registered: { label: "Registered", tone: "ok" }, adopted: { label: "Adopted", tone: "ok" }, closed: { label: "Closed", tone: "muted" },
};
const LEVEL: Record<string, string> = { A: "A deployable as is", B: "B deployable with configuration", C: "C needs repository changes", D: "D not suitable", unchanged: "Manifest unchanged" };
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { hour12: false }) : "—");

export function OnboardingPage({ canStart, isAdmin, onJob, initialOpen }: { canStart: boolean; isAdmin: boolean; onJob: (id: string) => void; initialOpen?: string }) {
  const [list, setList] = useState<AssessmentView[] | undefined>();
  const [open, setOpen] = useState<string | undefined>(initialOpen);
  const [repo, setRepo] = useState("");
  const [version, setVersion] = useState("");
  const [error, setError] = useState("");
  const [apps, setApps] = useState<string[]>([]);
  const [app, setApp] = useState("");
  const [appVersion, setAppVersion] = useState("");
  useEffect(() => { api.apps().then((r) => setApps(r.apps.map((x) => x.id)), () => setApps([])); }, []);
  const startVersion = (e: FormEvent) => {
    e.preventDefault();
    setError("");
    api.startAssessment({ app, version: appVersion }).then((r) => { setOpen(r.assessment.id); setAppVersion(""); refresh(); }, (e: Error) => setError(e.message));
  };
  const refresh = () => api.assessments().then((r) => setList(r.assessments), (e: Error) => setError(e.message));
  useEffect(() => { refresh(); const t = setInterval(refresh, 5_000); return () => clearInterval(t); }, []);
  const start = (e: FormEvent) => {
    e.preventDefault();
    setError("");
    api.startAssessment({ repo, ...(version ? { version } : {}) }).then((r) => { setOpen(r.assessment.id); setRepo(""); setVersion(""); refresh(); }, (e: Error) => setError(e.message));
  };
  return (
    <>
      <div className="toolbar"><h1>Onboarding</h1><span className="muted">Give a repository address; the Onboarding Assessor assesses it in an isolated sandbox and configures a draft. Trial deploys and registering are confirmed by a person.</span></div>
      {canStart && (
        <form className="card panel" onSubmit={start}>
          <div className="row">
            <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="https://github.com/owner/repo or git@bitbucket…" style={{ flex: 1 }} />
            <input value={version} onChange={(e) => setVersion(e.target.value.trim())} placeholder="Version (optional)" />
            <button className="primary" disabled={!repo.trim()}>Assess repository</button>
          </div>
          {error && <p className="error">{error}</p>}
        </form>
      )}
      {canStart && (
        <form className="card panel" onSubmit={startVersion}>
          <div className="row">
            <span>Assess a new version (D27):</span>
            <select value={app} onChange={(e) => setApp(e.target.value)}><option value="">Choose an app</option>{apps.map((x) => <option key={x} value={x}>{x}</option>)}</select>
            <input value={appVersion} onChange={(e) => setAppVersion(e.target.value.trim())} placeholder="New version, e.g. 1.4.0" />
            <button disabled={!app || !appVersion}>Assess this version</button>
            <span className="muted">The AI compares deploy-related files between the two tags and decides whether the manifest needs changes</span>
          </div>
        </form>
      )}
      {open && <AssessmentPanel id={open} canStart={canStart} isAdmin={isAdmin} onClose={() => setOpen(undefined)} onChanged={refresh} onJob={onJob} />}
      <table>
        <thead><tr><th>Started</th><th>Kind</th><th>Repository / app</th><th>Version</th><th>Who</th><th>Status</th><th>Level</th></tr></thead>
        <tbody>
          {(list ?? []).map((a) => (
            <tr key={a.id} className="app" onClick={() => setOpen(a.id)}>
              <td className="muted">{when(a.createdAt)}</td><td>{a.kind === "version" ? "New version" : "Onboarding"}</td>
              <td className="mono">{a.app ?? a.repo}</td><td className="mono">{a.version ?? "—"}</td><td>{a.requestedBy}</td>
              <td><span className={`badge ${STATE[a.state]?.tone ?? "muted"}`}>{STATE[a.state]?.label ?? a.state}</span></td><td>{a.level ? LEVEL[a.level] : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function AssessmentPanel({ id, canStart, isAdmin, onClose, onChanged, onJob }: { id: string; canStart: boolean; isAdmin: boolean; onClose: () => void; onChanged: () => void; onJob: (id: string) => void }) {
  const [a, setA] = useState<AssessmentView | undefined>();
  const [error, setError] = useState<{ message: string; details: string[] } | undefined>();
  const [editing, setEditing] = useState<string | undefined>();
  const [reason, setReason] = useState("");
  const load = () => api.assessment(id).then(setA, (e: api.ApiError) => setError({ message: e.message, details: e.details }));
  useEffect(() => { load(); const t = setInterval(load, 4_000); return () => clearInterval(t); }, [id]);
  const act = (p: Promise<unknown>) => { setError(undefined); p.then(() => { load(); onChanged(); }, (e: api.ApiError) => setError({ message: e.message, details: e.details ?? [] })); };
  if (!a) return <section className="card panel"><p className="muted">Loading…</p></section>;
  const save = () => {
    let draft: unknown;
    try { draft = JSON.parse(editing!); } catch { setError({ message: "The draft is not valid JSON", details: [] }); return; }
    act(api.changeDraft(id, "replace", { draft, reason }).then(() => { setEditing(undefined); setReason(""); }));
  };
  return (
    <section className="card panel">
      <div className="toolbar">
        <h2>{a.kind === "version" ? `Version assessment of ${a.app} ${a.version}` : a.repo}</h2>
        <span className={`badge ${STATE[a.state]?.tone ?? "muted"}`}>{STATE[a.state]?.label ?? a.state}</span>
        {a.level && <span className="badge info">{LEVEL[a.level]}</span>}
        <span className="muted">{a.requestedBy} · {when(a.createdAt)}</span>
        <button className="link" onClick={onClose}>Close</button>
      </div>
      {a.message && <p className={a.state === "failed" ? "error" : ""}>{a.message}</p>}
      {a.report && <div><h3>Assessment report</h3><Markdown text={a.report} /></div>}
      {a.state === "assessing" && <details open><summary>Progress (OMA session {a.session})</summary><ol className="steps">{a.progress.map((p, i) => <li key={i}>{p}</li>)}</ol></details>}
      <details open={Boolean(a.findings?.length)}>
        <summary>Draft {a.manifest.app ? `· ${a.manifest.app}` : ""} ({a.manifest.components?.length ?? 0} components, {a.draft.envKeys.length} env keys)</summary>
        {editing === undefined ? <pre className="json">{JSON.stringify(a.draft, null, 2)}</pre> : (
          <div className="panel">
            <textarea rows={18} value={editing} onChange={(e) => setEditing(e.target.value)} className="mono" />
            <div className="row"><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for the change (kept in the change log)" style={{ flex: 1 }} /><button onClick={save} disabled={reason.trim().length < 4}>Save draft</button><button className="link" onClick={() => setEditing(undefined)}>Cancel</button></div>
          </div>
        )}
        {canStart && editing === undefined && !["registered", "adopted", "closed"].includes(a.state) && <button className="link" onClick={() => setEditing(JSON.stringify(a.draft, null, 2))}>Edit the draft on the page</button>}
      </details>
      <details>
        <summary>Change log ({a.changes.length})</summary>
        <table><tbody>{a.changes.map((c, i) => <tr key={i}><td className="muted">{when(c.at)}</td><td>{c.by.startsWith("agent:") ? "AI" : c.by}</td><td>{c.summary}</td><td className="muted">{c.reason}</td></tr>)}</tbody></table>
      </details>
      <details><summary>Facts the Deployer scanned</summary><pre className="json">{JSON.stringify(a.facts, null, 2)}</pre></details>
      {a.findings && (a.findings.length ? <ul className="findings">{a.findings.map((f, i) => <li key={i} className="error">✕ {f.code} {f.at.join(".")}: {f.expected}</li>)}</ul> : <p className="ok">Validation passed</p>)}
      {a.issue && (
        <div className="panel">
          <h3>Issue draft ({a.issue.kind === "capability" ? "new Deployer capability" : "for the repository author"}): {a.issue.title}</h3>
          <Markdown text={a.issue.body} />
          {a.issue.url ? <a href={a.issue.url} target="_blank" rel="noreferrer">{a.issue.url}</a> : canStart && <button onClick={() => act(api.openIssue(id))}>Open the issue in the Deployer repository</button>}
        </div>
      )}
      <div className="row">
        <button onClick={() => act(api.validateDraft(id))}>Validate draft</button>
        {canStart && a.kind === "onboarding" && ["ready", "trial", "failed"].includes(a.state) && (a.level === "A" || a.level === "B") && (
          <button className="primary" onClick={() => act(api.trialAssessment(id).then((r) => onJob(r.job.id)))}>Trial deploy in UAT</button>
        )}
        {a.trialJob && <button className="link" onClick={() => onJob(a.trialJob!)}>Trial deploy {a.trialJob}</button>}
        {isAdmin && ((a.kind === "onboarding" && a.state === "trial") || (a.kind === "version" && a.state === "ready")) && (
          <button className="primary" onClick={() => act(api.registerAssessment(id))}>{a.kind === "version" ? (a.level === "unchanged" ? "Confirm keeping the manifest" : "Adopt the new manifest") : "Register the app"}</button>
        )}
        {canStart && !["registered", "adopted", "closed"].includes(a.state) && <button className="link" onClick={() => { if (confirm("Close this assessment? An app in trial deploy is removed from the registry.")) act(api.closeAssessment(id)); }}>Close assessment</button>}
      </div>
      {error && <div className="error">{error.message}{error.details.length > 0 && <ul>{error.details.map((d) => <li key={d}>{d}</li>)}</ul>}</div>}
    </section>
  );
}
