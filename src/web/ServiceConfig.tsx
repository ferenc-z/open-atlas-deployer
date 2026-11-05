// A service's Configuration tab (S24): a tab per file, and three ways to look at a properties file: the grouped
// property table (default; by the profile catalog's sections, each key's status against the shipped default, the
// catalog's description on hover), the node comparison (clusters only: a column per node, differences first and
// coloured by how much they matter, the identical keys folded into one row), and the file itself (line numbers,
// keys and values coloured, comments dimmed, folding by "# Section #" comments). XML files have only the file view.
// Secret values are always "(hidden)"; the comparison labels them "value A" / "value B" (worked out on the server).

import { Fragment, useMemo, useState } from "react";
import type { CatalogView, CompareRow, PropertyRow, ServiceConfigView, ServiceStatus } from "./api.ts";
import { webPort, when } from "./svc.tsx";

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

export function ServiceConfig({ cfg, status }: { cfg: ServiceConfigView | null | undefined; status: ServiceStatus }) {
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
  return (
    <div className="panel">
      <div className="muted small">Revision {cfg.revision} · {cfg.source === "import" ? "imported from the hosts at takeover" : cfg.source} · {when(cfg.savedAt)} by {cfg.savedBy} · secret values hidden</div>
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
        : shown === "table" ? <PropertyTable key={name} rows={cfg.view?.rows[Math.min(member, members.length - 1)]?.files[name] ?? []} catalog={catalog} file={name} sections={cfg.view?.sections ?? []} />
        : shown === "compare" ? <CompareTable key={name} rows={cfg.view?.compare?.find((c) => c.name === name)?.rows ?? []} labels={members.map((_, i) => label(i))} catalog={catalog} file={name} />
        : <>
          {cluster && format !== "properties" && (() => { const c = cfg.view?.compare?.find((x) => x.name === name); return c ? <p className={`small ${c.identical ? "muted" : "error"}`}>{c.identical ? "The same on every node." : "Differs between the nodes: pick a node above to see each."}</p> : null; })()}
          <RawFile key={`${name}:${member}`} text={record!.redacted} format={format} />
        </>}
    </div>
  );
}

function PropertyTable({ rows, catalog, file, sections }: { rows: PropertyRow[]; catalog: Map<string, CatalogView>; file: string; sections: readonly string[] }) {
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
      <table className="props">
        <thead><tr><th>Key</th><th>Value</th><th>Status</th></tr></thead>
        <tbody>{order.map((section) => {
          const here = visible.filter((r) => r.section === section);
          if (!here.length) return null;
          const shut = folded.has(section);
          return (
            <Fragment key={section}>
              <tr className="group-row"><td colSpan={3}><button className="link" onClick={() => toggle(section)} aria-expanded={!shut}><span className="caret">{shut ? "▸" : "▾"}</span>{section}</button> <span className="muted small">{here.length}{section === "Other" ? " · not in the profile's catalog" : ""}</span></td></tr>
              {!shut && here.map((r) => {
                const e = catalog.get(`${file}:${r.key}`);
                return (
                  <tr key={`${r.key}:${r.line}`} className={r.status === "changed" ? "changed" : ""}>
                    <td className="mono key"><span className="has-tip" title={tipOf(e)}>{r.key}</span></td>
                    <td className="mono value">{r.status === "hidden" ? <span className="hidden-value"><Lock /> Hidden</span> : r.value === "" ? <span className="muted">(empty)</span> : r.value}
                      {r.status === "changed" && e && <div className="muted small">default {e.default === null ? "not set" : e.default === "" ? "(empty)" : e.default}</div>}</td>
                    <td>{r.status === "changed" ? <span className="badge info" title={tipOf(e)}>Changed</span>
                      : r.status === "hidden" ? <span className="badge muted" title="A secret: never shown, not compared with a default"><Lock /> Hidden</span>
                      : r.status === "default" ? <span className="muted small">Default</span>
                      : <span className="muted small" title="Not in the service profile's catalog: no default to compare with">—</span>}</td>
                  </tr>
                );
              })}
            </Fragment>
          );
        })}</tbody>
      </table>
      {!visible.length && <p className="muted">{onlyChanged ? "No key differs from its default." : "The file has no keys."}</p>}
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
