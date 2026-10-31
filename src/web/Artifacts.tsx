// Phase 4 page (design §6.1): every image this environment built or ran, by digest — where it came from,
// its BUILD.json, and each deploy that used it.

import { useEffect, useState } from "react";
import * as api from "./api.ts";
import type { ArtifactView } from "./api.ts";
import { BASIS, JobState } from "./Deploy.tsx";

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { hour12: false });
const ORIGIN: Record<string, string> = { build: "Built here", pulled: "Pulled by tag", uat: "Digest from UAT", pinned: "Back to an old version by digest" };

export function Artifacts() {
  const [list, setList] = useState<ArtifactView[] | undefined>();
  const [app, setApp] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { api.artifacts().then((d) => setList(d.artifacts), (e: Error) => setError(e.message)); }, []);
  if (error) return <p className="error">{error}</p>;
  if (!list) return <p className="muted">Loading…</p>;
  const apps = [...new Set(list.map((a) => a.app))].sort();
  const shown = app ? list.filter((a) => a.app === app) : list;
  return (
    <>
      <div className="toolbar">
        <h1>Artifacts</h1>
        <select value={app} onChange={(e) => setApp(e.target.value)}>
          <option value="">All apps</option>
          {apps.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <span className="muted">Artifacts are immutable: app@version + service + digest. Build once, deploy many times: PROD deploys exactly the digest UAT verified.</span>
      </div>
      <table>
        <thead><tr><th>App</th><th>Version</th><th>Service</th><th>Image</th><th>Origin</th><th>BUILD.json</th><th>Deploys</th></tr></thead>
        <tbody>
          {shown.map((a) => (
            <tr key={`${a.app}-${a.service}-${a.digest}`}>
              <td>{a.app}</td>
              <td className="mono">{a.version}</td>
              <td className="mono">{a.service}</td>
              <td className="mono value" title={`${a.ref}@${a.digest}`}>{a.ref}<div className="muted">{a.digest.slice(0, 19)}…</div></td>
              <td>{ORIGIN[a.origin] ?? a.origin}<div className="muted">{when(a.seenAt)}</div></td>
              <td className="mono">{a.build ? <span title={JSON.stringify(a.build)}>{String(a.build.version ?? "")} {String(a.build.commit ?? "").slice(0, 10)}</span> : <span className="muted">—</span>}</td>
              <td>
                {a.deployments.length ? a.deployments.map((d) => (
                  <div key={d.id}><JobState state={d.state} /> <span className="muted">{d.environment.toUpperCase()} {when(d.at)} {d.by}{d.promotion ? ` · ${BASIS[d.promotion] ?? d.promotion}` : ""}</span></div>
                )) : <span className="muted">Not deployed yet</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {shown.length === 0 && <p className="muted">No artifacts yet: they appear here after the first build or deploy.</p>}
    </>
  );
}
