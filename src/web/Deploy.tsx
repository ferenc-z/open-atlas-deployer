// Phase 2 pages: choose a version, read the plan, build, confirm, follow the job; the deploy history
// with "回到这一版". Phase 5: the plan lists every component in the order it runs, and a running deploy
// shows those steps, with the manual ones ticked here item by item.

import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "./api.ts";
import type { Job, JobView as JobData, Plan } from "./api.ts";
import { diffLines } from "./diff.ts";

const STEP: Record<string, string> = {
  clone: "克隆 tag", tools: "取发布工具", build: "构建并推送", "verify-build": "核对 BUILD.json",
  files: "取发布文件", pull: "拉取镜像并固定 digest", validate: "校验片段与策略", backup: "备份数据",
  switch: "切换", migrate: "数据库迁移", start: "启动", verify: "健康检查", cleanup: "清理", rollback: "回滚", "restore-data": "恢复数据",
  write: "写入 env 文件", restart: "重启用到的服务", read: "读取 env 文件",
};
const STATE: Record<string, { label: string; tone: string }> = {
  queued: { label: "排队中", tone: "muted" }, running: { label: "进行中", tone: "info" }, succeeded: { label: "成功", tone: "ok" },
  failed: { label: "失败", tone: "bad" }, "rolled-back": { label: "已回滚", tone: "warn" }, refused: { label: "被拒绝", tone: "bad" },
  done: { label: "完成", tone: "ok" }, pending: { label: "未开始", tone: "muted" }, waiting: { label: "等人确认", tone: "warn" },
  skipped: { label: "跳过", tone: "muted" },
};
const TYPE: Record<string, string> = {
  "compose-service": "容器", "db-migration": "数据库迁移", "workbench-app": "Workbench 应用包", "studio-graph": "Studio 图", "oma-agent": "OMA Agent", manual: "人工步骤",
};
const WHERE: Record<string, string> = { host: "执行器", deployer: "Deployer", person: "人" };
const FINAL = ["succeeded", "failed", "rolled-back", "refused"];
export const BASIS: Record<string, string> = { uat: "UAT 部署成功过", release: "已正式发布", "prod-history": "本环境部署成功过", override: "管理员跳过" };
export const KIND: Record<string, string> = { build: "构建", deploy: "部署", env: "写入环境变量", "env-read": "导入环境变量" };
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }) : "—");

export function JobState({ state }: { state: string }) {
  const s = STATE[state] ?? { label: state, tone: "muted" };
  return <span className={`badge ${s.tone}`}>{s.label}</span>;
}

export function DeployPanel({ app, initial, isAdmin, onClose, onJob }: { app: string; initial?: { version: string; pinFrom?: string }; isAdmin?: boolean; onClose: () => void; onJob: (id: string) => void }) {
  const [reason, setReason] = useState("");
  const [overridden, setOverridden] = useState<string | undefined>();
  const [list, setList] = useState<{ versions: string[]; error?: string; built: string[]; deployed: string | null } | undefined>();
  const [version, setVersion] = useState(initial?.version ?? "");
  const [pinFrom] = useState(initial?.pinFrom);
  const [plan, setPlan] = useState<Plan | undefined>();
  const [error, setError] = useState<{ message: string; details: string[] } | undefined>();
  const [busy, setBusy] = useState(false);
  const fail = (e: api.ApiError) => { setError({ message: e.message, details: e.details ?? [] }); setBusy(false); };

  useEffect(() => { api.versions(app).then((l) => { setList(l); if (!version) setVersion(l.versions[0] ?? ""); }, fail); }, [app]);
  const makePlan = useCallback((v = version) => {
    setError(undefined); setPlan(undefined); setOverridden(undefined);
    if (v) api.plan(app, v, pinFrom).then(setPlan, fail);
  }, [app, version, pinFrom]);
  const override = () => {
    setError(undefined);
    api.planWithOverride(app, plan!.version, reason).then((p) => { setPlan(p); setOverridden(reason); }, fail);
  };
  useEffect(() => { if (initial?.version) makePlan(initial.version); }, []);

  const start = () => {
    setBusy(true);
    (overridden ? api.deployWithOverride(app, plan!.version, true, overridden) : api.deploy(app, plan!.version, true, pinFrom)).then((r) => onJob(r.job.id), fail);
  };
  const build = () => { setBusy(true); api.build(app, plan!.version).then((r) => onJob(r.jobs[0]!.id), fail); };
  const blocking = plan?.findings.filter((f) => f.blocking) ?? [];
  const notBuilt = blocking.some((f) => f.code === "deploy/not-built") && blocking.every((f) => f.code === "deploy/not-built");
  const notPromoted = blocking.some((f) => f.code === "deploy/not-promoted");

  return (
    <section className="card panel">
      <div className="toolbar">
        <h2>{pinFrom ? `回到 ${app} ${initial?.version}` : `部署 ${app}`}</h2>
        <span className="muted">{list?.deployed ? `现在：${list.deployed}` : "还没有经 Deployer 部署过"}</span>
        <button className="link" onClick={onClose}>关闭</button>
      </div>
      {!pinFrom && (
        <div className="row">
          <input list={`versions-${app}`} value={version} onChange={(e) => setVersion(e.target.value.trim())} placeholder="版本，如 2.8.0" />
          <datalist id={`versions-${app}`}>
            {(list?.versions ?? []).map((v) => <option key={v} value={v}>{list?.built.includes(v) ? "已构建" : ""}{list?.deployed === v ? " · 运行中" : ""}</option>)}
          </datalist>
          <button onClick={() => makePlan()} disabled={!version}>生成计划</button>
          {list?.error && <span className="muted">{list.error}，可以直接输入版本号</span>}
        </div>
      )}
      {plan && (
        <div className="plan">
          {plan.findings.length > 0 && (
            <ul className="findings">
              {plan.findings.map((f) => <li key={f.code + f.message} className={f.blocking ? "error" : "muted"}>{f.blocking ? "✕ " : "• "}{f.message}</li>)}
            </ul>
          )}
          {plan.promotion && <p className={plan.promotion.basis === "override" ? "error" : ""}><span className="badge info">晋级依据：{BASIS[plan.promotion.basis]}</span> {plan.promotion.basis === "override" ? `原因：${plan.promotion.reason}` : plan.promotion.detail}</p>}
          {notPromoted && isAdmin && (
            <div className="row override">
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="跳过晋级规则的原因（记入审计，部署记录上会标出）" />
              <button className="danger" onClick={override} disabled={reason.trim().length < 4}>跳过晋级规则</button>
            </div>
          )}
          <table>
            <thead><tr><th>#</th><th>组件</th><th>由谁做</th><th>现在</th><th>部署后</th><th>影响</th></tr></thead>
            <tbody>
              {plan.steps.map((s, i) => (
                <tr key={s.component}>
                  <td className="muted">{i + 1}</td>
                  <td><span className="mono">{s.component}</span> <span className="muted">{TYPE[s.type] ?? s.type}</span></td>
                  <td>{WHERE[s.where]}</td>
                  <td className="mono muted">{s.before ?? "—"}</td>
                  <td className="mono">{s.after}{s.checks && <ol>{s.checks.map((c) => <li key={c}>{c}</li>)}</ol>}</td>
                  <td className="muted">{s.impact}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">清单 {plan.manifest}{plan.bundle ? `；发布包 ${plan.bundle.asset}（${plan.bundle.digest.slice(0, 19)}…）` : ""}。按顺序执行：执行器的部分先拉取镜像并固定 digest、校验片段、备份数据、切换、启动、等健康检查，失败自动回到上一版；之后 Deployer 依次调用 Workbench、Studio、OMA，某一步失败就撤回它之前的这些步骤；人工步骤处暂停，逐项勾选后继续。</p>
          {plan.fragment && (
            <details>
              <summary>compose 片段的变化</summary>
              <pre className="diff">{diffLines(plan.previousFragment ?? "", plan.fragment).map((l, i) => <div key={i} className={l.kind}>{l.kind === "add" ? "+ " : l.kind === "del" ? "- " : "  "}{l.text}</div>)}</pre>
            </details>
          )}
          <div className="row">
            {notBuilt && <button onClick={build} disabled={busy}>构建 {plan.version}</button>}
            <button className="primary" onClick={start} disabled={busy || blocking.length > 0}>确认部署 {plan.version}</button>
          </div>
        </div>
      )}
      {error && <div className="error">{error.message}{error.details.length > 0 && <ul>{error.details.map((d) => <li key={d}>{d}</li>)}</ul>}</div>}
    </section>
  );
}

export function JobPanel({ id, onClose, onBack }: { id: string; onClose: () => void; onBack?: (job: JobData["job"]) => void }) {
  const [data, setData] = useState<JobData | undefined>();
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    let stop = false;
    const tick = () => api.job(id).then((d) => {
      if (stop) return;
      setData(d);
      if (!FINAL.includes(d.job.state)) setTimeout(tick, 2_000);
    }, (e: Error) => setError(e.message));
    tick();
    return () => { stop = true; };
  }, [id]);
  const reload = () => api.job(id).then(setData, (e: Error) => setError(e.message));
  const tickItem = (component: string, index: number, checked: boolean) => {
    setActionError("");
    api.check(id, component, index, checked).then(reload, (e: Error) => setActionError(e.message));
  };
  const stopHere = () => {
    if (!confirm("在这个人工步骤处停止部署？已完成的步骤保留，部署记为失败。")) return;
    api.stopJob(id).then(reload, (e: Error) => setActionError(e.message));
  };
  useEffect(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight); }, [data?.log]);

  if (error) return <section className="card panel"><p className="error">{error}</p></section>;
  if (!data) return <section className="card panel"><p className="muted">正在读取…</p></section>;
  const { job } = data;
  return (
    <section className="card panel">
      <div className="toolbar">
        <h2>{KIND[job.kind] ?? job.kind} {job.app} {job.kind === "env-read" ? "" : job.version}</h2>
        <JobState state={job.state} />
        <span className="muted">{job.requestedBy} · {when(job.requestedAt)}{job.pinFrom ? ` · 回到 ${job.pinFrom}` : ""}</span>
        {onBack && job.kind === "deploy" && job.state === "succeeded" && <button onClick={() => onBack(job)}>回到这一版</button>}
        <button className="link" onClick={onClose}>关闭</button>
      </div>
      {job.message && <p className={job.state === "succeeded" ? "" : "error"}>{job.message}</p>}
      {data.promotion && <p><span className={`badge ${data.promotion.basis === "override" ? "warn" : "info"}`}>晋级依据：{BASIS[data.promotion.basis]}</span> <span className="muted">{data.promotion.basis === "override" ? `${data.promotion.by}：${data.promotion.reason}` : data.promotion.detail}</span></p>}
      {job.state === "queued" && job.rollout?.host !== "none" && <p className="muted">等执行器领取…</p>}
      {job.rollout && (
        <table className="rollout">
          <thead><tr><th>#</th><th>组件</th><th>由谁做</th><th>状态</th><th>结果</th></tr></thead>
          <tbody>
            {job.rollout.steps.map((s, i) => (
              <tr key={s.component}>
                <td className="muted">{i + 1}</td>
                <td><span className="mono">{s.component}</span> <span className="muted">{TYPE[s.type] ?? s.type}</span></td>
                <td>{WHERE[s.where]}</td>
                <td><JobState state={s.state} /></td>
                <td>
                  {s.message && <div className={s.state === "failed" ? "error" : ""}>{s.message}</div>}
                  {s.checks && (
                    <ul className="checks">
                      {s.checks.map((c, n) => (
                        <li key={n}>
                          <label>
                            <input type="checkbox" checked={Boolean(c.by)} disabled={s.state !== "waiting"} onChange={(e) => tickItem(s.component, n, e.target.checked)} /> {c.text}
                          </label>
                          {c.by && <span className="muted"> · {c.by} {when(c.at)}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                  {s.state === "waiting" && <button className="link" onClick={stopHere}>在这里停止部署</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {actionError && <p className="error">{actionError}</p>}
      <ol className="steps">
        {(job.status?.steps ?? []).map((s, i) => (
          <li key={i}><JobState state={s.state} /> {STEP[s.name] ?? s.name}<span className="muted"> {when(s.at)}</span>{s.message && <div className="error">{s.message}</div>}</li>
        ))}
      </ol>
      {data.record && job.state !== "queued" && (
        <details>
          <summary>部署记录（deployment-receipt 字段）</summary>
          <pre className="json">{JSON.stringify(data.record, null, 2)}</pre>
        </details>
      )}
      {job.rollout?.host !== "none" && (
        <details open={!FINAL.includes(job.state) && job.rollout?.host !== "done"}>
          <summary>执行器日志</summary>
          <pre className="log" ref={logRef}>{data.log || "（还没有日志）"}</pre>
        </details>
      )}
      {(job.rollout?.log.length ?? 0) > 0 && (
        <details open={!FINAL.includes(job.state) && job.rollout?.host !== "pending"}>
          <summary>Deployer 步骤日志</summary>
          <pre className="log">{job.rollout!.log.join("\n")}</pre>
        </details>
      )}
    </section>
  );
}

export function History({ onBack }: { onBack: (job: { app: string; version: string; id: string }) => void }) {
  const [list, setList] = useState<Omit<Job, "request">[] | undefined>();
  const [open, setOpen] = useState<string | undefined>();
  const [error, setError] = useState("");
  const refresh = useCallback(() => { api.jobs().then((d) => setList(d.jobs), (e: Error) => setError(e.message)); }, []);
  useEffect(() => { refresh(); const t = setInterval(refresh, 5_000); return () => clearInterval(t); }, [refresh]);
  if (error) return <p className="error">{error}</p>;
  if (!list) return <p className="muted">正在读取…</p>;
  return (
    <>
      <div className="toolbar"><h1>部署记录</h1><span className="muted">构建、部署与环境变量写入，最近 50 条</span></div>
      {open && <JobPanel id={open} onClose={() => setOpen(undefined)} onBack={(j) => onBack({ app: j.app, version: j.version, id: j.id })} />}
      <table>
        <thead><tr><th>时间</th><th>任务</th><th>应用</th><th>版本</th><th>谁</th><th>结果</th><th>说明</th></tr></thead>
        <tbody>
          {list.map((j) => (
            <tr key={j.id} className="app" onClick={() => setOpen(j.id)}>
              <td className="muted">{when(j.requestedAt)}</td>
              <td>{j.pinFrom ? "回到旧版" : KIND[j.kind] ?? j.kind}</td>
              <td>{j.app}</td>
              <td className="mono">{j.fromVersion && j.kind !== "build" ? `${j.fromVersion} → ` : ""}{j.kind === "env-read" ? "" : j.version}</td>
              <td>{j.requestedBy}</td>
              <td><JobState state={j.state} /></td>
              <td className="muted clip">{j.message ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
