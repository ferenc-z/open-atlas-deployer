// Pieces the overview and the service page share: the light with its word (a colour is never the only signal), and the
// card's top bar colour.

import type { Light } from "./ops-page-types.ts";
import { LIGHT_LABEL } from "./FlowParts.tsx";
import "./ops.css";

/** The pill with a dot: Failing / Attention / Healthy / Unknown. */
export const LightBadge = ({ light, text }: { light: Light; text?: string }) => (
  <span className={`fl-pill big tone-${light}`}><span className="ops-dot" />{text ?? LIGHT_LABEL[light]}</span>
);

/** The big icon + word of the two cards on the service page. */
export function BigLight({ light, size }: { light: Light; size: number }) {
  const mark = light === "failing" ? <path d="M15 9l-6 6M9 9l6 6" /> : light === "healthy" ? <path d="M8 12.5l3 3 5-6" /> : light === "attention" ? <path d="M12 7v6M12 16.5v.5" /> : <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17v.5" />;
  return (
    <span className={`ops-big tone-text-${light}`}>
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" />{mark}</svg>
      <span style={{ fontSize: size >= 32 ? 30 : 26 }}>{LIGHT_LABEL[light]}</span>
    </span>
  );
}
