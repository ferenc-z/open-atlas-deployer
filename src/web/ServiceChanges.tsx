// A service's Changes tab (§12.2, §16.3): the open configuration drafts, what one would change, and the saved revisions
// compared two at a time. A draft is a list of changes on a revision (made on the Configuration tab); saving one makes
// the next revision and changes nothing on the hosts. Secrets are never here: a changed secret is named, not shown.

import { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "./api.ts";
import type { ChangeAssessment, ConfigDiff, ConfigDraft, ConfigDraftDetail, ConfigFinding, DraftChangeView, MemberDiff, ServiceConfigView, ServiceStatus } from "./api.ts";
import { ask } from "./Confirm.tsx";
import { Markdown } from "./Markdown.tsx";
import { SEVERITY, SOURCE, webPort, when } from "./svc.tsx";

/** The open drafts of a service, and the one edits on the Configuration tab go into. */
export type Drafts = {
  list: ConfigDraft[];
  /** undefined: edits start a new draft. */
  active: ConfigDraft | undefined;
  choose: (id: string | "new") => void;
  refresh: () => void;
  /** A draft as a call returned it. */
  took: (d: ConfigDraft) => void;
};

export function useDrafts(id: string, initial?: string): Drafts {
  const [list, setList] = useState<ConfigDraft[]>([]);
  const [chosen, setChosen] = useState<string | null>(initial ?? null);
  const refresh = useCallback(() => { api.configDrafts(id, "open").then((r) => setList(r.drafts), () => setList([])); }, [id]);
  useEffect(refresh, [refresh]);
  const took = useCallback((d: ConfigDraft) => {
    setList((was) => (d.state !== "open" ? was.filter((x) => x.id !== d.id) : was.some((x) => x.id === d.id) ? was.map((x) => (x.id === d.id ? d : x)) : [d, ...was]));
    setChosen(d.state === "open" ? d.id : null);
  }, []);
  const active = chosen === "new" ? undefined : list.find((d) => d.id === chosen) ?? list[0];
  return { list, active, choose: setChosen, refresh, took };
}

/** A member by what a person tells it by: a node's address and port, a standalone's host. */
export const memberName = (s: ServiceStatus, key: string | null) => {
  if (key === null) return s.kind === "cluster" ? "All nodes" : (s.members[0]?.host ?? "");
  const m = s.members.find((x) => x.key === key);
  if (!m) return key;
  if (s.kind !== "cluster") return m.host;
  // As on the Configuration tab: by address, or by host and port when the addresses do not tell the nodes apart.
  const addresses = s.members.map((x) => x.nodeAddress ?? x.host);
  return m.nodeAddress && new Set(addresses).size === addresses.length ? m.nodeAddress : `${m.host}:${webPort(m.ports) ?? "?"}`;
};

export function Findings({ findings }: { findings: ConfigFinding[] }) {
  if (!findings.length) return <p className="ok">No findings.</p>;
  const order = { error: 0, warning: 1, info: 2 };
  const sorted = [...findings].sort((a, b) => order[a.severity] - order[b.severity]);
  return (
    <ul className="findings">{sorted.map((f, i) => (
      <li key={i}>
        <span className={`badge ${SEVERITY[f.severity].tone}`}>{SEVERITY[f.severity].mark} {f.severity}</span> <span className="mono small">{f.code}</span> {f.message}
        {f.severity === "error" && !f.introduced && <span className="muted small"> (was already there: does not hold up applying)</span>}
      </li>
    ))}</ul>
  );
}

/** "2 errors, 1 warning": info is left out, there is usually some. */
export const findingCounts = (findings: ConfigFinding[]) => {
  const n = (s: ConfigFinding["severity"]) => findings.filter((f) => f.severity === s).length;
  return [n("error") > 0 && <span key="e" className="badge bad">{n("error")} error{n("error") > 1 ? "s" : ""}</span>, n("warning") > 0 && <span key="w" className="badge warn">{n("warning")} warning{n("warning") > 1 ? "s" : ""}</span>];
};

/** Each run of changed lines with what goes first, then what comes in: the server lists them the other way round. */
function ordered(diff: string) {
  const lines = diff.split("\n"), out: string[] = [];
  for (let i = 0; i < lines.length;) {
    if (!lines[i]!.startsWith("+ ") && !lines[i]!.startsWith("- ")) { out.push(lines[i]!); i++; continue; }
    const run: string[] = [];
    while (i < lines.length && (lines[i]!.startsWith("+ ") || lines[i]!.startsWith("- "))) run.push(lines[i++]!);
    out.push(...run.filter((l) => l.startsWith("- ")), ...run.filter((l) => l.startsWith("+ ")));
  }
  return out;
}

function FileDiffs({ members, s }: { members: MemberDiff[]; s: ServiceStatus }) {
  if (!members.length) return <p className="muted">No file differs.</p>;
  return (
    <div className="diffs">{members.map((m) => (
      <div key={m.member}>
        {s.kind === "cluster" && <h4 className="mono">{memberName(s, m.member)}</h4>}
        {m.files.map((f) => {
          const shown = ordered(f.diff);
          const lines = shown.some((l) => l.startsWith("+ ") || l.startsWith("- "));
          return (
            <details key={f.name} open>
              <summary><span className="mono">{f.name}</span>{f.change !== "content" && <span className="badge info">{f.change}</span>}</summary>
              {f.secretsChanged.length > 0 && <p className="small"><span className="hidden-value">Secret values changed:</span> <span className="mono">{f.secretsChanged.join(", ")}</span></p>}
              {!f.opened && <p className="small muted">A side was imported by an older version and cannot be opened: the kept copies are compared, secrets are not.</p>}
              {lines ? <pre className="diff">{shown.map((l, i) => <div key={i} className={l.startsWith("+ ") ? "add" : l.startsWith("- ") ? "del" : ""}>{l || " "}</div>)}</pre>
                : !f.secretsChanged.length && <p className="small muted">Only the bytes differ, not the text shown here.</p>}
            </details>
          );
        })}
      </div>
    ))}</div>
  );
}

function Assessment({ change, s }: { change: ChangeAssessment; s: ServiceStatus }) {
  const cluster = s.kind === "cluster";
  return (
    <div className="plan">
      <p>
        {!change.restart ? <span className="badge ok">No restart</span>
          : !cluster ? <span className="badge warn">Restart</span>
          : change.mode === "full" ? <span className="badge bad">Whole cluster stops and starts</span> : <span className="badge warn">Rolling restart</span>}
        {cluster && change.mode === "full" && <span className="small"> because of {change.fullBecause.map((f) => f.key ?? f.file).join(", ")}: nodes with the old and new values cannot share a cluster.</span>}
      </p>
      <table className="props">
        <thead><tr>{cluster && <th>Node</th>}<th>File</th><th>Keys</th><th>Restart</th></tr></thead>
        <tbody>{change.members.flatMap((m) => m.files.map((f) => (
          <tr key={`${m.member}:${f.name}`}>
            {cluster && <td className="mono">{memberName(s, m.member)}</td>}
            <td className="mono">{f.name}</td>
            <td className="mono value">{f.change === "format" ? <span className="muted">Only the layout differs</span> : f.keys.join(", ") || <span className="muted">{f.change}</span>}</td>
            <td title={f.reasons.join("\n")}>{f.restart ? "Needed" : <span className="muted">No</span>}</td>
          </tr>
        )))}</tbody>
      </table>
    </div>
  );
}

export const changeValue = (c: DraftChangeView) => ("text" in c ? <span className="muted">The file&apos;s text</span>
  : "unset" in c ? <span className="muted">Removed</span>
  : "hidden" in c ? <span className="hidden-value">New secret value</span>
  : c.value === "" ? <span className="muted">(empty)</span> : c.value);

function DraftDetail({ draft, s, cfg, drafts, onSaved, onEdit }: { draft: ConfigDraft; s: ServiceStatus; cfg: ServiceConfigView; drafts: Drafts; onSaved: () => void; onEdit: () => void }) {
  const [d, setD] = useState<ConfigDraftDetail | undefined>();
  const [note, setNote] = useState(draft.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let on = true;
    setError("");
    api.configDraft(s.id, draft.id).then((x) => { if (on) setD(x); }, (e: Error) => { if (on) setError(e.message); });
    return () => { on = false; };
  }, [s.id, draft.id, draft.updatedAt]);
  useEffect(() => setNote(draft.note ?? ""), [draft.id, draft.note]);
  const act = async (work: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await work(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const preview = d?.preview ?? null;
  const problem = preview && "problem" in preview ? preview.problem : null;
  const assessed = preview && "members" in preview ? preview : null;
  const findings = assessed?.findings ?? draft.findings;
  const newErrors = findings.filter((f) => f.severity === "error" && f.introduced).length;
  // A cluster's first edit keeps the same files in layers first, so the draft becomes the revision after that one.
  const splits = s.kind === "cluster" && !cfg.body.layers;
  const next = cfg.revision + (splits ? 2 : 1);
  const save = () => act(async () => {
    const warn = newErrors ? `\n\nIt has ${newErrors} new error${newErrors > 1 ? "s" : ""}: saving is allowed, but ${newErrors > 1 ? "they" : "it"} will hold up applying.` : "";
    if (!(await ask(`Save this draft as revision ${next}${splits ? ` (revision ${cfg.revision + 1} first keeps the same files split into layers)` : ""}? Nothing changes on the hosts.${warn}`, { confirm: "Save as revision" }))) return;
    const out = await api.saveConfigDraft(s.id, draft.id, note);
    drafts.took(out.draft);
    onSaved();
  });
  const discard = () => act(async () => {
    if (!(await ask(`Discard draft ${draft.id} and its ${draft.changes.length} change${draft.changes.length === 1 ? "" : "s"}?`, { confirm: "Discard draft", danger: true }))) return;
    drafts.took(await api.discardConfigDraft(s.id, draft.id));
  });
  const move = () => act(async () => { const x = await api.putConfigDraft(s.id, draft.id, { base: cfg.revision }); drafts.took(x); setD(x); });
  const undo = (i: number) => act(async () => { const x = await api.putConfigDraft(s.id, draft.id, { changes: draft.changes.filter((_, n) => n !== i) }); drafts.took(x); setD(x); });
  return (
    <section className="card plan">
      <div className="draft-bar-main">
        <h3 className="mono">{draft.id}</h3>
        {draft.stale ? <span className="badge warn">Made on r{draft.base}, the newest is r{cfg.revision}</span> : <span className="badge muted">On r{draft.base}</span>}
        <span className="muted small">by {draft.createdBy}{draft.via === "service" ? " (AI)" : ""} · {when(draft.updatedAt)}</span>
      </div>
      {draft.stale && <div className="banner warn inline">Someone saved a revision after this draft was made. Move it to r{cfg.revision} to save it: its changes are made again on that revision. {cfg.canDraft && <button onClick={move} disabled={busy}>Move to r{cfg.revision}</button>}</div>}
      {draft.changes.length === 0 ? <p className="muted">No changes yet. {cfg.canDraft && <button className="link" onClick={onEdit}>Edit on the Configuration tab</button>}</p> : <table className="props">
        <thead><tr><th>File</th>{s.kind === "cluster" && <th>Applies to</th>}<th>Key</th><th>New value</th>{cfg.canDraft && <th></th>}</tr></thead>
        <tbody>{draft.changes.map((c, i) => (
          <tr key={i}>
            <td className="mono">{c.file}</td>
            {s.kind === "cluster" && <td>{memberName(s, c.member)}</td>}
            <td className="mono key">{"key" in c ? c.key : "—"}</td>
            <td className="mono value">{changeValue(c)}</td>
            {cfg.canDraft && <td><button className="link" onClick={() => undo(i)} disabled={busy} title="Take this change out of the draft">Undo</button></td>}
          </tr>
        ))}</tbody>
      </table>}
      {problem && <p className="error">This draft cannot be made on r{draft.base}: {problem.message}</p>}
      {!d && !error && <p className="muted">Working out what it would change…</p>}
      {assessed?.change && assessed.members.length > 0 && <div><h4>When it is applied</h4><Assessment change={assessed.change} s={s} /></div>}
      {draft.changes.length > 0 && <div><h4>Checks</h4><Findings findings={findings} /><p className="muted small">The checks do not stop a save. Applying is held up only by errors this change brings in.</p></div>}
      {assessed && assessed.members.length > 0 && <div><h4>What differs from r{draft.base}</h4><FileDiffs members={assessed.members} s={s} /></div>}
      {cfg.canDraft && <>
        <label className="field">Why<textarea rows={2} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Raise the banner text for the migration week" />
          <span className="muted small">Kept with the revision and shown on the timeline. Anything that looks like a password is masked.</span></label>
        <div className="row">
          <button className="primary" onClick={save} disabled={busy || draft.stale || !draft.changes.length || Boolean(problem)} title={draft.stale ? "Move it to the newest revision first" : undefined}>Save as revision {next}</button>
          <button onClick={onEdit}>Edit on the Configuration tab</button>
          <button onClick={discard} disabled={busy}>Discard</button>
        </div>
        <p className="muted small">Saving keeps a new revision here. The hosts keep their files until the revision is applied.</p>
      </>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function Revisions({ s, cfg }: { s: ServiceStatus; cfg: ServiceConfigView }) {
  const newest = cfg.revisions[0]?.revision ?? cfg.revision;
  const fromOf = useCallback((to: number) => cfg.revisions.find((r) => r.revision === to)?.base ?? (to > 1 ? to - 1 : to), [cfg.revisions]);
  const [to, setTo] = useState(newest);
  const [from, setFrom] = useState(fromOf(newest));
  const [member, setMember] = useState("");
  const [diff, setDiff] = useState<ConfigDiff | undefined>();
  const [detail, setDetail] = useState<ServiceConfigView | undefined>();
  const [error, setError] = useState("");
  // A new revision was saved: look at it.
  useEffect(() => { setTo(newest); setFrom(fromOf(newest)); }, [newest, fromOf]);
  useEffect(() => {
    let on = true;
    setError(""); setDiff(undefined);
    api.serviceConfigDiff(s.id, { from, to, member }).then((x) => { if (on) setDiff(x); }, (e: Error) => { if (on) setError(e.message); });
    return () => { on = false; };
  }, [s.id, from, to, member]);
  useEffect(() => {
    let on = true;
    setDetail(undefined);
    api.serviceConfig(s.id, to).then((x) => { if (on) setDetail(x); }, () => undefined);
    return () => { on = false; };
  }, [s.id, to]);
  // The AI review ends a while after the save.
  useEffect(() => {
    if (detail?.review?.state !== "running") return;
    const t = setTimeout(() => { api.serviceConfig(s.id, to).then((x) => setDetail((was) => (was?.revision === x.revision ? x : was)), () => undefined); }, 5_000);
    return () => clearTimeout(t);
  }, [detail, s.id, to]);
  const pick = (r: number) => { setTo(r); setFrom(fromOf(r)); };
  const options = cfg.revisions.map((r) => <option key={r.revision} value={r.revision}>r{r.revision} · {when(r.savedAt)}</option>);
  const shown = useMemo(() => cfg.revisions.find((r) => r.revision === to), [cfg.revisions, to]);
  return (
    <section className="panel">
      <h3>Revisions</h3>
      <table className="props revisions">
        <thead><tr><th>Revision</th><th>How</th><th>When</th><th>By</th><th>Why</th></tr></thead>
        <tbody>{cfg.revisions.map((r) => (
          <tr key={r.revision} className={r.revision === to ? "selected" : ""}>
            <td><button className="link mono" onClick={() => pick(r.revision)} aria-pressed={r.revision === to} title="Compare this revision with the one it came from">r{r.revision}</button>{r.revision === newest && <span className="badge ok">Newest</span>}</td>
            <td>{SOURCE[r.source] ?? r.source}</td>
            <td className="nowrap">{when(r.savedAt)}</td>
            <td>{r.savedBy}{r.via === "service" ? " (AI)" : ""}</td>
            <td>{r.note ?? <span className="muted">—</span>}</td>
          </tr>
        ))}</tbody>
      </table>
      {cfg.revisions.length < 2 ? <p className="muted">Only one revision so far: nothing to compare yet.</p> : <>
        <div className="form-grid compare-form">
          <label className="field">From<select value={from} onChange={(e) => setFrom(Number(e.target.value))}>{options}</select></label>
          <label className="field">To<select value={to} onChange={(e) => setTo(Number(e.target.value))}>{options}</select></label>
          {s.kind === "cluster" && <label className="field">Node<select value={member} onChange={(e) => setMember(e.target.value)}>
            <option value="">All nodes</option>
            {s.members.map((m) => <option key={m.key} value={m.key}>{memberName(s, m.key)}</option>)}
          </select></label>}
        </div>
        <p className="muted small">Any two revisions: red is what r{from} has, green what r{to} has. Secret values stay hidden; a changed one is only named.</p>
        {error ? <p className="error">{error}</p> : !diff ? <p className="muted">Loading…</p> : <FileDiffs members={diff.members} s={s} />}
      </>}
      {shown && detail && (detail.findings !== null || detail.review) && <div className="plan">
        {detail.findings && detail.findings.length > 0 && <div><h4>Checks when r{to} was saved</h4><Findings findings={detail.findings} /></div>}
        {detail.review && <div>
          <h4>AI review of r{to} {detail.review.state && <span className={`badge ${detail.review.state === "done" ? "ok" : detail.review.state === "failed" ? "bad" : "info"}`}>{detail.review.state}</span>}</h4>
          {detail.review.state === "running" && <p className="muted small">The AI is reading this revision. It does not hold anything up.</p>}
          {detail.review.text && <Markdown text={detail.review.text} />}
          {detail.review.error && <p className="error">{detail.review.error}</p>}
        </div>}
      </div>}
    </section>
  );
}

export function ServiceChanges({ s, cfg, drafts, onSaved, onEdit }: { s: ServiceStatus; cfg: ServiceConfigView; drafts: Drafts; onSaved: () => void; onEdit: () => void }) {
  const { refresh } = drafts;
  useEffect(refresh, [refresh]);
  const current = drafts.active;
  return (
    <>
      <p className="muted small page-note">Drafts become revisions here. Nothing on this tab changes a host: a revision is kept until it is applied.</p>
      <section className="panel">
        <h3>Drafts</h3>
        {!drafts.list.length ? <p className="muted">No open drafts. {cfg.canDraft ? <>Edit a key on the <button className="link" onClick={onEdit}>Configuration tab</button> to start one.</> : "You can see drafts here, but not make them."}</p> : <>
          <table className="props revisions">
            <thead><tr><th>Draft</th><th>On</th><th>Changes</th><th>Checks</th><th>By</th><th>Updated</th></tr></thead>
            <tbody>{drafts.list.map((d) => (
              <tr key={d.id} className={d.id === current?.id ? "selected" : ""}>
                <td><button className="link mono" onClick={() => drafts.choose(d.id)} aria-pressed={d.id === current?.id}>{d.id}</button></td>
                <td className="mono">r{d.base}{d.stale && <span className="badge warn">Old</span>}</td>
                <td>{d.changes.length}</td>
                <td>{findingCounts(d.findings).some(Boolean) ? findingCounts(d.findings) : <span className="muted">—</span>}</td>
                <td>{d.createdBy}{d.via === "service" ? " (AI)" : ""}</td>
                <td className="nowrap">{when(d.updatedAt)}</td>
              </tr>
            ))}</tbody>
          </table>
          {current && <DraftDetail key={current.id} draft={current} s={s} cfg={cfg} drafts={drafts} onSaved={onSaved} onEdit={onEdit} />}
        </>}
      </section>
      <Revisions s={s} cfg={cfg} />
    </>
  );
}
