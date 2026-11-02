// Phase 6 pages: the Deploy Assistant beside the page (Workbench's embedded chat, design §10.2 interface A) and
// API keys (§9.4). The assistant only proposes: a card the person applies comes here as workbench-chat:action and
// runs as that person, through the same calls as the buttons; only the operations declared in Workbench's
// application entry (chat.hostOperations) are accepted, and only from Workbench's own origin.

import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import * as api from "./api.ts";
import { AiMissing } from "./Setup.tsx";
import { ask } from "./Confirm.tsx";

export const HOST_OPERATIONS = ["plan_deploy", "plan_rollback", "build_artifact", "set_env_value"] as const;

export interface HostActions {
  /** Opens the deploy panel with a plan for this version (and the deploy to go back to). */
  openPlan: (app: string, version: string, pinFrom?: string) => void;
}

type Payload = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** One card's operation, run as the signed-in person; the outcome is what the card shows. */
export async function runHostOperation(operation: string, payload: Payload, actions: HostActions): Promise<{ ok: boolean; outcome: string }> {
  const app = str(payload.app);
  if (!(HOST_OPERATIONS as readonly string[]).includes(operation)) return { ok: false, outcome: `The Deployer does not accept operation ${operation}` };
  if (!app) return { ok: false, outcome: "The card has no app" };
  try {
    switch (operation) {
      case "plan_deploy":
      case "plan_rollback": {
        const version = str(payload.version);
        if (!version) return { ok: false, outcome: "The card has no version" };
        const pinFrom = str(payload.pin_from ?? payload.pinFrom) || undefined;
        if (operation === "plan_rollback" && !pinFrom) return { ok: false, outcome: "Going back to an old version needs the deploy to go back to (pin_from)" };
        actions.openPlan(app, version, pinFrom);
        return { ok: true, outcome: `Created the plan for ${app} ${version} on the page: it runs only after it is checked and \"Confirm deploy\" is clicked` };
      }
      case "build_artifact": {
        const version = str(payload.version);
        if (!version) return { ok: false, outcome: "The card has no version" };
        const r = await api.build(app, version);
        return { ok: true, outcome: `Started building ${app} ${version} (${r.jobs.map((j) => j.id).join(", ")})` };
      }
      case "set_env_value": {
        const key = str(payload.key);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof payload.value !== "string") return { ok: false, outcome: "The key or value on the card is invalid" };
        const view = await api.env(app);
        const values: api.EnvEdit[] = view.values.filter((v) => v.key !== key).map((v) => (v.secret ? { key: v.key, keep: true } : { key: v.key, value: v.value ?? "" }));
        values.push({ key, value: payload.value });
        const r = await api.saveEnv(app, view.revision?.revision ?? null, values, str(payload.note) || `Assistant card: set ${key}`);
        return { ok: true, outcome: `Revision ${r.revision} of the ${app} environment variables is saved but not yet written to the server: review the plan on the \"Environment variables\" page and write it` };
      }
    }
  } catch (error) {
    return { ok: false, outcome: (error as Error).message };
  }
  return { ok: false, outcome: "Not handled" };
}

export function AssistantPanel({ workbenchUrl, environment, page, app, actions, onClose, onSetup }: { workbenchUrl: string; environment?: string; page: string; app?: string; actions: HostActions; onClose: () => void; onSetup?: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const base = new URL(workbenchUrl, window.location.href);
  const origin = base.origin;
  const src = new URL(`embed/chat?app=deployer&key=${encodeURIComponent(`env:${environment ?? "unknown"}`)}&title=${encodeURIComponent(`Deployer ${(environment ?? "").toUpperCase()}`)}`, base.href.endsWith("/") ? base.href : `${base.href}/`).href;
  const context = { env: environment ?? "unknown", page, ...(app ? { app } : {}) };
  const send = (message: Record<string, unknown>) => frame.current?.contentWindow?.postMessage(message, origin);
  // A frame Workbench cannot load (unreachable, or a certificate this browser does not trust) stays blank without an
  // error, so after a while without "ready" the panel says so and offers Workbench in a tab of its own.
  const [ready, setReady] = useState(false);
  const [slow, setSlow] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { setSlow(false); const t = setTimeout(() => setSlow(true), 10_000); return () => clearTimeout(t); }, [attempt]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== origin || e.source !== frame.current?.contentWindow || typeof e.data?.type !== "string") return;
      if (e.data.type === "workbench-chat:ready") { setReady(true); send({ type: "workbench-chat:context", pageContext: context }); }
      if (e.data.type === "workbench-chat:action") {
        const { id, operation, payload } = e.data as { id: string; operation: string; payload: Payload };
        runHostOperation(String(operation), payload ?? {}, actions).then((r) => send({ type: "workbench-chat:action-result", id, ...r }));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [origin, actions]);
  useEffect(() => { send({ type: "workbench-chat:context", pageContext: context }); }, [environment, page, app]);

  // D34: a column beside the page, not over it. Its width can be dragged and is remembered; it can fold into a strip
  // (the conversation stays loaded) or take the whole content area. Under 1100px it is a drawer over the page.
  const [mode, setMode] = useState<"normal" | "collapsed" | "expanded">("normal");
  const [width, setWidth] = useState(() => { try { return clampWidth(Number(localStorage.getItem(WIDTH_KEY)) || 420); } catch { return 420; } });
  const [dragging, setDragging] = useState(false);
  const drag = (e: ReactPointerEvent) => {
    e.preventDefault();
    setDragging(true);
    const move = (ev: PointerEvent) => setWidth(clampWidth(window.innerWidth - ev.clientX));
    const up = () => {
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setWidth((w) => { try { localStorage.setItem(WIDTH_KEY, String(w)); } catch { /* per-viewer convenience only */ } return w; });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <>
      {mode !== "collapsed" && <div className="assistant-backdrop" onClick={() => setMode("collapsed")} />}
      <aside className={`assistant ${mode}${dragging ? " dragging" : ""}`} style={{ "--assistant-width": `${width}px` } as CSSProperties}>
        {mode === "collapsed" ? (
          <button className="assistant-strip" onClick={() => setMode("normal")} title="Show the Deploy Assistant" aria-label="Show the Deploy Assistant">
            <span>Deploy Assistant</span>
          </button>
        ) : (
          <>
            {mode === "normal" && <div className="assistant-resizer" onPointerDown={drag} title="Drag to resize" aria-hidden="true" />}
            <div className="toolbar">
              <strong>Deploy Assistant</strong>
              <span className="muted">Read-only; changes run through cards after you confirm them</span>
              <button className="link" onClick={() => setMode("collapsed")} title="Fold into a strip; the conversation stays">Collapse</button>
              <button className="link wide-only" onClick={() => setMode(mode === "expanded" ? "normal" : "expanded")}>{mode === "expanded" ? "Restore" : "Expand"}</button>
              <button className="link" onClick={onClose}>Close</button>
            </div>
          </>
        )}
        {mode !== "collapsed" && <AiMissing use="assistant" what="The Deploy Assistant" {...(onSetup ? { onSetup } : {})} />}
        {!ready && slow && mode !== "collapsed" && (
          <div className="assistant-hint">
            <p>The assistant has not loaded from Workbench ({origin}). The frame stays blank when Workbench is unreachable or this browser does not trust its certificate.</p>
            <p><a href={src} target="_blank" rel="noreferrer">Open Workbench in a new tab</a> to see the error, then <button className="link" onClick={() => setAttempt(attempt + 1)}>try again</button>.</p>
          </div>
        )}
        <iframe key={attempt} ref={frame} src={src} title="Deploy Assistant" />
      </aside>
    </>
  );
}

const WIDTH_KEY = "deployer.assistant.width";
const clampWidth = (w: number) => Math.min(720, Math.max(320, Math.round(w)));

export function KeysPage({ isAdmin }: { isAdmin: boolean }) {
  const [list, setList] = useState<api.ApiKeyView[] | undefined>();
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [days, setDays] = useState(90);
  const [kind, setKind] = useState<"personal" | "service">("personal");
  const [made, setMade] = useState<string | undefined>();
  const refresh = () => api.keys().then((r) => setList(r.keys), (e: Error) => setError(e.message));
  useEffect(() => { refresh(); }, []);
  const create = (e: FormEvent) => {
    e.preventDefault();
    setError("");
    api.createKey(kind, name, days).then((r) => { setMade(r.key); setName(""); refresh(); }, (e: Error) => setError(e.message));
  };
  const revoke = async (id: string) => { if (await ask("Revoke this key? Clients using it stop working immediately.", { confirm: "Revoke", danger: true })) api.revokeKey(id).then(refresh, (e: Error) => setError(e.message)); };
  return (
    <>
      <div className="toolbar"><h1>API keys</h1><span className="muted">For AI clients (the Deployer's /mcp). A key can do what you can do on the page, but running in PROD, skipping promotion and seeing secret values accept only browser sessions</span></div>
      <form className="card panel" onSubmit={create}>
        <div className="row">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. My Claude Code" />
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>{[7, 30, 90, 365].map((d) => <option key={d} value={d}>{d} days</option>)}</select>
          {isAdmin && <select value={kind} onChange={(e) => setKind(e.target.value as "personal" | "service")}><option value="personal">Personal key</option><option value="service">Service key (read-only, for OMA Vault)</option></select>}
          <button className="primary" disabled={!name.trim()}>Create</button>
        </div>
        {made && <div className="banner warn">Shown only once; copy it now: <code className="mono">{made}</code> <button type="button" className="link" onClick={() => navigator.clipboard?.writeText(made)}>Copy</button></div>}
        {error && <p className="error">{error}</p>}
      </form>
      <table>
        <thead><tr><th>Name</th><th>Kind</th><th>Prefix</th><th>Owner</th><th>Expires</th><th>Last used</th><th></th></tr></thead>
        <tbody>
          {(list ?? []).map((k) => (
            <tr key={k.id} className={k.revokedAt ? "muted" : ""}>
              <td>{k.name}</td><td>{k.kind === "service" ? "Service (read-only)" : "Personal"}</td><td className="mono">{k.prefix}…</td><td>{k.owner}</td>
              <td>{new Date(k.expiresAt).toLocaleDateString("en-US")}</td><td>{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString("en-US", { hour12: false }) : "—"}</td>
              <td>{k.revokedAt ? "Revoked" : <button className="link" onClick={() => revoke(k.id)}>Revoke</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
