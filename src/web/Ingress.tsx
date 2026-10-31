// D36 page: how each app is reached (through nginx at https://<domain>:<port>, or directly at <host>:<port>), the
// recommended nginx configuration that operations apply, kept as revisions with what changed, and the internal CA
// an administrator configures for the containers.

import { useCallback, useEffect, useState } from "react";
import * as api from "./api.ts";
import type { IngressView } from "./api.ts";

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { hour12: false });
const KIND: Record<string, string> = { nginx: "Through nginx", direct: "Direct", none: "Not reachable from outside its host" };

export function IngressPage() {
  const [data, setData] = useState<IngressView | undefined>();
  const [error, setError] = useState("");
  const [view, setView] = useState<"apps" | "nginx" | "ca">("apps");
  const refresh = useCallback(() => { api.ingress().then(setData, (e: Error) => setError(e.message)); }, []);
  useEffect(refresh, [refresh]);
  if (!data) return error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>;
  const behindNginx = data.endpoints.some((e) => e.kind === "nginx");
  const pending = (behindNginx || Boolean(data.nginx.latest)) && data.nginx.latest?.sha256 !== data.nginx.sha256;
  return (
    <>
      <div className="toolbar">
        <h1>Ingress</h1>
        <span className="muted">One DNS name{data.domain ? ` (${data.domain})` : ""}; nginx tells apps apart by port and ends HTTPS, apps run plain HTTP. nginx is kept by operations: the Deployer only recommends its configuration.</span>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="subtabs">
        <button className={view === "apps" ? "active" : ""} onClick={() => setView("apps")}>Addresses</button>
        <button className={view === "nginx" ? "active" : ""} onClick={() => setView("nginx")}>nginx configuration{pending && <span className="badge warn">Changed</span>}</button>
        <button className={view === "ca" ? "active" : ""} onClick={() => setView("ca")}>Internal CA</button>
      </div>
      {view === "apps" && <Addresses data={data} />}
      {view === "nginx" && (behindNginx || data.nginx.latest ? <Nginx data={data} onSaved={refresh} /> : <p className="muted">No app goes through nginx in this environment: give an app <span className="mono">{"\"ingress\": { \"kind\": \"nginx\", \"port\": … }"}</span> in environment.json.</p>)}
      {view === "ca" && <Ca data={data} onSaved={refresh} />}
    </>
  );
}

function Addresses({ data }: { data: IngressView }) {
  return (
    <>
      <table>
        <thead><tr><th>App</th><th>Host</th><th>How</th><th>Address</th><th>nginx forwards to</th></tr></thead>
        <tbody>
          {data.endpoints.map((e) => (
            <tr key={e.app}>
              <td>{e.app}</td>
              <td className="mono">{e.host}</td>
              <td>{KIND[e.kind] ?? e.kind}</td>
              <td className="mono">{e.url ? <a href={e.url} target="_blank" rel="noreferrer">{e.url}</a> : e.problem ? <span className="error">{e.problem}</span> : <span className="muted">—</span>}</td>
              <td className="mono">{e.upstream ?? <span className="muted">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">Set in environment.json: <span className="mono">domain</span>, each host's <span className="mono">address</span>, and each app's <span className="mono">ingress</span> (<span className="mono">{"{ \"kind\": \"nginx\", \"port\": 8787 }"}</span> or <span className="mono">{"{ \"kind\": \"direct\" }"}</span>). Apps refer to each other as <span className="mono">{"{{app:oma.url}}"}</span> in env values and compose environment; the Deployer writes the address in.</p>
    </>
  );
}

function Nginx({ data, onSaved }: { data: IngressView; onSaved: () => void }) {
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const latest = data.nginx.latest;
  const pending = latest?.sha256 !== data.nginx.sha256;
  const save = () => { setError(""); api.saveNginx(note).then(() => { setNote(""); onSaved(); }, (e: Error) => setError(e.message)); };
  return (
    <>
      <section className="card panel">
        <div className="toolbar">
          <h2>{pending ? (latest ? `Changed since revision ${latest.revision}` : "Not saved yet") : `Same as revision ${latest!.revision}`}</h2>
          <span className="muted">{latest ? `Revision ${latest.revision} saved by ${latest.savedBy} at ${when(latest.savedAt)}${latest.note ? `: ${latest.note}` : ""}` : "Save a revision, then hand it to operations."}</span>
          {latest && <a className="button" href={api.nginxRevisionUrl(latest.revision)}>Download revision {latest.revision}</a>}
        </div>
        {data.nginx.problems.length > 0 && <ul className="findings">{data.nginx.problems.map((p) => <li key={p} className="error">✕ {p}: left out of the configuration</li>)}</ul>}
        {pending && data.canSave && (
          <div className="row">
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why (e.g. OMA moved to app2); kept with the revision" style={{ flex: 1 }} />
            <button className="primary" onClick={save}>Save as revision {(latest?.revision ?? 0) + 1}</button>
          </div>
        )}
        {error && <p className="error">{error}</p>}
        {data.nginx.diff && <details open><summary>What changes against revision {latest!.revision}</summary><pre className="diff">{data.nginx.diff.split("\n").map((l, i) => <span key={i} className={l.startsWith("+ ") ? "add" : l.startsWith("- ") ? "del" : ""}>{l}{"\n"}</span>)}</pre></details>}
        <details open={!data.nginx.diff}><summary>Recommended configuration now</summary><pre className="json">{data.nginx.body}</pre></details>
      </section>
      <h3>Revisions</h3>
      <table>
        <thead><tr><th>Revision</th><th>Saved</th><th>Who</th><th>Note</th><th></th></tr></thead>
        <tbody>
          {data.revisions.map((r) => (
            <tr key={r.revision}>
              <td>{r.revision}{r.revision === latest?.revision && <span className="badge info">Latest</span>}</td>
              <td className="muted">{when(r.savedAt)}</td>
              <td>{r.savedBy}</td>
              <td className="muted">{r.note ?? ""}</td>
              <td><a href={api.nginxRevisionUrl(r.revision)}>Download</a></td>
            </tr>
          ))}
          {!data.revisions.length && <tr><td colSpan={5} className="muted">No revisions yet.</td></tr>}
        </tbody>
      </table>
    </>
  );
}

function Ca({ data, onSaved }: { data: IngressView; onSaved: () => void }) {
  const [pem, setPem] = useState("");
  const [error, setError] = useState("");
  const save = (value: string) => { setError(""); api.setCa(value).then(() => { setPem(""); onSaved(); }, (e: Error) => setError(e.message)); };
  return (
    <section className="card panel">
      <p className="muted">The company's internal CA, so containers trust the HTTPS addresses of other apps behind nginx. Every deploy mounts it at <span className="mono">/etc/open-atlas/ca.pem</span> and sets <span className="mono">NODE_EXTRA_CA_CERTS</span> (added to the system CAs, never replacing them). A JVM app (Studio) needs a truststore: point <span className="mono">JAVA_OPTS</span> at one in its env file. The Deployer uses it for the check after a deploy.</p>
      {data.ca ? (
        <table><tbody>
          <tr><th>Subject</th><td className="mono">{data.ca.subject}</td></tr>
          <tr><th>Issuer</th><td className="mono">{data.ca.issuer}</td></tr>
          <tr><th>Valid until</th><td>{data.ca.validTo}</td></tr>
          <tr><th>SHA-256</th><td className="mono">{data.ca.fingerprint256}</td></tr>
        </tbody></table>
      ) : <p>No internal CA is configured.</p>}
      {data.canSetCa && (
        <>
          <textarea className="mono" rows={6} spellCheck={false} value={pem} onChange={(e) => setPem(e.target.value)} placeholder="-----BEGIN CERTIFICATE-----&#10;…&#10;-----END CERTIFICATE-----" />
          <div className="row">
            <button className="primary" disabled={!pem.trim()} onClick={() => save(pem)}>{data.ca ? "Replace" : "Save"}</button>
            {data.ca && <button className="danger" onClick={() => { if (confirm("Remove the internal CA? Deploys from now on stop mounting it.")) save(""); }}>Remove</button>}
            <span className="muted">Takes effect at each app's next deploy.</span>
          </div>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
