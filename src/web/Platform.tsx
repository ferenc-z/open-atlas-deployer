// D39: the Overview's Platform area, apart from the apps the Deployer deploys: the Deployer's own version and upgrade
// (a version from the list, a plan, then confirm; the page goes away while it restarts) and each host's executor (one
// host, or every outdated one in turn). Collapsed to one line when everything is current.

import { useCallback, useEffect, useState } from "react";
import * as api from "./api.ts";
import type { DeployerPlan, ExecutorKind, PlatformView } from "./api.ts";
import { JobState } from "./Deploy.tsx";
import { ask } from "./Confirm.tsx";

const RELATION: Record<string, string> = { newer: "newer", older: "older (go back)", running: "running", unknown: "" };
const active = (state?: string) => state === "queued" || state === "running";
/** A batch names a host's deploy executor as "<host>" and its service executor as "<host>/service" (a stop message follows a colon). */
const entryName = (s: string) => s.replace(/^([^\s:/]+)\/service\b/, "$1 (service executor)");

export function Platform() {
  const [data, setData] = useState<PlatformView | undefined>();
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const refresh = useCallback(() => { api.platform().then((d) => { setData(d); setError(""); }, (e: Error) => setError(e.message)); }, []);
  useEffect(() => { refresh(); const t = setInterval(refresh, 10_000); return () => clearInterval(t); }, [refresh]);
  if (!data) return error ? <p className="error">{error}</p> : null;

  const d = data.deployer;
  const outdated = data.executors.filter((e) => e.upgrade.available);
  const upgrading = active(d.job?.state) || data.executors.some((e) => active(e.upgrade.job?.state));
  const failed = (d.job && !active(d.job.state) && d.job.state !== "succeeded") || Boolean(data.batch?.stopped && !data.batch.finishedAt);
  const attention = Boolean(d.latest) || outdated.length > 0 || upgrading || failed || data.executors.some((e) => !e.online);
  const versions = [...new Set(data.executors.map((e) => e.version ?? "?"))];
  if (!attention && !open) {
    return (
      <section className="card platform folded">
        <button className="link" onClick={() => setOpen(true)}>▸ Platform</button>
        <span className="muted">Deployer {d.version} · {data.executors.length} executor{data.executors.length === 1 ? "" : "s"} {versions.join(", ")} · up to date</span>
      </section>
    );
  }
  return (
    <section className="card platform">
      <div className="toolbar">
        <h2>{!attention && <button className="link" onClick={() => setOpen(false)}>▾ </button>}Platform</h2>
        <span className="muted">The Deployer and the executor on each host, apart from the apps it deploys</span>
      </div>
      <DeployerRow data={data} onChanged={refresh} />
      <ExecutorRows data={data} onChanged={refresh} />
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function DeployerRow({ data, onChanged }: { data: PlatformView; onChanged: () => void }) {
  const d = data.deployer;
  const [choice, setChoice] = useState(d.latest ?? "");
  const [other, setOther] = useState("");
  const [plan, setPlan] = useState<DeployerPlan | undefined>();
  const [error, setError] = useState("");
  const version = choice === "other" || !d.versions.length ? other.trim() : choice;
  const running = active(d.job?.state);
  const review = () => { setError(""); api.deployerPlan(version).then(setPlan, (e: Error) => setError(e.message)); };
  const confirm_ = async () => {
    if (!plan) return;
    if (plan.older && !(await ask(`Go back from ${plan.from} to ${plan.to}? Data the newer version wrote may not be used by the older one.`, { confirm: `Go back to ${plan.to}`, danger: true }))) return;
    api.upgradeDeployer(plan.to, plan.older).then(() => { setPlan(undefined); onChanged(); }, (e: Error) => setError(e.message));
  };
  return (
    <div className="platform-row">
      <div className="platform-head">
        <strong>Deployer</strong>
        <span><span className="mono">{d.version}</span>{d.host && <span className="muted"> on {d.host}</span>}</span>
        {d.latest && !running && <span className="badge warn">{d.latest} available</span>}
        {running && <span><JobState state={d.job!.state} /> <span className="muted">upgrading to {d.job!.version}; this page reloads when it is back</span></span>}
      </div>
      {!running && d.job && <p className="small muted">Last upgrade {d.job.fromVersion} → {d.job.version}: <JobState state={d.job.state} />{d.job.message ? ` ${d.job.message}` : ""}</p>}
      {d.error && <p className="small muted">{d.error}</p>}
      {d.blocked && !running && <p className="small muted">{d.blocked}</p>}
      {data.canUpgrade && !running && !d.blocked && (
        <div className="row">
          {d.versions.length > 0 && (
            <select value={choice} onChange={(e) => { setChoice(e.target.value); setPlan(undefined); }}>
              <option value="">Choose a version…</option>
              {d.versions.map((v) => (
                <option key={v.version} value={v.version} disabled={v.relation === "running"}>
                  {v.version}{[v.version === d.latest ? "latest" : "", RELATION[v.relation], v.prerelease ? "pre-release" : ""].filter(Boolean).map((x) => ` · ${x}`).join("")}
                </option>
              ))}
              <option value="other">Other version…</option>
            </select>
          )}
          {(choice === "other" || !d.versions.length) && <input className="mono" value={other} onChange={(e) => { setOther(e.target.value); setPlan(undefined); }} placeholder="0.2.0" />}
          <button disabled={!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version) || version === d.version} onClick={review}>Review upgrade</button>
        </div>
      )}
      {plan && (
        <div className="card panel">
          <h3>{plan.older ? "Go back" : "Upgrade"} the Deployer to {plan.to}</h3>
          <p className="muted">From {plan.from}{plan.host ? ` · on ${plan.host}` : ""}{plan.image ? ` · ${plan.image}` : ""}</p>
          {plan.release?.notes && <details open><summary>Release notes</summary><pre className="json">{plan.release.notes}</pre></details>}
          {plan.release && !plan.release.notes && <p className="small muted">{plan.release.detail}</p>}
          <ol className="small">{plan.steps.map((s) => <li key={s}>{s}</li>)}</ol>
          {plan.warnings.map((w) => <p key={w} className={plan.older ? "banner warn" : "small muted"}>{w}</p>)}
          {plan.blocked && <p className="error">{plan.blocked}</p>}
          <div className="row">
            <button className="primary" disabled={Boolean(plan.blocked)} onClick={confirm_}>{plan.older ? `Go back to ${plan.to}` : "Confirm upgrade"}</button>
            <button onClick={() => setPlan(undefined)}>Cancel</button>
          </div>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function ExecutorRows({ data, onChanged }: { data: PlatformView; onChanged: () => void }) {
  const [error, setError] = useState("");
  const startable = data.executors.filter((e) => e.upgrade.available && !e.upgrade.blocked && !e.upgrade.killModeUnsafe);
  const batch = data.batch;
  const batchRunning = Boolean(batch?.current);
  const one = async (host: string, from: string | null, kind: ExecutorKind, unsafe?: string) => {
    if (unsafe) { await ask(api.killModeNote(host, unsafe), { confirm: "Upgrade", disabled: true }); return; }
    const name = kind === "service" ? "service executor" : "executor";
    const tail = kind === "service" ? " Services it started keep running." : "";
    if (!(await ask(`Upgrade the ${name} on ${host} from ${from} to ${data.shipped}? It takes the release from the host's own source and restarts; if the new version does not start, it goes back by itself.${tail}`, { confirm: "Upgrade" }))) return;
    setError("");
    api.upgradeExecutor(host, kind).then(onChanged, (e: Error) => setError(e.message));
  };
  const all = async () => {
    if (!(await ask(`Upgrade ${startable.length} executors to ${data.shipped}, one host after the other? A failed host stops the rest.`, { confirm: "Upgrade all" }))) return;
    setError("");
    api.upgradeOutdated().then(onChanged, (e: Error) => setError(e.message));
  };
  return (
    <div className="platform-row">
      <div className="platform-head">
        <strong>Executors</strong>
        <span className="muted">This Deployer ships executor <span className="mono">{data.shipped}</span></span>
        {data.canUpgrade && startable.length > 1 && !batchRunning && <button onClick={all}>Upgrade outdated ({startable.length})</button>}
      </div>
      {batch && (batchRunning || batch.stopped) && !batch.finishedAt && (
        <p className={batch.stopped ? "banner warn" : "small muted"}>
          {batchRunning ? `Upgrading one executor after the other: ${entryName(batch.current!.host)} now${batch.remaining.length ? `, then ${batch.remaining.map(entryName).join(", ")}` : ""}.` : `Stopped at ${entryName(batch.stopped!)}${batch.remaining.length ? `; not upgraded: ${batch.remaining.map(entryName).join(", ")}` : ""}.`}
        </p>
      )}
      <table className="executors">
        <tbody>
          {data.executors.map((e) => {
            const u = e.upgrade;
            const running = active(u.job?.state);
            return (
              <tr key={`${e.host}/${e.executor}`}>
                <td className="mono">{e.host}{e.executor === "service" && <> <span className="badge info">Service executor</span></>}</td>
                <td className="mono">{e.version ?? "—"}</td>
                <td>
                  {!e.online && !running && <span className="badge bad">Offline</span>}
                  {running && <><JobState state={u.job!.state} /> <span className="muted">upgrading to {u.job!.version}</span></>}
                  {!running && u.available && <span className="badge warn">{data.shipped} available</span>}
                  {!running && !u.available && e.online && <span className="badge ok">Up to date</span>}
                  {!running && u.job && u.job.state !== "succeeded" && u.job.version === data.shipped && <span className="small muted"> Last try: {u.job.message}</span>}
                  {!running && u.available && u.blocked && <div className="small muted">{u.blocked}</div>}
                </td>
                <td className="actions">{data.canUpgrade && !running && !batchRunning && u.available && !u.blocked && <button className="link" onClick={() => one(e.host, e.version, e.executor, u.killModeUnsafe)}>Upgrade</button>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
