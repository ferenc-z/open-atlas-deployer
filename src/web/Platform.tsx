// D39: the Overview's platform: the Deployer's own version and upgrade (a version from the list, a plan, then confirm;
// the page goes away while it restarts) and each host's executors (one host, or every outdated one in turn).
// 2026-11-19 Overview prototype: "Needs you" says what is wrong first (one line and at most one button each); "Hosts &
// executors" shows each host with its deploy and service executor side by side, only the ones it has ("Not installed"
// is no fault), each against its own shipped version. Folded to one line when everything is current.

import { useCallback, useEffect, useState } from "react";
import * as api from "./api.ts";
import type { DeployerPlan, ExecutorKind, PlatformView } from "./api.ts";
import { JobState } from "./Deploy.tsx";
import { ask } from "./Confirm.tsx";

const RELATION: Record<string, string> = { newer: "newer", older: "older (go back)", running: "running", unknown: "" };
const active = (state?: string) => state === "queued" || state === "running";
/** A batch names a host's deploy executor as "<host>" and its service executor as "<host>/service" (a stop message follows a colon). */
const entryName = (s: string) => s.replace(/^([^\s:/]+)\/service\b/, "$1 (service executor)");
const KIND_NAME: Record<ExecutorKind, string> = { deploy: "deploy executor", service: "service executor" };
type Row = PlatformView["executors"][number];

/** The platform view, refreshed every 10 seconds; the Overview shares it between "Needs you" and "Hosts & executors". */
export function usePlatform() {
  const [data, setData] = useState<PlatformView | undefined>();
  const [error, setError] = useState("");
  const refresh = useCallback(() => { api.platform().then((d) => { setData(d); setError(""); }, (e: Error) => setError(e.message)); }, []);
  useEffect(() => { refresh(); const t = setInterval(refresh, 10_000); return () => clearInterval(t); }, [refresh]);
  return { data, error, refresh };
}

const startable = (data: PlatformView) => data.executors.filter((e) => e.upgrade.available && !e.upgrade.blocked && !e.upgrade.killModeUnsafe);

function useUpgrade(data: PlatformView, onChanged: () => void) {
  const [error, setError] = useState("");
  const one = async (e: Row) => {
    const u = e.upgrade;
    if (u.killModeUnsafe) { await ask(api.killModeNote(e.host, u.killModeUnsafe), { confirm: "Upgrade", disabled: true }); return; }
    const tail = e.executor === "service" ? " Services it started keep running." : "";
    if (!(await ask(`Upgrade the ${KIND_NAME[e.executor]} on ${e.host} from ${e.version} to ${e.shipped}? It takes the release from the host's own source and restarts; if the new version does not start, it goes back by itself.${tail}`, { confirm: "Upgrade" }))) return;
    setError("");
    api.upgradeExecutor(e.host, e.executor).then(onChanged, (x: Error) => setError(x.message));
  };
  const all = async () => {
    const list = startable(data);
    if (list.length === 1) return one(list[0]!);
    if (!(await ask(`Upgrade ${list.length} executors (${list.map((e) => `${e.host} ${KIND_NAME[e.executor]}`).join(", ")}), one after the other? A failed one stops the rest.`, { confirm: `Upgrade ${list.length}` }))) return;
    setError("");
    api.upgradeOutdated().then(onChanged, (x: Error) => setError(x.message));
  };
  return { one, all, error };
}

/** What needs someone, worst first: executors offline, a stopped upgrade, upgrades to start, a newer Deployer. */
export function NeedsYou({ data, onChanged, onHosts }: { data: PlatformView; onChanged: () => void; onHosts?: () => void }) {
  const { all, error } = useUpgrade(data, onChanged);
  const items: { tone: "bad" | "warn"; tag: string; title: string; detail: string; action?: { label: string; run: () => void } }[] = [];
  const appsOn = (host: string) => data.hosts?.find((h) => h.host === host)?.apps ?? [];
  for (const e of data.executors) {
    if (e.online || active(e.upgrade.job?.state)) continue;
    const apps = e.executor === "deploy" ? appsOn(e.host) : [];
    items.push({ tone: "bad", tag: "Failing", title: `${e.host}: ${KIND_NAME[e.executor]} offline`,
      detail: `${e.reason ?? "No heartbeat"}.${apps.length ? ` Deploys of ${apps.join(", ")} wait until it is back.` : ""}`,
      ...(onHosts ? { action: { label: "Open Hosts", run: onHosts } } : {}) });
  }
  const b = data.batch;
  if (b?.stopped && !b.finishedAt) items.push({ tone: "bad", tag: "Stopped", title: "The executor upgrade stopped", detail: `At ${entryName(b.stopped)}${b.remaining.length ? `; not upgraded: ${b.remaining.map(entryName).join(", ")}` : ""}.` });
  const d = data.deployer;
  if (d.job && !active(d.job.state) && d.job.state !== "succeeded" && d.job.version !== d.version) items.push({ tone: "bad", tag: "Failed", title: `The Deployer upgrade to ${d.job.version} did not finish`, detail: d.job.message ?? d.job.state });
  const list = startable(data);
  if (list.length && !b?.current) {
    const kinds = [...new Set(list.map((e) => e.executor))];
    const title = kinds.length === 1
      ? `${kinds[0] === "service" ? "Service" : "Deploy"} executor ${data.shippedVersions[kinds[0]!]} available on ${list.length} host${list.length > 1 ? "s" : ""}`
      : `${list.length} executor upgrades available`;
    const others = (["deploy", "service"] as ExecutorKind[]).filter((k) => !kinds.includes(k) && data.executors.some((e) => e.executor === k));
    items.push({ tone: "warn", tag: "Upgrade", title,
      detail: `${list.map((e) => `${e.host} ${e.version} → ${e.shipped}`).join(", ")}.${others.length ? ` ${others.map((k) => KIND_NAME[k][0]!.toUpperCase() + KIND_NAME[k].slice(1)).join(" and ")}s are up to date.` : ""}`,
      ...(data.canUpgrade ? { action: { label: list.length > 1 ? `Upgrade ${list.length}` : "Upgrade", run: all } } : {}) });
  }
  if (d.latest && !active(d.job?.state)) items.push({ tone: "warn", tag: "Upgrade", title: `Deployer ${d.latest} available`, detail: `Running ${d.version}. Review the upgrade under Hosts & executors.` });
  if (!items.length) return null;
  return (
    <section className={`card needs ${items.some((i) => i.tone === "bad") ? "bad" : "warn"}`}>
      <h2>Needs you · {items.length}</h2>
      {items.map((i) => (
        <div key={i.title} className="needs-item">
          <span className={`badge ${i.tone}`}>{i.tag}</span>
          <div className="needs-text"><strong>{i.title}</strong><div className="muted">{i.detail}</div></div>
          {i.action && <button className="primary" onClick={i.action.run}>{i.action.label}</button>}
        </div>
      ))}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

/** Hosts & executors: the Deployer, then one row per host with its two executors. */
export function Platform({ data, error, onChanged }: { data: PlatformView | undefined; error: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  if (!data) return error ? <p className="error">{error}</p> : null;
  const d = data.deployer;
  const upgrading = active(d.job?.state) || data.executors.some((e) => active(e.upgrade.job?.state));
  const attention = Boolean(d.latest) || data.executors.some((e) => e.upgrade.available || !e.online) || upgrading || Boolean(data.batch?.stopped && !data.batch.finishedAt);
  const shown = attention || open;
  return (
    <section className="card platform">
      <div className="toolbar">
        <h2>Hosts &amp; executors</h2>
        <span className="muted">Only what is installed on each host is shown</span>
        {!attention && <button className="link" onClick={() => setOpen(!open)}>{open ? "Fold" : "Show hosts"}</button>}
      </div>
      {!shown && (
        <p className="banner ok">
          <strong>All healthy</strong> Deployer {d.version} · {hostsOf(data).length} host{hostsOf(data).length === 1 ? "" : "s"} · {data.executors.length} executor{data.executors.length === 1 ? "" : "s"} online · all up to date
        </p>
      )}
      {shown && <>
        <DeployerRow data={data} onChanged={onChanged} />
        <HostGrid data={data} onChanged={onChanged} />
      </>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

const hostsOf = (data: PlatformView) => data.hosts ?? [...new Set(data.executors.map((e) => e.host))].map((host) => ({ host, address: null, apps: [] as string[] }));

function HostGrid({ data, onChanged }: { data: PlatformView; onChanged: () => void }) {
  const { one, error } = useUpgrade(data, onChanged);
  const batch = data.batch;
  const batchRunning = Boolean(batch?.current);
  const slot = (host: string, kind: ExecutorKind) => {
    const e = data.executors.find((x) => x.host === host && x.executor === kind);
    if (!e) return <div className="slot"><span className="badge none">Not installed</span><div className="small muted">Not needed on this host</div></div>;
    const u = e.upgrade;
    const running = active(u.job?.state);
    const never = !e.version;
    const pill = running ? <><JobState state={u.job!.state} /> <span className="muted">upgrading to {u.job!.version}</span></>
      : !e.online ? <span className="badge bad">{never ? "Missing" : `Offline · ${e.version}`}</span>
      : u.available ? <span className="badge warn">{e.version} → {e.shipped}</span>
      : <span className="badge ok">Online · {e.version}</span>;
    const note = running ? "Restarts the executor" + (kind === "service" ? "; NiFi keeps running" : "")
      : !e.online ? e.reason ?? "No heartbeat"
      : u.available && u.blocked ? u.blocked
      : u.available ? "Online"
      : "Up to date";
    return (
      <div className="slot">
        <div className="row">
          {pill}
          {data.canUpgrade && !running && !batchRunning && u.available && !u.blocked && <button className="link" onClick={() => one(e)}>Upgrade</button>}
        </div>
        <div className="small muted">{note}</div>
        {!running && u.job && u.job.state !== "succeeded" && u.job.version === e.shipped && <div className="small muted">Last try: {u.job.message}</div>}
      </div>
    );
  };
  return (
    <div className="host-grid">
      <p className="small muted">Ships deploy executor <span className="mono">{data.shippedVersions.deploy}</span> · service executor <span className="mono">{data.shippedVersions.service}</span></p>
      {batch && batchRunning && !batch.finishedAt && (
        <p className="small muted">Upgrading one executor after the other: {entryName(batch.current!.host)} now{batch.remaining.length ? `, then ${batch.remaining.map(entryName).join(", ")}` : ""}.</p>
      )}
      <div className="host-row head"><span>Host</span><span>Deploy executor</span><span>Service executor</span></div>
      {hostsOf(data).map((h) => (
        <div key={h.host} className="host-row">
          <div><div className="mono">{h.host}</div><div className="small muted">{[h.address, h.apps.length ? `${h.apps.length} app${h.apps.length === 1 ? "" : "s"}` : "no apps"].filter(Boolean).join(" · ")}</div></div>
          {slot(h.host, "deploy")}
          {slot(h.host, "service")}
        </div>
      ))}
      {error && <p className="error">{error}</p>}
    </div>
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
        {!d.latest && !running && <span className="badge ok">Up to date</span>}
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
