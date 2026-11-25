// S39 step 8: the register verb's routes, and the pure helpers of the Businesses and Register pages.
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeBizClient } from "../src/web/biz-client.ts";
import type { BusinessRow, Preview } from "../src/web/biz-types.ts";
import type { RegDraft } from "../src/web/biz-types.ts";
import { draftChanges, isIncoming, moduleRow, previewStale, refusalOf, businessFilter, canRegister, chainOf, countByLight, edgeText, groupProblems, groupsLine, handoffOf, parseLinks, sortBusinesses, summaryOf } from "../src/web/biz-view.ts";

test("client: the pages' calls go to the registration routes, a write carries a request id", async () => {
  const seen: { method: string; path: string; body: unknown }[] = [];
  let n = 0;
  const biz = makeBizClient((async (method: string, path: string, body?: unknown) => { seen.push({ method, path, body }); return {}; }) as never, () => `req-${++n}`);
  await biz.businesses();
  await biz.modules();
  await biz.module("shm_1");
  await biz.createDraft();
  await biz.draft("rgd_1");
  await biz.draftsOf("flw_1");
  await biz.addLinks("rgd_1", ["a", { link: "b", service: "c250" }]);
  await biz.preview("rgd_1");
  await biz.commit("rgd_1", "x");
  await biz.discardDraft("rgd_1");
  await biz.rename("flw_1", "y");
  await biz.unregister("flw_1");
  assert.deepEqual(seen, [
    { method: "GET", path: "businesses", body: undefined },
    { method: "GET", path: "registrations/modules", body: undefined },
    { method: "GET", path: "registrations/modules/shm_1", body: undefined },
    { method: "POST", path: "registrations/drafts", body: {} },
    { method: "GET", path: "registrations/drafts/rgd_1", body: undefined },
    { method: "GET", path: "registrations/drafts?flow=flw_1", body: undefined },
    { method: "POST", path: "registrations/add", body: { draft: "rgd_1", links: ["a", { link: "b", service: "c250" }], request_id: "req-1" } },
    { method: "POST", path: "registrations/preview", body: { draft: "rgd_1" } },
    { method: "POST", path: "registrations/commit", body: { draft: "rgd_1", name: "x", request_id: "req-2" } },
    { method: "DELETE", path: "registrations/drafts/rgd_1", body: undefined },
    { method: "POST", path: "registrations/rename", body: { flow: "flw_1", name: "y", request_id: "req-3" } },
    { method: "POST", path: "registrations/unregister", body: { flow: "flw_1", request_id: "req-4" } },
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
  const bad: Preview = { ...preview, gaps: [], groups: [{ ref: "g1", service: "c250", group: { id: "1", name: "Manager" }, state: "ok" }, { ref: "g2", service: "n192", group: { id: "2", name: "Gone" }, state: "missing" }] };
  assert.deepEqual(groupProblems(bad), ["n192 · Gone: not found on that service"]);
  assert.equal(canRegister(bad, "x"), false);
});

test("register: S2S and MQ nobody receives are about where data goes out; a part not joined to the rest is about where it comes from", () => {
  for (const k of ["exit-unregistered", "s2s-unpaired", "mq-unpaired", "worker-unplaced", "group-missing"] as const) assert.equal(isIncoming(k), false, k);
  for (const k of ["entry-unregistered", "disconnected"] as const) assert.equal(isIncoming(k), true, k);
});

const draft = (over: Partial<RegDraft>): RegDraft => ({ draft: "rgd_1", flow: null, createdBy: "u", name: null, groups: [], handoffs: [], places: [], preview: null, createdAt: "", updatedAt: "", ...over });
const dg = (service: string, id: string, name: string) => ({ service, group: { id, name, path: "" }, link: null, addedBy: "u", addedAt: "" });

test("register: the picture is stale while the draft's groups are not the preview's", () => {
  assert.equal(previewStale(draft({})), false);
  assert.equal(previewStale(draft({ groups: [dg("c250", "1", "A")] })), true, "no preview yet");
  const p = { ...preview, groups: [{ ref: "g1", service: "c250", group: { id: "1", name: "A" }, state: "ok" as const }] };
  assert.equal(previewStale(draft({ groups: [dg("c250", "1", "A")], preview: p })), false);
  assert.equal(previewStale(draft({ groups: [dg("c250", "1", "A"), dg("c250", "2", "B")], preview: p })), true);
});

test("register: a refused Register becomes the lines to show and one sentence for the assistant", () => {
  const gate = refusalOf({ code: "register/gate-rejected", message: "refused", body: { problems: [{ text: "s2s-balance: 发出 10 收到 8" }] } });
  assert.deepEqual(gate.lines, ["s2s-balance: 发出 10 收到 8"]);
  assert.match(gate.tell, /^点 Register 被闸门拒绝了.*s2s-balance/u);
  const gaps = refusalOf({ code: "register/gaps-open", message: "open", body: { gaps: [{ id: "g1", text: "Archive 接不上" }] } }, "Confirm changes");
  assert.match(gaps.tell, /^点 Confirm changes 被拒绝了，还有 1 个地方接不上：Archive 接不上/u);
  // The server's gap sentences end with "。": the sentence has no "。；" or "。。".
  const two = refusalOf({ code: "register/gaps-open", message: "open", body: { gaps: [{ id: "g1", text: "A 连到没登记的组 B 的 in。" }, { id: "g2", text: "C 连到没登记的组 D 的 in。" }] } });
  assert.equal(two.tell, "点 Register 被拒绝了，还有 2 个地方接不上：A 连到没登记的组 B 的 in；C 连到没登记的组 D 的 in。请帮我逐个处理。");
});

test("business: a draft of changes is listed against what is registered", () => {
  const reg = { by: "u", at: "", shared: [], changes: [], groups: [{ service: "c250", id: "1", name: "A", how: "" }, { service: "c250", id: "2", name: "B", how: "" }], handoffs: [{ id: "hof_1", from: { service: "c250", group: "1", component: "p" }, to: { system: "x" }, quote: "old" }] };
  const same = draft({ flow: "flw_1", name: "N", groups: [dg("c250", "1", "A"), dg("c250", "2", "B")], handoffs: [{ id: "hof_1", from: reg.handoffs[0]!.from, to: reg.handoffs[0]!.to, quote: "old", declaredBy: "", declaredAt: "" }] });
  assert.deepEqual(draftChanges(same, { name: "N", reg }), []);
  const changed = draft({ flow: "flw_1", name: "Z", groups: [dg("c250", "1", "A"), dg("n112", "3", "C")], handoffs: [] });
  assert.deepEqual(draftChanges(changed, { name: "N", reg }), ["Add group C (n112)", "Remove group B (c250)", "Rename to “Z”", "Remove a handoff you described: “old”"]);
});

test("modules: a row says what goes in and out, its own health, and who uses it once that is known", () => {
  const m = { id: "shm_1", name: "校验", groups: [{ service: "n112", group: { id: "g", name: "validate" } }], segments: [], entries: [{ id: "e", text: "S2S 端口 in" }], exits: [{ id: "x", text: "MQ ok" }], health: { light: "ok" as const, minutes: 60, flowfilesIn: 3, flowfilesOut: 3, text: "进 3 出 3" }, createdBy: "u", updatedAt: "" };
  assert.deepEqual(moduleRow(m), { id: "shm_1", name: "校验", service: "n112", ports: "In: S2S 端口 in · Out: MQ ok", light: "healthy", health: "进 3 出 3" });
  assert.deepEqual(moduleRow(m, { ...m, users: [{ flow: "flw_1", name: "订单", via: [] }] }).usedBy, [{ id: "flw_1", name: "订单" }]);
});
