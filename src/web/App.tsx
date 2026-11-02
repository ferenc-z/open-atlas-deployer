import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import * as api from "./api.ts";
import type { AuditEntry, Manifest, ManifestCheck, Me, Principal, RegisteredApp, SetupStatus, StatusView } from "./api.ts";
import { DeployPanel, History, JobPanel, JobState, KIND } from "./Deploy.tsx";
import { EnvPage } from "./Env.tsx";
import { Artifacts } from "./Artifacts.tsx";
import { AssistantPanel, KeysPage } from "./Assistant.tsx";
import { OnboardingPage } from "./Onboarding.tsx";
import { BriefCard, DriftBanner } from "./Brief.tsx";
import { HostsPage } from "./Hosts.tsx";
import { IngressPage } from "./Ingress.tsx";
import { Platform } from "./Platform.tsx";
import { SettingsPage } from "./Settings.tsx";
import { SetupPage } from "./Setup.tsx";

type Tab = "setup" | "status" | "history" | "hosts" | "settings" | "env" | "registry" | "onboarding" | "ingress" | "keys" | "audit";
type Panel = { kind: "deploy"; app: string; initial?: { version: string; pinFrom?: string } } | { kind: "job"; id: string } | undefined;

const VERDICT: Record<string, { label: string; tone: string }> = {
  ok: { label: "Healthy", tone: "ok" },
  drift: { label: "Version mismatch", tone: "warn" },
  starting: { label: "Starting", tone: "info" },
  down: { label: "Down", tone: "bad" },
  missing: { label: "No containers", tone: "bad" },
  unknown: { label: "Unknown", tone: "muted" },
  "not-a-service": { label: "—", tone: "muted" },
};

const TYPE_LABEL: Record<string, string> = {
  "compose-service": "Container", "workbench-app": "Workbench app package", "oma-agent": "OMA Agent",
  "db-migration": "Database migration", "studio-graph": "Studio Graph", manual: "Manual step",
};

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { hour12: false });

function Badge({ verdict }: { verdict: string }) {
  const v = VERDICT[verdict] ?? { label: verdict, tone: "muted" };
  return <span className={`badge ${v.tone}`}>{v.label}</span>;
}

export function App() {
  const [me, setMe] = useState<Me | undefined>();
  const [tab, setTab] = useState<Tab>("status");
  const [panel, setPanel] = useState<Panel>();
  const [assistant, setAssistant] = useState(false);
  const [assessment, setAssessment] = useState<string | undefined>();
  const actions =useMemo(() => ({ openPlan: (app: string, version: string, pinFrom?: string) => { setPanel({ kind: "deploy", app, initial: { version, ...(pinFrom ? { pinFrom } : {}) } }); setTab("status"); } }), []);
  // §15 (D41): until setup is complete, Setup is the only page.
  const [setup, setSetup] = useState<SetupStatus | undefined>();
  const load = useCallback(() => {
    api.me().then((m) => { setMe(m); if (m.signedIn) api.setup().then(setSetup, () => setSetup(undefined)); }, () => setMe(undefined));
  }, []);
  useEffect(load, [load]);
  const setupChanged = useCallback((s: SetupStatus) => setSetup((was) => (was?.complete === s.complete ? was : s)), []);
  // D39: after the Deployer was upgraded, load the new version's page.
  const loaded = me?.signedIn ? me.deployerVersion : undefined;
  useEffect(() => {
    if (!loaded) return;
    const t = setInterval(() => { api.me().then((m) => { if (m.signedIn && m.deployerVersion && m.deployerVersion !== loaded) location.reload(); }, () => undefined); }, 15_000);
    return () => clearInterval(t);
  }, [loaded]);

  if (!me) return <main className="center"><p className="muted">Checking sign-in…</p></main>;
  if (!me.signedIn) return "forbidden" in me ? <Forbidden message={me.message} /> : <SignIn me={me} onSignedIn={load} />;
  const p = me.principal;
  if (!setup) return <main className="center"><p className="muted">Checking setup…</p></main>;
  const setupOnly = !setup.complete;
  const shown: Tab = setupOnly ? "setup" : tab;
  const go = (t: Tab) => { setTab(t); if (t !== "onboarding") setAssessment(undefined); };
  return (
    <div className="shell">
      <Sidebar principal={p} environment={me.environment} tab={shown} setTab={go} setupOnly={setupOnly} onSignedOut={load} assistant={assistant} toggleAssistant={() => setAssistant(!assistant)} />
      <div className="content">
        {p.via === "emergency" && (setupOnly
          ? <div className="banner bad">First setup with the emergency account. Once Workbench is deployed and answers, this account stops working by itself: sign in with Workbench's initial admin then. Every action is audited.</div>
          : <div className="banner bad">Using the emergency account: Workbench is unreachable. Every action is audited; sign in with Workbench once it is back.</div>)}
        {p.stale && <div className="banner warn">Workbench is not responding; using the last confirmed sign-in (valid for 15 minutes).</div>}
        {p.actAs && <div className="banner info">{p.actAs.administrator} is using Workbench as {p.displayName}, so permissions here are also those of {p.displayName}.</div>}
        <main>
          {shown === "setup" && <SetupPage workbenchUrl={me.workbenchUrl} onChanged={setupChanged} />}
          {shown === "status" && <><SetupLine status={setup} onOpen={() => go("setup")} /><DriftBanner /><Status panel={panel} setPanel={setPanel} isAdmin={p.permissions.includes("admin")} canRegenerate={p.permissions.includes("deploy-uat") || p.permissions.includes("deploy-prod")} onAssessment={(id) => { setPanel(undefined); setAssessment(id); setTab("onboarding"); }} /></>}
          {shown === "history" && <HistoryPage onBack={(j) => { setPanel({ kind: "deploy", app: j.app, initial: { version: j.version, pinFrom: j.id } }); setTab("status"); }} />}
          {shown === "hosts" && <HostsPage isAdmin={p.permissions.includes("admin")} />}
          {shown === "settings" && <SettingsPage />}
          {shown === "env" && <EnvPage />}
          {shown === "ingress" && <IngressPage />}
          {shown === "registry" && <Registry principal={p} prod={me.environment?.toLowerCase() === "prod"} />}
          {shown === "onboarding" && <OnboardingPage key={assessment ?? ""} {...(assessment ? { initialOpen: assessment } : {})} canStart={p.permissions.includes("deploy-uat") && p.via === "workbench"} isAdmin={p.permissions.includes("admin")} onJob={(id) => { setPanel({ kind: "job", id }); setTab("status"); }} />}
          {shown === "keys" && <KeysPage isAdmin={p.permissions.includes("admin")} />}
          {shown === "audit" && p.permissions.includes("admin") && <Audit />}
        </main>
      </div>
      {assistant && <AssistantPanel workbenchUrl={me.workbenchUrl} {...(me.environment ? { environment: me.environment } : {})} page={shown} {...(panel?.kind === "deploy" ? { app: panel.app } : {})} actions={actions} onClose={() => setAssistant(false)} />}
    </div>
  );
}

/** D33: navigation down the left, in three groups; on a phone it folds into a menu button. */
function Sidebar({ principal, environment, tab, setTab, setupOnly, onSignedOut, assistant, toggleAssistant }: { principal: Principal; environment?: string; tab: Tab; setTab: (t: Tab) => void; setupOnly: boolean; onSignedOut: () => void; assistant: boolean; toggleAssistant: () => void }) {
  const [open, setOpen] = useState(false);
  const groups: [string, [Tab, string][]][] = setupOnly ? [["First setup", [["setup", "Setup"]]]] : [
    ["Deploy", [["status", "Overview"], ["history", "Deploy history"], ["hosts", "Hosts"], ["settings", "Environment settings"]]],
    ["Apps", [["registry", "Apps & manifests"], ["onboarding", "Onboarding & assessments"], ["env", "Environment variables"], ["ingress", "Ingress"]]],
    ["Admin", [["keys", "API keys"], ...(principal.permissions.includes("admin") ? [["audit", "Audit"] as [Tab, string]] : [])]],
  ];
  const prod = environment?.toLowerCase() === "prod";
  return (
    <aside className={`sidebar${open ? " open" : ""}`}>
      <div className="brand">
        <span>Open Atlas Deployer</span>
        {environment && <span className={`env${prod ? " prod" : ""}`}>{environment.toUpperCase()}</span>}
        <button className="menu" aria-label="Menu" aria-expanded={open} onClick={() => setOpen(!open)}>☰</button>
      </div>
      <nav>
        {groups.map(([title, items]) => (
          <div key={title} className="group">
            <div className="group-title">{title}</div>
            <div className="group-items">
              {items.map(([id, label]) => <button key={id} className={tab === id ? "active" : ""} onClick={() => { setTab(id); setOpen(false); }}>{label}</button>)}
            </div>
          </div>
        ))}
      </nav>
      <div className="who">
        <span title={principal.groups.join(", ") || "No groups"}>{principal.displayName}</span>
        <span className="muted">{principal.isAdmin ? "Admin" : principal.groups.filter((g) => g.startsWith("deploy-")).join(" · ")}</span>
        {principal.via === "workbench" && !setupOnly && <button className={assistant ? "active" : ""} onClick={toggleAssistant}>Ask the assistant</button>}
        {principal.via === "emergency" && <button className="link" onClick={() => api.emergencyLogout().then(onSignedOut)}>Sign out</button>}
      </div>
    </aside>
  );
}

/** §15.5: once setup is complete it folds into one line on the Overview. */
function SetupLine({ status, onOpen }: { status: SetupStatus; onOpen: () => void }) {
  const left = status.steps.filter((s) => s.state !== "done").length;
  return <p className="setup-line small muted"><span className="badge ok">Setup complete</span> Workbench signs people in ({status.level}){left ? `; ${left} step${left > 1 ? "s" : ""} still open` : ""}. <button className="link" onClick={onOpen}>Show the steps</button></p>;
}

/** Deploy history and artifacts are two views of what ran here: by deploy, and by app@version + digest. */
function HistoryPage({ onBack }: { onBack: (job: { app: string; version: string; id: string }) => void }) {
  const [view, setView] = useState<"deploys" | "artifacts">("deploys");
  return (
    <>
      <div className="subtabs">
        <button className={view === "deploys" ? "active" : ""} onClick={() => setView("deploys")}>Deploys</button>
        <button className={view === "artifacts" ? "active" : ""} onClick={() => setView("artifacts")}>Artifacts</button>
      </div>
      {view === "deploys" ? <History onBack={onBack} /> : <Artifacts />}
    </>
  );
}

function SignIn({ me, onSignedIn }: { me: Extract<Me, { emergencyAvailable: boolean }>; onSignedIn: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError("");
    api.emergencyLogin(password).then(onSignedIn, (err: Error) => setError(err.message));
  };
  return (
    <main className="center">
      <section className="card narrow">
        <h1>Open Atlas Deployer</h1>
        {me.reason === "workbench-unavailable"
          ? <p>Workbench is unreachable, so your sign-in cannot be confirmed.</p>
          : <p>The Deployer uses the Workbench sign-in. Sign in to Workbench first, then come back here.</p>}
        <p><a className="button" href={me.workbenchUrl}>Sign in with Workbench</a></p>
        {me.emergencyAvailable && (
          <form onSubmit={submit} className="emergency">
            <h2>Emergency account</h2>
            <p className="muted">Available only while Workbench is unreachable; every use is audited.</p>
            <input type="password" autoComplete="current-password" placeholder="Emergency account password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <button type="submit" disabled={!password}>Sign in</button>
            {error && <p className="error">{error}</p>}
          </form>
        )}
      </section>
    </main>
  );
}

function Forbidden({ message }: { message: string }) {
  return (
    <main className="center">
      <section className="card narrow">
        <h1>No access</h1>
        <p>{message}</p>
        <p className="muted">Ask a Workbench admin to add you to the deploy-viewer (view), deploy-uat or deploy-prod group.</p>
      </section>
    </main>
  );
}

function Status({ panel, setPanel, isAdmin, canRegenerate, onAssessment }: { panel: Panel; setPanel: (p: Panel) => void; isAdmin: boolean; canRegenerate: boolean; onAssessment: (id: string) => void }) {
  const [data, setData] = useState<StatusView | undefined>();
  const [error, setError] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const refresh = useCallback(() => { api.statusView().then((d) => { setData(d); setError(""); }, (e: Error) => setError(e.message)); }, []);
  useEffect(() => { refresh(); const t = setInterval(refresh, panel ? 5_000 : 30_000); return () => clearInterval(t); }, [refresh, panel]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const peerApps = data.peer && "apps" in data.peer ? data.peer.apps : undefined;
  const peerName = data.peer && "environment" in data.peer ? data.peer.environment.toUpperCase() : "UAT";
  return (
    <>
      <div className="toolbar">
        <h1>Running in {data.environment.toUpperCase()}</h1>
        <span className="muted">
          {data.host ? <>Container status {when(data.host.at)}{data.host.stale && <span className="badge warn">Stale</span>}</> : "The executor has not reported container status yet; showing only the versions apps report"}
        </span>
        <button onClick={refresh}>Refresh</button>
      </div>
      <Platform />
      <BriefCard canRegenerate={canRegenerate} />
      {data.peer && "error" in data.peer && <p className="banner warn">Cannot check the UAT records: {data.peer.error}. Only officially released versions can be deployed, or an admin can skip the promotion rule.</p>}
      {panel?.kind === "deploy" && <DeployPanel key={`${panel.app}-${panel.initial?.version ?? ""}-${panel.initial?.pinFrom ?? ""}`} app={panel.app} isAdmin={isAdmin} {...(panel.initial ? { initial: panel.initial } : {})} onClose={() => setPanel(undefined)} onJob={(id) => setPanel({ kind: "job", id })} onAssessment={onAssessment} />}
      {panel?.kind === "job" && <JobPanel id={panel.id} onClose={() => { setPanel(undefined); refresh(); }} />}
      <table className="status">
        <thead><tr><th>App</th>{data.executors.length > 1 && <th>Host</th>}<th>Desired version</th>{peerApps && <th>{peerName} now</th>}<th>Manifest</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {data.apps.map((a) => {
            const active = data.active.find((j) => j.app === a.app);
            return (
              <AppRows key={a.app} app={a} {...(data.executors.length > 1 ? { host: data.hostOf[a.app] ?? "—" } : {})} {...(peerApps ? { peer: peerApps[a.app]?.version ?? null } : {})} open={!!open[a.app]} toggle={() => setOpen({ ...open, [a.app]: !open[a.app] })}
                action={active
                  ? <button className="link" onClick={() => setPanel({ kind: "job", id: active.id })}><JobState state={active.state} /> {KIND[active.kind]} {active.kind.startsWith("env") ? "" : active.version}</button>
                  : data.canDeploy ? <button onClick={() => setPanel({ kind: "deploy", app: a.app })}>Deploy…</button> : null} />
            );
          })}
        </tbody>
      </table>
      {data.unmanaged.length > 0 && (
        <section>
          <h2>Containers not in any manifest</h2>
          <table><thead><tr><th>Service</th><th>Image</th><th>Status</th></tr></thead>
            <tbody>{data.unmanaged.map((c) => <tr key={c.service}><td>{c.service}</td><td className="mono">{c.image}</td><td>{c.status}</td></tr>)}</tbody>
          </table>
        </section>
      )}
    </>
  );
}

function AppRows({ app, open, toggle, action, peer, host }: { app: StatusView["apps"][number]; open: boolean; toggle: () => void; action: React.ReactNode; peer?: string | null; host?: string }) {
  return (
    <>
      <tr className="app" onClick={toggle}>
        <td><span className="caret">{open ? "▾" : "▸"}</span>{app.name}<span className="muted"> {app.app}</span></td>
        {host !== undefined && <td className="mono">{host}</td>}
        <td className="mono">{app.desired ?? <span className="muted">Not in this environment</span>}</td>
        {peer !== undefined && <td className="mono">{peer ?? <span className="muted">—</span>}{peer && app.desired && peer !== app.desired && <span className="badge info">Can promote</span>}</td>}
        <td className="mono">{app.manifest ? `from ${app.manifest}` : <span className="muted">None</span>}</td>
        <td><Badge verdict={app.verdict} /></td>
        <td className="actions" onClick={(e) => e.stopPropagation()}>{action}</td>
      </tr>
      {open && (
        <tr className="detail"><td colSpan={5 + (peer !== undefined ? 1 : 0) + (host !== undefined ? 1 : 0)}>
          <table>
            <thead><tr><th>Component</th><th>Type</th><th>Service</th><th>Container</th><th>Label version</th><th>Reported version</th><th>Verdict</th></tr></thead>
            <tbody>
              {app.components.map((c) => (
                <tr key={c.id}>
                  <td>{c.id}</td>
                  <td>{TYPE_LABEL[c.type] ?? c.type}</td>
                  <td className="mono">{c.service ?? "—"}</td>
                  <td>{c.container ? <span title={c.container.image}>{c.container.status}</span> : c.type === "compose-service" ? <span className="muted">—</span> : <span className="muted">Shown from phase 5</span>}</td>
                  <td className="mono">{c.container?.version ?? "—"}</td>
                  <td className="mono">{c.observed?.kind === "build" ? <span title={c.observed.commit}>{c.observed.version}</span> : c.observed?.kind === "no-build-info" ? <span className="muted">No BUILD.json</span> : c.observed?.kind === "unreachable" ? <span className="muted">Unreachable</span> : "—"}</td>
                  <td><Badge verdict={c.verdict} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </td></tr>
      )}
    </>
  );
}

function Registry({ principal, prod }: { principal: Principal; prod: boolean }) {
  const [list, setList] = useState<RegisteredApp[] | undefined>();
  const [selected, setSelected] = useState<string | undefined>();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [taken, setTaken] = useState("");
  const admin = principal.permissions.includes("admin");
  const refresh = useCallback(() => { api.apps().then((d) => setList(d.apps), (e: Error) => setError(e.message)); }, []);
  useEffect(refresh, [refresh]);

  if (error) return <p className="error">{error}</p>;
  if (!list) return <p className="muted">Loading…</p>;
  if (selected) return <AppDetail id={selected} admin={admin && !prod} back={() => { setSelected(undefined); refresh(); }} />;
  const fromUat = () => api.takeRegistryFromUat().then((r) => { setTaken(r.added.length ? `Taken from UAT: ${r.added.join(", ")}` : "Already the same as UAT."); refresh(); }, (e: Error) => setError(e.message));
  return (
    <>
      <div className="toolbar">
        <h1>App registry</h1>
        <span className="muted">The Deployer only deploys the apps listed here (§4.4){prod ? "; PROD takes them from UAT, with each promotion or here (D38)" : admin ? "" : "; only Workbench admins can change it"}</span>
        {admin && !prod && <button onClick={() => setAdding(!adding)}>{adding ? "Cancel" : "Register an app"}</button>}
        {admin && prod && <button onClick={fromUat}>Take from UAT</button>}
      </div>
      {taken && <p className="banner info">{taken}</p>}
      {adding && <ManifestForm onSaved={() => { setAdding(false); refresh(); }} />}
      <table>
        <thead><tr><th>App</th><th>Repository</th><th>Manifests</th><th>Registered</th></tr></thead>
        <tbody>
          {list.map((a) => {
            const ranges = [...new Set(a.manifests.map((m) => m.appliesFrom))];
            return (
              <tr key={a.id} className="app" onClick={() => setSelected(a.id)}>
                <td>{a.name}<span className="muted"> {a.id}</span></td>
                <td className="mono">{a.repo}</td>
                <td className="mono">{ranges.map((r) => `from ${r}`).join(", ")}</td>
                <td className="muted">{a.addedBy} · {when(a.addedAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

function AppDetail({ id, admin, back }: { id: string; admin: boolean; back: () => void }) {
  const [data, setData] = useState<{ app: RegisteredApp; manifests: Manifest[] } | undefined>();
  const [shown, setShown] = useState<{ from: string; rev: number; body: Manifest } | undefined>();
  const [editing, setEditing] = useState<Manifest | null>(null);
  const [error, setError] = useState("");
  const refresh = useCallback(() => { api.app(id).then(setData, (e: Error) => setError(e.message)); }, [id]);
  useEffect(refresh, [refresh]);

  const show = (from: string, rev: number) => api.revision(id, from, rev).then((body) => setShown({ from, rev, body }), (e: Error) => setError(e.message));
  const remove = () => {
    if (!confirm(`Remove ${id} from the registry? Its manifest history is kept, but the Deployer will no longer deploy it.`)) return;
    api.removeApp(id).then(back, (e: Error) => setError(e.message));
  };

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const { app } = data;
  return (
    <>
      <div className="toolbar">
        <button className="link" onClick={back}>← Registry</button>
        <h1>{app.name}<span className="muted"> {app.id}</span></h1>
        <span className="mono muted">{app.repo}</span>
        {admin && <><button onClick={() => setEditing(data.manifests.at(-1) ?? null)}>New manifest / edit</button><button className="danger" onClick={remove}>Remove</button></>}
      </div>
      {editing !== null && <ManifestForm initial={editing} appId={app.id} onSaved={() => { setEditing(null); refresh(); }} />}
      <h2>Current manifests</h2>
      <table>
        <thead><tr><th>Applies from</th><th>Components</th><th>env file</th></tr></thead>
        <tbody>
          {data.manifests.map((m) => (
            <tr key={m.appliesFrom}>
              <td className="mono">{m.appliesFrom}</td>
              <td>{m.components.map((c) => `${c.id} (${TYPE_LABEL[c.type] ?? c.type})`).join(", ")}</td>
              <td className="mono">{m.env?.file ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Change history</h2>
      <table>
        <thead><tr><th>Applies from</th><th>Revision</th><th>Who</th><th>When</th><th>Note</th><th></th></tr></thead>
        <tbody>
          {app.manifests.map((m) => (
            <tr key={`${m.appliesFrom}-${m.revision}`}>
              <td className="mono">{m.appliesFrom}</td><td>{m.revision}</td><td>{m.savedBy}</td><td className="muted">{when(m.savedAt)}</td>
              <td className="muted">{m.note ?? ""}</td>
              <td className="actions">
                <button className="link" onClick={() => show(m.appliesFrom, m.revision)}>View</button>
                <a href={api.revisionUrl(app.id, m.appliesFrom, m.revision)}>Export deploy.json</a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {shown && (
        <section>
          <div className="toolbar"><h2>{shown.from} revision {shown.rev}</h2><button className="link" onClick={() => setShown(undefined)}>Hide</button></div>
          <pre className="json">{JSON.stringify(shown.body, null, 2)}</pre>
        </section>
      )}
    </>
  );
}

function ManifestForm({ initial, appId, onSaved }: { initial?: Manifest; appId?: string; onSaved: () => void }) {
  const [text, setText] = useState(initial ? JSON.stringify(initial, null, 2) : "");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [repoChange, setRepoChange] = useState(false);
  const [check, setCheck] = useState<{ id: string; manifest: unknown; result: ManifestCheck } | undefined>();
  const [error, setError] = useState<{ message: string; details: string[] } | undefined>();
  const fail = (err: api.ApiError) => setError({ message: err.message, details: err.details });
  // D38: check first (findings, the versions it affects, a changed source), then save on the revision it was read at.
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    let manifest: { app?: string; appliesFrom?: string };
    try { manifest = JSON.parse(text); } catch (err) { setError({ message: `Not valid JSON: ${(err as Error).message}`, details: [] }); return; }
    const id = appId ?? manifest.app;
    if (!id) { setError({ message: "The manifest has no app.", details: [] }); return; }
    const base = appId && manifest.appliesFrom ? api.appManifest(id, manifest.appliesFrom).then((m) => m.revision, () => null) : Promise.resolve(null);
    base.then((b) => api.checkManifest(id, manifest, b, repoChange)).then((result) => setCheck({ id, manifest, result }), fail);
  };
  const save = () => {
    if (!check) return;
    api.saveManifest(check.id, check.manifest, check.result.base, { ...(name ? { name } : {}), ...(note ? { note } : {}), repoChange }).then(onSaved, fail);
  };
  return (
    <form className="card manifest" onSubmit={submit}>
      <p className="muted">
        {appId ? "Changing appliesFrom starts a separate manifest from the new version; otherwise it is saved as a new revision for the same range." : "Paste a deploy manifest v1 (deploy.json). The first manifest registers the app; the repository comes from release.repo."}
        It is validated against format v1 before saving, and checked for conflicts in service names and host ports with other apps.
      </p>
      <textarea spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} placeholder='{ "v": 1, "app": "…", "appliesFrom": "…", … }' />
      <div className="row">
        {!appId && <input placeholder="Display name (optional)" value={name} onChange={(e) => setName(e.target.value)} />}
        <input placeholder="Change note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        <button type="submit" disabled={!text.trim()}>Check</button>
        {check && !check.result.findings.length && <button type="button" className="primary" onClick={save}>{check.result.newRange ? `Save as a new range from ${check.result.appliesFrom}` : `Save as revision ${(check.result.base ?? 0) + 1}`}</button>}
      </div>
      {check && (
        <div className="plan">
          {check.result.findings.length > 0 && <ul className="findings">{check.result.findings.map((f) => <li key={f} className="error mono">✕ {f}</li>)}</ul>}
          {check.result.repoChange && <label className="row small"><input type="checkbox" checked={repoChange} onChange={(e) => { setRepoChange(e.target.checked); setCheck(undefined); }} /> I confirm the repository change (check again after ticking)</label>}
          {check.result.warnings.map((w) => <p key={w} className="banner warn">{w}</p>)}
          <p className="small muted">
            Range from {check.result.affected.from}{check.result.affected.to ? ` up to ${check.result.affected.to}` : " on"}.
            {check.result.affected.deployed.length > 0 && ` Already deployed (they keep the revision they went out with): ${check.result.affected.deployed.join(", ")}.`}
            {check.result.affected.neverDeployed.length > 0 && ` Never deployed (they take this one): ${check.result.affected.neverDeployed.join(", ")}.`}
            {check.result.affected.versionsUnknown && ` Cannot list the versions: ${check.result.affected.versionsUnknown}.`}
          </p>
          {check.result.diff && <details><summary>What changes</summary><pre className="diff">{check.result.diff.split("\n").map((l, i) => <span key={i} className={l.startsWith("+ ") ? "add" : l.startsWith("- ") ? "del" : ""}>{l}{"\n"}</span>)}</pre></details>}
        </div>
      )}
      {error && <div className="error">{error.message}{error.details.length > 0 && <ul>{error.details.map((d) => <li key={d} className="mono">{d}</li>)}</ul>}</div>}
    </form>
  );
}

function Audit() {
  const [entries, setEntries] = useState<AuditEntry[] | undefined>();
  const [error, setError] = useState("");
  useEffect(() => { api.audit().then((d) => setEntries(d.entries), (e: Error) => setError(e.message)); }, []);
  if (error) return <p className="error">{error}</p>;
  if (!entries) return <p className="muted">Loading…</p>;
  const VIA: Record<string, string> = { workbench: "Workbench", emergency: "Emergency account", cli: "Command line" };
  return (
    <>
      <div className="toolbar"><h1>Audit</h1><span className="muted">Latest 100</span></div>
      <table>
        <thead><tr><th>Time</th><th>Who</th><th>Via</th><th>Action</th><th>Object</th><th>Details</th></tr></thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id} className={e.via === "emergency" ? "flag" : ""}>
              <td className="muted">{when(e.at)}</td><td>{e.actor}</td><td>{VIA[e.via] ?? e.via}</td>
              <td className="mono">{e.action}</td><td className="mono">{e.target}</td>
              <td className="mono muted">{e.detail ? JSON.stringify(e.detail) : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
