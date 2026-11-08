// Service ops §9.3: log lines and bulletins are redacted before the AI reads them (services/redact.ts, the same rules
// as the service executor's REDACT).

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { redactProvenance, redactStrings, redactText } from "../src/server/services/redact.ts";

// The cases are shared with the service executor's tests (testdata/redact/cases.json): both sides hide the same.
const CASES = JSON.parse(readFileSync(new URL("../testdata/redact/cases.json", import.meta.url), "utf8")) as { text: [string, string][]; attributes: { hidden: string[]; shown: string[] } };

test("§9.3: secret-looking parts of log lines are hidden, the rest stays (the cases the executor's REDACT passes too)", () => {
  for (const [line, want] of CASES.text) assert.equal(redactText(line), want, line);
  for (const [, want] of CASES.text) assert.equal(redactText(want), want, "redacting twice changes nothing");
});

test("S28: FlowFile attributes reach the AI with the values of secret-looking names hidden, the rest as they are", () => {
  const attrs = (names: string[]) => ({ event: { attributes: names.map((name) => ({ name, value: "v-1", previousValue: "v-0" })) } });
  for (const a of redactProvenance(attrs(CASES.attributes.hidden)).event.attributes) assert.deepEqual([a.name, a.value, a.previousValue], [a.name, "[hidden]", "[hidden]"], a.name);
  for (const a of redactProvenance(attrs(CASES.attributes.shown)).event.attributes) assert.deepEqual([a.name, a.value, a.previousValue], [a.name, "v-1", "v-0"], a.name);
});

test("§9.3: bulletins and other answers are redacted in every string, keys and numbers untouched", () => {
  const bulletins = { bulletins: [
    { id: 1, at: "2026-11-06T01:00:00Z", level: "ERROR", source: "InvokeHTTP", message: "401 with token=abc.def for https://u:p4ss@api/x", node: "node1:8443" },
    { id: 2, level: "WARNING", message: null, password: "not a value position" },
  ], count: 2 };
  assert.deepEqual(redactStrings(bulletins), { bulletins: [
    { id: 1, at: "2026-11-06T01:00:00Z", level: "ERROR", source: "InvokeHTTP", message: "401 with token=[hidden] for https://u:[hidden]@api/x", node: "node1:8443" },
    { id: 2, level: "WARNING", message: null, password: "not a value position" },
  ], count: 2 });
});
