// Service ops §9.3, §15.3 (phase 2 step 4): a service's logs. The service executor sums each watched NiFi's
// nifi-app.log WARN/ERROR entries by pattern into its samples (ingestLogs keeps them, with 5-minute counts for the
// rules); everything else is read on demand on the executor's read channel: log-read (list, lines, search, download;
// the lines and the archive come over the content channel, never into the job's status) and log-tail (§15.2 P7: up
// to 120 seconds, followed by inode and offset; its chunks reach the page over SSE, and while someone still follows a
// new tail carries on from the cursor the last one ended at; one tail per node and file, shared by everyone following).
// The executor reads only below the log directories of what it watches (realpath compared, links out refused).

import { newJobId, type ExecutorInfo, type Handoff } from "../handoff.ts";
import type { LogPatternIn, Store } from "../store.ts";
import { installKey, type ServiceMember } from "./draft.ts";
import type { ServiceSample } from "./watch.ts";
import { watchList } from "./watch.ts";

type Any = Record<string, any>;

export const LOG_LEVELS = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
/** §15.3: a search returns at most 5000 lines per node; a download at most 50 MiB; a tail runs 120 seconds at most. */
export const SEARCH_LIMIT = 5000;
export const DOWNLOAD_MAX = 50 << 20;
export const TAIL_SECONDS = 120;
const BUCKET_MS = 5 * 60_000;

export const bucketOf = (iso: string) => new Date(Math.floor(Date.parse(iso) / BUCKET_MS) * BUCKET_MS).toISOString().replace(".000Z", "Z");
const str = (v: unknown, max = 4096) => (typeof v === "string" ? v.slice(0, max) : null);

/** The patterns of a sample's log summary, as they are stored (malformed ones left out). */
export function logPatternsOf(sample: ServiceSample): LogPatternIn[] {
  const list = (sample.logs as Any | undefined)?.patterns;
  if (!Array.isArray(list)) return [];
  return list.slice(0, 200).flatMap((p: Any) => {
    if (!p || typeof p.key !== "string" || !/^[0-9a-f]{8,64}$/.test(p.key) || typeof p.level !== "string" || typeof p.count !== "number" || p.count < 1) return [];
    const lastAt = str(p.lastAt) && !Number.isNaN(Date.parse(p.lastAt)) ? p.lastAt : sample.at;
    const firstAt = str(p.firstAt) && !Number.isNaN(Date.parse(p.firstAt)) ? p.firstAt : lastAt;
    return [{ pattern: p.key, level: p.level.slice(0, 10), logger: str(p.logger, 300), template: str(p.template, 400) ?? "", exception: str(p.exception, 300), firstAt, lastAt,
      count: Math.floor(p.count), first: str(p.first, 2048), last: str(p.last, 2048), bucket: bucketOf(lastAt) }];
  });
}

/** Keeps a sample's log summary; what stays in the raw sample is only where the summary stands. */
export function ingestLogs(store: Store, sample: ServiceSample): Any | undefined {
  const logs = sample.logs as Any | undefined;
  if (!logs || typeof logs !== "object") return undefined;
  store.addLogPatterns(sample.service, sample.member, logPatternsOf(sample));
  const { patterns: _p, ...rest } = logs;
  return { ...rest, patterns: Array.isArray(logs.patterns) ? logs.patterns.length : 0 };
}

export class LogsError extends Error {
  readonly status: 400 | 404 | 409 | 503;
  readonly code: string;
  constructor(status: 400 | 404 | 409 | 503, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

export interface LogMember {
  key: string;
  host: string;
  label: string;
  logDir: string;
  executor: { online: boolean; reason?: string; version?: string };
  /** Whether the member's service executor names log-read / log-tail in its heartbeat (§15.2: by kind, not version). */
  canRead: boolean;
  canTail: boolean;
}

export interface SearchQuery { members?: string[]; files?: string[]; from: string; to: string; levels?: LogLevel[]; query?: string; regex?: boolean; limit: number }
export interface LogEntry { member: string; label: string; file: string; at: string; local: string; level: string; logger: string | null; thread: string | null; text: string }
export interface SearchResult {
  from: string; to: string;
  entries: LogEntry[];
  members: { member: string; label: string; state: "ok" | "failed"; entries: number; truncated: string | null; error?: string; files?: string[] }[];
}

/** A search request from the page or an API key: checked, with the defaults (the last hour, 1000 lines a node). */
export function parseSearch(body: unknown, now = new Date()): SearchQuery | { error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Any;
  const out: SearchQuery = { from: "", to: "", limit: 1000 };
  const to = b.to ? new Date(b.to) : now;
  const from = b.from ? new Date(b.from) : new Date(to.getTime() - 3600_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) return { error: "from and to are ISO times, from before to." };
  out.from = from.toISOString(); out.to = to.toISOString();
  if (b.members !== undefined && (!Array.isArray(b.members) || !b.members.every((m: unknown) => typeof m === "string") || b.members.length > 64)) return { error: "members is a list of member keys." };
  if (b.members) out.members = b.members;
  if (b.files !== undefined && (!Array.isArray(b.files) || b.files.length > 500 || !b.files.every((f: unknown) => typeof f === "string" && /^[^/\0]{1,255}$/.test(f)))) return { error: "files is a list of log file names (no paths)." };
  if (b.files?.length) out.files = b.files;
  if (b.levels !== undefined && (!Array.isArray(b.levels) || !b.levels.every((l: unknown) => (LOG_LEVELS as readonly unknown[]).includes(l)))) return { error: `levels are among ${LOG_LEVELS.join(", ")}.` };
  if (b.levels?.length) out.levels = b.levels;
  if (b.query !== undefined && b.query !== null && (typeof b.query !== "string" || b.query.length > 500)) return { error: "query is text of at most 500 characters." };
  if (b.query) out.query = b.query;
  if (b.regex) {
    try { new RegExp(String(b.query ?? "")); } catch (error) { return { error: `query is not a regular expression: ${(error as Error).message}` }; }
    out.regex = true;
  }
  if (b.limit !== undefined && !(Number.isInteger(b.limit) && b.limit >= 1 && b.limit <= SEARCH_LIMIT)) return { error: `limit is 1 to ${SEARCH_LIMIT} lines per node.` };
  if (b.limit) out.limit = b.limit;
  return out;
}

type TailEvent = Record<string, unknown> & { type: "lines" | "state" };
type Listener = (e: TailEvent) => void;
interface Tail { key: string; service: string; member: string; host: string; file: string; listeners: Set<Listener>; job: string | null; cursor: { inode: number; offset: number } | null; recent: string; jobs: number; retry: NodeJS.Timeout | null }

export class ServiceLogs {
  private tails = new Map<string, Tail>();
  private store: Store;
  private handoff: Handoff;
  private opts: { waitMs?: number; pollMs?: number; tailSeconds?: number; retryMs?: number };

  constructor(store: Store, handoff: Handoff, opts: { waitMs?: number; pollMs?: number; tailSeconds?: number; retryMs?: number } = {}) {
    this.store = store;
    this.handoff = handoff;
    this.opts = opts;
  }

  private executor(host: string): ExecutorInfo { return this.handoff.executor(host, "service"); }

  /** A registered service's members with their log directory and what their executor can do; undefined: no such service. */
  members(id: string): LogMember[] | undefined {
    const standalone = this.store.standalones().find((s) => s.id === id);
    const cluster = standalone ? undefined : this.store.clusters().find((c) => c.id === id);
    if (!standalone && !cluster) return undefined;
    const members: ServiceMember[] = standalone ? [standalone.member] : cluster!.nodes;
    const watches = new Map<string, ReturnType<typeof watchList>>();
    return members.map((m) => {
      const key = installKey(m);
      if (!watches.has(m.host)) watches.set(m.host, watchList(this.store, m.host));
      const w = watches.get(m.host)!.find((x) => x.member === key);
      const info = this.executor(m.host);
      const kinds = info.heartbeat?.kinds ?? [];
      const port = m.ports?.https ?? m.ports?.http ?? null;
      return {
        key, host: m.host, label: cluster ? `${m.nodeAddress ?? m.host}:${port ?? "?"}` : m.host,
        logDir: w?.logDir ?? `${m.installDir.replace(/\/+$/, "")}/logs`,
        executor: { online: info.online, ...(info.reason ? { reason: info.reason } : {}), ...(info.heartbeat?.version ? { version: info.heartbeat.version } : {}) },
        canRead: kinds.includes("log-read"), canTail: kinds.includes("log-tail"),
      };
    });
  }

  private member(id: string, key: string): LogMember {
    const all = this.members(id);
    if (!all) throw new LogsError(404, "service/unknown", `No standalone instance or cluster ${id}.`);
    const m = all.find((x) => x.key === key);
    if (!m) throw new LogsError(404, "logs/member", `${key} is not a member of ${id}.`);
    return m;
  }

  private usable(m: LogMember, kind: "log-read" | "log-tail") {
    if (!m.executor.online) throw new LogsError(409, "logs/executor-offline", m.executor.reason ?? `The service executor on ${m.host} is offline.`);
    if (!(kind === "log-read" ? m.canRead : m.canTail)) throw new LogsError(409, "executor/unsupported", `The service executor ${m.executor.version ?? ""} on ${m.host} cannot ${kind === "log-read" ? "read" : "follow"} logs (its heartbeat does not name ${kind}): upgrade it first.`);
  }

  /** One log-read on a member's executor: its status and the content it sent. */
  private async read(m: LogMember, request: Record<string, unknown>): Promise<{ result: Any; content: Buffer | undefined; truncated: boolean }> {
    this.usable(m, "log-read");
    const id = newJobId("log-read");
    this.handoff.submit(id, { kind: "log-read", member: m.key, timeoutSeconds: 35, ...request }, m.host, "service");
    const status = await this.handoff.awaitJob(id, this.opts.waitMs ?? 50_000, this.opts.pollMs ?? 200);
    if (!status) throw new LogsError(503, "logs/timeout", `The service executor on ${m.host} did not answer in time (job ${id}).`);
    const content = this.handoff.takeContent(id);
    if (status.state !== "succeeded") throw new LogsError(status.state === "refused" ? 400 : 503, `logs/${status.state}`, `${m.label}: ${status.message ?? status.state}`);
    return { result: (status.result ?? {}) as Any, content: content?.data, truncated: content?.truncated ?? false };
  }

  async files(id: string, key: string): Promise<{ dir: string; files: { name: string; size: number; modifiedAt: string; gz: boolean }[]; more: number }> {
    const { content } = await this.read(this.member(id, key), { mode: "list" });
    return JSON.parse(content?.toString("utf8") ?? "{}");
  }

  /** The last lines of one file (lines ≤ 5000). */
  async lines(id: string, key: string, file: string, lines: number): Promise<{ file: string; lines: string[] }> {
    const { content } = await this.read(this.member(id, key), { mode: "lines", file, lines });
    const body = JSON.parse(content?.toString("utf8") ?? "{}");
    return { file: body.file, lines: body.lines ?? [] };
  }

  /** §9.3: every chosen member searched in parallel, the matches merged by time. */
  async search(id: string, q: SearchQuery): Promise<SearchResult> {
    const all = this.members(id);
    if (!all) throw new LogsError(404, "service/unknown", `No standalone instance or cluster ${id}.`);
    const chosen = q.members ? all.filter((m) => q.members!.includes(m.key)) : all;
    if (!chosen.length) throw new LogsError(400, "logs/members", "None of the members asked for belongs to this service.");
    const request = { mode: "search", from: q.from, to: q.to, limit: q.limit, ...(q.files ? { files: q.files } : {}), ...(q.levels ? { levels: q.levels } : {}),
      ...(q.query ? { query: q.query } : {}), ...(q.regex ? { regex: true } : {}), maxBytes: 6 << 20 };
    const done = await Promise.all(chosen.map(async (m) => {
      try {
        const { content, truncated } = await this.read(m, request);
        const body = JSON.parse(content?.toString("utf8") ?? "{}") as Any;
        const entries: LogEntry[] = (body.entries ?? []).map((e: Any) => ({ member: m.key, label: m.label, file: e.file, at: e.at, local: e.local, level: e.level, logger: e.logger ?? null, thread: e.thread ?? null, text: e.text }));
        return { entries, summary: { member: m.key, label: m.label, state: "ok" as const, entries: entries.length, truncated: body.truncated ?? (truncated ? "the answer was cut at its size limit" : null), files: body.files ?? [] } };
      } catch (error) {
        if (!(error instanceof LogsError) && !(error as { code?: string }).code) throw error;
        return { entries: [], summary: { member: m.key, label: m.label, state: "failed" as const, entries: 0, truncated: null, error: (error as Error).message } };
      }
    }));
    const entries = done.flatMap((d) => d.entries).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
    return { from: q.from, to: q.to, entries, members: done.map((d) => d.summary) };
  }

  /** One member's files as a tar.gz (at most 50 MiB). */
  async download(id: string, key: string, files: string[]): Promise<{ name: string; data: Buffer; result: Any }> {
    const m = this.member(id, key);
    if (!files.length || files.length > 500 || !files.every((f) => /^[^/\0]{1,255}$/.test(f))) throw new LogsError(400, "logs/files", "files are log file names in the log directory (no paths).");
    const { content, result, truncated } = await this.read(m, { mode: "download", files, maxBytes: DOWNLOAD_MAX, timeoutSeconds: 110 });
    if (!content || truncated) throw new LogsError(503, "logs/download", `${m.label}: the archive did not arrive whole; choose fewer files.`);
    const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
    const name = `${id}-${m.label.replace(/[^A-Za-z0-9._-]+/g, "_")}-logs-${stamp}.tar.gz`;
    return { name, data: content, result };
  }

  /** Follows one member's file (§15.2 P7): the listener gets the lines as they come (first the recent ones), and the
   *  state; the returned function stops listening. One tail per member and file, shared. */
  tail(id: string, key: string, file: string, listener: Listener): () => void {
    if (!/^[^/\0]{1,255}$/.test(file) || file.endsWith(".gz")) throw new LogsError(400, "logs/file", "file is the name of a growing log file in the log directory (not a .gz).");
    const m = this.member(id, key);
    this.usable(m, "log-tail");
    const k = `${id}\0${key}\0${file}`;
    let t = this.tails.get(k);
    if (!t) {
      t = { key: k, service: id, member: key, host: m.host, file, listeners: new Set(), job: null, cursor: null, recent: "", jobs: 0, retry: null };
      this.tails.set(k, t);
    }
    t.listeners.add(listener);
    if (!t.job && !t.retry) this.start(t);
    listener({ type: "state", state: "following", job: t.job, followers: t.listeners.size, tails: t.jobs });
    if (t.recent) listener({ type: "lines", text: t.recent, backlog: true });
    const tail = t;
    return () => { tail.listeners.delete(listener); };
  }

  /** How many tails run (tests and the page's notes). */
  tailing(): { service: string; member: string; file: string; followers: number; job: string | null }[] {
    return [...this.tails.values()].map((t) => ({ service: t.service, member: t.member, file: t.file, followers: t.listeners.size, job: t.job }));
  }

  private broadcast(t: Tail, e: TailEvent) {
    for (const l of t.listeners) { try { l(e); } catch { /* a listener that went away */ } }
  }

  private start(t: Tail) {
    t.retry = null;
    if (!t.listeners.size) { this.tails.delete(t.key); return; }
    const seconds = this.opts.tailSeconds ?? TAIL_SECONDS;
    const id = newJobId("log-tail");
    try {
      const executor = this.executor(t.host);
      if (!executor.online) throw new LogsError(409, "logs/executor-offline", executor.reason ?? `The service executor on ${t.host} is offline.`);
      this.handoff.submit(id, { kind: "log-tail", member: t.member, file: t.file, seconds, timeoutSeconds: seconds + 10, ...(t.cursor ? { cursor: t.cursor } : { lines: 100 }) }, t.host, "service");
    } catch (error) {
      this.broadcast(t, { type: "state", state: "error", message: (error as Error).message });
      t.retry = setTimeout(() => this.start(t), this.opts.retryMs ?? 5000);
      t.retry.unref?.();
      return;
    }
    t.job = id;
    t.jobs++;
    if (t.jobs > 1) this.broadcast(t, { type: "state", state: "renewed", job: id, followers: t.listeners.size, tails: t.jobs });
    this.handoff.onChunk(id, (chunk) => {
      if (typeof chunk.inode === "number" && typeof chunk.offset === "number") t.cursor = { inode: chunk.inode, offset: chunk.offset };
      const text = typeof chunk.text === "string" ? chunk.text : "";
      if (text) t.recent = (t.recent + text).slice(-64 * 1024);
      if (text || chunk.rotated) this.broadcast(t, { type: "lines", text, ...(chunk.rotated ? { rotated: chunk.rotated } : {}), ...(chunk.first ? { first: true } : {}) });
      return t.listeners.size > 0;
    });
    void this.handoff.awaitJob(id, (seconds + 60) * 1000, this.opts.pollMs ?? 1000, true).then((status) => {
      this.handoff.onChunk(id, null);
      t.job = null;
      const r = (status?.result ?? {}) as Any;
      if (status?.state === "succeeded" && typeof r.inode === "number" && typeof r.offset === "number") t.cursor = { inode: r.inode, offset: r.offset };
      if (!t.listeners.size) { this.tails.delete(t.key); return; }
      if (status?.state === "succeeded") { this.start(t); return; }
      this.broadcast(t, { type: "state", state: "error", message: status ? `${status.state}: ${status.message ?? ""}` : `The tail ${id} did not end in time.` });
      t.retry = setTimeout(() => this.start(t), this.opts.retryMs ?? 5000);
      t.retry.unref?.();
    });
  }
}
