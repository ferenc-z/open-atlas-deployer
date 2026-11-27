// Managed services > Certificates (S41, prototype screen 6): the certificate library. One entry per certificate, kept as
// versions; a dropped new version is checked against every service that uses the entry before it is saved. Files and
// passwords are kept encrypted by the Deployer and never shown here.

import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "./api.ts";
import type { CertLibrary, CertUploadCheck, CertVersionView, NifiCertView } from "./api.ts";
import { ask } from "./Confirm.tsx";
import { certTone, daysLeft } from "./svc.tsx";

const day = (iso: string) => iso.slice(0, 10);
const inDays = (iso: string) => { const d = daysLeft(iso); return d < 0 ? `Expired ${-d} days ago` : d === 0 ? "Expires today" : `Expires in ${d} days`; };
const names = (v: Pick<CertVersionView, "san">) => v.san.map((e) => e.value).join(", ") || "—";
/** The version a service uses, as the library lists it. */
const versionOf = (c: NifiCertView, n: number) => c.versions.find((v) => v.version === n);
/** What creating drafts did: one draft per service, and why the others got none. */
export const draftsText = (r: api.CertDraftsResult) => [
  r.drafts.length ? `Draft${r.drafts.length === 1 ? "" : "s"} created for ${r.drafts.map((d) => d.service).join(", ")}: review and save ${r.drafts.length === 1 ? "it" : "each"} on the service's Drafts page.` : "No draft created.",
  ...r.skipped.map((s) => `${s.service}: ${s.message}`),
].join(" ");

export function CertificatesPage({ isAdmin, onOpenService }: { isAdmin: boolean; onOpenService: (id: string) => void }) {
  const [lib, setLib] = useState<CertLibrary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => { api.nifiCerts().then(setLib).catch((e: Error) => setError(e.message)); }, []);
  useEffect(() => { if (isAdmin) load(); }, [isAdmin, load]);
  if (!isAdmin) return <section className="panel"><h1>Certificates</h1><p className="muted">Only administrators see and change the certificate library.</p></section>;
  if (error) return <section className="panel"><h1>Certificates</h1><p className="error">{error}</p></section>;
  if (!lib) return <p className="muted">Loading…</p>;

  // The headline is the soonest expiry among the versions in use.
  const inUse = lib.certs.flatMap((c) => c.versions.filter((v) => v.usedBy.length).map((v) => ({ c, v })));
  const soonest = inUse.sort((a, b) => (a.v.notAfter < b.v.notAfter ? -1 : 1))[0];
  const days = soonest ? daysLeft(soonest.v.notAfter) : null;
  const tone = days === null ? "muted" : certTone(days);
  const headline = !lib.certs.length ? "No certificate in the library yet"
    : soonest ? `${soonest.c.name} ${inDays(soonest.v.notAfter).toLowerCase()} · used by ${soonest.v.usedBy.length} service${soonest.v.usedBy.length === 1 ? "" : "s"}`
    : "No service uses a certificate from the library yet";

  return (
    <>
      <section className="panel">
        <h1>Certificates</h1>
        <p><strong className={`cert-head ${tone}`}>{headline}</strong></p>
        <p className="muted small">Upload a certificate once, use it on many services. NiFi and the service executor on each host both use it. Files and passwords are kept encrypted in the Deployer: nobody can download them here, and the AI only sees subject, hosts and dates.</p>
        {(lib.warnings?.alerts.length || lib.warnings?.mismatches.length) ? <ul className="findings">{[...lib.warnings.alerts.map((a) => ({ k: `${a.cert}#${a.version}`, light: a.light, text: a.text })), ...lib.warnings.mismatches.map((m) => ({ k: `${m.service}/${m.cert}`, light: "attention", text: m.text }))].map((f) => <li key={f.k}><span className={`badge ${f.light === "failing" ? "bad" : "warn"}`}>{f.light === "failing" ? "Failing" : "Attention"}</span> {f.text}</li>)}</ul> : null}
        {!lib.keyConfigured && <div className="banner bad inline">DEPLOYER_CREDENTIAL_ENCRYPTION_KEY is not set: certificates cannot be kept until it is.</div>}
      </section>
      {lib.certs.map((c) => <CertCard key={c.id} cert={c} lib={lib} reload={load} onOpenService={onOpenService} />)}
      <AddCertificate lib={lib} reload={load} />
    </>
  );
}

function CertCard({ cert, lib, reload, onOpenService }: { cert: NifiCertView; lib: CertLibrary; reload: () => void; onOpenService: (id: string) => void }) {
  const used = cert.versions.filter((v) => v.usedBy.length);
  const current = used[0] ?? cert.versions[0]!;
  const users = lib.services.filter((s) => s.bound?.cert === cert.id);
  const next = Math.max(...cert.versions.map((v) => v.version)) + 1;
  const d = daysLeft(current.notAfter);
  const edge = used.length ? (d <= 7 ? "var(--bad)" : d <= 30 ? "var(--warn)" : "var(--ok)") : "var(--border)";
  const [saved, setSaved] = useState<string | null>(null);
  const [renewing, setRenewing] = useState(false);
  const newest = cert.versions[0]!;
  const behind = users.filter((s) => s.bound!.version < newest.version);
  return (
    <section className="card cert-card" style={{ borderTop: `6px solid ${edge}` }}>
      <div className="cert-title">
        <span><strong className="cert-name">{cert.name}</strong> <span className="muted">· {used.length ? used.map((v) => `v${v.version}`).join(" and ") : "no version"} in use</span>{cert.ownService && <span className="badge info">own certificate of {cert.ownService}</span>}</span>
        <span className="muted small">Issuer {current.issuer} · {current.keystoreType} keystore, {current.truststoreType} truststore</span>
      </div>
      <div className="cert-facts">
        <span>Subject <span className="mono">{current.subject}</span></span>
        <span>SAN <span className="mono">{names(current)}</span></span>
        <span>Valid until <strong className={`cert-head ${certTone(d)}`}>{day(current.notAfter)} (v{current.version}, {inDays(current.notAfter).replace(/^Expires in /, "").replace(/^Expired /, "expired ")})</strong></span>
      </div>
      {current.eku === null && <p className="small cert-notice">Certificate has no EKU; NiFi does not restrict its use</p>}

      <table>
        <thead><tr><th>Service</th><th>Hosts</th><th>Version</th><th>Status</th></tr></thead>
        <tbody>
          {users.length === 0 && <tr><td colSpan={4} className="muted">No service uses this certificate yet.</td></tr>}
          {users.map((s) => {
            const v = versionOf(cert, s.bound!.version);
            return (
              <tr key={s.id}>
                <td><button className="link" onClick={() => onOpenService(s.id)}>{s.id}</button></td>
                <td className="mono small">{s.hosts.join(", ")}</td>
                <td className="mono">v{s.bound!.version}</td>
                <td>{v ? <span className={`badge ${certTone(daysLeft(v.notAfter))}`}>{inDays(v.notAfter)}</span> : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {behind.length > 0 && (
        <div className="cert-stage">
          <strong>{behind.length} service{behind.length === 1 ? " is" : "s are"} still on an older version: {behind.map((s) => `${s.id} (v${s.bound!.version})`).join(", ")}</strong>
          <span className="small">One draft per service puts v{newest.version} on it; a service whose check fails gets none and stays on its version.</span>
          <div className="row"><button className="primary" disabled={renewing} onClick={async () => {
            setRenewing(true);
            try { setSaved(draftsText(await api.certDrafts(cert.id, newest.version, behind.map((s) => s.id)))); reload(); }
            catch (e) { setSaved((e as Error).message); }
            finally { setRenewing(false); }
          }}>Create {behind.length} draft{behind.length === 1 ? "" : "s"} for v{newest.version}</button></div>
        </div>
      )}

      <UploadStage lib={lib} target={{ cert }} nextVersion={next} onSaved={(t) => { setSaved(t); reload(); }} />
      {saved && <div className="cert-saved"><strong>{saved}</strong><span className="small">Nothing changes on a host until a draft is saved and its change is run.</span></div>}

      <div className="cert-versions">
        <strong>Versions</strong>
        <table>
          <thead><tr><th>Version</th><th>Valid until</th><th>Uploaded</th><th>Used by</th><th /></tr></thead>
          <tbody>{cert.versions.map((v) => (
            <tr key={v.version}>
              <td className="mono">v{v.version}</td><td>{day(v.notAfter)}</td><td>{v.uploadedBy} · {day(v.uploadedAt)}</td>
              <td>{v.usedBy.length ? `${v.usedBy.length} service${v.usedBy.length === 1 ? "" : "s"}: ${v.usedBy.join(", ")}` : "none · can be deleted"}</td>
              <td><button className="link" disabled={v.usedBy.length > 0} onClick={async () => {
                if (!(await ask(`Delete v${v.version} of ${cert.name} (${v.subject}, valid until ${day(v.notAfter)})? Its files are removed from the Deployer and cannot be recovered.`, { confirm: "Delete", danger: true }))) return;
                try { await api.removeNifiCertVersion(cert.id, v.version); reload(); } catch (e) { await ask((e as Error).message, { confirm: "OK" }); }
              }}>Delete</button></td>
            </tr>
          ))}</tbody>
        </table>
        <span className="muted small">An old version stays until no service uses it, so a rollout can be rolled back. Only admins can upload, roll out or delete.</span>
      </div>
    </section>
  );
}

/** Drop (or pick) the files, see the check per service, then save. `target.cert` adds a version, no cert a new entry. */
function UploadStage({ lib, target, nextVersion, onSaved }: { lib: CertLibrary; target: { cert?: NifiCertView }; nextVersion: number; onSaved: (text: string) => void }) {
  const [files, setFiles] = useState<File[] | null>(null);
  const [check, setCheck] = useState<CertUploadCheck | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<Record<string, boolean>>({});
  const input = useRef<HTMLInputElement>(null);
  const reset = () => { setFiles(null); setCheck(null); setError(null); setPick({}); };

  const take = async (list: FileList | File[] | null) => {
    const got = Array.from(list ?? []);
    if (!got.length) return;
    setBusy(true); setError(null); setCheck(null);
    try { const r = await api.checkNifiCert(got); setFiles(got); setCheck(r); setPick(Object.fromEntries(r.services.filter((s) => s.ok).map((s) => [s.id, true]))); }
    catch (e) { setFiles(null); setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const save = async (withDrafts: boolean) => {
    if (!files) return;
    setBusy(true); setError(null);
    try {
      const r = await api.saveNifiCert(files, target.cert ? { cert: target.cert.id } : { name: name.trim() });
      const services = withDrafts ? rows.filter((s) => s.ok && pick[s.id]).map((s) => s.id) : [];
      const drafted = services.length ? await api.certDrafts(r.cert, r.version, services) : null;
      reset(); setName("");
      onSaved(`v${r.version} saved.${drafted ? ` ${draftsText(drafted)}` : ""}`);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  // The services this is for: those using the entry, or, for a new entry, every service (shown for information).
  const rows = check ? check.services.filter((s) => !target.cert || s.bound?.cert === target.cert.id) : [];
  const picked = rows.filter((s) => s.ok && pick[s.id]).length;
  const v = check?.version;
  const label = target.cert ? `v${nextVersion}` : "the certificate";

  return (
    <>
      {!check && (
        <button className="cert-drop" disabled={busy || !lib.keyConfigured} onClick={() => input.current?.click()}
          onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void take(e.dataTransfer.files); }}>
          <span className="cert-drop-title">{busy ? "Checking…" : target.cert ? "Drop a new version here" : "Drop the files here"}</span>
          <span className="muted">keystore, truststore and config.json from the TLS toolkit (passwords are read from config.json). Pick all three files together.</span>
          <input ref={input} type="file" multiple hidden onChange={(e) => { void take(e.target.files); e.target.value = ""; }} />
        </button>
      )}
      {error && <div className="banner bad inline">{error}</div>}
      {check && v && (
        <div className="cert-stage">
          <strong>{label} · valid until {day(v.notAfter)} · passwords read from config.json ✓</strong>
          <span className="mono small">{v.subject} · SAN {names(v)}</span>
          {!target.cert && <label className="small">Name <input value={name} onChange={(e) => setName(e.target.value)} placeholder="corp-nifi" maxLength={64} /></label>}
          <span className="small">{target.cert ? "Checked against every service that uses this certificate. Pick where to roll it out; a service whose check fails cannot be picked and stays on its version." : "Checked against every managed service, for information: nothing uses it until a service is moved to it."}</span>
          <table>
            <thead><tr>{target.cert && <th style={{ width: 60 }}>Use</th>}<th>Service</th><th>Checks</th></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={3} className="muted">No services to check.</td></tr>}
              {rows.map((s) => {
                const failed = s.items.filter((i) => !i.ok), notices = s.items.filter((i) => i.ok && i.notice);
                const on = s.ok && !!pick[s.id];
                return (
                  <tr key={s.id}>
                    {target.cert && <td><button className={`cert-box${on ? " on" : ""}`} disabled={!s.ok} aria-pressed={on} aria-label={`Use for ${s.id}`} onClick={() => setPick({ ...pick, [s.id]: !pick[s.id] })}>{on ? "✓" : ""}</button></td>}
                    <td><strong>{s.id}</strong></td>
                    <td>
                      {s.ok ? <span className="cert-ok">✓ {s.items.filter((i) => i.ok).map((i) => i.code === "san" ? `SAN covers ${s.hosts.join(", ")}` : null).filter(Boolean).join(" · ") || "All checks pass"}</span>
                        : failed.map((i) => <div key={i.code} className="cert-bad">✕ {i.message}</div>)}
                      {notices.map((i) => <div key={i.code} className="cert-notice small">{i.message}</div>)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="row">
            {target.cert && <button className="primary" disabled={busy || picked === 0} onClick={() => void save(true)}>{`Save ${label} and create ${picked} draft${picked === 1 ? "" : "s"}`}</button>}
            <button className={target.cert ? undefined : "primary"} disabled={busy || (!target.cert && !name.trim())} onClick={() => void save(false)}>{target.cert ? `Save ${label} only` : "Save certificate"}</button>
            <button disabled={busy} onClick={reset}>Discard</button>
          </div>
        </div>
      )}
    </>
  );
}

function AddCertificate({ lib, reload }: { lib: CertLibrary; reload: () => void }) {
  const [open, setOpen] = useState(!lib.certs.length);
  const [saved, setSaved] = useState<string | null>(null);
  return (
    <section className="card cert-add">
      <div className="cert-title">
        <span className="small">A service can also use a certificate of its own. Add a certificate to the library here, then bind it or create a draft from the service's Certificates page.</span>
        {!open && <button onClick={() => setOpen(true)}>Add a certificate</button>}
      </div>
      {open && <UploadStage lib={lib} target={{}} nextVersion={1} onSaved={(t) => { setSaved(t); setOpen(false); reload(); }} />}
      {saved && <div className="cert-saved"><strong>{saved}</strong></div>}
    </section>
  );
}
