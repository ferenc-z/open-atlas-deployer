// A service's Configuration tab (S24): a tab per file, and three ways to look at a properties file: the grouped
// property table (default; by the profile catalog's sections, each key's status against the shipped default, the
// catalog's description on hover), the node comparison (clusters only: a column per node, differences first and
// coloured by how much they matter, the identical keys folded into one row), and the file itself (line numbers,
// keys and values coloured, comments dimmed, folding by "# Section #" comments). XML files have only the file view.
// Secret values are always "(hidden)"; the comparison labels them "value A" / "value B" (worked out on the server).
// Phase 3: with the right to, a key is edited in its row and an XML file as text; each edit goes into the draft the bar
// above the files names (a cluster: into the common layer or for one node). A secret is write-only, and an admin in a
// browser can ask for one value at a time, which is written to the audit trail.

import { Fragment, useMemo, useState, type FormEvent } from "react";
import * as api from "./api.ts";
import type { CatalogView, CompareRow, DraftChangeInput, DraftChangeView, PropertyRow, ServiceConfigView, ServiceStatus } from "./api.ts";
import { ask } from "./Confirm.tsx";
import { changeValue, findingCounts, type Drafts } from "./ServiceChanges.tsx";
import { SOURCE, webPort, when } from "./svc.tsx";

type Mode = "table" | "compare" | "raw";
const HIDDEN = "(hidden)";

const Lock = () => (
  <svg className="lock" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M5 7V5a3 3 0 0 1 6 0v2h.5A1.5 1.5 0 0 1 13 8.5v5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 13.5v-5A1.5 1.5 0 0 1 4.5 7H5Zm1.5 0h3V5a1.5 1.5 0 0 0-3 0v2Z" /></svg>
);

const tipOf = (e: CatalogView | undefined) => {
  if (!e) return "Not in the service profile's property catalog.";
  return [e.description, e.note, `Default: ${e.default === null ? "not set" : e.default === "" ? "(empty)" : e.default}`,
    e.scope === "cluster" ? "Every node must have the same value." : "Each node has its own value.", e.restart ? "A change needs a restart." : "Applies without a restart.",
    e.sensitive ? "Secret: the value is never shown." : ""].filter(Boolean).join("\n");
};

/** What the tables need to edit: the place edits apply to now, and how to put a change into the draft. */
type Edit = {
  can: boolean; canReveal: boolean; service: string; revision: number; cluster: boolean;
  /** The node on show (its install key) and its name. */
  member: string; memberName: string;
  changes: DraftChangeView[];
  submit: (c: DraftChangeInput) => Promise<void>;
  undo: (c: DraftChangeView) => Promise<void>;
};

const samePlace = (a: DraftChangeInput, b: DraftChangeInput) => a.file === b.file && (a.member ?? null) === (b.member ?? null) && ("key" in a ? a.key : null) === ("key" in b ? b.key : null);

const failure = (e: unknown) => (e as Error).message;

/** Which draft edits go into, and the way to the Changes tab. */
function DraftBar({ cfg, drafts, onReview }: { cfg: ServiceConfigView; drafts: Drafts; onReview: () => void }) {
  const a = drafts.active;
  if (!cfg.canDraft && !drafts.list.length) return null;
  return (
    <div className="draft-bar">
      <div className="draft-bar-main">
        <strong>Draft</strong>
        {cfg.canDraft && drafts.list.length > 0 ? <select aria-label="The draft edits go into" className="mono" value={a?.id ?? "new"} onChange={(e) => drafts.choose(e.target.value)}>
          {drafts.list.map((d) => <option key={d.id} value={d.id}>{d.id}</option>)}
          <option value="new">A new draft</option>
        </select> : a && <span className="mono">{a.id}</span>}
        {a ? <span className="small">{a.changes.length} change{a.changes.length === 1 ? "" : "s"} on r{a.base}</span> : <span className="muted small">None yet</span>}
        {a?.stale && <span className="badge warn">Old: the newest is r{cfg.revision}</span>}
        {a && findingCounts(a.findings)}
        <span className="spacer" />
        {a && <button className={cfg.canDraft ? "primary" : ""} onClick={onReview}>{cfg.canDraft ? "Review and save" : "See it"}</button>}
      </div>
      {cfg.canDraft && <p className="muted small">{a?.stale ? "This draft was made on an older revision: move it to the newest on the Changes tab before editing it."
        : a ? "Your edits go into this draft. They reach no host: saving makes a revision, and a revision is kept until it is applied."
        : "Use Edit on a key to start a draft. It reaches no host: saving makes a revision, and a revision is kept until it is applied."}</p>}
    </div>
  );
}

export function ServiceConfig({ cfg, status, drafts, onReview }: { cfg: ServiceConfigView | null | undefined; status: ServiceStatus; drafts: Drafts; onReview: () => void }) {
  const cluster = status.kind === "cluster";
  const members = cfg?.body.members ?? [];
  const files = useMemo(() => { const n: string[] = []; for (const m of members) for (const f of m.files) if (!n.includes(f.name)) n.push(f.name); return n; }, [members]);
  const [file, setFile] = useState<string | undefined>();
  const [mode, setMode] = useState<Mode>("table");
  const [member, setMember] = useState(0);
  if (cfg === undefined) return <p className="muted">Loading…</p>;
  if (cfg === null || !files.length) return <p className="muted">No configuration is kept for this service yet.</p>;
  const name = file && files.includes(file) ? file : files[0]!;
  const format = members.flatMap((m) => m.files).find((f) => f.name === name)?.format ?? "other";
  const modes: [Mode, string][] = format === "properties" ? [["table", "Properties"], ...(cluster ? [["compare", "Compare nodes"] as [Mode, string]] : []), ["raw", "File"]] : [["raw", "File"]];
  const shown = modes.some(([m]) => m === mode) ? mode : modes[0]![0];
  const label = (i: number) => {
    const m = members[i]!;
    const st = status.members.find((x) => x.host === m.host && x.installDir === m.installDir);
    // A node by its address; by host:port when the addresses do not tell the nodes apart (all localhost in the lab).
    const addresses = status.members.map((x) => x.nodeAddress ?? x.host);
    const port = st ? webPort(st.ports) : null;
    return cluster && st?.nodeAddress && new Set(addresses).size === addresses.length ? st.nodeAddress : `${m.host}${port ? `:${port}` : ""}`;
  };
  const m = members[Math.min(member, members.length - 1)]!;
  const record = m.files.find((f) => f.name === name);
  const catalog = new Map((cfg.view?.catalog ?? []).map((e) => [`${e.file}:${e.key}`, e]));
  const memberAt = Math.min(member, members.length - 1);
  const commit = async (make: (list: DraftChangeInput[]) => DraftChangeInput[]) => {
    const a = drafts.active;
    drafts.took(a ? await api.putConfigDraft(cfg.service, a.id, { changes: make(a.changes) }) : await api.createConfigDraft(cfg.service, { base: cfg.revision, changes: make([]) }));
  };
  const edit: Edit = {
    can: cfg.canDraft && !drafts.active?.stale, canReveal: cfg.canReveal, service: cfg.service, revision: cfg.revision, cluster,
    member: cfg.view?.rows[memberAt]?.key ?? "", memberName: label(memberAt),
    changes: drafts.active?.changes ?? [],
    submit: (c) => commit((list) => [...list.filter((x) => !samePlace(x, c)), c]),
    undo: (c) => commit((list) => list.filter((x) => !samePlace(x, c))),
  };
  const compared = cfg.view?.compare?.find((c) => c.name === name);
  return (
    <div className="panel">
      <div className="muted small">Revision {cfg.revision} · {SOURCE[cfg.source] ?? cfg.source} · {when(cfg.savedAt)} by {cfg.savedBy} · secret values hidden</div>
      <DraftBar cfg={cfg} drafts={drafts} onReview={onReview} />
      <div className="file-tabs" role="tablist" aria-label="Files">
        {files.map((f) => <button key={f} role="tab" aria-selected={f === name} className={`mono ${f === name ? "active" : ""}`} onClick={() => setFile(f)}>{f}</button>)}
      </div>
      <div className="toolbar config-bar">
        {modes.length > 1 && <div className="subtabs inline" role="tablist" aria-label="View">
          {modes.map(([id, text]) => <button key={id} className={id === shown ? "active" : ""} aria-selected={id === shown} onClick={() => setMode(id)}>{text}</button>)}
        </div>}
        {cluster && shown !== "compare" && <label className="small">Node <select value={member} onChange={(e) => setMember(Number(e.target.value))}>
          {members.map((_, i) => <option key={i} value={i}>{label(i)}</option>)}
        </select></label>}
        {record && shown !== "compare" && <span className="muted small mono">{record.path}</span>}
      </div>
      {!record && shown !== "compare" ? <p className="muted">{label(member)} has no {name}{m.missing.includes(name) ? " (not there when it was read)" : ""}.</p>
        : shown === "table" ? <PropertyTable key={`${name}:${memberAt}:${cfg.revision}`} rows={cfg.view?.rows[memberAt]?.files[name] ?? []} catalog={catalog} file={name} sections={cfg.view?.sections ?? []} edit={edit} differs={(key) => Boolean(compared?.rows.find((r) => r.key === key)?.severity)} />
        : shown === "compare" ? <CompareTable key={name} rows={cfg.view?.compare?.find((c) => c.name === name)?.rows ?? []} labels={members.map((_, i) => label(i))} catalog={catalog} file={name} />
        : <>
          {cluster && format !== "properties" && (() => { const c = cfg.view?.compare?.find((x) => x.name === name); return c ? <p className={`small ${c.identical ? "muted" : "error"}`}>{c.identical ? "The same on every node." : "Differs between the nodes: pick a node above to see each."}</p> : null; })()}
          {format === "xml" && <XmlEdit key={`${name}:${memberAt}:${cfg.revision}`} file={name} text={record!.redacted} edit={edit} shared={compared?.identical ?? true} />}
          <RawFile key={`${name}:${member}`} text={record!.redacted} format={format} />
          {format === "xml" && edit.canReveal && <XmlSecrets key={`s:${name}:${memberAt}:${cfg.revision}`} file={name} secrets={cfg.view?.rows[memberAt]?.xmlSecrets?.[name] ?? []} edit={edit} />}
        </>}
    </div>
  );
}

/** One kept secret value, on request. index: which of the same-named XML secrets. */
function Reveal({ edit, file, name, index }: { edit: Edit; file: string; name: string; index?: number }) {
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState("");
  const show = async () => {
    const where = edit.cluster ? ` on ${edit.memberName}` : "";
    if (!(await ask(`Show the value of ${name} in revision ${edit.revision}${where}? Showing it is written to the audit trail.`, { confirm: "Show value" }))) return;
    setError("");
    try { setValue((await api.revealConfigValue(edit.service, { revision: edit.revision, file, key: name, ...(edit.cluster ? { member: edit.member } : {}), ...(index === undefined ? {} : { index }) })).value); } catch (e) { setError(failure(e)); }
  };
  return (
    <span className="reveal">
      {value === null ? <button type="button" className="link small" onClick={show} title="Administrators only; written to the audit trail">Show value</button>
        : <><code className="mono">{value === "" ? "(empty)" : value}</code> <button type="button" className="link small" onClick={() => setValue(null)}>Hide</button></>}
      {error && <span className="error small"> {error}</span>}
    </span>
  );
}

/** All nodes or this one: only this one when the nodes differ, since the common layer then has no value to change. */
function Applies({ edit, node, setNode, shared, what }: { edit: Edit; node: boolean; setNode: (v: boolean) => void; shared: boolean; what: string }) {
  if (!edit.cluster) return null;
  return (
    <label className="field">Applies to
      <select value={shared && !node ? "common" : "node"} disabled={!shared} onChange={(e) => setNode(e.target.value === "node")}>
        {shared && <option value="common">All nodes (common layer)</option>}
        <option value="node">Only {edit.memberName}</option>
      </select>
      <span className="muted small">{shared ? `All nodes changes the shared copy; a node with its own value keeps it, and the checks say so. Only this node gives it its own ${what}.` : `The nodes differ here, so there is no shared copy to change: change it on each node (pick the node above).`}</span>
    </label>
  );
}

/** A key's form in its row. */
function KeyEdit({ row, entry, file, edit, shared, pending, onClose }: { row: PropertyRow; entry: CatalogView | undefined; file: string; edit: Edit; shared: boolean; pending: DraftChangeView[]; onClose: () => void }) {
  const secret = row.secret;
  const mine = pending.find((c) => (c.member === null) === shared);
  const first = !secret && mine && "value" in mine ? mine.value : secret || row.status === "hidden" ? "" : row.value;
  const [value, setValue] = useState(first);
  const [node, setNode] = useState(!shared);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const member = edit.cluster && (node || !shared) ? edit.member : null;
  const run = async (c: DraftChangeInput | null) => {
    setBusy(true); setError("");
    try { if (c) await edit.submit(c); onClose(); } catch (e) { setError(failure(e)); setBusy(false); }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (secret) void run(value === "" ? null : { file, member, key: row.key, secret: value });
    else if (value === row.value && row.status !== "hidden" && !pending.some((c) => c.member === member)) void run(null);
    else void run({ file, member, key: row.key, value });
  };
  const remove = async () => {
    if (await ask(`Take ${row.key} out of ${file}${member ? ` on ${edit.memberName}` : ""} in this draft?`, { confirm: "Remove in draft" })) void run({ file, member, key: row.key, unset: true });
  };
  return (
    <tr className="edit-row"><td colSpan={4}>
      <form onSubmit={submit} className="key-edit">
        <label className="field">{secret ? "New value" : "Value"}
          {secret
            ? <input className="mono" type="password" autoComplete="new-password" autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder="unchanged" />
            : <input className="mono" autoFocus autoComplete="off" spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)} placeholder={row.status === "hidden" ? "(hidden in this revision)" : ""} />}
          <span className="muted small">{secret ? "A secret is write-only: leave this empty to keep the value. A new one is sealed on the server and not shown again." : "As written in the file: escapes are not undone."}{entry?.description ? ` ${entry.description}` : ""}{entry ? (entry.restart ? " A change needs a restart." : " Applies without a restart.") : " Not in the profile's catalog: taken as needing a restart."}</span>
        </label>
        <Applies edit={edit} node={node} setNode={setNode} shared={shared} what="value" />
        <div className="row">
          <button type="submit" className="primary" disabled={busy}>Add to draft</button>
          <button type="button" onClick={remove} disabled={busy} title="The key leaves the file; the service then uses its default">Remove key</button>
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
        </div>
        {error && <p className="error small">{error}</p>}
      </form>
    </td></tr>
  );
}

/** A key the file does not have yet. */
function AddKey({ file, edit, onClose }: { file: string; edit: Edit; onClose: () => void }) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [secret, setSecret] = useState(false);
  const [node, setNode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const member = edit.cluster && node ? edit.member : null;
    setBusy(true); setError("");
    try { await edit.submit(secret ? { file, member, key: key.trim(), secret: value } : { file, member, key: key.trim(), value }); onClose(); } catch (x) { setError(failure(x)); setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="key-edit card">
      <label className="field">Key<input className="mono" required autoFocus autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} placeholder="e.g. nifi.ui.banner.text" />
        <span className="muted small">It goes at the end of {file}. A key the profile&apos;s catalog does not know is only noted by the checks, and taken as needing a restart.</span></label>
      <label className="field">Value<input className="mono" type={secret ? "password" : "text"} autoComplete={secret ? "new-password" : "off"} spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)} />
        <label className="check small"><input type="checkbox" checked={secret} onChange={(e) => setSecret(e.target.checked)} /> A secret: sealed, and not shown again</label></label>
      <Applies edit={edit} node={node} setNode={setNode} shared what="value" />
      <div className="row">
        <button type="submit" className="primary" disabled={busy || !key.trim()}>Add to draft</button>
        <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
      </div>
      {error && <p className="error small">{error}</p>}
    </form>
  );
}

/** Edit an XML file as text. */
function XmlEdit({ file, text, edit, shared }: { file: string; text: string; edit: Edit; shared: boolean }) {
  const pending = edit.changes.filter((c) => "text" in c && c.file === file && (c.member === null || c.member === edit.member)) as Extract<DraftChangeView, { text: string }>[];
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(text);
  const [node, setNode] = useState(!shared);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const member = edit.cluster && (node || !shared) ? edit.member : null;
  const start = () => { setValue((pending.find((c) => c.member === edit.member) ?? pending[0])?.text ?? text); setOpen(true); };
  const undo = async (c: DraftChangeView) => { setError(""); try { await edit.undo(c); } catch (e) { setError(failure(e)); } };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError("");
    try { await edit.submit({ file, member, text: value }); setOpen(false); } catch (x) { setError(failure(x)); } finally { setBusy(false); }
  };
  if (!edit.can && !pending.length) return null;
  return (
    <>
      {pending.map((c) => <div key={String(c.member)} className="banner info inline">The draft has new text for this file ({c.member === null ? (edit.cluster ? "all nodes" : "this instance") : `only ${edit.memberName}`}). The view below is still the revision. {edit.can && <button className="link" onClick={() => undo(c)}>Undo</button>}</div>)}
      {edit.can && !open && <div className="row"><button onClick={start}>Edit text</button></div>}
      {open && <form onSubmit={submit} className="key-edit card">
        <label className="field">{file}<textarea className="mono xml-text" rows={16} spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)} />
          <span className="muted small">Leave each (hidden) as it is to keep that secret, or type over it to change it. The text is checked for being well formed, and a problem is reported, not refused. The draft keeps it sealed, since it may hold a password.</span></label>
        <Applies edit={edit} node={node} setNode={setNode} shared={shared} what="copy of the whole file" />
        <div className="row">
          <button type="submit" className="primary" disabled={busy}>Add to draft</button>
          <button type="button" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
        </div>
      </form>}
      {error && <p className="error small">{error}</p>}
    </>
  );
}

function XmlSecrets({ file, secrets, edit }: { file: string; secrets: { name: string; hidden: boolean }[]; edit: Edit }) {
  const seen = new Map<string, number>();
  const items = secrets.flatMap((x) => { const index = seen.get(x.name) ?? 0; seen.set(x.name, index + 1); return x.hidden ? [{ ...x, index }] : []; });
  if (!items.length) return null;
  return (
    <div>
      <h4>Secrets in this file</h4>
      <ul className="xml-secrets">{items.map((x) => <li key={`${x.name}:${x.index}`}><span className="mono">{x.name}</span> <Reveal edit={edit} file={file} name={x.name} index={x.index} /></li>)}</ul>
    </div>
  );
}

function PropertyTable({ rows, catalog, file, sections, edit, differs }: { rows: PropertyRow[]; catalog: Map<string, CatalogView>; file: string; sections: readonly string[]; edit: Edit; differs: (key: string) => boolean }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const actions = edit.can || edit.canReveal;
  const drafted = edit.changes.filter((c) => "key" in c && c.file === file && (c.member === null || c.member === edit.member)) as Extract<DraftChangeView, { key: string }>[];
  const fresh = drafted.filter((c) => !rows.some((r) => r.key === c.key));
  const undo = async (c: DraftChangeView) => { setError(""); try { await edit.undo(c); } catch (e) { setError(failure(e)); } };
  const pendingLines = (list: typeof drafted) => list.map((c) => (
    <div key={String(c.member)} className="in-draft small">
      <span className="badge info">Draft{edit.cluster ? `: ${c.member === null ? "all nodes" : "this node"}` : ""}</span> {changeValue(c)}
      {edit.can && <button className="link small" onClick={() => undo(c)} title="Take this change out of the draft">Undo</button>}
    </div>
  ));
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const visible = onlyChanged ? rows.filter((r) => r.status === "changed") : rows;
  const counts = { changed: rows.filter((r) => r.status === "changed").length, hidden: rows.filter((r) => r.status === "hidden").length };
  const order = [...sections, ...new Set(rows.map((r) => r.section).filter((s) => !sections.includes(s)))];
  const toggle = (s: string) => setFolded((was) => { const n = new Set(was); if (n.has(s)) n.delete(s); else n.add(s); return n; });
  return (
    <>
      <div className="row config-filter">
        <label className="small"><input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} /> Only keys changed from the default</label>
        <span className="muted small">{rows.length} keys · {counts.changed} changed · {counts.hidden} hidden</span>
      </div>
      {error && <p className="error small">{error}</p>}
      <table className="props editable">
        <thead><tr><th>Key</th><th>Value</th><th>Status</th><th>{actions && <span className="sr-only">Actions</span>}</th></tr></thead>
        <tbody>
        {fresh.length > 0 && <>
          <tr className="group-row"><td colSpan={4}><strong>New in this draft</strong></td></tr>
          {fresh.map((c) => <tr key={`${c.key}:${String(c.member)}`} className="changed"><td className="mono key">{c.key}</td><td className="mono value">{pendingLines([c])}</td><td><span className="badge info">New</span></td><td></td></tr>)}
        </>}
        {order.map((section) => {
          const here = visible.filter((r) => r.section === section);
          if (!here.length) return null;
          const shut = folded.has(section);
          return (
            <Fragment key={section}>
              <tr className="group-row"><td colSpan={4}><button className="link" onClick={() => toggle(section)} aria-expanded={!shut}><span className="caret">{shut ? "▸" : "▾"}</span>{section}</button> <span className="muted small">{here.length}{section === "Other" ? " · not in the profile's catalog" : ""}</span></td></tr>
              {!shut && here.map((r) => {
                const e = catalog.get(`${file}:${r.key}`);
                const pending = drafted.filter((c) => c.key === r.key);
                return (
                  <Fragment key={`${r.key}:${r.line}`}>
                  <tr className={r.status === "changed" ? "changed" : ""}>
                    <td className="mono key"><span className="has-tip" title={tipOf(e)}>{r.key}</span></td>
                    <td className="mono value">{r.status === "hidden" ? <span className="hidden-value"><Lock /> Hidden</span> : r.value === "" ? <span className="muted">(empty)</span> : r.value}
                      {r.status === "changed" && e && <div className="muted small">default {e.default === null ? "not set" : e.default === "" ? "(empty)" : e.default}</div>}
                      {edit.canReveal && r.status === "hidden" && <div><Reveal edit={edit} file={file} name={r.key} /></div>}
                      {pendingLines(pending)}</td>
                    <td>{r.status === "changed" ? <span className="badge info" title={tipOf(e)}>Changed</span>
                      : r.status === "hidden" ? <span className="badge muted" title="A secret: never shown, not compared with a default"><Lock /> Hidden</span>
                      : r.status === "default" ? <span className="muted small">Default</span>
                      : <span className="muted small" title="Not in the service profile's catalog: no default to compare with">—</span>}</td>
                    <td className="row-actions">{edit.can && <button className="link small" aria-expanded={editing === r.key} onClick={() => setEditing(editing === r.key ? null : r.key)}>Edit</button>}</td>
                  </tr>
                  {editing === r.key && <KeyEdit row={r} entry={e} file={file} edit={edit} shared={!differs(r.key)} pending={pending} onClose={() => setEditing(null)} />}
                  </Fragment>
                );
              })}
            </Fragment>
          );
        })}</tbody>
      </table>
      {!visible.length && <p className="muted">{onlyChanged ? "No key differs from its default." : "The file has no keys."}</p>}
      {edit.can && (adding ? <AddKey file={file} edit={edit} onClose={() => setAdding(false)} /> : <div className="row"><button onClick={() => setAdding(true)}>Add a key</button></div>)}
    </>
  );
}

const SEV_TEXT = { error: "Must agree", warning: "Should agree", info: "Per node" } as const;

function CompareTable({ rows, labels, catalog, file }: { rows: CompareRow[]; labels: string[]; catalog: Map<string, CatalogView>; file: string }) {
  const [openSame, setOpenSame] = useState(false);
  const differing = rows.filter((r) => r.severity);
  const same = rows.filter((r) => !r.severity);
  const cell = (v: CompareRow["values"][number], i: number) => (
    <td key={i} className="mono value">{v.from === "unset" ? <span className="muted">not set</span>
      : v.value === HIDDEN ? <span className="hidden-value"><Lock /> Hidden</span>
      : <>{v.value === "" ? <span className="muted">(empty)</span> : v.value}{v.from === "default" && <span className="muted small"> (default)</span>}</>}</td>
  );
  const line = (r: CompareRow) => (
    <tr key={r.key} className={r.severity ? `sev-${r.severity}` : ""}>
      <td className="mono key"><span className="has-tip" title={tipOf(catalog.get(`${file}:${r.key}`))}>{r.key}</span></td>
      <td>{r.severity ? <span className={`badge ${r.severity === "error" ? "bad" : r.severity === "warning" ? "warn" : "info"}`}>{SEV_TEXT[r.severity]}</span> : <span className="muted small">Same</span>}</td>
      {r.values.map(cell)}
    </tr>
  );
  return (
    <>
      <p className="muted small">Differences first: <span className="badge bad">Must agree</span> a secret or a key that makes the cluster; <span className="badge warn">Should agree</span> nodes are meant to share it (or the catalog does not know it); <span className="badge info">Per node</span> expected to differ. A key a file leaves out counts as its default.</p>
      <table className="props compare">
        <thead><tr><th>Key</th><th></th>{labels.map((l, i) => <th key={i} className="mono">{l}</th>)}</tr></thead>
        <tbody>
          {differing.map(line)}
          {same.length > 0 && <tr className="group-row"><td colSpan={2 + labels.length}><button className="link" onClick={() => setOpenSame(!openSame)} aria-expanded={openSame}><span className="caret">{openSame ? "▾" : "▸"}</span>{same.length} key{same.length > 1 ? "s are" : " is"} the same on every node</button></td></tr>}
          {openSame && same.map(line)}
        </tbody>
      </table>
      {!differing.length && <p className="ok">No differences between the nodes in this file.</p>}
    </>
  );
}

// The file itself.

const HEADER = /^\s*#+\s*([A-Za-z][^#]*?)\s*#+\s*$/;

function propertyLine(text: string) {
  if (/^\s*[#!]/.test(text) || !text.trim()) return <span className="cm">{text || " "}</span>;
  const m = /^(\s*)([^=:\s]+)(\s*[=:]\s*)?(.*)$/.exec(text);
  if (!m) return <span>{text}</span>;
  return <>{m[1]}<span className="k">{m[2]}</span>{m[3] && <span className="op">{m[3]}</span>}{m[4] === HIDDEN ? <span className="hidden-value"><Lock /> {HIDDEN}</span> : <span className="v">{m[4]}</span>}</>;
}

/** XML lines coloured: comments, tag names, attribute names and values; comments may span lines. */
function xmlLines(lines: string[]) {
  let inComment = false;
  return lines.map((line) => {
    const out: { cls: string; text: string }[] = [];
    let rest = line;
    while (rest.length) {
      if (inComment) {
        const end = rest.indexOf("-->");
        if (end < 0) { out.push({ cls: "cm", text: rest }); rest = ""; } else { out.push({ cls: "cm", text: rest.slice(0, end + 3) }); rest = rest.slice(end + 3); inComment = false; }
        continue;
      }
      const m = /<!--|<\/?[\w:.-]+|[\w:.-]+(?==")|"[^"]*"|\/?>|<\?[\w]+|\?>/.exec(rest);
      if (!m) { out.push({ cls: "", text: rest }); break; }
      if (m.index) out.push({ cls: "", text: rest.slice(0, m.index) });
      const t = m[0];
      if (t === "<!--") { inComment = true; out.push({ cls: "cm", text: t }); }
      else out.push({ cls: t.startsWith("<") || t.endsWith(">") ? "tag" : t.startsWith('"') ? (t === `"${HIDDEN}"` ? "hidden-value" : "v") : "attr", text: t });
      rest = rest.slice(m.index + t.length);
    }
    return out.map((p, i) => <span key={i} className={p.cls || undefined}>{p.text}</span>);
  });
}

function RawFile({ text, format }: { text: string; format: string }) {
  const lines = text.replace(/\r/g, "").split("\n");
  if (lines.at(-1) === "") lines.pop();
  // Sections: a "# Name #" comment starts one; what comes before the first is the file's head (usually the licence).
  const blocks: { title: string | null; start: number; end: number }[] = [];
  if (format === "properties") {
    lines.forEach((l, i) => { const h = HEADER.exec(l); if (h) blocks.push({ title: h[1]!, start: i, end: lines.length }); });
    blocks.forEach((b, i) => { b.end = blocks[i + 1]?.start ?? lines.length; });
    if (!blocks.length || blocks[0]!.start > 0) blocks.unshift({ title: null, start: 0, end: blocks[0]?.start ?? lines.length });
  } else blocks.push({ title: null, start: 0, end: lines.length });
  const head = blocks[0]!;
  const headAllComments = blocks.length > 1 && head.title === null && lines.slice(head.start, head.end).every((l) => !l.trim() || /^\s*[#!]/.test(l));
  const [folded, setFolded] = useState<Set<number>>(() => new Set(headAllComments ? [0] : []));
  const rendered = format === "xml" ? xmlLines(lines) : lines.map(propertyLine);
  const toggle = (i: number) => setFolded((was) => { const n = new Set(was); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  const row = (i: number) => <div key={i} className="ln"><span className="no">{i + 1}</span><span className="tx">{rendered[i]}</span></div>;
  return (
    <div className="raw mono">
      {blocks.map((b, bi) => {
        const shut = folded.has(bi);
        const foldable = blocks.length > 1;
        const body = [];
        for (let i = b.title === null ? b.start : b.start + 1; i < b.end; i++) body.push(row(i));
        return (
          <div key={bi} className="fold">
            {foldable && (b.title !== null
              ? <button className="ln fold-head" onClick={() => toggle(bi)} aria-expanded={!shut}><span className="no">{b.start + 1}</span><span className="tx"><span className="caret">{shut ? "▸" : "▾"}</span><span className="cm">{lines[b.start]}</span>{shut && <span className="muted"> · {b.end - b.start - 1} lines</span>}</span></button>
              : <button className="ln fold-head" onClick={() => toggle(bi)} aria-expanded={!shut}><span className="no">{b.start + 1}</span><span className="tx"><span className="caret">{shut ? "▸" : "▾"}</span><span className="muted">{shut ? `Start of the file · ${b.end - b.start} lines` : "Start of the file"}</span></span></button>)}
            {!(foldable && shut) && body}
          </div>
        );
      })}
    </div>
  );
}
