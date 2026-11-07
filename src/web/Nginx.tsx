// Phase 2 step 6 (§9.4, §15.3): a service's nginx address on its Overview. Studio's nifi-ops graph reaches NiFi only
// through it; the Deployer checks /flow/about through it when it is saved, and publishes the graph again.

import { useCallback, useEffect, useState } from "react";
import * as api from "./api.ts";
import type { GraphState, NginxCheck, ServiceStatus } from "./api.ts";
import { ask } from "./Confirm.tsx";
import { ago, when } from "./svc.tsx";

function CheckLine({ check }: { check: NginxCheck | null }) {
  if (!check) return <span className="muted small">Not checked yet.</span>;
  return (
    <span className="small" title={when(check.at)}>
      {check.ok
        ? <><span className="badge ok">reachable</span> NiFi <span className="mono">{check.version}</span> answered <span className="mono">/flow/about</span> in {check.ms} ms</>
        : <><span className="badge bad">failed</span> {check.error}</>}
      <span className="muted"> · checked {ago(check.at)}</span>
    </span>
  );
}

export function NginxAddress({ s, onChanged }: { s: ServiceStatus; onChanged: () => void }) {
  const [graph, setGraph] = useState<GraphState | undefined>();
  const [value, setValue] = useState(s.nginxUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const loadGraph = useCallback(() => { api.serviceGraph().then(setGraph, () => setGraph(undefined)); }, []);
  useEffect(() => { loadGraph(); }, [loadGraph, s.nginxUrl]);
  useEffect(() => { setValue(s.nginxUrl ?? ""); }, [s.nginxUrl]);
  const canEdit = graph?.canPublish ?? false;
  const run = graph?.runs.find((r) => r.services.includes(s.id) || r.state !== "published");
  const save = async (url: string | null) => {
    const question = url
      ? `Set the nginx address of ${s.id} to ${url}? The Deployer checks /flow/about through it and publishes the ${graph?.graph ?? "nifi-ops"} graph to Studio again.`
      : `Remove the nginx address of ${s.id}? It leaves the ${graph?.graph ?? "nifi-ops"} graph at the next publication.`;
    if (!(await ask(question, { confirm: url ? "Save and check" : "Remove", danger: !url }))) return;
    setBusy(true); setError("");
    api.putServiceNginx(s.id, url).then(() => { onChanged(); setTimeout(loadGraph, 1500); }, (e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  const recheck = () => { setBusy(true); setError(""); api.checkServiceNginx(s.id).then(onChanged, (e: Error) => setError(e.message)).finally(() => setBusy(false)); };
  return (
    <div>
      <h3>nginx address for Studio</h3>
      <p className="muted small">
        Studio's <span className="mono">{graph?.graph ?? "nifi-ops"}</span> graph reads this {s.kind === "cluster" ? "cluster" : "instance"}'s queues, processors and bulletins live,
        only through nginx (provenance is not in the graph: the FlowFile trace tab asks NiFi through the service executor). Operations configure that nginx: it holds the NiFi client certificate (NiFi grants its identity read on /flow, /system,
        /controller and the process groups){s.kind === "cluster" ? ", and puts every node of the cluster behind this one address so that it moves on when a node is down" : ""}.
        Give the address without <span className="mono">/nifi-api</span>, e.g. <span className="mono">https://nifi-ops.example.internal:8443</span>.
      </p>
      {canEdit
        ? <div className="row">
            <input className="mono" type="url" value={value} placeholder="https://nginx-host:port" onChange={(e) => setValue(e.target.value)} style={{ minWidth: 360 }} aria-label="nginx address" />
            <button className="primary" disabled={busy || !value.trim() || value.trim() === s.nginxUrl} onClick={() => save(value.trim())}>Save and check</button>
            {s.nginxUrl && <button disabled={busy} onClick={recheck}>Check again</button>}
            {s.nginxUrl && <button className="link" disabled={busy} onClick={() => save(null)}>Remove</button>}
          </div>
        : <p className="mono">{s.nginxUrl ?? <span className="muted">not set</span>}</p>}
      {s.nginxUrl && <p><CheckLine check={s.nginxCheck} /></p>}
      {error && <div className="error">{error}</div>}
      {graph && <p className="muted small">
        {!graph.configured ? "Studio's Builder MCP is not configured in this Deployer (Settings → Studio), so the graph is not published."
          : run ? <>Graph {run.graph ?? graph.graph}: <span className={`badge ${run.state === "published" ? "ok" : run.state === "failed" ? "bad" : "muted"}`}>{run.state}</span> {ago(run.at)} — {run.message}</>
          : "The graph has not been published yet."}
      </p>}
      {!canEdit && <p className="muted small">Only Workbench admins set the nginx address.</p>}
    </div>
  );
}
