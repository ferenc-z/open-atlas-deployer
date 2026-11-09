// Service ops §15.3, phase 2 step 2: what the Deployer makes of the collector's samples. Each sample is kept raw (2 days)
// with its flat numbers (a point: heap, GC, threads, queue, back pressure, repositories, host), rolled up every 5 minutes
// (30 days); its bulletins go to service_bulletins (each once, dated: NiFi gives only the time of day), its certificates
// to service_certs (only the newest reading). Rates come from counters here (cpuSeconds, GC). Rules and alerts are step 3.

import { fingerprintsOf } from "./configdrift.ts";
import type { Point, ServiceBulletin, ServiceCert, Store } from "../store.ts";
import type { ServiceSample } from "./watch.ts";
import { installKey, type ServiceMember } from "./draft.ts";
import { ingestLogs } from "./logs.ts";

export const RAW_DAYS = 2;
export const ROLLUP_DAYS = 30;
export const ROLLUP_MINUTES = 5;

/** The numbers of a point, in the order the Metrics tab shows them; unit for the axis. */
export const FIELDS = {
  up: { label: "Process up", unit: "bool" },
  heapUsed: { label: "Heap used", unit: "bytes" },
  heapMax: { label: "Heap max", unit: "bytes" },
  heapPct: { label: "Heap used", unit: "%" },
  nonHeap: { label: "Non-heap used", unit: "bytes" },
  gcMsPerMin: { label: "GC time", unit: "ms/min" },
  gcPerMin: { label: "GC runs", unit: "/min" },
  threads: { label: "JVM threads", unit: "count" },
  activeThreads: { label: "Active threads", unit: "count" },
  queuedCount: { label: "Queued flowfiles", unit: "count" },
  queuedBytes: { label: "Queued bytes", unit: "bytes" },
  bpFull: { label: "Connections at back pressure", unit: "count" },
  bpMaxPct: { label: "Fullest connection", unit: "%" },
  repoFlowfilePct: { label: "FlowFile repository disk", unit: "%" },
  repoContentPct: { label: "Content repository disk", unit: "%" },
  repoProvenancePct: { label: "Provenance repository disk", unit: "%" },
  cpuPct: { label: "Process CPU", unit: "%" },
  rss: { label: "Process RSS", unit: "bytes" },
  load1: { label: "Host load (1 min)", unit: "count" },
  memPct: { label: "Host memory used", unit: "%" },
  diskPct: { label: "Fullest disk", unit: "%" },
} as const;
export type Field = keyof typeof FIELDS;

type Any = Record<string, any>;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const pct = (used: unknown, total: unknown) => { const u = num(used), t = num(total); return u !== null && t ? Math.round((u / t) * 1000) / 10 : null; };
const round = (v: number | null, digits = 1) => (v === null ? null : Math.round(v * 10 ** digits) / 10 ** digits);

/** Which of a cluster's node entries (nodewise snapshot, /controller/cluster) is this member: by API port, and address when known. */
export function ownNode<T extends { address?: unknown; apiPort?: unknown }>(nodes: T[] | undefined, m: Pick<ServiceMember, "ports" | "nodeAddress">): T | undefined {
  if (!Array.isArray(nodes)) return undefined;
  const port = m.ports?.https ?? m.ports?.http ?? null;
  const byPort = nodes.filter((n) => n.apiPort === port);
  return byPort.find((n) => m.nodeAddress && n.address === m.nodeAddress) ?? (byPort.length === 1 ? byPort[0] : undefined);
}

/** A sample's flat numbers; the previous sample of the same member gives the rates (none across a restart). */
export function pointOf(sample: Any, m: Pick<ServiceMember, "ports" | "nodeAddress">, previous?: Point | null, previousAt?: string): Point {
  const proc = sample.process ?? {};
  const nifi = sample.nifi ?? {};
  const diag = nifi.diagnostics ?? {};
  const snap: Any | undefined = Array.isArray(diag.nodes) ? ownNode(diag.nodes, m) : diag.aggregate;
  const clusterSelf: Any | undefined = ownNode(nifi.cluster?.nodes, m);
  const repo = (kind: string) => {
    const list = (snap?.repositories?.[kind] ?? []) as Any[];
    const all = list.map((u) => pct(u.usedSpaceBytes, u.totalSpaceBytes)).filter((v): v is number => v !== null);
    return all.length ? Math.max(...all) : null;
  };
  const gc = (snap?.gc ?? []) as Any[];
  const gcMillis = gc.length ? gc.reduce((s, g) => s + (num(g.millis) ?? 0), 0) : null;
  const gcCount = gc.length ? gc.reduce((s, g) => s + (num(g.count) ?? 0), 0) : null;
  const startedAt = typeof proc.startedAt === "string" ? Date.parse(proc.startedAt) : NaN;
  const disks = ((sample.disks ?? []) as Any[]).map((d) => pct(d.usedBytes, num(d.usedBytes) !== null && num(d.freeBytes) !== null ? d.usedBytes + d.freeBytes : d.totalBytes)).filter((v): v is number => v !== null);
  const mem = sample.host?.memory ?? {};
  const point: Point = {
    up: proc.running === true ? 1 : proc.running === false ? 0 : null,
    heapUsed: num(snap?.heap?.usedBytes), heapMax: num(snap?.heap?.maxBytes), heapPct: pct(snap?.heap?.usedBytes, snap?.heap?.maxBytes),
    nonHeap: num(snap?.nonHeapUsedBytes),
    gcMsPerMin: null, gcPerMin: null,
    threads: num(snap?.totalThreads),
    // A node's own share of the cluster's queue (the cluster view); a standalone's from /flow/status.
    activeThreads: num(clusterSelf?.activeThreadCount) ?? (Array.isArray(diag.nodes) ? null : num(nifi.status?.activeThreadCount)),
    queuedCount: num(clusterSelf?.flowFilesQueued) ?? (Array.isArray(diag.nodes) ? null : num(nifi.status?.flowFilesQueued)),
    queuedBytes: num(clusterSelf?.bytesQueued) ?? (Array.isArray(diag.nodes) ? null : num(nifi.status?.bytesQueued)),
    // Back pressure is read every few minutes (owner 2026-11-07): only some samples carry it; _bpEvery says how often
    // (an executor from before sends it every round without saying: null, the sampling period).
    bpFull: num(nifi.backpressure?.full), bpMaxPct: num(nifi.backpressure?.maxPercent),
    repoFlowfilePct: repo("flowfile"), repoContentPct: repo("content"), repoProvenancePct: repo("provenance"),
    cpuPct: null, rss: num(proc.rssBytes),
    load1: num(sample.host?.load?.[0]), memPct: pct(num(mem.totalBytes) !== null && num(mem.availableBytes) !== null ? mem.totalBytes - mem.availableBytes : null, mem.totalBytes),
    diskPct: disks.length ? Math.max(...disks) : null,
    _cpuSeconds: num(proc.cpuSeconds), _gcMillis: gcMillis, _gcCount: gcCount, _startedAt: Number.isNaN(startedAt) ? null : startedAt,
    ...(nifi.backpressure ? { _bpEvery: num(nifi.backpressure.everySeconds) } : {}),
  };
  if (previous && previousAt) {
    const minutes = (Date.parse(sample.at) - Date.parse(previousAt)) / 60_000;
    const sameProcess = point._startedAt !== null && point._startedAt === previous._startedAt;
    const rate = (now: number | null, was: number | null | undefined, per: number) => (now !== null && was !== null && was !== undefined && now >= was && minutes > 0 ? (now - was) / per : null);
    if (sameProcess && minutes > 0 && minutes <= 30) {
      const cpu = rate(point._cpuSeconds ?? null, previous._cpuSeconds, minutes * 60);
      point.cpuPct = cpu === null ? null : round(cpu * 100);
      point.gcMsPerMin = round(rate(gcMillis, previous._gcMillis, minutes));
      point.gcPerMin = round(rate(gcCount, previous._gcCount, minutes), 2);
    }
  }
  return point;
}

// --- bulletins: NiFi says only "HH:MM:SS TZ" in its own time zone ---------------------------------------------------

const TIME = /^(\d{1,2}):(\d{2}):(\d{2})(?:\.\d+)?(?:\s+(\S+))?$/;
const FULL = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:\s+(\S+))?$/;
const DAY = 86_400_000;
const QUARTER = 15 * 60_000;
const roundQuarter = (ms: number) => Math.round(ms / QUARTER) * QUARTER;
const seconds = (h: string, m: string, s: string) => (Number(h) * 3600 + Number(m) * 60 + Number(s)) * 1000;

/** The NiFi's offset from UTC (ms) known per member and time-zone name, from earlier samples. */
const offsets = new Map<string, number>();

/** The NiFi's UTC offset at this sample: from a full local time in the cluster view (heartbeats), else from the newest
 *  bulletin (the bulletin board keeps 5 minutes, so it is under 7.5 minutes old), else as found before. */
export function localOffset(sample: Any, key: string): number | null {
  const at = Date.parse(sample.at);
  const tz = sample.nifi?.about?.timezone ?? "";
  for (const n of (sample.nifi?.cluster?.nodes ?? []) as Any[]) {
    const f = FULL.exec(String(n.heartbeat ?? ""));
    if (f) {
      const local = Date.UTC(Number(f[3]), Number(f[1]) - 1, Number(f[2]), Number(f[4]), Number(f[5]), Number(f[6]));
      const off = roundQuarter(local - at);
      offsets.set(`${key}\0${tz}`, off);
      return off;
    }
  }
  const known = offsets.get(`${key}\0${tz}`);
  if (known !== undefined) return known;
  const times = ((sample.nifi?.bulletins ?? []) as Any[]).map((b) => TIME.exec(String(b.timestamp ?? ""))).filter((t): t is RegExpExecArray => Boolean(t)).map((t) => seconds(t[1]!, t[2]!, t[3]!));
  if (!times.length) return null;
  const utcOfDay = ((at % DAY) + DAY) % DAY;
  let off = roundQuarter(Math.max(...times) - utcOfDay);
  if (off > 14 * 3600_000) off -= DAY;
  if (off < -12 * 3600_000) off += DAY;
  offsets.set(`${key}\0${tz}`, off);
  return off;
}

/** The UTC time of a bulletin's "HH:MM:SS TZ": the newest such time not after the sample (2 minutes of slack). */
export function bulletinTime(timestamp: unknown, sampleAt: string, offset: number): string | null {
  const t = TIME.exec(String(timestamp ?? ""));
  if (!t) return null;
  const local = Date.parse(sampleAt) + offset;
  const day = Math.floor(local / DAY) * DAY;
  let when = day + seconds(t[1]!, t[2]!, t[3]!);
  if (when > local + 120_000) when -= DAY;
  return new Date(when - offset).toISOString().replace(".000Z", "Z");
}

export function bulletinsOf(sample: Any, service: string, member: string): ServiceBulletin[] {
  const list = (sample.nifi?.bulletins ?? []) as Any[];
  if (!list.length) return [];
  const offset = localOffset(sample, `${service}\0${member}`) ?? 0;
  return list.flatMap((b): ServiceBulletin[] => {
    const at = bulletinTime(b.timestamp, sample.at, offset);
    if (at === null || typeof b.id !== "number") return [];
    return [{ service, member, node: String(b.nodeAddress ?? member), id: b.id, at, level: b.level ?? null, category: b.category ?? null, source: b.sourceName ?? null, sourceType: b.sourceType ?? null, message: b.message ?? null }];
  });
}

// --- certificates (S27) ------------------------------------------------------------------------------------------

export function certRows(certs: Any): Omit<ServiceCert, "member" | "readAt">[] {
  const rows: Omit<ServiceCert, "member" | "readAt">[] = [];
  const blank = { path: null, type: null, alias: null, chain: null, subject: null, issuer: null, notBefore: null, notAfter: null, error: null };
  if (certs.error) rows.push({ ...blank, store: "*", error: String(certs.error) });
  for (const s of (certs.stores ?? []) as Any[]) {
    const base = { ...blank, store: String(s.store ?? "?"), path: s.path ?? null, type: s.type ?? null };
    if (s.error) rows.push({ ...base, error: String(s.error) });
    for (const c of (s.certificates ?? []) as Any[]) rows.push({ ...base, alias: c.alias ?? null, chain: num(c.chain), subject: c.subject ?? null, issuer: c.issuer ?? null, notBefore: c.notBefore ?? null, notAfter: c.notAfter ?? null });
  }
  return rows;
}

// --- taking samples in --------------------------------------------------------------------------------------------

/** The registered member a sample is of (by installKey). */
export function memberOf(store: Store, service: string, member: string): ServiceMember | undefined {
  const s = store.standalones().find((x) => x.id === service);
  if (s) return installKey(s.member) === member ? s.member : undefined;
  return store.clusters().find((x) => x.id === service)?.nodes.find((n) => installKey(n) === member);
}

/** Keeps accepted samples: each with its point; bulletins and certificates out of them into their tables. */
export function ingest(store: Store, samples: ServiceSample[]): { bulletins: number; certs: number } {
  let bulletins = 0, certs = 0;
  const sorted = [...samples].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const kept: (ServiceSample & { point: Point })[] = [];
  const last = new Map<string, { at: string; point: Point | null }>();
  for (const s of sorted) {
    const m = memberOf(store, s.service, s.member);
    const key = `${s.service}\0${s.member}`;
    const prev = last.get(key) ?? store.serviceSampleBefore(s.service, s.member, s.at);
    const point = pointOf(s, m ?? { ports: { https: null } as never, nodeAddress: null }, prev?.point, prev?.at);
    last.set(key, { at: s.at, point });
    bulletins += store.addServiceBulletins(bulletinsOf(s, s.service, s.member));
    const c = s.certs as Any | undefined;
    if (c && typeof c.readAt === "string" && store.putServiceCerts(s.service, s.member, c.readAt, certRows(c))) certs++;
    // Step 4: the log summary's patterns to service_log_patterns.
    const logs = ingestLogs(store, s);
    // The raw body without what went to its own tables.
    store.setServiceMemberActuals(s.service, s.member, fingerprintsOf(s), s.at);
    const { certs: _c, files: _f, ...rest } = s;
    const nifi = rest.nifi as Any | undefined;
    kept.push({ ...rest, ...(nifi ? { nifi: { ...nifi, bulletins: undefined } } : {}), ...(logs ? { logs } : {}), point } as ServiceSample & { point: Point });
  }
  store.addServiceSamples(kept);
  return { bulletins, certs };
}

// --- rollups and retention ----------------------------------------------------------------------------------------

const bucketOf = (iso: string) => new Date(Math.floor(Date.parse(iso) / (ROLLUP_MINUTES * 60_000)) * ROLLUP_MINUTES * 60_000).toISOString().replace(".000Z", "Z");
const shown = (Object.keys(FIELDS) as Field[]);

/** The average, maximum and last of each number over some points. */
export function summarize(points: Point[]): { n: number; avg: Point; max: Point; last: Point } {
  const avg: Point = {}, max: Point = {}, last: Point = {};
  for (const f of shown) {
    const vs = points.map((p) => p[f]).filter((v): v is number => typeof v === "number");
    avg[f] = vs.length ? round(vs.reduce((a, b) => a + b, 0) / vs.length, 3) : null;
    max[f] = vs.length ? Math.max(...vs) : null;
    last[f] = vs.length ? vs[vs.length - 1]! : null;
  }
  return { n: points.length, avg, max, last };
}

/** Rolls up every finished 5-minute bucket not rolled up yet (from the newest rolled-up one on). */
export function rollUp(store: Store, now: Date): number {
  const end = bucketOf(now.toISOString());
  const since = new Date(now.getTime() - RAW_DAYS * DAY).toISOString();
  let rows = 0;
  for (const { service, member, first } of store.sampledMembers(since)) {
    const done = store.lastServiceRollup(service, member);
    const from = done ? new Date(Date.parse(done) + ROLLUP_MINUTES * 60_000).toISOString().replace(".000Z", "Z") : bucketOf(first);
    if (from >= end) continue;
    const groups = new Map<string, Point[]>();
    for (const p of store.memberPoints(service, member, from, end)) {
      const b = bucketOf(p.at);
      groups.set(b, [...(groups.get(b) ?? []), p.point]);
    }
    const out = [...groups].map(([bucket, points]) => ({ service, member, bucket, body: summarize(points) }));
    store.putServiceRollups(out);
    rows += out.length;
  }
  return rows;
}

export function prune(store: Store, now: Date) {
  return store.pruneServiceData(new Date(now.getTime() - RAW_DAYS * DAY).toISOString(), new Date(now.getTime() - ROLLUP_DAYS * DAY).toISOString());
}

// --- reading: GET /api/services/:id/metrics -----------------------------------------------------------------------

export const RANGES = { "1h": 3600, "6h": 6 * 3600, "2d": 2 * 86400, "30d": 30 * 86400 } as const;
export type Range = keyof typeof RANGES;
const TARGET_POINTS = 240;

export interface MetricsView {
  from: string; to: string; step: number; source: "samples" | "rollups";
  fields: typeof FIELDS;
  /** Each member's series: times and, per field, the bucket averages (null: no data). */
  members: { member: string; at: string[]; values: Partial<Record<Field, (number | null)[]>> }[];
}

/** A service's numbers between two times, in buckets of step seconds: from the raw samples up to 2 days back, else from the 5-minute rollups. */
export function metrics(store: Store, service: string, opts: { from: Date; to: Date; now: Date; step?: number; member?: string; fields?: Field[] }): MetricsView {
  const span = Math.max(60, (opts.to.getTime() - opts.from.getTime()) / 1000);
  // Raw samples are kept 2 days: a range starting later than that reads them (an hour of slack for the hourly cleanup).
  const raw = opts.from.getTime() >= opts.now.getTime() - RAW_DAYS * DAY - 3600_000;
  const minimum = raw ? 10 : ROLLUP_MINUTES * 60;
  const step = Math.max(minimum, Math.round(opts.step ?? span / TARGET_POINTS));
  const fields = opts.fields?.length ? opts.fields : shown;
  const from = opts.from.toISOString(), to = opts.to.toISOString();
  const rows: { member: string; at: string; point: Point }[] = raw
    ? store.servicePoints(service, from, to)
    : store.serviceRollups(service, from, to).map((r) => ({ member: r.member, at: r.bucket, point: r.body.avg as Point }));
  const by = new Map<string, Map<number, Point[]>>();
  for (const r of rows) {
    if (opts.member && r.member !== opts.member) continue;
    const b = Math.floor(Date.parse(r.at) / 1000 / step) * step;
    const m = by.get(r.member) ?? new Map<number, Point[]>();
    m.set(b, [...(m.get(b) ?? []), r.point]);
    by.set(r.member, m);
  }
  return {
    from, to, step, source: raw ? "samples" : "rollups", fields: FIELDS,
    members: [...by].sort(([a], [b]) => (a < b ? -1 : 1)).map(([member, buckets]) => {
      const keys = [...buckets.keys()].sort((a, b) => a - b);
      const sums = keys.map((k) => summarize(buckets.get(k)!).avg);
      return {
        member, at: keys.map((k) => new Date(k * 1000).toISOString().replace(".000Z", "Z")),
        values: Object.fromEntries(fields.map((f) => [f, sums.map((s) => s[f] ?? null)])),
      };
    }),
  };
}

/** The list cards' small trends (§15.3): over the last hour in 5-minute steps, the members' average heap % and their total queue. */
export function trend(store: Store, service: string, now: Date): { heapPct: (number | null)[]; queuedCount: (number | null)[] } {
  const step = ROLLUP_MINUTES * 60_000, end = Math.floor(now.getTime() / step) * step + step, start = end - 12 * step;
  const heap: number[][] = Array.from({ length: 12 }, () => []);
  const queue: Map<string, number>[] = Array.from({ length: 12 }, () => new Map());
  for (const r of store.servicePoints(service, new Date(start).toISOString(), new Date(end).toISOString())) {
    const i = Math.floor((Date.parse(r.at) - start) / step);
    if (i < 0 || i > 11) continue;
    if (typeof r.point.heapPct === "number") heap[i]!.push(r.point.heapPct);
    if (typeof r.point.queuedCount === "number") queue[i]!.set(r.member, r.point.queuedCount);
  }
  return {
    heapPct: heap.map((v) => (v.length ? round(v.reduce((a, b) => a + b, 0) / v.length) : null)),
    queuedCount: queue.map((m) => (m.size ? [...m.values()].reduce((a, b) => a + b, 0) : null)),
  };
}

