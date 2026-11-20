// The OMA session code kept from the removed cases for step 5's analyses (oma-turn.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { OmaEvent } from "../src/server/oma.ts";
import { fitEvidence, openTurn, pollTurn, turnOutcome } from "../src/server/services/oma-turn.ts";

const u = (t: string): OmaEvent => ({ type: "user.message", content: [{ type: "text", text: t }] });
const m = (t: string): OmaEvent => ({ type: "agent.message", content: [{ type: "text", text: t }] });

test("a turn counts only once OMA shows every question asked, and the answer after the last one", () => {
  const first = [u("q1"), m("a1"), { type: "session.status_idle" }];
  assert.deepEqual(turnOutcome(first, 1), { text: "a1", ended: true });
  assert.equal(turnOutcome(first, 2).ended, false);
  assert.equal(turnOutcome([...first, u("q2")], 2).ended, false);
  assert.deepEqual(turnOutcome([...first, u("q2"), m("a2")], 2), { text: "a2", ended: true });
  assert.equal(turnOutcome([...first, u("q2"), { type: "session.error", error: "boom" }], 2).error, '"boom"');
});

test("a session opens with the evidence redacted and cut, and a poll says running, done or failed", async () => {
  const sent: string[] = [];
  const events = new Map<string, OmaEvent[]>();
  const oma = {
    open: async (_t: string, _k: string, text: string) => { sent.push(text); events.set("s1", [u(text)]); return "s1"; },
    events: async (s: string) => events.get(s)!,
  };
  const opened = await openTurn(oma, "Analysis #1 · c250", "analysis-1", "Look at c250.", { cards: [{ text: "password=hunter2" }] });
  assert.deepEqual(opened, { session: "s1" });
  assert.ok(!sent[0]!.includes("hunter2"), "redacted");
  const t0 = "2026-11-19T10:00:00Z";
  assert.deepEqual(await pollTurn(oma, "s1", 1, t0, Date.parse(t0) + 1000), { state: "running" });
  events.get("s1")!.push(m("done"), { type: "session.status_idle" });
  assert.deepEqual(await pollTurn(oma, "s1", 1, t0, Date.parse(t0) + 1000), { state: "done", text: "done" });
  assert.equal((await pollTurn({ events: async () => [u("q")] }, "s1", 1, t0, Date.parse(t0) + 11 * 60_000)).state, "failed");
  assert.deepEqual(await openTurn({ open: async () => { throw new Error("down"); } }, "t", "k", "m"), { error: "Could not start the session: down" });
  const big = { cards: Array.from({ length: 50 }, (_, i) => ({ i, text: "x".repeat(2000) })) };
  const cut = fitEvidence(big, 20_000) as { cards: unknown[]; cut: boolean };
  assert.ok(cut.cut && cut.cards.length < 50);
});
