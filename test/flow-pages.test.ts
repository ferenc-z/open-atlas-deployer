// Step 6b: the flow diagram's data (FlowGraph -> ELK input -> boxes and paths), the flow actions' routes, the hash routes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeFlowClient } from "../src/web/flow-client.ts";
import { flowHref, flowsHref, parseFlowRoute } from "../src/web/flow-routes.ts";
import type { FlowAction, FlowGraph } from "../src/server/services/ops-types.ts";
import { fromElk, nodeSize, toElk } from "../src/web/flowgraph.ts";
import { layoutFlow } from "../src/web/flowlayout.ts";
import { mockFlowClient } from "../src/web/flows-mock.ts";

const graph: FlowGraph = {
  services: [{ id: "n112", label: "n112-edge" }, { id: "c250", label: "c250-prod" }],
  nodes: [
    { id: "sup", kind: "external", service: null, label: "供应商推送\nHTTPS /invoices" },
    { id: "recv", kind: "group", service: "n112", label: "Invoice_Receive\n收发票 → 校验 → 转换", light: "failing" },
    { id: "store", kind: "group", service: "c250", label: "Invoice_Store", light: "healthy" },
    { id: "gone", kind: "external", service: null, label: "丢弃" },
    { id: "stray", kind: "group", service: "not-listed", label: "Stray" },
  ],
  edges: [
    { from: "sup", to: "recv", kind: "data" },
    { from: "recv", to: "store", kind: "s2s" },
    { from: "recv", to: "gone", kind: "drop", label: "failure" },
    { from: "recv", to: "missing", kind: "data" },
  ],
};

test("toElk: services are compound nodes holding their groups, externals and unlisted groups stay at the top", () => {
  const root = toElk(graph);
  assert.equal(root.layoutOptions?.["elk.algorithm"], "layered");
  assert.equal(root.layoutOptions?.["elk.direction"], "RIGHT");
  const byId = new Map((root.children ?? []).map((c) => [c.id, c]));
  assert.deepEqual(byId.get("svc:n112")?.children?.map((c) => c.id), ["n:recv"]);
  assert.deepEqual(byId.get("svc:c250")?.children?.map((c) => c.id), ["n:store"]);
  assert.ok(byId.has("n:sup") && byId.has("n:gone") && byId.has("n:stray"));
  assert.equal(byId.get("n:recv"), undefined);
});

test("toElk: every node has a size, edges keep their ends, an edge to a missing node is dropped, kinds give labels", () => {
  const root = toElk(graph);
  const all = [...(root.children ?? []), ...(root.children ?? []).flatMap((c) => c.children ?? [])].filter((n) => !n.id.startsWith("svc:"));
  for (const n of all) assert.ok((n.width ?? 0) > 0 && (n.height ?? 0) > 0, n.id);
  assert.equal(root.edges?.length, 3);
  const e = root.edges!;
  assert.deepEqual([e[0]!.sources, e[0]!.targets], [["n:sup"], ["n:recv"]]);
  assert.equal(e[0]!.labels, undefined);              // plain data: no label
  assert.equal(e[1]!.labels?.[0]?.text, "S2S");        // s2s: default label
  assert.equal(e[2]!.labels?.[0]?.text, "failure");    // the graph's own label
});

test("nodeSize: a longer label makes a wider box, capped; a group is at least 72 high", () => {
  const small = nodeSize("group", "A", undefined, false), big = nodeSize("group", "Customs_Receipt_Retry", "重试 3 次后送回再重试再重试", false);
  assert.ok(big.width > small.width && big.width <= 300);
  assert.equal(small.height, 72);
  assert.ok(nodeSize("group", "A", undefined, true).height >= small.height);
});

test("layout: ELK places services around their groups, left to right, and routes every edge", async () => {
  const laid = await layoutFlow(graph);
  assert.ok(laid.width > 0 && laid.height > 0);
  const node = (id: string) => laid.nodes.find((n) => n.id === id)!;
  const svc = (id: string) => laid.services.find((s) => s.id === id)!;
  for (const [n, s] of [["recv", "n112"], ["store", "c250"]] as const) {
    const a = node(n), b = svc(s);
    assert.ok(a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height, `${n} inside ${s}`);
  }
  assert.ok(node("sup").x < node("recv").x && node("recv").x < node("store").x, "left to right");
  assert.equal(laid.edges.length, 3);
  assert.ok(laid.edges.every((e) => e.path.startsWith("M ")));
  assert.equal(node("gone").dropTarget, true);
  assert.equal(node("store").dropTarget, false);
  assert.equal(node("recv").light, "failing");
  for (const n of laid.nodes) assert.ok(n.x + n.width <= laid.width + 1 && n.y + n.height <= laid.height + 1, `${n.id} within the diagram`);
});

test("fromElk: an edge is measured from its container", () => {
  const g: FlowGraph = { services: [{ id: "s", label: "s" }], nodes: [{ id: "a", kind: "group", service: "s", label: "A" }, { id: "b", kind: "group", service: "s", label: "B" }], edges: [{ from: "a", to: "b", kind: "data" }] };
  const elk = { id: "root", width: 400, height: 200, children: [{ id: "svc:s", x: 10, y: 20, width: 300, height: 150, children: [
    { id: "n:a", x: 16, y: 30, width: 100, height: 72 }, { id: "n:b", x: 180, y: 30, width: 100, height: 72 }] }],
    edges: [{ id: "e:0", container: "svc:s", sources: ["n:a"], targets: ["n:b"], sections: [{ id: "s0", startPoint: { x: 116, y: 66 }, endPoint: { x: 180, y: 66 } }] }] };
  const laid = fromElk(g, elk as never);
  assert.equal(laid.nodes[0]!.x, 26);
  assert.equal(laid.edges[0]!.path, "M 126 86 L 190 86");
});

test("client: each action goes to the flow's actions route with the action as the body", async () => {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const client = makeFlowClient((async (method: string, path: string, body?: unknown) => { calls.push({ method, path, body }); return {}; }) as never);
  const actions: FlowAction[] = [
    { kind: "confirm" }, { kind: "rename", name: "报关单回执" }, { kind: "split" }, { kind: "not-right", note: "x" },
    { kind: "ignore" }, { kind: "watch" }, { kind: "stuck", attentionMinutes: 10, failingMinutes: 60 },
  ];
  for (const a of actions) await client.act("flw_a/b", a);
  assert.equal(calls.length, actions.length);
  calls.forEach((c, i) => assert.deepEqual(c, { method: "POST", path: "flows/flw_a%2Fb/actions", body: actions[i] }));
  calls.length = 0;
  await client.review("n192-legacy");
  await client.detail("flw_x", "c250");
  await client.detail("flw_x");
  assert.deepEqual(calls.map((c) => [c.method, c.path]), [["GET", "services/n192-legacy/flows"], ["GET", "flows/flw_x?service=c250"], ["GET", "flows/flw_x"]]);
});

test("sample data answers like the server: confirm, rename (a person's name), stuck validation, ignore and watch", async () => {
  const r = await mockFlowClient.review("n192-legacy");
  assert.equal(r.flows.length, 2);
  assert.equal(r.ignored.length, 1);
  assert.equal(r.allConfirmed, false);
  await mockFlowClient.act("flw_crm", { kind: "rename", name: "客户同步" });
  await mockFlowClient.act("flw_crm", { kind: "confirm" });
  await assert.rejects(mockFlowClient.act("flw_crm", { kind: "stuck", attentionMinutes: 60, failingMinutes: 10 }));
  await mockFlowClient.act("flw_receipt", { kind: "confirm" });
  const done = await mockFlowClient.review("n192-legacy");
  assert.equal(done.allConfirmed, true);
  assert.equal(done.flows.find((c) => c.id === "flw_crm")?.nameBy, "person");
  await mockFlowClient.act("flw_tmp", { kind: "watch" });
  assert.equal((await mockFlowClient.review("n192-legacy")).ignored.length, 0);
});

test("hash routes: the links parse back", () => {
  assert.deepEqual(parseFlowRoute(flowsHref("n192-legacy")), { kind: "flows", service: "n192-legacy" });
  assert.deepEqual(parseFlowRoute(flowHref("flw_1", "c250-prod")), { kind: "flow", flow: "flw_1", service: "c250-prod" });
  assert.deepEqual(parseFlowRoute(flowHref("flw_1")), { kind: "flow", flow: "flw_1" });
  assert.equal(parseFlowRoute("#/other"), null);
  assert.equal(parseFlowRoute(""), null);
});
