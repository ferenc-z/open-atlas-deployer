// Phase 6 pages: the Deploy Assistant beside the page (Workbench's embedded chat, design §10.2 interface A) and
// API keys (§9.4). The assistant only proposes: a card the person applies comes here as workbench-chat:action and
// runs as that person, through the same calls as the buttons; only the operations declared in Workbench's
// application entry (chat.hostOperations) are accepted, and only from Workbench's own origin.

import { useEffect, useRef, useState, type FormEvent } from "react";
import * as api from "./api.ts";

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
  if (!(HOST_OPERATIONS as readonly string[]).includes(operation)) return { ok: false, outcome: `Deployer 不接受操作 ${operation}` };
  if (!app) return { ok: false, outcome: "卡片里没有 app" };
  try {
    switch (operation) {
      case "plan_deploy":
      case "plan_rollback": {
        const version = str(payload.version);
        if (!version) return { ok: false, outcome: "卡片里没有 version" };
        const pinFrom = str(payload.pin_from ?? payload.pinFrom) || undefined;
        if (operation === "plan_rollback" && !pinFrom) return { ok: false, outcome: "回到旧版要指明是哪一次部署（pin_from）" };
        actions.openPlan(app, version, pinFrom);
        return { ok: true, outcome: `已在页面上生成 ${app} ${version} 的计划：核对后点\"确认部署\"才会执行` };
      }
      case "build_artifact": {
        const version = str(payload.version);
        if (!version) return { ok: false, outcome: "卡片里没有 version" };
        const r = await api.build(app, version);
        return { ok: true, outcome: `已开始构建 ${app} ${version}（${r.jobs.map((j) => j.id).join("、")}）` };
      }
      case "set_env_value": {
        const key = str(payload.key);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof payload.value !== "string") return { ok: false, outcome: "卡片里的 key 或 value 不对" };
        const view = await api.env(app);
        const values: api.EnvEdit[] = view.values.filter((v) => v.key !== key).map((v) => (v.secret ? { key: v.key, keep: true } : { key: v.key, value: v.value ?? "" }));
        values.push({ key, value: payload.value });
        const r = await api.saveEnv(app, view.revision?.revision ?? null, values, str(payload.note) || `助手卡片：设置 ${key}`);
        return { ok: true, outcome: `${app} 的环境变量第 ${r.revision} 版已保存，还没写入服务器：到\"环境变量\"页看计划后写入` };
      }
    }
  } catch (error) {
    return { ok: false, outcome: (error as Error).message };
  }
  return { ok: false, outcome: "没有处理" };
}

export function AssistantPanel({ workbenchUrl, environment, page, app, actions, onClose }: { workbenchUrl: string; environment?: string; page: string; app?: string; actions: HostActions; onClose: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const base = new URL(workbenchUrl, window.location.href);
  const origin = base.origin;
  const src = new URL(`embed/chat?app=deployer&key=${encodeURIComponent(`env:${environment ?? "unknown"}`)}&title=${encodeURIComponent(`Deployer ${(environment ?? "").toUpperCase()}`)}`, base.href.endsWith("/") ? base.href : `${base.href}/`).href;
  const context = { env: environment ?? "unknown", page, ...(app ? { app } : {}) };
  const send = (message: Record<string, unknown>) => frame.current?.contentWindow?.postMessage(message, origin);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== origin || e.source !== frame.current?.contentWindow || typeof e.data?.type !== "string") return;
      if (e.data.type === "workbench-chat:ready") send({ type: "workbench-chat:context", pageContext: context });
      if (e.data.type === "workbench-chat:action") {
        const { id, operation, payload } = e.data as { id: string; operation: string; payload: Payload };
        runHostOperation(String(operation), payload ?? {}, actions).then((r) => send({ type: "workbench-chat:action-result", id, ...r }));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [origin, actions]);
  useEffect(() => { send({ type: "workbench-chat:context", pageContext: context }); }, [environment, page, app]);

  return (
    <aside className="assistant">
      <div className="toolbar"><strong>Deploy Assistant</strong><span className="muted">只读；改动经卡片由你确认后执行</span><button className="link" onClick={onClose}>收起</button></div>
      <iframe ref={frame} src={src} title="Deploy Assistant" />
    </aside>
  );
}

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
  const revoke = (id: string) => { if (confirm("吊销这把 key？用它的客户端会立即失效。")) api.revokeKey(id).then(refresh, (e: Error) => setError(e.message)); };
  return (
    <>
      <div className="toolbar"><h1>API key</h1><span className="muted">给 AI 客户端用（Deployer 的 /mcp）。key 能做的和你在页面上能做的一样，但 PROD 执行、跳过晋级、查看密钥原值只认浏览器会话</span></div>
      <form className="card panel" onSubmit={create}>
        <div className="row">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="名字，如 我的 Claude Code" />
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>{[7, 30, 90, 365].map((d) => <option key={d} value={d}>{d} 天</option>)}</select>
          {isAdmin && <select value={kind} onChange={(e) => setKind(e.target.value as "personal" | "service")}><option value="personal">个人 key</option><option value="service">服务 key（只读，给 OMA Vault）</option></select>}
          <button className="primary" disabled={!name.trim()}>生成</button>
        </div>
        {made && <div className="banner warn">只显示这一次，请现在复制：<code className="mono">{made}</code> <button type="button" className="link" onClick={() => navigator.clipboard?.writeText(made)}>复制</button></div>}
        {error && <p className="error">{error}</p>}
      </form>
      <table>
        <thead><tr><th>名字</th><th>类型</th><th>前缀</th><th>主人</th><th>到期</th><th>最近使用</th><th></th></tr></thead>
        <tbody>
          {(list ?? []).map((k) => (
            <tr key={k.id} className={k.revokedAt ? "muted" : ""}>
              <td>{k.name}</td><td>{k.kind === "service" ? "服务（只读）" : "个人"}</td><td className="mono">{k.prefix}…</td><td>{k.owner}</td>
              <td>{new Date(k.expiresAt).toLocaleDateString("zh-CN")}</td><td>{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString("zh-CN", { hour12: false }) : "—"}</td>
              <td>{k.revokedAt ? "已吊销" : <button className="link" onClick={() => revoke(k.id)}>吊销</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
