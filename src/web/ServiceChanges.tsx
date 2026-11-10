// A service's Changes tab (§12.2, §16.3): what is being done to it and what was (a plan to look at, the change holding the
// service with its buttons, the ones that ended), whether the hosts still have what is kept, the open configuration drafts,
// and the saved revisions compared two at a time. A draft is a list of changes on a revision (made on the Configuration
// tab); saving one makes the next revision and changes nothing on the hosts; only a confirmed plan touches a host.
// Secrets are never here: a changed secret is named, not shown.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as api from "./api.ts";
import type { ChangeAssessment, ChangePlan, ChangeRequest, ConfigDiff, ConfigDraft, ConfigDraftDetail, ConfigFinding, DraftChangeView, DriftAnswer, LiveDifferences, MemberDiff, ServiceChangeView, ServiceConfigView, ServiceStatus } from "./api.ts";
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

function FileDiffs({ members, s, action }: { members: MemberDiff[]; s: ServiceStatus; action?: (member: string, file: string) => ReactNode }) {
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
              <summary><span className="mono">{f.name}</span>{f.change !== "content" && <span className="badge info">{f.change}</span>}{action?.(m.member, f.name)}</summary>
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

function Revisions({ s, cfg, desk, onSaved }: { s: ServiceStatus; cfg: ServiceConfigView; desk: ChangeDesk; onSaved: () => void }) {
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
  // §16.3: an earlier revision comes back as the newest, and is then applied like any other.
  const backTo = async (r: number) => {
    if (!(await ask(`Go back to r${r}?\n\nIts files are saved as a new revision. Nothing changes on the hosts: the plan for applying it opens next, and you decide there.`, { confirm: `Back to r${r}` }))) return;
    setError("");
    try {
      const out = await api.rollBackConfig(s.id, r);
      onSaved();
      desk.plan({ kind: "apply", revision: out.revision });
    } catch (e) { setError((e as Error).message); }
  };
  const canAct = cfg.canDraft && !desk.active;
  const pending = s.members.some((m) => m.configPending.length > 0);
  const options = cfg.revisions.map((r) => <option key={r.revision} value={r.revision}>r{r.revision} · {when(r.savedAt)}</option>);
  const shown = useMemo(() => cfg.revisions.find((r) => r.revision === to), [cfg.revisions, to]);
  return (
    <section className="panel">
      <h3>Revisions</h3>
      <table className="props revisions">
        <thead><tr><th>Revision</th><th>How</th><th>When</th><th>By</th><th>Why</th>{canAct && <th></th>}</tr></thead>
        <tbody>{cfg.revisions.map((r) => (
          <tr key={r.revision} className={r.revision === to ? "selected" : ""}>
            <td><button className="link mono" onClick={() => pick(r.revision)} aria-pressed={r.revision === to} title="Compare this revision with the one it came from">r{r.revision}</button>{r.revision === newest && <span className="badge ok">Newest</span>}</td>
            <td>{SOURCE[r.source] ?? r.source}</td>
            <td className="nowrap">{when(r.savedAt)}</td>
            <td>{r.savedBy}{r.via === "service" ? " (AI)" : ""}</td>
            <td>{r.note ?? <span className="muted">—</span>}</td>
            {canAct && <td className="nowrap">{r.revision !== newest ? <button className="link" onClick={() => void backTo(r.revision)} title="Save this revision's files as the newest, then see the plan for applying it">Back to r{r.revision}</button> : pending && <button className="link" onClick={() => desk.plan({ kind: "apply", revision: r.revision })}>Plan applying</button>}</td>}
          </tr>
        ))}</tbody>
      </table>
      {error && cfg.revisions.length < 2 && <p className="error">{error}</p>}
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

const DRIFT_STATE = { same: { label: "Same", tone: "ok" }, changed: { label: "Changed", tone: "warn" }, missing: { label: "Gone", tone: "bad" }, unknown: { label: "Unknown", tone: "muted" } } as const;

/** Whether the files on the hosts still are what they should be, what differs, and keeping a host's file as a new revision. */
function Drift({ s, cfg, desk, onSaved }: { s: ServiceStatus; cfg: ServiceConfigView; desk: ChangeDesk; onSaved: () => void }) {
  const [drift, setDrift] = useState<DriftAnswer | undefined>();
  const [open, setOpen] = useState<string | null>(null);
  const [shown, setShown] = useState<LiveDifferences | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const load = useCallback(() => { api.serviceDrift(s.id).then(setDrift, (e: Error) => setError(e.message)); }, [s.id]);
  useEffect(() => { load(); const t = setInterval(load, 15_000); return () => clearInterval(t); }, [load]);
  const read = useCallback((member: string) => {
    setOpen(member); setShown(undefined); setError("");
    api.serviceDrift(s.id, member).then((x) => setShown(x.differences), (e: Error) => setError(e.message));
  }, [s.id]);
  const adopt = async (member: string, file: string) => {
    const seen = shown?.files.find((f) => f.name === file);
    if (!seen?.sha256) return;
    const pending = s.members.find((m) => m.key === member)?.configPending.includes(file) ?? false;
    const where = s.kind === "cluster" ? `${memberName(s, member)}'s ${file}` : file;
    const message = `Keep ${where} as the host has it, as a new revision?${s.kind === "cluster" ? " It becomes this node's own, which the checks may report as differing from the other nodes." : ""} Nothing changes on the host.${pending ? `\n\nThe newest revision changes this file and has not been applied: adopting replaces that change.` : ""}`;
    if (!(await ask(message, { confirm: "Adopt", danger: pending }))) return;
    setBusy(true); setError(""); setSaved("");
    try {
      const out = await api.adoptDrift(s.id, { member, file, sha256: seen.sha256, ...(pending ? { replacePending: true } : {}) });
      setSaved(`${file} is kept as r${out.revision}.`);
      setOpen(null); setShown(undefined);
      load(); onSaved();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  if (!drift) return <section className="panel"><h3>Files on the hosts</h3>{error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}</section>;
  const off = drift.members.flatMap((m) => m.files.filter((f) => f.state !== "same").map((f) => ({ m, f })));
  const reasons = [...new Set(drift.members.filter((m) => m.state === "unknown" && m.reason).map((m) => m.reason!))];
  const asOf = drift.members.map((m) => m.asOf).filter(Boolean).sort().at(-1);
  return (
    <section className="panel">
      <h3>Files on the hosts {drift.drifted && <span className="badge warn">Drift</span>}</h3>
      {reasons.map((r) => <p key={r} className="muted"><span className="badge muted">Unknown</span> {r}</p>)}
      {!off.length && !reasons.length && <p className="ok">Every file is what it should be{asOf ? ` (seen ${when(asOf)})` : ""}.</p>}
      {off.length > 0 && <table className="props revisions">
        <thead><tr>{s.kind === "cluster" && <th>Node</th>}<th>File</th><th>State</th><th>Should be</th><th>Seen</th><th></th></tr></thead>
        <tbody>{off.map(({ m, f }) => (
          <tr key={`${m.member}:${f.name}`}>
            {s.kind === "cluster" && <td className="mono">{memberName(s, m.member)}</td>}
            <td className="mono" title={f.path}>{f.name}</td>
            <td><span className={`badge ${DRIFT_STATE[f.state].tone}`}>{DRIFT_STATE[f.state].label}</span></td>
            <td className="mono">r{f.revision}</td>
            <td className="nowrap">{f.actualAt ? when(f.actualAt) : "—"}</td>
            <td>{f.state !== "unknown" && <button className="link" onClick={() => read(m.member)}>Show differences</button>}</td>
          </tr>
        ))}</tbody>
      </table>}
      {off.some(({ f }) => f.state !== "unknown") && cfg.canDraft && !desk.active && <div className="row plan-entry">
        <button onClick={() => desk.plan({ kind: "overwrite" })} title="Shows a plan first">Plan writing back what is kept</button>
        <span className="muted small">Writes what is kept over the hosts' files, with a backup. You see the plan first.</span>
      </div>}
      {open && !shown && !error && <p className="muted">Reading the files from the host…</p>}
      {open && shown && <div className="plan">
        <p className="muted small">Read from the host just now and not kept. Red is what the file should be, green what the host has. Secret values stay hidden; a changed one is only named.</p>
        <FileDiffs members={shown.files.length ? [shown] : []} s={s} action={(member, file) => {
          const f = shown.files.find((x) => x.name === file);
          return cfg.canDraft && f?.sha256 ? <button className="drift-adopt" onClick={(e) => { e.preventDefault(); void adopt(member, file); }} disabled={busy} title="Keep the host's file as a new revision">Adopt</button> : null;
        }} />
        <p className="muted small">Adopting keeps the host's file as a new revision and changes nothing on the host. A file that is gone cannot be adopted: write back what is kept instead.</p>
      </div>}
      {saved && <p className="ok">{saved}</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

// --- changes: a plan, a change under way, the ones that ended (§8, §16.3) ------------------------------------------------

/** What the service's page holds for changes: what happened, the one holding the service, and the plan someone asked to see. */
export type ChangeDesk = {
  list: ServiceChangeView[];
  active: ServiceChangeView | undefined;
  asked: ChangeRequest | null;
  plan: (request: ChangeRequest) => void;
  dismiss: () => void;
  refresh: () => void;
};

export function useChanges(id: string, onEnded: () => void): ChangeDesk {
  const [list, setList] = useState<ServiceChangeView[]>([]);
  const [active, setActive] = useState<ServiceChangeView | undefined>();
  const [asked, setAsked] = useState<ChangeRequest | null>(null);
  const held = useRef<string | null>(null);
  const ended = useRef(onEnded);
  ended.current = onEnded;
  const refresh = useCallback(() => {
    api.serviceChanges(id).then(async (r) => {
      setList(r.changes);
      const now = r.active ? await api.serviceChange(id, r.active) : undefined;
      setActive(now);
      if (held.current && !r.active) ended.current();
      held.current = r.active;
    }, () => undefined);
  }, [id]);
  const running = active !== undefined;
  useEffect(() => { refresh(); const t = setInterval(refresh, running ? 3_000 : 15_000); return () => clearInterval(t); }, [refresh, running]);
  const dismiss = useCallback(() => setAsked(null), []);
  return { list, active, asked, plan: setAsked, dismiss, refresh };
}

const KIND_LABEL: Record<api.ChangeKind, string> = { apply: "Apply", overwrite: "Write back", restart: "Restart", "rolling-restart": "Rolling restart", start: "Start", stop: "Stop" };
const CHANGE_STATE: Record<string, { label: string; tone: string }> = {
  running: { label: "Running", tone: "info" }, paused: { label: "Paused", tone: "warn" }, stopped: { label: "Stopped, waiting for you", tone: "bad" },
  succeeded: { label: "Succeeded", tone: "ok" }, "rolled-back": { label: "Rolled back", tone: "warn" }, closed: { label: "Closed", tone: "muted" },
};
const STEP_LABEL: Record<string, string> = {
  disconnect: "Disconnect", offload: "Offload", stop: "Stop", write: "Write files", start: "Start", "wait-rest": "REST answers", "wait-connected": "Connected", "wait-stable": "Stable",
  restore: "Put files back", kill: "Force kill", gate: "Check", look: "Look at the nodes", reconcile: "Compare with the hosts", check: "Check the hosts", backup: "Back up", verify: "Verify the files", compose: "Cluster forms", prune: "Clean old backups",
};
const STEP_TONE: Record<string, string> = { running: "info", succeeded: "ok", failed: "bad", "timed-out": "bad" };
const stepLabel = (step: string) => STEP_LABEL[step] ?? step;

/** "45 s", "12 min", "1 h 5 min". */
export const duration = (seconds: number) => (seconds < 90 ? `${Math.round(seconds)} s` : seconds < 5400 ? `${Math.round(seconds / 60)} min` : `${Math.floor(seconds / 3600)} h ${Math.round((seconds % 3600) / 60)} min`);
const took = (from: string, to: string | null) => duration(Math.max(0, ((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000));

const changeName = (c: { kind: string; revision: number | null; plan?: { members: { member: string }[] } }, s: ServiceStatus) => {
  const one = c.plan?.members.length === 1 && s.kind === "cluster" && ["restart", "start", "stop"].includes(c.kind) ? ` ${memberName(s, c.plan.members[0]!.member)}` : "";
  return `${KIND_LABEL[c.kind as api.ChangeKind] ?? c.kind}${c.revision !== null ? ` r${c.revision}` : ""}${one}`;
};

/** What this plan does to the service, said first and said differently for each way it can go. */
function Impact({ plan, s, request }: { plan: ChangePlan; s: ServiceStatus; request: ChangeRequest }) {
  const longest = duration(plan.longestSeconds);
  const cluster = s.kind === "cluster";
  if (plan.mode === "full") return (
    <div className="impact impact-full">
      <h4>The whole cluster goes down</h4>
      <p>Every node stops, so <strong>every flow stops and nothing is received or processed</strong> until the cluster has formed again: up to <strong>{longest}</strong> if each step takes all the time it is given (longer if a job waits for its host, or if it has to roll back).</p>
      <ul>
        <li><strong>Why it cannot roll:</strong> <span className="mono">{plan.fullBecause.map((f) => f.key ?? f.file).join(", ")}</span> changes, and nodes with the old and new values cannot share a cluster. This cannot be limited to some nodes, and the other changes in this revision go with it.</li>
        <li><strong>In this order:</strong> the nodes stop one by one, ordinary nodes first. Only when every one is confirmed gone are the files backed up and written. Only when every file is written do all nodes start together.</li>
        <li><strong>If a node will not stop:</strong> no file has been touched. The change waits for you: force kill and go on, or start again what was stopped.</li>
        <li><strong>If it fails after that:</strong> every node goes back to its old files and starts again, once, by itself: a second outage. If that fails too, it waits for you with the cluster down.</li>
      </ul>
    </div>
  );
  if (plan.kind === "stop") return (
    <div className="impact impact-warn">
      <h4>{cluster ? "This node stops and stays stopped" : "NiFi stops and stays stopped"}</h4>
      <p>{cluster ? "It leaves the cluster first; the other nodes go on without it. " : "Nothing is received or processed until someone starts it. "}The Deployer waits up to {duration(plan.options.timeouts.stop)} for the process to end and never kills it by itself.</p>
    </div>
  );
  if (plan.kind === "start") return (
    <div className="impact impact-ok">
      <h4>{cluster ? "This node starts and joins the cluster" : "NiFi starts"}</h4>
      <p>Nothing else is touched. Up to {longest} until it counts as back.</p>
    </div>
  );
  if (!plan.restart) return (
    <div className="impact impact-ok">
      <h4>No restart</h4>
      <p>Only the files are backed up and replaced; NiFi keeps running and reads them itself.</p>
    </div>
  );
  if (!cluster) return (
    <div className="impact impact-warn">
      <h4>NiFi is down while it restarts</h4>
      <p>This is the only installation, so nothing is received or processed until it is back: up to {longest}. If it does not come back, its files go back to the backup and it starts again.</p>
    </div>
  );
  if (plan.members.length === 1 && request.members) return (
    <div className="impact impact-rolling">
      <h4>Only this node restarts; the cluster stays up</h4>
      <p>It leaves the cluster, restarts and joins again: up to {longest}. The other nodes carry on without it. The change will not start unless they are all connected.</p>
    </div>
  );
  return (
    <div className="impact impact-rolling">
      <h4>The cluster stays up: one node at a time</h4>
      <p>Each node leaves the cluster, restarts and has to be connected and stable before the next one goes. Ordinary nodes first, the primary node and the coordinator last. Up to {longest} in all.</p>
      <ul><li><strong>If a node fails:</strong> it goes back to its old files, the change stops, and the next node is not touched. Nodes already done keep what they got.</li></ul>
    </div>
  );
}

/** The steps a plan will go through: a row per node when they go one at a time, one line when they all go together. */
function PlanSteps({ plan, s }: { plan: ChangePlan; s: ServiceStatus }) {
  if (plan.mode === "full") return (
    <ol className="stage-flow">{[`All ${plan.members.length} nodes stop, one by one`, "All back up", "All written", "All start together", "Cluster forms and is stable"].map((t) => <li key={t}><span className="stage">{t}</span></li>)}</ol>
  );
  return (
    <div className="stage-rows">{plan.members.map((m) => (
      <div key={m.member} className="stage-row">
        <span className="mono small stage-node">{s.kind === "cluster" ? memberName(s, m.member) : m.host}</span>
        <ol className="stage-flow">{m.stages.map((x) => <li key={x}><span className="stage">{stepLabel(x)}</span></li>)}</ol>
      </div>
    ))}{plan.members.length > 1 && <p className="muted small">The real order is decided as it goes, since the roles can move.</p>}</div>
  );
}

const TIMEOUT_FIELDS: { key: string; label: string; full?: boolean; rolling?: boolean }[] = [
  { key: "disconnect", label: "Disconnect", rolling: true }, { key: "offload", label: "Offload", rolling: true }, { key: "stop", label: "Stop", full: true, rolling: true }, { key: "write", label: "Back up, write", full: true, rolling: true },
  { key: "start", label: "Start", full: true, rolling: true }, { key: "rest", label: "REST answers", rolling: true }, { key: "connect", label: "Connected again", rolling: true }, { key: "stable", label: "Stable", rolling: true }, { key: "compose", label: "Cluster forms", full: true },
];

/** What a plan is about to do, looked at before anything happens: nothing is carried out until it is confirmed. */
function PlanPanel({ s, desk, request, canSteer }: { s: ServiceStatus; desk: ChangeDesk; request: ChangeRequest; canSteer: boolean }) {
  const [options, setOptions] = useState<api.ChangeOptionsInput>({});
  const [plan, setPlan] = useState<ChangePlan | undefined>();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const top = useRef<HTMLElement>(null);
  const asked = useMemo(() => ({ ...request, ...(Object.keys(options).length ? { options } : {}) }), [request, options]);
  const load = useCallback(() => { api.planChange(s.id, asked).then((p) => { setPlan(p); setError(""); }, (e: Error) => { setPlan(undefined); setError(e.message); }); }, [s.id, asked]);
  useEffect(() => { const t = setTimeout(load, 300); return () => clearTimeout(t); }, [load]);
  useEffect(() => { top.current?.scrollIntoView({ block: "start" }); }, []);
  const title = plan ? changeName({ kind: plan.kind, revision: plan.revision, plan }, s) : changeName({ kind: request.kind, revision: request.revision ?? null }, s);
  const full = plan?.mode === "full";
  const held = desk.active;
  const go = async () => {
    if (!plan) return;
    const message = full
      ? `Stop the whole of ${s.id}?\n\nEvery node goes down and every flow stops, for up to ${duration(plan.longestSeconds)}. If it fails after the files are written, all nodes go back and start again by themselves.`
      : plan.kind === "stop" ? `Stop ${request.members?.[0] ? memberName(s, request.members[0]) : s.id}? It stays stopped until someone starts it.`
      : plan.kind === "start" ? `Start ${request.members?.[0] ? memberName(s, request.members[0]) : s.id}?`
      : !plan.restart ? `${title}: the files are backed up and replaced, with no restart.`
      : s.kind === "cluster" ? `${title} of ${s.id}: ${plan.members.length} node${plan.members.length > 1 ? "s" : ""} restart${plan.members.length > 1 ? "" : "s"}, one at a time. The change stops at the first node that fails.`
      : `${title} of ${s.id}: NiFi is down until it is back, up to ${duration(plan.longestSeconds)}.`;
    const danger = full || plan.kind === "stop" || (s.kind !== "cluster" && plan.restart);
    if (!(await ask(message, { confirm: full ? "Stop the whole cluster" : plan.kind === "stop" ? "Stop it" : plan.kind === "start" ? "Start it" : title, danger }))) return;
    setBusy(true); setError("");
    try { await api.startChange(s.id, asked, plan.planHash, reason.trim()); desk.dismiss(); desk.refresh(); }
    catch (e) { setError((e as Error).message); load(); } finally { setBusy(false); }
  };
  const timeout = (key: string) => options.timeouts?.[key] ?? plan?.options.timeouts[key as keyof ChangePlan["options"]["timeouts"]] ?? 0;
  const setTimeoutOf = (key: string, value: number) => { if (value >= 1 && value <= 3600) setOptions((o) => ({ ...o, timeouts: { ...o.timeouts, [key]: value } })); };
  const fields = TIMEOUT_FIELDS.filter((f) => (full ? f.full : f.rolling) && (f.key !== "offload" || options.offload));
  const differences = (plan?.members ?? []).filter((m) => m.differences?.length).map((m) => ({ member: m.member, files: m.differences as MemberDiff["files"] }));
  const files = (plan?.members ?? []).flatMap((m) => m.files.map((f) => ({ m, f })));
  const restarts = plan?.restart && !["stop", "start"].includes(plan.kind);
  return (
    <section ref={top} className={`card plan change-plan${full ? " is-full" : ""}`}>
      <div className="draft-bar-main">
        <h3>Plan: {title}</h3>
        {plan && s.kind === "cluster" && <span className={`badge ${full ? "bad" : request.members ? "muted" : "info"}`}>{full ? "Whole cluster" : request.members ? "One node" : restarts ? "Rolling" : "No restart"}</span>}
        <button className="link plan-close" onClick={desk.dismiss}>Close without doing anything</button>
      </div>
      {!plan && !error && <p className="muted">{request.kind === "overwrite" ? "Reading the files from the hosts…" : "Working out the plan…"}</p>}
      {plan?.empty && <p className="ok">There is nothing to do: every {s.kind === "cluster" ? "node" : "file"} already has this.</p>}
      {plan && !plan.empty && <>
        <Impact plan={plan} s={s} request={request} />
        <PlanSteps plan={plan} s={s} />
        {files.length > 0 && <div>
          <h4>Files to write</h4>
          <table className="props">
            <thead><tr>{s.kind === "cluster" && <th>Node</th>}<th>File</th><th>Keys</th><th>Restart</th></tr></thead>
            <tbody>{files.map(({ m, f }) => (
              <tr key={`${m.member}:${f.name}`}>
                {s.kind === "cluster" && <td className="mono">{memberName(s, m.member)}</td>}
                <td className="mono" title={f.path}>{f.name}</td>
                <td className="mono value">{f.change === "format" ? <span className="muted">Only the layout differs</span> : f.keys.join(", ") || <span className="muted">{f.change}</span>}</td>
                <td title={f.reasons.join("\n")}>{f.restart ? "Needed" : <span className="muted">No</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>}
        {differences.length > 0 && <details className="plan-differences">
          <summary>What differs from what the hosts should have now</summary>
          <FileDiffs members={differences} s={s} />
        </details>}
        <div><h4>Checks</h4><Findings findings={plan.findings} /></div>
        {plan.blocking.length > 0 && <div className="banner bad inline">{plan.blocking.length} error{plan.blocking.length > 1 ? "s" : ""} above stop{plan.blocking.length > 1 ? "" : "s"} this plan. Nothing can start until {plan.blocking.length > 1 ? "they are" : "it is"} dealt with.</div>}
        {!["stop"].includes(plan.kind) && <details className="plan-options">
          <summary>Timeouts and limits</summary>
          <p className="muted small">When a step takes longer than this, the change stops and waits for you. The defaults are what most changes should use.</p>
          <div className="form-grid plan-numbers">
            {s.kind === "cluster" && !full && restarts && <label className="check"><input type="checkbox" checked={options.offload ?? false} onChange={(e) => setOptions((o) => ({ ...o, offload: e.target.checked }))} /> Offload each node first <span className="muted small">moves its queued data to the other nodes before it stops; with two nodes all of it lands on one, and it can take long.</span></label>}
            {fields.map((f) => <label key={f.key} className="field">{f.label} (seconds)<input type="number" min={1} max={3600} value={timeout(f.key)} onChange={(e) => setTimeoutOf(f.key, Number(e.target.value))} /></label>)}
            {plan.kind !== "start" && <label className="field">Extra invalid components allowed<input type="number" min={0} max={1000} value={options.invalidTolerance ?? plan.options.invalidTolerance} onChange={(e) => setOptions((o) => ({ ...o, invalidTolerance: Number(e.target.value) }))} /></label>}
            <label className="field">Stable for (seconds)<input type="number" min={0} max={600} value={options.stableSeconds ?? plan.options.stableSeconds} onChange={(e) => setOptions((o) => ({ ...o, stableSeconds: Number(e.target.value) }))} /></label>
          </div>
        </details>}
        {canSteer && <>
          <label className="field">{full ? "Why (required)" : "Why"}<textarea rows={2} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={full ? "e.g. Moving ZooKeeper to the new ensemble, agreed with the flow owners" : "e.g. Picks up the new banner text"} />
            <span className="muted small">Kept with the change and shown on the timeline.{full ? " A change that takes the whole cluster down needs a reason someone can read later." : ""}</span></label>
          {held && <div className="banner warn inline">Change {held.id} is {held.state}: it holds this service until it ends or is closed.</div>}
          <div className="row">
            <button className={full || plan.kind === "stop" ? "primary danger" : "primary"} onClick={() => void go()} disabled={busy || plan.blocking.length > 0 || Boolean(held) || (full && !reason.trim())} title={full && !reason.trim() ? "Say why first" : undefined}>{full ? "Stop the whole cluster…" : `${title}…`}</button>
            <button onClick={desk.dismiss}>Cancel</button>
          </div>
          <p className="muted small">Nothing has happened yet. The next button asks once more, and only then does it start.</p>
        </>}
        {!canSteer && <p className="muted small">You can look at this plan, but carrying it out takes the environment's deploy role.</p>}
      </>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

const FULL_ORDER = [["gate", "Check"], ["check", "Check the hosts"], ["stopping", "Stop nodes"], ["backup", "Back up"], ["write", "Write"], ["verify", "Verify"], ["start", "Start all"], ["compose", "Cluster forms"], ["finish", "Finish"]] as const;
const FULL_BACK = [["stopping", "Stop nodes"], ["restore", "Put files back"], ["verify", "Verify"], ["start", "Start all"], ["compose", "Cluster forms"]] as const;
const FILE_STAND: Record<string, { label: string; tone: string }> = { old: { label: "Old files", tone: "muted" }, new: { label: "New files", tone: "ok" }, mixed: { label: "Some new, some old", tone: "bad" }, changed: { label: "Changed by someone", tone: "bad" }, unknown: { label: "Not known", tone: "muted" } };
type Steps = NonNullable<ServiceChangeView["steps"]>;

/** A whole-cluster change by the stage the cluster is at, and where each node stands. */
function FullProgress({ c, s }: { c: ServiceChangeView; s: ServiceStatus }) {
  const back = c.progress.rollingBack;
  const order: readonly (readonly [string, string])[] = back ? FULL_BACK : FULL_ORDER;
  const at = c.state === "succeeded" ? order.length : order.findIndex(([p]) => p === c.phase);
  const halted = c.state === "stopped" || c.state === "paused";
  const seen = c.progress.seen;
  return (
    <>
      {back && <p className="small"><span className="badge warn">Rolling back</span> Every node goes back to its old files and starts again.</p>}
      <ol className="stage-flow phases">{order.map(([p, label], i) => (
        <li key={p}><span className={`stage ${i < at ? "done" : i === at ? (halted ? "failed" : c.state === "running" ? "now" : "") : ""}`}>{label}</span></li>
      ))}</ol>
      {c.phase === "reconcile" && <p className="muted small">Comparing with what the hosts have before going on.</p>}
      {c.phase === "kill" && <p className="muted small">Killing the process that would not stop.</p>}
      {c.progress.composing && c.state === "running" && <p className="small">Still waiting for: {c.progress.composing}</p>}
      <table className="props">
        <thead><tr><th>Node</th><th>Process</th><th>In the cluster</th><th>Files</th></tr></thead>
        <tbody>{c.plan.members.map((m) => {
          const n = seen?.members[m.member];
          const stand = FILE_STAND[n?.files ?? "unknown"] ?? FILE_STAND.unknown!;
          return (
            <tr key={m.member}>
              <td className="mono">{memberName(s, m.member)}</td>
              <td>{!n || n.running === null ? <span className="badge muted">Not known</span> : n.running ? <span className="badge ok">Running</span> : <span className="badge warn">Stopped</span>}</td>
              <td>{n?.status ? <span className={`badge ${n.status === "CONNECTED" ? "ok" : "warn"}`}>{n.status.toLowerCase()}</span> : <span className="muted">—</span>}</td>
              <td><span className={`badge ${stand.tone}`}>{stand.label}</span></td>
            </tr>
          );
        })}</tbody>
      </table>
      <p className="muted small">{seen ? <>As seen {when(seen.at)}. {seen.coordinator ? "It has a coordinator" : "No coordinator"}, {seen.primary ? "a primary node" : "no primary node"}.</> : "Not looked at yet."} {halted && c.progress.wrote ? "Writing had begun, so files may have changed since this look; Continue and Roll back look again first. " : ""}No node starts while the files are a mix of old and new.</p>
    </>
  );
}

/** A one-at-a-time change: each node and how far it got. */
function MemberProgress({ c, s, steps }: { c: ServiceChangeView; s: ServiceStatus; steps: Steps }) {
  const hidden = new Set(["gate", "reconcile", "look", "prune"]);
  return (
    <div className="stage-rows">{c.plan.members.map((m) => {
      const own = steps.filter((x) => x.member === m.member && !hidden.has(x.step));
      const finished = c.progress.done.includes(m.member);
      const extra = [...new Set(own.map((x) => x.step))].filter((x) => !(m.stages as string[]).includes(x));
      const line = [...(m.stages as string[]), ...extra];
      const current = c.currentMember === m.member;
      return (
        <div key={m.member} className={`stage-row${current ? " current" : ""}`}>
          <span className="mono small stage-node">{s.kind === "cluster" ? memberName(s, m.member) : m.host} {finished ? <span className="badge ok">Done</span> : current ? <span className={`badge ${c.state === "running" ? "info" : "bad"}`}>{c.state === "running" ? "Working" : "Stopped here"}</span> : !c.finishedAt ? <span className="badge muted">Waiting</span> : own.length ? <span className="badge warn">{c.state === "rolled-back" ? "Rolled back" : "Left as it was"}</span> : <span className="badge muted">Not touched</span>}</span>
          <ol className="stage-flow">{line.map((x) => {
            const tried = own.filter((y) => y.step === x).at(-1);
            const tone = tried ? (tried.state === "succeeded" ? "done" : tried.state === "running" ? "now" : "failed") : finished ? "skipped" : "";
            return <li key={x}><span className={`stage ${tone}`} title={tried ? `${tried.state}, ${took(tried.startedAt, tried.finishedAt)}` : finished ? "Not needed: the host already had it" : undefined}>{stepLabel(x)}</span></li>;
          })}</ol>
        </div>
      );
    })}</div>
  );
}

/** Each thing to do with a stopped or paused change, and what it means. */
function ChangeActions({ c, s, desk, onBusy }: { c: ServiceChangeView; s: ServiceStatus; desk: ChangeDesk; onBusy: (e: string) => void }) {
  const [busy, setBusy] = useState(false);
  const full = c.mode === "full";
  const who = c.currentMember && s.kind === "cluster" ? memberName(s, c.currentMember) : s.id;
  const act = async (action: "continue" | "stop" | "rollback" | "force-kill" | "close", question: string, confirm: string, danger: boolean, body: Record<string, unknown> = {}) => {
    if (!(await ask(question, { confirm, danger }))) return;
    setBusy(true); onBusy("");
    try { await api.steerChange(s.id, c.id, action, body); desk.refresh(); } catch (e) { onBusy((e as Error).message); } finally { setBusy(false); }
  };
  const stuck = c.progress.stuck as { pid?: number; startedAt?: string; bootstrapPid?: number } | null | undefined;
  const pids = [stuck?.pid, stuck?.bootstrapPid].filter(Boolean).join(" and ");
  const rows: ReactNode[] = [];
  if (c.state === "running") rows.push(<div key="stop"><button className="danger" disabled={busy} onClick={() => void act("stop", `Stop this change where it is?\n\nNothing is undone. A job a host has already taken may still finish. ${c.progress.wrote || c.currentMember ? `${who} may be left halfway. ` : ""}It holds the service until you continue, roll back or close it.`, "Stop the change", true)}>Stop here</button><span className="muted small">Goes no further and waits for you. Nothing is undone.</span></div>);
  if (c.progress.canForceKill) rows.push(<div key="kill"><button className="danger" disabled={busy} onClick={() => void act("force-kill", `Kill NiFi on ${who} with SIGKILL?\n\nOnly process${pids ? ` ${pids}` : ""}${stuck?.startedAt ? ` (started ${when(stuck.startedAt)})` : ""}, which did not stop in time. It gets no chance to shut down cleanly: what it was doing is cut off, and it recovers from its repositories when it starts. The change stays stopped, for you to continue.`, "Kill it", true)}>Force kill{pids ? ` (pid ${pids})` : ""}</button><span className="muted small">{who} did not stop in time. Only this process is killed; then continue.</span></div>);
  if (c.state === "paused" || c.state === "stopped") {
    rows.push(<div key="continue"><button className="primary" disabled={busy} onClick={() => void act("continue", `Continue this change?\n\nThe hosts are looked at first, and it goes on from what they have: a file already written is not written again, a NiFi already stopped is not stopped again.`, "Continue", false)}>Continue</button><span className="muted small">Looks at the hosts, then goes on from what it finds.</span></div>);
    if (c.progress.canRollBack) rows.push(<div key="back"><button disabled={busy} onClick={() => void act("rollback", full ? `Roll back the whole cluster?\n\n${c.progress.wrote ? "Every node that is running stops, every node goes back to its backup, and all start together: the cluster is down until it has formed again." : "No file has been written: only the nodes that were stopped are started again."}` : `Roll back ${who}?\n\nIts files go back to the backup and it restarts.${s.kind === "cluster" ? ' Nodes already done keep what they got: to take them back too, use "Back to" under Revisions.' : ""}`, "Roll back", true)}>Roll back</button><span className="muted small">{full ? (c.progress.wrote ? "Every node back to its old files, then all start." : "Starts again the nodes that were stopped.") : s.kind === "cluster" ? `${who} back to its old files. Nodes already done stay as they are.` : "Its old files back, and started again."}</span></div>);
    rows.push(<div key="close"><button className="danger" disabled={busy} onClick={() => void act("close", c.progress.wrote
      ? `Close this change with the files as they are?\n\nWriting has begun and they are not back: the nodes may hold old and new values side by side, and such a cluster may not form. This goes on the timeline. What differs shows as drift, and you sort it out by hand.`
      : `Close this change and accept things as they are?\n\nNothing on the hosts is touched. ${c.progress.done.length ? `${c.progress.done.length} node${c.progress.done.length > 1 ? "s" : ""} already done keep${c.progress.done.length > 1 ? "" : "s"} what ${c.progress.done.length > 1 ? "they" : "it"} got. ` : ""}Anything left different shows as drift, and the service is free for other changes.`, "Close the change", true, c.progress.wrote ? { filesMayBeMixed: true } : {})}>Close, accept as it is</button><span className="muted small">Touches nothing on the hosts and frees the service.{c.progress.wrote ? " The files may stay a mix of old and new." : ""}</span></div>);
  }
  return rows.length ? <div className="change-actions">{rows}</div> : null;
}

/** One change: how far it got, what stopped it, and for the one holding the service, the buttons. */
function ChangeRun({ c, s, desk, canSteer, onLogs }: { c: ServiceChangeView; s: ServiceStatus; desk: ChangeDesk; canSteer: boolean; onLogs: () => void }) {
  const [error, setError] = useState("");
  const st = CHANGE_STATE[c.state] ?? { label: c.state, tone: "muted" };
  const steps: Steps = c.steps ?? [];
  const open = steps.filter((x) => x.state === "running");
  const warnings = steps.flatMap((x) => (x.detail.warnings as string[] | undefined) ?? []);
  const live = !c.finishedAt;
  /** The engine's messages name members by key: here, as everywhere on the page, by what a person tells them by. */
  const named = (text: string) => s.members.reduce((out, m) => out.split(m.key).join(memberName(s, m.key)), text);
  return (
    <section className={`card plan change-run state-${c.state}${c.mode === "full" ? " is-full" : ""}`}>
      <div className="draft-bar-main">
        <h3>{changeName(c, s)}</h3>
        <span className={`badge ${st.tone}`}>{st.label}</span>
        {c.mode === "full" && <span className="badge bad">Whole cluster</span>}
        <span className="muted small">by {c.createdBy} · {when(c.createdAt)}{c.finishedAt ? ` · took ${took(c.createdAt, c.finishedAt)}` : ""}</span>
      </div>
      {c.reason && <p className="small">Why: {c.reason}</p>}
      {c.message && <div className={`banner inline ${c.state === "succeeded" ? "info" : c.state === "stopped" ? "bad" : "warn"}`}>{named(c.message)}</div>}
      {warnings.length > 0 && <div className="banner warn inline">When it started: {named(warnings.join("; "))}.</div>}
      {c.mode === "full" ? <FullProgress c={c} s={s} /> : <MemberProgress c={c} s={s} steps={steps} />}
      {live && open.length > 0 && <p className="small muted">Now: {open.map((x) => `${stepLabel(x.step)}${x.member ? ` on ${memberName(s, x.member)}` : ""}`).join(", ")}; gives up at {new Date(Math.max(...open.map((x) => Date.parse(x.deadline)))).toLocaleTimeString("en-US", { hour12: false })}.</p>}
      {live && canSteer && <ChangeActions c={c} s={s} desk={desk} onBusy={setError} />}
      {live && !canSteer && <p className="muted small">Steering a change takes the environment's deploy role.</p>}
      {error && <p className="error">{error}</p>}
      {steps.length > 0 && <details>
        <summary>Every step ({steps.length})</summary>
        <table className="props revisions">
          <thead><tr><th>Step</th><th>Node</th><th>State</th><th>Took</th><th>Said</th></tr></thead>
          <tbody>{steps.map((x) => (
            <tr key={x.seq}>
              <td>{stepLabel(x.step)}</td>
              <td className="mono small">{x.member ? memberName(s, x.member) : <span className="muted">All</span>}</td>
              <td><span className={`badge ${STEP_TONE[x.state] ?? "muted"}`}>{x.state}</span></td>
              <td className="nowrap small">{took(x.startedAt, x.finishedAt)}</td>
              <td className="small">{x.detail.message ? named(x.detail.message as string) : <span className="muted">—</span>}</td>
            </tr>
          ))}</tbody>
        </table>
        <p className="muted small">What NiFi itself said is on the <button className="link" onClick={onLogs}>Logs tab</button>.</p>
      </details>}
    </section>
  );
}

function ChangeHistory({ s, desk, canSteer, onLogs }: { s: ServiceStatus; desk: ChangeDesk; canSteer: boolean; onLogs: () => void }) {
  const [shown, setShown] = useState<string | null>(null);
  const [detail, setDetail] = useState<ServiceChangeView | undefined>();
  useEffect(() => {
    let on = true;
    setDetail(undefined);
    if (shown) api.serviceChange(s.id, shown).then((x) => { if (on) setDetail(x); }, () => undefined);
    return () => { on = false; };
  }, [s.id, shown]);
  const ended = desk.list.filter((c) => c.finishedAt);
  return (
    <section className="panel">
      <h3>Changes</h3>
      {!ended.length ? <p className="muted">{desk.active ? "None has ended yet." : "None so far. A change starts from a revision below, Rolling restart at the top of the page, or the Nodes tab."}</p> : <table className="props revisions">
        <thead><tr><th>Change</th><th>State</th><th>By</th><th>Started</th><th>Took</th><th>Why</th></tr></thead>
        <tbody>{ended.map((c) => {
          const st = CHANGE_STATE[c.state] ?? { label: c.state, tone: "muted" };
          return (
            <tr key={c.id} className={c.id === shown ? "selected" : ""}>
              <td><button className="link" onClick={() => setShown(c.id === shown ? null : c.id)} aria-pressed={c.id === shown}>{changeName(c, s)}</button>{c.mode === "full" && <span className="badge bad">Whole cluster</span>}</td>
              <td><span className={`badge ${st.tone}`}>{st.label}</span></td>
              <td>{c.createdBy}</td>
              <td className="nowrap">{when(c.createdAt)}</td>
              <td className="nowrap">{took(c.createdAt, c.finishedAt)}</td>
              <td>{c.reason ?? <span className="muted">—</span>}</td>
            </tr>
          );
        })}</tbody>
      </table>}
      {detail && <ChangeRun c={detail} s={s} desk={desk} canSteer={canSteer} onLogs={onLogs} />}
    </section>
  );
}

export function ServiceChanges({ s, cfg, drafts, desk, onSaved, onEdit, onLogs }: { s: ServiceStatus; cfg: ServiceConfigView; drafts: Drafts; desk: ChangeDesk; onSaved: () => void; onEdit: () => void; onLogs: () => void }) {
  const { refresh } = drafts;
  useEffect(refresh, [refresh]);
  const current = drafts.active;
  const notApplied = s.members.flatMap((m) => m.configPending.map((file) => ({ member: m.key, file })));
  return (
    <>
      <p className="muted small page-note">Drafts become revisions here, and a revision is kept until it is applied. Only a plan you confirm changes a host.</p>
      {desk.asked && <PlanPanel key={JSON.stringify(desk.asked)} s={s} desk={desk} request={desk.asked} canSteer={cfg.canDraft} />}
      {desk.active && <ChangeRun c={desk.active} s={s} desk={desk} canSteer={cfg.canDraft} onLogs={onLogs} />}
      {!desk.active && !desk.asked && cfg.canDraft && notApplied.length > 0 && <div className="banner info inline pending-bar">
        <span>r{cfg.revision} is saved but not on the hosts yet: {notApplied.length} file{notApplied.length > 1 ? "s" : ""}{s.kind === "cluster" ? ` on ${new Set(notApplied.map((x) => x.member)).size} node${new Set(notApplied.map((x) => x.member)).size > 1 ? "s" : ""}` : ""}.</span>
        <button className="primary" onClick={() => desk.plan({ kind: "apply", revision: cfg.revision })}>Plan applying r{cfg.revision}</button>
      </div>}
      <ChangeHistory s={s} desk={desk} canSteer={cfg.canDraft} onLogs={onLogs} />
      <Drift s={s} cfg={cfg} desk={desk} onSaved={onSaved} />
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
      <Revisions s={s} cfg={cfg} desk={desk} onSaved={onSaved} />
    </>
  );
}
