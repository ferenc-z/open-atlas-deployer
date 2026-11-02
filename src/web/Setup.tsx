// §15 (D41) page: the first setup, step by step up to Workbench and its API key. Until it is complete this is the only
// page in the navigation; each step says what was checked, what to do, and only the current step has the main button.
// The state comes from /api/setup, worked out by the Deployer on every call.

import { useCallback, useEffect, useState, type FormEvent } from "react";
import * as api from "./api.ts";
import type { SetupStatus, SetupStep } from "./api.ts";
import { DeployPanel, JobPanel } from "./Deploy.tsx";
import { EnvApp } from "./Env.tsx";
import { HostsPage } from "./Hosts.tsx";

const STATE: Record<SetupStep["state"], { label: string; tone: string }> = {
  done: { label: "Done", tone: "ok" }, next: { label: "Next", tone: "info" }, waiting: { label: "Waiting", tone: "muted" }, blocked: { label: "Blocked", tone: "bad" },
};

export function SetupPage({ workbenchUrl, onChanged }: { workbenchUrl: string; onChanged: (s: SetupStatus) => void }) {
  const [status, setStatus] = useState<SetupStatus | undefined>();
  const [error, setError] = useState("");
  const refresh = useCallback(() => { api.setup().then((s) => { setStatus(s); setError(""); onChanged(s); }, (e: Error) => setError(e.message)); }, [onChanged]);
  useEffect(() => { refresh(); const t = setInterval(refresh, 10_000); return () => clearInterval(t); }, [refresh]);

  if (!status) return error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>;
  const current = status.steps.find((s) => s.state === "next" || s.state === "blocked")?.id;
  return (
    <>
      <div className="toolbar">
        <h1>Setup</h1>
        <span className="muted">
          {status.complete
            ? "Setup is complete: Workbench signs people in and the Deployer has its Workbench API key."
            : "Workbench is the first app (D41). Each step is checked on the spot, so a step done by hand is recognised too."}
        </span>
        <span className="badge info">{status.level}</span>
        <button onClick={refresh}>Check again</button>
      </div>
      {error && <p className="error">{error}</p>}
      <ol className="setup-steps">
        {status.steps.map((s) => (
          <li key={s.id} className={`card setup-step ${s.state}${s.id === current ? " current" : ""}`}>
            <div className="setup-head"><strong>{s.title}</strong><span className={`badge ${STATE[s.state].tone}`}>{STATE[s.state].label}</span></div>
            <p className={s.state === "blocked" ? "error" : "muted"}>{s.detail}</p>
            {s.id === current && status.canAct && <StepAction step={s} status={status} workbenchUrl={workbenchUrl} onDone={refresh} />}
            {s.id === current && !status.canAct && <p className="small muted">An administrator does this step.</p>}
          </li>
        ))}
      </ol>
    </>
  );
}

function StepAction({ step, status, workbenchUrl, onDone }: { step: SetupStep; status: SetupStatus; workbenchUrl: string; onDone: () => void }) {
  const [error, setError] = useState("");
  const fail = (e: Error) => setError(e.message);
  const body = (() => {
    switch (step.id) {
      case "environment": return step.state === "next" ? <EnvironmentForm onSaved={onDone} /> : null;
      case "executor": return <HostsPage isAdmin />;
      case "workbench-manifest":
        return status.environment?.prod
          ? <button className="primary" onClick={() => api.takeRegistryFromUat().then(onDone, fail)}>Take the registry from UAT</button>
          : <button className="primary" onClick={() => api.importWorkbenchManifest().then(onDone, fail)}>Import the Workbench manifest</button>;
      case "workbench-deploy": return step.state === "next" ? <DeployWorkbench onDone={onDone} /> : null;
      case "workbench-signin": return <a className="button" href={workbenchUrl}>Open Workbench</a>;
      default: return null;
    }
  })();
  return <div className="setup-action">{body}{error && <p className="error">{error}</p>}</div>;
}

function EnvironmentForm({ onSaved }: { onSaved: () => void }) {
  const [form, setForm] = useState({ name: "uat", project: "open-atlas", domain: "", registry: "ghcr.io/ferenc-z", workbenchPort: "8443", certificate: "", certificateKey: "", bindIp: "127.0.0.1" });
  const [error, setError] = useState<api.ApiError | undefined>();
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    api.createEnvironment(form).then(onSaved, setError);
  };
  const field = (k: keyof typeof form, label: string, hint: string) => (
    <label className="setup-field"><span>{label}</span><input value={form[k]} onChange={set(k)} /><span className="small muted">{hint}</span></label>
  );
  return (
    <form className="setup-form" onSubmit={submit}>
      {field("name", "Environment", "uat or prod; prod takes its manifests from UAT")}
      {field("project", "Compose project", "lowercase letters, digits, - and _")}
      {field("domain", "Domain", "the DNS name nginx serves, e.g. uat.example.internal; empty if apps are reached directly")}
      {field("workbenchPort", "Workbench HTTPS port", "the port nginx listens on for Workbench")}
      {field("certificate", "Certificate (optional)", "path of nginx's certificate on its host")}
      {field("certificateKey", "Certificate key (optional)", "path of its key")}
      {field("registry", "Image registry (ghcr)", "where Workbench's image is pulled from")}
      {field("bindIp", "Bind address", "the address published ports bind to")}
      <p className="small muted">One host, local, runs everything; more hosts are added later in Environment settings. Saving makes revision 1.</p>
      <div className="row"><button type="submit" className="primary">Save the environment settings</button></div>
      {error && <div className="error">{error.message}{error.details.length > 0 && <ul>{error.details.map((d) => <li key={d} className="mono">{d}</li>)}</ul>}</div>}
    </form>
  );
}

function DeployWorkbench({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState<"env" | "deploy" | undefined>();
  const [job, setJob] = useState<string | undefined>();
  return (
    <>
      <div className="row">
        <button className={open === "env" ? "active" : ""} onClick={() => setOpen(open === "env" ? undefined : "env")}>Environment variables</button>
        <button className="primary" onClick={() => setOpen("deploy")}>Deploy Workbench…</button>
      </div>
      {open === "env" && <EnvApp app="workbench" onChanged={onDone} />}
      {open === "deploy" && !job && <DeployPanel app="workbench" isAdmin onClose={() => setOpen(undefined)} onJob={setJob} onAssessment={() => undefined} />}
      {job && <JobPanel id={job} onClose={() => { setJob(undefined); setOpen(undefined); onDone(); }} />}
    </>
  );
}
