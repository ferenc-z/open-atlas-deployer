// pages-rethink §10.1 ⑰: the changes run_model / publish_model take, applied to a draft (model-changes.ts). Only the
// model's own structure; the gate judges what comes out.

import assert from "node:assert/strict";
import { test } from "node:test";
import { applyChanges, draftLines } from "../src/server/services/model-changes.ts";
import type { ModelDraft, Segment } from "../src/server/services/trace/model.ts";

const seg = (id: string, flow: string | null): Segment => ({
  id, name: id, match: [], steps: [{ id: "g", name: id, position: { kind: "process-group", id, name: id } }],
  entries: [{ id: "in", step: "g", channel: { type: "external", system: "src" } }], exits: [{ id: "out-1", step: "g", channel: { type: "external", system: "dst" }, component: `${id}-put`, relationship: "success" }],
  group: { id, name: id }, slice: "*", role: flow ? "segment" : "shared", ...(flow ? { flow } : {}),
} as Segment);
const base = (): ModelDraft => ({ version: 2, service: "s", sources: [], segments: [seg("A", "new:a"), seg("B", "new:b"), seg("C", "new:c"), seg("X", null)], flows: [{ flow: "new:a", name: "A" }, { flow: "new:b", name: "B" }] });

test("merge, split, share, remove, rekey and notes", () => {
  const b = base();
  const { draft, errors } = applyChanges(b, [
    { op: "assign", segments: ["B"], flow: "new:a" },
    { op: "assign", segments: ["X"], flow: "new:x" },
    { op: "share", segments: ["C"] },
    { op: "rekey", from: "new:a", to: "flw_abcdef12" },
    { op: "note", flow: "flw_abcdef12", name: "Orders", summary: "in → out" },
    { op: "remove", segments: ["X"] },
  ]);
  assert.deepEqual(errors, []);
  assert.deepEqual(draft.segments.map((s) => [s.id, s.role, s.flow ?? null]), [["A", "segment", "flw_abcdef12"], ["B", "segment", "flw_abcdef12"], ["C", "shared", null]]);
  assert.deepEqual(draft.flows, [{ flow: "flw_abcdef12", name: "Orders", summary: "in → out" }], "the note of a key no segment has is dropped");
  assert.equal(b.segments[1]!.flow, "new:b", "the base is not touched");
});

test("entries and exits: add (ids and step filled in), change, remove; a hand-over is an exit here", () => {
  const { draft, errors } = applyChanges(base(), [
    { op: "add-exit", segment: "A", exit: { channel: { type: "mq", exchange: "/data/out", routingKey: "orders" }, component: "A-put2" } },
    { op: "set-exit", segment: "A", id: "out-1", relationship: null, component: "A-put0" },
    { op: "add-entry", segment: "B", entry: { channel: { type: "mq", exchange: "/data/out", routingKey: "orders" } } },
    { op: "remove-entry", segment: "B", id: "in" },
    { op: "set", segment: "C", name: "Common checks" },
  ]);
  assert.deepEqual(errors, []);
  const lines = Object.fromEntries(draftLines(draft).lines.map((l) => [l.id, l]));
  assert.deepEqual(lines.A!.exits, ["out-1 external:dst @A-put0", "out-2 mq:/data/out:orders @A-put2"]);
  assert.deepEqual(lines.B!.entries, ["in-2 mq:/data/out:orders"]);
  assert.equal(draft.segments.find((s) => s.id === "B")!.entries[0]!.step, "g");
  assert.equal(draft.segments.find((s) => s.id === "C")!.name, "Common checks");
});

test("a change that cannot apply is an error, named by its place; an unknown op too", () => {
  const { errors } = applyChanges(base(), [
    { op: "assign", segments: ["nope"], flow: "new:a" },
    { op: "add-exit", segment: "A", exit: { id: "out-1", channel: { type: "external" }, component: "c" } },
    { op: "remove-exit", segment: "A", id: "zz" },
    { op: "rekey", from: "new:none", to: "new:y" },
    { op: "explode" },
  ]);
  assert.equal(errors.length, 5);
  assert.match(errors[0]!, /^changes\[0\] \(assign\): no segment nope/);
  assert.match(errors[1]!, /has out-1 already/);
  assert.match(errors[4]!, /op is one of/);
  assert.deepEqual(applyChanges(base(), "x").errors, ["changes is a list of {op, …}."]);
});
