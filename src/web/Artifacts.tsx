// Phase 4 page (design §6.1): every image this environment built or ran, by digest — where it came from,
// its BUILD.json, and each deploy that used it.

import { useEffect, useState } from "react";
import * as api from "./api.ts";
import type { ArtifactView } from "./api.ts";
import { BASIS, JobState } from "./Deploy.tsx";

const when = (iso: string) => new Date(iso).toLocaleString("zh-CN", { hour12: false });
const ORIGIN: Record<string, string> = { build: "本环境构建", pulled: "按 tag 拉取", uat: "取自 UAT 的 digest", pinned: "按 digest 回到旧版" };

export function Artifacts() {
  const [list, setList] = useState<ArtifactView[] | undefined>();
  const [app, setApp] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { api.artifacts().then((d) => setList(d.artifacts), (e: Error) => setError(e.message)); }, []);
  if (error) return <p className="error">{error}</p>;
  if (!list) return <p className="muted">正在读取…</p>;
  const apps = [...new Set(list.map((a) => a.app))].sort();
  const shown = app ? list.filter((a) => a.app === app) : list;
  return (
    <>
      <div className="toolbar">
        <h1>制品</h1>
        <select value={app} onChange={(e) => setApp(e.target.value)}>
          <option value="">全部应用</option>
          {apps.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <span className="muted">制品不可变：应用@版本 + 服务 + digest。一次构建，多次部署：PROD 部署的就是 UAT 验证过的那个 digest。</span>
      </div>
      <table>
        <thead><tr><th>应用</th><th>版本</th><th>服务</th><th>镜像</th><th>来源</th><th>BUILD.json</th><th>部署</th></tr></thead>
        <tbody>
          {shown.map((a) => (
            <tr key={`${a.app}-${a.service}-${a.digest}`}>
              <td>{a.app}</td>
              <td className="mono">{a.version}</td>
              <td className="mono">{a.service}</td>
              <td className="mono value" title={`${a.ref}@${a.digest}`}>{a.ref}<div className="muted">{a.digest.slice(0, 19)}…</div></td>
              <td>{ORIGIN[a.origin] ?? a.origin}<div className="muted">{when(a.seenAt)}</div></td>
              <td className="mono">{a.build ? <span title={JSON.stringify(a.build)}>{String(a.build.version ?? "")} {String(a.build.commit ?? "").slice(0, 10)}</span> : <span className="muted">—</span>}</td>
              <td>
                {a.deployments.length ? a.deployments.map((d) => (
                  <div key={d.id}><JobState state={d.state} /> <span className="muted">{d.environment.toUpperCase()} {when(d.at)} {d.by}{d.promotion ? ` · ${BASIS[d.promotion] ?? d.promotion}` : ""}</span></div>
                )) : <span className="muted">还没部署过</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {shown.length === 0 && <p className="muted">还没有制品：构建或部署一次之后出现在这里。</p>}
    </>
  );
}
