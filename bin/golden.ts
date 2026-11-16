// Golden cases of the Deploy Assistant and the Onboarding Assessor (golden/cases.ts) against a real OMA: opens sessions,
// reads their events, judges each case and prints a table; the results also go to a JSON file.
//
// assistant: sessions of GOLDEN_ASSISTANT_AGENT with the page context the Deployer's page adds, reading a real Deployer
//   (the agent's MCP address, normally the UAT's, read-only) through GOLDEN_ASSISTANT_VAULT.
// assessor: a harness Deployer built from this working tree in-process (its own state in a temp directory; the source of
//   an assessment comes from golden/fixtures, packed by a fake git) serves /deploy/mcp on GOLDEN_LISTEN; assessments are
//   started on it, and their sessions run GOLDEN_ASSESSOR_AGENT, whose MCP address is that harness, through
//   GOLDEN_ASSESSOR_VAULT (OMA matches a credential by host name: one for the same host as the harness will do).
//
// Usage: OMA_URL=… OMA_API_KEY_FILE=… GOLDEN_ENVIRONMENT=env-… GOLDEN_ASSISTANT_AGENT=… GOLDEN_ASSISTANT_VAULT=…
//   GOLDEN_ASSESSOR_AGENT=… GOLDEN_ASSESSOR_VAULT=… GOLDEN_LISTEN=172.18.0.1:8098
//   node bin/golden.ts <assistant|assessor|all> [case ids…] [--out results.json]

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { ASSESSOR, ASSISTANT, NEVER_RUN, VERDICT, type AssessorCase, type AssistantCase } from "../golden/cases.ts";
import { createApp } from "../src/server/app.ts";
import { permissionsFor, WorkbenchSessions, type Principal } from "../src/server/auth.ts";
import type { Config } from "../src/server/config.ts";
import { Deployments } from "../src/server/deploy.ts";
import { WorkbenchAdmin } from "../src/server/drivers/workbench.ts";
import { EnvManager, Schemas } from "../src/server/env.ts";
import type { Git } from "../src/server/git.ts";
import { Handoff, hostIds } from "../src/server/handoff.ts";
import { KeyError, type Keys } from "../src/server/keys.ts";
import { Observer } from "../src/server/observe.ts";
import { OmaSessions, type OmaEvent } from "../src/server/oma.ts";
import { Onboarding, type Assessment } from "../src/server/onboarding.ts";
import { SecretBox } from "../src/server/secretbox.ts";
import { ServiceChanges } from "../src/server/services/changes.ts";
import { Takeover } from "../src/server/services/takeover.ts";
import { Store } from "../src/server/store.ts";
import { Versions } from "../src/server/versions.ts";

const env = (k: string) => { const v = process.env[k]; if (!v) { console.error(`set ${k}`); process.exit(2); } return v; };
const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const out = outAt >= 0 ? args.splice(outAt, 2)[1] : undefined;
// --repeat N runs each case N times (how steady a model is on it).
const repeatAt = args.indexOf("--repeat");
const repeat = repeatAt >= 0 ? Number(args.splice(repeatAt, 2)[1]) : 1;
const [which = "all", ...only] = args;
const pick = <T extends { id: string }>(cases: T[]) => (only.length ? cases.filter((c) => only.includes(c.id)) : cases).flatMap((c) => Array.from({ length: repeat }, () => c));
const root = join(import.meta.dirname, "..");
const oma = { url: env("OMA_URL"), keyFile: env("OMA_API_KEY_FILE") };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Result { id: string; what: string; pass: boolean; problems: string[]; tools: string[]; session: string; seconds: number; detail?: unknown }

// ── Reading a session ──
const TOOL_PREFIX = /^mcp__[^_]+(?:-[^_]+)*__/;
function toolsOf(events: OmaEvent[]) {
  return events.filter((e) => e.type === "agent.mcp_tool_use").map((e) => ({ name: String(e.name ?? "").replace(TOOL_PREFIX, ""), input: (e.input ?? {}) as Record<string, unknown> }));
}
function commandsOf(events: OmaEvent[]) {
  return events.filter((e) => e.type === "agent.tool_use" && e.name === "bash").map((e) => String((e.input as { command?: string } | undefined)?.command ?? ""));
}
const answerOf = (events: OmaEvent[]) => events.filter((e) => e.type === "agent.message").map((e) => (e.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n")).join("\n");
const idle = (events: OmaEvent[]) => {
  const last = events.at(-1);
  return Boolean(last && (last.type === "session.status_idle" || last.type === "session.error" || last.type === "session.status_terminated"));
};
/** Each command of a shell line that must never run. */
const forbiddenRuns = (commands: string[]) => commands.flatMap((c) => c.split(/&&|\|\||;|\||\n|\$\(/).map((s) => s.trim().replace(/^\(+/, ""))).filter((s) => NEVER_RUN.test(s));

async function waitIdle(sessions: OmaSessions, id: string, timeoutMs: number): Promise<OmaEvent[]> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const events = await sessions.events(id);
    if (idle(events) && events.some((e) => e.type === "agent.message")) return events;
    if (Date.now() > until) return events;
    await sleep(3000);
  }
}

// ── The Deploy Assistant ──
async function runAssistant(c: AssistantCase): Promise<Result> {
  const sessions = new OmaSessions({ ...oma, agent: env("GOLDEN_ASSISTANT_AGENT"), environment: env("GOLDEN_ENVIRONMENT"), vaults: [env("GOLDEN_ASSISTANT_VAULT")] });
  const started = Date.now();
  const context = Object.entries(c.page).map(([k, v]) => `${k}=${v}`).join(" ");
  const session = await sessions.open(`golden ${c.id}`, `golden-${c.id}`, `${c.ask}\n\n[deployer-page] ${context}`);
  const events = await waitIdle(sessions, session, 240_000);
  const tools = toolsOf(events);
  const answer = answerOf(events);
  const problems: string[] = [];
  if (!idle(events)) problems.push("did not finish in 240 s");
  if (events.some((e) => e.type === "session.error")) problems.push("session error");
  if (c.first && tools[0]?.name !== c.first) problems.push(`first tool ${tools[0]?.name ?? "(none)"}, expected ${c.first}`);
  for (const want of c.calls ?? []) {
    const hit = tools.find((t) => t.name === want.tool && Object.entries(want.args ?? {}).every(([k, v]) => String(t.input[k] ?? "") === v));
    if (!hit) problems.push(`no ${want.tool}${want.args ? ` ${JSON.stringify(want.args)}` : ""}`);
  }
  for (const no of c.never ?? []) if (tools.some((t) => t.name === no)) problems.push(`called ${no}`);
  for (const re of c.forbid ?? []) if (re.test(answer)) problems.push(`answer matches ${re}`);
  for (const re of c.require ?? []) if (!re.test(answer)) problems.push(`answer lacks ${re}`);
  if (c.english && (answer.match(/[一-鿿]/g) ?? []).length > 10) problems.push("answer is not in English");
  // A deploy card is only proposed after plan_deploy (prompt: "Always call plan_deploy before you propose a deploy").
  if (/"operation"\s*:\s*"plan_deploy"/.test(answer) && !tools.some((t) => t.name === "plan_deploy")) problems.push("plan_deploy card without plan_deploy");
  if (!answer.trim()) problems.push("no answer");
  return { id: c.id, what: c.what, pass: problems.length === 0, problems, tools: tools.map((t) => t.name), session, seconds: Math.round((Date.now() - started) / 1000), detail: { answer: answer.slice(0, 1500) } };
}

// ── The Onboarding Assessor, on a harness Deployer ──
class GoldenSessions extends OmaSessions {
  mode: AssessorCase["source"] = "attached";
  override async upload(filename: string, bytes: Uint8Array, mediaType?: string) {
    return super.upload(filename, this.mode === "corrupt" ? Buffer.from("this is not a gzip archive\n") : bytes, mediaType);
  }
  override async open(title: string, correlation: string, text: string, files: { id: string; mountPath: string }[] = []) {
    return super.open(title, correlation, text, this.mode === "missing" ? [] : files);
  }
}

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "golden-"));
  const store = new Store(join(dir, "deployer.db"));
  const environmentFile = join(dir, "environment.json");
  writeFileSync(environmentFile, JSON.stringify({ name: "uat", project: "open-atlas", bindIp: "127.0.0.1", registries: { ghcr: "localhost:5000/open-atlas" }, apps: {} }));
  const box = new SecretBox(Buffer.alloc(32, 9).toString("base64"));
  const fixtures = join(root, "golden", "fixtures");
  let current: AssessorCase | undefined;
  const git = {
    configured: true,
    async tags() { return [...(current?.tags ?? [])]; },
    async archive(repo: string) {
      const name = /fixtures\/([\w-]+)\.git$/.exec(repo)?.[1];
      if (!name) throw new Error(`not a fixture: ${repo}`);
      // repos:<name> is a checkout under GOLDEN_REPOS (a real repository, not kept here); .git stays out.
      const dir = current?.fixture.startsWith("repos:") ? env("GOLDEN_REPOS") : fixtures;
      return execFileSync("tar", ["-czf", "-", "--exclude=.git", "-C", dir, name], { maxBuffer: 256 * 1024 * 1024 });
    },
    async diff() { throw new Error("no diffs in the golden harness"); },
    async log() { return { commits: [], more: false }; },
  } as unknown as Git;
  const sessions = new GoldenSessions({ ...oma, agent: env("GOLDEN_ASSESSOR_AGENT"), environment: env("GOLDEN_ENVIRONMENT"), vaults: [env("GOLDEN_ASSESSOR_VAULT")] });
  const config = { bind: "127.0.0.1", port: 0, basePath: "/deploy", dataDir: dir, workbenchUrl: "http://127.0.0.1:1", workbenchPublicUrl: "/", environmentFile, observeUrls: {}, secureCookies: false, webDir: join(dir, "web"), templatesDir: join(root, "templates"), initialManifestsDir: join(dir, "manifests"), peerKeySha256: [], githubApi: "http://127.0.0.1:1", omaVaults: [], omaAssessorVaults: [], briefHour: 8, deployerReleaseTag: "v{version}" } as unknown as Config;
  const handoff = new Handoff(store, Date.now, box);
  const observer = new Observer({});
  const deployments = new Deployments(store, handoff, observer, environmentFile, {});
  const onboarding = new Onboarding({ store, deployments, oma: sessions, git, githubApi: "http://127.0.0.1:1", githubTokenFile: undefined, issueRepo: undefined, issueTokenFile: undefined, templatesDir: join(dir, "kept"), pageUrl: "/" });
  // OMA picks a Vault's credential by the MCP address's host name, so the harness gets the same service key as the
  // Deployer on that host: any dps_ key is the service account here; it is neither kept nor logged.
  const service: Principal = { id: "golden-assessor", displayName: "golden-assessor", via: "service", groups: [], isAdmin: false, permissions: ["view"], csrfToken: "", keyId: "golden" } as Principal;
  const keys = { resolve: async (bearer: string) => { if (!bearer.startsWith("dps_")) throw new KeyError(401, "key/unknown", "Unknown key."); return service; } } as unknown as Keys;
  const takeover = new Takeover({ store, handoff, box, environment: () => deployments.environment().env.name, hosts: () => hostIds(deployments.environment().env) });
  const app = createApp({ config, store, takeover, keys, changes: new ServiceChanges({ store, handoff, box }), sessions: new WorkbenchSessions(config.workbenchUrl), observer, deployments,
    versions: new Versions(undefined), env: new EnvManager(store, deployments, new Schemas(undefined, join(root, "templates")), box, "golden"), workbench: new WorkbenchAdmin(config.workbenchUrl, () => ""), onboarding });
  const [host, port] = env("GOLDEN_LISTEN").split(":");
  // OMA lists an MCP server's tools with the Vault credential stored for that exact address, and there is none for the
  // harness's: a request without a key is the service account here (the harness listens only for this run).
  // GOLDEN_DEBUG: one line per request (method, path, JSON-RPC method, status), never headers.
  const fetcher = async (incoming: Request) => {
    const req = incoming.headers.get("authorization") ? incoming : new Request(incoming, { headers: new Headers([...incoming.headers, ["authorization", "Bearer dps_golden_harness"]]) });
    if (!process.env.GOLDEN_DEBUG) return app.fetch(req);
    const body = req.method === "POST" ? await req.clone().text().catch(() => "") : "";
    const res = await app.fetch(req);
    console.error(`harness ${req.method} ${new URL(req.url).pathname} ${/"method"\s*:\s*"([^"]+)"/.exec(body)?.[1] ?? ""} ${/"name"\s*:\s*"([^"]+)"/.exec(body)?.[1] ?? ""} ${incoming.headers.get("authorization") ? "" : "(no key)"} → ${res.status}`);
    return res;
  };
  const server = serve({ fetch: fetcher, hostname: host!, port: Number(port) });
  const person: Principal = { id: "golden@uat", displayName: "golden", via: "workbench", groups: ["deploy-uat"], isAdmin: false, permissions: permissionsFor(["deploy-uat"], false), csrfToken: "" } as Principal;
  return { onboarding, sessions, person, server, set: (c: AssessorCase) => { current = c; sessions.mode = c.source; } };
}

async function runAssessor(h: ReturnType<typeof harness>, c: AssessorCase): Promise<Result> {
  h.set(c);
  const started = Date.now();
  const { assessment } = await h.onboarding.start(h.person, { repo: `git@git.golden.test:fixtures/${c.fixture.replace(/^repos:/, "")}.git` });
  const problems: string[] = [];
  if (!assessment.session) return { id: c.id, what: c.what, pass: false, problems: [`not started: ${assessment.message}`], tools: [], session: "", seconds: 0 };
  let events: OmaEvent[] = [];
  let a: Assessment = assessment;
  const until = Date.now() + 15 * 60_000;
  for (;;) {
    await h.onboarding.poll();
    a = h.onboarding.get(assessment.id);
    events = await h.sessions.events(assessment.session);
    if (idle(events) && a.state !== "assessing") break;
    if (Date.now() > until) { problems.push("did not finish in 15 min"); break; }
    await sleep(5000);
  }
  const tools = toolsOf(events);
  const names = tools.map((t) => t.name);
  const runs = forbiddenRuns(commandsOf(events));
  if (runs.length) problems.push(`ran: ${runs.slice(0, 3).join(" | ")}`);
  if (!c.expect.level.includes(a.level)) problems.push(`level ${a.level}, expected ${c.expect.level.join(" or ")}`);
  if (c.expect.state && !c.expect.state.includes(a.state)) problems.push(`state ${a.state}, expected ${c.expect.state.join(" or ")}`);
  if (c.expect.issue === "none" && a.issue) problems.push(`drafted an issue (${a.issue.kind}): ${a.issue.title}`);
  if (c.expect.issue === "onboarding" && a.issue?.kind !== "onboarding") problems.push(`no onboarding issue${a.issue ? ` (${a.issue.kind})` : ""}`);
  if (c.expect.noDraft && a.draft.manifest.components.length) problems.push(`configured the draft: ${a.draft.manifest.components.map((x) => x.id).join(", ")}`);
  if (c.expect.validated) {
    const report = names.lastIndexOf("draft_report"), validated = names.lastIndexOf("validate_draft");
    if (validated < 0 || validated > report) problems.push("draft_report without validate_draft before it");
  }
  if (!names.includes("draft_report")) problems.push("no draft_report");
  for (const re of c.expect.report ?? []) if (!re.test(a.report ?? "")) problems.push(`report lacks ${re}`);
  // The first sentence: the first line that is not a heading, up to its first full stop.
  const first = (a.report ?? "").split("\n").map((l) => l.replace(/^[#>*\s-]+/, "").trim()).find((l) => l.length > 0)?.split(/[。.!！]/)[0] ?? "";
  if (a.level && VERDICT[a.level] && !VERDICT[a.level]!.test(first)) problems.push(`first sentence does not say whether it can be deployed: "${first.slice(0, 80)}"`);
  return {
    id: c.id, what: c.what, pass: problems.length === 0, problems, tools: names, session: assessment.session, seconds: Math.round((Date.now() - started) / 1000),
    detail: { assessment: a.id, state: a.state, level: a.level, issue: a.issue ? { kind: a.issue.kind, title: a.issue.title } : null, components: a.draft.manifest.components.map((x) => x.id), report: (a.report ?? "").slice(0, 600), message: a.message, commands: commandsOf(events).slice(0, 40) },
  };
}

const results: Result[] = [];
if (which === "assistant" || which === "all") {
  // A few at a time: each is a short conversation.
  const cases = pick(ASSISTANT);
  for (let i = 0; i < cases.length; i += 4) results.push(...await Promise.all(cases.slice(i, i + 4).map((c) => runAssistant(c).catch((e) => ({ id: c.id, what: c.what, pass: false, problems: [`error: ${(e as Error).message}`], tools: [], session: "", seconds: 0 })))));
}
if (which === "assessor" || which === "all") {
  const h = harness();
  try {
    for (const c of pick(ASSESSOR)) results.push(await runAssessor(h, c).catch((e) => ({ id: c.id, what: c.what, pass: false, problems: [`error: ${(e as Error).message}`], tools: [], session: "", seconds: 0 })));
  } finally { h.server.close(); }
}
for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"} ${r.id} ${r.seconds}s ${r.what}\n     tools: ${r.tools.join(" → ") || "-"}${r.problems.length ? `\n     ${r.problems.join("\n     ")}` : ""}\n     session: ${r.session}`);
console.log(`${results.filter((r) => r.pass).length}/${results.length} passed`);
if (out) writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), agents: { assistant: process.env.GOLDEN_ASSISTANT_AGENT, assessor: process.env.GOLDEN_ASSESSOR_AGENT }, results }, null, 2) + "\n");
process.exit(results.every((r) => r.pass) ? 0 : 1);
