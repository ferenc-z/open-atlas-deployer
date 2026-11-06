// Light SVG charts for the service pages (§15.3: no chart library): a line chart with one line per node, a shared
// time axis, a crosshair with a tooltip; and a sparkline for the list cards. Colors are the --series-N tokens.

import { useEffect, useRef, useState, type MouseEvent, type RefObject } from "react";
import { fmtUnit } from "./svc.tsx";

export interface Series { name: string; at: number[]; values: (number | null)[] }

export const seriesColor = (i: number) => `var(--series-${(i % 4) + 1})`;

function useWidth(): [RefObject<HTMLElement>, number] {
  const ref = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    if (!ref.current) return;
    const o = new ResizeObserver(([e]) => { if (e) setWidth(Math.max(200, Math.floor(e.contentRect.width))); });
    o.observe(ref.current);
    return () => o.disconnect();
  }, []);
  return [ref, width];
}

const timeLabel = (ms: number, span: number) => {
  const d = new Date(ms);
  return span > 2 * 86_400_000 ? d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : span > 86_400_000 ? d.toLocaleString("en-US", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false })
      : d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
};

/** A nice upper bound for the axis. */
const niceMax = (v: number) => {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 2.5, 5, 10].find((m) => m * p >= v) ?? 10) * p;
};

export function LineChart({ title, unit, series, from, to, max, note }: { title: string; unit: string; series: Series[]; from: number; to: number; max?: number; note?: string }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const height = 150, left = 56, right = 10, top = 8, bottom = 22;
  const plotW = width - left - right, plotH = height - top - bottom;
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const yMax = max ?? Math.max(unit === "bytes" ? 1024 : unit === "count" ? 2 : 1, niceMax(Math.max(0, ...all) * 1.1));
  const x = (t: number) => left + ((t - from) / Math.max(1, to - from)) * plotW;
  const y = (v: number) => top + plotH - (Math.min(v, yMax) / yMax) * plotH;
  const path = (s: Series) => {
    let d = "", pen = false;
    s.values.forEach((v, i) => {
      if (v === null) { pen = false; return; }
      d += `${pen ? "L" : "M"}${x(s.at[i]!).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const move = (e: MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    setHover(px < left || px > width - right ? null : from + ((px - left) / plotW) * (to - from));
  };
  // At the crosshair: each series' nearest point (within 3 % of the range).
  const near = hover === null ? [] : series.map((s, i) => {
    let best = -1;
    s.at.forEach((t, j) => { if (s.values[j] !== null && (best < 0 || Math.abs(t - hover) < Math.abs(s.at[best]! - hover))) best = j; });
    return best >= 0 && Math.abs(s.at[best]! - hover) <= (to - from) * 0.03 ? { i, name: s.name, t: s.at[best]!, v: s.values[best]! } : null;
  }).filter((n): n is { i: number; name: string; t: number; v: number } => n !== null);
  const empty = all.length === 0;
  const last = (s: Series) => [...s.values].reverse().find((v) => v !== null) ?? null;
  return (
    <figure className="chart" ref={ref}>
      <figcaption><strong>{title}</strong> <span className="muted small">{unit === "count" ? "" : unit === "bool" ? "" : unit}</span></figcaption>
      {series.length > 1 && <ul className="chart-legend small">{series.map((s, i) => (
        <li key={s.name}><span className="swatch" style={{ background: seriesColor(i) }} />{s.name} <span className="muted">{fmtUnit(last(s), unit)}</span></li>
      ))}</ul>}
      <div className="chart-plot">
        <svg width={width} height={height} onMouseMove={move} onMouseLeave={() => setHover(null)} role="img" aria-label={`${title}, ${series.length} series`}>
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line x1={left} x2={width - right} y1={y(yMax * f)} y2={y(yMax * f)} className="chart-grid" />
              <text x={left - 6} y={y(yMax * f) + 4} textAnchor="end" className="chart-axis">{fmtUnit(yMax * f, unit === "bool" ? "count" : unit)}</text>
            </g>
          ))}
          {[from, (from + to) / 2, to].map((t, i) => <text key={i} x={x(t)} y={height - 6} textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"} className="chart-axis">{timeLabel(t, to - from)}</text>)}
          {series.map((s, i) => <path key={s.name} d={path(s)} fill="none" stroke={seriesColor(i)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />)}
          {hover !== null && near.length > 0 && <line x1={x(near[0]!.t)} x2={x(near[0]!.t)} y1={top} y2={top + plotH} className="chart-cross" />}
          {near.map((n) => <circle key={n.i} cx={x(n.t)} cy={y(n.v)} r={4} fill={seriesColor(n.i)} stroke="var(--surface)" strokeWidth={2} />)}
          {empty && <text x={left + plotW / 2} y={top + plotH / 2} textAnchor="middle" className="chart-axis">{note ?? "No data in this range"}</text>}
        </svg>
        {near.length > 0 && <div className="chart-tip small" style={{ left: Math.min(x(near[0]!.t) + 10, width - 190) }}>
          <div className="muted">{new Date(near[0]!.t).toLocaleString("en-US", { hour12: false })}</div>
          {near.map((n) => <div key={n.i}><span className="swatch" style={{ background: seriesColor(n.i) }} />{series.length > 1 ? `${n.name} ` : ""}<strong>{fmtUnit(n.v, unit)}</strong></div>)}
        </div>}
      </div>
    </figure>
  );
}

/** A small line without axes (the list cards); the title says first, last and highest. */
export function Sparkline({ label, values, unit }: { label: string; values: (number | null)[]; unit: string }) {
  const w = 96, h = 22;
  const nums = values.filter((v): v is number => v !== null);
  const top = Math.max(1e-9, ...nums);
  let d = "", pen = false;
  values.forEach((v, i) => {
    if (v === null) { pen = false; return; }
    d += `${pen ? "L" : "M"}${((i / Math.max(1, values.length - 1)) * (w - 4) + 2).toFixed(1)},${(h - 2 - (v / top) * (h - 4)).toFixed(1)}`;
    pen = true;
  });
  const last = nums[nums.length - 1];
  return (
    <span className="spark small" title={nums.length ? `${label}, last hour: now ${fmtUnit(last, unit)}, highest ${fmtUnit(Math.max(...nums), unit)}` : `${label}: no samples in the last hour`}>
      <span className="muted">{label}</span>
      <svg width={w} height={h} aria-hidden="true">{nums.length > 0 && <path d={d} fill="none" stroke="var(--series-1)" strokeWidth={1.5} strokeLinejoin="round" />}</svg>
      <span className="mono">{fmtUnit(last, unit)}</span>
    </span>
  );
}
