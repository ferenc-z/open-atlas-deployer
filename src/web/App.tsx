import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import * as api from "./api.ts";
import type { AuditEntry, Manifest, Me, Principal, RegisteredApp, StatusView } from "./api.ts";
import { DeployPanel, History, JobPanel, JobState, KIND } from "./Deploy.tsx";
import { EnvPage } from "./Env.tsx";
import { Artifacts } from "./Artifacts.tsx";
import { AssistantPanel, KeysPage } from "./Assistant.tsx";

type Tab = "status" | "history" | "artifacts" | "env" | "registry" | "keys" | "audit";
type Panel = { kind: "deploy"; app: string; initial?: { version: string; pinFrom?: string } } | { kind: "job"; id: string } | undefined;

const VERDICT: Record<string, { label: string; tone: string }> = {
  ok: { label: "正常", tone: "ok" },
  drift: { label: "版本不符", tone: "warn" },
  starting: { label: "启动中", tone: "info" },
  down: { label: "异常", tone: "bad" },
  missing: { label: "没有容器", tone: "bad" },
  unknown: { label: "未知", tone: "muted" },
  "not-a-service": { label: "—", tone: "muted" },
};

const TYPE_LABEL: Record<string, string> = {
  "compose-service": "容器", "workbench-app": "Workbench 应用包", "oma-agent": "OMA Agent",
  "db-migration": "数据库迁移", "studio-graph": "Studio Graph", manual: "人工步骤",
};

const when = (iso: string) => new Date(iso).toLocaleString("zh-CN", { hour12: false });

function Badge({ verdict }: { verdict: string }) {
  const v = VERDICT[verdict] ?? { label: verdict, tone: "muted" };
  return <span className={`badge ${v.tone}`}>{v.label}</span>;
}

export function App() {
  const [me, setMe] = useState<Me | undefined>();
  const [tab, setTab] = useState<Tab>("status");
  const [panel, setPanel] = useState<Panel>();
  const [assistant, setAssistant] = useState(false);
  const actions = useMemo(() => ({ openPlan: (app: string, version: string, pinFrom?: string) => { setPanel({ kind: "deploy", app, initial: { version, ...(pinFrom ? { pinFrom } : {}) } }); setTab("status"); } }), []);
  const load = useCallback(() => { api.me().then(setMe, () => setMe(undefined)); }, []);
  useEffect(load, [load]);

  if (!me) return <main className="center"><p className="muted">正在确认登录…</p></main>;
  if (!me.signedIn) return "forbidden" in me ? <Forbidden message={me.message} /> : <SignIn me={me} onSignedIn={load} />;
  const p = me.principal;
  return (
    <>
      <Header principal={p} environment={me.environment} tab={tab} setTab={setTab} onSignedOut={load} assistant={assistant} toggleAssistant={() => setAssistant(!assistant)} />
      {p.via === "emergency" && <div className="banner bad">正在使用紧急账号：Workbench 无法访问。每个操作都记入审计；Workbench 恢复后请改用 Workbench 登录。</div>}
      {p.stale && <div className="banner warn">Workbench 暂时没有响应，正在使用最近一次确认的登录（15 分钟内有效）。</div>}
      {p.actAs && <div className="banner info">{p.actAs.administrator} 正在以 {p.displayName} 的身份使用 Workbench，这里的权限也按 {p.displayName} 计算。</div>}
      {assistant && <AssistantPanel workbenchUrl={me.workbenchUrl} {...(me.environment ? { environment: me.environment } : {})} page={tab} {...(panel?.kind === "deploy" ? { app: panel.app } : {})} actions={actions} onClose={() => setAssistant(false)} />}
      <main className={assistant ? "with-assistant" : ""}>
        {tab === "status" && <Status panel={panel} setPanel={setPanel} isAdmin={p.permissions.includes("admin")} />}
        {tab === "artifacts" && <Artifacts />}
        {tab === "history" && <History onBack={(j) => { setPanel({ kind: "deploy", app: j.app, initial: { version: j.version, pinFrom: j.id } }); setTab("status"); }} />}
        {tab === "env" && <EnvPage />}
        {tab === "registry" && <Registry principal={p} />}
        {tab === "keys" && <KeysPage isAdmin={p.permissions.includes("admin")} />}
        {tab === "audit" && p.permissions.includes("admin") && <Audit />}
      </main>
    </>
  );
}

function Header({ principal, environment, tab, setTab, onSignedOut, assistant, toggleAssistant }: { principal: Principal; environment?: string; tab: Tab; setTab: (t: Tab) => void; onSignedOut: () => void; assistant: boolean; toggleAssistant: () => void }) {
  const tabs: [Tab, string][] = [["status", "状态"], ["history", "部署记录"], ["artifacts", "制品"], ["env", "环境变量"], ["registry", "应用注册表"], ["keys", "API key"], ...(principal.permissions.includes("admin") ? [["audit", "审计"] as [Tab, string]] : [])];
  return (
    <header>
      <div className="brand">Open Atlas Deployer{environment && <span className="env">{environment.toUpperCase()}</span>}</div>
      <nav>{tabs.map(([id, label]) => <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}</button>)}</nav>
      <div className="who">
        <span title={principal.groups.join(", ") || "无组"}>{principal.displayName}</span>
        <span className="muted">{principal.isAdmin ? "管理员" : principal.groups.filter((g) => g.startsWith("deploy-")).join(" · ")}</span>
        {principal.via === "workbench" && <button className={assistant ? "active" : ""} onClick={toggleAssistant}>问助手</button>}
        {principal.via === "emergency" && <button className="link" onClick={() => api.emergencyLogout().then(onSignedOut)}>退出</button>}
      </div>
    </header>
  );
}

function SignIn({ me, onSignedIn }: { me: Extract<Me, { emergencyAvailable: boolean }>; onSignedIn: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError("");
    api.emergencyLogin(password).then(onSignedIn, (err: Error) => setError(err.message));
  };
  return (
    <main className="center">
      <section className="card narrow">
        <h1>Open Atlas Deployer</h1>
        {me.reason === "workbench-unavailable"
          ? <p>Workbench 暂时无法访问，无法确认你的登录。</p>
          : <p>Deployer 使用 Workbench 的登录。请先登录 Workbench，再回到这里。</p>}
        <p><a className="button" href={me.workbenchUrl}>前往 Workbench 登录</a></p>
        {me.emergencyAvailable && (
          <form onSubmit={submit} className="emergency">
            <h2>紧急账号</h2>
            <p className="muted">只在 Workbench 无法访问时可用，每次使用都记入审计。</p>
            <input type="password" autoComplete="current-password" placeholder="紧急账号密码" value={password} onChange={(e) => setPassword(e.target.value)} />
            <button type="submit" disabled={!password}>登录</button>
            {error && <p className="error">{error}</p>}
          </form>
        )}
      </section>
    </main>
  );
}

function Forbidden({ message }: { message: string }) {
  return (
    <main className="center">
      <section className="card narrow">
        <h1>没有权限</h1>
        <p>{message}</p>
        <p className="muted">请 Workbench 管理员把你加入 deploy-viewer（查看）、deploy-uat 或 deploy-prod 组。</p>
      </section>
    </main>
  );
}

function Status({ panel, setPanel, isAdmin }: { panel: Panel; setPanel: (p: Panel) => void; isAdmin: boolean }) {
  const [data, setData] = useState<StatusView | undefined>();
  const [error, setError] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const refresh = useCallback(() => { api.statusView().then((d) => { setData(d); setError(""); }, (e: Error) => setError(e.message)); }, []);
  useEffect(() => { refresh(); const t = setInterval(refresh, panel ? 5_000 : 30_000); return () => clearInterval(t); }, [refresh, panel]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">正在读取…</p>;
  const peerApps = data.peer && "apps" in data.peer ? data.peer.apps : undefined;
  const peerName = data.peer && "environment" in data.peer ? data.peer.environment.toUpperCase() : "UAT";
  return (
    <>
      <div className="toolbar">
        <h1>{data.environment.toUpperCase()} 正在运行</h1>
        <span className="muted">
          {data.host ? <>容器状态 {when(data.host.at)}{data.host.stale && <span className="badge warn">已过期</span>}</> : "执行器还没有上报容器状态，只显示应用自报的版本"}
        </span>
        <button onClick={refresh}>刷新</button>
      </div>
      <p className="executor">
        {data.executor.online
          ? <><span className="badge ok">执行器在线</span> <span className="muted">{data.executor.heartbeat?.version}{data.executor.heartbeat?.busy ? ` · 正在执行 ${data.executor.heartbeat.busy}` : ""}</span></>
          : <><span className="badge bad">执行器离线</span> <span className="muted">{data.executor.reason}；可以查看，但不能构建和部署</span></>}
      </p>
      {data.peer && "error" in data.peer && <p className="banner warn">无法确认 UAT 记录：{data.peer.error}。只有已正式发布的版本、或管理员跳过晋级规则才能部署。</p>}
      {panel?.kind === "deploy" && <DeployPanel key={`${panel.app}-${panel.initial?.version ?? ""}-${panel.initial?.pinFrom ?? ""}`} app={panel.app} isAdmin={isAdmin} {...(panel.initial ? { initial: panel.initial } : {})} onClose={() => setPanel(undefined)} onJob={(id) => setPanel({ kind: "job", id })} />}
      {panel?.kind === "job" && <JobPanel id={panel.id} onClose={() => { setPanel(undefined); refresh(); }} />}
      <table className="status">
        <thead><tr><th>应用</th><th>期望版本</th>{peerApps && <th>{peerName} 现在</th>}<th>清单</th><th>状态</th><th></th></tr></thead>
        <tbody>
          {data.apps.map((a) => {
            const active = data.active.find((j) => j.app === a.app);
            return (
              <AppRows key={a.app} app={a} {...(peerApps ? { peer: peerApps[a.app]?.version ?? null } : {})} open={!!open[a.app]} toggle={() => setOpen({ ...open, [a.app]: !open[a.app] })}
                action={active
                  ? <button className="link" onClick={() => setPanel({ kind: "job", id: active.id })}><JobState state={active.state} /> {KIND[active.kind]} {active.kind.startsWith("env") ? "" : active.version}</button>
                  : data.canDeploy ? <button onClick={() => setPanel({ kind: "deploy", app: a.app })}>部署…</button> : null} />
            );
          })}
        </tbody>
      </table>
      {data.unmanaged.length > 0 && (
        <section>
          <h2>未纳入清单的容器</h2>
          <table><thead><tr><th>服务</th><th>镜像</th><th>状态</th></tr></thead>
            <tbody>{data.unmanaged.map((c) => <tr key={c.service}><td>{c.service}</td><td className="mono">{c.image}</td><td>{c.status}</td></tr>)}</tbody>
          </table>
        </section>
      )}
    </>
  );
}

function AppRows({ app, open, toggle, action, peer }: { app: StatusView["apps"][number]; open: boolean; toggle: () => void; action: React.ReactNode; peer?: string | null }) {
  return (
    <>
      <tr className="app" onClick={toggle}>
        <td><span className="caret">{open ? "▾" : "▸"}</span>{app.name}<span className="muted"> {app.app}</span></td>
        <td className="mono">{app.desired ?? <span className="muted">未纳入本环境</span>}</td>
        {peer !== undefined && <td className="mono">{peer ?? <span className="muted">—</span>}{peer && app.desired && peer !== app.desired && <span className="badge info">可晋级</span>}</td>}
        <td className="mono">{app.manifest ? `自 ${app.manifest}` : <span className="muted">无</span>}</td>
        <td><Badge verdict={app.verdict} /></td>
        <td className="actions" onClick={(e) => e.stopPropagation()}>{action}</td>
      </tr>
      {open && (
        <tr className="detail"><td colSpan={peer !== undefined ? 6 : 5}>
          <table>
            <thead><tr><th>组件</th><th>类型</th><th>服务</th><th>容器</th><th>标签版本</th><th>自报版本</th><th>判断</th></tr></thead>
            <tbody>
              {app.components.map((c) => (
                <tr key={c.id}>
                  <td>{c.id}</td>
                  <td>{TYPE_LABEL[c.type] ?? c.type}</td>
                  <td className="mono">{c.service ?? "—"}</td>
                  <td>{c.container ? <span title={c.container.image}>{c.container.status}</span> : c.type === "compose-service" ? <span className="muted">—</span> : <span className="muted">阶段 5 起显示</span>}</td>
                  <td className="mono">{c.container?.version ?? "—"}</td>
                  <td className="mono">{c.observed?.kind === "build" ? <span title={c.observed.commit}>{c.observed.version}</span> : c.observed?.kind === "no-build-info" ? <span className="muted">无 BUILD.json</span> : c.observed?.kind === "unreachable" ? <span className="muted">连不上</span> : "—"}</td>
                  <td><Badge verdict={c.verdict} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </td></tr>
      )}
    </>
  );
}

function Registry({ principal }: { principal: Principal }) {
  const [list, setList] = useState<RegisteredApp[] | undefined>();
  const [selected, setSelected] = useState<string | undefined>();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const admin = principal.permissions.includes("admin");
  const refresh = useCallback(() => { api.apps().then((d) => setList(d.apps), (e: Error) => setError(e.message)); }, []);
  useEffect(refresh, [refresh]);

  if (error) return <p className="error">{error}</p>;
  if (!list) return <p className="muted">正在读取…</p>;
  if (selected) return <AppDetail id={selected} admin={admin} back={() => { setSelected(undefined); refresh(); }} />;
  return (
    <>
      <div className="toolbar">
        <h1>应用注册表</h1>
        <span className="muted">Deployer 只部署这里列出的应用（§4.4）{admin ? "" : "；只有 Workbench 管理员能修改"}</span>
        {admin && <button onClick={() => setAdding(!adding)}>{adding ? "取消" : "登记应用"}</button>}
      </div>
      {adding && <ManifestForm onSaved={() => { setAdding(false); refresh(); }} />}
      <table>
        <thead><tr><th>应用</th><th>仓库</th><th>清单</th><th>登记</th></tr></thead>
        <tbody>
          {list.map((a) => {
            const ranges = [...new Set(a.manifests.map((m) => m.appliesFrom))];
            return (
              <tr key={a.id} className="app" onClick={() => setSelected(a.id)}>
                <td>{a.name}<span className="muted"> {a.id}</span></td>
                <td className="mono">{a.repo}</td>
                <td className="mono">{ranges.map((r) => `自 ${r}`).join("，")}</td>
                <td className="muted">{a.addedBy} · {when(a.addedAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

function AppDetail({ id, admin, back }: { id: string; admin: boolean; back: () => void }) {
  const [data, setData] = useState<{ app: RegisteredApp; manifests: Manifest[] } | undefined>();
  const [shown, setShown] = useState<{ from: string; rev: number; body: Manifest } | undefined>();
  const [editing, setEditing] = useState<Manifest | null>(null);
  const [error, setError] = useState("");
  const refresh = useCallback(() => { api.app(id).then(setData, (e: Error) => setError(e.message)); }, [id]);
  useEffect(refresh, [refresh]);

  const show = (from: string, rev: number) => api.revision(id, from, rev).then((body) => setShown({ from, rev, body }), (e: Error) => setError(e.message));
  const remove = () => {
    if (!confirm(`从注册表移除 ${id}？清单历史保留，但 Deployer 不再部署它。`)) return;
    api.removeApp(id).then(back, (e: Error) => setError(e.message));
  };

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">正在读取…</p>;
  const { app } = data;
  return (
    <>
      <div className="toolbar">
        <button className="link" onClick={back}>← 注册表</button>
        <h1>{app.name}<span className="muted"> {app.id}</span></h1>
        <span className="mono muted">{app.repo}</span>
        {admin && <><button onClick={() => setEditing(data.manifests.at(-1) ?? null)}>新清单 / 修改</button><button className="danger" onClick={remove}>移除</button></>}
      </div>
      {editing !== null && <ManifestForm initial={editing} appId={app.id} onSaved={() => { setEditing(null); refresh(); }} />}
      <h2>当前清单</h2>
      <table>
        <thead><tr><th>适用自</th><th>组件</th><th>env 文件</th></tr></thead>
        <tbody>
          {data.manifests.map((m) => (
            <tr key={m.appliesFrom}>
              <td className="mono">{m.appliesFrom}</td>
              <td>{m.components.map((c) => `${c.id}（${TYPE_LABEL[c.type] ?? c.type}）`).join("、")}</td>
              <td className="mono">{m.env?.file ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>修改历史</h2>
      <table>
        <thead><tr><th>适用自</th><th>版次</th><th>谁</th><th>何时</th><th>说明</th><th></th></tr></thead>
        <tbody>
          {app.manifests.map((m) => (
            <tr key={`${m.appliesFrom}-${m.revision}`}>
              <td className="mono">{m.appliesFrom}</td><td>{m.revision}</td><td>{m.savedBy}</td><td className="muted">{when(m.savedAt)}</td>
              <td className="muted">{m.note ?? ""}</td>
              <td className="actions">
                <button className="link" onClick={() => show(m.appliesFrom, m.revision)}>查看</button>
                <a href={api.revisionUrl(app.id, m.appliesFrom, m.revision)}>导出 deploy.json</a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {shown && (
        <section>
          <div className="toolbar"><h2>{shown.from} 第 {shown.rev} 版</h2><button className="link" onClick={() => setShown(undefined)}>收起</button></div>
          <pre className="json">{JSON.stringify(shown.body, null, 2)}</pre>
        </section>
      )}
    </>
  );
}

function ManifestForm({ initial, appId, onSaved }: { initial?: Manifest; appId?: string; onSaved: () => void }) {
  const [text, setText] = useState(initial ? JSON.stringify(initial, null, 2) : "");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<{ message: string; details: string[] } | undefined>();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    let manifest: { app?: string };
    try { manifest = JSON.parse(text); } catch (err) { setError({ message: `不是合法的 JSON：${(err as Error).message}`, details: [] }); return; }
    const id = appId ?? manifest.app;
    if (!id) { setError({ message: "清单里没有 app。", details: [] }); return; }
    api.saveManifest(id, manifest, name || undefined, note || undefined).then(onSaved, (err: api.ApiError) => setError({ message: err.message, details: err.details }));
  };
  return (
    <form className="card manifest" onSubmit={submit}>
      <p className="muted">
        {appId ? "改 appliesFrom 即从新版本起另立一份清单；不改则保存为同一区间的新版次。" : "粘贴部署清单 v1（deploy.json）。第一份清单登记应用，仓库取自 release.repo。"}
        保存前按格式 v1 校验，并检查服务名、宿主机端口和其他应用不冲突。
      </p>
      <textarea spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} placeholder='{ "v": 1, "app": "…", "appliesFrom": "…", … }' />
      <div className="row">
        {!appId && <input placeholder="显示名（可选）" value={name} onChange={(e) => setName(e.target.value)} />}
        <input placeholder="修改说明（可选）" value={note} onChange={(e) => setNote(e.target.value)} />
        <button type="submit" disabled={!text.trim()}>校验并保存</button>
      </div>
      {error && <div className="error">{error.message}{error.details.length > 0 && <ul>{error.details.map((d) => <li key={d} className="mono">{d}</li>)}</ul>}</div>}
    </form>
  );
}

function Audit() {
  const [entries, setEntries] = useState<AuditEntry[] | undefined>();
  const [error, setError] = useState("");
  useEffect(() => { api.audit().then((d) => setEntries(d.entries), (e: Error) => setError(e.message)); }, []);
  if (error) return <p className="error">{error}</p>;
  if (!entries) return <p className="muted">正在读取…</p>;
  const VIA: Record<string, string> = { workbench: "Workbench", emergency: "紧急账号", cli: "命令行" };
  return (
    <>
      <div className="toolbar"><h1>审计</h1><span className="muted">最近 100 条</span></div>
      <table>
        <thead><tr><th>时间</th><th>谁</th><th>经由</th><th>操作</th><th>对象</th><th>详情</th></tr></thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id} className={e.via === "emergency" ? "flag" : ""}>
              <td className="muted">{when(e.at)}</td><td>{e.actor}</td><td>{VIA[e.via] ?? e.via}</td>
              <td className="mono">{e.action}</td><td className="mono">{e.target}</td>
              <td className="mono muted">{e.detail ? JSON.stringify(e.detail) : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
