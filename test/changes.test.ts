// Phase 3 step 11 (§7, §8, §13, §16.3): the change engine against a stand-in for the service executors: a cluster and a
// standalone whose processes, files, connections and roles only exist here. Step 11b's full stop and start is at the end.
// Rolling order and roles that move, the check
// before each member, every step's timeout, failing and rolling back, an executor or the Deployer restarting, jobs that
// expire, one change per service, who may do what, and what the rules and the timeline make of it.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/server/app.ts";
import { permissionsFor, WorkbenchSessions, type Principal } from "../src/server/auth.ts";
import type { Config } from "../src/server/config.ts";
import { Deployments } from "../src/server/deploy.ts";
import { WorkbenchAdmin } from "../src/server/drivers/workbench.ts";
import { EnvManager, Schemas } from "../src/server/env.ts";
import { Handoff, hostIds, type ExecutorInfo } from "../src/server/handoff.ts";
import type { Keys } from "../src/server/keys.ts";
import { Observer } from "../src/server/observe.ts";
import { SecretBox } from "../src/server/secretbox.ts";
import { INTERRUPTED, longestSeconds, nowStages, ServiceChanges, stagesFor } from "../src/server/services/changes.ts";
import { sealFile, type ConfigMember, type ServiceConfigBody } from "../src/server/services/config.ts";
import type { DraftCluster, DraftStandalone } from "../src/server/services/draft.ts";
import { ingest } from "../src/server/services/metrics.ts";
import { watchList } from "../src/server/services/watch.ts";
import { check } from "../src/server/services/rules.ts";
import { Takeover } from "../src/server/services/takeover.ts";
import type { ServiceSample } from "../src/server/services/watch.ts";
import { Store } from "../src/server/store.ts";
import { Versions } from "../src/server/versions.ts";

const box = new SecretBox(Buffer.alloc(32, 7).toString("base64"));
const cli = { id: "admin", via: "cli" } as const;
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const A = "local:/opt/a", B = "local:/opt/b", C = "local:/opt/c", SOLO = "local:/opt/solo";
const COORD = "Cluster Coordinator", PRIMARY = "Primary Node";

const USERS: Record<string, { groups: string[]; isAdmin?: boolean }> = { viewer: { groups: ["deploy-viewer"] }, uat: { groups: ["deploy-uat"] }, prod: { groups: ["deploy-prod"] }, admin: { groups: [], isAdmin: true } };
const keyPrincipal = (id: string, via: "key" | "service", groups: string[]): Principal => ({ id, displayName: id, via, groups, isAdmin: false, permissions: via === "service" ? ["view"] : permissionsFor(groups, false), csrfToken: "" });
const KEYS: Record<string, Principal> = { dpk_admin: { ...keyPrincipal("a@x", "key", []), isAdmin: true, permissions: permissionsFor([], true) }, dpk_uat: keyPrincipal("u@x", "key", ["deploy-uat"]), dpk_prod: keyPrincipal("p@x", "key", ["deploy-prod"]), dps_assistant: keyPrincipal("assistant", "service", []) };

interface Node { key: string; nodeId: string | null; running: boolean; pid: number; startedAt: string; files: Map<string, string>; status: string; roles: string[]; invalid: number; rest: boolean; joining: boolean; connects: boolean; dies: boolean; env: Record<string, string>; flow: string; backup?: Map<string, string>; flowBackup?: string; saved?: string[] }
type Answer = { state: string; message?: string; result?: Record<string, unknown> };

/** The hosts: answers every job as the service executor would, and does what it says to the members. */
function world(t: { store: Store; handoff: Handoff; now: { t: number } }) {
  const w = {
    nodes: new Map<string, Node>(),
    calls: [] as string[],
    via: [] as string[],
    held: new Set<string>(),
    /** After doing the thing, or instead of it: "<action> <member>" → how it ends. */
    failing: new Map<string, Answer & { didIt?: boolean }>(),
    offline: false,
    control: { operatorCert: true, killMode: "process" as string | null, runuser: true },
    kinds: ["svc-read", "svc-read@2", "svc-state", "svc-state@1", "svc-write", "svc-write@1", "svc-control", "svc-control@1"],
    onJob: null as null | ((action: string, member: string) => void),
    pidNext: 1000,
    add(key: string, nodeId: string | null, roles: string[] = []) {
      const files = new Map(t.store.serviceMemberFiles(nodeId ? "flow" : "solo").filter((f) => f.member === key).map((f) => [f.file, f.expectedSha256]));
      w.nodes.set(key, { key, nodeId, running: true, pid: w.pidNext++, startedAt: "2026-11-01T00:00:00Z", files, status: "CONNECTED", roles, invalid: 2, rest: true, joining: false, connects: true, dies: false, env: { JAVA_HOME: "/jdk" }, flow: `flow-of-${key}` });
    },
    table(me: Node) {
      if (!me.nodeId || !me.running || !me.rest) return undefined;
      const peers = [...w.nodes.values()].filter((n) => n.nodeId);
      return { nodes: peers.map((n) => ({ nodeId: n.nodeId!, address: "localhost", apiPort: 0, status: n.status, roles: n.roles })), self: me.nodeId };
    },
    state(n: Node) {
      return {
        process: n.running ? { running: true, pid: n.pid, startedAt: n.startedAt } : { running: false },
        environment: n.running ? n.env : null, limits: n.running ? { nofile: { soft: 50000, hard: 50000 } } : null,
        files: [...n.files].map(([name, sha256]) => ({ name, path: `x/${name}`, sha256 })),
        rest: !n.running ? { state: "not-running" } : !n.rest ? { state: "unreachable", error: "refused" } : { state: "ok", invalidCount: n.invalid, cluster: w.table(n) },
      };
    },
    /** One poll of the executor: a heartbeat, then every job that is there. */
    async run() {
      if (w.offline) return;
      t.handoff.heartbeat("local", { version: "0.9.0", protocols: [2], at: "", project: "", registries: [], databaseBackup: {}, busy: null, kinds: w.kinds, user: "nifi", isRoot: false, control: w.control } as never, "service");
      for (let job = await t.handoff.next("local", 0, undefined, "service"); job; job = await t.handoff.next("local", 0, undefined, "service")) w.handle(job);
      // Nodes that have been started come up by themselves.
      for (const n of w.nodes.values()) {
        if (n.running && n.dies) { n.running = false; n.dies = false; continue; }
        if (n.running && !n.rest) continue;
        if (n.running && n.joining && n.nodeId && n.connects) { n.status = "CONNECTED"; n.joining = false; }
      }
    },
    handle(job: Record<string, unknown>) {
      const id = String(job.id), kind = String(job.kind), member = String(job.member);
      const n = w.nodes.get(member)!;
      const finish = (a: Answer) => t.handoff.putStatus(id, { state: a.state as never, steps: [], result: (a.result ?? {}) as never, ...(a.message ? { message: a.message } : {}) });
      if (kind === "svc-state") return finish({ state: "succeeded", result: w.state(n) });
      if (kind === "svc-read") {
        const files = (job.files as string[]).map((name) => ({ name, path: `/opt/solo/conf/${name}`, sha256: sha("x\n"), size: 2, modifiedAt: "2026-11-09T00:00:00Z", content: Buffer.from("x\n").toString("base64") }));
        t.handoff.putEnvContent(id, JSON.stringify({ files }));
        return finish({ state: "succeeded", result: { files: [] } });
      }
      const action = String(job.action);
      // A node-* job names the node it is about; the executor asked (member) may be another one's (step 14).
      const about = action.startsWith("node-") ? [...w.nodes.entries()].find(([, x]) => x.nodeId === job.nodeId)?.[0] ?? member : member;
      const name = `${action} ${about}`;
      w.calls.push(name);
      if (about !== member) w.via.push(`${action} ${about} via ${member}`);
      w.onJob?.(action, about);
      if (w.held.has(name) || w.held.has(action)) return;
      const failure = w.failing.get(name);
      if (failure) w.failing.delete(name);
      if (failure && !failure.didIt) return finish(failure);
      if (action === "node-disconnect") { w.nodes.get(about)!.status = "DISCONNECTED"; finish({ state: "succeeded" }); }
      else if (action === "node-offload") { w.nodes.get(about)!.status = "OFFLOADED"; finish({ state: "succeeded" }); }
      else if (action === "node-connect") { const to = [...w.nodes.values()].find((x) => x.nodeId === job.nodeId)!; to.connects = true; to.status = "CONNECTED"; finish({ state: "succeeded" }); }
      else if (action === "stop") {
        const had = n.running;
        n.running = false;
        n.status = "DISCONNECTED";
        finish({ state: "succeeded", result: had ? { stopped: { pid: n.pid } } : { alreadyStopped: true } });
      } else if (action === "start") {
        if (n.running) finish({ state: "succeeded", result: { alreadyRunning: true } });
        else { n.running = true; n.pid = w.pidNext++; n.startedAt = new Date(t.now.t).toISOString(); n.joining = true; finish({ state: "succeeded", result: { process: { pid: n.pid } } }); }
      } else if (action === "kill") { n.running = false; finish({ state: "succeeded", result: { killed: [job.pid] } }); }
      else if (action === "check" || action === "backup") {
        const files = job.files as { name: string; baseSha256: string | null; sha256?: string }[];
        for (const f of files) if (n.files.get(f.name) !== f.baseSha256 && n.files.get(f.name) !== f.sha256) return finish({ state: "refused", message: `${f.name} changed` });
        if (action === "backup") { n.backup ??= new Map(n.files); if (job.flowFile) n.flowBackup ??= n.flow; }
        finish({ state: "succeeded", result: { files: [] } });
      } else if (action === "apply") {
        const files = job.files as { name: string; baseSha256: string | null; sha256: string }[];
        for (const f of files) if (n.files.get(f.name) !== f.baseSha256 && n.files.get(f.name) !== f.sha256) return finish({ state: "refused", message: `${f.name} changed` });
        const content = JSON.parse(String(job.content)) as { files: { name: string; base64: string }[] };
        n.backup ??= new Map(n.files);
        for (const f of files) { assert.equal(sha(Buffer.from(content.files.find((x) => x.name === f.name)!.base64, "base64")), f.sha256, "the content is what it says"); n.files.set(f.name, f.sha256); }
        finish({ state: "succeeded", result: { files: [] } });
      } else if (action === "restore") {
        if (!n.backup) return finish({ state: "refused", message: "this change has no backup here" });
        n.files = new Map(n.backup);
        if (n.flowBackup) n.flow = n.flowBackup;
        finish({ state: "succeeded", result: { files: [] } });
      } else if (action === "prune") finish({ state: "succeeded", result: { pruned: [], kept: 1 } });
      else assert.fail(`no such action: ${action}`);
      if (failure) finish(failure); // it did the thing, and then said otherwise
    },
  };
  return w;
}

function setup(name = "uat", store?: Store, nowAt?: { t: number }) {
  const now = nowAt ?? { t: Date.parse("2026-11-09T10:00:00Z") };
  const db = store ?? new Store(":memory:", () => new Date(now.t));
  const dir = mkdtempSync(join(tmpdir(), "changes-"));
  const environmentFile = join(dir, "environment.json");
  writeFileSync(environmentFile, JSON.stringify({ name, project: "open-atlas", bindIp: "127.0.0.1", registries: {}, apps: {} }));
  const fetcher = (async (input: URL | string, init?: RequestInit) => {
    if (new URL(String(input)).pathname === "/health") return Response.json({ status: "ok" });
    const token = /open_atlas_workbench_session=([^;]+)/.exec(new Headers(init?.headers).get("cookie") ?? "")?.[1] ?? "";
    const user = USERS[token];
    if (!user) return Response.json({ error: "auth/unauthorized" }, { status: 401 });
    return Response.json({ user: { id: token, email: `${token}@x`, displayName: token, enabled: true, role: user.isAdmin ? "admin" : "member", isAdmin: !!user.isAdmin }, csrfToken: `csrf-${token}`, groups: user.groups });
  }) as typeof fetch;
  const config = { bind: "127.0.0.1", port: 0, basePath: "/deploy", dataDir: dir, workbenchUrl: "http://workbench:8090", workbenchPublicUrl: "/", environmentFile, observeUrls: {}, secureCookies: false, webDir: join(dir, "web"), templatesDir: join(dir, "templates"), initialManifestsDir: join(dir, "manifests"), peerKeySha256: [], githubApi: "https://api.github.com", omaVaults: [], omaAssessorVaults: [], briefHour: 8, deployerReleaseTag: "v{version}" } as unknown as Config;
  const handoff = new Handoff(db, () => now.t, box);
  const observer = new Observer({}, fetcher);
  const deployments = new Deployments(db, handoff, observer, environmentFile, {});
  const takeover = new Takeover({ store: db, handoff, box, environment: () => deployments.environment().env.name, hosts: () => hostIds(deployments.environment().env) });
  const keys = { resolve: async (bearer: string) => KEYS[bearer] } as unknown as Keys;
  const env = new EnvManager(db, deployments, new Schemas(undefined, join(dir, "templates"), fetcher), box, "compare");
  const engine = { changes: new ServiceChanges({ store: db, handoff, box, now: () => now.t, liveRead: { sleep: async () => { await w.run(); }, timeoutMs: 2000, pollMs: 1 } }) };
  const app = createApp({ config, store: db, takeover, keys, changes: engine.changes, sessions: new WorkbenchSessions(config.workbenchUrl, fetcher), observer, deployments, versions: new Versions(undefined, fetcher), env, workbench: new WorkbenchAdmin(config.workbenchUrl, () => "", fetcher) });
  type As = { as?: string; key?: string };
  const call = (method: string, path: string, who: As, body?: unknown) => {
    const headers = new Headers({ "content-type": "application/json" });
    if (who.as) { headers.set("cookie", `open_atlas_workbench_session=${who.as}`); headers.set("x-csrf-token", `csrf-${who.as}`); }
    if (who.key) headers.set("authorization", `Bearer ${who.key}`);
    return app.request(`/deploy${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  };
  const w = world({ store: db, handoff, now });
  return { store: db, handoff, now, engine, call, w, app };
}
type T = ReturnType<typeof setup>;

const NIFI = (over: Record<string, string>) => {
  const v: Record<string, string> = { "nifi.ui.banner.text": "", "nifi.web.https.port": "8443", "nifi.security.keystorePasswd": "keystore-s3cret", "nifi.cluster.is.node": "false", ...over };
  return `# NiFi\n${Object.entries(v).map(([k, x]) => `${k}=${x}`).join("\n")}\n`;
};
function memberOf(dir: string, files: Record<string, string>): ConfigMember {
  return { host: "local", installDir: dir, missing: [], files: Object.entries(files).map(([name, text]) => sealFile({ name, path: `${dir}/conf/${name}`, modifiedAt: "2026-11-01T00:00:00Z" }, Buffer.from(text), box)) };
}
const serviceMember = (dir: string, https: number, serviceUser: string | null = "nifi") => ({ host: "local", installDir: dir, serviceUser, startEnvironment: { JAVA_HOME: "/old" }, ports: { https }, nodeAddress: "localhost", discovery: null });

/** A standalone "solo" and a three-node cluster "flow": a is the coordinator, c the primary node. */
function takenOver(t: T, user: string | null = "nifi") {
  const solo = { kind: "standalone", id: "solo", service: "nifi", profile: "nifi-2.x", version: "2.0.0", webUrl: null, member: serviceMember("/opt/solo", 7443, user) } as unknown as DraftStandalone;
  const flow = { kind: "cluster", id: "flow", service: "nifi", profile: "nifi-2.x", version: "2.5.0", webUrl: null, zookeeper: "zk:2181", zookeeperRoot: "/flow", nodes: [serviceMember("/opt/a", 8443, user), serviceMember("/opt/b", 9443, user), serviceMember("/opt/c", 10443, user)] } as unknown as DraftCluster;
  const draft = t.store.createServiceDraft("uat", [], [solo, flow], cli);
  const node = (dir: string, https: string) => memberOf(dir, { "nifi.properties": NIFI({ "nifi.web.https.port": https, "nifi.cluster.is.node": "true" }), "logback.xml": `<configuration scan="true"/>\n` });
  const configs: Record<string, ServiceConfigBody> = {
    solo: { members: [memberOf("/opt/solo", { "nifi.properties": NIFI({ "nifi.web.https.port": "7443" }), "logback.xml": `<configuration scan="true"/>\n` })] },
    flow: { members: [node("/opt/a", "8443"), node("/opt/b", "9443"), node("/opt/c", "10443")] },
  };
  t.store.confirmServiceDraft(draft.id, configs, cli);
  t.w.add(A, "node-a", [COORD]);
  t.w.add(B, "node-b");
  t.w.add(C, "node-c", [PRIMARY]);
  t.w.add(SOLO, null);
}

const fast = { stableSeconds: 6, timeouts: { disconnect: 20, stop: 20, write: 20, start: 20, rest: 40, connect: 90, stable: 40, gate: 40, offload: 20, compose: 60 } };

async function revision(t: T, service: string, changes: unknown[] = [{ file: "nifi.properties", key: "nifi.ui.banner.text", value: "hello" }], who: { as: string } = { as: "uat" }) {
  const draft = await t.call("POST", `/api/services/${service}/config/drafts`, who, { changes });
  assert.equal(draft.status, 201, await draft.clone().text());
  const saved = await t.call("POST", `/api/services/${service}/config/drafts/${(await draft.json()).id}/save`, who, {});
  assert.equal(saved.status, 201, await saved.clone().text());
  return (await saved.json()).revision as number;
}
async function planOf(t: T, service: string, body: Record<string, unknown>, who: { as?: string; key?: string } = { as: "uat" }) {
  await t.w.run();
  const r = await t.call("POST", `/api/services/${service}/changes/plan`, who, body);
  assert.equal(r.status, 200, await r.clone().text());
  return r.json();
}
async function begin(t: T, service: string, body: Record<string, unknown>) {
  const options = { ...fast, ...(body.options as object ?? {}) };
  const plan = await planOf(t, service, { ...body, options });
  assert.deepEqual(plan.blocking, []);
  const r = await t.call("POST", `/api/services/${service}/changes`, { as: "uat" }, { ...body, options, planHash: plan.planHash, reason: "because" });
  assert.equal(r.status, 201, await r.clone().text());
  return (await r.json()).id as string;
}
const changeOf = (t: T, service: string, id: string) => t.store.serviceChange(service, id)!;
async function drive(t: T, service: string, id: string, until: (c: ReturnType<typeof changeOf>) => boolean = (c) => c.state !== "running", max = 400) {
  for (let i = 0; i < max; i++) {
    await t.w.run();
    t.engine.changes.tick();
    const c = changeOf(t, service, id);
    if (until(c)) return c;
    t.now.t += 3000;
  }
  assert.fail(`not there after ${max} rounds: ${JSON.stringify({ state: changeOf(t, service, id).state, phase: changeOf(t, service, id).phase, message: changeOf(t, service, id).message, steps: t.store.serviceChangeSteps(id).slice(-3) })}`);
}
const stepsOf = (t: T, id: string) => t.store.serviceChangeSteps(id).map((s) => `${s.step} ${s.member ?? ""} ${s.state}`.replace(/\s+/g, " ").trim());
const touched = (t: T) => t.w.calls.filter((c) => !c.startsWith("prune"));
const act = (t: T, service: string, id: string, what: string, who: { as?: string; key?: string } = { as: "uat" }) => t.call("POST", `/api/services/${service}/changes/${id}/${what}`, who, {});
const events = (t: T, service: string) => t.store.serviceEvents(service).map((e) => e.kind).reverse();

test("a rolling apply: one node at a time, ordinary first, the primary node and the coordinator last, each through every step, on the timeline", async () => {
  const t = setup();
  takenOver(t);
  const rev = await revision(t, "flow");
  const id = await begin(t, "flow", { kind: "apply" });
  const c = await drive(t, "flow", id);
  assert.equal(c.state, "succeeded", c.message ?? "");
  assert.deepEqual(touched(t), [B, C, A].flatMap((m) => ["node-disconnect", "stop", "apply", "start"].map((a) => `${a} ${m}`)));
  assert.equal(t.w.calls.filter((x) => x.startsWith("prune")).length, 3, "the old backups go after it succeeded, each member's");
  assert.equal(t.w.via.filter((x) => x.startsWith("node-disconnect")).length, 3, "a disconnected node cannot confirm it itself: another member asks (step 14)");
  assert.ok(t.w.via.every((x) => !x.match(/^node-disconnect (\S+) via \1$/)));
  const steps = stepsOf(t, id);
  assert.deepEqual(steps.slice(0, 9), ["gate succeeded", `disconnect ${B} succeeded`, `stop ${B} succeeded`, `write ${B} succeeded`, `start ${B} succeeded`, `wait-rest ${B} succeeded`, `wait-connected ${B} succeeded`, `wait-stable ${B} succeeded`, "gate succeeded"]);
  for (const f of t.store.serviceMemberFiles("flow").filter((x) => x.file === "nifi.properties")) {
    assert.equal(f.revision, rev);
    assert.equal(f.change, id);
    assert.equal(f.actualSha256, f.expectedSha256, "no older sample calls it drift");
    assert.equal(t.w.nodes.get(f.member)!.files.get("nifi.properties"), f.expectedSha256);
  }
  const kinds = events(t, "flow");
  assert.ok(kinds.includes("change-started") && kinds.at(-1) === "change-finished");
  assert.equal(kinds.filter((k) => k === "node-stopped").length, 3);
  assert.equal(kinds.filter((k) => k === "node-started").length, 3);
  assert.equal(kinds.filter((k) => k === "config-applied").length, 3);
  assert.equal(t.store.activeServiceChange("flow"), undefined);
  const status = await (await t.call("GET", "/api/services/flow/status", { as: "viewer" })).json();
  assert.deepEqual(status.members.flatMap((m: { configPending: string[] }) => m.configPending), [], "nothing is left pending");
});

test("roles that move during the roll count at the next round", async () => {
  const t = setup();
  takenOver(t);
  // While b goes, the coordinator role moves from a to c: then a is the ordinary one, and c (primary and coordinator) last.
  t.w.onJob = (action, member) => {
    if (action === "stop" && member === B) { t.w.nodes.get(A)!.roles = []; t.w.nodes.get(C)!.roles = [PRIMARY, COORD]; }
  };
  const id = await begin(t, "flow", { kind: "rolling-restart" });
  assert.equal((await drive(t, "flow", id)).state, "succeeded");
  assert.deepEqual(touched(t).filter((x) => x.startsWith("stop")), [`stop ${B}`, `stop ${A}`, `stop ${C}`]);
  assert.ok(!t.w.calls.some((x) => x.startsWith("apply")), "a restart writes nothing");
  assert.ok(!t.w.calls.some((x) => x.startsWith("prune")), "nor prunes");
});

test("the check before a member: another node away, no coordinator, a file changed, an executor gone: stopped with nothing done", async () => {
  for (const [spoil, says] of [
    [(t: T) => { t.w.nodes.get(A)!.status = "DISCONNECTED"; }, /local:\/opt\/a is not connected/],
    [(t: T) => { for (const n of t.w.nodes.values()) n.roles = []; }, /no coordinator/],
    [(t: T) => { t.w.nodes.get(B)!.files.set("nifi.properties", "f".repeat(64)); }, /changed on the host/],
  ] as const) {
    const t = setup();
    takenOver(t);
    await revision(t, "flow");
    const plan = await planOf(t, "flow", { kind: "apply", options: fast });
    spoil(t);
    await t.w.run();
    const r = await t.call("POST", "/api/services/flow/changes", { as: "uat" }, { kind: "apply", options: fast, planHash: plan.planHash });
    assert.equal(r.status, 201);
    const id = (await r.json()).id as string;
    const c = await drive(t, "flow", id);
    assert.equal(c.state, "stopped");
    assert.match(c.message!, says);
    assert.deepEqual(t.w.calls, [], "nothing was touched");
    assert.equal(c.currentMember, null);
  }
  const t = setup();
  takenOver(t);
  const id = await begin(t, "flow", { kind: "rolling-restart" });
  t.w.offline = true;
  t.now.t += 60_000;
  t.engine.changes.tick();
  assert.equal(changeOf(t, "flow", id).state, "stopped");
  assert.match(changeOf(t, "flow", id).message!, /service executor of local is offline/);
  assert.deepEqual(t.w.calls, []);
});

test("each step has its deadline: past it the change stops where it is, nothing rolled back", async () => {
  for (const action of ["node-disconnect", "stop", "apply", "start"]) {
    const t = setup();
    takenOver(t);
    await revision(t, "flow");
    t.w.held.add(action);
    const id = await begin(t, "flow", { kind: "apply" });
    const c = await drive(t, "flow", id);
    assert.equal(c.state, "stopped", action);
    assert.match(c.message!, /timed out/);
    assert.equal(t.store.serviceChangeSteps(id).at(-1)!.state, "timed-out");
    assert.ok(!t.w.calls.some((x) => x.startsWith("restore")), `${action}: no rollback on a timeout`);
    assert.equal(t.w.calls.at(-1)!.split(" ")[0], action, "and the next step never came");
    assert.equal(c.currentMember, B);
  }
  // What it waits for after the start.
  const t = setup();
  takenOver(t);
  const original = t.w.handle;
  t.w.handle = (job) => { original(job); if (job.action === "start") t.w.nodes.get(String(job.member))!.rest = false; };
  const id = await begin(t, "flow", { kind: "rolling-restart" });
  const c = await drive(t, "flow", id);
  assert.equal(c.state, "stopped");
  assert.match(c.message!, /wait-rest on local:\/opt\/b timed out/);

  const t2 = setup();
  takenOver(t2);
  const original2 = t2.w.handle;
  t2.w.handle = (job) => { original2(job); if (job.action === "start") { t2.w.nodes.get(String(job.member))!.connects = false; } };
  t2.w.held.add("node-connect");
  const id2 = await begin(t2, "flow", { kind: "rolling-restart" });
  const c2 = await drive(t2, "flow", id2);
  assert.equal(c2.state, "stopped");
  assert.match(c2.message!, /wait-connected on local:\/opt\/b timed out/);
  assert.ok(t2.w.via.includes(`node-connect ${B} via ${A}`) || t2.w.via.includes(`node-connect ${B} via ${C}`), "another node was asked to connect it, once");
  assert.equal(t2.w.calls.filter((x) => x.startsWith("node-connect")).length, 1);
});

test("a node staying away is connected through another node, and the roll goes on", async () => {
  const t = setup();
  takenOver(t);
  const original = t.w.handle;
  t.w.handle = (job) => { original(job); if (job.action === "start" && job.member === B) t.w.nodes.get(B)!.connects = false; };
  const id = await begin(t, "flow", { kind: "rolling-restart" });
  assert.equal((await drive(t, "flow", id)).state, "succeeded");
  const asked = t.w.via.find((x) => x.startsWith("node-connect"))!;
  assert.match(asked, new RegExp(`^node-connect ${B} via (?!${B}$)`), "through another node's executor");
});

test("a failing start rolls that node back, starts it and stops the change; the others stay as they were", async () => {
  const t = setup();
  takenOver(t);
  await revision(t, "flow");
  const before = new Map(t.w.nodes.get(B)!.files);
  t.w.failing.set(`start ${B}`, { state: "failed", message: "no JVM came up" });
  const id = await begin(t, "flow", { kind: "apply" });
  const c = await drive(t, "flow", id);
  assert.equal(c.state, "rolled-back", c.message ?? "");
  assert.match(c.message!, /no JVM/);
  assert.deepEqual(touched(t), ["node-disconnect", "stop", "apply", "start", "restore", "stop", "start"].map((a) => `${a} ${B}`));
  assert.deepEqual(t.w.nodes.get(B)!.files, before);
  assert.equal(t.w.nodes.get(B)!.running, true);
  assert.equal(t.w.nodes.get(B)!.status, "CONNECTED");
  assert.ok(events(t, "flow").includes("config-rolled-back"));
  assert.ok(t.store.serviceMemberFiles("flow").every((f) => f.revision === 1), "what they should be has not moved");
  assert.equal(t.store.activeServiceChange("flow"), undefined, "ended: a new change may start");
  assert.ok(!t.w.calls.some((x) => x.startsWith("prune")), "failed changes keep their backups");
});

test("a NiFi that dies after starting, and a health check that does not pass, roll back as well", async () => {
  const t = setup();
  takenOver(t);
  await revision(t, "flow");
  const original = t.w.handle;
  let once = true;
  t.w.handle = (job) => { original(job); if (job.action === "start" && once) { once = false; t.w.nodes.get(B)!.dies = true; } };
  const id = await begin(t, "flow", { kind: "apply" });
  const c = await drive(t, "flow", id);
  assert.equal(c.state, "rolled-back", c.message ?? "");
  assert.match(c.message!, /not running any more/);

  const t2 = setup();
  takenOver(t2);
  await revision(t2, "flow");
  const original2 = t2.w.handle;
  let done = false;
  t2.w.handle = (job) => {
    original2(job);
    if (job.action === "apply") t2.w.nodes.get(B)!.invalid = 9;
    if (job.action === "restore") { done = true; t2.w.nodes.get(B)!.invalid = 2; }
  };
  const id2 = await begin(t2, "flow", { kind: "apply" });
  const c2 = await drive(t2, "flow", id2);
  assert.equal(c2.state, "rolled-back", c2.message ?? "");
  assert.match(c2.message!, /invalid components/);
  assert.ok(done);
  assert.ok(!t2.w.calls.includes(`node-disconnect ${C}`), "the next node was not touched");
});

test("a write refused or failing: what was written goes back only when the executor could not put it back itself", async () => {
  const t = setup();
  takenOver(t);
  await revision(t, "flow");
  // Someone changed the file between the check and the write: the executor refuses it, nothing was written.
  t.w.failing.set(`apply ${B}`, { state: "refused", message: "nifi.properties changed" });
  const id = await begin(t, "flow", { kind: "apply" });
  const c = await drive(t, "flow", id);
  assert.equal(c.state, "rolled-back");
  assert.deepEqual(touched(t), ["node-disconnect", "stop", "apply", "start"].map((a) => `${a} ${B}`), "started again, no restore");

  const t2 = setup();
  takenOver(t2);
  await revision(t2, "flow");
  t2.w.failing.set(`apply ${B}`, { state: "failed", message: "disk full", result: { rolledBack: true, notRestored: [] } });
  const id2 = await begin(t2, "flow", { kind: "apply" });
  assert.equal((await drive(t2, "flow", id2)).state, "rolled-back");
  assert.ok(!t2.w.calls.some((x) => x.startsWith("restore")), "it put them back itself");

  const t3 = setup();
  takenOver(t3);
  await revision(t3, "flow");
  t3.w.failing.set(`apply ${B}`, { state: "failed", message: "half", result: { rolledBack: false, notRestored: ["nifi.properties"] }, didIt: true });
  const id3 = await begin(t3, "flow", { kind: "apply" });
  assert.equal((await drive(t3, "flow", id3)).state, "rolled-back");
  assert.ok(t3.w.calls.includes(`restore ${B}`));
});

test("rolling back that fails stops, says so and does not try again; a person's rollback then works from what the host has", async () => {
  const t = setup();
  takenOver(t);
  await revision(t, "flow");
  t.w.failing.set(`start ${B}`, { state: "failed", message: "no JVM" });
  t.w.failing.set(`restore ${B}`, { state: "failed", message: "read-only file system", didIt: false });
  const id = await begin(t, "flow", { kind: "apply" });
  const c = await drive(t, "flow", id);
  assert.equal(c.state, "stopped");
  assert.match(c.message!, /Rolling back failed.*read-only/);
  assert.equal(t.w.calls.filter((x) => x.startsWith("restore")).length, 1);
  assert.equal(c.currentMember, B);
  const view = await (await t.call("GET", `/api/services/flow/changes/${id}`, { as: "viewer" })).json();
  assert.equal(view.progress.canRollBack, true);

  assert.equal((await act(t, "flow", id, "rollback")).status, 200);
  const after = await drive(t, "flow", id);
  assert.equal(after.state, "rolled-back", after.message ?? "");
  assert.equal(t.w.nodes.get(B)!.running, true);
  assert.equal(t.w.calls.filter((x) => x.startsWith("restore")).length, 2);
});

test("a restart with nothing written has nothing to go back to: it stops, and rollback says so", async () => {
  const t = setup();
  takenOver(t);
  t.w.failing.set(`start ${B}`, { state: "failed", message: "no JVM" });
  const id = await begin(t, "flow", { kind: "rolling-restart" });
  const c = await drive(t, "flow", id);
  assert.equal(c.state, "stopped");
  assert.ok(!t.w.calls.some((x) => x.startsWith("restore")));
  assert.equal((await act(t, "flow", id, "rollback")).status, 409);
  // Continue starts it again: it is stopped, and that is what is left.
  assert.equal((await act(t, "flow", id, "continue")).status, 200);
  assert.equal((await drive(t, "flow", id)).state, "succeeded");
  assert.deepEqual(t.w.calls.slice(2, 5), [`start ${B}`, `start ${B}`, `node-disconnect ${C}`], "continuing skipped what was done");
});

test("the executor restarting mid-job stops the change without rolling back; continuing looks first and skips what is done", async () => {
  const t = setup();
  takenOver(t);
  await revision(t, "flow");
  t.w.failing.set(`start ${B}`, { state: "failed", message: INTERRUPTED, didIt: true });
  const id = await begin(t, "flow", { kind: "apply" });
  const c = await drive(t, "flow", id);
  assert.equal(c.state, "stopped");
  assert.match(c.message!, /stopped while this job ran/);
  assert.ok(!t.w.calls.some((x) => x.startsWith("restore")), "the state is not known: no rollback by itself");
  const count = t.w.calls.filter((x) => x.endsWith(B)).length;

  assert.equal((await act(t, "flow", id, "continue")).status, 200);
  const after = await drive(t, "flow", id);
  assert.equal(after.state, "succeeded", after.message ?? "");
  assert.equal(t.w.calls.filter((x) => x.endsWith(B) && !x.startsWith("prune")).length, count, "the file is as planned, the process new: nothing done to it again");
  assert.ok(stepsOf(t, id).includes(`reconcile ${B} succeeded`));
});

test("the executor gone when it was stopping: stopped where it is, written or not, and continuing works out the rest", async () => {
  const t = setup();
  takenOver(t);
  await revision(t, "flow");
  t.w.failing.set(`apply ${B}`, { state: "failed", message: INTERRUPTED, didIt: true });
  const id = await begin(t, "flow", { kind: "apply" });
  assert.equal((await drive(t, "flow", id)).state, "stopped");
  assert.equal(t.w.nodes.get(B)!.running, false);
  assert.equal((await act(t, "flow", id, "continue")).status, 200);
  assert.equal((await drive(t, "flow", id)).state, "succeeded");
  assert.equal(t.w.calls.filter((x) => x === `apply ${B}`).length, 1, "already written");
  assert.equal(t.w.calls.filter((x) => x === `start ${B}`).length, 1);
});

test("the Deployer restarting: the member at work is finished and then it waits for a person, from the database alone", async () => {
  const t = setup();
  takenOver(t);
  await revision(t, "flow");
  const id = await begin(t, "flow", { kind: "apply" });
  await drive(t, "flow", id, () => t.w.calls.includes(`stop ${B}`));
  // A new process: new engine, same database.
  t.engine.changes = new ServiceChanges({ store: t.store, handoff: t.handoff, box, now: () => t.now.t });
  t.engine.changes.recover();
  const c = await drive(t, "flow", id);
  assert.equal(c.state, "paused", c.message ?? "");
  assert.equal(c.currentMember, null);
  assert.deepEqual((c.progress as { done: string[] }).done, [B]);
  assert.ok(!t.w.calls.includes(`node-disconnect ${C}`), "no next member");
  assert.ok(t.store.serviceMemberFiles("flow").some((f) => f.member === B && f.revision > 1));
  assert.ok(events(t, "flow").includes("change-paused"));

  assert.equal((await act(t, "flow", id, "continue")).status, 200);
  const done = await drive(t, "flow", id);
  assert.equal(done.state, "succeeded", done.message ?? "");
  assert.deepEqual(touched(t).filter((x) => x.startsWith("stop")), [`stop ${B}`, `stop ${C}`, `stop ${A}`]);
});

test("the Deployer away for longer than a step's deadline: it counts as past, and stops", async () => {
  const t = setup();
  takenOver(t);
  t.w.held.add("stop");
  const id = await begin(t, "flow", { kind: "rolling-restart" });
  await drive(t, "flow", id, () => t.w.calls.includes(`stop ${B}`));
  t.engine.changes = new ServiceChanges({ store: t.store, handoff: t.handoff, box, now: () => t.now.t });
  t.engine.changes.recover();
  t.now.t += 3600_000;
  t.engine.changes.tick();
  const c = changeOf(t, "flow", id);
  assert.equal(c.state, "stopped");
  assert.match(c.message!, /stop on .* timed out/);
});

test("a job past expiresAt while the executor is away is refused and never runs, and the change stops", async () => {
  const t = setup();
  takenOver(t);
  t.w.onJob = (action) => { if (action === "node-disconnect") t.w.offline = true; };
  const id = await begin(t, "flow", { kind: "rolling-restart" });
  const c = await drive(t, "flow", id);
  assert.equal(c.state, "stopped");
  assert.match(c.message!, /waited in the queue/);
  assert.ok(!t.w.calls.includes(`stop ${B}`));
  const step = t.store.serviceChangeSteps(id).at(-1)!;
  assert.equal(t.store.executorJob(step.job!)!.status!.state, "refused");

  // Back: it is not run after all, and continuing begins by looking.
  t.w.offline = false;
  t.w.onJob = null;
  assert.equal((await act(t, "flow", id, "continue")).status, 200);
  assert.equal((await drive(t, "flow", id)).state, "succeeded");
  assert.equal(t.w.calls.filter((x) => x === `node-disconnect ${B}`).length, 1, "already away: not asked again");
});

test("one change per service, stopped ones too; closing frees it; other services are not held", async () => {
  const t = setup();
  takenOver(t);
  t.w.held.add("stop");
  const id = await begin(t, "flow", { kind: "rolling-restart" });
  const plan = await planOf(t, "flow", { kind: "rolling-restart", options: fast });
  const second = await t.call("POST", "/api/services/flow/changes", { as: "uat" }, { kind: "rolling-restart", options: fast, planHash: plan.planHash });
  assert.equal(second.status, 409);
  assert.equal((await second.json()).error, "service-change/active");
  const other = await begin(t, "solo", { kind: "restart" });
  assert.ok(other, "a standalone next to it is another service");

  const c = await drive(t, "flow", id);
  assert.equal(c.state, "stopped");
  const third = await t.call("POST", "/api/services/flow/changes", { as: "uat" }, { kind: "rolling-restart", options: fast, planHash: plan.planHash });
  assert.equal(third.status, 409, "stopped still holds it");
  assert.equal(t.store.activeServiceChange("flow")!.id, id);
  assert.equal((await act(t, "flow", id, "close")).status, 200);
  assert.equal(changeOf(t, "flow", id).state, "closed");
  assert.equal(t.store.activeServiceChange("flow"), undefined);
  assert.equal((await act(t, "flow", id, "continue")).status, 409, "closed is closed");
  t.w.held.clear();
  const fourth = await t.call("POST", "/api/services/flow/changes", { as: "uat" }, { kind: "rolling-restart", options: fast, planHash: plan.planHash });
  assert.equal(fourth.status, 201);
});

test("a plan that changed since it was looked at is refused", async () => {
  const t = setup();
  takenOver(t);
  await revision(t, "solo");
  const plan = await planOf(t, "solo", { kind: "apply" });
  await revision(t, "solo", [{ file: "nifi.properties", key: "nifi.ui.banner.text", value: "newer" }]);
  const r = await t.call("POST", "/api/services/solo/changes", { as: "uat" }, { kind: "apply", planHash: plan.planHash });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, "service-change/plan-changed");
  assert.equal((await t.call("POST", "/api/services/solo/changes", { as: "uat" }, { kind: "apply" })).status, 400);
  const fresh = await planOf(t, "solo", { kind: "apply", revision: 2 });
  assert.equal(fresh.revision, 2);
  assert.equal(fresh.planHash, plan.planHash, "the same plan, asked by its revision");
});

test("permissions (§13, D7): viewers see plans and changes; UAT takes its group and personal keys; PROD only browsers; the AI's key never", async () => {
  const t = setup();
  takenOver(t);
  const body = { kind: "restart" };
  const plan = await planOf(t, "solo", body, { as: "viewer" });
  const start = (who: { as?: string; key?: string }) => t.call("POST", "/api/services/solo/changes", who, { ...body, planHash: plan.planHash });
  assert.equal((await start({ as: "viewer" })).status, 403);
  assert.equal((await start({ key: "dps_assistant" })).status, 403);
  assert.equal((await start({ as: "prod" })).status, 403, "the other environment's group");
  const viaKey = await start({ key: "dpk_uat" });
  assert.equal(viaKey.status, 201, await viaKey.clone().text());
  const made = await viaKey.json();
  assert.equal(made.via, "key");
  assert.equal((await act(t, "solo", made.id, "stop", { as: "viewer" })).status, 403);
  assert.equal((await act(t, "solo", made.id, "stop", { key: "dps_assistant" })).status, 403);

  const prod = setup("prod");
  takenOver(prod);
  const planned = await planOf(prod, "solo", body, { key: "dpk_prod" });
  const refused = await prod.call("POST", "/api/services/solo/changes", { key: "dpk_prod" }, { ...body, planHash: planned.planHash });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error, "auth/browser-only");
  assert.equal((await prod.call("POST", "/api/services/solo/changes", { as: "uat" }, { ...body, planHash: planned.planHash })).status, 403);
  const browser = await prod.call("POST", "/api/services/solo/changes", { as: "prod" }, { ...body, planHash: planned.planHash, reason: "patching" });
  assert.equal(browser.status, 201);
  const id = (await browser.json()).id;
  for (const what of ["stop", "continue", "rollback", "force-kill", "close"]) {
    const r = await act(prod, "solo", id, what, { key: "dpk_prod" });
    assert.equal(r.status, 403, what);
    assert.equal((await r.json()).error, "auth/browser-only");
  }
  assert.equal((await act(prod, "solo", id, "stop", { as: "prod" })).status, 200);
});

async function sampled(t: T, member: string, running: boolean, hash?: string) {
  const at = new Date(t.now.t - 1000).toISOString();
  const files = t.store.serviceMemberFiles("flow").filter((f) => f.member === member).map((f) => ({ name: f.file, sha256: hash ?? f.expectedSha256 }));
  ingest(t.store, [{
    service: "flow", member, at,
    process: running ? { running: true, pid: 1, startedAt: "2026-11-01T00:00:00Z" } : { running: false },
    nifi: running ? { state: "ok", about: { version: "2.5.0", timezone: "UTC" }, cluster: { nodes: [{ address: "localhost", apiPort: member === A ? 8443 : member === B ? 9443 : 10443, status: "CONNECTED", roles: member === A ? [COORD] : [] }] }, backpressure: { connections: 0, full: 0, maxPercent: 0 } } : { state: "not-running" },
    files,
  } as unknown as ServiceSample]);
}

test("the rules leave the member at work alone while the change runs, and judge it again once it has stopped", async () => {
  const t = setup();
  takenOver(t);
  t.w.held.add("start");
  const online: ExecutorInfo = { online: true, host: "local", ageSeconds: 5, heartbeat: { collector: { seconds: 30 } } as never };
  const rule = () => t.store.serviceAlerts({ service: "flow", state: "open" }).map((a) => `${a.rule} ${a.member}`).sort();
  const before = new Date(t.now.t).toISOString();
  await sampled(t, B, true);
  check(t.store, () => online, "flow", new Date(t.now.t));
  const id = await begin(t, "flow", { kind: "rolling-restart" });
  await drive(t, "flow", id, () => t.w.calls.includes(`start ${B}`));
  assert.equal(changeOf(t, "flow", id).currentMember, B);

  t.now.t += 30_000;
  await sampled(t, B, false, "e".repeat(64));
  check(t.store, () => online, "flow", new Date(t.now.t));
  assert.ok(!rule().some((r) => r === `process-down ${B}`), "no process-down for the node being worked on");
  assert.ok(!rule().some((r) => r === `node-disconnected ${B}`));
  assert.ok(!rule().some((r) => r === `no-samples ${B}`));
  assert.ok(!rule().some((r) => r === `config-drift ${B}`), "nor drift");
  // Another member is judged as ever.
  await sampled(t, C, false);
  check(t.store, () => online, "flow", new Date(t.now.t));
  assert.ok(rule().includes(`process-down ${C}`), "the others count");

  const c = await drive(t, "flow", id);
  assert.equal(c.state, "stopped");
  t.now.t += 3000;
  await sampled(t, B, false);
  check(t.store, () => online, "flow", new Date(t.now.t));
  assert.ok(rule().includes(`process-down ${B}`), "stopped: judged again");
  assert.ok(!t.store.serviceEvents("flow", { from: before }).some((e) => e.kind === "process-restarted"), "the timeline has the change's steps");
});

test("a standalone: stop, write, start, REST, health, without a cluster's steps; its own kinds", async () => {
  const t = setup();
  takenOver(t);
  await revision(t, "solo");
  const id = await begin(t, "solo", { kind: "apply" });
  assert.equal((await drive(t, "solo", id)).state, "succeeded");
  assert.deepEqual(touched(t), ["stop", "apply", "start"].map((a) => `${a} ${SOLO}`));
  assert.deepEqual(stepsOf(t, id).slice(0, 7), ["gate succeeded", `stop ${SOLO} succeeded`, `write ${SOLO} succeeded`, `start ${SOLO} succeeded`, `wait-rest ${SOLO} succeeded`, `wait-stable ${SOLO} succeeded`, `prune ${SOLO} succeeded`]);
  assert.equal(t.store.serviceMemberFiles("solo").find((f) => f.file === "nifi.properties")!.revision, 2);

  t.w.calls.length = 0;
  const stopped = await begin(t, "solo", { kind: "stop" });
  assert.equal((await drive(t, "solo", stopped)).state, "succeeded");
  assert.deepEqual(touched(t), [`stop ${SOLO}`]);
  assert.equal(t.w.nodes.get(SOLO)!.running, false);
  assert.ok(events(t, "solo").includes("node-stopped"));

  t.w.calls.length = 0;
  const started = await begin(t, "solo", { kind: "start" });
  assert.equal((await drive(t, "solo", started)).state, "succeeded");
  assert.deepEqual(touched(t), [`start ${SOLO}`]);
  assert.equal(t.w.nodes.get(SOLO)!.running, true);
});

test("only a file that needs no restart: written in place, nothing stopped (§16.3 no. 9)", async () => {
  const t = setup();
  takenOver(t);
  await revision(t, "solo", [{ file: "logback.xml", text: `<configuration scan="true"><root level="WARN"/></configuration>\n` }]);
  const plan = await planOf(t, "solo", { kind: "apply" });
  assert.equal(plan.restart, false);
  assert.deepEqual(plan.members[0].stages, ["write", "wait-stable"]);
  const id = await begin(t, "solo", { kind: "apply" });
  assert.equal((await drive(t, "solo", id)).state, "succeeded");
  assert.deepEqual(touched(t), [`apply ${SOLO}`]);
});

test("one node of a cluster: a restart or a stop is of that node, disconnected first; the others only checked", async () => {
  const t = setup();
  takenOver(t);
  const bad = await t.call("POST", "/api/services/flow/changes/plan", { as: "uat" }, { kind: "restart" });
  assert.equal(bad.status, 400);
  const id = await begin(t, "flow", { kind: "restart", members: [A] });
  assert.equal((await drive(t, "flow", id)).state, "succeeded");
  assert.deepEqual(touched(t), ["node-disconnect", "stop", "start"].map((a) => `${a} ${A}`));
  t.w.calls.length = 0;
  const off = await begin(t, "flow", { kind: "stop", members: [C] });
  assert.equal((await drive(t, "flow", off)).state, "succeeded");
  assert.deepEqual(touched(t), ["node-disconnect", "stop"].map((a) => `${a} ${C}`));
});

test("a stop that does not end: a person may kill those very processes, and then continue", async () => {
  const t = setup();
  takenOver(t);
  const pid = t.w.nodes.get(B)!.pid;
  t.w.failing.set(`stop ${B}`, { state: "failed", message: "still running", result: { stillRunning: true, process: { pid, startedAt: "2026-11-01T00:00:00Z" } } });
  const id = await begin(t, "flow", { kind: "rolling-restart" });
  const c = await drive(t, "flow", id);
  assert.equal(c.state, "stopped");
  assert.equal(c.currentMember, B);
  assert.ok(!t.w.calls.includes(`start ${B}`), "never killed by itself");
  assert.ok(!t.w.calls.some((x) => x.startsWith("kill")));
  const view = await (await t.call("GET", `/api/services/flow/changes/${id}`, { as: "viewer" })).json();
  assert.equal(view.progress.canForceKill, true);

  assert.equal((await act(t, "flow", id, "force-kill")).status, 200);
  const killed = await drive(t, "flow", id);
  assert.equal(killed.state, "stopped");
  assert.match(killed.message!, /killed: continue/);
  const job = t.store.serviceChangeSteps(id).at(-1)!.job!;
  assert.equal(t.store.executorJob(job)!.request.pid, pid, "only the pair it named");
  assert.equal(t.w.nodes.get(B)!.running, false);

  assert.equal((await act(t, "flow", id, "force-kill")).status, 409, "nothing left to kill");
  assert.equal((await act(t, "flow", id, "continue")).status, 200);
  assert.equal((await drive(t, "flow", id)).state, "succeeded");
});

test("stopping a running change by hand takes its queued job back, and continuing looks first", async () => {
  const t = setup();
  takenOver(t);
  const id = await begin(t, "flow", { kind: "rolling-restart" });
  await drive(t, "flow", id, (c) => t.store.runningServiceChangeStep(c.id)?.step === "stop");
  const job = t.store.runningServiceChangeStep(id)!.job!;
  assert.equal((await act(t, "flow", id, "stop")).status, 200);
  assert.equal(t.store.executorJob(job)!.status!.state, "refused");
  await t.w.run();
  assert.ok(!t.w.calls.includes(`stop ${B}`), "it does not run after all");
  assert.equal(changeOf(t, "flow", id).state, "stopped");
  assert.equal((await act(t, "flow", id, "stop")).status, 409);
  assert.equal((await act(t, "flow", id, "continue")).status, 200);
  assert.equal((await drive(t, "flow", id)).state, "succeeded");
});

test("what stops a plan early: the executor's state, the service user, a file on the host, the file's place", async () => {
  const codes = async (t: T, service: string, body: Record<string, unknown>) => (await planOf(t, service, body)).blocking.map((f: { code: string }) => f.code);
  const t = setup();
  takenOver(t);
  await revision(t, "flow");
  t.w.control = { operatorCert: false, killMode: "control-group", runuser: true };
  const blocked = await codes(t, "flow", { kind: "apply" });
  assert.ok(blocked.includes("change/kill-mode") && blocked.includes("change/no-operator-cert"), String(blocked));
  t.w.control = { operatorCert: true, killMode: "process", runuser: true };
  t.w.kinds = ["svc-read", "svc-state", "svc-state@1", "svc-control", "svc-control@1"];
  assert.ok((await codes(t, "flow", { kind: "apply" })).includes("change/executor-old"), "no svc-write");
  assert.deepEqual(await codes(t, "flow", { kind: "rolling-restart" }), [], "a restart does not need it");
  t.w.kinds = ["svc-read", "svc-read@2", "svc-state", "svc-state@1", "svc-write", "svc-write@1", "svc-control", "svc-control@1"];
  const r = await planOf(t, "flow", { kind: "apply" });
  t.w.offline = true;
  t.now.t += 60_000;
  const offline = await t.call("POST", "/api/services/flow/changes/plan", { as: "uat" }, { kind: "apply" });
  assert.ok((await offline.json()).blocking.some((f: { code: string }) => f.code === "change/executor-offline"));
  const refused = await t.call("POST", "/api/services/flow/changes", { as: "uat" }, { kind: "apply", planHash: r.planHash });
  assert.equal(refused.status, 409, "and it stops the start");
  assert.equal((await refused.json()).error, "service-change/blocked");
  t.w.offline = false;

  const rootly = setup();
  takenOver(rootly, "root");
  assert.ok((await codes(rootly, "solo", { kind: "restart" })).includes("change/service-user"));
  const unknown = setup();
  takenOver(unknown, null);
  assert.ok((await codes(unknown, "solo", { kind: "restart" })).includes("change/service-user"));
  const other = setup();
  takenOver(other, "someone");
  assert.ok((await codes(other, "solo", { kind: "restart" })).includes("change/other-user"));

  // A file drifted: not applied over, until it is adopted or overwritten.
  const drifted = setup();
  takenOver(drifted);
  await revision(drifted, "solo");
  drifted.store.setServiceMemberActuals("solo", SOLO, new Map([["nifi.properties", "d".repeat(64)]]), new Date(drifted.now.t).toISOString());
  assert.ok((await codes(drifted, "solo", { kind: "apply" })).includes("change/drifted"));

  // Nothing to do; options out of bounds.
  const quiet = setup();
  takenOver(quiet);
  const nothing = await planOf(quiet, "solo", { kind: "apply" });
  assert.equal(nothing.empty, true);
  assert.equal((await quiet.call("POST", "/api/services/solo/changes", { as: "uat" }, { kind: "apply", planHash: nothing.planHash })).status, 409);
  assert.equal((await quiet.call("POST", "/api/services/solo/changes/plan", { as: "uat" }, { kind: "restart", options: { timeouts: { stop: 99999 } } })).status, 400);
  assert.equal((await quiet.call("POST", "/api/services/solo/changes/plan", { as: "uat" }, { kind: "restart", options: { offload: true } })).status, 400);
  assert.equal((await quiet.call("POST", "/api/services/solo/changes/plan", { as: "uat" }, { kind: "rolling-restart" })).status, 400);
  assert.equal((await quiet.call("POST", "/api/services/nope/changes/plan", { as: "uat" }, { kind: "restart" })).status, 404);
});

test("overwriting drift: writes back what is kept, from what the host has now", async () => {
  const t = setup();
  takenOver(t);
  const kept = t.store.serviceMemberFiles("solo").find((f) => f.file === "nifi.properties")!;
  const live = sha("x\n");
  t.w.nodes.get(SOLO)!.files.set("nifi.properties", live);
  t.store.setServiceMemberActuals("solo", SOLO, new Map([["nifi.properties", live], ["logback.xml", t.w.nodes.get(SOLO)!.files.get("logback.xml")!]]), new Date(t.now.t).toISOString());
  const plan = await planOf(t, "solo", { kind: "overwrite" });
  assert.equal(plan.members.length, 1);
  assert.deepEqual(plan.members[0].files.map((f: { name: string }) => f.name), ["nifi.properties"]);
  assert.equal(plan.members[0].files[0].sha256, undefined, "no hashes in what is shown");
  assert.deepEqual(plan.blocking, []);
  const id = await begin(t, "solo", { kind: "overwrite" });
  const c = await drive(t, "solo", id);
  assert.equal(c.state, "succeeded", c.message ?? "");
  assert.equal(t.w.nodes.get(SOLO)!.files.get("nifi.properties"), kept.expectedSha256);
  assert.equal(t.store.serviceMemberFiles("solo").find((f) => f.file === "nifi.properties")!.revision, 1);
});

test("what a change shows: no hashes, no start environment, no secrets; the queue holds no file in the clear; settings kept from the running process", async () => {
  const t = setup();
  takenOver(t);
  await revision(t, "solo", [{ file: "nifi.properties", key: "nifi.security.keystorePasswd", secret: "new-s3cret" }]);
  t.w.nodes.get(SOLO)!.env = { JAVA_HOME: "/jdk-live" };
  t.w.held.add("apply");
  const id = await begin(t, "solo", { kind: "apply" });
  await drive(t, "solo", id, () => t.w.calls.includes(`stop ${SOLO}`));
  await drive(t, "solo", id, (c) => t.store.runningServiceChangeStep(c.id)?.step === "write");
  const step = t.store.runningServiceChangeStep(id)!;
  const raw = t.store.executorJob(step.job!)!;
  assert.ok(!JSON.stringify(raw.request).includes("s3cret"));
  const list = await (await t.call("GET", "/api/services/solo/changes", { as: "viewer" })).text();
  const one = await (await t.call("GET", `/api/services/solo/changes/${id}`, { as: "viewer" })).text();
  for (const text of [list, one]) {
    assert.doesNotMatch(text, /s3cret/);
    assert.doesNotMatch(text, /[0-9a-f]{64}/, "no hash");
    assert.doesNotMatch(text, /jdk-live|JAVA_HOME/, "no environment");
    assert.doesNotMatch(text, /v1:/, "nothing sealed");
  }
  const m = t.store.standalones()[0]!.member;
  assert.deepEqual(m.startEnvironment, { JAVA_HOME: "/jdk-live" }, "kept from the running process");
  assert.deepEqual(m.startLimits, { nofile: { soft: 50000, hard: 50000 } });
  const start = t.store.executorJob(t.store.serviceChangeSteps(id).find((s) => s.step === "stop")!.job!)!.request;
  assert.deepEqual(start.env, { JAVA_HOME: "/jdk-live" });
  assert.equal(start.serviceUser, "nifi");
  assert.equal(typeof start.expiresAt, "string");
  assert.equal(start.change, id);
});

test("the sealed queue: a write waiting has its content sealed, and it is dropped when the change stops", async () => {
  const t = setup();
  takenOver(t);
  await revision(t, "solo");
  const id = await begin(t, "solo", { kind: "apply" });
  await drive(t, "solo", id, (c) => t.store.runningServiceChangeStep(c.id)?.step === "write");
  // The write is queued now; the executor has not taken it.
  const job = t.store.runningServiceChangeStep(id)!.job!;
  const content = (t.store as unknown as { db: { prepare: (s: string) => { get: (a: string) => { content: string | null } } } }).db.prepare("SELECT content FROM executor_jobs WHERE id = ?").get(job).content;
  assert.match(content!, /^v1:/);
  assert.equal((await act(t, "solo", id, "stop")).status, 200);
  const after = (t.store as unknown as { db: { prepare: (s: string) => { get: (a: string) => { content: string | null } } } }).db.prepare("SELECT content FROM executor_jobs WHERE id = ?").get(job).content;
  assert.equal(after, null);
});

test("while a change holds a service: no adopting, no upgrade of its host's executor or of the Deployer; stopped lets upgrades through", async () => {
  const t = setup();
  takenOver(t);
  const beat = () => t.handoff.heartbeat("local", { version: "0.1.0", protocols: [2], at: "", project: "", registries: [], databaseBackup: {}, busy: null, kinds: ["executor-upgrade", "deployer-upgrade"], upgradeFrom: "directory", deployer: { image: "x/deployer" } } as never);
  const blocked = async () => {
    beat();
    const hosts = await (await t.call("GET", "/api/hosts", { as: "admin" })).json();
    const self = await (await t.call("GET", "/api/deployer", { as: "admin" })).json();
    return { host: hosts.hosts[0].upgrade.blocked as string | undefined, self: self.blocked as string | undefined };
  };
  assert.deepEqual(await blocked(), { host: undefined, self: undefined });
  t.w.held.add("start");
  const id = await begin(t, "flow", { kind: "rolling-restart" });
  await drive(t, "flow", id, () => t.w.calls.includes(`start ${B}`));
  const during = await blocked();
  assert.match(during.host!, /in the middle of change/);
  assert.match(during.self!, /in progress/);
  const adopt = await t.call("POST", "/api/services/flow/drift/adopt", { as: "uat" }, { member: B, file: "nifi.properties", sha256: "a".repeat(64) });
  assert.equal(adopt.status, 409);
  assert.equal((await adopt.json()).error, "drift/change-active");

  assert.equal((await drive(t, "flow", id)).state, "stopped");
  assert.deepEqual(await blocked(), { host: undefined, self: undefined });
  assert.equal((await t.call("POST", "/api/services/flow/drift/adopt", { as: "uat" }, { member: B, file: "nifi.properties", sha256: "a".repeat(64) })).status, 409, "the files may be half way");
});

test("what a member goes through: the stages and what is left given what the host has", () => {
  const files = [{ name: "nifi.properties", baseSha256: "b", sha256: "n" }] as never[];
  const write = { restart: true, files };
  assert.deepEqual(stagesFor("apply", true, write, true), ["disconnect", "offload", "stop", "write", "start", "wait-rest", "wait-connected", "wait-stable"]);
  assert.deepEqual(stagesFor("apply", false, write, false), ["stop", "write", "start", "wait-rest", "wait-stable"]);
  assert.deepEqual(stagesFor("apply", false, { restart: false, files }, false), ["write", "wait-stable"]);
  assert.deepEqual(stagesFor("rolling-restart", true, { restart: true, files: [] }, false), ["disconnect", "stop", "start", "wait-rest", "wait-connected", "wait-stable"]);
  const all = stagesFor("apply", true, write, true);
  const pair = { pid: 1, startedAt: "x" };
  const answer = (running: boolean, hash: string, pid = 1) => ({ process: running ? { running: true, pid, startedAt: "x" } : { running: false }, environment: null, limits: null, files: [{ name: "nifi.properties", sha256: hash }], rest: { state: running ? "ok" : "not-running" } });
  assert.deepEqual(nowStages(all, { files }, answer(true, "b"), pair, "CONNECTED"), all, "nothing done yet");
  assert.deepEqual(nowStages(all, { files }, answer(true, "b"), pair, "DISCONNECTED"), all.filter((s) => s !== "disconnect"), "already away");
  assert.deepEqual(nowStages(all, { files }, answer(false, "b"), pair, null), ["write", "start", "wait-rest", "wait-connected", "wait-stable"], "already stopped");
  assert.deepEqual(nowStages(all, { files }, answer(false, "n"), pair, null), ["start", "wait-rest", "wait-connected", "wait-stable"], "already written");
  assert.deepEqual(nowStages(all, { files }, answer(true, "n", 2), pair, "DISCONNECTED"), ["wait-rest", "wait-connected", "wait-stable"], "already started again");
  assert.deepEqual(nowStages(all, { files }, answer(true, "n"), pair, "CONNECTED"), all.filter((s) => s !== "write"), "written but this process has not read it");
  assert.deepEqual(nowStages(["disconnect", "stop"], { files: [] }, answer(false, "b"), null, null), [], "a stop of one that is stopped");
});

test("the executor says interrupted the way the engine knows", () => {
  const python = readFileSync(new URL("../executor/service_executor.py", import.meta.url), "utf8");
  assert.ok(python.includes(`INTERRUPTED = "${INTERRUPTED}"`));
});

/** ZooKeeper messages enough to open zk-errors, were it judged. */
function zkMessages(t: T) {
  const at = new Date(t.now.t - 1000).toISOString();
  t.store.addServiceBulletins([1, 2, 3, 4, 5].map((i) => ({ service: "flow", member: A, node: "n", id: t.now.t + i, at, level: "ERROR", category: "x", source: "x", sourceType: "x", message: "ZooKeeper ConnectionLoss" })));
}

// --- the whole cluster (S31, §8, §16.3) ----------------------------------------------------------------------------------

const ROOT = [{ file: "nifi.properties", key: "nifi.zookeeper.root.node", value: "/other" }, { file: "nifi.properties", key: "nifi.ui.banner.text", value: "hi" }];
const NODES = [A, B, C];
const cluster = (t: T) => NODES.map((k) => t.w.nodes.get(k)!);
const calls = (t: T, action: string) => t.w.calls.filter((x) => x.startsWith(`${action} `));
const propsOf = (t: T) => cluster(t).map((n) => n.files.get("nifi.properties"));

/** The rules of the flow, checked at every job the hosts get: nothing written while a node runs, nothing written before every backup, no start over a mix. */
function guard(t: T, more?: (action: string, member: string) => void) {
  const old = new Map(cluster(t).map((n) => [n.key, n.files.get("nifi.properties")]));
  t.w.onJob = (action, member) => {
    if (action === "backup" || action === "apply" || action === "restore") assert.ok(cluster(t).every((n) => !n.running), `${action} on ${member} while a node runs`);
    if (action === "apply") assert.ok(cluster(t).every((n) => n.backup), `apply on ${member} before every backup`);
    if (action === "start") {
      const fresh = cluster(t).filter((n) => n.files.get("nifi.properties") !== old.get(n.key)).length;
      assert.ok(fresh === 0 || fresh === NODES.length, `start on ${member} over a mix of old and new`);
    }
    more?.(action, member);
  };
}
async function fullChange(t: T, who: { as: string } = { as: "uat" }) {
  takenOver(t);
  const rev = await revision(t, "flow", ROOT, who);
  return { rev, old: propsOf(t) };
}

test("full: a key that cannot roll takes the ordinary keys along: every node stopped and confirmed one by one, all backed up, all written, all started at once, the cluster waited for", async () => {
  const t = setup();
  const { rev, old } = await fullChange(t);
  guard(t);
  const plan = await planOf(t, "flow", { kind: "apply", options: fast });
  assert.equal(plan.mode, "full");
  assert.deepEqual(plan.fullBecause, [{ file: "nifi.properties", key: "nifi.zookeeper.root.node" }]);
  assert.deepEqual(plan.blocking, [], "change/full-not-yet is gone");
  assert.ok(plan.findings.some((f: { code: string }) => f.code === "config/not-rolling-safe"));
  assert.equal(plan.members.length, 3);
  assert.ok(plan.members.every((m: { restart: boolean; stages: string[] }) => m.restart && m.stages.join() === "stop,write,start"));
  assert.match(plan.order, /whole cluster/);
  // A request cannot choose: the mode is the server's, in the plan and its hash.
  const asked = await planOf(t, "flow", { kind: "apply", mode: "rolling", options: fast });
  assert.equal(asked.mode, "full");
  assert.equal(asked.planHash, plan.planHash);

  const id = await begin(t, "flow", { kind: "apply" });
  const c = await drive(t, "flow", id);
  assert.equal(c.state, "succeeded", c.message ?? "");
  assert.equal(c.mode, "full");
  assert.deepEqual(touched(t), [
    ...NODES.map((m) => `check ${m}`),
    `stop ${B}`, `stop ${C}`, `stop ${A}`,
    ...NODES.flatMap((m) => [`backup ${m}`]), ...NODES.map((m) => `apply ${m}`), ...NODES.map((m) => `start ${m}`),
  ]);
  assert.ok(!t.w.calls.some((x) => /node-|kill|restore/.test(x)), "not disconnected, not offloaded, nothing else");
  assert.equal(calls(t, "prune").length, 3);
  const steps = t.store.serviceChangeSteps(id);
  const startedAt = (name: string) => steps.filter((s) => s.step === name).map((s) => s.startedAt);
  assert.equal(new Set(startedAt("start")).size, 1, "sent together");
  assert.equal(new Set(startedAt("stop")).size, 3, "each after the one before");
  assert.equal(steps.find((s) => s.step === "compose")!.member, null, "a step of the cluster's");
  assert.ok(steps.every((s) => s.state === "succeeded"));
  for (const job of steps.filter((s) => s.step === "backup" || s.step === "check")) assert.equal(t.store.executorJob(job.job!)!.request.flowFile, true, "the flow file with the backup");
  for (const n of cluster(t)) {
    assert.equal(n.flowBackup, n.flow);
    assert.notEqual(n.files.get("nifi.properties"), old[NODES.indexOf(n.key)]);
    assert.equal(n.running && n.status, "CONNECTED");
  }
  for (const f of t.store.serviceMemberFiles("flow").filter((x) => x.file === "nifi.properties")) {
    assert.equal(f.revision, rev);
    assert.equal(f.change, id);
    assert.equal(f.actualSha256, f.expectedSha256);
  }
  const kinds = events(t, "flow");
  assert.equal(kinds.filter((k) => k === "node-stopped").length, 3);
  assert.equal(kinds.filter((k) => k === "node-started").length, 3);
  assert.equal(kinds.filter((k) => k === "config-applied").length, 3);
  assert.equal(kinds.at(-1), "change-finished");
  assert.equal(t.store.activeServiceChange("flow"), undefined);
  const status = await (await t.call("GET", "/api/services/flow/status", { as: "viewer" })).json();
  assert.deepEqual(status.members.flatMap((m: { configPending: string[] }) => m.configPending), []);
});

test("full: a member whose own files do not change still stops and starts, and is backed up with its flow, with nothing to write", async () => {
  const t = setup();
  const { rev } = await fullChange(t);
  const target = t.store.serviceConfig("flow", rev)!.body.members.find((m) => `${m.host}:${m.installDir}` === B)!.files.find((f) => f.name === "nifi.properties")!;
  t.store.setMemberFilesApplied("flow", B, [{ file: "nifi.properties", path: target.path, sha256: target.sha256, revision: rev }], "earlier");
  t.w.nodes.get(B)!.files.set("nifi.properties", target.sha256);
  const id = await begin(t, "flow", { kind: "apply" });
  assert.equal((await drive(t, "flow", id)).state, "succeeded");
  assert.ok(t.w.calls.includes(`stop ${B}`) && t.w.calls.includes(`start ${B}`) && t.w.calls.includes(`backup ${B}`));
  assert.ok(!t.w.calls.includes(`apply ${B}`));
  assert.ok(t.w.calls.includes(`apply ${A}`));
  const job = t.store.serviceChangeSteps(id).find((s) => s.step === "backup" && s.member === B)!.job!;
  assert.deepEqual(t.store.executorJob(job)!.request.files, []);
});

test("full: the plan: all members or none, no offload, the time to come together follows the flow election, a changed plan is refused, the P15 warning does not stop it", async () => {
  const t = setup();
  takenOver(t);
  await revision(t, "flow", [...ROOT, { file: "nifi.properties", key: "nifi.sensitive.props.key", secret: "new-props-key" }, { file: "nifi.properties", key: "nifi.cluster.flow.election.max.wait.time", value: "40 mins" }]);
  const subset = await planOf(t, "flow", { kind: "apply", members: [A] });
  assert.ok(subset.blocking.some((f: { code: string }) => f.code === "config/full-needs-all-members"));
  const refused = await t.call("POST", "/api/services/flow/changes", { as: "uat" }, { kind: "apply", members: [A], planHash: subset.planHash });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error, "service-change/blocked");

  const plan = await planOf(t, "flow", { kind: "apply", options: { offload: true } });
  assert.equal(plan.options.offload, false);
  assert.ok(plan.findings.some((f: { code: string }) => f.code === "change/full-no-offload"));
  assert.ok(plan.members.every((m: { stages: string[] }) => !m.stages.includes("offload") && !m.stages.includes("disconnect")));
  assert.equal(plan.options.timeouts.compose, 40 * 60 + 600, "the election's wait and ten minutes");
  assert.equal((await planOf(t, "flow", { kind: "apply", options: { timeouts: { compose: 77 } } })).options.timeouts.compose, 77);

  const migration = plan.findings.find((f: { code: string }) => f.code === "config/sensitive-key-migration");
  assert.equal(migration.severity, "warning", "P15: told, not stopped, and no migration is in the flow");
  assert.deepEqual(plan.blocking, []);
  assert.ok(plan.fullBecause.some((f: { key?: string }) => f.key === "nifi.sensitive.props.key"));

  await revision(t, "flow", [{ file: "nifi.properties", key: "nifi.ui.banner.text", value: "newer" }]);
  const stale = await t.call("POST", "/api/services/flow/changes", { as: "uat" }, { kind: "apply", options: { offload: true }, planHash: plan.planHash });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error, "service-change/plan-changed");
  assert.deepEqual(t.w.calls.filter((x) => !x.startsWith("svc")), [], "nothing was touched");

  // Without the default wait written anywhere, the design's 15 minutes hold.
  const quiet = setup();
  await fullChange(quiet);
  assert.equal((await planOf(quiet, "flow", { kind: "apply" })).options.timeouts.compose, 900);
  // No operator certificate is needed: nothing is disconnected.
  quiet.w.control = { operatorCert: false, killMode: "process", runuser: true };
  assert.deepEqual((await planOf(quiet, "flow", { kind: "apply" })).blocking, []);
  // And a standalone is never full.
  const solo = setup();
  takenOver(solo);
  await revision(solo, "solo", ROOT);
  assert.equal((await planOf(solo, "solo", { kind: "apply" })).mode, "rolling");
});

test("full: a sensitive key whose flow cannot be read: told, tried, and rolled back by itself (P15)", async () => {
  const t = setup();
  takenOver(t);
  await revision(t, "flow", [{ file: "nifi.properties", key: "nifi.sensitive.props.key", secret: "new-props-key" }]);
  guard(t);
  t.w.failing.set(`start ${A}`, { state: "failed", message: "the flow could not be decrypted" });
  const id = await begin(t, "flow", { kind: "apply" });
  const c = await drive(t, "flow", id);
  assert.equal(c.state, "rolled-back", c.message ?? "");
  assert.match(c.message!, /could not be decrypted/);
  assert.ok(!t.w.calls.some((x) => /migrat|set-sensitive/.test(x)));
});

test("full: the check before anything: what fails ends the change with nothing touched; a node down or away only warns", async () => {
  for (const [spoil, says] of [
    [(t: T) => { t.w.failing.set(`check ${B}`, { state: "refused", message: "cannot write in the directory" }); }, /cannot write/],
    [(t: T) => { t.w.nodes.get(C)!.files.set("nifi.properties", "f".repeat(64)); }, /changed on the host/],
    [(t: T) => { t.store.setServiceMemberStart("flow", C, null, null); t.w.nodes.get(C)!.running = false; }, /no start environment/],
  ] as const) {
    const t = setup();
    await fullChange(t);
    const plan = await planOf(t, "flow", { kind: "apply", options: fast });
    spoil(t);
    const r = await t.call("POST", "/api/services/flow/changes", { as: "uat" }, { kind: "apply", options: fast, planHash: plan.planHash });
    assert.equal(r.status, 201, await r.clone().text());
    const c = await drive(t, "flow", (await r.json()).id);
    assert.equal(c.state, "closed", c.message ?? "");
    assert.match(c.message!, says);
    assert.match(c.message!, /Nothing was touched/);
    assert.deepEqual(t.w.calls.filter((x) => !x.startsWith("check")), []);
    assert.equal(t.store.activeServiceChange("flow"), undefined);
  }
  const off = setup();
  await fullChange(off);
  const id0 = await begin(off, "flow", { kind: "apply" });
  off.w.offline = true;
  off.now.t += 60_000;
  // Started while it was still there; gone by the time of the check.
  const c0 = await drive(off, "flow", id0);
  assert.equal(c0.state, "closed", c0.message ?? "");
  assert.deepEqual(off.w.calls, []);

  const t = setup();
  await fullChange(t);
  guard(t);
  const down = t.w.nodes.get(B)!;
  down.running = false;
  down.status = "DISCONNECTED";
  t.w.nodes.get(C)!.status = "DISCONNECTED";
  const id = await begin(t, "flow", { kind: "apply" });
  const c = await drive(t, "flow", id);
  assert.equal(c.state, "succeeded", c.message ?? "");
  assert.ok(!t.w.calls.includes(`stop ${B}`), "it was not running");
  assert.ok(t.w.calls.includes(`start ${B}`), "and the end is the same: all of them up");
  const gate = t.store.serviceChangeSteps(id).find((s) => s.step === "gate")!;
  assert.deepEqual(gate.detail.warnings, [`${B} is not running`, `${C} is not connected`]);
});

test("full: a stop that fails or times out stops there: files untouched, nothing killed, nothing started; the person kills and goes on, or starts what was stopped", async () => {
  const stuck = async () => {
    const t = setup();
    await fullChange(t);
    guard(t);
    const n = t.w.nodes.get(C)!;
    t.w.failing.set(`stop ${C}`, { state: "failed", message: "still running", result: { stillRunning: true, process: { pid: n.pid, startedAt: n.startedAt } } });
    const id = await begin(t, "flow", { kind: "apply" });
    const c = await drive(t, "flow", id);
    assert.equal(c.state, "stopped", c.message ?? "");
    assert.equal(c.currentMember, C);
    assert.deepEqual(touched(t).filter((x) => !x.startsWith("check")), [`stop ${B}`, `stop ${C}`], "the next was not stopped, and nothing else");
    assert.equal(t.w.nodes.get(B)!.running, false, "not started by itself");
    const view = await (await t.call("GET", `/api/services/flow/changes/${id}`, { as: "viewer" })).json();
    assert.equal(view.progress.canForceKill, true);
    assert.equal(view.progress.canRollBack, true);
    assert.equal(view.progress.wrote, false);
    return { t, id };
  };
  const killed = await stuck();
  assert.equal((await act(killed.t, "flow", killed.id, "force-kill")).status, 200);
  assert.match((await drive(killed.t, "flow", killed.id)).message!, /killed: continue/);
  assert.equal(killed.t.w.nodes.get(C)!.running, false);
  assert.equal((await act(killed.t, "flow", killed.id, "continue")).status, 200);
  const on = await drive(killed.t, "flow", killed.id);
  assert.equal(on.state, "succeeded", on.message ?? "");
  assert.equal(calls(killed.t, "stop").length, 3, "b is not stopped twice, a is stopped now");

  const back = await stuck();
  const old = propsOf(back.t);
  assert.equal((await act(back.t, "flow", back.id, "rollback")).status, 200);
  const after = await drive(back.t, "flow", back.id);
  assert.equal(after.state, "rolled-back", after.message ?? "");
  assert.deepEqual(calls(back.t, "start"), [`start ${B}`], "only what was stopped; the others keep running");
  assert.equal(calls(back.t, "restore").length, 0, "no file was touched");
  assert.equal(calls(back.t, "backup").length, 0);
  assert.deepEqual(propsOf(back.t), old);
  assert.ok(cluster(back.t).every((n) => n.running && n.status === "CONNECTED"));

  const t = setup();
  await fullChange(t);
  t.w.held.add(`stop ${B}`);
  const id = await begin(t, "flow", { kind: "apply" });
  const c = await drive(t, "flow", id);
  assert.equal(c.state, "stopped");
  assert.match(c.message!, /stop on .* timed out/);
  assert.ok(!t.w.calls.includes(`stop ${C}`));
  assert.equal(t.store.serviceChangeSteps(id).at(-1)!.state, "timed-out");
});

test("full: a backup that fails: no file written, no restore, all started again, rolled back", async () => {
  const t = setup();
  const { old } = await fullChange(t);
  guard(t);
  t.w.failing.set(`backup ${C}`, { state: "failed", message: "no space left" });
  const id = await begin(t, "flow", { kind: "apply" });
  const c = await drive(t, "flow", id);
  assert.equal(c.state, "rolled-back", c.message ?? "");
  assert.match(c.message!, /no space left/);
  assert.equal(calls(t, "apply").length, 0, "none written though two backups went well");
  assert.equal(calls(t, "restore").length, 0);
  assert.equal(calls(t, "start").length, 3);
  assert.deepEqual(propsOf(t), old);
  assert.ok(events(t, "flow").includes("config-rolled-back"));
  assert.equal(t.store.activeServiceChange("flow"), undefined);
});

test("full: a write that fails: every member back from its backup, the flow too, all started, rolled back once and no more", async () => {
  const t = setup();
  const { old } = await fullChange(t);
  guard(t);
  t.w.failing.set(`apply ${C}`, { state: "failed", message: "disk full", result: { rolledBack: true, notRestored: [] } });
  const id = await begin(t, "flow", { kind: "apply" });
  t.w.nodes.get(A)!.flow = "flow-a";
  const c = await drive(t, "flow", id);
  assert.equal(c.state, "rolled-back", c.message ?? "");
  assert.equal(calls(t, "restore").length, 3);
  assert.equal(calls(t, "start").length, 3);
  assert.deepEqual(propsOf(t), old);
  assert.ok(t.store.serviceMemberFiles("flow").every((f) => f.revision === 1), "what they should be has not moved");
  assert.ok(!t.w.calls.some((x) => x.startsWith("prune")), "failed changes keep their backups");
  assert.equal(calls(t, "apply").length, 3, "not tried again");
});

test("full: starting fails, a node dies, the cluster does not come together, or the health check does not pass: rolled back by itself", async () => {
  const running = async (t: T) => {
    const id = await begin(t, "flow", { kind: "apply" });
    const c = await drive(t, "flow", id);
    assert.equal(c.state, "rolled-back", c.message ?? "");
    assert.equal(calls(t, "restore").length, 3);
    assert.equal(calls(t, "apply").length, 3, "not tried again");
    assert.ok(cluster(t).every((n) => n.running && n.status === "CONNECTED"));
    return c;
  };
  const failed = setup();
  await fullChange(failed);
  guard(failed);
  failed.w.failing.set(`start ${B}`, { state: "failed", message: "no JVM" });
  assert.match((await running(failed)).message!, /no JVM/);

  const dies = setup();
  await fullChange(dies);
  let once = true;
  guard(dies, (action, member) => { if (action === "start" && member === C && once) { once = false; dies.w.nodes.get(C)!.dies = true; } });
  assert.match((await running(dies)).message!, /not running any more/);

  // No coordinator ever: the election does not end under the new settings.
  const election = setup();
  await fullChange(election);
  let restored = false;
  guard(election, (action) => {
    if (action === "restore") restored = true;
    if (action === "start" && !restored) for (const n of cluster(election)) { n.saved ??= n.roles; n.roles = []; }
    if (action === "start" && restored) for (const n of cluster(election)) if (n.saved) { n.roles = n.saved; }
  });
  assert.match((await running(election)).message!, /did not come together in time: no cluster coordinator/);

  // A node that does not connect.
  const away = setup();
  await fullChange(away);
  let back = false;
  guard(away, (action) => {
    if (action === "restore") back = true;
    if (action === "start") away.w.nodes.get(C)!.connects = back;
  });
  assert.match((await running(away)).message!, /did not come together in time: local:\/opt\/c not connected/);

  // A node short: the table has fewer than the members.
  const short = setup();
  await fullChange(short);
  let whole = false;
  const nope = short.w.table;
  short.w.table = (me) => { const x = nope(me); return x && !whole ? { ...x, nodes: x.nodes.filter((n) => n.nodeId !== "node-b") } : x; };
  guard(short, (action) => { if (action === "restore") whole = true; });
  assert.match((await running(short)).message!, /2 of 3 nodes/);

  const health = setup();
  await fullChange(health);
  guard(health, (action) => {
    if (action === "apply") for (const n of cluster(health)) n.invalid = 9;
    if (action === "restore") for (const n of cluster(health)) n.invalid = 2;
  });
  assert.match((await running(health)).message!, /9 invalid components, 2 before/);
});

test("full: an election that takes its time, REST away and no table meanwhile, is waiting and not failing", async () => {
  const t = setup();
  await fullChange(t);
  guard(t, (action, member) => { if (action === "start") { t.w.nodes.get(member)!.rest = false; } });
  const id = await begin(t, "flow", { kind: "apply" });
  await drive(t, "flow", id, (c) => c.phase === "compose");
  for (let i = 0; i < 6; i++) { await t.w.run(); t.engine.changes.tick(); t.now.t += 3000; }
  const c = changeOf(t, "flow", id);
  assert.equal(c.state, "running");
  const view = await (await t.call("GET", `/api/services/flow/changes/${id}`, { as: "viewer" })).json();
  assert.equal(view.progress.composing, "no cluster coordinator");
  for (const n of cluster(t)) n.rest = true;
  assert.equal((await drive(t, "flow", id)).state, "succeeded");
});

test("full: rolling back that fails stops at once, says so, and is not tried again by itself", async () => {
  const restoreFails = setup();
  const r = await fullChange(restoreFails);
  guard(restoreFails);
  restoreFails.w.failing.set(`apply ${A}`, { state: "failed", message: "disk full" });
  restoreFails.w.failing.set(`restore ${B}`, { state: "failed", message: "read-only file system" });
  const id = await begin(restoreFails, "flow", { kind: "apply" });
  const c = await drive(restoreFails, "flow", id);
  assert.equal(c.state, "stopped");
  assert.match(c.message!, /Rolling back failed.*read-only/);
  assert.equal(calls(restoreFails, "restore").length, 3);
  assert.equal(calls(restoreFails, "start").length, 0, "the files may be a mix: nothing started");
  // A person's rollback goes on from what the hosts have.
  assert.equal((await act(restoreFails, "flow", id, "rollback")).status, 200);
  const again = await drive(restoreFails, "flow", id);
  assert.equal(again.state, "rolled-back", again.message ?? "");
  assert.deepEqual(propsOf(restoreFails), r.old);

  const startFails = setup();
  await fullChange(startFails);
  guard(startFails, (action) => { if (action === "restore") startFails.w.failing.set(`start ${C}`, { state: "failed", message: "no JVM either" }); });
  startFails.w.failing.set(`apply ${A}`, { state: "failed", message: "disk full" });
  const id2 = await begin(startFails, "flow", { kind: "apply" });
  const c2 = await drive(startFails, "flow", id2);
  assert.equal(c2.state, "stopped");
  assert.match(c2.message!, /Rolling back failed.*no JVM either/);
  assert.equal(calls(startFails, "restore").length, 3);
  assert.equal(calls(startFails, "start").length, 3);

  const neverUp = setup();
  await fullChange(neverUp);
  guard(neverUp, (action) => { if (action === "restore") for (const n of cluster(neverUp)) n.roles = []; });
  neverUp.w.failing.set(`apply ${A}`, { state: "failed", message: "disk full" });
  const id3 = await begin(neverUp, "flow", { kind: "apply" });
  const c3 = await drive(neverUp, "flow", id3);
  assert.equal(c3.state, "stopped");
  assert.match(c3.message!, /Rolling back failed.*no cluster coordinator/);
  assert.equal(calls(neverUp, "restore").length, 3);
  assert.equal(calls(neverUp, "start").length, 3);
  assert.equal(calls(neverUp, "apply").length, 3);
});

test("full: the hard rule: whatever the jobs said, the hosts are asked before any start, and a mix never starts", async () => {
  // The write said it went well, and c has the old file: a mix. Rolled back, with nothing started over it.
  const t = setup();
  const { old } = await fullChange(t);
  guard(t);
  const original = t.w.handle;
  t.w.handle = (job) => {
    if (job.action === "apply" && job.member === C) { t.w.calls.push(`apply ${C}`); return t.handoff.putStatus(String(job.id), { state: "succeeded" as never, steps: [], result: {} as never }); }
    original(job);
  };
  const id = await begin(t, "flow", { kind: "apply" });
  const c = await drive(t, "flow", id);
  assert.equal(c.state, "rolled-back", c.message ?? "");
  assert.match(c.message!, /local:\/opt\/c does not have the new files/);
  assert.deepEqual(propsOf(t), old);
  assert.ok(t.w.calls.indexOf(`restore ${A}`) < t.w.calls.indexOf(`start ${A}`));

  // Rolling back, the restore says it went well and b has the new file: nothing starts, and a person is asked.
  const t2 = setup();
  await fullChange(t2);
  guard(t2);
  t2.w.failing.set(`start ${A}`, { state: "failed", message: "no JVM", didIt: false });
  const original2 = t2.w.handle;
  t2.w.handle = (job) => {
    if (job.action === "restore" && job.member === B) { t2.w.calls.push(`restore ${B}`); return t2.handoff.putStatus(String(job.id), { state: "succeeded" as never, steps: [], result: {} as never }); }
    original2(job);
  };
  const id2 = await begin(t2, "flow", { kind: "apply" });
  const c2 = await drive(t2, "flow", id2);
  assert.equal(c2.state, "stopped");
  assert.match(c2.message!, /Rolling back failed.*local:\/opt\/b does not have the old files.*No node was started/);
  const started = t2.w.calls.filter((x, i) => x.startsWith("start ") && i > t2.w.calls.indexOf(`restore ${A}`));
  assert.deepEqual(started, []);
});

test("full: the executor gone in the middle of a job: stopped, nothing rolled back; continuing writes only what is left, and refuses a mix with a node running", async () => {
  const t = setup();
  await fullChange(t);
  guard(t);
  t.w.failing.set(`apply ${C}`, { state: "failed", message: INTERRUPTED });
  const id = await begin(t, "flow", { kind: "apply" });
  const c = await drive(t, "flow", id);
  assert.equal(c.state, "stopped", c.message ?? "");
  assert.match(c.message!, /stopped while this job ran.*not known/);
  assert.equal(calls(t, "restore").length, 0, "no rollback by itself");
  assert.equal(calls(t, "start").length, 0, "a mix does not start");
  const view = await (await t.call("GET", `/api/services/flow/changes/${id}`, { as: "viewer" })).json();
  assert.equal(view.progress.wrote, true);

  // Someone started a node meanwhile: a mix with a node running goes to a person.
  t.w.nodes.get(A)!.running = true;
  assert.equal((await act(t, "flow", id, "continue")).status, 200);
  const refused = await drive(t, "flow", id);
  assert.equal(refused.state, "stopped");
  assert.match(refused.message!, /mix of old and new and local:\/opt\/a is running/);
  assert.equal(calls(t, "apply").length, 3);
  t.w.nodes.get(A)!.running = false;

  assert.equal((await act(t, "flow", id, "continue")).status, 200);
  const on = await drive(t, "flow", id);
  assert.equal(on.state, "succeeded", on.message ?? "");
  assert.equal(calls(t, "apply").filter((x) => x === `apply ${C}`).length, 2, "only what was left");
  assert.equal(calls(t, "apply").filter((x) => x === `apply ${A}`).length, 1);
  assert.equal(calls(t, "backup").length, 3, "the backups stay as they were");
  assert.ok(stepsOf(t, id).includes("reconcile succeeded"));

  // Or rolled back from the same place.
  const t2 = setup();
  const r = await fullChange(t2);
  guard(t2);
  t2.w.failing.set(`apply ${C}`, { state: "failed", message: INTERRUPTED });
  const id2 = await begin(t2, "flow", { kind: "apply" });
  await drive(t2, "flow", id2);
  assert.equal((await act(t2, "flow", id2, "rollback")).status, 200);
  const back = await drive(t2, "flow", id2);
  assert.equal(back.state, "rolled-back", back.message ?? "");
  assert.deepEqual(propsOf(t2), r.old);
  assert.equal(calls(t2, "restore").length, 3);

  // A stop interrupted: going on stops the rest.
  const t3 = setup();
  await fullChange(t3);
  guard(t3);
  t3.w.failing.set(`stop ${C}`, { state: "failed", message: INTERRUPTED, didIt: true });
  const id3 = await begin(t3, "flow", { kind: "apply" });
  const c3 = await drive(t3, "flow", id3);
  assert.equal(c3.state, "stopped");
  assert.equal(calls(t3, "backup").length, 0);
  assert.equal((await act(t3, "flow", id3, "continue")).status, 200);
  const on3 = await drive(t3, "flow", id3);
  assert.equal(on3.state, "succeeded", on3.message ?? "");
  assert.deepEqual(calls(t3, "stop"), [`stop ${B}`, `stop ${C}`, `stop ${A}`]);

  // A job taken and never answered: at its deadline it stops, for the same reason. So does a start.
  const t4 = setup();
  await fullChange(t4);
  guard(t4);
  t4.w.held.add(`start ${C}`);
  const id4 = await begin(t4, "flow", { kind: "apply" });
  const c4 = await drive(t4, "flow", id4);
  assert.equal(c4.state, "stopped");
  assert.match(c4.message!, /start on local:\/opt\/c timed out.*not known/);
  assert.equal(calls(t4, "restore").length, 0);
  t4.w.held.clear();
  assert.equal((await act(t4, "flow", id4, "continue")).status, 200);
  const on4 = await drive(t4, "flow", id4);
  assert.equal(on4.state, "succeeded", on4.message ?? "");
  assert.equal(calls(t4, "start").filter((x) => x === `start ${A}`).length, 1, "what runs is not started again");
});

test("full: an executor gone while the cluster comes together: stopped at the deadline with nothing rolled back, and it can go on", async () => {
  const t = setup();
  await fullChange(t);
  guard(t);
  const id = await begin(t, "flow", { kind: "apply" });
  await drive(t, "flow", id, (c) => c.phase === "compose");
  t.w.offline = true;
  const c = await drive(t, "flow", id);
  assert.equal(c.state, "stopped", c.message ?? "");
  assert.match(c.message!, /did not come together.*no answer.*not known/);
  assert.equal(calls(t, "restore").length, 0);
  t.w.offline = false;
  await t.w.run();
  assert.equal((await act(t, "flow", id, "continue")).status, 200);
  assert.equal((await drive(t, "flow", id)).state, "succeeded");
  assert.equal(calls(t, "start").length, 3);
});

test("full: the Deployer restarting before any file is written: paused, and a person chooses; after, it goes on by itself; a deadline passed meanwhile stops it, nothing rolled back", async () => {
  const fresh = (t: T) => {
    t.engine.changes = new ServiceChanges({ store: t.store, handoff: t.handoff, box, now: () => t.now.t });
    t.engine.changes.recover();
  };
  const t = setup();
  await fullChange(t);
  guard(t);
  const id = await begin(t, "flow", { kind: "apply" });
  await drive(t, "flow", id, () => t.w.calls.includes(`stop ${C}`));
  fresh(t);
  const c = await drive(t, "flow", id, (x) => x.state !== "running");
  assert.equal(c.state, "paused", c.message ?? "");
  assert.equal(c.currentMember, null);
  assert.ok(events(t, "flow").includes("change-paused"));
  assert.equal(calls(t, "backup").length, 0);
  const view = await (await t.call("GET", `/api/services/flow/changes/${id}`, { as: "viewer" })).json();
  assert.equal(view.progress.canRollBack, true);
  assert.equal((await act(t, "flow", id, "continue")).status, 200);
  const on = await drive(t, "flow", id);
  assert.equal(on.state, "succeeded", on.message ?? "");
  assert.equal(new Set(calls(t, "stop")).size, 3);
  assert.equal((on.progress as { resume: boolean }).resume, false);

  // Or a person rolls it back: what was stopped starts, nothing written.
  const t2 = setup();
  await fullChange(t2);
  const id2 = await begin(t2, "flow", { kind: "apply" });
  await drive(t2, "flow", id2, () => t2.w.calls.includes(`stop ${C}`));
  fresh(t2);
  assert.equal((await drive(t2, "flow", id2)).state, "paused");
  assert.equal((await act(t2, "flow", id2, "rollback")).status, 200);
  const back = await drive(t2, "flow", id2);
  assert.equal(back.state, "rolled-back", back.message ?? "");
  assert.ok(cluster(t2).every((n) => n.running && n.status === "CONNECTED"));
  assert.equal(calls(t2, "restore").length, 0);
  assert.equal(calls(t2, "apply").length, 0);

  // After the first write: no pause, service first.
  const t3 = setup();
  await fullChange(t3);
  guard(t3);
  const id3 = await begin(t3, "flow", { kind: "apply" });
  await drive(t3, "flow", id3, () => calls(t3, "apply").length > 0);
  fresh(t3);
  const went = await drive(t3, "flow", id3);
  assert.equal(went.state, "succeeded", went.message ?? "");
  assert.ok(!events(t3, "flow").includes("change-paused"));

  // Restarting while rolling back, too, goes on.
  const t4 = setup();
  await fullChange(t4);
  guard(t4);
  t4.w.failing.set(`backup ${A}`, { state: "failed", message: "no space" });
  const id4 = await begin(t4, "flow", { kind: "apply" });
  await drive(t4, "flow", id4, (c) => (c.progress as { rollingBack: boolean }).rollingBack);
  fresh(t4);
  assert.equal((await drive(t4, "flow", id4)).state, "rolled-back");

  // Away past the deadline, the cluster half way up: stopped, not rolled back.
  const t5 = setup();
  await fullChange(t5);
  guard(t5);
  const id5 = await begin(t5, "flow", { kind: "apply" });
  await drive(t5, "flow", id5, (c) => c.phase === "compose");
  fresh(t5);
  t5.now.t += 3600_000;
  t5.engine.changes.tick();
  const late = changeOf(t5, "flow", id5);
  assert.equal(late.state, "stopped");
  assert.match(late.message!, /away past the deadline of compose: nothing is rolled back/);
  assert.equal(calls(t5, "restore").length, 0);
  assert.equal((await act(t5, "flow", id5, "continue")).status, 200);
  assert.equal((await drive(t5, "flow", id5)).state, "succeeded");
});

test("full: stopping by hand takes back everything queued; closing after the first write takes saying so, and the timeline has it", async () => {
  const t = setup();
  await fullChange(t);
  const id = await begin(t, "flow", { kind: "apply" });
  await drive(t, "flow", id, (c) => c.phase === "write" && t.store.serviceChangeSteps(id).filter((s) => s.step === "write").length === 3);
  const jobs = t.store.serviceChangeSteps(id).filter((s) => s.step === "write").map((s) => s.job!);
  assert.equal((await act(t, "flow", id, "stop")).status, 200);
  for (const j of jobs) assert.equal(t.store.executorJob(j)!.status!.state, "refused");
  assert.equal(t.store.serviceChangeSteps(id).filter((s) => s.state === "running").length, 0);
  await t.w.run();
  assert.equal(calls(t, "apply").length, 0);
  const refused = await act(t, "flow", id, "close");
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error, "service-change/files-mixed");
  assert.equal(changeOf(t, "flow", id).state, "stopped");
  const closed = await t.call("POST", `/api/services/flow/changes/${id}/close`, { as: "uat" }, { filesMayBeMixed: true });
  assert.equal(closed.status, 200);
  assert.equal(changeOf(t, "flow", id).state, "closed");
  const finished = t.store.serviceEvents("flow").find((e) => e.kind === "change-finished")!;
  assert.match(String(finished.detail.text), /mix of old and new/);
  assert.equal(t.store.activeServiceChange("flow"), undefined);

  // Before any write there is nothing to say.
  const t2 = setup();
  await fullChange(t2);
  t2.w.held.add("stop");
  const id2 = await begin(t2, "flow", { kind: "apply" });
  await drive(t2, "flow", id2, () => t2.w.calls.some((x) => x.startsWith("stop")));
  assert.equal((await act(t2, "flow", id2, "stop")).status, 200);
  assert.equal((await act(t2, "flow", id2, "close")).status, 200);
});

test("full: PROD takes it only from a browser (D7); UAT's personal key may; what a change shows holds no hash, no secret, no environment", async () => {
  const prod = setup("prod");
  await fullChange(prod, { as: "prod" });
  const planned = await planOf(prod, "flow", { kind: "apply", options: fast }, { key: "dpk_prod" });
  assert.equal(planned.mode, "full");
  const refused = await prod.call("POST", "/api/services/flow/changes", { key: "dpk_prod" }, { kind: "apply", options: fast, planHash: planned.planHash });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error, "auth/browser-only");
  assert.equal((await prod.call("POST", "/api/services/flow/changes", { key: "dps_assistant" }, { kind: "apply", options: fast, planHash: planned.planHash })).status, 403);
  const browser = await prod.call("POST", "/api/services/flow/changes", { as: "prod" }, { kind: "apply", options: fast, planHash: planned.planHash, reason: "a new ZooKeeper" });
  assert.equal(browser.status, 201, await browser.clone().text());
  const id = (await browser.json()).id as string;
  for (const what of ["stop", "continue", "rollback", "force-kill", "close"]) {
    const r = await act(prod, "flow", id, what, { key: "dpk_prod" });
    assert.equal(r.status, 403, what);
    assert.equal((await r.json()).error, "auth/browser-only");
  }
  assert.equal((await drive(prod, "flow", id)).state, "succeeded");

  const uat = setup();
  await fullChange(uat);
  const plan = await planOf(uat, "flow", { kind: "apply", options: fast });
  const viaKey = await uat.call("POST", "/api/services/flow/changes", { key: "dpk_uat" }, { kind: "apply", options: fast, planHash: plan.planHash });
  assert.equal(viaKey.status, 201);
  const made = await viaKey.json();
  await drive(uat, "flow", made.id, (c) => c.phase === "compose");
  const one = await (await uat.call("GET", `/api/services/flow/changes/${made.id}`, { as: "viewer" })).text();
  assert.doesNotMatch(one, /[0-9a-f]{64}/, "no hash");
  assert.doesNotMatch(one, /JAVA_HOME/, "no environment");
  const seen = JSON.parse(one).progress.seen;
  assert.equal(seen.members[A].files, "new");
  assert.equal(typeof seen.coordinator, "boolean");
});

test("full: the rules leave every member and the cluster alone while it runs, and judge them again once it has stopped", async () => {
  const t = setup();
  await fullChange(t);
  const online: ExecutorInfo = { online: true, host: "local", ageSeconds: 5, heartbeat: { collector: { seconds: 30 } } as never };
  const rule = () => t.store.serviceAlerts({ service: "flow", state: "open" }).map((a) => `${a.rule} ${a.member}`).sort();
  const before = new Date(t.now.t).toISOString();
  for (const m of NODES) await sampled(t, m, true);
  check(t.store, () => online, "flow", new Date(t.now.t));
  t.w.held.add("start");
  const id = await begin(t, "flow", { kind: "apply" });
  await drive(t, "flow", id, () => calls(t, "start").length === 3);
  assert.equal(changeOf(t, "flow", id).currentMember, null, "no member in particular");

  t.now.t += 30_000;
  for (const m of NODES) await sampled(t, m, false, "e".repeat(64));
  zkMessages(t);
  check(t.store, () => online, "flow", new Date(t.now.t));
  assert.deepEqual(rule().filter((r) => /process-down|node-disconnected|no-samples|no-coordinator|zk-errors|config-drift/.test(r)), []);

  const c = await drive(t, "flow", id);
  assert.equal(c.state, "stopped");
  t.now.t += 3000;
  for (const m of NODES) await sampled(t, m, false);
  zkMessages(t);
  check(t.store, () => online, "flow", new Date(t.now.t));
  for (const m of NODES) assert.ok(rule().includes(`process-down ${m}`), `${m} is judged again`);
  assert.ok(rule().includes("zk-errors *"), "and the cluster");
  await sampled(t, B, true);
  check(t.store, () => online, "flow", new Date(t.now.t));
  assert.ok(rule().includes("no-coordinator *"));
  assert.ok(!t.store.serviceEvents("flow", { from: before }).some((e) => e.kind === "process-restarted" || e.kind === "node-disconnected"), "the timeline has the change's steps");
});

test("back to a revision: its files saved as the newest with source rollback, changing nothing on the hosts, and applied like any other", async () => {
  const t = setup();
  takenOver(t);
  const rev = await revision(t, "solo");
  const before = t.store.serviceConfig("solo", 1)!.body.members[0]!.files.map((f) => f.sha256);
  const post = (who: { as?: string; key?: string }, body: unknown) => t.call("POST", "/api/services/solo/config/rollback", who, body);
  assert.equal((await post({ as: "viewer" }, { revision: 1 })).status, 403);
  assert.equal((await post({ as: "uat" }, {})).status, 400);
  assert.equal((await post({ as: "uat" }, { revision: 99 })).status, 404);
  const applied = await begin(t, "solo", { kind: "apply", revision: rev });
  assert.equal((await drive(t, "solo", applied)).state, "succeeded");
  const hostHad = t.w.nodes.get(SOLO)!.files.get("nifi.properties");

  const out = await post({ as: "uat" }, { revision: 1, note: "that banner was wrong" });
  assert.equal(out.status, 201, await out.clone().text());
  const back = await out.json();
  assert.equal(back.revision, rev + 1);
  assert.equal(back.saved, true);
  const kept = t.store.serviceConfig("solo")!;
  assert.equal(kept.source, "rollback");
  assert.equal(kept.note, "that banner was wrong");
  assert.deepEqual(kept.body.members[0]!.files.map((f) => f.sha256), before, "the very files of revision 1");
  assert.ok(t.store.serviceEvents("solo").some((e) => e.kind === "config-saved" && String((e.detail as { text?: unknown }).text).includes("back to revision 1")));
  assert.equal(t.w.nodes.get(SOLO)!.files.get("nifi.properties"), hostHad, "nothing changes on the host");

  const again = await post({ as: "uat" }, { revision: 1 });
  assert.deepEqual([again.status, (await again.json()).saved], [200, false], "the newest already has those files");
  assert.equal(t.store.serviceConfig("solo")!.revision, rev + 1);

  const id = await begin(t, "solo", { kind: "apply" });
  const c = await drive(t, "solo", id);
  assert.equal(c.state, "succeeded");
  assert.equal(c.revision, rev + 1);
  assert.equal(t.w.nodes.get(SOLO)!.files.get("nifi.properties"), before[0], "and applying puts them back");
});

test("a member's start environment: an admin in a browser, through the takeover's filter, and only the names come back", async () => {
  const t = setup();
  takenOver(t);
  const path = (m: string) => `/api/services/flow/members/${encodeURIComponent(m)}/start`;
  const given = { environment: { JAVA_HOME: "/new", NIFI_DB_PASSWORD: "s3cret-value" } };
  assert.equal((await t.call("PUT", path(A), { as: "uat" }, given)).status, 403);
  assert.equal((await t.call("PUT", path(A), { key: "dpk_uat" }, given)).status, 403);
  assert.equal((await t.call("PUT", path("local:/nowhere"), { as: "admin" }, given)).status, 404);
  assert.equal((await t.call("PUT", path(A), { as: "admin" }, { environment: { JAVA_HOME: 1 } })).status, 400);
  const out = await t.call("PUT", path(A), { as: "admin" }, given);
  assert.equal(out.status, 200, await out.clone().text());
  assert.deepEqual(await out.json(), { kept: ["JAVA_HOME"], dropped: ["NIFI_DB_PASSWORD"] });
  const status = await (await t.call("GET", "/api/services/flow/status", { as: "viewer" })).text();
  assert.ok(!status.includes("/new") && !status.includes("s3cret-value"), "no value in the status");
  assert.deepEqual(JSON.parse(status).members.find((m: { key: string }) => m.key === A).startEnvironment, ["JAVA_HOME"]);
  assert.equal(t.store.clusters().find((c) => c.id === "flow")!.nodes.find((n) => n.installDir === "/opt/a")!.startEnvironment!.JAVA_HOME, "/new");

  t.w.held.add("stop");
  const id = await begin(t, "flow", { kind: "stop", members: [B] });
  assert.ok(id);
  assert.equal((await t.call("PUT", path(A), { as: "admin" }, given)).status, 409, "not while a change holds the service");
  t.w.held.clear();
  assert.equal((await act(t, "flow", id, "stop")).status, 200);
  assert.equal((await act(t, "flow", id, "close")).status, 200);
  const forgot = await t.call("PUT", path(A), { as: "admin" }, { environment: {} });
  assert.deepEqual(await forgot.json(), { kept: [], dropped: [] });
  assert.equal(t.store.clusters().find((c) => c.id === "flow")!.nodes.find((n) => n.installDir === "/opt/a")!.startEnvironment, null);
});

test("how long a plan can take is shown with it: a whole cluster's outage, or a rolling change's steps added up; a change that stopped names the process it would kill", async () => {
  const t = setup();
  const { rev } = await fullChange(t);
  const full = await planOf(t, "flow", { kind: "apply", revision: rev });
  const o = full.options.timeouts;
  assert.equal(full.mode, "full");
  assert.equal(full.longestSeconds, 3 * o.stop + 2 * o.write + o.gate + o.start + o.compose);
  const rolling = await planOf(t, "flow", { kind: "rolling-restart" });
  const d = rolling.options.timeouts;
  assert.equal(rolling.longestSeconds, 3 * (d.disconnect + d.stop + d.start + d.rest + d.connect + d.stable));
  assert.equal(longestSeconds({ mode: "rolling", members: [], options: rolling.options }), 0);

  const n = t.w.nodes.get(B)!;
  t.w.failing.set(`stop ${B}`, { state: "failed", message: "still running", result: { stillRunning: true, process: { pid: n.pid, startedAt: n.startedAt } } });
  const id = await begin(t, "flow", { kind: "stop", members: [B] });
  await drive(t, "flow", id);
  const seen = await (await t.call("GET", `/api/services/flow/changes/${id}`, { as: "viewer" })).json();
  assert.equal(seen.state, "stopped");
  assert.equal(seen.progress.canForceKill, true);
  assert.deepEqual(seen.progress.stuck, { pid: n.pid, startedAt: n.startedAt });
});

// Phase 3 step 15 (§16.2): removing a service only stops managing it.
test("removing a service: an admin in a browser, the watch list drops it, NiFi and the files are not touched, nothing sensitive stays, the id is not taken again", async () => {
  const t = setup();
  takenOver(t);
  const rev = await revision(t, "flow");
  await revision(t, "solo");
  const draft = await t.call("POST", "/api/services/flow/config/drafts", { as: "uat" }, { changes: [{ file: "nifi.properties", key: "nifi.security.keystorePasswd", value: "new-s3cret-value" }] });
  assert.equal(draft.status, 201, await draft.clone().text());
  t.store.openServiceAlert({ service: "flow", member: "*", rule: "process-down", level: "CRIT", detail: {} }, "2026-11-09T10:00:00Z", {});
  const del = (who: { as?: string; key?: string }, id = "flow") => t.call("DELETE", `/api/services/${id}`, who);
  const hostFiles = JSON.stringify([...t.w.nodes.entries()].map(([k, n]) => [k, [...n.files.entries()]]));
  assert.ok(watchList(t.store, "local").some((e) => e.service === "flow"));

  for (const who of [{ as: "viewer" }, { as: "uat" }, { as: "prod" }]) assert.equal((await del(who)).status, 403, JSON.stringify(who));
  assert.equal((await del({ key: "dpk_admin" })).status, 403, "not with an API key, not even an admin's");
  assert.equal((await del({ key: "dpk_uat" })).status, 403);
  assert.equal((await del({ as: "admin" }, "nowhere")).status, 404);
  assert.equal(t.store.clusters().length, 1, "nothing was removed by those");

  const out = await del({ as: "admin" });
  assert.equal(out.status, 200, await out.clone().text());
  assert.deepEqual(await out.json(), { removed: "flow", kind: "cluster", members: [A, B, C] });
  assert.equal((await del({ as: "admin" })).status, 404, "removed once");

  // Gone from every view and from the watch list; the other service is untouched.
  assert.deepEqual(watchList(t.store, "local").map((e) => e.service), ["solo"]);
  assert.equal((await t.call("GET", "/api/services/flow/status", { as: "viewer" })).status, 404);
  assert.equal((await t.call("GET", "/api/services/flow/events", { as: "viewer" })).status, 404);
  const list = await (await t.call("GET", "/api/services", { as: "viewer" })).json();
  assert.deepEqual([list.clusters.length, list.standalones.map((s: { id: string }) => s.id)], [0, ["solo"]]);
  assert.equal((await t.call("GET", "/api/services/solo/status", { as: "viewer" })).status, 200);
  assert.equal(t.store.serviceUsing("local", "/opt/a"), undefined, "the installation can be taken over again");
  assert.equal(t.store.serviceUsing("local", "/opt/solo"), "solo");
  assert.equal(t.store.serviceAlerts({ service: "flow", state: "open" }).length, 0, "its alerts are closed");
  assert.equal((await (await t.call("GET", "/api/alerts", { as: "viewer" })).json()).open, 0);

  // NiFi and its files: no job went to an executor, nothing was written.
  assert.deepEqual(t.w.calls, []);
  assert.equal(JSON.stringify([...t.w.nodes.entries()].map(([k, n]) => [k, [...n.files.entries()]])), hostFiles);

  // History stays; what could leak or act does not.
  assert.equal(t.store.serviceConfig("flow")!.revision, rev, "the revisions are history");
  const raw = (t.store as unknown as { db: { prepare(s: string): { all(...a: unknown[]): Record<string, unknown>[] } } }).db;
  assert.ok(raw.prepare("SELECT removed_at, start_env FROM service_nodes WHERE cluster = 'flow'").all().every((n) => n.removed_at && n.start_env === null), "the start environments are dropped");
  assert.ok(raw.prepare("SELECT removed_by FROM service_clusters WHERE id = 'flow'").all().every((n) => String(n.removed_by).startsWith("admin")));
  const drafts = raw.prepare("SELECT state, changes FROM service_config_drafts WHERE service = 'flow'").all();
  assert.ok(drafts.length > 0 && drafts.every((d) => d.state !== "open") && drafts.filter((d) => d.state === "discarded").every((d) => d.changes === "[]") && drafts.some((d) => d.state === "discarded"), "an open draft is closed and its changes gone");
  assert.equal(raw.prepare("SELECT 1 FROM service_standalones WHERE id = 'solo' AND start_env IS NOT NULL").all().length, 1, "only the removed service's");
  const events = t.store.serviceEvents("flow");
  assert.ok(events.some((e) => e.kind === "removed" && JSON.stringify(e.detail).includes("untouched")), "on the timeline");
  assert.ok(events.some((e) => e.kind === "alert-resolved"));
  const audit = t.store.listAudit(5, { action: "service.removed" });
  assert.deepEqual(audit.map((a) => [a.actor.startsWith("admin"), a.target]), [[true, "flow"]]);
  const traces = JSON.stringify([events, audit]);
  assert.ok(!traces.includes("new-s3cret-value") && !traces.includes("keystore-s3cret") && !traces.includes("/old"), "no value in the records");

  // The id is not taken again (service_configs is keyed by service + revision).
  const again = { kind: "cluster", id: "flow", service: "nifi", profile: "nifi-2.x", version: "2.5.0", webUrl: null, zookeeper: null, zookeeperRoot: null, nodes: [serviceMember("/opt/a", 8443)] } as unknown as DraftCluster;
  const d2 = t.store.createServiceDraft("uat", [], [again], cli);
  assert.throws(() => t.store.confirmServiceDraft(d2.id, { flow: { members: [memberOf("/opt/a", { "nifi.properties": NIFI({}) })] } }, cli), /already registered/);

  // A standalone instance goes the same way.
  assert.equal((await del({ as: "admin" }, "solo")).status, 200);
  assert.deepEqual(watchList(t.store, "local"), []);
  assert.equal(t.store.serviceUsing("local", "/opt/solo"), undefined);
});

test("removing a service is refused while a change holds it (running, paused, stopped) and goes through once it is closed", async () => {
  const t = setup();
  takenOver(t);
  await revision(t, "flow");
  const del = () => t.call("DELETE", "/api/services/flow", { as: "admin" });

  t.w.held.add("stop");
  const id = await begin(t, "flow", { kind: "stop", members: [B] });
  assert.equal(changeOf(t, "flow", id).state, "running");
  const running = await del();
  assert.equal(running.status, 409);
  assert.equal((await running.json()).error, "service-change/active");

  t.w.held.clear();
  t.w.failing.set(`stop ${B}`, { state: "failed", message: "still running", result: { stillRunning: true } });
  const c = await drive(t, "flow", id);
  assert.equal(c.state, "stopped");
  assert.equal((await del()).status, 409, "stopped is not finished: files may be mixed");
  assert.equal(t.store.clusters().length, 1);

  t.w.failing.clear();
  assert.equal((await act(t, "flow", id, "close")).status, 200);
  assert.equal((await del()).status, 200, "closed: nothing holds it");
  assert.equal(t.store.clusters().length, 0);
});
