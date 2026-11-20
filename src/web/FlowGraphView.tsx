// The flow diagram (prototype README "流程图"): ELK lays the FlowGraph out left to right; a service is a light-blue
// shaded area, a process group a white box, anything outside NiFi a grey dashed box; S2S is a blue arrow, failure and retry
// amber, lost data a red dashed line; a group with a problem has a red box. It keeps its natural size inside a box that
// scrolls sideways only (the height follows the diagram).

import { useEffect, useId, useMemo, useState } from "react";
import type { FlowGraph, Light } from "../server/services/ops-types.ts";
import { EDGE_STYLE, type EdgeKind, type Laid } from "./flowgraph.ts";
import { layoutFlow } from "./flowlayout.ts";
import "./flows.css";

const LIGHT_WORD: Record<Light, string> = { failing: "Failing", attention: "Attention", healthy: "Healthy", unknown: "Unknown" };
const LIGHT_COLOR: Record<Light, string> = { failing: "#B3261E", attention: "#8A5300", healthy: "#1E6B34", unknown: "#4F4F4B" };
const EDGE_WORDS: Record<EdgeKind, string> = { data: "to", s2s: "over site-to-site to", failure: "on failure to", retry: "on retry back to", drop: "when it fails, data is dropped at" };

export function FlowGraphView({ graph }: { graph: FlowGraph }) {
  const key = useMemo(() => JSON.stringify(graph), [graph]);
  const [laid, setLaid] = useState<Laid | undefined>();
  const [error, setError] = useState("");
  const uid = useId().replace(/:/g, "");
  useEffect(() => {
    let live = true;
    layoutFlow(JSON.parse(key) as FlowGraph).then((l) => { if (live) { setLaid(l); setError(""); } }, (e: Error) => { if (live) setError(e.message || "The diagram could not be laid out"); });
    return () => { live = false; };
  }, [key]);
  if (error) return <p className="fl-error">{error}</p>;
  if (!laid) return <p className="fl-muted">Drawing the diagram…</p>;
  const names = new Map(laid.nodes.map((n) => [n.id, n.label]));
  const colors = [...new Set(laid.edges.map((e) => EDGE_STYLE[e.kind].color))];
  return (
    <div className="fl-scroll" tabIndex={0} role="group" aria-label="Flow diagram, scrollable">
      <div style={{ width: laid.width }}>
        <div className="fl-diagram" style={{ width: laid.width, height: laid.height }}>
          {laid.services.map((s) => (
            <div key={s.id}>
              <div className="fl-svcbox" style={{ left: s.x, top: s.y, width: s.width, height: s.height }} />
              <div className="fl-svclabel" style={{ left: s.x + 12, top: s.y + 6 }}>{s.label}</div>
            </div>
          ))}
          <svg width={laid.width} height={laid.height} fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <defs>
              {colors.map((c) => (
                <marker key={c} id={`${uid}-${c.slice(1)}`} orient="auto" markerWidth="6" markerHeight="6" refX="5" refY="3" markerUnits="userSpaceOnUse">
                  <path d="M0 0 L6 3 L0 6 Z" fill={c} stroke="none" />
                </marker>
              ))}
            </defs>
            {laid.edges.map((e) => {
              const st = EDGE_STYLE[e.kind];
              return (
                <path key={e.id} d={e.path} stroke={st.color} {...(st.dash ? { strokeDasharray: st.dash } : {})} markerEnd={`url(#${uid}-${st.color.slice(1)})`} role="img" aria-label={`From ${names.get(e.from)} ${EDGE_WORDS[e.kind]} ${names.get(e.to)}`} />
              );
            })}
          </svg>
          {laid.nodes.map((n) => {
            const cls = ["fl-node", n.kind === "external" ? (n.dropTarget ? "drop" : "external") : "", n.kind === "group" && n.light && n.light !== "unknown" ? n.light : ""].filter(Boolean).join(" ");
            return (
              <div key={n.id} className={cls} style={{ left: n.x, top: n.y, width: n.width, height: n.height }}>
                <span>
                  <b>{n.label}</b>
                  {n.detail && <span><br />{n.detail}</span>}
                  {n.kind === "group" && n.light && <><br /><b style={{ color: LIGHT_COLOR[n.light] }}>{LIGHT_WORD[n.light]}</b></>}
                </span>
              </div>
            );
          })}
          {laid.edges.map((e) => e.label && (
            <div key={`l${e.id}`} className="fl-edgelabel" style={{ left: e.label.x, top: e.label.y, minWidth: e.label.width, color: EDGE_STYLE[e.kind].color, fontWeight: e.kind === "s2s" ? 600 : 400 }}>{e.label.text}</div>
          ))}
        </div>
      </div>
    </div>
  );
}
