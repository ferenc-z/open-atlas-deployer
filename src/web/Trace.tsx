// A service's FlowFile trace tab (§9.5, S28, phase 2 step 7): NiFi's provenance, read by a member's service executor
// with the monitor certificate. Search by a FlowFile UUID or a searchable field in a time range (required, the last
// hour by default); the events by time with their component and relationship; a FlowFile's lineage, expanded to an
// event's parents or children; one event's details; the logs and bulletins around an event's time.

import { useEffect, useMemo, useState } from "react";
import * as api from "./api.ts";
import type { LineageNode, LineageResult, ProvenanceInfo, ProvenanceResult, ProvEvent, SearchResult, ServiceBulletin, ServiceStatus } from "./api.ts";
import { fmtBytes, when } from "./svc.tsx";

/** A datetime-local value (the browser's zone) for a time. */
const localInput = (t: number) => { const d = new Date(t); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const FIELDS = [{ id: "Filename", label: "Filename" }, { id: "ProcessorID", label: "Component ID" }, { id: "EventType", label: "Event Type" }, { id: "Relationship", label: "Relationship" }];
const typeTone = (t?: string) => (t === "DROP" || t === "EXPIRE" ? "muted" : t === "RECEIVE" || t === "CREATE" || t === "FETCH" ? "ok" : t === "SEND" || t === "REMOTE_INVOCATION" ? "info" : "");
/** The events whose FlowFile came from others or became others: NiFi expands only these to their parents and children. */
const EXPANDS = ["FORK", "JOIN", "CLONE", "REPLAY"];
const short = (uuid?: string) => (uuid ? `${uuid.slice(0, 8)}…` : "—");

export function FlowFileTrace({ s }: { s: ServiceStatus }) {
  const [info, setInfo] = useState<ProvenanceInfo | undefined>();
  const [error, setError] = useState("");
  useEffect(() => { api.provenanceInfo(s.id).then(setInfo, (e: Error) => setError(e.message)); }, [s.id]);
  const [result, setResult] = useState<ProvenanceResult | undefined>();
  const [ask, setAsk] = useState<{ uuid?: string; node?: string; at?: string } | undefined>();
  const [lineageOf, setLineageOf] = useState<{ uuid: string; node?: string } | undefined>();
  const [detail, setDetail] = useState<ProvEvent | undefined>();
  if (!info) return error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>;
  const cluster = s.kind === "cluster";
  return (
    <div className="panel">
      <p className="muted small">
        Read from NiFi's provenance repository by {cluster ? "a node's" : "the host's"} service executor with the monitor certificate (NiFi grants its identity
        "query provenance" and "view provenance" on the flow). Each search asks NiFi once{cluster ? " for the whole cluster (NiFi merges the nodes' events)" : ""}, at most
        100 events, 4 MiB and 30 seconds, and the query is deleted on NiFi afterwards. Only reads: nothing is replayed, no content is read.
      </p>
      {!info.supported && <p><span className="badge bad">Not supported</span> {info.note}</p>}
      {info.supported && !info.ready && <div>{info.members.filter((m) => m.reason).map((m) => <p key={m.key} className="error small">{m.label}: {m.reason}</p>)}</div>}
      {info.ready && <>
        <Search s={s} info={info} onResult={(r) => { setResult(r); setDetail(undefined); }} preset={ask} />
        {result && <Events s={s} result={result} onUuid={(uuid, node) => setAsk({ uuid, ...(node ? { node } : {}) })} onLineage={(e) => setLineageOf({ uuid: e.flowFileUuid, ...(e.clusterNodeId ? { node: e.clusterNodeId } : {}) })} onDetail={setDetail} />}
        {detail && <Detail s={s} event={detail} onClose={() => setDetail(undefined)} />}
        {lineageOf && <Lineage s={s} uuid={lineageOf.uuid} node={lineageOf.node} onClose={() => setLineageOf(undefined)} onDetail={(n) => setDetail({ eventId: Number(n.id), at: n.at, eventType: n.eventType ?? "", flowFileUuid: n.flowFileUuid ?? "", ...(n.clusterNodeIdentifier ? { clusterNodeId: n.clusterNodeIdentifier } : {}), ...(n.componentName ? { componentName: n.componentName } : {}), ...(n.componentId ? { componentId: n.componentId } : {}) })} />}
      </>}
    </div>
  );
}

function Search({ s, info, onResult, preset }: { s: ServiceStatus; info: ProvenanceInfo; onResult: (r: ProvenanceResult) => void; preset: { uuid?: string; node?: string } | undefined }) {
  const cluster = s.kind === "cluster";
  const [by, setBy] = useState<"uuid" | "field">("uuid");
  const [uuid, setUuid] = useState("");
  const [field, setField] = useState("Filename");
  const [fields, setFields] = useState(FIELDS);
  const [value, setValue] = useState("");
  const [from, setFrom] = useState(() => localInput(Date.now() - 3600_000));
  const [to, setTo] = useState(() => localInput(Date.now() + 60_000));
  const [node, setNode] = useState("");
  const [max, setMax] = useState(100);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (by === "field") api.provenanceOptions(s.id).then((o) => { if (o.fields.length) setFields(o.fields.filter((f) => f.id !== "FlowFileUUID").map((f) => ({ id: f.id, label: f.label }))); }, () => undefined);
  }, [by, s.id]);
  const run = async (q?: { uuid: string; node?: string }) => {
    setBusy(true); setError("");
    try {
      const nodeId = q ? q.node ?? "" : node;
      onResult(await api.searchProvenance(s.id, {
        ...(q ? { uuid: q.uuid } : by === "uuid" ? { uuid: uuid.trim() } : { field, value: value.trim() }),
        from: new Date(from).toISOString(), to: new Date(to).toISOString(), maxResults: max, ...(nodeId ? { node: nodeId } : {}),
      }));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  useEffect(() => {
    if (!preset?.uuid) return;
    setBy("uuid"); setUuid(preset.uuid); setNode(preset.node ?? "");
    void run({ uuid: preset.uuid, ...(preset.node ? { node: preset.node } : {}) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset]);
  const nodes = useMemo(() => info.members, [info]);
  return (
    <section className="card">
      <h3>Search</h3>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void run(); }}>
        <div className="field">Search by
          <div className="row wrap">
            <label className="check"><input type="radio" checked={by === "uuid"} onChange={() => setBy("uuid")} /> FlowFile UUID</label>
            <label className="check"><input type="radio" checked={by === "field"} onChange={() => setBy("field")} /> A searchable field</label>
          </div>
          <span className="muted small">A FlowFile's UUID finds every event of that FlowFile. The other fields are the ones NiFi indexes (nifi.provenance.repository.indexed.fields).</span>
        </div>
        {by === "uuid"
          ? <label className="field">FlowFile UUID<input className="mono" value={uuid} onChange={(e) => setUuid(e.target.value)} placeholder="e.g. 7ec93cd5-70f6-46f7-ae7d-ed4ce7da330c" required pattern="[0-9a-fA-F-]{36}" />
              <span className="muted small">The uuid attribute, as NiFi shows it in a queue listing or a log line.</span></label>
          : <>
              <label className="field">Field<select value={field} onChange={(e) => setField(e.target.value)}>{fields.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</select>
                <span className="muted small">Component ID is a processor's id; Event Type is e.g. RECEIVE, CREATE, ROUTE, SEND, DROP.</span></label>
              <label className="field">Value<input value={value} onChange={(e) => setValue(e.target.value)} required maxLength={256} placeholder="e.g. orders-2026-11-06.csv" />
                <span className="muted small">Matched as NiFi matches it (the whole value; * as a wildcard).</span></label>
            </>}
        <label className="field">From<input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} required /><span className="muted small">Required, in your browser's time zone. Keep the range tight: NiFi searches its whole repository index for it.</span></label>
        <label className="field">To<input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} required /><span className="muted small">Required. The default range is the last hour.</span></label>
        {cluster && <div className="field">Nodes
          {node ? <span className="small">Only NiFi node <span className="mono">{node}</span> <button type="button" className="link small" onClick={() => setNode("")}>ask the whole cluster</button></span>
            : <span className="small">The whole cluster ({nodes.map((m) => m.label).join(", ")})</span>}
          <span className="muted small">The cluster is asked through one node and NiFi merges every node's events. To ask one node only, use "this node" on one of its events (NiFi names nodes by its own ids).</span>
        </div>}
        <label className="field">Events at most<input type="number" min={1} max={100} value={max} onChange={(e) => setMax(Number(e.target.value))} /><span className="muted small">1 to 100. Over it NiFi keeps the newest.</span></label>
        <div className="row"><button className="primary" disabled={busy}>{busy ? "Searching…" : "Search"}</button></div>
      </form>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function Events({ s, result, onUuid, onLineage, onDetail }: { s: ServiceStatus; result: ProvenanceResult; onUuid: (uuid: string, node?: string) => void; onLineage: (e: ProvEvent) => void; onDetail: (e: ProvEvent) => void }) {
  const cluster = s.kind === "cluster";
  const [around, setAround] = useState<ProvEvent | undefined>();
  const label = (m?: string | null, addr?: string) => s.members.find((x) => x.key === m) ? `${s.members.find((x) => x.key === m)!.nodeAddress ?? s.members.find((x) => x.key === m)!.host}${addr ? `:${addr.split(":").pop()}` : ""}` : addr ?? "—";
  return (
    <section className="card">
      <h3>Events</h3>
      <p className="muted small">
        {result.events.length} of {result.totalText ?? result.total} event{result.total === 1 ? "" : "s"} from {when(result.from)} to {when(result.to)}, oldest first; asked through {result.via.label} ({result.scope}, NiFi {result.nifiVersion}).
        {result.limitReached && <strong> The limit was reached: narrow the time range or the search.</strong>}
      </p>
      {(result.notes ?? []).map((n, i) => <p key={i} className="muted small">Note: {n}</p>)}
      {result.errors.map((n, i) => <p key={i} className="error small">{n}</p>)}
      {result.events.length > 0 && <table className="log-results">
        <thead><tr><th>Time</th>{cluster && <th>Node</th>}<th>Event</th><th>Component</th><th>Relationship</th><th>FlowFile</th><th>Size</th><th></th></tr></thead>
        <tbody>{result.events.map((e) => (
          <tr key={`${e.clusterNodeId ?? ""}:${e.eventId}`}>
            <td className="mono small nowrap" title={e.eventTime ? `${e.eventTime} on NiFi` : undefined}>{e.at ? when(e.at) : e.eventTime ?? "—"}</td>
            {cluster && <td className="mono small nowrap" title={e.clusterNodeId}>{label(e.member, e.clusterNodeAddress)}</td>}
            <td><span className={`badge ${typeTone(e.eventType)}`}>{e.eventType}</span><span className="muted small mono"> #{e.eventId}</span></td>
            <td className="small">{e.componentName ?? "—"} <span className="muted">{e.componentType}</span>{e.details && <div className="muted small">{e.details}</div>}</td>
            <td className="small">{e.relationship ?? <span className="muted">—</span>}</td>
            <td className="mono small" title={e.flowFileUuid}><button className="link small mono" onClick={() => onUuid(e.flowFileUuid)} title="Search every event of this FlowFile">{short(e.flowFileUuid)}</button></td>
            <td className="small nowrap">{e.fileSizeBytes !== undefined ? fmtBytes(e.fileSizeBytes) : "—"}</td>
            <td className="small nowrap">
              <button className="link small" onClick={() => onLineage(e)}>lineage</button> · <button className="link small" onClick={() => onDetail(e)}>details</button> · <button className="link small" onClick={() => setAround(around === e ? undefined : e)}>{around === e ? "hide logs" : "logs and bulletins"}</button>
              {cluster && e.clusterNodeId && <> · <button className="link small" onClick={() => onUuid(e.flowFileUuid, e.clusterNodeId)} title="Search this FlowFile on this node only">this node</button></>}
            </td>
          </tr>
        ))}</tbody>
      </table>}
      {around && <Around s={s} event={around} />}
    </section>
  );
}

// §9.5: from an event to the logs and bulletins of its time: the node's log lines (± 2 minutes) naming the component,
// and the bulletins of that time.
function Around({ s, event }: { s: ServiceStatus; event: ProvEvent }) {
  const [minutes, setMinutes] = useState(2);
  const [all, setAll] = useState(false);
  const [logs, setLogs] = useState<SearchResult | undefined>();
  const [bulletins, setBulletins] = useState<ServiceBulletin[] | undefined>();
  const [error, setError] = useState("");
  const at = event.at ? Date.parse(event.at) : NaN;
  useEffect(() => {
    if (Number.isNaN(at)) return;
    setLogs(undefined); setBulletins(undefined); setError("");
    const from = new Date(at - minutes * 60_000).toISOString(), to = new Date(at + minutes * 60_000).toISOString();
    api.searchLogs(s.id, { ...(event.member ? { members: [event.member] } : {}), from, to, levels: ["ERROR", "WARN", "INFO"], ...(!all && event.componentId ? { query: event.componentId } : {}), limit: 500 })
      .then(setLogs, (e: Error) => setError(e.message));
    api.bulletinsBetween(s.id, from, to).then((b) => setBulletins(b.bulletins), () => setBulletins([]));
  }, [s.id, at, minutes, all, event.member, event.componentId]);
  if (Number.isNaN(at)) return <p className="muted small">This event's time could not be read, so there is no time range to look in.</p>;
  const mine = (bulletins ?? []).filter((b) => all || !event.componentName || b.source === event.componentName);
  return (
    <div className="card">
      <h3>Around {when(event.at!)}: {event.componentName ?? "the event"}</h3>
      <div className="row wrap">
        <label className="field">Minutes before and after<input type="number" min={1} max={30} value={minutes} onChange={(e) => setMinutes(Math.max(1, Math.min(30, Number(e.target.value))))} /><span className="muted small">The logs of {event.member ? "this event's node" : "every node"} are searched in that window.</span></label>
        <label className="check small"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Everything in the window, not only what names this component</label>
      </div>
      {error && <p className="error small">{error}</p>}
      <h4>Log entries (INFO and up{!all && event.componentId ? <>, naming <span className="mono">{event.componentId}</span></> : ""})</h4>
      {!logs ? <p className="muted small">Searching the logs…</p> : !logs.entries.length ? <p className="muted small">None. {logs.members.filter((m) => m.state === "failed").map((m) => `${m.label}: ${m.error}`).join(" ")}</p> :
        <table className="log-results"><tbody>{logs.entries.map((e, i) => (
          <tr key={i}><td className="mono small nowrap">{when(e.at)}</td><td className="mono small nowrap">{e.label}</td><td><span className={`badge ${e.level === "ERROR" ? "bad" : e.level === "WARN" ? "warn" : "muted"}`}>{e.level}</span></td><td className="small mono">{e.text.split("\n")[0]}</td></tr>
        ))}</tbody></table>}
      <h4>Bulletins{!all && event.componentName ? <> from {event.componentName}</> : ""}</h4>
      {!bulletins ? <p className="muted small">Loading…</p> : !mine.length ? <p className="muted small">None (the collector keeps bulletins 2 days).</p> :
        <table><tbody>{mine.map((b) => (
          <tr key={`${b.node}:${b.id}:${b.at}`}><td className="muted small nowrap">{when(b.at)}</td><td><span className={`badge ${b.level === "ERROR" ? "bad" : b.level === "WARNING" ? "warn" : "muted"}`}>{b.level ?? "?"}</span></td><td className="mono small">{b.node}</td><td className="small">{b.source}</td><td className="small">{b.message}</td></tr>
        ))}</tbody></table>}
    </div>
  );
}

function Detail({ s, event, onClose }: { s: ServiceStatus; event: ProvEvent; onClose: () => void }) {
  const [full, setFull] = useState<ProvEvent | undefined>();
  const [error, setError] = useState("");
  useEffect(() => { setFull(undefined); setError(""); api.provenanceEvent(s.id, event.eventId, event.clusterNodeId).then((r) => setFull(r.event), (e: Error) => setError(e.message)); }, [s.id, event.eventId, event.clusterNodeId]);
  return (
    <section className="card">
      <div className="row"><h3>Event #{event.eventId}{event.clusterNodeId ? <span className="muted small mono"> on {event.clusterNodeId}</span> : null}</h3><button className="link" onClick={onClose}>close</button></div>
      {error && <p className="error">{error}</p>}
      {!full && !error && <p className="muted">Loading…</p>}
      {full && <>
        <table><tbody>
          {([["Type", full.eventType], ["Time", full.at ? `${when(full.at)} (${full.eventTime} on NiFi)` : full.eventTime], ["Component", `${full.componentName ?? "—"} (${full.componentType ?? "?"}) ${full.componentId ?? ""}`], ["Process group", full.groupId],
            ["Relationship", full.relationship], ["Details", full.details], ["FlowFile", full.flowFileUuid], ["Size", full.fileSizeBytes !== undefined ? fmtBytes(full.fileSizeBytes) : undefined],
            ["Duration", full.eventDuration !== undefined ? `${full.eventDuration} ms (${full.lineageDuration ?? "?"} ms since the lineage started)` : undefined], ["Transit URI", full.transitUri],
            ["Parents", full.parentUuids?.join(", ")], ["Children", full.childUuids?.join(", ")]] as [string, string | undefined][]).filter(([, v]) => v).map(([k, v]) => (
            <tr key={k}><th className="small">{k}</th><td className="small mono">{v}</td></tr>
          ))}
        </tbody></table>
        {full.attributesHidden ? <p className="muted small">NiFi does not show this event's attributes to the monitoring identity (it may not view the data of this component). Content is never read here.</p>
          : full.attributes && <>
            <h4>Attributes</h4>
            <table><thead><tr><th>Name</th><th>Value</th><th>Before</th></tr></thead><tbody>{full.attributes.map((a) => (
              <tr key={a.name}><td className="mono small">{a.name}</td><td className="mono small">{a.value ?? <span className="muted">—</span>}</td><td className={`mono small ${a.previousValue !== a.value ? "" : "muted"}`}>{a.previousValue ?? "—"}</td></tr>
            ))}</tbody></table>
          </>}
      </>}
    </section>
  );
}

// A FlowFile's lineage: the events in time order with their component; an event's parents and children can be added.
function Lineage({ s, uuid, node, onClose, onDetail }: { s: ServiceStatus; uuid: string; node: string | undefined; onClose: () => void; onDetail: (n: LineageNode) => void }) {
  const [nodes, setNodes] = useState<LineageNode[]>([]);
  const [links, setLinks] = useState<LineageResult["links"]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const merge = (r: LineageResult) => {
    setNodes((was) => { const by = new Map(was.map((n) => [`${n.type}:${n.id}`, n])); for (const n of r.nodes) by.set(`${n.type}:${n.id}`, { ...by.get(`${n.type}:${n.id}`), ...n }); return [...by.values()]; });
    setLinks((was) => { const seen = new Set(was.map((l) => `${l.sourceId}>${l.targetId}`)); return [...was, ...r.links.filter((l) => !seen.has(`${l.sourceId}>${l.targetId}`))]; });
    setNotes((was) => [...was, ...(r.notes ?? []), ...r.errors]);
  };
  const load = (q: { uuid?: string; eventId?: number; direction?: string }) => {
    setBusy(true); setError("");
    api.lineage(s.id, { ...q, ...(node ? { node } : {}) }).then(merge, (e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  useEffect(() => { setNodes([]); setLinks([]); setNotes([]); load({ uuid }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [s.id, uuid, node]);
  const events = nodes.filter((n) => n.type === "EVENT").sort((a, b) => (a.at ?? "") < (b.at ?? "") ? -1 : (a.at ?? "") > (b.at ?? "") ? 1 : Number(a.id) - Number(b.id));
  const flowfiles = nodes.filter((n) => n.type === "FLOWFILE");
  const parentsOf = (n: LineageNode) => links.filter((l) => l.targetId === n.id).map((l) => l.sourceId);
  return (
    <section className="card">
      <div className="row"><h3>Lineage of <span className="mono">{uuid}</span>{node ? <span className="muted small mono"> on {node}</span> : null}</h3><button className="link" onClick={onClose}>close</button></div>
      <p className="muted small">Every event of this FlowFile and of the FlowFiles it came from or became, in time order, as NiFi's lineage query gives them ({flowfiles.length} FlowFile{flowfiles.length === 1 ? "" : "s"}, {events.length} event{events.length === 1 ? "" : "s"}, {links.length} link{links.length === 1 ? "" : "s"}). On a fork, join, clone or replay, "parents" and "children" add what the FlowFile came from or became.</p>
      {busy && <p className="muted small">Asking NiFi…</p>}
      {error && <p className="error">{error}</p>}
      {notes.map((n, i) => <p key={i} className="muted small">Note: {n}</p>)}
      {events.length > 0 && <ol className="lineage">{events.map((n) => (
        <li key={n.id}>
          <span className="mono small nowrap">{n.at ? when(n.at) : "—"}</span>{" "}
          <span className={`badge ${typeTone(n.eventType)}`}>{n.eventType}</span>{" "}
          <strong className="small">{n.componentName ?? "?"}</strong> <span className="muted small">{n.componentType}</span>
          {n.relationship && <span className="small"> → {n.relationship}</span>}
          <span className="muted small mono"> #{n.id} · {short(n.flowFileUuid)}</span>
          {n.flowFileUuid && n.flowFileUuid !== uuid && <span className="badge info small">other FlowFile</span>}
          {(n.parentUuids?.length ?? 0) > 0 && <span className="muted small"> from {n.parentUuids!.map(short).join(", ")}</span>}
          {(n.childUuids?.length ?? 0) > 0 && <span className="muted small"> into {n.childUuids!.map(short).join(", ")}</span>}
          {n.error && <span className="error small"> {n.error}</span>}
          {" "}<button className="link small" onClick={() => onDetail(n)}>details</button>
          {EXPANDS.includes(n.eventType ?? "") && <>
            {" · "}<button className="link small" disabled={busy} onClick={() => load({ eventId: Number(n.id), direction: "PARENTS" })}>parents</button>
            {" · "}<button className="link small" disabled={busy} onClick={() => load({ eventId: Number(n.id), direction: "CHILDREN" })}>children</button>
          </>}
          {parentsOf(n).length > 0 && <span className="muted small"> (after {parentsOf(n).join(", ")})</span>}
        </li>
      ))}</ol>}
      {!busy && !error && events.length === 0 && <p className="muted">No events: NiFi has none of this FlowFile any more (the provenance repository keeps a limited time and size).</p>}
    </section>
  );
}
