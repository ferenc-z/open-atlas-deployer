// Step 6a: the overview and service page's calls (routes), the sample data's behaviour, and the pure helpers (counts, labels, rows).
import assert from "node:assert/strict";
import { test } from "node:test";
import { contextPage, SUGGESTIONS } from "../src/web/ask-ai.ts";
import { makeOpsClient } from "../src/web/ops-client.ts";
import { makeMockOpsClient, sortCards } from "../src/web/ops-mock.ts";
import { actionLabel, businessLabel, cardLight, changeRow, nextLine, summaryParts, worstLight } from "../src/web/ops-view.ts";
import type { ServiceCard } from "../src/web/ops-page-types.ts";

test("client: each call takes the route of §10.2.2", async () => {
  const seen: string[] = [];
  const ops = makeOpsClient(async (method, path, body) => { seen.push(`${method} ${path}${body === undefined ? "" : ` ${JSON.stringify(body)}`}`); return {} as never; });
  await ops.overview();
  await ops.page("c250 prod");
  await ops.checkService("c250");
  await ops.checkAll();
  await ops.analysis(7);
  await ops.draftTodo("td_1");
  await ops.todoState("td_1", "dismissed");
  assert.deepEqual(seen, [
    "GET services/overview", "GET services/c250%20prod/page", "POST services/c250/analyses {}", "POST analyses {}", "GET analyses/7",
    "POST todos/td_1/draft {}", 'POST todos/td_1/state {"state":"dismissed"}',
  ]);
});

test("sample data: the overview is worst first and counts the to-dos", async () => {
  const ops = makeMockOpsClient();
  const o = await ops.overview();
  assert.deepEqual(o.services.map((s) => s.id), ["c250-prod", "n112-edge", "n200-test", "n192-legacy"]);
  assert.equal(o.services[0]!.todoCount, 3);
  assert.deepEqual(summaryParts(o.services), { failing: 2, attention: 1, waiting: 6 });
});

test("sample data: Check now runs a round, then the check-up time moves", async () => {
  const ops = makeMockOpsClient();
  const before = (await ops.overview()).lastCheckup!;
  await ops.checkAll();
  assert.equal((await ops.overview()).running, true);
  const after = await ops.overview();
  assert.equal(after.running, false);
  assert.notEqual(after.lastCheckup!.at, before.at);
});

test("sample data: Look again now shows a running analysis that ends when polled; a second one is refused while it runs", async () => {
  const ops = makeMockOpsClient();
  const a = await ops.checkService("c250-prod");
  assert.equal(a.state, "running");
  await assert.rejects(() => ops.checkService("c250-prod"), /already running/);
  assert.equal((await ops.page("c250-prod")).analysis?.state, "running");
  assert.equal((await ops.analysis(a.id)).state, "running");
  const done = await ops.analysis(a.id);
  assert.equal(done.state, "done");
  assert.ok(done.summary);
});

test("sample data: Apply makes the draft once, only for a configuration change; to-dos can be closed", async () => {
  const ops = makeMockOpsClient();
  const page = await ops.page("c250-prod");
  const apply = page.todos.find((t) => t.action?.kind === "config-change")!;
  const restart = page.todos.find((t) => t.action?.kind === "member-control")!;
  const first = await ops.draftTodo(apply.id);
  assert.equal(first.service, "c250-prod");
  assert.equal((await ops.draftTodo(apply.id)).draft, first.draft);
  assert.equal((await ops.page("c250-prod")).todos.find((t) => t.id === apply.id)?.draft, first.draft);
  await assert.rejects(() => ops.draftTodo(restart.id), /no configuration change/);
  await ops.todoState(restart.id, "done");
  assert.equal((await ops.page("c250-prod")).todos.length, 2);
  assert.equal((await ops.overview()).services.find((s) => s.id === "c250-prod")!.todoCount, 2);
});

test("sample data: every service has a page, with the six checks of §10.2.1", async () => {
  const ops = makeMockOpsClient();
  for (const id of ["c250-prod", "n112-edge", "n200-test", "n192-legacy"]) {
    const p = await ops.page(id);
    assert.deepEqual(p.machine.checks.map((c) => c.check).sort(), ["certificate", "collection", "coordinator", "disk", "heap", "process"]);
  }
  await assert.rejects(() => ops.page("nope"), /No service/);
});

const card = (over: Partial<ServiceCard> & { m?: ServiceCard["machine"]["light"]; b?: ServiceCard["business"]["light"] }): ServiceCard => ({
  id: "x", kind: "standalone", environment: "uat", label: "NiFi",
  machine: { light: over.m ?? "healthy", sentence: "" },
  business: { light: over.b ?? "healthy", sentence: "", flowCount: 2, toConfirm: 0, ...(over.business ?? {}) },
  todoCount: over.todoCount ?? 0,
});

test("lights: the worse of two, unknown between attention and healthy; the card's bar follows it", () => {
  assert.equal(worstLight("healthy", "unknown"), "unknown");
  assert.equal(worstLight("attention", "unknown"), "attention");
  assert.equal(worstLight("failing", "attention"), "failing");
  assert.equal(cardLight(card({ m: "healthy", b: "failing" })), "failing");
  assert.deepEqual(sortCards([card({ m: "healthy" }), { ...card({ b: "unknown" }), id: "a" }, { ...card({ m: "failing" }), id: "z" }]).map((c) => c.id), ["z", "a", "x"]);
});

test("overview text: what waits for the person, and the business label", () => {
  assert.equal(nextLine(card({ todoCount: 1 })), "1 thing for you");
  assert.equal(nextLine(card({ todoCount: 3 })), "3 things for you");
  assert.equal(nextLine(card({ business: { light: "unknown", sentence: "", flowCount: 0, toConfirm: 2 }, b: "unknown" })), "Confirm the flows the AI found");
  assert.equal(nextLine(card({})), null);
  assert.equal(businessLabel(card({})), "Business · 2 flows");
  assert.equal(businessLabel(card({ business: { light: "unknown", sentence: "", flowCount: 0, toConfirm: 2 } })), "Business · to confirm");
});

test("to-do actions: Apply is fixed text, the others use the AI's label or a default; a change row reads the contract's shapes", () => {
  assert.equal(actionLabel({ kind: "config-change", label: "应用", changes: [], note: "" }), "Apply the AI's change");
  assert.equal(actionLabel({ kind: "member-control", label: "", member: "n2", action: "restart" }), "Restart n2");
  assert.equal(actionLabel({ kind: "open-nifi", label: "", url: "https://x" }), "Open in NiFi");
  assert.equal(actionLabel({ kind: "set-threshold", label: "Raise the disk limit", overrides: {} }), "Raise the disk limit");
  assert.deepEqual(changeRow({ file: "nifi.properties", key: "a.b", value: "3 days" }), { setting: "a.b", file: "nifi.properties", to: "3 days" });
  assert.equal(changeRow({ file: "nifi.properties", key: "a.b", unset: true }).to, "(removed)");
  assert.equal(changeRow({ file: "bootstrap.conf", xml: "<x/>" }).to, "(file edited)");
});

test("Ask AI: the service page and the overview are the service context; the flow pages keep their names and have suggestions", () => {
  assert.equal(contextPage("services"), "service");
  assert.equal(contextPage("flow"), "flow");
  assert.equal(contextPage("status"), "status");
  for (const k of ["services", "flows", "flow"]) assert.ok(SUGGESTIONS[k]!.length >= 3);
});
