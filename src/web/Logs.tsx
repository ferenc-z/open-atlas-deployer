// A service's Logs tab (§9.3, §15.3, phase 2 step 4): follow one node's file live, search every node at once (merged by
// time), download a node's files as a tar.gz, and the WARN/ERROR summary the collector keeps. Everything is read by the
// node's service executor, only below its registered log directory.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "./api.ts";
import type { LogFile, LogMember, LogPattern, SearchResult, ServiceStatus } from "./api.ts";
import { ago, fmtBytes, when } from "./svc.tsx";

const LEVELS = ["ERROR", "WARN", "INFO", "DEBUG"] as const;
const levelTone = (l: string | null) => (l === "ERROR" || l === "FATAL" ? "bad" : l === "WARN" ? "warn" : "muted");
const MAX_LINES = 3000;
/** A datetime-local value (the browser's zone) for a time. */
const localInput = (t: number) => { const d = new Date(t); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

export function Logs({ s }: { s: ServiceStatus }) {
  const [info, setInfo] = useState<{ members: LogMember[]; patterns: LogPattern[]; hours: number } | undefined>();
  const [error, setError] = useState("");
  const load = useCallback(() => { api.serviceLogs(s.id).then((d) => { setInfo(d); setError(""); }, (e: Error) => setError(e.message)); }, [s.id]);
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);
  if (!info) return error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>;
  const usable = info.members.filter((m) => m.executor.online && m.canRead);
  return (
    <div className="panel">
      <p className="muted small">Read by each node's service executor, only below the log directory registered for the node (<span className="mono">{[...new Set(info.members.map((m) => m.logDir))].join(", ")}</span>); paths outside it are refused. A search reads at most 5000 lines, 4 MiB and 30 seconds per node; a download at most 50 MiB.</p>
      {info.members.filter((m) => !m.executor.online || !m.canRead).map((m) => (
        <p key={m.key} className="error small">{m.label}: {!m.executor.online ? m.executor.reason ?? "service executor offline" : `service executor ${m.executor.version ?? ""} cannot read logs; upgrade it`}</p>
      ))}
      {usable.length > 0 && <>
        <Follow s={s} members={usable} />
        <Search s={s} members={usable} />
        <Download s={s} members={usable} />
      </>}
      <Summary s={s} members={info.members} patterns={info.patterns} hours={info.hours} />
    </div>
  );
}

/** The files of one node's log directory, newest first (nifi-app.log on top). */
function useFiles(id: string, member: string) {
  const [files, setFiles] = useState<LogFile[] | undefined>();
  const [error, setError] = useState("");
  useEffect(() => {
    setFiles(undefined); setError("");
    if (member) api.logFiles(id, member).then((f) => setFiles(f.files), (e: Error) => setError(e.message));
  }, [id, member]);
  return { files, error };
}

function NodePicker({ members, value, onChange, label = "Node" }: { members: LogMember[]; value: string; onChange: (v: string) => void; label?: string }) {
  return (
    <label className="field">{label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>{members.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}</select>
    </label>
  );
}

// §15.2 P7: one node's file, live. The Deployer runs a 2-minute tail on the node and starts the next one from where the
// last stopped while this page follows; everyone following the same file shares it.
function Follow({ s, members }: { s: ServiceStatus; members: LogMember[] }) {
  const [member, setMember] = useState(members[0]!.key);
  const { files } = useFiles(s.id, member);
  const [file, setFile] = useState("nifi-app.log");
  const [on, setOn] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [state, setState] = useState("");
  const [stick, setStick] = useState(true);
  const box = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!on) return;
    setLines([]); setState("Starting…");
    const es = new EventSource(api.logTailUrl(s.id, member, file), { withCredentials: true });
    const add = (text: string, note?: string) => setLines((was) => {
      const more = text.replace(/\n$/, "").split("\n").filter((l, i, all) => l !== "" || i < all.length - 1);
      return [...was, ...(note ? [note] : []), ...(text ? more : [])].slice(-MAX_LINES);
    });
    es.addEventListener("lines", (ev) => {
      const e = JSON.parse((ev as MessageEvent).data);
      add(e.text ?? "", e.rotated ? `── rolled over: the old file is now ${e.rotated}; following the new ${file} ──` : undefined);
    });
    es.addEventListener("state", (ev) => {
      const e = JSON.parse((ev as MessageEvent).data);
      if (e.state === "error") setState(`Problem: ${e.message} (trying again)`);
      else if (e.state === "renewed") { setState(`Following (tail #${e.tails}, ${e.followers} following)`); }
      else setState(`Following${e.followers > 1 ? ` (shared with ${e.followers - 1} more)` : ""}`);
    });
    es.onerror = () => setState("Connection lost; the browser reconnects…");
    return () => es.close();
  }, [on, s.id, member, file]);
  useEffect(() => { if (stick && box.current) box.current.scrollTop = box.current.scrollHeight; }, [lines, stick]);
  const growing = (files ?? []).filter((f) => !f.gz);
  return (
    <section className="card">
      <h3>Follow</h3>
      <p className="muted small">Shows a file as it grows, a piece every second or two. It follows the file by inode and offset, so a restart of NiFi or a rollover does not lose lines; it stops when you stop or leave this page.</p>
      <div className="row wrap">
        <NodePicker members={members} value={member} onChange={(v) => { setOn(false); setMember(v); }} />
        <label className="field">File
          <select value={file} onChange={(e) => { setOn(false); setFile(e.target.value); }}>
            {(growing.length ? growing : [{ name: "nifi-app.log" } as LogFile]).map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
          </select>
        </label>
        <button className={on ? "" : "primary"} onClick={() => setOn(!on)}>{on ? "Stop" : "Follow"}</button>
        <label className="check small"><input type="checkbox" checked={stick} onChange={(e) => setStick(e.target.checked)} /> Keep at the bottom</label>
        {on && <span className="muted small">{state}</span>}
        {lines.length > 0 && <button className="link" onClick={() => setLines([])}>Clear</button>}
      </div>
      {(on || lines.length > 0) && <pre ref={box} className="log tail">{lines.join("\n") || " "}</pre>}
      {lines.length >= MAX_LINES && <p className="muted small">Only the newest {MAX_LINES} lines are kept on the page.</p>}
    </section>
  );
}

// §9.3: every chosen node in parallel; the matches merged by time.
function Search({ s, members }: { s: ServiceStatus; members: LogMember[] }) {
  const [chosen, setChosen] = useState<string[]>(members.map((m) => m.key));
  const [from, setFrom] = useState(() => localInput(Date.now() - 3600_000));
  const [to, setTo] = useState("");
  const [levels, setLevels] = useState<string[]>(["ERROR", "WARN"]);
  const [query, setQuery] = useState("");
  const [regex, setRegex] = useState(false);
  const [limit, setLimit] = useState(1000);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SearchResult | undefined>();
  const [error, setError] = useState("");
  const [open, setOpen] = useState<Set<number>>(new Set());
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const run = async () => {
    setBusy(true); setError(""); setOpen(new Set());
    try {
      setResult(await api.searchLogs(s.id, { members: chosen, from: new Date(from).toISOString(), to: to ? new Date(to).toISOString() : new Date().toISOString(), levels, ...(query ? { query } : {}), ...(regex ? { regex } : {}), limit }));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <section className="card">
      <h3>Search</h3>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void run(); }}>
        <div className="field">Nodes
          <div className="row wrap">{members.map((m) => <label key={m.key} className="check"><input type="checkbox" checked={chosen.includes(m.key)} onChange={() => setChosen(toggle(chosen, m.key))} /> {m.label}</label>)}</div>
          <span className="muted small">Each node chosen is searched at the same time; the results are merged by time.</span>
        </div>
        <label className="field">From<input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} required /><span className="muted small">In your browser's time zone. Rolled-over files (also .gz) last written before this are skipped.</span></label>
        <label className="field">To<input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} /><span className="muted small">Empty: now.</span></label>
        <div className="field">Levels
          <div className="row wrap">{LEVELS.map((l) => <label key={l} className="check"><input type="checkbox" checked={levels.includes(l)} onChange={() => setLevels(toggle(levels, l))} /> {l}</label>)}</div>
          <span className="muted small">An entry's level is its first line's; a stack trace belongs to the entry above it.</span>
        </div>
        <label className="field">Text<input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. ConnectionLoss" maxLength={500} />
          <span className="muted small"><label className="check"><input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} /> Regular expression</label> Case is ignored; an entry matches when its text (stack trace included) holds it. Empty: every entry.</span></label>
        <label className="field">Lines per node<input type="number" min={1} max={5000} value={limit} onChange={(e) => setLimit(Number(e.target.value))} /><span className="muted small">At most 5000; over it the newest are kept.</span></label>
        <div className="row"><button className="primary" disabled={busy || !chosen.length || !levels.length}>{busy ? "Searching…" : "Search"}</button></div>
      </form>
      {error && <p className="error">{error}</p>}
      {result && <>
        <p className="muted small">{result.entries.length} entr{result.entries.length === 1 ? "y" : "ies"} from {when(result.from)} to {when(result.to)}. {result.members.map((m) => `${m.label}: ${m.state === "ok" ? `${m.entries}${m.truncated ? ` (${m.truncated})` : ""}` : `failed (${m.error})`}`).join(" · ")}</p>
        {result.entries.length > 0 && <table className="log-results">
          <thead><tr><th>Time</th><th>Node</th><th>Level</th><th>Entry</th></tr></thead>
          <tbody>{result.entries.map((e, i) => {
            const [head, ...rest] = e.text.split("\n");
            return (
              <tr key={i}>
                <td className="mono small nowrap" title={`${e.local} on the node`}>{when(e.at)}</td>
                <td className="mono small nowrap">{e.label}</td>
                <td><span className={`badge ${levelTone(e.level)}`}>{e.level}</span></td>
                <td className="small">
                  <span className="mono">{head}</span>
                  {rest.length > 0 && <> <button className="link small" onClick={() => setOpen(toggle([...open], i).reduce((a, x) => a.add(x), new Set<number>()))}>{open.has(i) ? "less" : `${rest.length} more line${rest.length > 1 ? "s" : ""}`}</button>
                    {open.has(i) && <pre className="log">{rest.join("\n")}</pre>}</>}
                  <span className="muted"> · {e.file}</span>
                </td>
              </tr>
            );
          })}</tbody>
        </table>}
      </>}
    </section>
  );
}

function Download({ s, members }: { s: ServiceStatus; members: LogMember[] }) {
  const [member, setMember] = useState(members[0]!.key);
  const { files, error } = useFiles(s.id, member);
  const [picked, setPicked] = useState<string[]>(["nifi-app.log"]);
  useEffect(() => { setPicked(["nifi-app.log"]); }, [member]);
  const total = (files ?? []).filter((f) => picked.includes(f.name)).reduce((n, f) => n + f.size, 0);
  return (
    <section className="card">
      <h3>Download</h3>
      <p className="muted small">The chosen files of one node as a .tar.gz, at most 50 MiB packed (files that would not fit are left out and the download says so in its name list). Downloads are audited.</p>
      <div className="row wrap"><NodePicker members={members} value={member} onChange={setMember} /></div>
      {error && <p className="error">{error}</p>}
      {!files && !error && <p className="muted small">Listing the log directory…</p>}
      {files && <div className="file-list">{files.map((f) => (
        <label key={f.name} className="check small">
          <input type="checkbox" checked={picked.includes(f.name)} onChange={() => setPicked(picked.includes(f.name) ? picked.filter((x) => x !== f.name) : [...picked, f.name])} />
          <span className="mono">{f.name}</span> <span className="muted">{fmtBytes(f.size)} · {ago(f.modifiedAt)}</span>
        </label>
      ))}</div>}
      <div className="row">
        {picked.length ? <a className="button primary" href={api.logDownloadUrl(s.id, member, picked)} download>Download {picked.length} file{picked.length > 1 ? "s" : ""} ({fmtBytes(total)} unpacked)</a> : <span className="muted small">Choose files.</span>}
      </div>
    </section>
  );
}

// §15.3: what the collector keeps of nifi-app.log: WARN/ERROR entries counted by pattern, with the first and the newest.
function Summary({ s, members, patterns, hours }: { s: ServiceStatus; members: LogMember[]; patterns: LogPattern[]; hours: number }) {
  const label = useMemo(() => new Map(members.map((m) => [m.key, m.label])), [members]);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="card">
      <h3>WARN and ERROR in nifi-app.log</h3>
      <p className="muted small">Collected with every sample: each entry is reduced to a pattern (numbers, IDs, addresses and paths replaced) and counted; the first and the newest entry are kept, cut at 2 KiB, with what looks like a password, token or key hidden. Shown: the patterns seen in the last {hours} hours, the most frequent first. The ZooKeeper alert counts these too.</p>
      {!patterns.length ? <p className="muted"><span className="badge ok">None</span> {s.members.length > 1 ? "on any node" : ""}</p> :
        <table>
          <thead><tr><th>Level</th><th>{s.kind === "cluster" ? "Node" : "Host"}</th><th>Count</th><th>Pattern</th><th>Last seen</th></tr></thead>
          <tbody>{patterns.map((p) => {
            const k = `${p.member}:${p.pattern}`;
            return (
              <tr key={k}>
                <td><span className={`badge ${levelTone(p.level)}`}>{p.level}</span></td>
                <td className="mono small nowrap">{label.get(p.member) ?? p.member}</td>
                <td className="mono small" title={`${p.total} since ${when(p.firstAt)}`}>{p.count}</td>
                <td className="small">
                  <span className="mono muted">{p.logger}</span> <span className="mono">{p.template}</span>{p.exception && <span className="mono error"> {p.exception}</span>}
                  {" "}<button className="link small" onClick={() => setOpen(open === k ? null : k)}>{open === k ? "hide" : "examples"}</button>
                  {open === k && <><p className="muted small">First ({when(p.firstAt)}):</p><pre className="log">{p.firstSample}</pre><p className="muted small">Newest ({when(p.lastAt)}):</p><pre className="log">{p.lastSample}</pre></>}
                </td>
                <td className="muted small nowrap" title={when(p.lastAt)}>{ago(p.lastAt)}</td>
              </tr>
            );
          })}</tbody>
        </table>}
    </section>
  );
}
