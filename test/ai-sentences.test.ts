// UAT feedback 2026-11-22: the sentences beside the lights are the AI's (record analysis.machineSentence, businessSentence,
// flows[].sentence) while the lights stay as they were at record; record keeps the lights at write time (so a model the
// AI published meanwhile does not make the analysis "out of date"); the flows to-do reads as one sentence; the overview's
// check-up line.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AnalysisRecord } from "../src/server/store.ts";
import { Store } from "../src/server/store.ts";
import { aiSentences, analysisView, parseRecord, record, SENTENCE_MS } from "../src/server/services/todos.ts";
import { pendingText } from "../src/server/services/flowmodel.ts";
import { checkupLine, nextLine, TRIGGER_TEXT } from "../src/web/ops-view.ts";
import type { ServiceCard } from "../src/server/services/ops-types.ts";

const T = new Date("2026-11-22T08:00:00Z");
const row = (o: Partial<AnalysisRecord> = {}): AnalysisRecord => ({
  id: 1, service: "c250", run: null, trigger: "check-now", state: "done", session: null, requestedBy: "x",
  startedAt: "2026-11-22T07:47:00Z", finishedAt: "2026-11-22T07:51:00Z", machineLight: "healthy", businessLight: "unknown",
  body: { machineSentence: "一切正常。", businessSentence: "AI 找到 2 条业务流程，等你确认。", flows: [{ flow: "flw_a", sentence: "还没有数据流过。" }, { flow: "flw_b", sentence: "没有异常。" }], flowLights: { flw_a: "unknown", flw_b: "healthy" } },
  error: null, ...o,
});

test("AI sentences: shown while each light is the one recorded; a changed light, an old or unfinished analysis falls back to the rules", () => {
  const same = aiSentences(row(), T, { machine: "healthy", business: "unknown" }, { flw_a: "unknown", flw_b: "healthy" });
  assert.deepEqual(same, { machine: "一切正常。", business: "AI 找到 2 条业务流程，等你确认。", flows: { flw_a: "还没有数据流过。", flw_b: "没有异常。" } });
  const moved = aiSentences(row(), T, { machine: "failing", business: "unknown" }, { flw_a: "unknown", flw_b: "failing" });
  assert.deepEqual(moved, { business: "AI 找到 2 条业务流程，等你确认。", flows: { flw_a: "还没有数据流过。" } });
  assert.deepEqual(aiSentences(row(), new Date(Date.parse("2026-11-22T07:51:00Z") + SENTENCE_MS + 1), { machine: "healthy", business: "unknown" }), { flows: {} });
  assert.deepEqual(aiSentences(row({ state: "running" }), T, { machine: "healthy", business: "unknown" }), { flows: {} });
  assert.deepEqual(aiSentences(row({ body: { machine: "长结论" } }), T, { machine: "healthy", business: "unknown" }), { flows: {} }, "no sentence fields: the rules'");
});

test("record: the sentences are kept; the lights are the ones at record, so the analysis is not out of date right after", () => {
  const store = new Store(":memory:", () => T);
  store.addStandalone({ kind: "standalone", id: "c250", service: "nifi", profile: "nifi-2.x", version: "2.5.0", webUrl: null, member: { host: "local", installDir: "/lab/c250", serviceUser: "ferenc", startEnvironment: null, ports: { https: 18443 }, nodeAddress: "localhost", discovery: null } } as never, "uat", { id: "admin", via: "cli" });
  const id = store.addAnalysis({ service: "c250", run: null, trigger: "check-now", state: "running", session: "s", requestedBy: "x", startedAt: "2026-11-22T07:47:00Z", finishedAt: null, machineLight: "healthy", businessLight: "attention", body: null, error: null });
  const input = parseRecord("c250", { analysisId: id, analysis: { trigger: "check-now", machine: "m", business: "b", machineSentence: " 一切正常。 ", businessSentence: "等你确认。", summary: "s", lookedAt: [] } });
  assert.equal(input.analysis?.machineSentence, "一切正常。");
  record({ store, actor: { id: "checkup", via: "service" } as never, scope: "full", lights: () => ({ machine: "healthy", business: "unknown" }), flowLights: () => ({}), now: () => T }, input);
  const a = store.analysis(id)!;
  assert.deepEqual([a.state, a.machineLight, a.businessLight], ["done", "healthy", "unknown"]);
  assert.equal(analysisView(a, T, { machine: "healthy", business: "unknown" }).stale, false);
  assert.deepEqual((a.body as { flowLights: unknown }).flowLights, {});
  assert.throws(() => parseRecord("c250", { analysis: { trigger: "check-now", machine: "m", business: "b", summary: "s", lookedAt: [], machineSentence: "长".repeat(201) } }), /record is not valid/);
});

test("the flows to-do: one sentence counting what waits, not one line per segment", () => {
  const text = pendingText([
    { flow: "flw_x", kind: "cross-service", text: "NiFi Flow 接进别的服务已有的业务，成为它的一段" },
    { flow: "new:a", kind: "new", text: "新的业务：NiFi Flow" },
    { flow: "new:b", kind: "new", text: "新的业务：ops-lab" },
  ]);
  assert.equal(text, "AI 识别出 2 条新业务（NiFi Flow、ops-lab）、1 处跨服务连接，等你在流程页确认。");
});

test("overview: the check-up line says when the next one is (else why it ran); Check now reads without an article; AI has a plan", () => {
  const card = { id: "c", nextCheckAt: "2026-11-22T12:00:00Z", todoCount: 2, aiHasPlan: true, business: { toConfirm: 0 } } as unknown as ServiceCard;
  const at = "2026-11-22T07:47:00Z";
  assert.match(checkupLine({ lastCheckup: { at, trigger: "check-now", state: "done" }, running: false, services: [card] }), /^AI check-up \d\d:47 · next \d\d:00$/);
  assert.match(checkupLine({ lastCheckup: { at, trigger: "check-now", state: "done" }, running: false, services: [] }), /^AI check-up \d\d:47 · Check now$/);
  assert.equal(checkupLine({ lastCheckup: null, running: true, services: [] }), "AI check-up running…");
  assert.equal(TRIGGER_TEXT["check-now"], "Check now");
  assert.equal(nextLine(card), "2 things for you · AI has a plan");
});
