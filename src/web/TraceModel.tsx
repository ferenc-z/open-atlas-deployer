// S37 step 5 (pages-rethink §4.2.0, T1/T2/T7): a service's business process model, edited by hand. Each service
// defines only its own segment: businesses with match rules, ordered steps bound to a position (picked from NiFi by
// name), entry and exit endpoints naming only this side's channel, and on entries which field a clue is searched by.
// Segments are joined by equal channels; the health card shows the links and the dangling endpoints after a save.

import { useEffect, useState } from "react";
import * as api from "./api.ts";
import type { Business, Channel, Condition, Endpoint, FlowComponent, ServiceStatus, Step, TraceModel, TraceModelView } from "./api.ts";
import { when } from "./svc.tsx";

const KINDS = ["process-group", "input-port", "output-port", "processor", "worker"] as const;
const OPS = ["equals", "prefix", "regex", "exists"] as const;
const CUES = [{ id: "fileName", label: "File name" }, { id: "emailFrom", label: "Email from" }, { id: "emailSubject", label: "Email subject" }] as const;
const CHANNEL_HINT = { s2s: "Site-to-Site", mq: "MQ", external: "External" } as const;

const newStep = (n: number): Step => ({ id: `step-${n}`, name: "", position: { kind: "processor", id: "" } });
const newBusiness = (n: number): Business => ({ id: `business-${n}`, name: "", match: [], steps: [newStep(1)], entries: [{ id: "in", step: "step-1", channel: { type: "external", system: "" }, cues: [{ cue: "fileName", key: "filename" }] }], exits: [] });

export function TraceModelEditor({ s }: { s: ServiceStatus }) {
  const [view, setView] = useState<TraceModelView | undefined>();
  const [model, setModel] = useState<TraceModel | undefined>();
  const [error, setError] = useState<{ message: string; details: string[] } | undefined>();
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => api.traceModel(s.id).then((v) => { setView(v); setModel(structuredClone(v.model)); setError(undefined); }, (e: api.ApiError) => setError({ message: e.message, details: [] }));
  useEffect(() => { void load(); }, [s.id]);
  if (!view || !model) return error ? <p className="error">{error.message}</p> : <p className="muted">Loading…</p>;
  const edit = (fn: (m: TraceModel) => void) => { const m = structuredClone(model); fn(m); setModel(m); setSaved(""); };
  const dirty = JSON.stringify(model) !== JSON.stringify(view.model);
  const save = async () => {
    setBusy(true); setError(undefined);
    try {
      const r = await api.saveTraceModel(s.id, { sources: model.sources, businesses: model.businesses }, view.revision);
      setView({ ...view, model: structuredClone(model), revision: r.revision, health: r.health, savedAt: new Date().toISOString() });
      setSaved(`Saved as revision ${r.revision}.`);
    } catch (e) { setError({ message: (e as api.ApiError).message, details: (e as api.ApiError).details ?? [] }); } finally { setBusy(false); }
  };
  return (
    <div className="panel">
      <p className="muted small">
        How business data goes through this service, for the data trace. Define only this service's own part: each business has steps bound to a place in NiFi,
        entries where its data comes in and exits where it leaves. An exit is joined to another service's entry when both name the same channel (Site-to-Site:
        the receiving service and its input port; MQ: exchange and routing key), so no model refers to another. Saving needs an admin.
      </p>
      <Health view={view} />
      <section className="card">
        <h3>Evidence sources</h3>
        <label className="field">In order of preference
          <input value={model.sources.join(", ")} onChange={(e) => edit((m) => { m.sources = e.target.value.split(",").map((x) => x.trim()).filter(Boolean); })} placeholder="e.g. e2e_trace, provenance" />
          <span className="muted small">Asked in this order; when one has nothing for a step the next one is asked. Available in this Deployer: {view.sources.length ? view.sources.join(", ") : "none yet"}.</span>
        </label>
      </section>
      {model.businesses.map((b, i) => (
        <BusinessCard key={i} s={s} b={b} onChange={(fn) => edit((m) => fn(m.businesses[i]!))} onRemove={() => edit((m) => { m.businesses.splice(i, 1); })} />
      ))}
      <div className="row wrap">
        <button type="button" onClick={() => edit((m) => { m.businesses.push(newBusiness(m.businesses.length + 1)); })}>Add business</button>
        <button type="button" className="primary" disabled={busy || !dirty} onClick={() => void save()}>{busy ? "Saving…" : "Save model"}</button>
        <button type="button" disabled={busy || !dirty} onClick={() => { setModel(structuredClone(view.model)); setError(undefined); }}>Discard changes</button>
        <span className="muted small">Revision {view.revision}{view.savedAt ? `, saved ${when(view.savedAt)}${view.savedBy ? ` by ${view.savedBy}` : ""}` : ""}{dirty ? " · unsaved changes" : ""}</span>
        {saved && <span className="ok small">{saved}</span>}
      </div>
      {error && <div className="error"><p>{error.message}</p>{error.details.length > 0 && <ul className="small">{error.details.map((d) => <li key={d}>{d}</li>)}</ul>}</div>}
    </div>
  );
}

function Health({ view }: { view: TraceModelView }) {
  const { dangling, links } = view.health;
  return (
    <section className="card">
      <h3>Joins with other services</h3>
      {!links.length && !dangling.length && <p className="muted small">No Site-to-Site or MQ endpoints yet.</p>}
      {links.length > 0 && <ul className="small">{links.map((l) => <li key={`${l.channel}-${l.from.service}-${l.from.endpoint}-${l.to.service}-${l.to.endpoint}`}><span className="badge ok">joined</span> {l.from.service} / {l.from.business} exit {l.from.endpoint} → {l.to.service} / {l.to.business} entry {l.to.endpoint} <span className="mono muted">{l.channel}</span></li>)}</ul>}
      {dangling.length > 0 && <ul className="small">{dangling.map((d) => <li key={`${d.side}-${d.business}-${d.endpoint}`}><span className="badge warn">dangling</span> {d.business}: {d.message}</li>)}</ul>}
    </section>
  );
}

function BusinessCard({ s, b, onChange, onRemove }: { s: ServiceStatus; b: Business; onChange: (fn: (b: Business) => void) => void; onRemove: () => void }) {
  return (
    <section className="card">
      <div className="row wrap">
        <h3>{b.name || "New business"}</h3>
        <button type="button" className="link small" onClick={onRemove}>remove business</button>
      </div>
      <div className="form-grid">
        <label className="field">Name<input value={b.name} onChange={(e) => onChange((x) => { x.name = e.target.value; })} placeholder="e.g. Daily orders" /></label>
        <label className="field">Id<input className="mono" value={b.id} onChange={(e) => onChange((x) => { x.id = e.target.value; })} /><span className="muted small">Letters, digits, . _ -; unique in this service.</span></label>
      </div>
      <h4>Recognised by</h4>
      <Conditions list={b.match} onChange={(fn) => onChange((x) => fn(x.match))} empty="Every piece of data at its entries belongs to this business." />
      <h4>Steps, in order</h4>
      <table className="small">
        <thead><tr><th>Id</th><th>Name</th><th>Where</th><th>Max time (s)</th><th /></tr></thead>
        <tbody>{b.steps.map((st, i) => <StepRow key={i} s={s} st={st} onChange={(fn) => onChange((x) => fn(x.steps[i]!))}
          onMove={(d) => onChange((x) => { const j = i + d; if (j < 0 || j >= x.steps.length) return; [x.steps[i], x.steps[j]] = [x.steps[j]!, x.steps[i]!]; })}
          onRemove={() => onChange((x) => { x.steps.splice(i, 1); })} />)}</tbody>
      </table>
      <button type="button" className="small" onClick={() => onChange((x) => { x.steps.push(newStep(x.steps.length + 1)); })}>Add step</button>
      <h4>Entries</h4>
      <Endpoints side="entry" b={b} list={b.entries} onChange={(fn) => onChange((x) => fn(x.entries))} />
      <h4>Exits</h4>
      <Endpoints side="exit" b={b} list={b.exits} onChange={(fn) => onChange((x) => fn(x.exits))} />
    </section>
  );
}

function StepRow({ s, st, onChange, onMove, onRemove }: { s: ServiceStatus; st: Step; onChange: (fn: (x: Step) => void) => void; onMove: (d: number) => void; onRemove: () => void }) {
  const [finding, setFinding] = useState(false);
  return (
    <tr>
      <td><input className="mono" size={10} value={st.id} onChange={(e) => onChange((x) => { x.id = e.target.value; })} aria-label="Step id" /></td>
      <td><input size={16} value={st.name} onChange={(e) => onChange((x) => { x.name = e.target.value; })} aria-label="Step name" placeholder="e.g. Pick up" /></td>
      <td>
        <div className="row wrap">
          <select value={st.position.kind} onChange={(e) => onChange((x) => { x.position.kind = e.target.value as Step["position"]["kind"]; })} aria-label="Position kind">{KINDS.map((k) => <option key={k}>{k}</option>)}</select>
          <input className="mono" size={24} value={st.position.id} onChange={(e) => onChange((x) => { x.position.id = e.target.value; })} aria-label="Position id" placeholder={st.position.kind === "worker" ? "worker name" : "component id"} />
          {st.position.name && <span className="muted">{st.position.name}</span>}
          {st.position.kind !== "worker" && <button type="button" className="link small" onClick={() => setFinding(!finding)}>{finding ? "close" : "find in NiFi"}</button>}
        </div>
        {finding && <Finder s={s} onPick={(c) => { onChange((x) => { x.position = { kind: c.kind, id: c.id, ...(c.name ? { name: c.name } : {}) }; if (!x.name && c.name) x.name = c.name; }); setFinding(false); }} />}
      </td>
      <td><input type="number" min={1} style={{ width: "6em" }} value={st.maxSeconds ?? ""} placeholder="900" onChange={(e) => onChange((x) => { if (e.target.value) x.maxSeconds = Number(e.target.value); else delete x.maxSeconds; })} aria-label="Max seconds" /></td>
      <td className="nowrap"><button type="button" className="link small" onClick={() => onMove(-1)} title="Move up">↑</button> <button type="button" className="link small" onClick={() => onMove(1)} title="Move down">↓</button> <button type="button" className="link small" onClick={onRemove}>remove</button></td>
    </tr>
  );
}

/** A name search on the service's NiFi (its own component search, through a member's service executor). */
function Finder({ s, onPick }: { s: ServiceStatus; onPick: (c: FlowComponent) => void }) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<{ results: FlowComponent[]; truncated: boolean } | undefined>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async () => { setBusy(true); setError(""); try { setFound(await api.searchPositions(s.id, q.trim())); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return (
    <div className="card small">
      <form className="row wrap" onSubmit={(e) => { e.preventDefault(); if (q.trim()) void run(); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="a process group, port or processor name" maxLength={100} aria-label="Search NiFi components" />
        <button disabled={busy || !q.trim()}>{busy ? "Searching…" : "Search"}</button>
      </form>
      {error && <p className="error small">{error}</p>}
      {found && !found.results.length && <p className="muted small">Nothing found.</p>}
      {found && found.results.length > 0 && <ul className="small">{found.results.map((c) => <li key={c.id}><button type="button" className="link" onClick={() => onPick(c)}>{c.name ?? c.id}</button> <span className="muted">{c.kind}{c.groupName ? ` in ${c.groupName}` : ""}</span> <span className="mono muted">{c.id}</span></li>)}</ul>}
      {found?.truncated && <p className="muted small">More found than shown: be more specific.</p>}
    </div>
  );
}

function Conditions({ list, onChange, empty }: { list: Condition[]; onChange: (fn: (l: Condition[]) => void) => void; empty: string }) {
  return (
    <div className="small">
      {!list.length && <p className="muted">{empty}</p>}
      {list.map((c, i) => (
        <div className="row wrap" key={i}>
          <input value={c.attr} onChange={(e) => onChange((l) => { l[i]!.attr = e.target.value; })} placeholder="attribute" aria-label="Attribute" />
          <select value={c.op} onChange={(e) => onChange((l) => { l[i]!.op = e.target.value as Condition["op"]; if (l[i]!.op === "exists") delete l[i]!.value; else l[i]!.value ??= ""; })} aria-label="Condition">{OPS.map((o) => <option key={o}>{o}</option>)}</select>
          {c.op !== "exists" && <input value={c.value ?? ""} onChange={(e) => onChange((l) => { l[i]!.value = e.target.value; })} placeholder="value" aria-label="Value" />}
          <button type="button" className="link" onClick={() => onChange((l) => { l.splice(i, 1); })}>remove</button>
        </div>
      ))}
      <button type="button" className="link small" onClick={() => onChange((l) => { l.push({ attr: "", op: "equals", value: "" }); })}>add condition</button>
    </div>
  );
}

function ChannelFields({ side, c, onChange }: { side: "entry" | "exit"; c: Channel; onChange: (fn: (c: Channel) => void) => void }) {
  const set = (k: keyof Channel) => (e: { target: { value: string } }) => onChange((x) => { (x as unknown as Record<string, string>)[k] = e.target.value; });
  return (
    <span className="row wrap">
      <select value={c.type} onChange={(e) => onChange((x) => { for (const k of Object.keys(x)) delete (x as unknown as Record<string, unknown>)[k]; x.type = e.target.value as Channel["type"]; })} aria-label="Channel type">
        {(["s2s", "mq", "external"] as const).map((t) => <option key={t} value={t}>{CHANNEL_HINT[t]}</option>)}
      </select>
      {c.type === "s2s" && side === "exit" && <input value={c.service ?? ""} onChange={set("service")} placeholder="receiving service" aria-label="Receiving service" />}
      {c.type === "s2s" && <input value={c.port ?? ""} onChange={set("port")} placeholder={side === "exit" ? "its input port" : "this service's input port"} aria-label="Input port" />}
      {c.type === "mq" && <><input value={c.exchange ?? ""} onChange={set("exchange")} placeholder="exchange" aria-label="Exchange" /><input value={c.routingKey ?? ""} onChange={set("routingKey")} placeholder="routing key" aria-label="Routing key" /></>}
      {c.type === "external" && <input value={c.system ?? ""} onChange={set("system")} placeholder={side === "entry" ? "e.g. mailbox orders@, sftp:/in" : "e.g. the warehouse"} aria-label="External system" />}
    </span>
  );
}

function Endpoints({ side, b, list, onChange }: { side: "entry" | "exit"; b: Business; list: Endpoint[]; onChange: (fn: (l: Endpoint[]) => void) => void }) {
  return (
    <div className="small">
      {!list.length && <p className="muted">{side === "entry" ? "A business needs at least one entry." : "No exit: the data ends in this service."}</p>}
      {list.map((e, i) => (
        <div className="card" key={i}>
          <div className="row wrap">
            <input className="mono" size={10} value={e.id} onChange={(ev) => onChange((l) => { l[i]!.id = ev.target.value; })} aria-label={`${side} id`} />
            <label className="row">at step <select value={e.step} onChange={(ev) => onChange((l) => { l[i]!.step = ev.target.value; })} aria-label={`${side} step`}>{b.steps.map((s) => <option key={s.id} value={s.id}>{s.name || s.id}</option>)}{!b.steps.some((s) => s.id === e.step) && <option value={e.step}>{e.step || "—"}</option>}</select></label>
            <ChannelFields side={side} c={e.channel} onChange={(fn) => onChange((l) => fn(l[i]!.channel))} />
            {e.channel.type !== "external" && <input value={e.keyAttribute ?? ""} onChange={(ev) => onChange((l) => { if (ev.target.value) l[i]!.keyAttribute = ev.target.value; else delete l[i]!.keyAttribute; })} placeholder={e.channel.type === "mq" ? "key attribute (correlation_id)" : "key attribute (optional)"} aria-label="Key attribute" />}
            <button type="button" className="link" onClick={() => onChange((l) => { l.splice(i, 1); })}>remove</button>
          </div>
          {side === "entry" && <div>
            <span className="muted">Clues searched here:</span>
            {(e.cues ?? []).map((m, j) => (
              <span className="row wrap" key={j}>
                <select value={m.cue} onChange={(ev) => onChange((l) => { l[i]!.cues![j]!.cue = ev.target.value as typeof m.cue; })} aria-label="Clue">{CUES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select>
                <span>is the field</span>
                <input value={m.key} onChange={(ev) => onChange((l) => { l[i]!.cues![j]!.key = ev.target.value; })} placeholder="e.g. filename" aria-label="Clue field" />
                <button type="button" className="link" onClick={() => onChange((l) => { l[i]!.cues!.splice(j, 1); })}>remove</button>
              </span>
            ))}
            <button type="button" className="link" onClick={() => onChange((l) => { (l[i]!.cues ??= []).push({ cue: "fileName", key: "filename" }); })}>add clue</button>
          </div>}
          {side === "exit" && <div><span className="muted">Only when (split condition):</span>
            <Conditions list={e.when ?? []} onChange={(fn) => onChange((l) => { l[i]!.when ??= []; fn(l[i]!.when!); })} empty="Always." /></div>}
        </div>
      ))}
      <button type="button" className="small" onClick={() => onChange((l) => { l.push({ id: `${side === "entry" ? "in" : "out"}-${l.length + 1}`, step: side === "entry" ? (b.steps[0]?.id ?? "") : (b.steps[b.steps.length - 1]?.id ?? ""), channel: side === "entry" ? { type: "external", system: "" } : { type: "s2s", service: "", port: "" }, ...(side === "entry" ? { cues: [] } : {}) }); })}>Add {side}</button>
    </div>
  );
}
