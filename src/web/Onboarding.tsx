// Phase 7 page (design §10.5): assessments. Start one from a repository (or a new version of a registered app),
// follow the Onboarding Assessor's progress, read and edit its draft, validate, trial-deploy in UAT, register.

import { useEffect, useState, type FormEvent } from "react";
import * as api from "./api.ts";
import type { AssessmentView } from "./api.ts";

const STATE: Record<string, { label: string; tone: string }> = {
  assessing: { label: "评估中", tone: "info" }, ready: { label: "评估完成", tone: "ok" }, failed: { label: "失败", tone: "bad" },
  trial: { label: "试部署", tone: "warn" }, registered: { label: "已登记", tone: "ok" }, adopted: { label: "已采用", tone: "ok" }, closed: { label: "已关闭", tone: "muted" },
};
const LEVEL: Record<string, string> = { A: "A 直接可部署", B: "B 补配置可部署", C: "C 需要改仓库", D: "D 不适合", unchanged: "清单不用改" };
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }) : "—");

export function OnboardingPage({ canStart, isAdmin, onJob }: { canStart: boolean; isAdmin: boolean; onJob: (id: string) => void }) {
  const [list, setList] = useState<AssessmentView[] | undefined>();
  const [open, setOpen] = useState<string | undefined>();
  const [repo, setRepo] = useState("");
  const [version, setVersion] = useState("");
  const [error, setError] = useState("");
  const [apps, setApps] = useState<string[]>([]);
  const [app, setApp] = useState("");
  const [appVersion, setAppVersion] = useState("");
  useEffect(() => { api.apps().then((r) => setApps(r.apps.map((x) => x.id)), () => setApps([])); }, []);
  const startVersion = (e: FormEvent) => {
    e.preventDefault();
    setError("");
    api.startAssessment({ app, version: appVersion }).then((r) => { setOpen(r.assessment.id); setAppVersion(""); refresh(); }, (e: Error) => setError(e.message));
  };
  const refresh = () => api.assessments().then((r) => setList(r.assessments), (e: Error) => setError(e.message));
  useEffect(() => { refresh(); const t = setInterval(refresh, 5_000); return () => clearInterval(t); }, []);
  const start = (e: FormEvent) => {
    e.preventDefault();
    setError("");
    api.startAssessment({ repo, ...(version ? { version } : {}) }).then((r) => { setOpen(r.assessment.id); setRepo(""); setVersion(""); refresh(); }, (e: Error) => setError(e.message));
  };
  return (
    <>
      <div className="toolbar"><h1>接入评估</h1><span className="muted">给一个仓库地址，由 Onboarding Assessor 在隔离沙箱里评估并配置草案；试部署和登记由人确认</span></div>
      {canStart && (
        <form className="card panel" onSubmit={start}>
          <div className="row">
            <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="https://github.com/owner/repo 或 git@bitbucket…" style={{ flex: 1 }} />
            <input value={version} onChange={(e) => setVersion(e.target.value.trim())} placeholder="版本（可选）" />
            <button className="primary" disabled={!repo.trim()}>评估仓库</button>
          </div>
          {error && <p className="error">{error}</p>}
        </form>
      )}
      {canStart && (
        <form className="card panel" onSubmit={startVersion}>
          <div className="row">
            <span>评估新版本（D27）：</span>
            <select value={app} onChange={(e) => setApp(e.target.value)}><option value="">选应用</option>{apps.map((x) => <option key={x} value={x}>{x}</option>)}</select>
            <input value={appVersion} onChange={(e) => setAppVersion(e.target.value.trim())} placeholder="新版本，如 1.4.0" />
            <button disabled={!app || !appVersion}>评估这个版本</button>
            <span className="muted">AI 对比两个 tag 之间部署相关文件的差异，判断清单要不要改</span>
          </div>
        </form>
      )}
      {open && <AssessmentPanel id={open} canStart={canStart} isAdmin={isAdmin} onClose={() => setOpen(undefined)} onChanged={refresh} onJob={onJob} />}
      <table>
        <thead><tr><th>开始</th><th>类型</th><th>仓库 / 应用</th><th>版本</th><th>谁</th><th>状态</th><th>级别</th></tr></thead>
        <tbody>
          {(list ?? []).map((a) => (
            <tr key={a.id} className="app" onClick={() => setOpen(a.id)}>
              <td className="muted">{when(a.createdAt)}</td><td>{a.kind === "version" ? "新版本" : "接入"}</td>
              <td className="mono">{a.app ?? a.repo}</td><td className="mono">{a.version ?? "—"}</td><td>{a.requestedBy}</td>
              <td><span className={`badge ${STATE[a.state]?.tone ?? "muted"}`}>{STATE[a.state]?.label ?? a.state}</span></td><td>{a.level ? LEVEL[a.level] : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function AssessmentPanel({ id, canStart, isAdmin, onClose, onChanged, onJob }: { id: string; canStart: boolean; isAdmin: boolean; onClose: () => void; onChanged: () => void; onJob: (id: string) => void }) {
  const [a, setA] = useState<AssessmentView | undefined>();
  const [error, setError] = useState<{ message: string; details: string[] } | undefined>();
  const [editing, setEditing] = useState<string | undefined>();
  const [reason, setReason] = useState("");
  const load = () => api.assessment(id).then(setA, (e: api.ApiError) => setError({ message: e.message, details: e.details }));
  useEffect(() => { load(); const t = setInterval(load, 4_000); return () => clearInterval(t); }, [id]);
  const act = (p: Promise<unknown>) => { setError(undefined); p.then(() => { load(); onChanged(); }, (e: api.ApiError) => setError({ message: e.message, details: e.details ?? [] })); };
  if (!a) return <section className="card panel"><p className="muted">正在读取…</p></section>;
  const save = () => {
    let draft: unknown;
    try { draft = JSON.parse(editing!); } catch { setError({ message: "草案不是合法的 JSON", details: [] }); return; }
    act(api.changeDraft(id, "replace", { draft, reason }).then(() => { setEditing(undefined); setReason(""); }));
  };
  return (
    <section className="card panel">
      <div className="toolbar">
        <h2>{a.kind === "version" ? `${a.app} ${a.version} 的版本评估` : a.repo}</h2>
        <span className={`badge ${STATE[a.state]?.tone ?? "muted"}`}>{STATE[a.state]?.label ?? a.state}</span>
        {a.level && <span className="badge info">{LEVEL[a.level]}</span>}
        <span className="muted">{a.requestedBy} · {when(a.createdAt)}</span>
        <button className="link" onClick={onClose}>关闭</button>
      </div>
      {a.message && <p className={a.state === "failed" ? "error" : ""}>{a.message}</p>}
      {a.report && <div><h3>评估报告</h3><pre className="report">{a.report}</pre></div>}
      {a.state === "assessing" && <details open><summary>进度（OMA 会话 {a.session}）</summary><ol className="steps">{a.progress.map((p, i) => <li key={i}>{p}</li>)}</ol></details>}
      <details open={Boolean(a.findings?.length)}>
        <summary>草案 {a.manifest.app ? `· ${a.manifest.app}` : ""}（{a.manifest.components?.length ?? 0} 个组件，{a.draft.envKeys.length} 个 env 键）</summary>
        {editing === undefined ? <pre className="json">{JSON.stringify(a.draft, null, 2)}</pre> : (
          <div className="panel">
            <textarea rows={18} value={editing} onChange={(e) => setEditing(e.target.value)} className="mono" />
            <div className="row"><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="修改原因（记入修改记录）" style={{ flex: 1 }} /><button onClick={save} disabled={reason.trim().length < 4}>保存草案</button><button className="link" onClick={() => setEditing(undefined)}>取消</button></div>
          </div>
        )}
        {canStart && editing === undefined && !["registered", "adopted", "closed"].includes(a.state) && <button className="link" onClick={() => setEditing(JSON.stringify(a.draft, null, 2))}>在页面上修改草案</button>}
      </details>
      <details>
        <summary>修改记录（{a.changes.length}）</summary>
        <table><tbody>{a.changes.map((c, i) => <tr key={i}><td className="muted">{when(c.at)}</td><td>{c.by.startsWith("agent:") ? "AI" : c.by}</td><td>{c.summary}</td><td className="muted">{c.reason}</td></tr>)}</tbody></table>
      </details>
      <details><summary>Deployer 扫描到的事实</summary><pre className="json">{JSON.stringify(a.facts, null, 2)}</pre></details>
      {a.findings && (a.findings.length ? <ul className="findings">{a.findings.map((f, i) => <li key={i} className="error">✕ {f.code} {f.at.join(".")}：{f.expected}</li>)}</ul> : <p className="ok">校验通过</p>)}
      {a.issue && (
        <div className="panel">
          <h3>Issue 草稿（{a.issue.kind === "capability" ? "Deployer 新能力" : "给仓库作者"}）：{a.issue.title}</h3>
          <pre className="report">{a.issue.body}</pre>
          {a.issue.url ? <a href={a.issue.url} target="_blank" rel="noreferrer">{a.issue.url}</a> : canStart && <button onClick={() => act(api.openIssue(id))}>在 Deployer 仓库开 Issue</button>}
        </div>
      )}
      <div className="row">
        <button onClick={() => act(api.validateDraft(id))}>校验草案</button>
        {canStart && a.kind === "onboarding" && ["ready", "trial", "failed"].includes(a.state) && (a.level === "A" || a.level === "B") && (
          <button className="primary" onClick={() => act(api.trialAssessment(id).then((r) => onJob(r.job.id)))}>在 UAT 试部署</button>
        )}
        {a.trialJob && <button className="link" onClick={() => onJob(a.trialJob!)}>试部署 {a.trialJob}</button>}
        {isAdmin && ((a.kind === "onboarding" && a.state === "trial") || (a.kind === "version" && a.state === "ready")) && (
          <button className="primary" onClick={() => act(api.registerAssessment(id))}>{a.kind === "version" ? (a.level === "unchanged" ? "确认沿用清单" : "采用新清单") : "登记应用"}</button>
        )}
        {canStart && !["registered", "adopted", "closed"].includes(a.state) && <button className="link" onClick={() => { if (confirm("关闭这个评估？试部署中的应用会从注册表移除。")) act(api.closeAssessment(id)); }}>关闭评估</button>}
      </div>
      {error && <div className="error">{error.message}{error.details.length > 0 && <ul>{error.details.map((d) => <li key={d}>{d}</li>)}</ul>}</div>}
    </section>
  );
}
