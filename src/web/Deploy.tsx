// Phase 2 pages: choose a version, read the plan, build, confirm, follow the job; the deploy history
// with "Go back to this version". Phase 5: the plan lists every component in the order it runs, and a running deploy
// shows those steps, with the manual ones ticked here item by item.

import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "./api.ts";
import type { Job, JobView as JobData, Plan } from "./api.ts";
import { diffLines } from "./diff.ts";
import { ask } from "./Confirm.tsx";

const STEP: Record<string, string> = {
  clone: "Clone tag", tools: "Get release tools", build: "Build and push", "verify-build": "Check BUILD.json",
  files: "Get release files", pull: "Pull images and pin digests", validate: "Validate fragment and policy", backup: "Back up data",
  switch: "Switch", migrate: "Database migration", start: "Start", verify: "Health check", cleanup: "Clean up", rollback: "Roll back", "restore-data": "Restore data",
  write: "Write env file", restart: "Restart services that use it", read: "Read env file",
};
const STATE: Record<string, { label: string; tone: string }> = {
  queued: { label: "Queued", tone: "muted" }, running: { label: "Running", tone: "info" }, succeeded: { label: "Succeeded", tone: "ok" },
  failed: { label: "Failed", tone: "bad" }, "rolled-back": { label: "Rolled back", tone: "warn" }, refused: { label: "Refused", tone: "bad" },
  done: { label: "Done", tone: "ok" }, pending: { label: "Not started", tone: "muted" }, waiting: { label: "Waiting for confirmation", tone: "warn" },
  skipped: { label: "Skipped", tone: "muted" },
};
const TYPE: Record<string, string> = {
  "compose-service": "Container", "db-migration": "Database migration", "workbench-app": "Workbench app package", "studio-graph": "Studio graph", "oma-agent": "OMA Agent", manual: "Manual step",
};
const WHERE: Record<string, string> = { host: "Executor", deployer: "Deployer", person: "Person" };
const FINAL = ["succeeded", "failed", "rolled-back", "refused"];
export const BASIS: Record<string, string> = { uat: "Deployed successfully in UAT", release: "Officially released", "prod-history": "Deployed successfully here", override: "Skipped by an admin" };
export const KIND: Record<string, string> = { build: "Build", deploy: "Deploy", env: "Write env", "env-read": "Import env", "executor-upgrade": "Upgrade executor", "deployer-upgrade": "Upgrade Deployer" };
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("en-US", { hour12: false }) : "—");

export function JobState({ state }: { state: string }) {
  const s = STATE[state] ?? { label: state, tone: "muted" };
  return <span className={`badge ${s.tone}`}>{s.label}</span>;
}

export function DeployPanel({ app, label = app, initial, isAdmin, onClose, onJob, onAssessment }: { app: string; label?: string; initial?: { version: string; pinFrom?: string }; isAdmin?: boolean; onClose: () => void; onJob: (id: string) => void; onAssessment: (id: string) => void }) {
  const [reason, setReason] = useState("");
  const [overridden, setOverridden] = useState<string | undefined>();
  const [list, setList] = useState<api.VersionList | undefined>();
  const [version, setVersion] = useState(initial?.version ?? "");
  const [pinFrom] = useState(initial?.pinFrom);
  const [plan, setPlan] = useState<Plan | undefined>();
  const [notice, setNotice] = useState(0);
  const [error, setError] = useState<{ message: string; details: string[] } | undefined>();
  const [busy, setBusy] = useState(false);
  const fail = (e: api.ApiError) => { setError({ message: e.message, details: e.details ?? [] }); setBusy(false); };

  // Start on the running version so the full list opens around it; fall back to the newest tag.
  useEffect(() => { api.versions(app).then((l) => { setList(l); if (!version) setVersion(l.deployed && l.versions.includes(l.deployed) ? l.deployed : l.versions[0] ?? ""); }, fail); }, [app]);
  const makePlan = useCallback((v = version) => {
    setError(undefined); setPlan(undefined); setOverridden(undefined);
    if (v) api.plan(app, v, pinFrom).then(setPlan, fail);
  }, [app, version, pinFrom]);
  const override = () => {
    setError(undefined);
    api.planWithOverride(app, plan!.version, reason).then((p) => { setPlan(p); setOverridden(reason); }, fail);
  };
  useEffect(() => { if (initial?.version) makePlan(initial.version); }, []);

  const start = () => {
    setBusy(true);
    (overridden ? api.deployWithOverride(app, plan!.version, true, overridden) : notice ? api.deployWithNotice(app, plan!.version, notice, pinFrom) : api.deploy(app, plan!.version, true, pinFrom)).then((r) => onJob(r.job.id), fail);
  };
  const build = () => { setBusy(true); api.build(app, plan!.version).then((r) => onJob(r.jobs[0]!.id), fail); };
  // D32: a version no manifest covers is assessed first; "unchanged" extends the manifest down to it.
  const assess = () => { setBusy(true); api.startAssessment({ app, version }).then((r) => onAssessment(r.assessment.id), fail); };
  const uncovered = Boolean(list?.uncovered.includes(version));
  const blocking = plan?.findings.filter((f) => f.blocking) ?? [];
  const notBuilt = blocking.some((f) => f.code === "deploy/not-built") && blocking.every((f) => f.code === "deploy/not-built");
  const notPromoted = blocking.some((f) => f.code === "deploy/not-promoted");

  return (
    <section className="card panel">
      <div className="toolbar">
        <h2>{pinFrom ? `Go back to ${label} ${initial?.version}` : `Deploy ${label}`}</h2>
        <span className="muted">{list?.deployed ? `Now: ${list.deployed}` : "Not deployed by the Deployer yet"}</span>
        <button className="link" onClick={onClose}>Close</button>
      </div>
      {!pinFrom && (
        <div className="row">
          {list?.versions.length ? (
            <>
              <select value={version} onChange={(e) => { setVersion(e.target.value); setPlan(undefined); setError(undefined); }} className="versions">
                {(list.versions.includes(version) || !version ? list.versions : [version, ...list.versions]).map((v) => (
                  <option key={v} value={v} className={list.deployed === v ? "running" : list.uncovered.includes(v) ? "uncovered" : undefined}>
                    {v}{list.deployed === v ? " · Running" : ""}{list.built.includes(v) ? " · Built" : ""}{list.uncovered.includes(v) ? " · No manifest" : ""}
                  </option>
                ))}
              </select>
              {list.deployed === version && <span className="badge ok">Running</span>}
              {uncovered && <span className="badge muted">No manifest</span>}
            </>
          ) : (
            <input value={version} onChange={(e) => setVersion(e.target.value.trim())} placeholder="Version, e.g. 2.8.0" />
          )}
          {uncovered
            ? <button onClick={assess} disabled={busy}>Assess this version</button>
            : <button onClick={() => makePlan()} disabled={!version}>Create plan</button>}
          {list?.error && <span className="muted">{list.error}; you can type a version directly</span>}
        </div>
      )}
      {!pinFrom && uncovered && <p className="muted">No manifest covers {version} yet: it is older than the first one. An assessment compares its deploy files with the manifest's version; if nothing changed, the manifest extends down to {version}, otherwise a new manifest is drafted for an admin to adopt.</p>}
      {plan && (
        <div className="plan">
          {plan.findings.length > 0 && (
            <ul className="findings">
              {plan.findings.map((f) => <li key={f.code + f.message} className={f.blocking ? "error" : "muted"}>{f.blocking ? "✕ " : "• "}{f.message}</li>)}
            </ul>
          )}
          {plan.promotion && <p className={plan.promotion.basis === "override" ? "error" : ""}><span className="badge info">Promotion basis: {BASIS[plan.promotion.basis]}</span> {plan.promotion.basis === "override" ? `Reason: ${plan.promotion.reason}` : plan.promotion.detail}</p>}
          {notPromoted && isAdmin && (
            <div className="row override">
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for skipping the promotion rule (audited and marked on the deploy record)" />
              <button className="danger" onClick={override} disabled={reason.trim().length < 4}>Skip the promotion rule</button>
            </div>
          )}
          <table>
            <thead><tr><th>#</th><th>Component</th><th>Done by</th><th>Now</th><th>After deploy</th><th>Impact</th></tr></thead>
            <tbody>
              {plan.steps.map((s, i) => (
                <tr key={s.component}>
                  <td className="muted">{i + 1}</td>
                  <td><span className="mono">{s.component}</span> <span className="muted">{TYPE[s.type] ?? s.type}</span></td>
                  <td>{WHERE[s.where]}</td>
                  <td className="mono muted">{s.before ?? "—"}</td>
                  <td className="mono">{s.after}{s.checks && <ol>{s.checks.map((c) => <li key={c}>{c}</li>)}</ol>}</td>
                  <td className="muted">{s.impact}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">Manifest {plan.manifest}{plan.bundle ? `; release bundle ${plan.bundle.asset} (${plan.bundle.digest.slice(0, 19)}…)` : ""}. Runs in order: the executor first pulls images and pins digests, validates the fragment, backs up data, switches, starts and waits for health checks, going back to the previous version automatically on failure; then the Deployer calls Workbench, Studio and OMA in turn, and if a step fails, the steps before it are undone; it pauses at manual steps and continues once every item is checked.</p>
          {plan.fragment && (
            <details>
              <summary>Changes to the compose fragment</summary>
              <pre className="diff">{diffLines(plan.previousFragment ?? "", plan.fragment).map((l, i) => <div key={i} className={l.kind}>{l.kind === "add" ? "+ " : l.kind === "del" ? "- " : "  "}{l.text}</div>)}</pre>
            </details>
          )}
          <div className="row">
            {notBuilt && <button onClick={build} disabled={busy}>Build {plan.version}</button>}
            {plan.steps.some((s) => s.where === "host") && !overridden && (
              <label className="muted">
                <select value={notice} onChange={(e) => setNotice(Number(e.target.value))}>
                  <option value={0}>Deploy now</option>{[5, 10, 15, 30].map((m) => <option key={m} value={m}>Deploy in {m} minutes, notifying Workbench users first</option>)}
                </select>
              </label>
            )}
            <button className="primary" onClick={start} disabled={busy || blocking.length > 0}>{notice ? `Notify and deploy ${plan.version} in ${notice} minutes` : `Confirm deploy of ${plan.version}`}</button>
          </div>
        </div>
      )}
      {error && <div className="error">{error.message}{error.details.length > 0 && <ul>{error.details.map((d) => <li key={d}>{d}</li>)}</ul>}</div>}
    </section>
  );
}

export function JobPanel({ id, onClose, onBack }: { id: string; onClose: () => void; onBack?: (job: JobData["job"]) => void }) {
  const [data, setData] = useState<JobData | undefined>();
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    let stop = false;
    const tick = () => api.job(id).then((d) => {
      if (stop) return;
      setData(d);
      if (!FINAL.includes(d.job.state)) setTimeout(tick, 2_000);
    }, (e: Error) => setError(e.message));
    tick();
    return () => { stop = true; };
  }, [id]);
  const reload = () => api.job(id).then(setData, (e: Error) => setError(e.message));
  const tickItem = (component: string, index: number, checked: boolean) => {
    setActionError("");
    api.check(id, component, index, checked).then(reload, (e: Error) => setActionError(e.message));
  };
  const stopHere = async () => {
    const scheduled = data?.job.rollout?.scheduled && !data.job.rollout.scheduled.submitted;
    if (!(await ask(scheduled ? "Cancel this scheduled deploy? The maintenance notice in Workbench will be removed." : "Stop the deploy at this manual step? Finished steps are kept and the deploy is marked failed.", { confirm: scheduled ? "Cancel deploy" : "Stop deploy", danger: true }))) return;
    api.stopJob(id).then(reload, (e: Error) => setActionError(e.message));
  };
  useEffect(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight); }, [data?.log]);

  if (error) return <section className="card panel"><p className="error">{error}</p></section>;
  if (!data) return <section className="card panel"><p className="muted">Loading…</p></section>;
  const { job } = data;
  return (
    <section className="card panel">
      <div className="toolbar">
        <h2>{KIND[job.kind] ?? job.kind} {job.app} {job.kind === "env-read" ? "" : job.version}</h2>
        <JobState state={job.state} />
        <span className="muted">{job.requestedBy} · {when(job.requestedAt)}{job.pinFrom ? ` · back to ${job.pinFrom}` : ""}</span>
        {onBack && job.kind === "deploy" && job.state === "succeeded" && <button onClick={() => onBack(job)}>Go back to this version</button>}
        <button className="link" onClick={onClose}>Close</button>
      </div>
      {job.message && <p className={job.state === "succeeded" ? "" : "error"}>{job.message}</p>}
      {(() => {
        // D36: the address checked once after the deploy; a failure only warns.
        const ingress = (job.observation as { ingress?: { url: string; ok: boolean; status?: number; error?: string } } | null)?.ingress;
        if (!ingress) return null;
        return ingress.ok
          ? <p className="muted">Reached at <a href={ingress.url} target="_blank" rel="noreferrer">{ingress.url}</a> (HTTP {ingress.status}).</p>
          : <p className="banner warn">Deployed, but not reachable at its address: {ingress.url} ({ingress.status ? `HTTP ${ingress.status}` : ingress.error}). The containers are healthy, so check the nginx configuration (Ingress page) and the network; nothing was rolled back.</p>;
      })()}
      {data.promotion && <p><span className={`badge ${data.promotion.basis === "override" ? "warn" : "info"}`}>Promotion basis: {BASIS[data.promotion.basis]}</span> <span className="muted">{data.promotion.basis === "override" ? `${data.promotion.by}: ${data.promotion.reason}` : data.promotion.detail}</span></p>}
      {job.rollout?.scheduled && !job.rollout.scheduled.submitted && !FINAL.includes(job.state) && (
        <p className="banner info">Workbench users have been notified; the deploy starts at {new Date(job.rollout.scheduled.at).toLocaleTimeString("en-US", { hour12: false })}. <button className="link" onClick={stopHere}>Cancel this deploy</button></p>
      )}
      {job.state === "queued" && job.rollout?.host !== "none" && !(job.rollout?.scheduled && !job.rollout.scheduled.submitted) && <p className="muted">Waiting for the executor to pick it up…</p>}
      {job.rollout && (
        <table className="rollout">
          <thead><tr><th>#</th><th>Component</th><th>Done by</th><th>Status</th><th>Result</th></tr></thead>
          <tbody>
            {job.rollout.steps.map((s, i) => (
              <tr key={s.component}>
                <td className="muted">{i + 1}</td>
                <td><span className="mono">{s.component}</span> <span className="muted">{TYPE[s.type] ?? s.type}</span></td>
                <td>{WHERE[s.where]}</td>
                <td><JobState state={s.state} /></td>
                <td>
                  {s.message && <div className={s.state === "failed" ? "error" : ""}>{s.message}</div>}
                  {s.checks && (
                    <ul className="checks">
                      {s.checks.map((c, n) => (
                        <li key={n}>
                          <label>
                            <input type="checkbox" checked={Boolean(c.by)} disabled={s.state !== "waiting"} onChange={(e) => tickItem(s.component, n, e.target.checked)} /> {c.text}
                          </label>
                          {c.by && <span className="muted"> · {c.by} {when(c.at)}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                  {s.state === "waiting" && <button className="link" onClick={stopHere}>Stop the deploy here</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {actionError && <p className="error">{actionError}</p>}
      <ol className="steps">
        {(job.status?.steps ?? []).map((s, i) => (
          <li key={i}><JobState state={s.state} /> {STEP[s.name] ?? s.name}<span className="muted"> {when(s.at)}</span>{s.message && <div className="error">{s.message}</div>}</li>
        ))}
      </ol>
      {data.record && job.state !== "queued" && (
        <details>
          <summary>Deploy record (deployment-receipt fields)</summary>
          <pre className="json">{JSON.stringify(data.record, null, 2)}</pre>
        </details>
      )}
      {job.rollout?.host !== "none" && (
        <details open={!FINAL.includes(job.state) && job.rollout?.host !== "done"}>
          <summary>Executor log</summary>
          <pre className="log" ref={logRef}>{data.log || "(no log yet)"}</pre>
        </details>
      )}
      {(job.rollout?.log.length ?? 0) > 0 && (
        <details open={!FINAL.includes(job.state) && job.rollout?.host !== "pending"}>
          <summary>Deployer step log</summary>
          <pre className="log">{job.rollout!.log.join("\n")}</pre>
        </details>
      )}
    </section>
  );
}

export function History({ onBack }: { onBack: (job: { app: string; version: string; id: string }) => void }) {
  const [list, setList] = useState<Omit<Job, "request">[] | undefined>();
  const [open, setOpen] = useState<string | undefined>();
  const [error, setError] = useState("");
  const refresh = useCallback(() => { api.jobs().then((d) => setList(d.jobs), (e: Error) => setError(e.message)); }, []);
  useEffect(() => { refresh(); const t = setInterval(refresh, 5_000); return () => clearInterval(t); }, [refresh]);
  if (error) return <p className="error">{error}</p>;
  if (!list) return <p className="muted">Loading…</p>;
  return (
    <>
      <div className="toolbar"><h1>Deploy history</h1><span className="muted">Builds, deploys and env writes, latest 50</span></div>
      {open && <JobPanel id={open} onClose={() => setOpen(undefined)} onBack={(j) => onBack({ app: j.app, version: j.version, id: j.id })} />}
      <table>
        <thead><tr><th>Time</th><th>Job</th><th>App</th><th>Version</th><th>Who</th><th>Result</th><th>Note</th></tr></thead>
        <tbody>
          {list.map((j) => (
            <tr key={j.id} className="app" onClick={() => setOpen(j.id)}>
              <td className="muted">{when(j.requestedAt)}</td>
              <td>{j.pinFrom ? "Back to an old version" : KIND[j.kind] ?? j.kind}</td>
              <td>{j.app}</td>
              <td className="mono">{j.fromVersion && j.kind !== "build" ? `${j.fromVersion} → ` : ""}{j.kind === "env-read" ? "" : j.version}</td>
              <td>{j.requestedBy}</td>
              <td><JobState state={j.state} /></td>
              <td className="muted clip">{j.message ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
