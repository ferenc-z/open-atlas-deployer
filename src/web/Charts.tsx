// A sparkline for the service list cards (no chart library). Colors are the --series-N tokens.
import { fmtUnit } from "./svc.tsx";
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
