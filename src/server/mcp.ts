// The Deployer's MCP endpoint (§10.4, phase 6): POST /mcp speaks JSON-RPC (MCP streamable HTTP, JSON answers only).
// The bearer is an API key: personal (dpk_) or the Deploy Assistant's read-only service key (dps_).
//
// Every tool is ONE request to the Deployer's own API, dispatched in-process as the key's principal, so a tool has
// no authority, validation or audit of its own beyond the route's: the page and the AI run the same code. A refusal
// comes back as a finding (code / at / expected). Commands take a request_id: a retry with the same one returns the
// first answer instead of doing it twice. Arguments a tool does not declare are refused by name.

import type { Principal } from "./auth.ts";
import type { Store } from "./store.ts";

interface Property { type: "string" | "integer" | "boolean" | "array" | "object"; description: string; items?: { type: "object" | "string" } }
export interface Tool {
  name: string;
  description: string;
  /** Read-only tools are the only ones a service key sees; the others change something (destructiveHint). */
  readOnly: boolean;
  properties: Record<string, Property>;
  required?: string[];
  request: (a: Record<string, unknown>) => { method: "GET" | "POST" | "PUT"; path: string; query?: Record<string, unknown>; body?: unknown };
}

const s = (description: string): Property => ({ type: "string", description });
const n = (description: string): Property => ({ type: "integer", description });
const enc = (v: unknown) => encodeURIComponent(String(v));
const APP = s("The app id, as list_apps names it.");
const REQUEST_ID = s("Any string unique to this command; send the same one again to retry without doing it twice.");

export const TOOLS: Tool[] = [
  { name: "get_status", readOnly: true, description: "This environment: each app's desired and running version, container health, the executor, deploys in progress; in PROD also what UAT runs.", properties: {}, request: () => ({ method: "GET", path: "/api/status" }) },
  { name: "list_apps", readOnly: true, description: "Registered apps with their manifest revisions.", properties: {}, request: () => ({ method: "GET", path: "/api/apps" }) },
  { name: "get_app", readOnly: true, description: "One app's registration and every manifest (components, drivers, env file).", properties: { app: APP }, required: ["app"], request: (a) => ({ method: "GET", path: `/api/apps/${enc(a.app)}` }) },
  { name: "list_versions", readOnly: true, description: "Versions an app can be deployed at (its release tags, newest first), which are built, which runs.", properties: { app: APP }, required: ["app"], request: (a) => ({ method: "GET", path: `/api/apps/${enc(a.app)}/versions` }) },
  { name: "plan_deploy", readOnly: true, description: "The deploy plan for one app at one version: every step in order with before → after, findings (blocking ones refuse the deploy), promotion basis in PROD, contract check. Changes nothing. pin_from goes back to an earlier successful deploy's digests.", properties: { app: APP, version: s("The version, e.g. 2.9.0."), pin_from: s("Optional: the id of an earlier successful deploy of this version.") }, required: ["app", "version"], request: (a) => ({ method: "POST", path: `/api/apps/${enc(a.app)}/plan`, body: { version: a.version, ...(a.pin_from ? { pinFrom: a.pin_from } : {}) } }) },
  { name: "list_jobs", readOnly: true, description: "Recent builds, deploys and env writes, newest first.", properties: { app: s("Optional app id."), kind: s("Optional: build, deploy, env or env-read."), limit: n("Optional, default 50.") }, request: (a) => ({ method: "GET", path: "/api/jobs", query: { app: a.app, kind: a.kind, limit: a.limit } }) },
  { name: "get_job", readOnly: true, description: "One job: state, every step (executor and Deployer), the executor's log, the deployment record, the failure diagnosis when there is one.", properties: { job: s("The job id.") }, required: ["job"], request: (a) => ({ method: "GET", path: `/api/jobs/${enc(a.job)}` }) },
  { name: "list_artifacts", readOnly: true, description: "Artifacts (image or bundle digests) and where each was deployed.", properties: { app: s("Optional app id.") }, request: (a) => ({ method: "GET", path: "/api/artifacts", query: { app: a.app } }) },
  { name: "get_env", readOnly: true, description: "An app's env file as the Deployer keeps it: values with secrets masked, revisions, what the schema expects (missing, unknown, renamed keys).", properties: { app: APP, revision: n("Optional revision; the newest by default.") }, required: ["app"], request: (a) => ({ method: "GET", path: `/api/apps/${enc(a.app)}/env`, query: { revision: a.revision } }) },
  { name: "plan_env", readOnly: true, description: "What writing an env revision to the server would change: keys, services restarted, findings. Changes nothing.", properties: { app: APP, revision: n("Optional revision; the newest by default.") }, required: ["app"], request: (a) => ({ method: "POST", path: `/api/apps/${enc(a.app)}/env/plan`, body: a.revision === undefined ? {} : { revision: a.revision } }) },
  { name: "compare_env_with_uat", readOnly: true, description: "PROD only: UAT's env fingerprint for the app (values for plain keys, a keyed hash for secrets) to compare with get_env_fingerprint.", properties: { app: APP }, required: ["app"], request: (a) => ({ method: "GET", path: `/api/apps/${enc(a.app)}/env/peer-fingerprint` }) },
  { name: "get_env_fingerprint", readOnly: true, description: "This environment's env fingerprint for the app (secrets as a keyed hash, never their value).", properties: { app: APP }, required: ["app"], request: (a) => ({ method: "GET", path: `/api/apps/${enc(a.app)}/env/fingerprint` }) },
  { name: "deploy", readOnly: false, description: "Start a deploy (as plan_deploy plans it). Refused for a key in PROD: PROD takes a browser session.", properties: { app: APP, version: s("The version."), pin_from: s("Optional earlier successful deploy id."), request_id: REQUEST_ID }, required: ["app", "version", "request_id"], request: (a) => ({ method: "POST", path: `/api/apps/${enc(a.app)}/deploy`, body: { version: a.version, ...(a.pin_from ? { pinFrom: a.pin_from } : {}) } }) },
  { name: "build", readOnly: false, description: "Build the app's own images at a version (UAT only).", properties: { app: APP, version: s("The version."), request_id: REQUEST_ID }, required: ["app", "version", "request_id"], request: (a) => ({ method: "POST", path: `/api/apps/${enc(a.app)}/build`, body: { version: a.version } }) },
  { name: "set_env_values", readOnly: false, description: "Save a new env revision. base is the revision the change is based on (get_env); values lists every key of the new revision: {key, value} or {key, keep: true} to keep a secret unseen. Writes nothing to the server (apply_env does).", properties: { app: APP, base: n("The revision this change is based on."), values: { type: "array", items: { type: "object" }, description: "Every key of the new revision." }, note: s("Optional note."), request_id: REQUEST_ID }, required: ["app", "base", "values", "request_id"], request: (a) => ({ method: "PUT", path: `/api/apps/${enc(a.app)}/env`, body: { base: a.base, values: a.values, ...(a.note ? { note: a.note } : {}) } }) },
  { name: "apply_env", readOnly: false, description: "Write an env revision to the server and restart what reads it (as plan_env plans it). Refused for a key in PROD.", properties: { app: APP, revision: n("The revision."), request_id: REQUEST_ID }, required: ["app", "revision", "request_id"], request: (a) => ({ method: "POST", path: `/api/apps/${enc(a.app)}/env/apply`, body: { revision: a.revision } }) },
  { name: "import_env", readOnly: false, description: "Read the app's env file on the server into a new revision (the first step before the Deployer writes it).", properties: { app: APP, request_id: REQUEST_ID }, required: ["app", "request_id"], request: (a) => ({ method: "POST", path: `/api/apps/${enc(a.app)}/env/import`, body: {} }) },
  { name: "stop_deploy", readOnly: false, description: "Stop a deploy that waits at a manual step; what is done stays done. Refused for a key in PROD.", properties: { job: s("The deploy id."), request_id: REQUEST_ID }, required: ["job", "request_id"], request: (a) => ({ method: "POST", path: `/api/jobs/${enc(a.job)}/stop`, body: {} }) },
  { name: "check_manual_item", readOnly: false, description: "Tick (or untick) one item of the manual step a deploy waits at. Refused for a key in PROD.", properties: { job: s("The deploy id."), component: s("The manual component id."), index: n("The item, from 0."), checked: { type: "boolean", description: "Optional, default true." }, request_id: REQUEST_ID }, required: ["job", "component", "index", "request_id"], request: (a) => ({ method: "POST", path: `/api/jobs/${enc(a.job)}/checks`, body: { component: a.component, index: a.index, checked: a.checked !== false } }) },
];

/** Tool arguments: only the declared ones, the required ones present, of the declared type. */
export function checkArgs(tool: Tool, args: Record<string, unknown>): string | null {
  const unknown = Object.keys(args).filter((k) => !tool.properties[k]);
  if (unknown.length) return `${tool.name} 没有参数 ${unknown.join("、")}`;
  const missing = (tool.required ?? []).filter((k) => args[k] === undefined || args[k] === null || args[k] === "");
  if (missing.length) return `${tool.name} 缺参数 ${missing.join("、")}`;
  for (const [k, v] of Object.entries(args)) {
    const t = tool.properties[k]!.type;
    const ok = t === "integer" ? Number.isInteger(v) : t === "array" ? Array.isArray(v) : t === "object" ? typeof v === "object" && v !== null && !Array.isArray(v) : typeof v === t;
    if (!ok) return `${tool.name} 的参数 ${k} 应为 ${t}`;
  }
  if (!tool.readOnly && (typeof args.request_id !== "string" || args.request_id.length > 100)) return `${tool.name} 的 request_id 要是 100 字以内的文字`;
  return null;
}

export interface McpContext {
  principal: Principal;
  store: Store;
  /** One request to the Deployer's API as this principal. */
  call: (spec: ReturnType<Tool["request"]>) => Promise<{ status: number; body: any }>;
}

const rpc = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
const text = (value: unknown, isError = false) => ({ content: [{ type: "text", text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });

/** Answers one JSON-RPC message; null for a notification. */
export async function handleMcp(message: any, ctx: McpContext): Promise<unknown> {
  const { principal, store } = ctx;
  const id = message?.id;
  const visible = TOOLS.filter((t) => principal.via !== "service" || t.readOnly);
  if (message?.id === undefined) return null;
  switch (message?.method) {
    case "initialize":
      return rpc(id, { protocolVersion: message.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "open-atlas-deployer", version: "1" } });
    case "ping":
      return rpc(id, {});
    case "tools/list":
      return rpc(id, { tools: visible.map((t) => ({
        name: t.name, description: t.description,
        inputSchema: { type: "object", properties: t.properties, ...(t.required ? { required: t.required } : {}), additionalProperties: false },
        annotations: { readOnlyHint: t.readOnly, destructiveHint: !t.readOnly, idempotentHint: t.readOnly || undefined, openWorldHint: false },
      })) });
    case "tools/call": {
      const name = String(message.params?.name ?? "");
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
      const tool = visible.find((t) => t.name === name);
      if (!tool) return rpc(id, text({ finding: { code: "mcp/unknown-tool", at: ["name"], expected: `one of ${visible.map((t) => t.name).join(", ")}` } }, true));
      const bad = checkArgs(tool, args);
      if (bad) return rpc(id, text({ finding: { code: "mcp/arguments", at: [tool.name], expected: bad } }, true));
      const keyId = principal.keyId ?? principal.id;
      if (!tool.readOnly) {
        const earlier = store.mcpAnswer(keyId, String(args.request_id));
        if (earlier) {
          if (earlier.tool !== tool.name) return rpc(id, text({ finding: { code: "mcp/request-id-reused", at: ["request_id"], expected: `a new request_id (this one was used for ${earlier.tool})` } }, true));
          return rpc(id, earlier.response);
        }
      }
      const { request_id: requestId, ...rest } = args;
      const answer = await ctx.call(tool.request(rest));
      const ok = answer.status < 400;
      const result = ok ? text(answer.body) : text({ finding: { code: answer.body?.error ?? `http/${answer.status}`, at: [tool.name], expected: answer.body?.message ?? `HTTP ${answer.status}` }, ...(answer.body?.details?.length ? { details: answer.body.details } : {}) }, true);
      store.audit({ id: principal.id, via: principal.via === "service" ? "service" : "key" }, `mcp.${tool.name}`, String(args.app ?? args.job ?? "-"), { key: principal.keyId ?? null, status: answer.status, ...(requestId ? { requestId } : {}) });
      if (!tool.readOnly && ok) store.saveMcpAnswer(keyId, String(requestId), tool.name, result);
      return rpc(id, result);
    }
    default:
      return rpcError(id, -32601, `unknown method ${message?.method}`);
  }
}
