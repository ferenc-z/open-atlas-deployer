// Opening a background OMA session and waiting for its answer, kept from the removed cases (pages-rethink §10.2.4:
// "Analyst 里开 OMA 会话、等结果的代码搬给第 5 步的分析触发用"). Step 5 opens an analysis session with this (the
// Deployer gives the analysis id in the first message; the Agent writes back with record), then polls until the turn ends.

import type { OmaEvent, OmaSessions } from "../oma.ts";
import { redactStrings } from "./redact.ts";

/** How long one turn may take before it counts as failed. */
export const TURN_TIMEOUT_MS = 10 * 60_000;
const MAX_EVIDENCE = 60_000;

/** Cuts evidence to the message's size: whole cards or traces are dropped from the end, the rest is said. */
export function fitEvidence(evidence: unknown, max = MAX_EVIDENCE): unknown {
  let text = JSON.stringify(evidence);
  if (text.length <= max) return evidence;
  const e = { ...(evidence as Record<string, any>) };
  for (const list of ["cards", "traces"]) {
    const inner = e.investigation && typeof e.investigation === "object" && list in e.investigation ? (e.investigation = { ...e.investigation }) : e;
    while (Array.isArray(inner[list]) && inner[list].length > 1 && (text = JSON.stringify(e)).length > max) inner[list] = inner[list].slice(0, -1);
  }
  text = JSON.stringify(e);
  return text.length <= max ? { ...e, cut: true } : { cut: true, text: text.slice(0, max) };
}

/** Where the session's newest turn stands: OMA must show `asked` person messages, then an answer after the last one. */
export function turnOutcome(events: OmaEvent[], asked: number): { error?: string; text?: string; ended: boolean } {
  const users = events.map((e, i) => (e.type === "user.message" ? i : -1)).filter((i) => i >= 0);
  if (users.length < asked) return { ended: false };
  const after = events.slice((users.at(-1) ?? -1) + 1);
  const error = after.find((e) => e.type === "session.error" || (e.type === "agent.message_stream_end" && e.status && e.status !== "completed"));
  if (error) return { error: JSON.stringify(error.error ?? error.status), ended: true };
  const last = [...after].reverse().find((e) => e.type === "agent.message");
  if (!last) return { ended: false };
  const end = events.at(-1);
  const ended = end === last || end?.type === "session.status_idle" || end?.type === "agent.message_stream_end";
  return { text: (last.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n"), ended };
}

/** Opens a session with a first message (the evidence redacted and cut); its id, or the error that kept it from opening. */
export async function openTurn(oma: Pick<OmaSessions, "open">, title: string, key: string, message: string, evidence?: unknown): Promise<{ session: string } | { error: string }> {
  const text = evidence === undefined ? message : [message, "```json", JSON.stringify(fitEvidence(redactStrings(evidence)), null, 1), "```"].join("\n");
  try { return { session: await oma.open(title.slice(0, 200), key, text) }; } catch (error) { return { error: `Could not start the session: ${(error as Error).message}` }; }
}

/** One look at a running turn: done (with the answer's text), failed, or still running; late after timeoutMs. */
export async function pollTurn(oma: Pick<OmaSessions, "events">, session: string, asked: number, startedAt: string, now = Date.now(), timeoutMs = TURN_TIMEOUT_MS): Promise<{ state: "running" } | { state: "done"; text: string } | { state: "failed"; error: string }> {
  const late = now - Date.parse(startedAt) > timeoutMs;
  try {
    const o = turnOutcome(await oma.events(session), asked);
    if (o.error) return { state: "failed", error: `OMA session error: ${o.error}` };
    if (o.ended && o.text !== undefined) return { state: "done", text: o.text };
  } catch (error) {
    if (late) return { state: "failed", error: (error as Error).message };
  }
  return late ? { state: "failed", error: `No answer after ${Math.round(timeoutMs / 60_000)} minutes` } : { state: "running" };
}
