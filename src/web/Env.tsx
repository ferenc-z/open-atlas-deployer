// Phase 3 page (design §7.2): one app's env file — its values (secrets masked), the checks against
// .env.example and the compose fragment, editing as a new revision, the history with "回到这一版",
// writing to the server as a plan, and comparing with the other environment.

import { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "./api.ts";
import type { EnvEdit, EnvPlan, EnvView, Fingerprint, RegisteredApp } from "./api.ts";
import { JobPanel } from "./Deploy.tsx";

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }) : "—");
const SOURCE: Record<string, string> = { edit: "编辑", import: "从服务器导入", revert: "回到旧版" };
const CHANGE: Record<string, string> = { added: "新增", removed: "删除", changed: "修改" };
const MASK = "••••••••";

type Fail = { message: string; details: string[] };
const toFail = (e: api.ApiError): Fail => ({ message: e.message, details: e.details ?? [] });

function Failure({ error }: { error: Fail | undefined }) {
  if (!error) return null;
  return <div className="error">{error.message}{error.details.length > 0 && <ul>{error.details.map((d) => <li key={d}>{d}</li>)}</ul>}</div>;
}

export function EnvPage() {
  const [apps, setApps] = useState<RegisteredApp[] | undefined>();
  const [app, setApp] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { api.apps().then((d) => { setApps(d.apps); setApp((a) => a || d.apps[0]?.id || ""); }, (e: Error) => setError(e.message)); }, []);
  if (error) return <p className="error">{error}</p>;
  if (!apps) return <p className="muted">正在读取…</p>;
  return (
    <>
      <div className="toolbar">
        <h1>环境变量</h1>
        <select value={app} onChange={(e) => setApp(e.target.value)}>
          {apps.map((a) => <option key={a.id} value={a.id}>{a.name}（{a.id}）</option>)}
        </select>
        <span className="muted">Deployer 是 env 文件唯一的维护者：在这里改，确认计划后由执行器写入服务器并重启用到的服务。</span>
      </div>
      {app && <EnvApp key={app} app={app} />}
    </>
  );
}

function EnvApp({ app }: { app: string }) {
  const [data, setData] = useState<EnvView | undefined>();
  const [revision, setRevision] = useState<number | undefined>();
  const [mode, setMode] = useState<"view" | "edit" | "plan" | "compare">("view");
  const [job, setJob] = useState<string | undefined>();
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [error, setError] = useState<Fail | undefined>();
  const refresh = useCallback((rev?: number) => {
    setError(undefined);
    api.env(app, rev).then((d) => { setData(d); setRevision(rev); setRevealed({}); }, (e: api.ApiError) => setError(toFail(e)));
  }, [app]);
  useEffect(() => refresh(), [refresh]);

  if (error && !data) return <Failure error={error} />;
  if (!data) return <p className="muted">正在读取…</p>;
  const latest = data.revisions[0]?.revision ?? null;
  const shown = data.revision?.revision ?? null;
  const viewingOld = revision !== undefined && revision !== latest;
  const schemaKeys = "keys" in data.schema ? data.schema.keys : [];
  const byKey = new Map(schemaKeys.map((k) => [k.key, k]));
  const findingFor = new Map(data.findings.map((f) => [f.key, f]));
  const reveal = (key: string) => api.revealEnv(app, shown!, key).then((r) => setRevealed({ ...revealed, [key]: r.value }), (e: api.ApiError) => setError(toFail(e)));
  const startImport = () => api.importEnv(app).then((r) => setJob(r.job.id), (e: api.ApiError) => setError(toFail(e)));
  const revert = (rev: number) => {
    if (!confirm(`以第 ${rev} 版的值另存为新版本？保存后还需要写入服务器才生效。`)) return;
    api.revertEnv(app, rev, latest).then(() => refresh(), (e: api.ApiError) => setError(toFail(e)));
  };

  return (
    <>
      <div className="toolbar">
        <h2 className="mono">{data.file}</h2>
        <span className="muted">
          {shown === null ? "还没有任何版本" : <>第 {shown} 版{viewingOld && "（历史版本）"} · 服务器上：{data.applied === null ? "还没导入" : `第 ${data.applied} 版`}{data.applied !== null && latest !== data.applied && <span className="badge warn">有未写入的修改</span>}</>}
          {!data.deployed && " · 还没有经 Deployer 部署过，写入只改文件"}
        </span>
        {viewingOld && <button className="link" onClick={() => refresh()}>回到最新版</button>}
        {data.canChange && mode === "view" && !viewingOld && (
          <>
            <button onClick={startImport}>从服务器导入</button>
            <button onClick={() => setMode("edit")}>编辑</button>
            {shown !== null && <button className="primary" onClick={() => setMode("plan")}>写入服务器…</button>}
          </>
        )}
        {mode === "view" && data.applied !== null && <button onClick={() => setMode("compare")}>与另一环境对比</button>}
      </div>
      {job && <JobPanel id={job} onClose={() => { setJob(undefined); refresh(); }} />}
      <Failure error={error} />
      {mode === "plan" && shown !== null && <PlanPanel app={app} revision={shown} onClose={() => setMode("view")} onJob={(id) => { setMode("view"); setJob(id); }} />}
      {mode === "compare" && <Compare app={app} onClose={() => setMode("view")} />}
      {mode === "edit"
        ? <Editor data={data} onCancel={() => setMode("view")} onSaved={() => { setMode("view"); refresh(); }} />
        : (
          <>
            <p className="muted">
              校验依据：{"error" in data.schema ? <span className="error">{data.schema.error}</span> : <>{data.schema.source}（{data.version}）</>}
              {data.referenced.required.length > 0 && <> · compose 片段引用 {data.referenced.required.map((k) => `\${${k}}`).join(" ")}</>}
            </p>
            {data.findings.length > 0 && (
              <ul className="findings">{data.findings.map((f) => <li key={f.code + f.key} className={f.blocking ? "error" : "muted"}>{f.blocking ? "✕ " : "• "}{f.message}</li>)}</ul>
            )}
            <table>
              <thead><tr><th>键</th><th>值</th><th>.env.example</th></tr></thead>
              <tbody>
                {data.values.map((v) => (
                  <tr key={v.key}>
                    <td className="mono">{v.key}{findingFor.get(v.key) && <span className="badge warn">{findingFor.get(v.key)!.code === "env/renamed" ? "可能改名" : "未知"}</span>}</td>
                    <td className="mono value">
                      {v.secret
                        ? revealed[v.key] !== undefined ? revealed[v.key] : <>{MASK} <span className="badge muted">密钥</span>{data.canReveal && <button className="link" onClick={() => reveal(v.key)}>查看原值</button>}</>
                        : v.value === "" ? <span className="muted">（空）</span> : v.value}
                    </td>
                    <td className="muted">{byKey.get(v.key)?.comment ?? ""}</td>
                  </tr>
                ))}
                {schemaKeys.filter((k) => !data.values.some((v) => v.key === k.key)).map((k) => (
                  <tr key={k.key} className="absent">
                    <td className="mono">{k.key}{k.required ? <span className="badge warn">缺少</span> : <span className="badge muted">可选</span>}</td>
                    <td className="mono muted">{k.example ? `示例：${k.example}` : "—"}</td>
                    <td className="muted">{k.comment ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      <h3>版本历史</h3>
      <table>
        <thead><tr><th>版本</th><th>来源</th><th>谁</th><th>何时</th><th>改了哪些键</th><th>说明</th><th></th></tr></thead>
        <tbody>
          {data.revisions.map((r) => (
            <tr key={r.revision} className={r.revision === shown ? "current" : ""}>
              <td>{r.revision}{r.revision === data.applied && <span className="badge ok">服务器上</span>}</td>
              <td>{SOURCE[r.source] ?? r.source}</td>
              <td>{r.savedBy}</td>
              <td className="muted">{when(r.savedAt)}</td>
              <td className="mono">{r.changes.length ? r.changes.map((c) => `${c.key} ${c.secret && c.change === "changed" ? "已修改" : CHANGE[c.change]}`).join("，") : <span className="muted">无变化</span>}</td>
              <td className="muted">{r.note ?? ""}</td>
              <td className="actions">
                {r.revision !== shown && <button className="link" onClick={() => refresh(r.revision)}>查看</button>}
                {data.canChange && r.revision !== latest && <button className="link" onClick={() => revert(r.revision)}>回到这一版</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

type Row = { id: number; key: string; value: string; secret: boolean; had: boolean };

function Editor({ data, onCancel, onSaved }: { data: EnvView; onCancel: () => void; onSaved: () => void }) {
  const initial = useMemo<Row[]>(() => data.values.map((v, i) => ({ id: i, key: v.key, value: v.value ?? "", secret: v.secret, had: true })), [data]);
  const [rows, setRows] = useState<Row[]>(initial);
  const [note, setNote] = useState("");
  const [error, setError] = useState<Fail | undefined>();
  const [nextId, setNextId] = useState(initial.length);
  const schemaKeys = "keys" in data.schema ? data.schema.keys : [];
  const missing = schemaKeys.filter((k) => !rows.some((r) => r.key === k.key));
  const add = (key = "", value = "") => { setRows([...rows, { id: nextId, key, value, secret: data.secrets.includes(key), had: false }]); setNextId(nextId + 1); };
  const update = (id: number, patch: Partial<Row>) => setRows(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const save = () => {
    setError(undefined);
    // A secret the page never saw goes back as "keep" unless someone typed a new value.
    const values: EnvEdit[] = rows.filter((r) => r.key.trim()).map((r) => (r.secret && r.had && r.value === "" ? { key: r.key.trim(), keep: true } : { key: r.key.trim(), value: r.value }));
    api.saveEnv(data.app, data.revision?.revision ?? null, values, note || undefined).then(onSaved, (e: api.ApiError) => setError(toFail(e)));
  };
  return (
    <section className="card panel">
      <p className="muted">保存后是新的一版，还没有写入服务器。密钥留空表示不修改；要清空密钥请删除这一行。</p>
      <table className="edit">
        <thead><tr><th>键</th><th>值</th><th></th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td><input className="mono" value={r.key} onChange={(e) => update(r.id, { key: e.target.value, secret: r.secret || data.secrets.includes(e.target.value) })} placeholder="KEY" /></td>
              <td>
                {r.secret
                  ? <input className="mono" type="password" autoComplete="new-password" value={r.value} onChange={(e) => update(r.id, { value: e.target.value })} placeholder={r.had ? "不修改则留空" : "密钥"} />
                  : <input className="mono" value={r.value} onChange={(e) => update(r.id, { value: e.target.value })} />}
              </td>
              <td className="actions"><button className="link danger" onClick={() => setRows(rows.filter((x) => x.id !== r.id))}>删除</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <button onClick={() => add()}>添加一行</button>
        {missing.length > 0 && (
          <select value="" onChange={(e) => { const k = schemaKeys.find((x) => x.key === e.target.value); if (k) add(k.key, k.example); }}>
            <option value="">从 .env.example 添加…</option>
            {missing.map((k) => <option key={k.key} value={k.key}>{k.key}{k.required ? "（应设置）" : ""}</option>)}
          </select>
        )}
      </div>
      <div className="row">
        <input placeholder="修改说明（可选）" value={note} onChange={(e) => setNote(e.target.value)} />
        <button onClick={onCancel}>取消</button>
        <button className="primary" onClick={save}>保存为新版本</button>
      </div>
      <Failure error={error} />
    </section>
  );
}

function PlanPanel({ app, revision, onClose, onJob }: { app: string; revision: number; onClose: () => void; onJob: (id: string) => void }) {
  const [plan, setPlan] = useState<EnvPlan | undefined>();
  const [error, setError] = useState<Fail | undefined>();
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.planEnv(app, revision).then(setPlan, (e: api.ApiError) => setError(toFail(e))); }, [app, revision]);
  const apply = () => { setBusy(true); api.applyEnv(app, revision).then((r) => onJob(r.job.id), (e: api.ApiError) => { setError(toFail(e)); setBusy(false); }); };
  const blocking = plan?.findings.filter((f) => f.blocking) ?? [];
  return (
    <section className="card panel">
      <div className="toolbar">
        <h2>写入第 {revision} 版</h2>
        <span className="muted">{plan ? `服务器上现在是${plan.applied === null ? "未导入的文件" : `第 ${plan.applied} 版`}` : ""}</span>
        <button className="link" onClick={onClose}>关闭</button>
      </div>
      {plan && (
        <div className="plan">
          {plan.findings.length > 0 && <ul className="findings">{plan.findings.map((f) => <li key={f.code + (f.key ?? "")} className={f.blocking ? "error" : "muted"}>{f.blocking ? "✕ " : "• "}{f.message}</li>)}</ul>}
          <p>
            {plan.changes.length ? <>改动：<span className="mono">{plan.changes.map((c) => `${c.key} ${c.secret && c.change === "changed" ? "已修改" : CHANGE[c.change]}`).join("，")}</span></> : "没有改动。"}
          </p>
          <p>{plan.restarts.length ? <>会重启：<span className="mono">{plan.restarts.join("、")}</span>。重启期间这些服务不可用，通常几秒到一分钟；健康检查不过会自动换回原来的文件。</> : "不重启任何服务。"}</p>
          <div className="row"><button className="primary" onClick={apply} disabled={busy || blocking.length > 0}>确认写入</button></div>
        </div>
      )}
      <Failure error={error} />
    </section>
  );
}

/** §7.2 并排比较: this environment's fingerprint next to the other Deployer's, fetched in PROD (§6.3) or pasted. */
function Compare({ app, onClose }: { app: string; onClose: () => void }) {
  const [mine, setMine] = useState<Fingerprint | undefined>();
  const [text, setText] = useState("");
  const [error, setError] = useState<Fail | undefined>();
  const [fetched, setFetched] = useState<string | undefined>();
  useEffect(() => { api.fingerprint(app).then(setMine, (e: api.ApiError) => setError(toFail(e))); }, [app]);
  useEffect(() => {
    api.peerFingerprint(app).then((fp) => { setText(JSON.stringify(fp)); setFetched(""); }, (e: api.ApiError) => { if (e.status !== 404) setFetched(e.message); });
  }, [app]);
  let other: Fingerprint | undefined;
  let parseError = "";
  if (text.trim()) {
    try {
      other = JSON.parse(text);
      if (other?.format !== mine?.format || other?.app !== app) parseError = `这不是 ${app} 的环境变量指纹。`;
    } catch (e) { parseError = `不是合法的 JSON：${(e as Error).message}`; }
  }
  const cell = (v: { value?: string; secret?: string | null } | undefined) => (!v ? <span className="muted">（没有）</span> : "value" in v ? (v.value || <span className="muted">（空）</span>) : <span className="muted">{MASK}</span>);
  const same = (a?: { value?: string; secret?: string | null }, b?: { value?: string; secret?: string | null }) => {
    if (!a || !b) return false;
    if ("value" in a || "value" in b) return a.value === b.value;
    return a.secret !== null && a.secret === b.secret ? true : a.secret === null || b.secret === null ? undefined : false;
  };
  const keys = mine && other && !parseError ? [...new Set([...Object.keys(mine.keys), ...Object.keys(other.keys)])].sort() : [];
  return (
    <section className="card panel">
      <div className="toolbar"><h2>与另一环境对比</h2><span className="muted">密钥只比较是否相同</span><button className="link" onClick={onClose}>关闭</button></div>
      {mine && (
        <details>
          <summary>本环境（{mine.environment.toUpperCase()}，第 {mine.revision} 版）的指纹：复制到另一环境的 Deployer 里粘贴</summary>
          <div className="row"><button onClick={() => navigator.clipboard?.writeText(JSON.stringify(mine))}>复制</button></div>
          <pre className="json">{JSON.stringify(mine, null, 2)}</pre>
        </details>
      )}
      {fetched === "" ? <p className="muted">已从 UAT 的 Deployer 取得指纹。</p> : <>
        {fetched && <p className="error">没能从 UAT 的 Deployer 取得指纹：{fetched}。可以手工粘贴。</p>}
        <textarea className="mono" spellCheck={false} rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="粘贴另一环境的指纹（那边的 环境变量 → 与另一环境对比 → 复制）" />
      </>}
      {parseError && <p className="error">{parseError}</p>}
      {keys.length > 0 && mine && other && (
        <table>
          <thead><tr><th>键</th><th>{mine.environment.toUpperCase()}</th><th>{other.environment.toUpperCase()}</th><th></th></tr></thead>
          <tbody>
            {keys.map((k) => {
              const s = same(mine.keys[k], other!.keys[k]);
              return (
                <tr key={k} className={s === false ? "differs" : ""}>
                  <td className="mono">{k}</td><td className="mono value">{cell(mine.keys[k])}</td><td className="mono value">{cell(other!.keys[k])}</td>
                  <td>{s === true ? <span className="badge ok">相同</span> : s === false ? <span className="badge warn">不同</span> : <span className="badge muted">无法比较</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {mine && Object.values(mine.keys).some((v) => "secret" in v && v.secret === null) && <p className="muted">没有配置 DEPLOYER_COMPARE_KEY：密钥只能看出两边是否都设置了。</p>}
      <Failure error={error} />
    </section>
  );
}
