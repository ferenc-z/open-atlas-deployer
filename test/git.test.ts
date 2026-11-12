// D46: repositories read with git over SSH. The tests use a local repository in place of the SSH address.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Git, pem, runGit, sshUrl } from "../src/server/git.ts";
import { Versions } from "../src/server/versions.ts";
import { OmaSessions } from "../src/server/oma.ts";

const URL_ = "git@github.com:acme/shop.git";

function upstream(): string {
  const dir = mkdtempSync(join(tmpdir(), "git-up-"));
  const g = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
  g("init", "-q", "-b", "main");
  const commit = (file: string, text: string, message: string, tag?: string) => {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), text);
    g("add", "-A");
    g("commit", "-q", "-m", message);
    if (tag) g("tag", tag);
  };
  commit("README.md", "shop\n", "start", "shop-1.0.0");
  commit("Dockerfile", "FROM node:22\n", "add a Dockerfile");
  commit("src/app.ts", "x\n", "feature", "shop-1.1.0");
  commit("deploy/compose.yaml", "services: {}\n", "compose for deploys\n\nThe port moves to 9000.");
  commit("Dockerfile", `FROM node:22\n${"RUN true\n".repeat(2000)}`, "longer Dockerfile", "shop-1.2.0");
  return dir;
}

/** The real git, with the SSH address pointing at the local repository and the file transport allowed for it. */
function local(dir: string) {
  const ran: string[][] = [];
  const run: typeof runGit = (args, options) => {
    ran.push(args);
    return runGit(args.map((a) => (a === URL_ ? dir : a === "protocol.allow=never" ? "protocol.allow=always" : a)), options);
  };
  return { git: new Git({ dir: mkdtempSync(join(tmpdir(), "git-dep-")), keyFile: () => "k", run }), ran };
}

test("D46: a key pasted into a one-line field gets its lines back", () => {
  const body = "A".repeat(150);
  assert.equal(pem(`-----BEGIN OPENSSH PRIVATE KEY-----${body}-----END OPENSSH PRIVATE KEY-----`),
    `-----BEGIN OPENSSH PRIVATE KEY-----\n${"A".repeat(70)}\n${"A".repeat(70)}\n${"A".repeat(10)}\n-----END OPENSSH PRIVATE KEY-----`);
  assert.equal(pem("-----BEGIN OPENSSH PRIVATE KEY-----\nAB\nCD\n-----END OPENSSH PRIVATE KEY-----\n"), "-----BEGIN OPENSSH PRIVATE KEY-----\nABCD\n-----END OPENSSH PRIVATE KEY-----");
});

test("D46: release repos map to SSH addresses", () => {
  assert.equal(sshUrl("acme/shop"), URL_);
  assert.equal(sshUrl("https://github.com/acme/shop.git"), URL_);
  assert.equal(sshUrl("ssh://git@bitbucket.corp:7999/proj/shop.git"), "ssh://git@bitbucket.corp:7999/proj/shop.git");
  assert.throws(() => sshUrl("https://gitlab.com/a/b/c"), /SSH address/);
});

test("D46: tags, every changed deploy file across versions, commit messages and the source come from git", async () => {
  const dir = upstream();
  const { git, ran } = local(dir);
  assert.deepEqual((await git.tags("acme/shop")).sort(), ["shop-1.0.0", "shop-1.1.0", "shop-1.2.0"]);

  // Two versions apart: the Dockerfile added in between and the compose file both show; the source change does not.
  const d = await git.diff("acme/shop", "shop-1.0.0", "shop-1.2.0", /(^|\/)(Dockerfile|compose[^/]*\.ya?ml)$/, 500);
  assert.equal(d.changed, 3);
  assert.deepEqual(d.files.map((f) => [f.file, f.status, Boolean(f.truncated)]), [["Dockerfile", "added", true], ["deploy/compose.yaml", "added", false]]);
  assert.match(d.files[1]!.patch, /\+services: \{\}/);

  const l = await git.log("acme/shop", "shop-1.0.0", "shop-1.2.0");
  assert.equal(l.commits.length, 4);
  assert.match(l.commits[1]!, /compose for deploys\nThe port moves to 9000\./);
  assert.equal((await git.log("acme/shop", "shop-1.0.0", "shop-1.2.0", 2)).more, true);

  const tgz = await git.archive("acme/shop", "shop-1.1.0");
  assert.deepEqual([tgz[0], tgz[1]], [0x1f, 0x8b]);
  const out = mkdtempSync(join(tmpdir(), "git-x-"));
  execFileSync("tar", ["-xzf", "-", "-C", out], { input: tgz });
  assert.ok(existsSync(join(out, "src/app.ts")) && !existsSync(join(out, "deploy")));
  assert.ok((await git.archive("acme/shop", null)).length > 0, "the default branch when no version is given");

  // Hooks off, no other transport, never a checkout.
  assert.ok(ran.every((a) => a.includes("core.hooksPath=/dev/null") && a.includes("protocol.allow=never")));
  assert.ok(!ran.some((a) => a.includes("checkout") || a.includes("clone")));
  await assert.rejects(git.archive("acme/shop", "--upload-pack=x"), /not a tag name/);
});

test("D46: without a key nothing runs, and the version list keeps the GitHub API", async () => {
  const git = new Git({ dir: mkdtempSync(join(tmpdir(), "git-dep-")), keyFile: undefined, run: async () => { throw new Error("ran"); } });
  assert.equal(git.configured, false);
  const api = new Versions(undefined, (async () => Response.json([{ name: "shop-1.2.0" }])) as typeof fetch, Date.now, "https://api.github.test", git);
  assert.deepEqual((await api.list("acme/shop", "shop-{version}")).versions, ["1.2.0"]);

  const { git: ssh } = local(upstream());
  const viaGit = new Versions(undefined, (async () => { throw new Error("no API"); }) as typeof fetch, Date.now, "https://api.github.test", ssh);
  assert.deepEqual((await viaGit.list("acme/shop", "shop-{version}")).versions, ["1.2.0", "1.1.0", "1.0.0"]);
});

test("D46: the source archive is uploaded to OMA and mounted read-only in the session's sandbox", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/v1/files")) return Response.json({ id: "file_1" }, { status: 201 });
    if (String(url).endsWith("/v1/sessions")) return Response.json({ id: "sess_1" });
    return new Response(null, { status: 202 });
  }) as typeof fetch;
  const oma = new OmaSessions({ url: "http://oma.test/", keyFile: () => "k", agent: "agent_assessor" }, fetcher);
  const id = await oma.upload("source.tar.gz", new Uint8Array([0x1f, 0x8b]));
  assert.equal(id, "file_1");
  const form = calls[0]!.init.body as FormData;
  assert.equal((form.get("file") as File).name, "source.tar.gz");
  await oma.open("t", "c", "x", [{ id, mountPath: "/sandbox/files/source.tar.gz" }]);
  assert.deepEqual(JSON.parse(String(calls[1]!.init.body)).resources, [{ type: "file", file_id: "file_1", mount_path: "/sandbox/files/source.tar.gz", access: "read_only" }]);
});

test("a session's events are read to the last page, where the turn's end is (OMA pages them with after_seq)", async () => {
  const urls: string[] = [];
  const page = (from: number, n: number, more: boolean, last?: string) => Response.json({
    data: Array.from({ length: n }, (_, i) => ({ type: i === n - 1 && last ? last : "agent.tool_use", seq: from + i + 1 })),
    has_more: more, next_page: more ? `seq_${from + n}` : null,
  });
  const fetcher = (async (url: string) => {
    urls.push(String(url));
    const after = Number(new URL(String(url)).searchParams.get("after_seq") ?? 0);
    return after === 0 ? page(0, 200, true) : after === 200 ? page(200, 200, true) : page(400, 6, false, "session.status_idle");
  }) as typeof fetch;
  const oma = new OmaSessions({ url: "http://oma.test/", keyFile: () => "k", agent: "agent_assessor" }, fetcher);
  const events = await oma.events("sess_1");
  assert.equal(events.length, 406);
  assert.equal(events.at(-1)!.type, "session.status_idle");
  assert.deepEqual(urls.map((u) => new URL(u).searchParams.get("after_seq")), [null, "200", "400"]);
});
