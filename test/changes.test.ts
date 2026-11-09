// Phase 3 step 11 (§7, §8, §13, §16.3): the change engine against a stand-in for the service executors: a cluster and a
// standalone whose processes, files, connections and roles only exist here. Rolling order and roles that move, the check
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
import { INTERRUPTED, nowStages, ServiceChanges, stagesFor } from "../src/server/services/changes.ts";
import { sealFile, type ConfigMember, type ServiceConfigBody } from "../src/server/services/config.ts";
import type { DraftCluster, DraftStandalone } from "../src/server/services/draft.ts";
import { ingest } from "../src/server/services/metrics.ts";
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
const KEYS: Record<string, Principal> = { dpk_uat: keyPrincipal("u@x", "key", ["deploy-uat"]), dpk_prod: keyPrincipal("p@x", "key", ["deploy-prod"]), dps_assistant: keyPrincipal("assistant", "service", []) };

interface Node { key: string; nodeId: string | null; running: boolean; pid: number; startedAt: string; files: Map<string, string>; status: string; roles: string[]; invalid: number; rest: boolean; joining: boolean; connects: boolean; dies: boolean; env: Record<string, string> }
type Answer = { state: string; message?: string; result?: Record<string, unknown> };

/** The hosts: answers every job as the service executor would, and does what it says to the members. */
function world(t: { store: Store; handoff: Handoff; now: { t: number } }) {
  const w = {
    nodes: new Map<string, Node>(),
    calls: [] as string[],
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
      w.nodes.set(key, { key, nodeId, running: true, pid: w.pidNext++, startedAt: "2026-11-01T00:00:00Z", files, status: "CONNECTED", roles, invalid: 2, rest: true, joining: false, connects: true, dies: false, env: { JAVA_HOME: "/jdk" } });
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
      const name = `${action} ${member}`;
      w.calls.push(name);
      w.onJob?.(action, member);
      if (w.held.has(name) || w.held.has(action)) return;
      const failure = w.failing.get(name);
      if (failure) w.failing.delete(name);
      if (failure && !failure.didIt) return finish(failure);
      if (action === "node-disconnect") { n.status = "DISCONNECTED"; finish({ state: "succeeded" }); }
      else if (action === "node-offload") { n.status = "OFFLOADED"; finish({ state: "succeeded" }); }
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
      else if (action === "apply") {
        const files = job.files as { name: string; baseSha256: string | null; sha256: string }[];
        for (const f of files) if (n.files.get(f.name) !== f.baseSha256 && n.files.get(f.name) !== f.sha256) return finish({ state: "refused", message: `${f.name} changed` });
        const content = JSON.parse(String(job.content)) as { files: { name: string; base64: string }[] };
        (n as Node & { backup?: Map<string, string> }).backup ??= new Map(n.files);
        for (const f of files) { assert.equal(sha(Buffer.from(content.files.find((x) => x.name === f.name)!.base64, "base64")), f.sha256, "the content is what it says"); n.files.set(f.name, f.sha256); }
        finish({ state: "succeeded", result: { files: [] } });
      } else if (action === "restore") {
        const backup = (n as Node & { backup?: Map<string, string> }).backup;
        if (!backup) return finish({ state: "refused", message: "this change has no backup here" });
        n.files = new Map(backup);
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

const fast = { stableSeconds: 6, timeouts: { disconnect: 20, stop: 20, write: 20, start: 20, rest: 40, connect: 90, stable: 40, gate: 40, offload: 20 } };

async function revision(t: T, service: string, changes: unknown[] = [{ file: "nifi.properties", key: "nifi.ui.banner.text", value: "hello" }]) {
  const draft = await t.call("POST", `/api/services/${service}/config/drafts`, { as: "uat" }, { changes });
  assert.equal(draft.status, 201, await draft.clone().text());
  const saved = await t.call("POST", `/api/services/${service}/config/drafts/${(await draft.json()).id}/save`, { as: "uat" }, {});
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
  assert.ok(t2.w.calls.includes(`node-connect ${A}`) || t2.w.calls.includes(`node-connect ${C}`), "another node was asked to connect it, once");
  assert.equal(t2.w.calls.filter((x) => x.startsWith("node-connect")).length, 1);
});

test("a node staying away is connected through another node, and the roll goes on", async () => {
  const t = setup();
  takenOver(t);
  const original = t.w.handle;
  t.w.handle = (job) => { original(job); if (job.action === "start" && job.member === B) t.w.nodes.get(B)!.connects = false; };
  const id = await begin(t, "flow", { kind: "rolling-restart" });
  assert.equal((await drive(t, "flow", id)).state, "succeeded");
  const asked = t.w.calls.find((x) => x.startsWith("node-connect"))!;
  assert.notEqual(asked, `node-connect ${B}`, "through another node's executor");
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

test("keys that cannot roll: the plan says full and that this version refuses it, whatever else changes", async () => {
  const t = setup();
  takenOver(t);
  await revision(t, "flow", [{ file: "nifi.properties", key: "nifi.zookeeper.root.node", value: "/other" }, { file: "nifi.properties", key: "nifi.ui.banner.text", value: "hi" }]);
  const plan = await planOf(t, "flow", { kind: "apply" });
  assert.equal(plan.mode, "full");
  assert.ok(plan.fullBecause.some((f: { key?: string }) => f.key === "nifi.zookeeper.root.node"));
  assert.ok(plan.blocking.some((f: { code: string }) => f.code === "change/full-not-yet"));
  assert.equal((await t.call("POST", "/api/services/flow/changes", { as: "uat" }, { kind: "apply", planHash: plan.planHash })).status, 409);
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
