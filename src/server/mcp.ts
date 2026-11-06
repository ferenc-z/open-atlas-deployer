// The Deployer's MCP endpoint (§10.4, phase 6): POST /mcp speaks JSON-RPC (MCP streamable HTTP, JSON answers only).
// The bearer is an API key: personal (dpk_) or the Deploy Assistant's read-only service key (dps_).
//
// Every tool is ONE request to the Deployer's own API, dispatched in-process as the key's principal, so a tool has
// no authority, validation or audit of its own beyond the route's: the page and the AI run the same code. A refusal
// comes back as a finding (code / at / expected). Commands take a request_id: a retry with the same one returns the
// first answer instead of doing it twice. Arguments a tool does not declare are refused by name.
//
// Admin tools (§10.8, D38) read and change the Deployer's configuration: manifests, environment settings, the nginx
// recommendation, hosts, keys, the audit log. Only a personal key of a Workbench admin sees them. Saving them does not
// deploy anything; nothing secret (env values, tokens, keys) is ever a tool's answer.

import type { Principal } from "./auth.ts";
import type { Store } from "./store.ts";

interface Property { type: "string" | "integer" | "boolean" | "array" | "object"; description: string; items?: { type: "object" | "string" } }
type Method = "GET" | "POST" | "PUT" | "DELETE";
export interface Tool {
  name: string;
  description: string;
  /** Read-only tools are the only ones a service key sees, besides draft tools; the others change something (destructiveHint). */
  readOnly: boolean;
  /** Writes only an assessment's draft (§10.5.6): the service key sees it, and the route checks the task token. */
  draft?: boolean;
  /** D38: a Workbench admin's personal key only. */
  admin?: boolean;
  /** D38: destructiveHint, when it is not simply "changes something" (a save that deploys nothing is not destructive). */
  destructive?: boolean;
  properties: Record<string, Property>;
  required?: string[];
  request: (a: Record<string, unknown>) => { method: Method; path: string; query?: Record<string, unknown>; body?: unknown; headers?: Record<string, string> };
}

const s = (description: string): Property => ({ type: "string", description });
const n = (description: string): Property => ({ type: "integer", description });
const enc = (v: unknown) => encodeURIComponent(String(v));
const APP = s("The app id, as list_apps names it.");
const ASSESSMENT = s("The assessment id (asm_…).");

/** A draft tool: one draft operation, with the task token, a reason and a request_id. */
function draft(name: string, operation: string, description: string, properties: Record<string, Property>, required: string[]): Tool {
  return {
    name, readOnly: false, draft: true, description: `${description} Writes only the draft of the assessment the task token belongs to; needs reason.`,
    properties: { id: ASSESSMENT, ...properties, reason: s("Why this setting (recorded with the change)."), task_token: s("The task token from the assessment's first message."), request_id: REQUEST_ID },
    required: ["id", ...required, "reason", "task_token", "request_id"],
    request: (a) => {
      const { id, task_token: token, ...body } = a;
      return { method: "POST", path: `/api/assessments/${enc(id)}/draft/${operation}`, body, headers: { "x-task-token": String(token) } };
    },
  };
}
const REQUEST_ID = s("Any string unique to this command; send the same one again to retry without doing it twice.");
const NOTE = s("Why this change (kept with the revision and in the audit log).");
const PATCH: Property = { type: "array", items: { type: "object" }, description: "JSON Patch (RFC 6902) operations on the base revision, e.g. [{\"op\":\"replace\",\"path\":\"/components/0/source/image\",\"value\":\"postgres:16.6\"}]. Prefer it to sending the whole document." };
const BOUNDARY = "Only what is the same in every environment belongs in a manifest; a port, a data directory or the host for one environment goes in the environment settings (save_environment).";

/** D38: the admin tools. Each is one of the page's own API calls; the route checks, audits and refuses. */
const ADMIN: Tool[] = [
  { name: "get_manifest", readOnly: true, admin: true, description: `One manifest of an app with its revision number (base for save_manifest): the newest revision of the newest range unless applies_from or revision say otherwise, and the app's ranges. ${BOUNDARY}`,
    properties: { app: APP, applies_from: s("Optional: the range (its appliesFrom version)."), revision: n("Optional: a revision of that range.") }, required: ["app"],
    request: (a) => ({ method: "GET", path: `/api/apps/${enc(a.app)}/manifest`, query: { applies_from: a.applies_from, revision: a.revision } }) },
  { name: "validate_manifest", readOnly: true, admin: true, description: "Shows what save_manifest would save, without saving: the merged manifest, findings (code / at / expected), warnings (a changed source needs UAT again), the diff, and which versions the range covers, split into those already deployed (they keep their own revision) and those never deployed (they would take this one).",
    properties: { app: APP, applies_from: s("The range to change (one of get_manifest's ranges)."), new_applies_from: s("Or: start a new range from this version (the patch applies to applies_from's revision)."), base: n("The revision the change is made on, from get_manifest."), patch: PATCH, manifest: { type: "object", description: "Or the whole manifest." } }, required: ["app"],
    request: (a) => ({ method: "POST", path: `/api/apps/${enc(a.app)}/manifests/validate`, body: manifestBody(a) }) },
  { name: "save_manifest", readOnly: false, admin: true, destructive: false, description: `Saves a manifest change as a new revision (UAT only; PROD takes manifests from UAT with each promotion). Say which range: applies_from changes it, new_applies_from starts one; base must be that range's newest revision, or it is refused (409) and you read it again. Takes effect at the next deploy. Changing release.repo is done only on the page. ${BOUNDARY}`,
    properties: { app: APP, applies_from: s("The range to change."), new_applies_from: s("Or: start a new range from this version."), base: n("The revision the change is made on (from get_manifest)."), patch: PATCH, manifest: { type: "object", description: "Or the whole manifest." }, note: NOTE, request_id: REQUEST_ID }, required: ["app", "note", "request_id"],
    request: (a) => ({ method: "PUT", path: `/api/apps/${enc(a.app)}/manifests`, body: { ...manifestBody(a), note: a.note } }) },
  { name: "get_environment", readOnly: true, admin: true, description: "The environment settings (hosts, domain, registries, each app's version, host, ingress, overrides, settings) at their newest revision or the one given, with every revision and what it changed.",
    properties: { revision: n("Optional: an earlier revision.") }, request: (a) => ({ method: "GET", path: "/api/environment", query: { revision: a.revision } }) },
  { name: "validate_environment", readOnly: true, admin: true, description: "Shows what save_environment would save, without saving: the merged settings, findings (at / expected), changed paths and the diff.",
    properties: { base: n("The revision the change is made on, from get_environment."), patch: PATCH, environment: { type: "object", description: "Or the whole settings." } }, required: ["base"],
    request: (a) => ({ method: "POST", path: "/api/environment/validate", body: { base: a.base, patch: a.patch, environment: a.environment } }) },
  { name: "save_environment", readOnly: false, admin: true, destructive: false, description: "Saves a change of the environment settings as a new revision; base must be the newest revision, or it is refused (409). Nothing is deployed: plans use the new settings from the next deploy on.",
    properties: { base: n("The revision the change is made on."), patch: PATCH, environment: { type: "object", description: "Or the whole settings." }, note: NOTE, request_id: REQUEST_ID }, required: ["base", "note", "request_id"],
    request: (a) => ({ method: "PUT", path: "/api/environment", body: { base: a.base, patch: a.patch, environment: a.environment, note: a.note } }) },
  { name: "get_ingress", readOnly: true, admin: true, description: "How each app is reached (through nginx or directly), the recommended nginx configuration now and its saved revisions, and the internal CA's subject and validity.",
    properties: {}, request: () => ({ method: "GET", path: "/api/ingress" }) },
  { name: "get_nginx_config", readOnly: true, admin: true, description: "One saved revision of the recommended nginx configuration, as text.",
    properties: { revision: n("The revision.") }, required: ["revision"], request: (a) => ({ method: "GET", path: `/api/ingress/nginx/${enc(a.revision)}` }) },
  { name: "save_nginx_config", readOnly: false, admin: true, destructive: false, description: "Saves the recommended nginx configuration as it is now as a new revision, for operations to apply (nginx is not touched).",
    properties: { note: NOTE, request_id: REQUEST_ID }, required: ["note", "request_id"], request: (a) => ({ method: "POST", path: "/api/ingress/nginx", body: { note: a.note } }) },
  { name: "list_hosts", readOnly: true, admin: true, description: "The hosts, their executors (online, version, upgrade), the apps on each, and their tokens' prefixes (never the tokens).",
    properties: {}, request: () => ({ method: "GET", path: "/api/hosts" }) },
  { name: "revoke_host_token", readOnly: false, admin: true, destructive: true, description: "Revokes every executor token of a host: its executor stops reaching the Deployer at once, until an administrator issues a new token on the page.",
    properties: { host: s("The host, as list_hosts names it."), note: NOTE, request_id: REQUEST_ID }, required: ["host", "note", "request_id"], request: (a) => ({ method: "POST", path: `/api/hosts/${enc(a.host)}/revoke`, body: {} }) },
  { name: "list_keys", readOnly: true, admin: true, description: "API keys: name, kind, owner, prefix, expiry, last use (never the keys).",
    properties: {}, request: () => ({ method: "GET", path: "/api/keys" }) },
  { name: "revoke_key", readOnly: false, admin: true, destructive: true, description: "Revokes an API key at once.",
    properties: { id: s("The key's id, from list_keys."), note: NOTE, request_id: REQUEST_ID }, required: ["id", "note", "request_id"], request: (a) => ({ method: "DELETE", path: `/api/keys/${enc(a.id)}` }) },
  { name: "list_audit", readOnly: true, admin: true, description: "The audit log, newest first: who did what to what, and when (e.g. who changed a manifest).",
    properties: { actor: s("Optional: only this actor."), action: s("Optional: actions starting with this, e.g. manifest."), target: s("Optional: targets starting with this, e.g. shop."), since: s("Optional: ISO time."), limit: n("Optional, default 100.") },
    request: (a) => ({ method: "GET", path: "/api/audit", query: { actor: a.actor, action: a.action, target: a.target, since: a.since, limit: a.limit } }) },
];

function manifestBody(a: Record<string, unknown>) {
  return { appliesFrom: a.applies_from, newAppliesFrom: a.new_applies_from, base: a.base, patch: a.patch, manifest: a.manifest };
}

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
  // Managed services (service ops §10, phase 1): what was taken over, and how it is doing.
  { name: "list_service_clusters", readOnly: true, description: "The managed services (NiFi) registered in this environment: clusters with their nodes and standalone instances, each with version, profile, hosts and install directories, configuration revision, and in short how many members are running (live, from the service executors' samples), as of when, and the soonest certificate expiry.", properties: {}, request: () => ({ method: "GET", path: "/api/services" }) },
  { name: "get_cluster_status", readOnly: true, description: "One cluster or standalone instance (id from list_service_clusters): every member with its host's service executor (online or not) and its state from the collector's newest sample: running or stopped as of that sample (asOf), unknown after 3 sampling periods without one, lost when the executor is offline; never sampled: as of the newest discovery (source). Also the live pid, version, cluster connection, key numbers and every certificate with its expiry.", properties: { id: s("The cluster's or standalone instance's id, as list_service_clusters names it.") }, required: ["id"], request: (a) => ({ method: "GET", path: `/api/services/${enc(a.id)}/status` }) },
  // Assessments (§10.5.6): the Onboarding Assessor reads these and writes only its own draft, with the task token.
  { name: "onboarding_draft", readOnly: true, description: "An assessment: its draft (the manifest being built, env keys), every change with who and why, the scanned facts, findings of the last validation, report.", properties: { id: ASSESSMENT }, required: ["id"], request: (a) => ({ method: "GET", path: `/api/assessments/${enc(a.id)}` }) },
  { name: "environment_facts", readOnly: true, description: "Ports, service names and data paths this environment already uses, per app; no env values.", properties: {}, request: () => ({ method: "GET", path: "/api/environment-facts" }) },
  { name: "validate_draft", readOnly: true, description: "Runs every program check on the draft (schema, conflicts with other apps, compose generation, forbidden fields, release tag) and returns the findings; none means it may be trial-deployed.", properties: { id: ASSESSMENT }, required: ["id"], request: (a) => ({ method: "POST", path: `/api/assessments/${enc(a.id)}/validate`, body: {} }) },
  draft("draft_app", "app", "The app's id, name and release: app, name, applies_from, release_repo (owner/name), tag_pattern (e.g. v{version}), release_manifest (release.json or package.json), optional bundle_asset (e.g. my-{version}.tar.gz) and bundle_repo.", { app: s("The app id (lowercase)."), name: s("Display name."), applies_from: s("Version the manifest applies from."), release_repo: s("owner/name of the release repository."), tag_pattern: s("Tag pattern with {version}."), release_manifest: s("release.json or package.json."), bundle_asset: s("Optional Release asset with {version}."), bundle_repo: s("Optional, defaults to release_repo.") }, ["app"]),
  draft("draft_component", "component", "Add or change a component: component (id), type (compose-service, workbench-app, oma-agent, db-migration, studio-graph, manual), depends_on.", { component: s("Component id."), type: s("Component type."), depends_on: { type: "array", items: { type: "string" }, description: "Optional component ids it waits for." } }, ["component", "type"]),
  draft("remove_draft_component", "remove-component", "Remove a component from the draft.", { component: s("Component id.") }, ["component"]),
  draft("draft_source", "source", "A component's one source (§5.1): {kind: public-registry, image: name:fixed-tag} or {kind: company-registry, registry, image, build?}.", { component: s("Component id."), source: { type: "object", description: "The source object." } }, ["component", "source"]),
  draft("draft_runtime", "runtime", "A component's runtime settings, the ones the Deployer generates compose from: service, ports [{container, host?}], volumes [{target, path | file}], health (image, none or a test array), command, environment {KEY: value or ${KEY}}, envFile; for other types their fields (dir, savedQueries, file, bind, steps, when, target, migrations, …).", { component: s("Component id."), service: s("Optional compose service name (unique across apps)."), ports: { type: "array", items: { type: "object" }, description: "Optional." }, volumes: { type: "array", items: { type: "object" }, description: "Optional." }, health: { type: "array", items: { type: "string" }, description: "Optional test array; or use command for image / none via draft_compose_extra." }, command: { type: "array", items: { type: "string" }, description: "Optional." }, environment: { type: "object", description: "Optional." }, envFile: { type: "boolean", description: "Optional: pass the whole env file." }, steps: { type: "array", items: { type: "string" }, description: "manual: the checklist." }, when: s("manual: install or always."), target: s("db-migration: the database component."), migrations: s("db-migration: directory."), install: s("db-migration: directory."), dir: s("studio-graph."), savedQueries: s("studio-graph."), file: s("oma-agent."), bind: s("oma-agent.") }, ["component"]),
  draft("draft_compose_extra", "compose-extra", "Advanced: extra compose fields for a component (validated; privileged, host namespaces, build and the like are refused).", { component: s("Component id."), fields: { type: "object", description: "compose fields." } }, ["component", "fields"]),
  draft("draft_env_key", "env-key", "An env key the app needs: key, description, secret (a secret has no default: a person fills it), default for a plain key.", { key: s("UPPER_CASE key."), description: s("What it is."), secret: { type: "boolean", description: "Whether it is a secret." }, default: s("Optional default, plain keys only.") }, ["key", "description", "secret"]),
  draft("remove_draft_env_key", "remove-env-key", "Remove an env key from the draft.", { key: s("The key.") }, ["key"]),
  draft("draft_report", "report", "The assessment report: level A, B, C or D (a version assessment: unchanged, or the level of the new draft) and the report (conclusion, level, components, what is missing and how, risks, what people must decide).", { level: s("A, B, C, D or unchanged."), report: s("The report, in the person's language.") }, ["level", "report"]),
  draft("draft_issue", "issue", "Draft an issue for the Deployer's own repository: kind onboarding (what the repository's author should change) or capability (what the Deployer lacks). A person opens it.", { kind: s("onboarding or capability."), title: s("Title."), body: s("Body: source repository and version, what is missing where, the suggested change, how it would deploy then.") }, ["kind", "title", "body"]),
  { name: "deploy", readOnly: false, description: "Start a deploy (as plan_deploy plans it). Refused for a key in PROD: PROD takes a browser session.", properties: { app: APP, version: s("The version."), pin_from: s("Optional earlier successful deploy id."), request_id: REQUEST_ID }, required: ["app", "version", "request_id"], request: (a) => ({ method: "POST", path: `/api/apps/${enc(a.app)}/deploy`, body: { version: a.version, ...(a.pin_from ? { pinFrom: a.pin_from } : {}) } }) },
  { name: "build", readOnly: false, description: "Build the app's own images at a version (UAT only).", properties: { app: APP, version: s("The version."), request_id: REQUEST_ID }, required: ["app", "version", "request_id"], request: (a) => ({ method: "POST", path: `/api/apps/${enc(a.app)}/build`, body: { version: a.version } }) },
  { name: "set_env_values", readOnly: false, description: "Save a new env revision. base is the revision the change is based on (get_env); values lists every key of the new revision: {key, value} or {key, keep: true} to keep a secret unseen. Writes nothing to the server (apply_env does).", properties: { app: APP, base: n("The revision this change is based on."), values: { type: "array", items: { type: "object" }, description: "Every key of the new revision." }, note: s("Optional note."), request_id: REQUEST_ID }, required: ["app", "base", "values", "request_id"], request: (a) => ({ method: "PUT", path: `/api/apps/${enc(a.app)}/env`, body: { base: a.base, values: a.values, ...(a.note ? { note: a.note } : {}) } }) },
  { name: "apply_env", readOnly: false, description: "Write an env revision to the server and restart what reads it (as plan_env plans it). Refused for a key in PROD.", properties: { app: APP, revision: n("The revision."), request_id: REQUEST_ID }, required: ["app", "revision", "request_id"], request: (a) => ({ method: "POST", path: `/api/apps/${enc(a.app)}/env/apply`, body: { revision: a.revision } }) },
  { name: "import_env", readOnly: false, description: "Read the app's env file on the server into a new revision (the first step before the Deployer writes it).", properties: { app: APP, request_id: REQUEST_ID }, required: ["app", "request_id"], request: (a) => ({ method: "POST", path: `/api/apps/${enc(a.app)}/env/import`, body: {} }) },
  { name: "stop_deploy", readOnly: false, description: "Stop a deploy that waits at a manual step; what is done stays done. Refused for a key in PROD.", properties: { job: s("The deploy id."), request_id: REQUEST_ID }, required: ["job", "request_id"], request: (a) => ({ method: "POST", path: `/api/jobs/${enc(a.job)}/stop`, body: {} }) },
  { name: "check_manual_item", readOnly: false, description: "Tick (or untick) one item of the manual step a deploy waits at. Refused for a key in PROD.", properties: { job: s("The deploy id."), component: s("The manual component id."), index: n("The item, from 0."), checked: { type: "boolean", description: "Optional, default true." }, request_id: REQUEST_ID }, required: ["job", "component", "index", "request_id"], request: (a) => ({ method: "POST", path: `/api/jobs/${enc(a.job)}/checks`, body: { component: a.component, index: a.index, checked: a.checked !== false } }) },
  ...ADMIN,
];

/** Tool arguments: only the declared ones, the required ones present, of the declared type. */
export function checkArgs(tool: Tool, args: Record<string, unknown>): string | null {
  const unknown = Object.keys(args).filter((k) => !tool.properties[k]);
  if (unknown.length) return `${tool.name} has no parameter ${unknown.join(", ")}`;
  const missing = (tool.required ?? []).filter((k) => args[k] === undefined || args[k] === null || args[k] === "");
  if (missing.length) return `${tool.name} is missing parameter ${missing.join(", ")}`;
  for (const [k, v] of Object.entries(args)) {
    const t = tool.properties[k]!.type;
    const ok = t === "integer" ? Number.isInteger(v) : t === "array" ? Array.isArray(v) : t === "object" ? typeof v === "object" && v !== null && !Array.isArray(v) : typeof v === t;
    if (!ok) return `Parameter ${k} of ${tool.name} should be ${t}`;
  }
  if (!tool.readOnly && (typeof args.request_id !== "string" || args.request_id.length > 100)) return `request_id of ${tool.name} must be text of at most 100 characters`;
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
  const admin = principal.via !== "service" && principal.permissions.includes("admin");
  const visible = TOOLS.filter((t) => (t.admin ? admin : principal.via !== "service" || t.readOnly || t.draft));
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
        annotations: { readOnlyHint: t.readOnly, destructiveHint: t.destructive ?? !t.readOnly, idempotentHint: t.readOnly || undefined, openWorldHint: false },
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
      store.audit({ id: principal.id, via: principal.via === "service" ? "service" : "key" }, `mcp.${tool.name}`, String(args.app ?? args.job ?? args.host ?? args.id ?? "-"), { key: principal.keyId ?? null, status: answer.status, ...(requestId ? { requestId } : {}), ...(typeof args.note === "string" ? { note: args.note } : {}) });
      if (!tool.readOnly && ok) store.saveMcpAnswer(keyId, String(requestId), tool.name, result);
      return rpc(id, result);
    }
    default:
      return rpcError(id, -32601, `unknown method ${message?.method}`);
  }
}
