// S37 step 8 (Q6): the sentence-to-conditions converter — the prompt carries no data, the answer is checked, a slow or
// failing Assistant is a fallback, and the route answers 200 with either `conditions` or `fallback`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import type { Context } from "hono";
import type { Permission, Principal } from "../src/server/auth.ts";
import type { OmaSessions } from "../src/server/oma.ts";
import { Store } from "../src/server/store.ts";
import { NlConverter, nlPrompt, parseNl } from "../src/server/services/trace/nl.ts";
import { mountTrace } from "../src/server/services/trace/routes.ts";
import { TOOLS } from "../src/server/mcp.ts";

const BUSINESSES = [{ id: "invoice", name: "发票处理" }, { id: "order", name: "订单" }];
const NOW = new Date("2026-11-18T08:30:00Z"); // 16:30 on Wednesday in UTC+8
const UTC8 = 480;

test("the prompt holds the sentence, the business list, now and a calendar, and nothing else", () => {
  const p = nlPrompt("昨天下午张三发的发票", BUSINESSES, NOW, UTC8);
  assert.match(p, /Now: 2026-11-18 16:30 \(周三\)/);
  assert.match(p, /2026-11-17 周二（昨天）/);
  assert.match(p, /2026-11-11 周三/);
  assert.match(p, /invoice: 发票处理/);
  assert.match(p, /"昨天下午张三发的发票"/);
});

test("the answer is read into checked conditions: local time to ISO, unknown business dropped, bad range dropped", () => {
  const good = parseNl('```json\n{"business":"invoice","fileName":null,"emailFrom":"张三","emailSubject":"发票","from":"2026-11-17 12:00","to":"2026-11-17 18:00"}\n```', BUSINESSES, UTC8);
  assert.deepEqual(good, { business: "invoice", emailFrom: "张三", emailSubject: "发票", from: "2026-11-17T04:00:00.000Z", to: "2026-11-17T10:00:00.000Z" });
  assert.deepEqual(parseNl('{"business":"nope","fileName":"a.pdf","from":"2026-11-17 18:00","to":"2026-11-17 12:00"}', BUSINESSES, UTC8), { fileName: "a.pdf" });
  assert.deepEqual(parseNl('{"business":"订单","from":"x","to":null}', BUSINESSES, UTC8), { business: "order" });
  assert.equal(parseNl("sorry, I cannot", BUSINESSES, UTC8), undefined);
});

const fakeOma = (reply: () => Promise<string | undefined>): OmaSessions => ({
  open: async () => "ses_1",
  events: async () => { const t = await reply(); return t === undefined ? [] : [{ type: "agent.message", content: [{ type: "text", text: t }] }, { type: "session.status_idle" }]; },
}) as unknown as OmaSessions;

test("the converter answers with conditions, falls back at the timeout and when the Assistant fails", async () => {
  const ok = await new NlConverter(fakeOma(async () => '{"fileName":"a.pdf"}'), 2000).convert("c250", "a.pdf", BUSINESSES, UTC8, NOW);
  assert.deepEqual("conditions" in ok && ok.conditions, { fileName: "a.pdf" });
  const slow = await new NlConverter(fakeOma(async () => undefined), 600).convert("c250", "a.pdf", BUSINESSES, UTC8, NOW);
  assert.ok("fallback" in slow && /within 0\.6 seconds/.test(slow.fallback), JSON.stringify(slow));
  const broken = await new NlConverter({ open: async () => { throw new Error("HTTP 502"); } } as unknown as OmaSessions, 2000).convert("c250", "a.pdf", BUSINESSES, UTC8, NOW);
  assert.ok("fallback" in broken && /HTTP 502/.test(broken.fallback));
  const noise = await new NlConverter(fakeOma(async () => "I think the file is a.pdf"), 2000).convert("c250", "a.pdf", BUSINESSES, UTC8, NOW);
  assert.ok("fallback" in noise);
});

function routes(nl?: NlConverter) {
  const store = new Store(":memory:");
  const reject = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 429 | 503, code: string, message: string, details: string[] = []) => c.json({ error: { code, message, details } }, status);
  const authenticate = async (_c: Context, _need: Permission): Promise<Principal | Response> => ({ id: "viewer", displayName: "x", via: "workbench", groups: [], isAdmin: false, permissions: ["view"] }) as unknown as Principal;
  const api = new Hono();
  mountTrace(api, { store, authenticate, reject, provenance: {} as never, registered: (id: string) => (id === "c250" ? {} : undefined), actorOf: (p: Principal) => ({ id: p.id, via: p.via }), adapters: new Map(), ...(nl ? { nl } : {}) });
  return async (body: unknown) => { const r = await api.request("/api/services/c250/trace-parse", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() as any }; };
}

test("the parse route: no Assistant configured is a fallback, an empty sentence a 400, the model's businesses go to the converter", async () => {
  const none = await routes()({ text: "a.pdf" });
  assert.equal(none.status, 200);
  assert.match(none.body.fallback, /not configured/);
  assert.equal((await routes()({ text: "  " })).status, 400);
  const seen: unknown[] = [];
  const nl = { convert: async (...args: unknown[]) => { seen.push(args); return { conditions: { fileName: "a.pdf" }, ms: 1 }; } } as unknown as NlConverter;
  const withNl = await routes(nl)({ text: "a.pdf", utcOffsetMinutes: 480 });
  assert.deepEqual(withNl.body, { conditions: { fileName: "a.pdf" }, ms: 1 });
  assert.deepEqual((seen[0] as unknown[]).slice(0, 2), ["c250", "a.pdf"]);
  assert.deepEqual((seen[0] as unknown[])[3], 480);
});

test("trace_business_data is a read-only MCP tool taking the page's conditions", () => {
  const tool = TOOLS.find((t) => t.name === "trace_business_data");
  assert.ok(tool?.readOnly);
  const req = tool.request({ id: "c250", file_name: "a.pdf", from: "2026-11-17T00:00:00Z" });
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/api/services/c250/trace-business-data");
  assert.deepEqual(req.body, { business: undefined, fileName: "a.pdf", emailFrom: undefined, emailSubject: undefined, from: "2026-11-17T00:00:00Z", to: undefined });
});
