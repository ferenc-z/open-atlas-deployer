// Screen 3 (prototype Register.dc.html, S39; replaces the old "confirm the flows" page): register a business. On the left the
// person pastes the links of the process groups the business uses; the server reads them (register preview) and the right side
// shows how they connect: the groups in order from upstream to downstream, a line between them that says how they connect
// (canvas, S2S, MQ, schedule, a shared module, or a handoff the person described, purple dashed with their own words), and what
// cannot be connected. A gap is answered on the left (where its data comes from, in the person's words) and the preview is
// read again with that answer. Register needs every gap closed and a name. Nothing is written until then (register commit).
// The thread on the left is Deployer's own text built from the server's answer; the AI itself is the Ask AI drawer.
// Fixed text is English; the sentences about the groups come from the server.

import { useEffect, useMemo, useRef, useState } from "react";
import { biz } from "./biz-data.ts";
import { ApiError } from "./api.ts";
import { canRegister, chainOf, edgeLook, edgeText, groupProblems, handoffOf, isIncoming, parseLinks, summaryOf, type GapAnswer } from "./biz-view.ts";
import type { CommitResult, HandoffInput, LinkInput, Preview, PreviewGap, PreviewSegment } from "./biz-types.ts";
import { businessesHref, flowHref, openAskAi } from "./flow-routes.ts";
import { usePageFocus } from "./focus.ts";
import "./ops.css";

type Message = { who: "you" | "deployer"; text: string };

const linkText = (l: LinkInput) => (typeof l === "string" ? l : `${l.link} service=${l.service ?? ""}`);
const reasonOf = (e: unknown): string => {
  const x = e as ApiError;
  return x.details?.length ? `${x.message} ${x.details.join(" ")}` : x.message;
};

export function RegisterPage() {
  usePageFocus("page", "register");
  const [links, setLinks] = useState<LinkInput[]>([]);
  const [handoffs, setHandoffs] = useState<{ key: string; handoff: HandoffInput }[]>([]);
  const [text, setText] = useState("");
  const [thread, setThread] = useState<Message[]>([{ who: "deployer", text: "Paste the links of the process groups your business uses, one per line. Groups on different machines can go together. I read them and string them together; what I cannot connect, I ask you." }]);
  const [preview, setPreview] = useState<Preview | undefined>();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<CommitResult | undefined>();
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView?.({ block: "nearest" }); }, [thread.length]);

  /** Reads the groups again with what the person has said so far; `said` is the new text for the thread. */
  const read = async (nextLinks: LinkInput[], nextHandoffs: typeof handoffs, said: Message[]): Promise<void> => {
    setBusy(true); setError("");
    try {
      const p = await biz.preview({ links: nextLinks, ...(name.trim() ? { name: name.trim() } : {}), ...(nextHandoffs.length ? { handoffs: nextHandoffs.map((h) => h.handoff) } : {}) });
      setLinks(nextLinks); setHandoffs(nextHandoffs); setPreview(p);
      if (!name.trim() && p.name) setName(p.name);
      setThread((t) => [...t, ...said, { who: "deployer", text: describe(p) }]);
    } catch (e) {
      setError(reasonOf(e));
    } finally { setBusy(false); }
  };

  const send = async () => {
    const fresh = parseLinks(text, links);
    if (fresh.length === 0) return setError(text.trim() ? "Those links are already in." : "Paste at least one link.");
    await read([...links, ...fresh], handoffs, [{ who: "you", text: fresh.map(linkText).join("\n") }]);
    setText("");
  };
  const answer = async (gap: PreviewGap, a: GapAnswer) => {
    if (!preview) return;
    const handoff = handoffOf(preview, gap, a);
    if (!handoff) return setError(isIncoming(gap.kind) ? "Choose where it comes from, which part sends it, and say it in your words." : "Say which part sends it, where it goes, and say it in your words.");
    await read(links, [...handoffs, { key: `${gap.id}:${handoffs.length}`, handoff }], [{ who: "you", text: a.quote.trim() }]);
  };
  const addNeighbor = async (gap: PreviewGap) => {
    const link = gap.neighbor?.link;
    if (!link) return;
    const fresh = parseLinks(link, links);
    if (fresh.length === 0) return;
    await read([...links, ...fresh], handoffs, [{ who: "you", text: `Add ${gap.neighbor?.group.name ?? "that group"} too.` }]);
  };
  const register = async () => {
    if (!preview || !canRegister(preview, name)) return;
    setBusy(true); setError("");
    try {
      const r = await biz.commit({ name: name.trim(), links, ...(handoffs.length ? { handoffs: handoffs.map((h) => h.handoff) } : {}) });
      setDone(r);
      setThread((t) => [...t, { who: "deployer", text: `Registered “${r.name}”. It is being watched now.` }]);
    } catch (e) {
      setError(reasonOf(e));
      if (e instanceof ApiError && e.code === "register/gaps-open") void read(links, handoffs, []);
    } finally { setBusy(false); }
  };
  const startOver = () => { setLinks([]); setHandoffs([]); setText(""); setPreview(undefined); setName(""); setError(""); setDone(undefined); setThread((t) => t.slice(0, 1)); };

  const chain = useMemo(() => (preview ? chainOf(preview) : []), [preview]);
  const problems = preview ? groupProblems(preview) : [];
  const gapSegments = new Set(preview?.gaps.map((g) => g.segment));
  const canSend = !done && !busy;
  return (
    <div className="fl ops ops-wide">
      <a href={businessesHref()}>← All businesses</a>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <h1 style={{ fontSize: 28 }}>Register a business</h1>
        <p className="fl-lead">Give the links of the process groups your business uses; they can be on different machines. Deployer strings them together by the canvas connections, S2S, the schedule definitions and the registered shared modules, and asks you about what it cannot connect. Registering starts the monitoring; nobody has to approve it.</p>
      </div>

      <div className="rg-cols">
        <section aria-label="Registering" className="rg-chat">
          <div className="rg-chat-head">
            <span style={{ fontSize: 16, fontWeight: 700 }}>Register</span>
            <span className="fl-muted">A new business · <button type="button" className="fl-linkbtn" title="Opens Ask AI" onClick={openAskAi}>Ask AI for help</button></span>
          </div>
          <div className="rg-thread" aria-live="polite">
            {thread.map((m, i) => <div key={i} className={`rg-msg ${m.who}`}>{m.text}</div>)}
            <div ref={end} />
          </div>
          {preview && !done && preview.gaps.length > 0 && (
            <div className="rg-asks">
              {preview.gaps.map((g) => <GapForm key={`${g.id}:${handoffs.length}:${links.length}`} gap={g} preview={preview} busy={busy} onAnswer={(a) => void answer(g, a)} onAdd={() => void addNeighbor(g)} />)}
            </div>
          )}
          <div className="rg-input">
            <label htmlFor="rg-say" className="fl-muted">{preview ? "Paste more links to add groups" : "Paste links, one per line"}</label>
            <textarea id="rg-say" className="fl-input" rows={4} value={text} disabled={!canSend} onChange={(e) => setText(e.target.value)} placeholder={"https://nifi-a1.corp:8443/nifi/#/process-groups/…\nhttps://nifi-b2.corp:8443/nifi/?processGroupId=…"} />
            <div className="fl-row">
              <button type="button" className="fl-btn primary" style={{ background: "#1F4FB8", borderColor: "#1F4FB8" }} disabled={!canSend || !text.trim()} onClick={() => void send()}>{busy ? "Reading…" : "Send"}</button>
              <button type="button" className="fl-linkbtn" onClick={startOver}>Start over</button>
            </div>
            <span className="fl-muted">If Deployer cannot place an address, add <code>service=&lt;service id&gt;</code> after that link.</span>
          </div>
        </section>

        <section aria-label="How the groups connect" className="rg-graph">
          <div className="fl-head">
            <h2 style={{ fontSize: 18 }}>How the groups connect</h2>
            <span className="fl-muted">{preview ? summaryOf(preview) : ""}</span>
          </div>
          {error && <p className="fl-error" style={{ margin: 0 }}>{error}</p>}
          {!preview && <div className="bz-empty" style={{ textAlign: "center" }}>After you send the links, how they connect shows here.</div>}
          {preview && (
            <>
              {problems.length > 0 && <div className="rg-problem"><b>Cannot use ({problems.length})</b>{problems.map((p) => <span key={p}>{p}</span>)}</div>}
              <div className="rg-chain">
                {chain.map((layer, i) => (
                  <div key={i} className="rg-layer">
                    {layer.arriving.map(({ edge, from, to }, n) => {
                      const look = edgeLook(edge.kind);
                      return <div key={n} className="rg-edge" style={{ borderLeft: `2px ${look.dashed ? "dashed" : "solid"} ${look.color}`, color: look.color }}>↓ {from.group.name} → {to.group.name} · {edgeText(edge)}</div>;
                    })}
                    <div className="rg-segs">{layer.segments.map((s) => <SegmentCard key={s.id} s={s} stuck={gapSegments.has(s.id)} />)}</div>
                  </div>
                ))}
                {chain.length === 0 && <p className="fl-muted" style={{ margin: 0 }}>None of the links gave a usable group yet.</p>}
              </div>

              {preview.gaps.length > 0 && (
                <div className="rg-gap-box">
                  <b>Can't connect ({preview.gaps.length})</b>
                  {preview.gaps.map((g) => <span key={g.id}>{g.text}</span>)}
                </div>
              )}

              <div className="rg-outside">
                <b>Checked one step outside your groups</b>
                {(preview.notes ?? []).map((n, i) => <span key={i}>{n}</span>)}
                {!preview.gaps.some((g) => g.kind === "exit-unregistered" || g.kind === "entry-unregistered") && <span>No exit leads to a group that is not registered.</span>}
              </div>

              {(preview.entries.length > 0 || preview.exits.length > 0) && (
                <div className="fl-facts">
                  <div><span className="k">Entrance</span><span>{preview.entries.length ? preview.entries.map((e) => e.label).join("、") : "—"}</span></div>
                  <div><span className="k">Exits</span><span>{preview.exits.length ? preview.exits.map((e) => e.label).join("、") : "—"}</span></div>
                </div>
              )}

              <span className="fl-muted" style={{ fontSize: 12 }}>Gray line = seen on the canvas or in the schedule definitions · blue = S2S · green = a shared module · purple dashed = a handoff you described</span>

              {!done && (
                <div className="rg-commit">
                  <div className="fl-row">
                    <label htmlFor="rg-name">Name</label>
                    <input id="rg-name" className="fl-input" style={{ flex: "1 1 200px" }} value={name} onChange={(e) => setName(e.target.value)} />
                  </div>
                  <div className="fl-row" style={{ gap: 10 }}>
                    <button type="button" className="fl-btn primary" disabled={busy || !canRegister(preview, name)} onClick={() => void register()}>Register</button>
                    <span className="fl-muted">{preview.gaps.length > 0 ? `Answer the ${preview.gaps.length === 1 ? "question" : "questions"} on the left first.` : problems.length > 0 ? "Fix the groups that cannot be used first." : !name.trim() ? "Give it a name." : "You can add or remove groups later, from the business page or by telling the AI."}</span>
                  </div>
                </div>
              )}
              {done && (
                <div className="rg-done">
                  <b>Registered.</b>
                  <span>{done.name} is being watched now, on {[...new Set(done.preview.segments.map((s) => s.service))].join(" and ") || "its services"}.</span>
                  <a href={flowHref(done.flow)} style={{ fontWeight: 600 }}>Open the business →</a>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

/** What Deployer says after reading: how many groups, what connected, what it needs from the person. */
function describe(p: Preview): string {
  const lines = [summaryOf(p) + "."];
  const bad = groupProblems(p);
  if (bad.length) lines.push(`Cannot use: ${bad.join("; ")}.`);
  if (p.gaps.length) lines.push(`${p.gaps.length === 1 ? "One place" : `${p.gaps.length} places`} I cannot connect. Answer ${p.gaps.length === 1 ? "it" : "them"} below, or register the group next to it.`);
  else if (bad.length === 0) lines.push("Every group is connected. Give it a name and register.");
  return lines.join("\n");
}

function SegmentCard({ s, stuck }: { s: PreviewSegment; stuck: boolean }) {
  const role = s.role === "shared" ? `Shared module · registered once${s.steps?.length ? ` · ${s.steps.join(" → ")}` : ""}` : s.steps?.length ? s.steps.join(" → ") : "";
  return (
    <div className={`rg-seg${s.role === "shared" ? " shared" : ""}${stuck ? " stuck" : ""}`}>
      <span className="where">{s.service}</span>
      <span className="name">{s.group.name}</span>
      <span className="role">{stuck ? "Can't connect: where does its data come from?" : role}</span>
    </div>
  );
}

/** One question, in the person's words: where its data comes from (or goes), then Connect. For a group that leads to an unregistered neighbour there is also "register that group". */
function GapForm({ gap, preview, busy, onAnswer, onAdd }: { gap: PreviewGap; preview: Preview; busy: boolean; onAnswer: (a: GapAnswer) => void; onAdd: () => void }) {
  const incoming = isIncoming(gap.kind);
  const sources = preview.segments.filter((s) => s.id !== gap.segment);
  const [a, setA] = useState<GapAnswer>({ from: sources[0]?.id ?? "", component: gap.candidates?.length === 1 ? gap.candidates[0]!.component : "", quote: "", system: "" });
  const set = (patch: Partial<GapAnswer>) => setA({ ...a, ...patch });
  const id = `gap-${gap.id}`;
  const mine = preview.segments.find((s) => s.id === gap.segment);
  return (
    <div className="rg-ask">
      <b>{mine ? `${mine.service} · ${mine.group.name}` : "A group"}</b>
      <span>{gap.text}</span>
      {incoming && sources.length > 0 && (
        <div className="fl-row">
          <label htmlFor={`${id}-from`}>Its data comes from</label>
          <select id={`${id}-from`} className="fl-input" value={a.from} onChange={(e) => set({ from: e.target.value })}>
            {sources.map((s) => <option key={s.id} value={s.id}>{s.service} · {s.group.name}</option>)}
          </select>
        </div>
      )}
      <div className="fl-row">
        <label htmlFor={`${id}-comp`}>{incoming ? "Sent by" : "Leaves from"}</label>
        {gap.candidates && gap.candidates.length > 0
          ? <select id={`${id}-comp`} className="fl-input" value={a.component} onChange={(e) => set({ component: e.target.value })}><option value="">Choose a processor</option>{gap.candidates.map((c) => <option key={c.component} value={c.component}>{c.name}</option>)}</select>
          : <input id={`${id}-comp`} className="fl-input" value={a.component} placeholder="Processor name or id" onChange={(e) => set({ component: e.target.value })} />}
      </div>
      {!incoming && (
        <div className="fl-row">
          <label htmlFor={`${id}-sys`}>It goes to (outside NiFi)</label>
          <input id={`${id}-sys`} className="fl-input" value={a.system} placeholder="e.g. the customer's SFTP" onChange={(e) => set({ system: e.target.value })} />
        </div>
      )}
      <label htmlFor={`${id}-q`} className="fl-muted">In your words</label>
      <textarea id={`${id}-q`} className="fl-input" rows={2} value={a.quote} placeholder="比如：Customs_Save 调 Java service 入库后，PDF 写到共享目录 /data/customs/out" onChange={(e) => set({ quote: e.target.value })} />
      <div className="fl-row" style={{ gap: 10 }}>
        <button type="button" className="fl-btn small primary" disabled={busy} onClick={() => onAnswer(a)}>Connect</button>
        {gap.neighbor?.link && <button type="button" className="fl-btn small" disabled={busy} onClick={onAdd}>Register {gap.neighbor.group.name} too</button>}
      </div>
    </div>
  );
}
