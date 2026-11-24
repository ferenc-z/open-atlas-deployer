// Screen 3 (prototype Register.dc.html, S39; replaces the old "confirm the flows" page): register a business. The page makes a
// registration draft when it opens (business-registration.md 7.9). On the left the Deploy Assistant is embedded and always
// there (the same chat as the Ask AI drawer; its page context carries the draft id): the person gives it the links, it adds
// the groups to the draft, asks about what it cannot connect and writes the answers down as handoffs. On the right the page
// reads the draft every 2 seconds and draws how the groups connect from the draft's preview. Register is the person's click
// (the assistant never commits). When the assistant cannot be reached, the left column says so and keeps the first version's
// question cards, which work on the draft directly, so a business can be registered without the AI.
// Fixed text is English; the sentences about the groups come from the server and the AI.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { biz } from "./biz-data.ts";
import { ApiError } from "./api.ts";
import { AssistantFrame, pageContext, TryAsking, type HostActions } from "./Assistant.tsx";
import { AiMissing } from "./Setup.tsx";
import { canRegister, chainOf, edgeLook, edgeText, groupProblems, handoffOf, isIncoming, parseLinks, previewStale, refusalOf, summaryOf, type GapAnswer } from "./biz-view.ts";
import type { CommitResult, Preview, PreviewGap, PreviewSegment, RegDraft } from "./biz-types.ts";
import { SUGGESTIONS } from "./ask-ai.ts";
import { copyText } from "./clipboard.ts";
import { businessesHref, flowHref } from "./flow-routes.ts";
import "./ops.css";

const STORE_KEY = "deployer.register.draft";
const reasonOf = (e: unknown): string => {
  const x = e as ApiError;
  return x.details?.length ? `${x.message} ${x.details.join(" ")}` : x.message;
};
const remembered = (): string | null => { try { return sessionStorage.getItem(STORE_KEY); } catch { return null; } };
const remember = (id: string | null) => { try { if (id) sessionStorage.setItem(STORE_KEY, id); else sessionStorage.removeItem(STORE_KEY); } catch { /* a convenience only */ } };

/** Who the page re-reads the picture for: the groups, the told hand-overs and the placed workers a preview was not made from. */
const sigOf = (d: RegDraft) => [d.groups.map((g) => g.group.id).sort().join(","), d.handoffs.map((h) => h.id).sort().join(","), d.places.map((p) => `${p.schedule}/${p.worker}`).sort().join(",")].join("|");

export function RegisterPage({ workbenchUrl, environment, actions, canAsk }: { workbenchUrl: string; environment?: string; actions: HostActions; canAsk: boolean }) {
  const [draft, setDraft] = useState<RegDraft | undefined>();
  const [name, setName] = useState("");
  const typed = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The poll's own trouble (the draft expired, the server is away): kept apart so a good read does not wipe an action's error.
  const [pollError, setPollError] = useState("");
  const [refusal, setRefusal] = useState<ReturnType<typeof refusalOf> | undefined>();
  const [done, setDone] = useState<CommitResult | undefined>();
  const [frame, setFrame] = useState<"loading" | "ready" | "slow">("loading");
  const started = useRef(false);
  const lastSig = useRef("");
  const id = draft?.draft;

  const adopt = useCallback((d: RegDraft) => {
    setDraft((was) => (was && was.draft === d.draft && was.updatedAt === d.updatedAt && JSON.stringify(was.preview) === JSON.stringify(d.preview) ? was : d));
    if (!typed.current && d.name) setName(d.name);
  }, []);
  const begin = useCallback(async () => {
    setError("");
    try { const d = await biz.createDraft(); remember(d.draft); lastSig.current = ""; typed.current = false; setName(""); setDraft(d); } catch (e) { setError(reasonOf(e)); }
  }, []);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const old = remembered();
    (old ? biz.draft(old).then((d) => (d.flow ? undefined : d), () => undefined) : Promise.resolve(undefined)).then((d) => { if (d) { setDraft(d); if (d.name) setName(d.name); } else void begin(); });
  }, [begin]);

  // The right side follows the draft: every 2 seconds, and at once after something the page itself did.
  const refresh = useCallback(async () => {
    if (!id) return;
    try { adopt(await biz.draft(id)); setPollError(""); } catch (e) { setPollError(e instanceof ApiError && e.status === 404 ? "This draft is gone (drafts are kept for a day). Start over." : reasonOf(e)); }
  }, [id, adopt]);
  useEffect(() => {
    if (!id || done) return;
    const t = setInterval(() => void refresh(), 2000);
    return () => clearInterval(t);
  }, [id, done, refresh]);
  // The picture is made from the groups and hand-overs the draft has now: when the assistant changed them and has not read
  // them again, the page asks for a read itself (once per change), so the right side never shows an older chain.
  useEffect(() => {
    if (!draft || done || busy || draft.groups.length === 0) return;
    const sig = sigOf(draft);
    if (sig === lastSig.current) return;
    const first = lastSig.current === "";
    lastSig.current = sig;
    if (first && draft.preview && !previewStale(draft)) return;
    setError("");
    void biz.preview(draft.draft).then(refresh, (e) => setError(reasonOf(e)));
  }, [draft, done, busy, refresh]);

  const preview = draft?.preview ?? undefined;
  const register = async () => {
    if (!draft || !preview || !canRegister(preview, name)) return;
    setBusy(true); setError(""); setRefusal(undefined);
    try {
      const r = await biz.commit(draft.draft, name.trim());
      remember(null);
      setDone(r);
    } catch (e) {
      const x = e as ApiError;
      setRefusal(refusalOf({ ...(x.code ? { code: x.code } : {}), message: reasonOf(e), body: x.body }));
      void refresh();
    } finally { setBusy(false); }
  };
  const startOver = async () => {
    const old = draft?.draft;
    setDone(undefined); setRefusal(undefined); setDraft(undefined);
    if (old) await biz.discardDraft(old).catch(() => undefined);
    await begin();
  };

  const chain = useMemo(() => (preview ? chainOf(preview) : []), [preview]);
  const problems = preview ? groupProblems(preview) : [];
  const gapSegments = new Set(preview?.gaps.map((g) => g.segment));
  const stale = draft ? previewStale(draft) : false;
  const showFallback = !canAsk || frame === "slow";
  return (
    <div className="fl ops ops-wide">
      <a href={businessesHref()}>← All businesses</a>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <h1 style={{ fontSize: 28 }}>Register a business</h1>
        <p className="fl-lead">Give the assistant the links of the process groups your business uses; they can be on different machines. It strings them together by the canvas connections, S2S, the schedule definitions and the registered shared modules, and asks you about what it cannot connect. Registering starts the monitoring; nobody has to approve it.</p>
      </div>

      <div className="rg-cols">
        <section aria-label="Registering" className="rg-chat">
          <div className="rg-chat-head">
            <span style={{ fontSize: 16, fontWeight: 700 }}>Register</span>
            <span className="fl-muted">A new business · talk to the assistant here; the picture on the right follows what you agree</span>
          </div>
          <AiMissing use="assistant" what="The Deploy Assistant" />
          {canAsk && <TryAsking items={SUGGESTIONS.register ?? []} />}
          {canAsk && id && (
            <div className="rg-frame">
              <AssistantFrame workbenchUrl={workbenchUrl} {...(environment ? { environment } : {})} context={pageContext(environment, "register", { draft: id })} actions={actions} onState={setFrame} />
            </div>
          )}
          {!canAsk && <div className="assistant-hint"><p>The assistant is there when you sign in through Workbench. You can still register a business with the questions below.</p></div>}
          {showFallback && id && !done && <Fallback draft={draft!} busy={busy} setBusy={setBusy} setError={setError} refresh={refresh} />}
        </section>

        <section aria-label="How the groups connect" className="rg-graph">
          <div className="fl-head">
            <h2 style={{ fontSize: 18 }}>How the groups connect</h2>
            <span className="fl-muted">{preview ? summaryOf(preview) : draft?.groups.length ? `${draft.groups.length} ${draft.groups.length === 1 ? "group" : "groups"} added` : ""}</span>
            <button type="button" className="fl-linkbtn" style={{ marginLeft: "auto" }} onClick={() => void startOver()}>Start over</button>
          </div>
          {(error || pollError) && <p className="fl-error" style={{ margin: 0 }}>{error || pollError}</p>}
          {!draft && !error && <div className="bz-empty" style={{ textAlign: "center" }}>Opening a draft…</div>}
          {draft && !preview && (
            <div className="bz-empty" style={{ textAlign: "center" }}>
              {draft.groups.length === 0 ? "After you give the assistant the links, how they connect shows here." : "The groups are added. Reading how they connect…"}
              {draft.groups.length > 0 && <div style={{ marginTop: 8, textAlign: "left" }}>{draft.groups.map((g) => <div key={`${g.service}:${g.group.id}`}>{g.service} · {g.group.name}</div>)}</div>}
            </div>
          )}
          {preview && (
            <>
              {stale && <p className="fl-muted" style={{ margin: 0 }}>The groups changed after this picture was made; it is being read again.</p>}
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
            </>
          )}

          {draft && !done && (
            <div className="rg-commit">
              <div className="fl-row">
                <label htmlFor="rg-name">Name</label>
                <input id="rg-name" className="fl-input" style={{ flex: "1 1 200px" }} value={name} onChange={(e) => { typed.current = true; setName(e.target.value); }} />
              </div>
              <div className="fl-row" style={{ gap: 10 }}>
                <button type="button" className="fl-btn primary" disabled={busy || stale || !canRegister(preview, name)} onClick={() => void register()}>Register</button>
                <span className="fl-muted">{!preview ? "Register is available once the groups are connected." : preview.gaps.length > 0 ? `Settle the ${preview.gaps.length === 1 ? "question" : "questions"} with the assistant first.` : problems.length > 0 ? "Fix the groups that cannot be used first." : !name.trim() ? "Give it a name (the assistant can suggest one)." : "You can add or remove groups later, from the business page or by telling the assistant."}</span>
              </div>
              {refusal && <Refusal r={refusal} />}
            </div>
          )}
          {done && (
            <div className="rg-done">
              <b>Registered.</b>
              <span>{done.name} is being watched now, on {[...new Set(done.preview.segments.map((s) => s.service))].join(" and ") || "its services"}.</span>
              <a href={flowHref(done.flow)} style={{ fontWeight: 600 }}>Open the business →</a>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/** A refused Register: why, in the server's words, and a button that copies one sentence to paste to the assistant (its box cannot be pre-filled). */
export function Refusal({ r }: { r: { message: string; lines: string[]; tell: string } }) {
  const [copied, setCopied] = useState<boolean | undefined>();
  const manual = useRef<HTMLInputElement>(null);
  useEffect(() => { if (copied === false) manual.current?.select(); }, [copied]);
  return (
    <div className="rg-problem" role="alert">
      <b>Not registered</b>
      <span>{r.message}</span>
      {r.lines.length > 0 && <ul style={{ margin: 0, paddingLeft: 18 }}>{r.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>}
      <div className="fl-row" style={{ gap: 10 }}>
        <button type="button" className="fl-btn small" title="Copies one sentence: paste it into the assistant's box" onClick={() => void copyText(r.tell).then(setCopied)}>Tell the AI</button>
        {copied && <span className="fl-muted" role="status">Copied. Paste it into the assistant's box (Ctrl+V).</span>}
      </div>
      {copied === false && <div role="alert"><span className="fl-muted">This browser did not allow copying. The sentence is selected below: press Ctrl+C, then paste it into the assistant's box.</span><input ref={manual} readOnly className="fl-input" value={r.tell} onFocus={(e) => e.currentTarget.select()} aria-label="Sentence to copy" /></div>}
    </div>
  );
}

function SegmentCard({ s, stuck }: { s: PreviewSegment; stuck: boolean }) {
  const role = s.role === "shared" ? `Shared module · registered once${s.steps?.length ? ` · ${s.steps.join(" → ")}` : ""}` : s.steps?.length ? s.steps.join(" → ") : "";
  return (
    <div className={`rg-seg${s.role === "shared" ? " shared" : ""}${stuck ? " stuck" : ""}`}>
      <span className="where">{s.service}</span>
      <span className="name">{s.group.name}</span>
      <span className="role">{stuck ? "Can't connect: ask the assistant" : role}</span>
    </div>
  );
}

// ---- The fallback: the first version's question cards, on the draft, for when the assistant cannot be reached ----

function Fallback({ draft, busy, setBusy, setError, refresh }: { draft: RegDraft; busy: boolean; setBusy: (b: boolean) => void; setError: (e: string) => void; refresh: () => Promise<void> }) {
  const [text, setText] = useState("");
  const preview = draft.preview ?? undefined;
  /** One change to the draft; the page then reads how it connects (the effect above) and the right side follows. */
  const change = async (work: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true); setError("");
    try { await work(); await refresh(); return true; } catch (e) { setError(reasonOf(e)); return false; } finally { setBusy(false); }
  };
  const send = async () => {
    const fresh = parseLinks(text, draft.groups.flatMap((g) => (g.link ? [g.link] : [])));
    if (fresh.length === 0) return setError(text.trim() ? "Those links are already in." : "Paste at least one link.");
    if (await change(() => biz.addLinks(draft.draft, fresh))) setText("");
  };
  return (
    <div className="rg-fallback">
      <div className="rg-input">
        <b>Without the assistant</b>
        <label htmlFor="rg-say" className="fl-muted">Paste links, one per line</label>
        <textarea id="rg-say" className="fl-input" rows={4} value={text} disabled={busy} onChange={(e) => setText(e.target.value)} placeholder={"https://nifi-a1.corp:8443/nifi/#/process-groups/…\nhttps://nifi-b2.corp:8443/nifi/?processGroupId=…"} />
        <div className="fl-row">
          <button type="button" className="fl-btn primary" style={{ background: "#1F4FB8", borderColor: "#1F4FB8" }} disabled={busy || !text.trim()} onClick={() => void send()}>{busy ? "Reading…" : "Add"}</button>
          <span className="fl-muted">If Deployer cannot place an address, add <code>service=&lt;service id&gt;</code> after that link.</span>
        </div>
      </div>
      {preview && preview.gaps.length > 0 && (
        <div className="rg-asks">
          {preview.gaps.map((g) => <GapForm key={`${g.id}:${draft.handoffs.length}:${draft.groups.length}:${draft.places.length}`} gap={g} preview={preview} busy={busy}
            onHandoff={(a) => { const h = handoffOf(preview, g, a); if (!h) return setError(isIncoming(g.kind) ? "Choose where it comes from, which part sends it, and say it in your words." : "Say which part sends it, where it goes, and say it in your words."); void change(() => biz.declareHandoff(draft.draft, h)); }}
            onPlace={(p) => void change(() => biz.placeWorker(draft.draft, p))}
            onAdd={() => { const link = g.neighbor?.link; if (link) void change(() => biz.addLinks(draft.draft, [link])); }} />)}
        </div>
      )}
    </div>
  );
}

/** One question, in the person's words. A gap about where data goes in or out: where it comes from (or goes), then Connect;
 *  a worker nobody placed: which group it runs in. For a group that leads to an unregistered neighbour there is also "register that group". */
function GapForm({ gap, preview, busy, onHandoff, onPlace, onAdd }: { gap: PreviewGap; preview: Preview; busy: boolean; onHandoff: (a: GapAnswer) => void; onPlace: (p: { schedule: string; worker: string; quote: string; group?: { service: string; group: string }; outside?: boolean }) => void; onAdd: () => void }) {
  const incoming = isIncoming(gap.kind);
  const sources = preview.segments.filter((s) => s.id !== gap.segment);
  const [a, setA] = useState<GapAnswer>({ from: sources[0]?.id ?? "", component: gap.candidates?.length === 1 ? gap.candidates[0]!.component : "", quote: "", system: "", dir: "in" });
  const [where, setWhere] = useState("");
  const set = (patch: Partial<GapAnswer>) => setA({ ...a, ...patch });
  const id = `gap-${gap.id}`;
  const mine = preview.segments.find((s) => s.id === gap.segment);
  const head = <><b>{mine ? `${mine.service} · ${mine.group.name}` : "A group"}</b><span>{gap.text}</span></>;
  if (gap.kind === "group-missing") return <div className="rg-ask">{head}</div>;
  if (gap.kind === "worker-unplaced" && gap.worker) {
    const w = gap.worker;
    const options = preview.groups.map((g) => ({ key: `${g.service}\0${g.group.id}`, service: g.service, group: g.group.id, label: `${g.service} · ${g.group.name}` }));
    const submit = () => {
      if (!a.quote.trim() || !where) return;
      const base = { schedule: w.schedule, worker: w.name, quote: a.quote.trim() };
      if (where === "outside") onPlace({ ...base, outside: true });
      else { const o = options.find((x) => x.key === where); if (o) onPlace({ ...base, group: { service: o.service, group: o.group } }); }
    };
    return (
      <div className="rg-ask">
        {head}
        <div className="fl-row">
          <label htmlFor={`${id}-where`}>{w.name} runs in</label>
          <select id={`${id}-where`} className="fl-input" value={where} onChange={(e) => setWhere(e.target.value)}>
            <option value="">Choose a group</option>
            {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
            <option value="outside">Not in NiFi</option>
          </select>
        </div>
        <label htmlFor={`${id}-q`} className="fl-muted">In your words</label>
        <textarea id={`${id}-q`} className="fl-input" rows={2} value={a.quote} onChange={(e) => set({ quote: e.target.value })} />
        <div className="fl-row"><button type="button" className="fl-btn small primary" disabled={busy || !where || !a.quote.trim()} onClick={submit}>Place it</button></div>
      </div>
    );
  }
  return (
    <div className="rg-ask">
      {head}
      {gap.kind === "disconnected" && (
        <div className="fl-row">
          <label htmlFor={`${id}-dir`}>This part</label>
          <select id={`${id}-dir`} className="fl-input" value={a.dir} onChange={(e) => set({ dir: e.target.value as "in" | "out" })}>
            <option value="in">receives data from the other group</option>
            <option value="out">sends data to the other group</option>
          </select>
        </div>
      )}
      {incoming && sources.length > 0 && (
        <div className="fl-row">
          <label htmlFor={`${id}-from`}>{a.dir === "out" ? "Its data goes to" : "Its data comes from"}</label>
          <select id={`${id}-from`} className="fl-input" value={a.from} onChange={(e) => set({ from: e.target.value })}>
            {sources.map((s) => <option key={s.id} value={s.id}>{s.service} · {s.group.name}</option>)}
          </select>
        </div>
      )}
      <div className="fl-row">
        <label htmlFor={`${id}-comp`}>{incoming && a.dir !== "out" ? "Sent by" : "Leaves from"}</label>
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
        <button type="button" className="fl-btn small primary" disabled={busy} onClick={() => onHandoff(a)}>Connect</button>
        {gap.kind !== "disconnected" && gap.neighbor?.link && gap.neighbor.group && <button type="button" className="fl-btn small" disabled={busy} onClick={onAdd}>Register {gap.neighbor.group.name} too</button>}
      </div>
    </div>
  );
}
