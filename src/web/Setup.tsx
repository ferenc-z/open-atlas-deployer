// §15 (D41) page: the first setup, step by step up to Workbench, its API key and the deploy groups. Until it is
// complete this is the only page in the navigation; each step says what was checked, what to do, and only the current
// step (and an optional one that is open) has buttons. The state comes from /api/setup, worked out on every call.

import { useCallback, useEffect, useState, type FormEvent } from "react";
import * as api from "./api.ts";
import type { AiItem, AiStatus, AiUse, SetupStatus, SetupStep } from "./api.ts";
import { DeployPanel, JobPanel } from "./Deploy.tsx";
import { EnvApp } from "./Env.tsx";
import { HostsPage } from "./Hosts.tsx";
import { Nginx } from "./Ingress.tsx";

const STATE: Record<SetupStep["state"], { label: string; tone: string }> = {
  done: { label: "Done", tone: "ok" }, next: { label: "Next", tone: "info" }, waiting: { label: "Waiting", tone: "muted" }, blocked: { label: "Blocked", tone: "bad" },
};

export function SetupPage({ workbenchUrl, onChanged, onGo }: { workbenchUrl: string; onChanged: (s: SetupStatus) => void; onGo?: (page: "registry" | "keys") => void }) {
  const [status, setStatus] = useState<SetupStatus | undefined>();
  const [error, setError] = useState("");
  const refresh = useCallback(() => { api.setup().then((s) => { setStatus(s); setError(""); onChanged(s); }, (e: Error) => setError(e.message)); }, [onChanged]);
  useEffect(() => { refresh(); const t = setInterval(refresh, 10_000); return () => clearInterval(t); }, [refresh]);

  if (!status) return error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>;
  const current = status.steps.find((s) => !s.optional && (s.state === "next" || s.state === "blocked"))?.id;
  return (
    <>
      <div className="toolbar">
        <h1>Setup</h1>
        <span className="muted">
          {status.complete
            ? "Setup is complete: the Deployer runs Workbench, people sign in with it, and the deploy groups exist."
            : "Workbench is the first app (D41). Each step is checked on the spot, so a step done by hand is recognised too."}
        </span>
        <span className="badge info">{status.level}</span>
        <button onClick={refresh}>Check again</button>
      </div>
      {error && <p className="error">{error}</p>}
      <ol className="setup-steps">
        {status.steps.map((s) => {
          const open = s.id === current || (s.optional && s.state === "next" && (!current || status.complete));
          return (
            <li key={s.id} className={`card setup-step ${s.state}${s.id === current ? " current" : ""}`}>
              <div className="setup-head">
                <strong>{s.title}</strong>
                <span className={`badge ${STATE[s.state].tone}`}>{STATE[s.state].label}</span>
                {s.optional && <span className="badge muted">Optional</span>}
              </div>
              <p className={s.state === "blocked" ? "error" : "muted"}>{s.detail}</p>
              {open && status.canAct && <StepAction step={s} status={status} workbenchUrl={workbenchUrl} onDone={refresh} />}
              {open && !status.canAct && <p className="small muted">An administrator does this step.</p>}
            </li>
          );
        })}
      </ol>
      {status.complete && <AiSteps canAct={status.canAct} workbenchUrl={workbenchUrl} {...(onGo ? { onGo } : {})} />}
    </>
  );
}

/** Step 6 (L3, optional): what the assistant, assessments, diagnosis and briefs need, checked on the spot (§15.4). */
function AiSteps({ canAct, workbenchUrl, onGo }: { canAct: boolean; workbenchUrl: string; onGo?: (page: "registry" | "keys") => void }) {
  const [ai, setAi] = useState<AiStatus | undefined>();
  const [error, setError] = useState("");
  const refresh = useCallback(() => { api.setupAi().then((a) => { setAi(a); setError(""); }, (e: Error) => setError(e.message)); }, []);
  useEffect(() => { refresh(); }, [refresh]);
  return (
    <>
      <div className="toolbar">
        <h2>AI</h2>
        <span className="muted">Optional: deploys do not need it. The assistant, onboarding assessments, failure diagnosis and the daily brief run on OMA and say what they still miss.</span>
        {ai && <span className={`badge ${ai.left ? "info" : "ok"}`}>{ai.left ? `${ai.left} of ${ai.items.length} open` : "Done"}</span>}
        <button onClick={refresh}>Check again</button>
      </div>
      {error && <p className="error">{error}</p>}
      {!ai && !error && <p className="muted">Checking OMA and Workbench…</p>}
      {ai && (
        <ol className="setup-steps">
          {ai.items.map((s) => (
            <li key={s.id} className={`card setup-step ${s.state}`}>
              <div className="setup-head">
                <strong>{s.title}</strong>
                <span className={`badge ${STATE[s.state].tone}`}>{STATE[s.state].label}</span>
                <span className="small muted">For {s.uses.map((u) => USE[u]).join(", ")}</span>
              </div>
              <p className={s.state === "blocked" ? "error" : "muted"}>{s.detail}</p>
              {s.state !== "done" && s.state !== "waiting" && <AiAction item={s} canAct={canAct} workbenchUrl={workbenchUrl} onDone={refresh} {...(onGo ? { onGo } : {})} />}
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

const USE: Record<AiUse, string> = { assistant: "the assistant", assessments: "assessments", diagnosis: "failure diagnosis", briefs: "the daily brief" };

function AiAction({ item, canAct, workbenchUrl, onDone, onGo }: { item: AiItem; canAct: boolean; workbenchUrl: string; onDone: () => void; onGo?: (page: "registry" | "keys") => void }) {
  const [url, setUrl] = useState(api.deployerUrl());
  const [error, setError] = useState("");
  switch (item.id) {
    case "oma": return onGo ? <div className="row"><button onClick={() => onGo("registry")}>Open Apps & manifests</button></div> : null;
    case "oma-vault": return onGo ? <div className="row"><button onClick={() => onGo("keys")}>Open API keys</button></div> : null;
    case "workbench-agent": return <div className="row"><a className="button" href={workbenchUrl}>Open Workbench</a></div>;
    case "workbench-entry":
      if (!canAct) return <p className="small muted">An administrator does this step.</p>;
      return (
        <>
          <div className="row">
            <input value={url} onChange={(e) => setUrl(e.target.value)} />
            <button className="primary" onClick={() => { setError(""); api.registerInWorkbench(url).then(onDone, (e: Error) => setError(e.message)); }}>Register the Deployer in Workbench</button>
          </div>
          {error && <p className="error">{error}</p>}
        </>
      );
    default: return null;
  }
}

/** The assistant and onboarding entry points: what they still miss, with a way to the AI steps (§15.4 step 6). */
export function AiMissing({ use, what, onSetup }: { use: AiUse; what: string; onSetup?: () => void }) {
  const [missing, setMissing] = useState<string[] | undefined>();
  useEffect(() => { api.setupAi().then((a) => setMissing(a.missing[use]), () => setMissing(undefined)); }, [use]);
  if (!missing?.length) return null;
  return (
    <div className="banner warn inline">
      {what} is not configured yet. Still missing: {missing.join("; ")}.{" "}
      {onSetup && <button className="link" onClick={onSetup}>Show the AI steps</button>}
    </div>
  );
}

function StepAction({ step, status, workbenchUrl, onDone }: { step: SetupStep; status: SetupStatus; workbenchUrl: string; onDone: () => void }) {
  const [error, setError] = useState("");
  const fail = (e: Error) => setError(e.message);
  const body = (() => {
    switch (step.id) {
      case "environment": return step.state === "next" ? <EnvironmentForm onSaved={onDone} /> : null;
      case "executor": return <HostsPage isAdmin compact />;
      case "workbench-manifest":
        return status.environment?.prod
          ? <button className="primary" onClick={() => api.takeRegistryFromUat().then(onDone, fail)}>Take the registry from UAT</button>
          : <button className="primary" onClick={() => api.importWorkbenchManifest().then(onDone, fail)}>Import the Workbench manifest</button>;
      case "workbench-deploy": return step.state === "next" && step.workbench ? <DeployWorkbench info={step.workbench} onDone={onDone} /> : null;
      case "workbench-signin": return <a className="button" href={workbenchUrl}>Open Workbench</a>;
      case "workbench-key": return step.key?.canSet ? <KeyForm onSaved={onDone} /> : null;
      case "workbench-groups": return <button className="primary" onClick={() => api.createWorkbenchGroups().then(onDone, fail)}>Create {step.missingGroups?.join(", ")}</button>;
      case "workbench-applinks": return <AppLinks onDone={onDone} />;
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

/** Step 4: a new Workbench (generate its env, write it, deploy) or one to take over (import its env, deploy). */
function DeployWorkbench({ info, onDone }: { info: NonNullable<SetupStep["workbench"]>; onDone: () => void }) {
  const [open, setOpen] = useState<"env" | "nginx" | "deploy" | undefined>();
  const [job, setJob] = useState<string | undefined>();
  // A job still queued or running when the page was opened (the env read queued with the generated env, say) shows too.
  const [closed, setClosed] = useState<string | undefined>();
  const shown = job ?? (info.job && info.job.id !== closed ? info.job.id : undefined);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const fail = (e: Error) => setError(e.message);
  const generate = (e: FormEvent) => {
    e.preventDefault();
    setError("");
    api.generateWorkbenchEnv(email.trim(), api.deployerUrl()).then((r) => { setPassword(r.password); if (r.job) setJob(r.job); onDone(); }, fail);
  };
  const importEnv = () => api.importEnv("workbench").then((r) => setJob(r.job.id), fail);
  const done = () => { setClosed(shown); setJob(undefined); onDone(); };
  return (
    <>
      {password && (
        <div className="banner warn">
          The initial admin's password, shown only once: <code className="mono">{password}</code>{" "}
          <button className="link" onClick={() => navigator.clipboard?.writeText(password)}>Copy</button>
          <div className="muted">Keep it now: once Workbench answers, you sign in with this account, and the emergency account stops working. Remove WORKBENCH_BOOTSTRAP_PASSWORD from the variables after the first sign-in.</div>
        </div>
      )}
      {!info.takeover && !info.envRevisions && (
        <form className="row" onSubmit={generate}>
          <input type="email" placeholder="Initial admin's email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <button type="submit" className="primary" disabled={!email.trim()}>Generate Workbench's environment variables</button>
        </form>
      )}
      {info.takeover && !info.envRevisions && <div className="row"><button className="primary" onClick={importEnv}>Import Workbench's env file from the server</button></div>}
      {info.envRevisions > 0 && (
        <div className="row">
          <button className={open === "env" ? "active" : ""} onClick={() => setOpen(open === "env" ? undefined : "env")}>Environment variables{info.envWritten ? "" : " (not written yet)"}</button>
          {info.nginx && <button className={open === "nginx" ? "active" : ""} onClick={() => setOpen(open === "nginx" ? undefined : "nginx")}>nginx configuration{info.nginx.changed ? (info.nginx.saved ? " (changed)" : " (not saved yet)") : ""}</button>}
          <button className={info.envWritten ? "primary" : ""} onClick={() => setOpen("deploy")}>{info.takeover ? "Take over: deploy Workbench…" : "Deploy Workbench…"}</button>
        </div>
      )}
      {shown && <JobPanel key={shown} id={shown} onClose={done} />}
      {open === "env" && <EnvApp app="workbench" onChanged={onDone} />}
      {open === "nginx" && <SetupNginx onSaved={onDone} />}
      {open === "deploy" && <DeployPanel app="workbench" label="Workbench" initial={{ version: info.version }} isAdmin onClose={() => setOpen(undefined)} onJob={(id) => { setOpen(undefined); setJob(id); }} onAssessment={() => undefined} />}
      {error && <p className="error">{error}</p>}
    </>
  );
}

function SetupNginx({ onSaved }: { onSaved: () => void }) {
  const [data, setData] = useState<api.IngressView | undefined>();
  const [error, setError] = useState("");
  const refresh = useCallback(() => { api.ingress().then(setData, (e: Error) => setError(e.message)); }, []);
  useEffect(refresh, [refresh]);
  if (!data) return error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>;
  return <Nginx data={data} onSaved={() => { refresh(); onSaved(); }} />;
}

function KeyForm({ onSaved }: { onSaved: () => void }) {
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError("");
    api.setWorkbenchKey(key.trim()).then(() => { setKey(""); onSaved(); }, (err: Error) => setError(err.message));
  };
  return (
    <form className="row" onSubmit={submit}>
      <input type="password" autoComplete="off" placeholder="Workbench API key" value={key} onChange={(e) => setKey(e.target.value)} />
      <button type="submit" className="primary" disabled={!key.trim()}>Check and keep the key</button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function AppLinks({ onDone }: { onDone: () => void }) {
  const [url, setUrl] = useState(api.deployerUrl());
  const [env, setEnv] = useState(false);
  const [error, setError] = useState("");
  return (
    <>
      <div className="row">
        <input value={url} onChange={(e) => setUrl(e.target.value)} />
        <button onClick={() => { setError(""); api.addDeployerLink(url).then(() => { setEnv(true); onDone(); }, (e: Error) => setError(e.message)); }}>Add the Deployer to WORKBENCH_APP_LINKS</button>
        <button className={env ? "active" : ""} onClick={() => setEnv(!env)}>Workbench's environment variables</button>
      </div>
      {env && <EnvApp app="workbench" onChanged={onDone} />}
      {error && <p className="error">{error}</p>}
    </>
  );
}
