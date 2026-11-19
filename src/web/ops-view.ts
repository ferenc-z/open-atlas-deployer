// Pure helpers of the overview and service page (kept apart from the components so they can be tested).

import { LIGHT_ORDER } from "../server/services/ops-types.ts";
import type { AnalysisTrigger, Light, ServiceCard, TodoAction } from "./ops-page-types.ts";

/** The worse of two lights. */
export const worstLight = (a: Light, b: Light): Light => (LIGHT_ORDER[a] <= LIGHT_ORDER[b] ? a : b);

/** A card's worst light: it colours the bar on the card's top. */
export const cardLight = (c: ServiceCard): Light => worstLight(c.machine.light, c.business.light);

/** What waits for the person on one card: the open to-dos, else the flows to confirm. */
export function nextLine(c: ServiceCard): string | null {
  if (c.todoCount > 0) return `${c.todoCount} ${c.todoCount === 1 ? "thing" : "things"} for you`;
  if (c.business.toConfirm > 0) return "Confirm the flows the AI found";
  return null;
}

/** The heading's counts: services by their worst light, and what waits for the person (a service with only flows to confirm counts one). */
export function summaryParts(cards: ServiceCard[]): { failing: number; attention: number; waiting: number } {
  let failing = 0, attention = 0, waiting = 0;
  for (const c of cards) {
    const l = cardLight(c);
    if (l === "failing") failing++;
    else if (l === "attention") attention++;
    waiting += c.todoCount + (c.todoCount === 0 && c.business.toConfirm > 0 ? 1 : 0);
  }
  return { failing, attention, waiting };
}

/** "Business · 3 flows" (or "to confirm" when none is confirmed yet). */
export const businessLabel = (c: ServiceCard): string => (c.business.flowCount > 0 ? `Business · ${c.business.flowCount} ${c.business.flowCount === 1 ? "flow" : "flows"}` : c.business.toConfirm > 0 ? "Business · to confirm" : "Business");

/** Why an analysis was made, for the line under "AI analysis". */
export const TRIGGER_TEXT: Record<AnalysisTrigger, string> = {
  schedule: "the scheduled check-up",
  "machine-red": "the machine light turning red",
  "user-visit": "you opening this page",
  "check-now": "a Check now",
  "flows-feedback": "your feedback on the flows",
};

/** The button of a to-do's one action: Apply the AI's change is fixed text (the prototype); the rest use the AI's own label. */
export function actionLabel(a: TodoAction): string {
  if (a.kind === "config-change") return "Apply the AI's change";
  if (a.kind === "confirm-flows") return a.label || "Confirm the flows";
  if (a.kind === "open-nifi") return a.label || "Open in NiFi";
  if (a.kind === "member-control") return a.label || `${a.action[0]!.toUpperCase()}${a.action.slice(1)} ${a.member}`;
  return a.label;
}

/** A configuration change as the dialog's row: the setting, where it is, and what it becomes. */
export function changeRow(change: Record<string, unknown>): { setting: string; file: string; to: string } {
  const file = typeof change.file === "string" ? change.file : "";
  const key = typeof change.key === "string" ? change.key : "";
  if (change.unset === true) return { setting: key || file, file, to: "(removed)" };
  if (typeof change.value === "string" || typeof change.value === "number" || typeof change.value === "boolean") return { setting: key, file, to: String(change.value) };
  return { setting: key || file || "File", file, to: "(file edited)" };
}

/** "10:14" from an ISO time, in the browser's zone. */
export function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
