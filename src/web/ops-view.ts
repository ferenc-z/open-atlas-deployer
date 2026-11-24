// Pure helpers of the overview and service page (kept apart from the components so they can be tested).

import { LIGHT_ORDER } from "../server/services/ops-types.ts";
import type { AnalysisTrigger, ConfigChange, Light, ServiceCard, ServicesOverview, TodoAction } from "../server/services/ops-types.ts";

/** The worse of two lights. */
export const worstLight = (a: Light, b: Light): Light => (LIGHT_ORDER[a] <= LIGHT_ORDER[b] ? a : b);

/** A card's light (S39: the machine's only; business health lives on the Businesses page): it colours the bar on the card's top. */
export const cardLight = (c: ServiceCard): Light => c.machine.light;

/** What waits for the person on one card: the open to-dos (the machine's). */
export function nextLine(c: ServiceCard): string | null {
  if (c.todoCount > 0) return `${c.todoCount} ${c.todoCount === 1 ? "thing" : "things"} for you${c.aiHasPlan ? " · AI has a plan" : ""}`;
  return null;
}

/** The heading's counts: services by their machine light, and what waits for the person. */
export function summaryParts(cards: ServiceCard[]): { failing: number; attention: number; waiting: number } {
  let failing = 0, attention = 0, waiting = 0;
  for (const c of cards) {
    const l = cardLight(c);
    if (l === "failing") failing++;
    else if (l === "attention") attention++;
    waiting += c.todoCount;
  }
  return { failing, attention, waiting };
}

/** The card's bottom line: how many registered businesses run on the service and how many of them have a problem. */
export function businessesLine(c: ServiceCard): string {
  const count = c.businesses?.count ?? c.business.flowCount;
  if (count === 0) return "No businesses registered here";
  const noun = `${count} ${count === 1 ? "business runs" : "businesses run"} here`;
  if (c.businesses) {
    const problems = [c.businesses.failing > 0 ? `${c.businesses.failing} failing` : "", c.businesses.attention > 0 ? `${c.businesses.attention} attention` : ""].filter(Boolean);
    return problems.length ? `${noun} · ${problems.join(", ")}` : `${noun} · ${count === 1 ? "healthy" : "all healthy"}`;
  }
  // No counts from the server: only the worst light is known.
  return c.business.light === "failing" ? `${noun} · some failing` : c.business.light === "attention" ? `${noun} · some need attention` : noun;
}

/** Why an analysis was made, for the line under "AI analysis". */
export const TRIGGER_TEXT: Record<AnalysisTrigger, string> = {
  schedule: "the scheduled check-up",
  "machine-red": "the machine light turning red",
  "user-visit": "you opening this page",
  "check-now": "Check now",
  "flows-feedback": "your feedback on the flows",
};

/** The overview's check-up line (prototype "AI check-up 10:00 · next 14:00"); without a schedule, why it ran. */
export function checkupLine(o: Pick<ServicesOverview, "lastCheckup" | "running" | "services">): string {
  const last = o.lastCheckup;
  if (o.running || last?.state === "running") return "AI check-up running…";
  if (!last) return "No AI check-up yet";
  const next = o.services.find((s) => s.nextCheckAt)?.nextCheckAt;
  return `AI check-up ${clock(last.at)}${last.state === "failed" ? " (failed)" : ""} · ${next ? `next ${clock(next)}` : TRIGGER_TEXT[last.trigger]}`;
}

/** The button of a to-do's one action: Apply the AI's change is fixed text (the prototype); the rest use the AI's own label. */
export function actionLabel(a: TodoAction): string {
  if (a.kind === "config-change") return "Apply the AI's change";
  if (a.kind === "confirm-flows") return a.label || "Confirm the flows";
  if (a.kind === "open-nifi") return a.label || "Open in NiFi";
  if (a.kind === "member-control") return a.label || `${a.action[0]!.toUpperCase()}${a.action.slice(1)} ${a.member}`;
  return a.label;
}

/** A configuration change as the dialog's row: the setting, where it is, and what it becomes. */
export function changeRow(change: ConfigChange): { setting: string; file: string; to: string; now?: string } {
  const file = typeof change.file === "string" ? change.file : "";
  const key = typeof change.key === "string" ? change.key : "";
  const now = typeof change.current === "string" && change.current ? { now: change.current } : {};
  if (change.unset === true) return { setting: key || file, file, to: "(removed)", ...now };
  if (typeof change.value === "string" || typeof change.value === "number" || typeof change.value === "boolean") return { setting: key, file, to: String(change.value), ...now };
  return { setting: key || file || "File", file, to: "(file edited)", ...now };
}

/** "10:14" from an ISO time, in the browser's zone. */
export function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
