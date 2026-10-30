// Phase 8 on the home page: the daily brief (D25: shown only here, never pushed) and drift (§7.1: shown, never
// changed back).

import { useEffect, useState } from "react";
import * as api from "./api.ts";
import type { BriefView, DriftView } from "./api.ts";

const KIND: Record<string, string> = { version: "版本", fragment: "compose 片段", env: "环境变量文件" };
const when = (iso: string) => new Date(iso).toLocaleString("zh-CN", { hour12: false });

export function DriftBanner() {
  const [drift, setDrift] = useState<DriftView[]>([]);
  useEffect(() => { api.drift().then((r) => setDrift(r.drift), () => setDrift([])); }, []);
  if (!drift.length) return null;
  return (
    <div className="banner warn">
      <strong>发现漂移：服务器上的实际情况和 Deployer 记录的不一样（不会自动改回）</strong>
      <ul>{drift.map((d) => <li key={d.key}>{d.app} · {KIND[d.kind] ?? d.kind}：{d.detail} <span className="muted">（{when(d.firstSeen)} 起）</span></li>)}</ul>
    </div>
  );
}

export function BriefCard({ canRegenerate }: { canRegenerate: boolean }) {
  const [brief, setBrief] = useState<BriefView | null | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = () => api.brief().then((r) => setBrief(r.brief), () => setBrief(null));
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, []);
  if (brief === undefined) return null;
  const regenerate = () => { setBusy(true); setError(""); api.regenerateBrief().then((r) => { setBrief(r.brief); setBusy(false); }, (e: Error) => { setError(e.message); setBusy(false); }); };
  const f = brief?.facts;
  return (
    <section className="card panel brief">
      <div className="toolbar">
        <h2>今日简报{brief ? ` · ${brief.date}` : ""}</h2>
        {brief?.state === "writing" && <span className="badge info">AI 正在写</span>}
        {canRegenerate && <button className="link" onClick={regenerate} disabled={busy}>{busy ? "正在生成…" : "重新生成"}</button>}
      </div>
      {!brief && <p className="muted">今天的简报还没有生成。</p>}
      {brief?.text && <pre className="report">{brief.text}</pre>}
      {brief?.message && <p className="muted">{brief.message}</p>}
      {f && !brief?.text && (
        <ul>
          {f.apps.filter((a) => a.newer.length).map((a) => <li key={a.app}>{a.app}：现在 {a.desired ?? "—"}，有新版本 {a.newer.join("、")}</li>)}
          {f.apps.filter((a) => a.versionsError).map((a) => <li key={`e-${a.app}`} className="muted">{a.app}：读不到版本列表（{a.versionsError}），不知道有没有新版本</li>)}
          {f.promotable.map((p) => <li key={`p-${p.app}`}>{p.app}：UAT 已跑 {p.uat}，这里是 {p.here ?? "—"}</li>)}
          {f.drift.map((d) => <li key={`d-${d.app}-${d.kind}`}>漂移 · {d.app}：{d.detail}</li>)}
          {f.failed.map((j) => <li key={j.job}>失败 · {j.app} {j.version}：{j.diagnosis ?? j.message ?? j.state}</li>)}
          {f.waiting.map((w) => <li key={`w-${w.job}`}>等人处理 · {w.app} {w.version}：{w.step}</li>)}
          {!f.apps.some((a) => a.newer.length || a.versionsError) && !f.promotable.length && !f.drift.length && !f.failed.length && !f.waiting.length && <li className="muted">没有新版本、漂移或失败的部署。</li>}
        </ul>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
