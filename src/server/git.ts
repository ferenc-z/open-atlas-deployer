// D46: the Deployer reads repositories over SSH with one read-only key. Tags, diffs, commit messages and source
// archives come from git itself, not from a host's API, so a host without Releases or a compare API (Bitbucket)
// works the same. Each repository is a bare mirror under <data>/git: nothing is checked out, no hook runs and no
// other transport is allowed, so the repository's content stays bytes here (D20); the Agent unpacks it in its sandbox.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readToken, type TokenSource } from "./versions.ts";

export type GitRunner = (args: string[], options: { cwd?: string; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number }) => Promise<Buffer>;

export interface GitOptions {
  /** Where the bare mirrors, the key copy and the learned host keys live. */
  dir: string;
  keyFile: TokenSource;
  /** Pinned host keys; none: the first connection to a host records its key, later ones must match. */
  knownHostsFile?: string;
  run?: GitRunner;
}

export interface GitDiffFile { file: string; status: "added" | "modified" | "removed"; patch: string; truncated?: boolean }

const TAG = /^(?!-)[A-Za-z0-9._\/+-]+$/;
const ARCHIVE_LIMIT = 64 * 1024 * 1024;

/** The SSH address of a release repo: owner/name is GitHub (first phase); an ssh:// or git@ address is used as is. */
export function sshUrl(repo: string): string {
  const r = repo.trim();
  if (/^(ssh:\/\/|git@)[\w.@:\/~-]+$/.test(r)) return r;
  const m = /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(r);
  if (!m) throw new Error(`${repo} is neither owner/name on GitHub nor an SSH address (git@host:path or ssh://…)`);
  return `git@github.com:${m[1]}/${m[2]}.git`;
}

/** A key pasted into a one-line field loses its line breaks; ssh accepts it only with the body back in lines. */
export function pem(key: string): string {
  const m = /^-----BEGIN ([A-Z0-9 ]+)-----\s*([\s\S]*?)\s*-----END \1-----$/.exec(key.trim());
  if (!m) return key.trim();
  const body = m[2]!.replace(/\s+/g, "");
  return [`-----BEGIN ${m[1]}-----`, ...(body.match(/.{1,70}/g) ?? []), `-----END ${m[1]}-----`].join("\n");
}

export const runGit: GitRunner = (args, options) => new Promise((resolve, reject) => {
  execFile("git", args, { ...options, encoding: "buffer" }, (error, stdout, stderr) => {
    if (error) {
      const why = stderr.toString("utf8").trim().split("\n").filter(Boolean).slice(-3).join(" ") || error.message;
      reject(new Error(why));
    } else resolve(stdout);
  });
});

export class Git {
  private o: GitOptions;
  private run: GitRunner;

  constructor(options: GitOptions) {
    this.o = options;
    this.run = options.run ?? runGit;
  }

  /** Reading over SSH needs the key; without it the callers keep using the GitHub API. */
  get configured(): boolean { return Boolean(readToken(this.o.keyFile)); }

  private env(): NodeJS.ProcessEnv {
    const ssh = join(this.o.dir, ".ssh");
    mkdirSync(ssh, { recursive: true, mode: 0o700 });
    // ssh reads the key from a file only: write the current one (pasted keys live encrypted in the state, D45).
    const key = join(ssh, "key");
    const text = `${pem(readToken(this.o.keyFile))}\n`;
    if (!existsSync(key) || readFileSync(key, "utf8") !== text) writeFileSync(key, text, { mode: 0o600 });
    const known = this.o.knownHostsFile ?? join(ssh, "known_hosts");
    const q = (v: string) => `'${v.replaceAll("'", "'\\''")}'`;
    return {
      PATH: process.env.PATH,
      HOME: this.o.dir,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_SSH_COMMAND: `ssh -i ${q(key)} -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 -o UserKnownHostsFile=${q(known)} -o StrictHostKeyChecking=${this.o.knownHostsFile ? "yes" : "accept-new"}`,
    };
  }

  private git(args: string[], mirror?: string, maxBuffer = 16 * 1024 * 1024, timeout = 120_000): Promise<Buffer> {
    if (!this.configured) return Promise.reject(new Error("No SSH key for reading repositories (DEPLOYER_GIT_SSH_KEY_FILE)"));
    const safe = ["-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never", "-c", "protocol.ssh.allow=always", "-c", "core.fsmonitor=false"];
    return this.run([...safe, ...(mirror ? [`--git-dir=${mirror}`] : []), ...args], { env: this.env(), timeout, maxBuffer });
  }

  private async text(args: string[], mirror?: string): Promise<string> { return (await this.git(args, mirror)).toString("utf8"); }

  private async mirror(url: string): Promise<string> {
    const path = join(this.o.dir, `${createHash("sha256").update(url).digest("hex").slice(0, 16)}.git`);
    if (!existsSync(join(path, "HEAD"))) {
      mkdirSync(this.o.dir, { recursive: true });
      await this.git(["init", "--bare", "-q", path]);
    }
    return path;
  }

  /** Fetches the tags (or the default branch when none) into the repo's mirror; tags may have been moved, so always forced. */
  private async fetch(repo: string, tags: string[]): Promise<string> {
    for (const t of tags) if (!TAG.test(t)) throw new Error(`${t} is not a tag name`);
    const url = sshUrl(repo);
    const mirror = await this.mirror(url);
    const specs = tags.length ? tags.map((t) => `+refs/tags/${t}:refs/tags/${t}`) : ["+HEAD:refs/deployer/head"];
    await this.git(["fetch", "-q", "--no-tags", "--no-recurse-submodules", url, ...specs], mirror, 16 * 1024 * 1024, 300_000);
    return mirror;
  }

  async tags(repo: string): Promise<string[]> {
    const out = await this.text(["ls-remote", "--tags", "--refs", sshUrl(repo)]);
    return out.split("\n").map((l) => l.split("\t")[1] ?? "").filter((r) => r.startsWith("refs/tags/")).map((r) => r.slice("refs/tags/".length));
  }

  /** Every changed path between two tags, and the patches of those `pick` keeps (each cut at `perFile` characters). */
  async diff(repo: string, from: string, to: string, pick: RegExp, perFile = 8000): Promise<{ changed: number; files: GitDiffFile[] }> {
    const mirror = await this.fetch(repo, [from, to]);
    const a = `refs/tags/${from}`, b = `refs/tags/${to}`;
    const names = (await this.text(["diff", "--no-renames", "--name-status", "-z", a, b], mirror)).split("\0").filter(Boolean);
    const changed: { status: string; file: string }[] = [];
    for (let i = 0; i + 1 < names.length; i += 2) changed.push({ status: names[i]!, file: names[i + 1]! });
    const files: GitDiffFile[] = [];
    for (const c of changed.filter((x) => pick.test(x.file))) {
      const patch = await this.text(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", a, b, "--", c.file], mirror);
      files.push({
        file: c.file, status: c.status === "A" ? "added" : c.status === "D" ? "removed" : "modified",
        patch: patch.slice(0, perFile), ...(patch.length > perFile ? { truncated: true } : {}),
      });
    }
    return { changed: changed.length, files };
  }

  /** Commit subjects and bodies between two tags, newest first: what a host without release notes says about the change. */
  async log(repo: string, from: string, to: string, max = 200, chars = 20_000): Promise<{ commits: string[]; more: boolean }> {
    const mirror = await this.fetch(repo, [from, to]);
    const out = await this.text(["log", "--no-merges", `-n${max + 1}`, "--format=%h %s%n%b%x00", `refs/tags/${from}..refs/tags/${to}`], mirror);
    const all = out.split("\0").map((c) => c.trim()).filter(Boolean);
    const commits: string[] = [];
    let used = 0;
    for (const c of all.slice(0, max)) {
      if (used + c.length > chars) break;
      commits.push(c);
      used += c.length;
    }
    return { commits, more: commits.length < all.length };
  }

  /** The source at a tag (or the default branch) as a .tar.gz, for the Agent to unpack in its sandbox. */
  async archive(repo: string, tag: string | null): Promise<Buffer> {
    const mirror = await this.fetch(repo, tag ? [tag] : []);
    return this.git(["archive", "--format=tar.gz", tag ? `refs/tags/${tag}` : "refs/deployer/head"], mirror, ARCHIVE_LIMIT, 300_000);
  }
}
