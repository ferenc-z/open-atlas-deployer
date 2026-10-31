// D35 page: the hosts of this environment (environment.json hosts), each running an executor that calls the Deployer
// over HTTPS with its own token. An administrator issues a host's token here (shown once) and can revoke it.

import { useCallback, useEffect, useState } from "react";
import * as api from "./api.ts";
import type { HostView } from "./api.ts";

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { hour12: false });

export function HostsPage({ isAdmin }: { isAdmin: boolean }) {
  const [list, setList] = useState<HostView[] | undefined>();
  const [error, setError] = useState("");
  const [issued, setIssued] = useState<{ host: string; token: string } | undefined>();
  const refresh = useCallback(() => { api.hosts().then((r) => setList(r.hosts), (e: Error) => setError(e.message)); }, []);
  useEffect(() => { refresh(); const t = setInterval(refresh, 10_000); return () => clearInterval(t); }, [refresh]);
  const issue = (id: string) => {
    if (!confirm(`Issue a new executor token for ${id}? Earlier tokens of ${id} keep working until revoked.`)) return;
    api.issueHostToken(id).then((r) => { setIssued(r); refresh(); }, (e: Error) => setError(e.message));
  };
  const revoke = (id: string) => {
    if (!confirm(`Revoke every executor token of ${id}? Its executor stops reaching the Deployer at once.`)) return;
    api.revokeHost(id).then(refresh, (e: Error) => setError(e.message));
  };
  if (!list) return error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>;
  return (
    <>
      <div className="toolbar">
        <h1>Hosts</h1>
        <span className="muted">Each host runs an executor that calls the Deployer with its own token; the Deployer never connects to a host. Hosts and where each app runs are set in environment.json.</span>
      </div>
      {error && <p className="error">{error}</p>}
      {issued && (
        <div className="banner warn">
          Token for <strong>{issued.host}</strong>, shown only once: <code className="mono">{issued.token}</code>{" "}
          <button className="link" onClick={() => navigator.clipboard?.writeText(issued.token)}>Copy</button>
          <div className="muted">Put it on {issued.host} in the file EXECUTOR_TOKEN_FILE names (mode 600), then restart the executor there.</div>
        </div>
      )}
      <table>
        <thead><tr><th>Host</th><th>Address</th><th>Executor</th><th>Apps</th><th>Containers reported</th><th>Tokens</th><th></th></tr></thead>
        <tbody>
          {list.map((h) => {
            const live = h.tokens.filter((t) => !t.revokedAt);
            return (
              <tr key={h.id}>
                <td className="mono">{h.id}</td>
                <td className="mono">{h.address ?? <span className="muted">—</span>}</td>
                <td>
                  {h.executor.online
                    ? <><span className="badge ok">Online</span> <span className="muted">{h.executor.heartbeat?.version}{h.executor.heartbeat?.busy ? ` · running ${h.executor.heartbeat.busy}` : ""}</span></>
                    : <><span className="badge bad">Offline</span> <span className="muted">{h.executor.reason}</span></>}
                </td>
                <td>{h.apps.length ? h.apps.join(", ") : <span className="muted">None</span>}</td>
                <td>{h.report ? <>{h.report.containers} <span className="muted">at {when(h.report.at)}</span>{h.report.stale && <span className="badge warn">Stale</span>}</> : <span className="muted">Not yet</span>}</td>
                <td>{live.length ? live.map((t) => <span key={t.prefix} className="mono" title={`Issued by ${t.createdBy} at ${when(t.createdAt)}`}>{t.prefix}… </span>) : <span className="muted">None</span>}</td>
                <td className="actions">
                  {isAdmin && <button className="link" onClick={() => issue(h.id)}>Issue token</button>}
                  {isAdmin && live.length > 0 && <button className="link danger" onClick={() => revoke(h.id)}>Revoke</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
