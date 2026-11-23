// pages-rethink §10.1 ⑰: look's and describe's summaries stay small however big the answer behind them is, keep what
// identification needs (every unit and link, the skeleton's questions, every shown event's uuid and event id), say how
// to get the rest, and detail "full" is the answer as it was.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Topology } from "../src/server/services/flowcounts.ts";
import { bulletinsShape, describeShape, logsShape, modelShape, provenanceShape, topologyShape } from "../src/server/services/look-summary.ts";

const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
const id = (i: number) => `0${String(i).padStart(7, "0")}-01a2-1000-ffff-ffffa655a7b8`;

function bigCanvas(n: number): { topology: Topology; skeleton: any; takenAt: string } {
  const groups = Array.from({ length: n }, (_, i) => ({
    id: id(i), name: `group-${i}`, root: false,
    fragments: [{ key: id(1000 + i), processors: 12, names: Array.from({ length: 12 }, (_, k) => `Processor number ${k} of group ${i} doing something`), inputs: ["in"], outputs: ["out", "errors"], remoteIn: [], s2sOut: [], starts: 1 }],
  }));
  const links = groups.slice(1).map((g, i) => ({ connection: id(2000 + i), from: { group: groups[i]!.id, fragment: groups[i]!.fragments[0]!.key, port: "out" }, to: { group: g.id, fragment: g.fragments[0]!.key, port: "in" } }));
  const ends = groups.map((g, i) => ({ id: id(3000 + i), name: `Write file ${i}`, type: "org.apache.nifi.processors.standard.PutFile", group: g.id, fragment: g.fragments[0]!.key, relationships: ["failure", "success"] }));
  const questions = groups.slice(0, 6).map((g) => ({ kind: "split", service: "s", group: g.id, text: `组 ${g.name} 里有 2 片互不相连的部分，先按片拆成 2 条，是否其实是一件事要问人。` }));
  const skeleton = {
    flows: groups.map((g) => ({ key: `s/${g.id}`, segments: [{ id: `s/${g.id}`, service: "s", group: { id: g.id, name: g.name }, fragment: null, root: false, processors: 12, names: g.fragments[0]!.names, traffic: "yes" }], exceptions: [], reason: null })),
    shared: [], empty: [], questions,
  };
  return { topology: { root: { id: "root", name: "NiFi Flow" }, groups, links, s2sIn: [], s2sOut: [], ends }, skeleton, takenAt: "2026-11-23T01:00:00Z" };
}

test("look topology: a summary under its cap with every unit, link and question; group gives one unit; full is the body", () => {
  const body = bigCanvas(40);
  const sum = topologyShape(body, {}) as any;
  assert.ok(size(body) > 60_000, `the body is big (${size(body)})`);
  assert.ok(size(sum) < 16_000, `summary ${size(sum)} bytes`);
  assert.deepEqual([sum.units.length, sum.links.length, sum.counts.ends, sum.skeleton.questions.length], [40, 39, 40, 6]);
  assert.deepEqual(sum.skeleton.questions, body.skeleton.questions, "the questions whole");
  assert.match(sum.more, /detail: "full"/);
  const one = topologyShape(body, { group: "group-3" }) as any;
  assert.deepEqual([one.found, one.unit.fragments[0].names.length, one.links.length, one.ends.length, one.skeleton.flows.length], [true, 12, 2, 1, 1]);
  assert.equal(topologyShape(body, { detail: "full" }), body);
});

test("look model: the draft whole (what run_model takes), the current model in a line per segment", () => {
  const seg = (i: number) => ({ id: `seg-${i}`, flow: `flw_${i}`, name: `g${i}`, match: [], steps: [{ id: "g", name: `g${i}`, position: { kind: "process-group", id: id(i), name: `g${i}` } }], entries: [{ id: "in", step: "g", channel: { type: "external", system: "x" } }], exits: [{ id: "out-1", step: "g", channel: { type: "external", system: "Write" }, component: id(500 + i), relationship: "success" }], group: { id: id(i), name: `g${i}` }, slice: "*", role: "segment" });
  const body = { current: { revision: 3, publishedAt: "t", publishedBy: "ai", source: "ai", model: { version: 2, service: "s", sources: [], segments: Array.from({ length: 20 }, (_, i) => seg(i)) } }, base: 3, draft: { version: 2, service: "s", sources: [], segments: Array.from({ length: 20 }, (_, i) => seg(i)), flows: [] }, flows: [], e2e: null };
  const sum = modelShape(body, {}) as any;
  assert.deepEqual(sum.draft, body.draft, "the draft untouched");
  assert.equal(sum.current.segments.length, 20);
  assert.equal(sum.current.model, undefined);
  assert.ok(size(sum) < size(body) * 0.65, `${size(sum)} of ${size(body)}`);
  assert.equal(modelShape(body, { detail: "full" }), body);
});

test("look provenance: counts and the first events in a line, uuid and event id kept, under its cap; offset pages", () => {
  const events = Array.from({ length: 100 }, (_, i) => ({
    id: String(i), eventId: 1000 + i, eventTime: "11/23/2026 01:00:00.000 CST", at: `2026-11-23T01:00:${String(i % 60).padStart(2, "0")}.000Z`, eventType: i % 3 ? "ROUTE" : "DROP",
    flowFileUuid: id(i), fileSizeBytes: 1234, clusterNodeId: "node-1", clusterNodeAddress: "localhost:18445", groupId: id(9000), componentId: id(7000 + (i % 5)),
    componentType: "org.apache.nifi.processors.standard.RouteOnAttribute", componentName: `Route ${i % 5}`, relationship: "matched", details: "Auto-Terminated by failure Relationship ".repeat(4),
    eventDuration: 3, lineageDuration: 40, parentUuids: [], childUuids: [], transitUri: null, alternateIdentifierUri: null, member: "local:/x/c250-1",
  }));
  const body = { events, total: 100, limit: 100, limitReached: true, from: "a", to: "b", via: { member: "m", label: "l" } };
  const sum = provenanceShape(body, {}) as any;
  assert.ok(size(body) > 50_000, `body ${size(body)}`);
  assert.ok(size(sum) < 10_000, `summary ${size(sum)} bytes`);
  assert.deepEqual([sum.count, sum.flowFiles, sum.byType.DROP, sum.byComponent.length, sum.events.length, sum.shown.rest], [100, 100, 34, 5, 20, 80]);
  assert.ok(sum.events.every((e: any) => e.uuid && Number.isInteger(e.eventId) && e.node === "node-1"), "what look event and lineage take");
  assert.ok(sum.byComponent.every((c: any) => c.component.length === 36 && c.name));
  assert.match(sum.more, /offset: 20/);
  assert.equal((provenanceShape(body, { offset: 90 }) as any).events[0].eventId, 1090);
  assert.equal(provenanceShape(body, { detail: "full" }), body);
});

test("look bulletins and logs: grouped by pattern under their caps; full is every row", () => {
  const bulletins = Array.from({ length: 1000 }, (_, i) => ({ service: "s", member: `m${i % 2}`, node: "n", id: i, at: `2026-11-23T0${i % 10}:00:00Z`, level: i % 4 ? "WARNING" : "ERROR", category: "Log Message", source: `Proc ${i % 7}`, sourceType: "org.apache.nifi.processors.standard.PutFile", sourceId: id(i % 7), groupId: id(99), message: `PutFile[id=${id(i % 7)}] Failed to write file ${i}.csv to /data/out/${i}: disk quota exceeded after ${i} attempts ${"x".repeat(200)}` }));
  const b = bulletinsShape({ bulletins }, {}) as any;
  assert.ok(size({ bulletins }) > 300_000);
  assert.ok(size(b) < 12_000, `bulletins summary ${size(b)} bytes`);
  assert.deepEqual([b.count, b.groups, b.top.length, b.levels.ERROR], [1000, 14, 14, 250], "one group per source, level and message pattern");
  assert.equal(b.top.reduce((x: number, g: any) => x + g.count, 0), 1000);
  assert.equal(bulletinsShape({ bulletins }, { detail: "full" }).bulletins.length, 1000);

  const entries = Array.from({ length: 2000 }, (_, i) => ({ member: `m${i % 2}`, label: "l", file: "nifi-app.log", at: `2026-11-23T01:${String(i % 60).padStart(2, "0")}:00Z`, local: "x", level: i % 10 ? "INFO" : "ERROR", logger: `o.a.n.c.Logger${i % 6}`, thread: "t", text: `Something ${i % 6} happened to FlowFile ${id(i)} after ${i} ms ${"y".repeat(400)}` }));
  const l = logsShape({ from: "a", to: "b", entries, members: [] }, {}) as any;
  assert.ok(size(l) < 14_000, `logs summary ${size(l)} bytes`);
  assert.deepEqual([l.count, l.newest.length, l.levels.ERROR], [2000, 8, 200]);
  assert.ok(l.groups <= 12);
  assert.equal((logsShape({ entries }, { detail: "full" }) as any).entries.length, 2000);
});

test("describe: short by default (to-do details clipped, the business detail whole), full as it was", () => {
  const body = {
    service: { id: "s" }, machine: { light: "healthy", checks: [] }, business: { light: "healthy", flows: [] },
    todos: Array.from({ length: 20 }, (_, i) => ({ id: `td_${i}`, flow: null, source: "analysis", severity: "attention", title: `t${i}`, detail: "很长的说明".repeat(300), action: { kind: "open-nifi", label: "打开", url: "https://x", component: "c" }, createdAt: "t", createdBy: "b", draft: null })),
    analysis: { summary: "s".repeat(3000) }, gaps: [], flow: { detail: "d".repeat(3000) },
  };
  const sum = describeShape(body, {}) as any;
  assert.ok(size(sum) < 14_000, `describe ${size(sum)} bytes (20 to-dos)`);
  assert.ok(size(sum) < size(body) / 4);
  assert.equal(sum.todos.length, 20);
  assert.match(sum.todos[0].detail, /…\(\+\d+ chars\)$/);
  assert.equal(sum.flow.detail.length, 3000, "the business asked for, whole");
  assert.equal(describeShape(body, { detail: "full" }), body);
});
