// §16.3: the executor protocol under a change: jobs that expire in the queue, what is sealed while it waits, reads
// beside a change, and what an executor too old for a job is told.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ContentNotSealed, ExecutorUnsupported, Handoff, kindsNeeded, PROTOCOL, QUEUE_LIMIT_MS, SERVICE_READ_KINDS } from "../src/server/handoff.ts";
import { SecretBox } from "../src/server/secretbox.ts";
import { Store } from "../src/server/store.ts";

const box = new SecretBox(Buffer.alloc(32, 7).toString("base64"));
const START = Date.parse("2026-11-09T10:00:00Z");
const CONTENT = JSON.stringify({ files: [{ name: "nifi.properties", base64: Buffer.from("nifi.sensitive.props.key=do-not-show").toString("base64") }] });

function setup(options: { box?: SecretBox | undefined; file?: string } = {}) {
  const clock = { now: START };
  const store = new Store(options.file ?? ":memory:", () => new Date(clock.now));
  const handoff = new Handoff(store, () => clock.now, "box" in options ? options.box : box);
  const take = (only?: string[]) => handoff.next("local", 0, undefined, "service", only);
  const row = (id: string) => (store as unknown as { db: { prepare(s: string): { get(a: string): { content: string | null; request: string; picked_at: string | null } } } }).db.prepare("SELECT content, request, picked_at FROM executor_jobs WHERE id = ?").get(id);
  return { clock, store, handoff, take, row };
}

const beat = (handoff: Handoff, kinds: string[], version = "0.9.0") =>
  handoff.heartbeat("local", { executor: "service", version, protocols: [PROTOCOL], kinds, project: "", registries: [], databaseBackup: {}, busy: null, at: "" }, "service");

test("§16.3: a job past its expiresAt never reaches the executor, and is refused by the Deployer's clock", async () => {
  const { clock, handoff, take, row } = setup();
  handoff.submit("svc-control-1", { kind: "svc-control", action: "stop", expiresAt: new Date(START + 60_000).toISOString() }, "local", "service");
  handoff.submit("svc-control-2", { kind: "svc-control", action: "stop", expiresAt: new Date(START + 600_000).toISOString() }, "local", "service");
  clock.now = START + 60_000;
  const got = await take();
  assert.equal(got?.id, "svc-control-2", "the one still in time");
  assert.equal(got?.expiresAt, new Date(START + 600_000).toISOString(), "the executor gets to see it, but does not decide by it");
  const refused = handoff.status("svc-control-1")!;
  assert.equal(refused.state, "refused");
  assert.match(refused.message!, /waited in the queue past 2026-11-09T10:01:00/);
  assert.ok(refused.finishedAt);
  assert.ok(row("svc-control-1").picked_at, "out of the queue");
  assert.equal(await take(), undefined);
});

test("§16.3: a job expires while its executor is away, with nobody asking, and its content goes with it", async () => {
  const { clock, handoff, take, row } = setup();
  handoff.submit("svc-write-1", { kind: "svc-write", action: "apply", content: CONTENT }, "local", "service");
  assert.ok(row("svc-write-1").content);
  clock.now = START + QUEUE_LIMIT_MS - 1;
  handoff.expireQueued();
  assert.equal(handoff.status("svc-write-1"), undefined, "not yet");
  assert.ok(row("svc-write-1").content);
  clock.now = START + QUEUE_LIMIT_MS;
  handoff.expireQueued();
  assert.equal(handoff.status("svc-write-1")!.state, "refused");
  assert.equal(row("svc-write-1").content, null);
  assert.equal(await take(), undefined, "the executor comes back to nothing");
  const finished = handoff.status("svc-write-1")!.finishedAt;
  clock.now += 60_000;
  handoff.expireQueued();
  assert.equal(handoff.status("svc-write-1")!.finishedAt, finished, "said once");
});

test("§16.3: the jobs that expire get expiresAt when the request has none, others do not; one that cannot be read has passed", async () => {
  const { handoff, take } = setup();
  for (const kind of ["svc-state", "svc-write", "svc-control"]) {
    handoff.submit(`${kind}-1`, { kind }, "local", "service");
    assert.equal(handoff.request(`${kind}-1`)!.expiresAt, new Date(START + QUEUE_LIMIT_MS).toISOString(), kind);
  }
  handoff.submit("svc-read-1", { kind: "svc-read", installDir: "/opt/nifi" }, "local", "service");
  assert.equal(handoff.request("svc-read-1")!.expiresAt, undefined);
  handoff.submit("svc-state-9", { kind: "svc-state", expiresAt: "whenever" }, "local", "service");
  assert.deepEqual([(await take())?.id, (await take())?.id, (await take())?.id, (await take())?.id, await take()], ["svc-state-1", "svc-write-1", "svc-control-1", "svc-read-1", undefined]);
  assert.equal(handoff.status("svc-state-9")!.state, "refused");
});

test("§16.3: a svc-write's content waits sealed, is opened when taken, and goes from the queue; an env job's is as it was", async () => {
  const { handoff, take, row } = setup();
  handoff.submit("svc-write-1", { kind: "svc-write", action: "apply", content: CONTENT }, "local", "service");
  handoff.submit("env-1", { kind: "env", content: "A=1" }, "local", "service");
  const queued = row("svc-write-1");
  assert.ok(queued.content!.startsWith("v1:"));
  assert.ok(!queued.content!.includes(CONTENT));
  assert.ok(!queued.content!.includes(Buffer.from("do-not-show").toString("base64").slice(0, 8)));
  assert.equal(box.open(queued.content!), CONTENT);
  assert.ok(!queued.request.includes("files"), "nor in the request");
  assert.equal(handoff.request("svc-write-1")!.content, undefined);
  assert.equal(row("env-1").content, "A=1");

  const got = await take();
  assert.deepEqual([got?.id, got?.content], ["svc-write-1", CONTENT]);
  assert.equal(row("svc-write-1").content, null);
  assert.equal((await take())?.content, "A=1");
});

test("§16.3: without the key a svc-write with content is not queued at all; a key that changed refuses what waited", async () => {
  const none = setup({ box: undefined });
  assert.throws(() => none.handoff.submit("svc-write-1", { kind: "svc-write", content: CONTENT }, "local", "service"), (e: ContentNotSealed) => e.status === 409 && e.code === "executor/no-encryption-key");
  assert.equal(none.store.executorJob("svc-write-1"), undefined);
  none.handoff.submit("svc-write-2", { kind: "svc-write", action: "restore" }, "local", "service");
  assert.equal((await none.take())?.id, "svc-write-2", "nothing to seal");

  const file = join(mkdtempSync(join(tmpdir(), "handoff-")), "deployer.db");
  const first = setup({ file });
  first.handoff.submit("svc-write-1", { kind: "svc-write", content: CONTENT }, "local", "service");
  first.store.close();
  const other = setup({ file, box: new SecretBox(Buffer.alloc(32, 8).toString("base64")) });
  assert.equal(await other.take(), undefined);
  assert.equal(other.handoff.status("svc-write-1")!.state, "refused");
  assert.equal(other.row("svc-write-1").content, null);
  other.store.close();
});

test("§16.3: what is queued survives a restart of the Deployer: still sealed, opened after it, and still expiring", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "handoff-")), "deployer.db");
  const first = setup({ file });
  first.handoff.submit("svc-write-1", { kind: "svc-write", content: CONTENT }, "local", "service");
  first.handoff.submit("svc-control-1", { kind: "svc-control", expiresAt: new Date(START + 1000).toISOString() }, "local", "service");
  first.store.close();
  const again = setup({ file });
  again.clock.now = START + 1000;
  const got = await again.take();
  assert.deepEqual([got?.id, got?.content], ["svc-write-1", CONTENT]);
  assert.equal(again.handoff.status("svc-control-1")!.state, "refused");
  again.store.close();
});

test("§16.3: while a change runs the executor takes only reads, oldest first; the second change stays queued", async () => {
  const { handoff, take, row } = setup();
  handoff.submit("svc-write-1", { kind: "svc-write", action: "apply" }, "local", "service");
  handoff.submit("svc-state-1", { kind: "svc-state", member: "m" }, "local", "service");
  handoff.submit("executor-upgrade-1", { kind: "executor-upgrade", version: "9.9.9" }, "local", "service");
  handoff.submit("log-read-1", { kind: "log-read" }, "local", "service");
  assert.equal((await take(SERVICE_READ_KINDS))?.id, "svc-state-1");
  assert.equal((await take(SERVICE_READ_KINDS))?.id, "log-read-1");
  assert.equal(await take(SERVICE_READ_KINDS), undefined);
  assert.equal(row("svc-write-1").picked_at, null);
  assert.equal(row("executor-upgrade-1").picked_at, null);
  assert.equal((await take())?.id, "svc-write-1", "once none runs, in order");
  assert.equal((await take())?.id, "executor-upgrade-1");
});

test("§16.3: a long poll for reads is woken by a read, and ends empty on a change, which it leaves", async () => {
  const { handoff, row } = setup();
  const forRead = handoff.next("local", 5000, undefined, "service", SERVICE_READ_KINDS);
  handoff.submit("svc-state-1", { kind: "svc-state" }, "local", "service");
  assert.equal((await forRead)?.id, "svc-state-1");
  const forChange = handoff.next("local", 5000, undefined, "service", SERVICE_READ_KINDS);
  handoff.submit("svc-control-1", { kind: "svc-control" }, "local", "service");
  assert.equal(await forChange, undefined);
  assert.equal(row("svc-control-1").picked_at, null);
});

test("§16.3: the reads the Deployer hands over beside a change are the executor's read channel", () => {
  const code = readFileSync(new URL("../executor/service_executor.py", import.meta.url), "utf8");
  const block = /READ_JOBS = \{([^}]*)\}/.exec(code)![1]!;
  assert.deepEqual([...block.matchAll(/"([\w-]+)":/g)].map((m) => m[1]).sort(), [...SERVICE_READ_KINDS].sort());
});

test("§15.2, §16.3: an executor that does not name a job's first form cannot be sent it, and one queued before it said so is refused", async () => {
  for (const kind of ["svc-state", "svc-write", "svc-control"]) assert.deepEqual(kindsNeeded({ kind }), [kind, `${kind}@1`]);
  const { handoff, take } = setup();
  handoff.submit("svc-state-1", { kind: "svc-state" }, "local", "service");
  handoff.submit("svc-write-1", { kind: "svc-write", content: CONTENT }, "local", "service");
  beat(handoff, ["svc-read", "executor-upgrade", "svc-state"], "0.8.0"); // the plain kind alone does not count
  assert.equal(await take(), undefined);
  for (const id of ["svc-state-1", "svc-write-1"]) {
    assert.equal(handoff.status(id)!.state, "refused");
    assert.match(handoff.status(id)!.message!, /service executor 0\.8\.0 on local cannot run this svc-\w+ job \(it does not name (svc-\w+, )?svc-\w+@1\): upgrade it first/);
  }
  assert.throws(() => handoff.submit("svc-control-1", { kind: "svc-control" }, "local", "service"), (e: ExecutorUnsupported) => e.status === 409 && e.code === "executor/unsupported" && e.missing.join() === "svc-control,svc-control@1");
  assert.throws(() => handoff.submit("svc-state-2", { kind: "svc-state" }, "local", "service"), (e: ExecutorUnsupported) => e.missing.join() === "svc-state@1");

  beat(handoff, ["svc-state", "svc-state@1"]);
  handoff.submit("svc-state-3", { kind: "svc-state" }, "local", "service");
  assert.equal((await take())?.id, "svc-state-3");
});
