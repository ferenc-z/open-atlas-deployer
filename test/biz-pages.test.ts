// S39 step 8: the register verb's routes, and the pure helpers of the Businesses and Register pages.
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeBizClient } from "../src/web/biz-client.ts";
import type { BusinessRow, Preview } from "../src/web/biz-types.ts";
import { businessFilter, canRegister, chainOf, countByLight, edgeText, groupProblems, groupsLine, handoffOf, parseLinks, sortBusinesses, summaryOf } from "../src/web/biz-view.ts";

test("client: the register verb goes to registrations/<action>, a write carries a request id", async () => {
  const seen: { method: string; path: string; body: unknown }[] = [];
  let n = 0;
  const biz = makeBizClient((async (method: string, path: string, body?: unknown) => { seen.push({ method, path, body }); return {}; }) as never, () => `req-${++n}`);
  await biz.list();
  await biz.preview({ links: ["a", { link: "b", service: "c250" }], name: "x" });
  await biz.commit({ name: "x", links: ["a"] });
  await biz.rename("flw_1", "y");
  await biz.unregister("flw_1");
  assert.deepEqual(seen, [
    { method: "GET", path: "businesses", body: undefined },
    { method: "POST", path: "registrations/preview", body: { links: ["a", { link: "b", service: "c250" }], name: "x" } },
    { method: "POST", path: "registrations/commit", body: { name: "x", links: ["a"], request_id: "req-1" } },
    { method: "POST", path: "registrations/rename", body: { flow: "flw_1", name: "y", request_id: "req-2" } },
    { method: "POST", path: "registrations/unregister", body: { flow: "flw_1", request_id: "req-3" } },
  ]);
});

const row = (over: Partial<BusinessRow>): BusinessRow => ({ id: "flw_a", name: "A", light: "healthy", sentence: "", anomalies: [], services: ["c250"], groupCount: 2, handoffCount: 0, registeredBy: "王敏", registeredAt: "2026-11-24T10:20:00Z", ...over });

test("businesses: worst first, the filters, and the counts the chips show", () => {
  const rows = [row({ id: "1", name: "b", light: "healthy" }), row({ id: "2", name: "a", light: "failing", services: ["n112", "c250"], registeredById: "u1" }), row({ id: "3", name: "c", light: "attention", registeredBy: "Ferenc" })];
  assert.deepEqual(sortBusinesses(rows).map((r) => r.id), ["2", "3", "1"]);
  assert.deepEqual(countByLight(rows), { failing: 1, attention: 1, healthy: 1, unknown: 0 });
  const me = { id: "u1", displayName: "Ferenc" };
  const pick = (f: Parameters<typeof businessFilter>[0]) => rows.filter(businessFilter(f)).map((r) => r.id);
  assert.deepEqual(pick({ status: "all", service: "", mine: false, me }), ["1", "2", "3"]);
  assert.deepEqual(pick({ status: "failing", service: "", mine: false, me }), ["2"]);
  assert.deepEqual(pick({ status: "all", service: "n112", mine: false, me }), ["2"]);
  // Mine: by id when the row has one, else by the display name.
  assert.deepEqual(pick({ status: "all", service: "", mine: true, me }), ["2", "3"]);
  assert.equal(groupsLine(row({ groupCount: 5, handoffCount: 1 })), "5 groups · 1 handoff you described");
  assert.equal(groupsLine(row({ groupCount: 1 })), "1 group");
});

test("links: one per line, blank lines and repeats go, `service=` is the hint", () => {
  assert.deepEqual(parseLinks("  https://a/x \n\nhttps://b/y service=c250\nhttps://a/x"), ["https://a/x", { link: "https://b/y", service: "c250" }]);
  assert.deepEqual(parseLinks("https://a/x\nhttps://c/z", ["https://a/x"]), ["https://c/z"]);
});

const preview: Preview = {
  groups: [
    { ref: "g1", service: "c250", group: { id: "1", name: "Manager" }, state: "ok" },
    { ref: "g2", service: "c250", group: { id: "2", name: "Parse" }, state: "ok" },
    { ref: "g3", service: "n192", group: { id: "3", name: "Archive" }, state: "ok" },
  ],
  segments: [
    { id: "s1", service: "c250", group: { id: "1", name: "Manager" }, slice: "*", role: "segment", steps: ["manager"] },
    { id: "s2", service: "c250", group: { id: "2", name: "Parse" }, slice: "*", role: "segment" },
    { id: "s3", service: "n192", group: { id: "3", name: "Archive" }, slice: "*", role: "segment" },
  ],
  layers: [["s1"], ["s2"], ["s3"]],
  edges: [{ from: "s1", to: "s2", kind: "schedule", via: "schedule 1→2" }],
  entries: [], exits: [],
  gaps: [{ id: "gap1", kind: "disconnected", segment: "s3", text: "Archive 接不上", candidates: [{ component: "p1", name: "PutFile" }] }],
};

test("register: the chain follows the layers, the summary counts what is open, a handoff is built from the answer", () => {
  const chain = chainOf(preview);
  assert.deepEqual(chain.map((l) => l.segments.map((s) => s.id)), [["s1"], ["s2"], ["s3"]]);
  assert.deepEqual(chain.map((l) => l.arriving.length), [0, 1, 0]);
  assert.equal(summaryOf(preview), "3 groups · 2 connected · 1 to ask");
  assert.equal(summaryOf({ ...preview, gaps: [] }), "3 groups · all connected · 2 services");
  assert.equal(canRegister(preview, "x"), false, "a gap is open");
  assert.equal(canRegister({ ...preview, gaps: [] }, " "), false, "no name");
  assert.equal(canRegister({ ...preview, gaps: [] }, "报关单处理"), true);
  assert.equal(edgeText({ from: "s1", to: "s2", kind: "declared", quote: "写到共享目录", inferred: true }), "You described · inferred · “写到共享目录”");
  const gap = preview.gaps[0]!;
  assert.equal(handoffOf(preview, gap, { from: "s2", component: "", quote: "x", system: "" }), null);
  assert.deepEqual(handoffOf(preview, gap, { from: "s2", component: "p1", quote: " 写到共享目录 ", system: "" }), { from: { service: "c250", group: "2", component: "p1" }, to: { service: "n192", group: "3" }, quote: "写到共享目录" });
  const exit = { ...gap, kind: "exit-unregistered" as const, segment: "s2" };
  assert.deepEqual(handoffOf(preview, exit, { from: "", component: "p9", quote: "q", system: "客户 SFTP" }), { from: { service: "c250", group: "2", component: "p9" }, to: { system: "客户 SFTP" }, quote: "q" });
});

test("register: a group that cannot be used is named, and blocks Register", () => {
  const bad: Preview = { ...preview, gaps: [], groups: [{ ref: "g1", service: "c250", group: { id: "1", name: "Manager" }, state: "taken", takenBy: { flow: "flw_x", name: "订单同步" } }, { ref: "g2", service: "n192", group: { id: "2", name: "Gone" }, state: "missing" }] };
  assert.deepEqual(groupProblems(bad), ["c250 · Manager: already registered by 订单同步", "n192 · Gone: not found on that service"]);
  assert.equal(canRegister(bad, "x"), false);
});
