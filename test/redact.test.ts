// Service ops §9.3: log lines and bulletins are redacted before the AI reads them (services/redact.ts, the same rules
// as the service executor's REDACT).

import assert from "node:assert/strict";
import { test } from "node:test";
import { redactStrings, redactText } from "../src/server/services/redact.ts";

test("§9.3: secret-looking parts of log lines are hidden, the rest stays", () => {
  const cases: [string, string][] = [
    ["2026-11-06 01:00:00,000 ERROR [Timer-Driven Process Thread-3] o.a.n.p.s.PutSQL login failed password=hunter2 user=etl", "2026-11-06 01:00:00,000 ERROR [Timer-Driven Process Thread-3] o.a.n.p.s.PutSQL login failed password=[hidden] user=etl"],
    ["nifi.security.keystorePasswd: 'abc def'", "nifi.security.keystorePasswd: [hidden]"],
    ["Authorization: Basic dXNlcjpwYXNzd29yZA==", "Authorization: Basic [hidden]"],
    ["bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJtZSJ9.c2lnbmF0dXJlLXZhbHVl", "bearer [hidden]"],
    ["got eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJtZSJ9.c2lnbmF0dXJlLXZhbHVl back", "got [token hidden] back"],
    ["api_key=AKIA1234;secret=\"x y\"&client_secret=z", "api_key=[hidden];secret=[hidden]&client_secret=[hidden]"],
    ["ldaps://cn=admin:pw@ldap:636 failed", "ldaps://cn=admin:[hidden]@ldap:636 failed"],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY----- after", "[private key hidden] after"],
    ["-----BEGIN PRIVATE KEY-----\nMIIabc cut off", "[private key hidden]"],
    ["Connection to 10.0.0.5:2181 lost, retrying in 1000 ms", "Connection to 10.0.0.5:2181 lost, retrying in 1000 ms"],
    ["Processor PutFile[id=1234-abcd] transferred 3 FlowFiles", "Processor PutFile[id=1234-abcd] transferred 3 FlowFiles"],
  ];
  for (const [line, want] of cases) assert.equal(redactText(line), want, line);
  for (const [, want] of cases) assert.equal(redactText(want), want, "redacting twice changes nothing");
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
