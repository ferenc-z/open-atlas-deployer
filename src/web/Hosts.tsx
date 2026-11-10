// D35 page: the hosts of this environment (environment.json hosts), each running an executor that calls the Deployer
// over HTTPS with its own token. An administrator issues a host's token here (shown once) and can revoke it. Upgrades of
// the executors and of the Deployer are on the Overview (D39); hosts are added in the environment settings (D38).
// S18: a host runs a deploy executor, a service executor (managed services such as NiFi, no Docker), or both; each has
// its own tokens, and the service executor takes no deploy jobs.

import { useCallback, useEffect, useState } from "react";
import * as api from "./api.ts";
import type { ExecutorInfo, ExecutorKind, ExecutorUpgrade, HostView } from "./api.ts";
import { ask } from "./Confirm.tsx";
import { JobState } from "./Deploy.tsx";

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { hour12: false });
const NAME: Record<ExecutorKind, string> = { deploy: "deploy executor", service: "service executor" };

/** The deploy executor is listed unless the host only has a service executor (no deploy token, no heartbeat, no apps). */
const hasDeploy = (h: HostView) => !h.service || h.apps.length > 0 || Boolean(h.executor.heartbeat) || h.tokens.some((t) => t.executor === "deploy");

/** §16.3 step 16: the service executor's upgrade, offered here as well as on the Overview; same API, same blocks. */
function UpgradeLine({ upgrade, shipped, isAdmin, onUpgrade }: { upgrade: ExecutorUpgrade; shipped: string; isAdmin: boolean; onUpgrade: () => void }) {
  const running = upgrade.job?.state === "queued" || upgrade.job?.state === "running";
  if (running) return <div className="small muted"><JobState state={upgrade.job!.state} /> upgrading to {upgrade.job!.version}</div>;
  if (!upgrade.available) return null;
  return (
    <div className="small">
      <span className="badge warn">{shipped} available</span>{" "}
      {upgrade.blocked ? <span className="muted">{upgrade.blocked}</span> : isAdmin && <button className="link" onClick={onUpgrade}>Upgrade</button>}
    </div>
  );
}

function ExecutorLine({ kind, info, labelled }: { kind: ExecutorKind; info: ExecutorInfo; labelled: boolean }) {
  const beat = info.heartbeat;
  return (
    <div>
      {labelled && <span className={`badge ${kind === "service" ? "info" : "muted"}`}>{kind === "service" ? "Service executor" : "Deploy executor"}</span>}{" "}
      {info.online
        ? <><span className="badge ok">Online</span> <span className="muted">{beat?.version}{beat?.busy ? ` · running ${beat.busy}` : ""}{beat?.reading?.length ? ` · reading ${beat.reading.length}` : ""}</span></>
        : <><span className="badge bad">Offline</span> <span className="muted">{info.reason}</span></>}
      {kind === "service" && beat && (beat.isRoot
        ? <span className="muted"> · runs as root</span>
        : <> <span className="badge warn" title="Not root: it sees and manages only the services this user runs">Not root</span> <span className="muted">runs as {beat.user ?? "an ordinary user"}: manages only {beat.user ?? "that user"}'s services</span></>)}
      {kind === "service" && <div className="muted">Takes no deploy jobs.</div>}
    </div>
  );
}

/** `compact`: inside a setup step, only the host, its executor and its tokens. */
export function HostsPage({ isAdmin, compact = false }: { isAdmin: boolean; compact?: boolean }) {
  const [list, setList] = useState<HostView[] | undefined>();
  const [shipped, setShipped] = useState("");
  const [error, setError] = useState("");
  const [issued, setIssued] = useState<{ host: string; executor: ExecutorKind; token: string } | undefined>();
  const refresh = useCallback(() => { api.hosts().then((r) => { setList(r.hosts); setShipped(r.executorVersion); }, (e: Error) => setError(e.message)); }, []);
  useEffect(() => { refresh(); const t = setInterval(refresh, 10_000); return () => clearInterval(t); }, [refresh]);
  const issue = async (id: string, kind: ExecutorKind) => {
    if (!(await ask(`Issue a new ${NAME[kind]} token for ${id}? Earlier ${NAME[kind]} tokens of ${id} keep working until revoked.`, { confirm: "Issue token" }))) return;
    api.issueHostToken(id, kind).then((r) => { setIssued(r); refresh(); }, (e: Error) => setError(e.message));
  };
  const upgradeService = async (h: HostView) => {
    const from = h.service?.heartbeat?.version ?? "?";
    if (!(await ask(`Upgrade the service executor on ${h.id} from ${from} to ${shipped}? It takes the release from the host's own source and restarts; if the new version does not start, it goes back by itself. Services it started keep running.`, { confirm: "Upgrade" }))) return;
    setError("");
    api.upgradeExecutor(h.id, "service").then(refresh, (e: Error) => setError(e.message));
  };
  const revoke = async (id: string, kind: ExecutorKind) => {
    if (!(await ask(`Revoke every ${NAME[kind]} token of ${id}? That executor stops reaching the Deployer at once.`, { confirm: "Revoke", danger: true }))) return;
    api.revokeHost(id, kind).then(refresh, (e: Error) => setError(e.message));
  };
  if (!list) return error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>;
  return (
    <>
      {!compact && <div className="toolbar">
        <h1>Hosts</h1>
        <span className="muted">Each host runs a deploy executor, a service executor (managed services such as NiFi; no Docker), or both. Each calls the Deployer with its own token; the Deployer never connects to a host. Hosts and where each app runs are set in Environment settings; upgrades of the executors are on the Overview (a service executor's is here too).</span>
      </div>}
      {error && <p className="error">{error}</p>}
      {issued && (
        <div className="banner warn">
          {issued.executor === "service" ? "Service executor token" : "Token"} for <strong>{issued.host}</strong>, shown only once: <code className="mono">{issued.token}</code>{" "}
          <button className="link" onClick={() => navigator.clipboard?.writeText(issued.token)}>Copy</button>
          <div className="muted">Put it on {issued.host} in the file EXECUTOR_TOKEN_FILE names in {issued.executor === "service" ? "service-executor.env" : "executor.env"} (mode 600), then restart that executor there.</div>
        </div>
      )}
      <table>
        <thead><tr><th>Host</th>{!compact && <th>Address</th>}<th>Executors</th>{!compact && <><th>Apps</th><th>Containers reported</th></>}<th>Tokens</th><th></th></tr></thead>
        <tbody>
          {list.map((h) => {
            const live = h.tokens.filter((t) => !t.revokedAt);
            const kinds: ExecutorKind[] = [...(hasDeploy(h) ? ["deploy" as const] : []), ...(h.service ? ["service" as const] : [])];
            const labelled = Boolean(h.service);
            return (
              <tr key={h.id}>
                <td className="mono">{h.id}</td>
                {!compact && <td className="mono">{h.address ?? <span className="muted">—</span>}</td>}
                <td>{kinds.map((k) => (
                  <div key={k}>
                    <ExecutorLine kind={k} info={k === "service" ? h.service! : h.executor} labelled={labelled} />
                    {k === "service" && h.serviceUpgrade && !compact && <UpgradeLine upgrade={h.serviceUpgrade} shipped={shipped} isAdmin={isAdmin} onUpgrade={() => upgradeService(h)} />}
                  </div>
                ))}</td>
                {!compact && <td>{h.apps.length ? h.apps.join(", ") : <span className="muted">None</span>}</td>}
                {!compact && <td>{h.report ? <>{h.report.containers} <span className="muted">at {when(h.report.at)}</span>{h.report.stale && <span className="badge warn">Stale</span>}</> : <span className="muted">Not yet</span>}</td>}
                <td>{live.length ? live.map((t) => <span key={t.prefix} className="mono" title={`${NAME[t.executor]} token, issued by ${t.createdBy} at ${when(t.createdAt)}`}>{t.prefix}…{labelled ? ` (${t.executor})` : ""} </span>) : <span className="muted">None</span>}</td>
                <td className="actions">
                  {isAdmin && <button className="link" onClick={() => issue(h.id, "deploy")}>{compact ? "Issue token" : "Issue deploy token"}</button>}
                  {isAdmin && !compact && <button className="link" onClick={() => issue(h.id, "service")}>Issue service token</button>}
                  {isAdmin && (["deploy", "service"] as const).filter((k) => live.some((t) => t.executor === k)).map((k) => (
                    <button key={k} className="link danger" onClick={() => revoke(h.id, k)}>{labelled || k === "service" ? `Revoke ${k}` : "Revoke"}</button>
                  ))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
