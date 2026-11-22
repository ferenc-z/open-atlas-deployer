// The Deployer's MCP endpoint (§10.4, phase 6): POST /mcp speaks JSON-RPC (MCP streamable HTTP, JSON answers only).
// The bearer is an API key: personal (dpk_), the Deploy Assistant's service key (dps_) or the scheduled check-up's
// key (dpc_). Which tools a key sees (pages-rethink §10.2.3): a personal key as its owner may (admin tools and
// publish_model / record for a Workbench admin only); the Assistant's key the read-only and draft tools plus
// publish_model and record (to-dos only, P4, P5); the check-up's key the managed-service verbs except draft_change.
// A tool a key may not use is not listed for it.
//
// Every tool is ONE request to the Deployer's own API, dispatched in-process as the key's principal, so a tool has
// no authority, validation or audit of its own beyond the route's: the page and the AI run the same code. A refusal
// comes back as a finding (code / at / expected). Commands take a request_id: a retry with the same one returns the
// first answer instead of doing it twice. Arguments a tool does not declare are refused by name.
//
// Admin tools (§10.8, D38) read and change the Deployer's configuration: manifests, environment settings, the nginx
// recommendation, hosts, keys, the audit log. Only a personal key of a Workbench admin sees them. Saving them does not
// deploy anything; nothing secret (env values, tokens, keys) is ever a tool's answer.

import { createHash } from "node:crypto";
import type { Principal } from "./auth.ts";
import type { Store } from "./store.ts";
import { installKey } from "./services/draft.ts";
import { LEVELS } from "./onboarding.ts";
import { aiDiffs, aiFindings } from "./services/configreview.ts";
import { redactProvenance, redactStrings, redactText } from "./services/redact.ts";

interface Property { type: "string" | "integer" | "boolean" | "array" | "object"; description: string; items?: { type: "object" | "string" } }
type Method = "GET" | "POST" | "PUT" | "DELETE";
export interface Tool {
  name: string;
  description: string;
  /** Read-only tools are the only ones a service key sees, besides draft tools; the others change something (destructiveHint). */
  readOnly: boolean;
  /** Writes only a draft, which a person turns into something: the service key sees it, and the route decides (an assessment's draft takes the task token, §10.5.6; a service's configuration draft touches no secret, §16.3). */
  draft?: boolean;
  /** D38: a Workbench admin's personal key only. */
  admin?: boolean;
  /** D38: destructiveHint, when it is not simply "changes something" (a save that deploys nothing is not destructive). */
  destructive?: boolean;
  properties: Record<string, Property>;
  required?: string[];
  request: (a: Record<string, unknown>) => { method: Method; path: string; query?: Record<string, unknown>; body?: unknown; headers?: Record<string, string> };
  /** What the AI gets of a successful answer, when not the route's body as it is (service ops: redacted, narrowed). */
  shape?: (body: any, a: Record<string, unknown>) => unknown;
  /** Checks beyond the declared types (look's kind); the reason it is refused, or null. */
  check?: (a: Record<string, unknown>) => string | null;
  /** §10.2.3: who sees it, when not by readOnly / draft / admin (the managed-service verbs). */
  access?: { personal: "all" | "admin"; assistant: boolean; checkup: boolean };
}

/** The three kinds of key (§10.2.3). */
export type Tier = "personal" | "assistant" | "checkup";
export const tierOf = (p: Pick<Principal, "via" | "keyKind">): Tier => (p.via !== "service" ? "personal" : p.keyKind === "checkup" ? "checkup" : "assistant");

/** The tools a key of this kind sees (admin: a Workbench admin's personal key). */
export function visibleTools(tier: Tier, admin: boolean): Tool[] {
  return TOOLS.filter((t) => {
    if (t.access) return tier === "personal" ? t.access.personal === "all" || admin : t.access[tier];
    if (t.admin) return tier === "personal" && admin;
    if (tier === "checkup") return false;
    return tier === "personal" || t.readOnly || Boolean(t.draft);
  });
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
    // D52: the route answers the whole assessment (the page needs it); the Agent gets a receipt, and reads the draft with get_draft.
    shape: (body, a) => {
      const keys = Array.isArray(a.keys) ? (a.keys as { key?: unknown }[]).map((k) => String(k?.key)).join(",") : undefined;
      const target = keys ?? [a.component, a.key, a.app, a.level, a.kind].find((v) => typeof v === "string" && v);
      return { ok: true, operation, ...(target ? { target } : {}), changes: Array.isArray(body?.changes) ? body.changes.length : 0 };
    },
  };
}

/** get_draft: the draft and its findings, without the change log, report, issue, facts and progress (D52). */
function draftOnly(body: Any) {
  const { manifest: _inner, ...draft } = body?.draft ?? {};
  return { draft, manifest: body?.manifest, findings: body?.findings ?? null };
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

// Managed services (pages-rethink §9.1 C3, §10.2.3): seven verbs. describe first (the two lights, the businesses, the
// to-dos, the newest analysis, the model's gaps, each pointing at the verb that fixes it); look for the raw data (one
// kind at a time, through the routes the pages had); trace one piece of data; run_model / publish_model for the business
// model (the gate decides); record writes the analysis and the to-dos back; draft_change drafts a configuration change a
// person saves. Everything that reaches the AI is redacted (log lines, bulletins, provenance, configuration, alert texts).
const SERVICE = s("The service's id: a cluster or standalone instance, as describe lists them.");
const strs = (description: string): Property => ({ type: "array", items: { type: "string" }, description });
type Any = Record<string, any>;

/** look kind metrics: per member and field the last, min, max and average over the range; the series only when asked for. */
function metricsShape(body: Any, a: Record<string, unknown>) {
  const units = Object.fromEntries(Object.entries(body.fields ?? {}).map(([k, v]) => [k, (v as Any).unit]));
  return {
    from: body.from, to: body.to, step: body.step, source: body.source, units,
    members: (body.members ?? []).map((m: Any) => {
      const summary = Object.fromEntries(Object.entries(m.values as Record<string, (number | null)[]>).map(([f, vs]) => {
        const xs = vs.filter((v): v is number => typeof v === "number");
        const avg = xs.length ? Math.round((xs.reduce((x, y) => x + y, 0) / xs.length) * 10) / 10 : null;
        return [f, { last: [...vs].reverse().find((v) => v !== null) ?? null, min: xs.length ? Math.min(...xs) : null, max: xs.length ? Math.max(...xs) : null, avg }];
      }));
      return { member: m.member, points: m.at.length, first: m.at[0] ?? null, last: m.at.at(-1) ?? null, summary, ...(a.series ? { at: m.at, values: m.values } : {}) };
    }),
  };
}

const memberMatches = (m: { host: string; installDir: string; confDir?: string }, want: unknown) => !want || installKey(m) === want || m.host === want;

/** look kind config: the redacted files of a revision; files other than properties and XML (not redacted at import) through the log redaction. */
function configShape(body: Any, a: Record<string, unknown>) {
  const members = (body.body?.members ?? []).filter((m: any) => memberMatches(m, a.member)).map((m: any) => ({
    key: installKey(m), host: m.host, installDir: m.installDir, ...(m.confDir ? { confDir: m.confDir } : {}), missing: m.missing ?? [],
    files: m.files.filter((f: Any) => !a.file || f.name === a.file).map((f: Any) => ({ name: f.name, path: f.path, format: f.format, sha256: f.sha256, modifiedAt: f.modifiedAt, hidden: f.secrets, text: f.format === "other" ? redactText(f.redacted) : f.redacted })),
  }));
  return { service: body.service, revision: body.revision, savedAt: body.savedAt, savedBy: body.savedBy, source: body.source, note: body.note, revisions: body.revisions ?? [], members };
}

/** draft_change: what the draft means, for the Assistant to explain; nothing about any secret. */
function draftShape(body: Any) {
  const preview = (body.preview ?? {}) as Any;
  const change = preview.change as Any | null | undefined;
  return redactStrings({
    draft: body.id, service: body.service, base: body.base, state: body.state, saved: false, note: body.note, changes: body.changes,
    ...(preview.problem ? { problem: preview.problem } : {
      changesAnyFile: (preview.members ?? []).length > 0,
      findings: aiFindings(preview.findings ?? []),
      // whole-cluster is config/not-rolling-safe: all the nodes stop and start together; rolling: one at a time.
      restart: !change?.restart && change?.mode !== "full" ? "none" : body.kind !== "cluster" ? "restart" : change.mode === "full" ? "whole-cluster" : "rolling",
      fullBecause: change?.fullBecause ?? [],
      differences: aiDiffs(preview.members ?? []),
    }),
    next: "Nothing is saved or applied: a person reviews this draft on the page. End your reply with an open_service_change card for it.",
  });
}

/** look kind drift: which files, and the redacted differences; no hashes (§16.3). */
function driftShape(body: Any) {
  return redactStrings({
    service: body.service, known: body.known, drifted: body.drifted,
    members: (body.members ?? []).map((m: Any) => ({ member: m.member, state: m.state, reason: m.reason, asOf: m.asOf, files: m.files.map((f: Any) => ({ name: f.name, path: f.path, state: f.state, revision: f.revision, seenAt: f.actualAt })) })),
    ...(body.differences ? { differences: { member: body.differences.member, files: body.differences.files.map((f: Any) => ({ name: f.name, path: f.path, change: f.change, diff: f.diff, secretsChanged: f.secretsChanged, opened: f.opened })) }, legend: "diff: + is on the host, - is what it should be, ... is left out. secretsChanged: secrets whose value differs, by name only." } : {}),
  });
}

/** look kind config-diff: two revisions (base → revision), the redacted differences with a changed secret only by name; or a revision's nodes. */
function diffShape(body: Any, a: Record<string, unknown>) {
  if (a.base !== undefined || (a.revision !== undefined && body.from !== undefined)) return { service: body.service, from: body.from, to: body.to, members: aiDiffs(body.members ?? []), legend: "diff: + is in to, - is in from, ... is left out. secretsChanged: secrets whose value differs, by name only." };
  const nodes = (body.body?.members ?? []).map((m: any) => installKey(m));
  const compare = body.view?.compare as Any[] | null | undefined;
  if (!compare) return { service: body.service, revision: body.revision, kind: "standalone", nodes, files: [], note: "A standalone instance has no nodes to compare. Give base (and revision) to compare two revisions." };
  const files = compare.map((f) => ({
    name: f.name, identical: f.identical, differing: f.differing,
    rows: (f.rows as Any[]).filter((r) => r.severity).map((r) => ({ key: r.key, section: r.section, severity: r.severity, values: r.values.map((v: Any, i: number) => ({ node: nodes[i] ?? i, value: v.value, from: v.from })) })),
  }));
  return redactStrings({
    service: body.service, revision: body.revision, kind: "cluster", nodes, files,
    legend: "severity error: the nodes must agree (secret or grouping key); warning: they should agree, or the catalog does not know the key; info: a per-node key. Secrets read \"(hidden)\" or are compared as value A / value B. from: file, default (the catalog's, not in the file) or unset.",
  });
}

/** look kind queues: the newest back pressure reading and each member's queued numbers (get_cluster_status's summary). */
function queuesShape(body: Any) {
  return redactStrings({
    asOf: body.asOf ?? null, backpressure: body.summary?.backpressure ?? null,
    members: (body.members ?? []).map((m: Any) => ({ key: m.key, state: m.state, at: m.live?.at ?? null, queuedCount: m.live?.point?.queuedCount ?? null, queuedBytes: m.live?.point?.queuedBytes ?? null, bpFull: m.live?.point?.bpFull ?? null, bpMaxPct: m.live?.point?.bpMaxPct ?? null })),
  });
}

export const LOOK_KINDS = ["metrics", "logs", "provenance", "lineage", "event", "bulletins", "queues", "topology", "flow-counts",
  "events", "evidence", "components", "config", "config-diff", "drift", "changes", "property", "members", "model"] as const;
export type LookKind = (typeof LOOK_KINDS)[number];

const HOUR_MS = 3_600_000;
/** A provenance search needs both ends: the last hour by default. */
const range = (a: Record<string, unknown>) => {
  const to = typeof a.to === "string" ? a.to : new Date().toISOString();
  return { from: typeof a.from === "string" ? a.from : new Date(Date.parse(to) - HOUR_MS).toISOString(), to };
};

function lookRequest(a: Record<string, unknown>): ReturnType<Tool["request"]> {
  const base = `/api/services/${enc(a.service)}`;
  const q = typeof a.query === "string" ? a.query : undefined;
  switch (a.kind as LookKind) {
    case "metrics": return { method: "GET", path: `${base}/metrics`, query: { range: a.from || a.to ? undefined : "1h", from: a.from, to: a.to, member: a.member, fields: Array.isArray(a.fields) ? a.fields.join(",") : undefined } };
    case "logs": return { method: "POST", path: `${base}/logs/search`, body: { from: a.from, to: a.to, ...(a.member ? { members: [a.member] } : {}), ...(a.levels ? { levels: a.levels } : {}), ...(q ? { query: q } : {}), ...(a.regex ? { regex: true } : {}), ...(a.limit ? { limit: a.limit } : {}) } };
    case "provenance": {
      const by = a.uuid ? { uuid: a.uuid } : a.component ? { field: "ProcessorID", value: a.component } : q && q.includes("=") ? { field: q.slice(0, q.indexOf("=")).trim(), value: q.slice(q.indexOf("=") + 1).trim() } : {};
      return { method: "POST", path: `${base}/provenance`, body: { ...by, ...range(a), ...(a.limit ? { maxResults: a.limit } : {}), ...(a.member ? { node: a.member } : {}) } };
    }
    case "lineage": return { method: "POST", path: `${base}/lineage`, body: { ...(a.uuid ? { uuid: a.uuid } : { eventId: a.eventId }), ...(q ? { direction: q } : {}), ...(a.member ? { node: a.member } : {}) } };
    case "event": return { method: "GET", path: `${base}/provenance/events/${enc(a.eventId)}`, query: { node: a.member } };
    case "bulletins": return { method: "GET", path: `${base}/bulletins`, query: { level: Array.isArray(a.levels) ? a.levels[0] : undefined, from: a.from, to: a.to, limit: a.limit } };
    case "queues": case "members": return { method: "GET", path: `${base}/status` };
    case "topology": return { method: "GET", path: `${base}/topology` };
    case "flow-counts": return { method: "GET", path: `${base}/flow-counts`, query: { from: a.from, to: a.to, ref: a.component, limit: a.limit } };
    case "events": return { method: "GET", path: `${base}/events`, query: { from: a.from, to: a.to, kind: q, limit: a.limit } };
    case "evidence": return { method: "GET", path: `${base}/investigate`, query: { member: a.member, from: a.from, to: a.to, focus: q, compact: "1" } };
    case "components": return { method: "GET", path: `${base}/components`, query: { q: q ?? a.component } };
    case "config": return { method: "GET", path: `${base}/config`, query: { revision: a.revision } };
    case "config-diff": return a.base !== undefined
      ? { method: "GET", path: `${base}/config/diff`, query: { from: a.base, to: a.revision, member: a.member } }
      : { method: "GET", path: `${base}/config`, query: { revision: a.revision } };
    case "drift": return { method: "GET", path: `${base}/drift`, query: { member: a.member } };
    case "changes": return q ? { method: "GET", path: `${base}/changes/${enc(q)}` } : { method: "GET", path: `${base}/changes` };
    // A dotted word is a key (exact), anything else words to look for.
    case "property": return { method: "GET", path: "/api/service-properties", query: { service: a.service, ...(q && /^[\w-]+(\.[\w-]+)+$/.test(q) ? { key: q } : { q }), file: a.file, limit: a.limit } };
    case "model": return { method: "GET", path: `${base}/model` };
  }
}

function lookShape(body: Any, a: Record<string, unknown>) {
  const kind = a.kind as LookKind;
  const data = kind === "metrics" ? metricsShape(body, a) : kind === "config" ? configShape(body, a) : kind === "config-diff" ? diffShape(body, a)
    : kind === "drift" ? driftShape(body) : kind === "queues" ? queuesShape(body)
    : kind === "provenance" || kind === "lineage" || kind === "event" ? redactProvenance(body) : redactStrings(body);
  const notes = Array.isArray(body?.notes) ? body.notes.filter((x: unknown) => typeof x === "string") : [];
  return { kind, data, truncated: Boolean(body?.truncated || body?.limitReached || body?.cut), notes };
}

/** What look needs besides the declared types: a known kind, and the ids some kinds cannot do without. */
function lookCheck(a: Record<string, unknown>): string | null {
  if (!LOOK_KINDS.includes(a.kind as LookKind)) return `kind is one of ${LOOK_KINDS.join(", ")}`;
  if (a.kind === "event" && a.eventId === undefined) return "kind event needs eventId";
  if (a.kind === "lineage" && !a.uuid && a.eventId === undefined) return "kind lineage needs uuid or eventId";
  if (a.kind === "components" && !a.query && !a.component) return "kind components needs query (part of a name) or component (an id)";
  return null;
}

const VERBS: Tool[] = [
  { name: "describe", readOnly: true, access: { personal: "all", assistant: true, checkup: true },
    description: "Start here. Without service: every managed service (NiFi) with its machine light and business light (failing, attention, healthy, unknown), a sentence each, the number of open to-dos and its gaps. With service: the machine light (six checks: process, disk, heap, certificate, coordinator, collection, with member and since), the business light and its businesses, the open to-dos, the newest AI analysis (stale: over an hour old or a light changed since), the business model (revision), whether provenance can be read, and gaps: what keeps the business picture from being right (no-model, unconfirmed, gate-rejected, topology-changed, no-exit, no-stuck-times, s2s-unpaired, no-counts), each with fix: the verb (and arguments) that fixes it. flow adds that business's detail.",
    properties: { service: s("Optional: one service."), flow: s("Optional with service: one business (flw_…) of it.") },
    request: (a) => ({ method: "GET", path: "/api/describe", query: { service: a.service, flow: a.flow } }), shape: redactStrings },
  { name: "look", readOnly: true, access: { personal: "all", assistant: true, checkup: true },
    description: "The raw data of one service, one kind at a time (answers {kind, data, truncated, notes}, secret-looking parts hidden). kind: metrics (per member and field last/min/max/avg; fields e.g. heapPct, gcMsPerMin, queuedCount, bpFull, bpMaxPct, repoContentPct, cpuPct, diskPct; series: true for the points), logs (every node at once, merged by time; query text or regex, levels, member; the last hour by default), provenance (NiFi's FlowFile trace in from–to, the last hour by default: by uuid, component (a processor id) or query \"Field=value\" e.g. Filename=a.csv; at most 100 events; on a cluster member = a node's clusterNodeId), lineage (uuid, or eventId with query PARENTS or CHILDREN; member = the event's clusterNodeId), event (one provenance event's details and attributes, never content: eventId, member), bulletins (levels[0] ERROR/WARNING/INFO), queues (the newest back pressure reading and each member's queue), members (every member: state as of when, executor, version, connection, certificates), topology (the canvas: root groups, links, S2S, and the skeleton's questions), flow-counts (5-minute in/out/transferred per root group and S2S port, summed over from–to, default the last day; component = one row's ref for its buckets), events (the timeline: restarts, disconnects, alerts opened and resolved, changes; query = one kind), evidence (the Deployer's evidence cards over from–to, at most 24 hours: restarts and OOM, bulletins by component, new or surging log patterns, metrics off the day before, changes in the 24 hours before; query = a check or card to put first), components (NiFi components by name or id: query or component), config (the kept files, secrets (hidden); revision, member, file), config-diff (without base: a cluster node by node; with base: revision base → revision, a changed secret only by name), drift (whether the hosts still have the kept files; member for the changed lines), changes (changes made through the Deployer, the active one; query = one change's id), property (the property catalog: query words or a key, file), model (the business model: current with base revision for publish_model, a draft from the code's skeleton to start from, the businesses).",
    properties: { service: SERVICE, kind: s(`One of ${LOOK_KINDS.join(", ")}.`), from: s("Optional ISO time (UTC)."), to: s("Optional ISO time (UTC), now by default."), member: s("Optional: a member key (look kind members: members[].key) or, for provenance, a node's clusterNodeId."), component: s("Optional: a component id (provenance, components) or a flow-counts ref."), query: s("Optional: see kind."), uuid: s("Optional: a FlowFile UUID (provenance, lineage)."), eventId: n("Optional: a provenance event id (event, lineage)."), fields: strs("Optional metrics fields."), levels: strs("Optional log levels (TRACE … FATAL) or a bulletin level."), regex: { type: "boolean", description: "Optional: logs query is a regular expression." }, series: { type: "boolean", description: "Optional: metrics with every point." }, revision: n("Optional: a configuration revision (config, config-diff)."), base: n("Optional: config-diff from this revision."), file: s("Optional: one file name (config, property), e.g. nifi.properties."), limit: n("Optional: at most this many rows.") },
    required: ["service", "kind"], check: lookCheck, request: lookRequest, shape: lookShape },
  { name: "trace", readOnly: true, access: { personal: "all", assistant: true, checkup: true },
    description: "Follows one piece of business data through a service (and across services over S2S or MQ) by the business model, from what the person knows: a file name, an email sender or subject (at least one), optionally one business, in a time range (the last 24 hours by default). Answers the traces found (up to 20): each segment's steps (state, time, evidence source, inferred or not) and a verdict: completed, failed, dropped, stuck, handover-lost, insufficient (with why) or in-progress, where it stopped and the next actions. A FlowFile by its uuid: look kind lineage.",
    properties: { service: SERVICE, flow: s("Optional: a business (flw_…) to follow."), fileName: s("Optional: the file name or part of it."), emailFrom: s("Optional: the email sender."), emailSubject: s("Optional: a keyword of the email subject."), from: s("Optional ISO time."), to: s("Optional ISO time.") }, required: ["service"],
    request: (a) => { const { service, ...body } = a; return { method: "POST", path: `/api/services/${enc(service)}/trace`, body }; }, shape: redactStrings },
  { name: "run_model", readOnly: true, access: { personal: "all", assistant: true, checkup: true },
    description: "Replays a business model draft against the last 7 days and saves nothing: the verdict publishing it would get (published, needs-confirmation, rejected), the checks (coverage, reachable, no-dangling, s2s-balance, no-regression) with why, the changes against the current model (inside, counts, cues take effect; new, gone, merge, split, cross-service wait for a person) and regressions (businesses right before and wrong with the draft). Start from look kind model's draft.",
    properties: { service: SERVICE, model: { type: "object", description: "The draft: {version: 2, service, sources, segments: [{id, flow (flw_… or new:<key>), group {id, name}, slice, role, name, steps, entries, exits [{component, relationship?}], …}], flows?: [{flow, name?, summary?, reason?, risks?, stuck?}]}, as look kind model gives it." } },
    required: ["service", "model"], request: (a) => ({ method: "POST", path: `/api/services/${enc(a.service)}/model/run`, body: { model: a.model } }), shape: redactStrings },
  { name: "publish_model", readOnly: false, destructive: false, access: { personal: "admin", assistant: true, checkup: true },
    description: "Submits a business model draft; the Deployer runs the same gate as run_model. Answers verdict: published (revision), needs-confirmation (what is inside businesses took effect; new, gone, merged, split or cross-service businesses wait in pending for a person, with a to-do) or rejected (the model stays, reasons, a to-do; those businesses' lights are unknown until a publish passes). A name a person gave or confirmed is never changed. base must be the current revision (look kind model: base), or it is refused (409): read it again. source e2e_trace: the steps come from e2e_trace's schedules, you only place them.",
    properties: { service: SERVICE, base: n("The revision the draft was made on (0 when there is none)."), model: { type: "object", description: "The draft, as for run_model." }, note: s("What changed and why (kept with the business's history)."), source: s("Optional: ai (default) or e2e_trace."), request_id: REQUEST_ID },
    required: ["service", "base", "model", "note", "request_id"], request: (a) => { const { service, ...body } = a; return { method: "POST", path: `/api/services/${enc(service)}/model/publish`, body }; }, shape: redactStrings },
  { name: "record", readOnly: false, destructive: false, access: { personal: "admin", assistant: true, checkup: true },
    description: "Writes back to the service's page. todos: things a person should do, each {key (the same key updates the open to-do), flow?, severity failing|attention, title, detail, action?}; action is at most one button: {kind: config-change, label, changes (as draft_change takes them), note} | {kind: member-control, label, member, action start|stop|restart} | {kind: set-threshold, label, overrides} | {kind: confirm-flows, label} | {kind: open-nifi, label, url, component?}; nothing runs until a person presses it. The Deploy Assistant's key writes todos only (\"save as a to-do\" in a chat). The check-up also writes analysis {trigger, machine, business, machineSentence, businessSentence (one plain sentence each, shown beside the two lights), summary (in Chinese), lookedAt, flows?: [{flow, sentence (one plain sentence, shown beside the business), problems?: [{anomaly, cause, advice}], risks?}], stuckSuggestions?: [{flow, attentionMinutes, failingMinutes, basis}], intro?} (into analysis_id when the first message gave one) and resolve: ids of to-dos it found recovered.",
    properties: { service: SERVICE, analysis: { type: "object", description: "Optional (check-up): the analysis." }, analysis_id: n("Optional: the analysis id the first message gave."), todos: { type: "array", items: { type: "object" }, description: "Optional: to-dos to open or update (at most 20)." }, resolve: strs("Optional (check-up): to-do ids (td_…) now done."), request_id: REQUEST_ID },
    required: ["service", "request_id"],
    request: (a) => ({ method: "POST", path: `/api/services/${enc(a.service)}/record`, body: { analysis: a.analysis, analysisId: a.analysis_id, todos: a.todos, resolve: a.resolve } }) },
  { name: "draft_change", readOnly: false, draft: true, destructive: false, access: { personal: "all", assistant: true, checkup: false },
    description: "Writes a change of a service's configuration into a new draft, the only change the AI can make: nothing is saved as a revision or applied to a host until a person does it on the page. Answers the draft's id, the check's findings, whether it needs a restart (none, restart on a standalone instance, rolling or whole-cluster on a cluster, and why) and the differences. Secrets are refused (config/secret-by-person, and nothing is drafted): keys the catalog marks sensitive or with a secret-looking name, set or removed, and secret values in XML; a person enters those on the page. In XML text keep each (hidden) as it is. Each call makes a new draft. Then end your reply with an open_service_change card.",
    properties: { service: SERVICE, changes: { type: "array", items: { type: "object" }, description: "The changes: {file, key, value} sets a key (added if new), {file, key, unset: true} removes it, {file, text} replaces an XML file's whole text (start from look kind config's). On a cluster add member (a member key) for one node; without it the change is for all nodes (the common layer), which a node with its own value does not take (config/node-override), so give member for a key whose value differs between the nodes." }, note: s("Why this change, in the person's words (kept with the draft and on the timeline)."), base: n("Optional: the revision this was read from; refused if it is no longer the newest."), request_id: REQUEST_ID }, required: ["service", "changes", "note", "request_id"],
    request: (a) => ({ method: "POST", path: `/api/services/${enc(a.service)}/config/drafts`, body: { ai: true, changes: a.changes, note: a.note, ...(a.base !== undefined ? { base: a.base } : {}) } }), shape: draftShape },
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
  // Managed services: the seven verbs (§10.2.3).
  ...VERBS,
  // Assessments (§10.5.6): the Onboarding Assessor reads these and writes only its own draft, with the task token;
  // the Deploy Assistant reads them (list_assessments, onboarding_draft) to answer about the Onboarding page.
  { name: "list_assessments", readOnly: true, description: "Every assessment, newest first: id (asm_…), kind (onboarding or version), repository or app, version, who started it, status and level.", properties: {}, request: () => ({ method: "GET", path: "/api/assessments" }) },
  { name: "onboarding_draft", readOnly: true, description: "An assessment: its draft (the manifest being built, env keys), every change with who and why, the scanned facts, findings of the last validation, report.", properties: { id: ASSESSMENT }, required: ["id"], request: (a) => ({ method: "GET", path: `/api/assessments/${enc(a.id)}` }) },
  { name: "get_draft", readOnly: true, description: "The current draft of an assessment, small: draft (app, name, env keys), manifest (the manifest the draft makes, with its components) and the findings of the last validation. No change log, report or facts. The draft_* tools only answer with a receipt, so read it here to see what is in it (a version assessment starts from a copy of the current manifest).", properties: { id: ASSESSMENT }, required: ["id"], request: (a) => ({ method: "GET", path: `/api/assessments/${enc(a.id)}` }), shape: draftOnly },
  { name: "environment_facts", readOnly: true, description: "Ports, service names and data paths this environment already uses, per app; no env values.", properties: {}, request: () => ({ method: "GET", path: "/api/environment-facts" }) },
  { name: "validate_draft", readOnly: true, description: "Runs every program check on the draft (schema, conflicts with other apps, compose generation, forbidden fields, release tag) and returns the findings; none means it may be trial-deployed.", properties: { id: ASSESSMENT }, required: ["id"], request: (a) => ({ method: "POST", path: `/api/assessments/${enc(a.id)}/validate`, body: {} }) },
  draft("draft_app", "app", "The app's id, name and release: app, name, applies_from, release_repo (owner/name), tag_pattern (e.g. v{version}), release_manifest (release.json or package.json), optional bundle_asset (e.g. my-{version}.tar.gz) and bundle_repo.", { app: s("The app id (lowercase)."), name: s("Display name."), applies_from: s("Version the manifest applies from."), release_repo: s("owner/name of the release repository."), tag_pattern: s("Tag pattern with {version}."), release_manifest: s("release.json or package.json."), bundle_asset: s("Optional Release asset with {version}."), bundle_repo: s("Optional, defaults to release_repo.") }, ["app"]),
  draft("draft_component", "component", "Add or change a component: component (id), type (compose-service, workbench-app, oma-agent, db-migration, studio-graph, manual), depends_on.", { component: s("Component id."), type: s("Component type."), depends_on: { type: "array", items: { type: "string" }, description: "Optional component ids it waits for." } }, ["component", "type"]),
  draft("remove_draft_component", "remove-component", "Remove a component from the draft.", { component: s("Component id.") }, ["component"]),
  draft("draft_source", "source", "A component's one source (§5.1): {kind: public-registry, image: name:fixed-tag} or {kind: company-registry, registry, image, build?}. build is {repo, tag, script: \"build-images.sh\", platform?} when the repository has tools.lock (image open-atlas-<app>), or {repo, tag, dockerfile, prefix?, platform?} for a plain docker build of a self-contained Dockerfile (prefix: the context directory the repository goes to, for a Dockerfile that copies apps/<name>/...; image open-atlas-<app> or open-atlas-<app>-<component>). A repository's own build script never runs (validate_draft: draft/build-script). registry is a name from the environment's registries; a published image in a registry not listed there gets a new name, and the assessment is B with the administrator's step to register it (draft_report refuses A: draft/registry-unregistered). The release manifest file (release.json or package.json) is optional: it only holds contracts, and versions come from the tags.", { component: s("Component id."), source: { type: "object", description: "The source object." } }, ["component", "source"]),
  draft("draft_runtime", "runtime", "A component's runtime settings, the ones the Deployer generates compose from: service, ports [{container, host?}], volumes [{target, path | file}], health (image, none or a test array), command, environment {KEY: value or ${KEY}}, envFile; for other types their fields (dir, savedQueries, file, bind, steps, when, target, migrations, …).", { component: s("Component id."), service: s("Optional compose service name (unique across apps)."), ports: { type: "array", items: { type: "object" }, description: "Optional." }, volumes: { type: "array", items: { type: "object" }, description: "Optional." }, health: { type: "array", items: { type: "string" }, description: "Optional test array; or use command for image / none via draft_compose_extra." }, command: { type: "array", items: { type: "string" }, description: "Optional." }, environment: { type: "object", description: "Optional." }, envFile: { type: "boolean", description: "Optional: pass the whole env file." }, steps: { type: "array", items: { type: "string" }, description: "manual: the checklist." }, when: s("manual: install or always."), target: s("db-migration: the database component."), migrations: s("db-migration: directory."), install: s("db-migration: directory."), dir: s("studio-graph."), savedQueries: s("studio-graph."), file: s("oma-agent."), bind: s("oma-agent.") }, ["component"]),
  draft("draft_compose_extra", "compose-extra", "Advanced: extra compose fields for a component (validated; privileged, host namespaces, build and the like are refused).", { component: s("Component id."), fields: { type: "object", description: "compose fields." } }, ["component", "fields"]),
  draft("draft_env_key", "env-key", "Env keys the app reads. One key: key, description, secret (a secret has no default: a person fills it), default for a plain key (the first env revision starts from it), optional when the app runs without it. Several keys: keys, an array of those objects ({key, description, secret, default?, optional?}), in ONE call with one reason; if any one is wrong, none is written. Use either key or keys.", { key: s("UPPER_CASE key."), description: s("What it is."), secret: { type: "boolean", description: "Whether it is a secret." }, default: s("Optional default, plain keys only."), optional: { type: "boolean", description: "The app runs without it (e.g. single sign-on, own TLS certificate): shown as optional, never as missing." }, keys: { type: "array", items: { type: "object" }, description: "Instead of key: several keys, each {key, description, secret, default?, optional?}." } }, []),
  draft("remove_draft_env_key", "remove-env-key", "Remove an env key from the draft.", { key: s("The key.") }, ["key"]),
  draft("draft_report", "report", "The assessment report, the last call: level and report (conclusion, level, components, what is missing and how, risks, what people must decide). Refused: unchanged on an onboarding assessment; A or B while the draft does not pass validate_draft (draft/not-valid, with the findings); C or D while the draft has components (draft/configured); C before draft_issue kind onboarding (draft/no-issue). unreadable makes the assessment fail with the report as its reason, without a level or an issue, and the draft then takes no more changes.", { level: s(`One of ${LEVELS.join(", ")}.`), report: s("The report, in the person's language.") }, ["level", "report"]),
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
  const visible = visibleTools(tierOf(principal), admin);
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
      const bad = checkArgs(tool, args) ?? tool.check?.(args) ?? null;
      if (bad) return rpc(id, text({ finding: { code: "mcp/arguments", at: [tool.name], expected: bad } }, true));
      const keyId = principal.keyId ?? principal.id;
      const { request_id: requestId, ...rest } = args;
      // A retry is the same tool with the same arguments; anything else under an old request_id (another
      // assessment's task token, another app) is refused rather than answered with the earlier result.
      const argsSha256 = fingerprint(rest);
      if (!tool.readOnly) {
        const earlier = store.mcpAnswer(keyId, String(requestId));
        if (earlier) {
          if (earlier.tool !== tool.name || earlier.argsSha256 !== argsSha256) return rpc(id, text({ finding: { code: "mcp/request-id-reused", at: ["request_id"], expected: `a new request_id (this one was used for ${earlier.tool}${earlier.tool === tool.name ? " with other arguments" : ""})` } }, true));
          return rpc(id, earlier.response);
        }
      }
      const answer = await ctx.call(tool.request(rest));
      const ok = answer.status < 400;
      const result = ok ? text(tool.shape ? tool.shape(answer.body, rest) : answer.body) : text({ finding: { code: answer.body?.error ?? `http/${answer.status}`, at: [tool.name], expected: answer.body?.message ?? `HTTP ${answer.status}` }, ...(answer.body?.details?.length ? { details: answer.body.details } : {}) }, true);
      store.audit({ id: principal.id, via: principal.via === "service" ? "service" : "key" }, `mcp.${tool.name}`, String(args.app ?? args.job ?? args.host ?? args.service ?? args.id ?? "-"), { key: principal.keyId ?? null, status: answer.status, ...(requestId ? { requestId } : {}), ...(typeof args.note === "string" ? { note: args.note } : {}) });
      if (!tool.readOnly && ok) store.saveMcpAnswer(keyId, String(requestId), tool.name, argsSha256, result);
      return rpc(id, result);
    }
    default:
      return rpcError(id, -32601, `unknown method ${message?.method}`);
  }
}

/** The arguments of a command without its request_id, as a hash that does not depend on key order. */
function fingerprint(args: Record<string, unknown>): string {
  const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;
  return createHash("sha256").update(JSON.stringify(canon(args))).digest("hex");
}
