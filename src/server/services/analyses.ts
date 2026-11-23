// pages-rethink A1, §10.2 step 5: starting the AI's analyses. The rules light the lamps every minute without the AI;
// an analysis is the check-up agent (agents/service-checkup.md, its dpc_ key) looking at one or more services and
// writing back with record. Each analysis is first a running row (store.addAnalysis), then one OMA session is opened
// for the services of one start (the first message names each service's analysis id and why it was started), and
// poll() follows the session until the agent has ended its turn or the time is up (then the rows still running fail).
//
// What starts one: the 4-hourly check-up (OMA agent-schedules, checkup-schedule.ts; its session is opened by OMA, so
// its analyses are created by record, todos.ts), a machine light turning red (checkAll's onTurn), a person opening a
// page while a service is not green and its analysis is out of date (at most once a service an hour), Check now (one
// service, or a round over all), and a person's feedback on the flows page (split, not right).
// DEPLOYER_CHECKUP_AUTO=off turns the automatic ones off (schedule, machine-red, user-visit); a person's still start.

import type { OmaSessions } from "../oma.ts";
import type { AnalysisRecord, FlowRecord, Store } from "../store.ts";
import type { AnalysisTrigger, AnalysisView, Light, Lights } from "./ops-types.ts";
import { openTurn, pollTurn, TURN_TIMEOUT_MS } from "./oma-turn.ts";
import type { MachineTurn } from "./rules.ts";
import { analysisView, STALE_MS } from "./todos.ts";

/** user-visit: at most one start a service an hour (A1, §10.3), whatever the pages' 15-second polling does. */
export const VISIT_GAP_MS = STALE_MS;
/** A running row whose session never opened (the Deployer restarted while opening it) fails after this. */
const OPEN_GRACE_MS = 2 * 60_000;
/** A session over several services gets more time: 10 minutes, plus 3 for each further service, at most an hour. */
const turnTimeout = (services: number) => Math.min(60 * 60_000, TURN_TIMEOUT_MS + Math.max(0, services - 1) * 3 * 60_000);

export interface AnalysisDeps {
  store: Store;
  /** Sessions of the check-up agent (DEPLOYER_OMA_CHECKUP_AGENT); none: analyses cannot be started. */
  oma?: Pick<OmaSessions, "open" | "events">;
  /** The two lights now (kept with the row, to tell later whether it is out of date). */
  lights: (service: string, now: Date) => Lights;
  /** Every registered service's id. */
  services: () => string[];
  /** DEPLOYER_CHECKUP_AUTO: false starts nothing by itself (no machine-red, no user-visit); Check now and flows feedback still do. Default true. */
  auto?: boolean;
  now?: () => Date;
}

/** A person's feedback on a business (§10.2.2 #7 split, not-right). */
export interface Feedback { flow: string; name: string; kind: "split" | "not-right"; note: string | null; by: string }

export class AnalysisError extends Error {
  readonly status: 409 | 503;
  readonly code: string;
  readonly analysis: AnalysisView | null;
  readonly run: string | null;
  constructor(status: 409 | 503, code: string, message: string, extra: { analysis?: AnalysisView; run?: string | null } = {}) {
    super(message); this.status = status; this.code = code; this.analysis = extra.analysis ?? null; this.run = extra.run ?? null;
  }
}

/** A service card or page as the visit check needs it. */
export interface Visited { service: string; machine: Light; business: Light; analysis: AnalysisView | null }

const green = (v: Pick<Visited, "machine" | "business">) => v.machine === "healthy" && v.business === "healthy";

/** ⑰: each service's check-up brief (ops-routes briefs, checkup-brief.ts), for the first message. */
export type BriefSource = (services: string[], at: Date) => Promise<unknown[]>;

/** The first message: why, each service's analysis id (agents/service-checkup.md "The first message") and, when
 *  given, each service's brief (⑰), so the agent does not start with describe and look. */
export function analysisMessage(trigger: AnalysisTrigger, rows: Pick<AnalysisRecord, "id" | "service">[], reasons: Record<string, string> = {}, feedback?: Feedback, briefs?: unknown[]): string {
  const why: Record<AnalysisTrigger, string> = {
    "schedule": "The scheduled check-up.",
    "machine-red": "The machine light turned red.",
    "user-visit": "A person opened the page while the service is not green and its last analysis is out of date.",
    "check-now": "A person pressed Look again now.",
    "flows-feedback": "A person gave feedback on a business on the flows page.",
  };
  const body = {
    trigger,
    services: rows.map((r) => ({ service: r.service, analysis_id: r.id, reason: reasons[r.service] ?? why[trigger] })),
    ...(feedback ? { feedback: { flow: feedback.flow, name: feedback.name, kind: feedback.kind === "split" ? "These are two flows" : "Not right", note: feedback.note, by: feedback.by } } : {}),
  };
  return [
    `Deployer analysis (trigger: ${trigger}). Look at each service below and record it once, with its analysis_id and analysis.trigger "${trigger}".`,
    ...(feedback ? ["The person's feedback is about the business named below: fix the model (look kind model → run_model → publish_model) or explain in the analysis why it stays as it is."] : []),
    "```json", JSON.stringify(body, null, 1), "```",
    ...(briefs?.length ? [
      "Each service's brief, built by the Deployer as this check-up started (what describe {brief: true} gives): work from it, and look only for what it does not say.",
      "```json", JSON.stringify(briefs), "```",
    ] : []),
  ].join("\n");
}

export class Analyses {
  private d: AnalysisDeps;
  /** Rows whose session is being opened (not failed by poll as "never opened"). */
  private opening = new Set<number>();
  /** The newest user-visit start of each service (ms), besides what the table says. */
  private visits = new Map<string, number>();
  private polling = false;
  private brief: BriefSource | null = null;

  constructor(d: AnalysisDeps) { this.d = d; }

  /** ⑰: the briefs for the first message (the app sets it once its routes are mounted). */
  useBrief(source: BriefSource) { this.brief = source; }

  get configured(): boolean { return Boolean(this.d.oma); }
  /** Whether analyses start by themselves (machine-red, user-visit). */
  get auto(): boolean { return this.d.auto !== false; }
  private now() { return this.d.now?.() ?? new Date(); }

  /** The service's running analysis, if any. */
  running(service: string): AnalysisRecord | null { return this.d.store.analyses(service, 5).find((a) => a.state === "running") ?? null; }

  view(a: AnalysisRecord): AnalysisView { return analysisView(a, this.now(), this.d.lights(a.service, this.now())); }

  /** One session over the services: a running row each; a service already running one is left out. None without OMA. */
  begin(services: string[], trigger: AnalysisTrigger, by: string, o: { run?: string; reasons?: Record<string, string>; feedback?: Feedback } = {}): AnalysisRecord[] {
    if (!this.d.oma) return [];
    const at = this.now();
    const fresh = [...new Set(services)].filter((s) => !this.running(s));
    if (!fresh.length) return [];
    const rows = fresh.map((service) => {
      const l = this.d.lights(service, at);
      const id = this.d.store.addAnalysis({ service, run: o.run ?? null, trigger, state: "running", session: null, requestedBy: by, startedAt: at.toISOString(), finishedAt: null, machineLight: l.machine, businessLight: l.business, body: null, error: null });
      this.opening.add(id);
      return this.d.store.analysis(id)!;
    });
    void this.open(rows, trigger, o.reasons, o.feedback);
    return rows;
  }

  private async open(rows: AnalysisRecord[], trigger: AnalysisTrigger, reasons?: Record<string, string>, feedback?: Feedback) {
    const title = `Service analysis · ${trigger} · ${rows.map((r) => r.service).join(", ")}`;
    try {
      // A brief that cannot be built leaves the message as it was: the agent then starts with describe.
      let briefs: unknown[] | undefined;
      if (this.brief) { try { briefs = await this.brief(rows.map((r) => r.service), this.now()); } catch { briefs = undefined; } }
      const r = await openTurn(this.d.oma!, title, `analysis-${rows[0]!.id}`, analysisMessage(trigger, rows, reasons, feedback, briefs));
      for (const a of rows) {
        const cur = this.d.store.analysis(a.id);
        if (!cur || cur.state !== "running") continue;   // recorded already
        if ("error" in r) this.d.store.setAnalysis({ id: a.id, state: "failed", session: null, finishedAt: this.now().toISOString(), body: null, error: r.error });
        else this.d.store.setAnalysis({ id: a.id, state: "running", session: r.session, finishedAt: null, body: null, error: null });
      }
    } finally { for (const a of rows) this.opening.delete(a.id); }
  }

  /** §10.2.2 #3: Look again now on one service. 409 while one runs (with it), 503 without the check-up agent. */
  checkNow(service: string, by: string): AnalysisRecord {
    const running = this.running(service);
    if (running) throw new AnalysisError(409, "analysis/running", `An analysis of ${service} is running.`, { analysis: this.view(running) });
    if (!this.configured) throw new AnalysisError(503, "analysis/unavailable", "The AI check-up is not configured (DEPLOYER_OMA_CHECKUP_AGENT and the OMA connection).");
    return this.begin([service], "check-now", by)[0]!;
  }

  /** §10.2.2 #4: the overview's Check now, one round (run) over every service in one session. */
  round(by: string): { run: string; services: string[] } {
    const last = this.d.store.analysisRun();
    if (last.some((a) => a.state === "running")) throw new AnalysisError(409, "analysis/running", "A check-up round is running.", { run: last[0]!.run });
    if (!this.configured) throw new AnalysisError(503, "analysis/unavailable", "The AI check-up is not configured (DEPLOYER_OMA_CHECKUP_AGENT and the OMA connection).");
    const services = this.d.services();
    if (!services.length) throw new AnalysisError(409, "analysis/no-services", "No managed services to look at.");
    const run = `run-${this.now().toISOString().replace(/[-:.]/g, "")}-${Math.random().toString(36).slice(2, 6)}`;
    const rows = this.begin(services, "check-now", by, { run });
    if (!rows.length) throw new AnalysisError(409, "analysis/running", "Every service has an analysis running.");
    return { run, services: rows.map((r) => r.service) };
  }

  /** checkAll's onTurn: a machine light turned red, an analysis now (unless one runs). */
  machineTurn(turn: MachineTurn): AnalysisRecord | null {
    if (turn.kind !== "machine-red" || !this.auto) return null;
    return this.begin([turn.service], "machine-red", "deployer", { reasons: { [turn.service]: `The machine light turned red (${turn.from} → ${turn.to}): ${turn.text}` } })[0] ?? null;
  }

  /** Whether a visit should start an analysis of this service: not green, out of date, none in the last hour. */
  private due(v: Visited, at: number): boolean {
    if (green(v)) return false;
    if (v.analysis && (v.analysis.state === "running" || !v.analysis.stale)) return false;
    if (this.running(v.service)) return false;
    const last = Math.max(this.visits.get(v.service) ?? 0, ...this.d.store.analyses(v.service, 20).filter((a) => a.trigger === "user-visit").map((a) => Date.parse(a.startedAt)));
    return at - last >= VISIT_GAP_MS;
  }

  /** A person opened pages showing these services (the overview: all of them, a service page: one): one session for those due. */
  visit(seen: Visited[], by: string): AnalysisRecord[] {
    if (!this.configured || !this.auto) return [];
    const at = this.now().getTime();
    const due = seen.filter((v) => this.due(v, at));
    for (const v of due) this.visits.set(v.service, at);
    return due.length ? this.begin(due.map((v) => v.service), "user-visit", by) : [];
  }

  /** §10.2.2 #7: These are two flows / Not right: the services the business runs in are looked at again with the feedback. */
  feedback(flow: FlowRecord, services: string[], kind: "split" | "not-right", note: string | null, by: string): AnalysisRecord[] {
    return this.begin(services, "flows-feedback", by, { feedback: { flow: flow.id, name: flow.name, kind, note, by } });
  }

  /** Follows the open sessions: a turn that ended without a record, an error or no answer in time fails its rows. */
  async poll(): Promise<void> {
    if (this.polling || !this.d.oma) return;
    this.polling = true;
    try {
      const at = this.now();
      const bySession = new Map<string, AnalysisRecord[]>();
      for (const a of this.d.store.runningAnalyses()) {
        if (a.session) { bySession.set(a.session, [...(bySession.get(a.session) ?? []), a]); continue; }
        if (!this.opening.has(a.id) && at.getTime() - Date.parse(a.startedAt) > OPEN_GRACE_MS) this.fail(a, "The AI session did not open.");
      }
      for (const [session, rows] of bySession) {
        const startedAt = rows.reduce((x, y) => (x.startedAt <= y.startedAt ? x : y)).startedAt;
        const timeout = turnTimeout(rows.length);
        const r = await pollTurn(this.d.oma, session, 1, startedAt, at.getTime(), timeout);
        if (r.state === "running") continue;
        const error = r.state === "failed" ? r.error : "The AI ended without recording this service's analysis.";
        for (const a of rows) { const cur = this.d.store.analysis(a.id); if (cur?.state === "running") this.fail(cur, error); }
      }
    } finally { this.polling = false; }
  }

  private fail(a: AnalysisRecord, error: string) {
    this.d.store.setAnalysis({ id: a.id, state: "failed", session: a.session, finishedAt: this.now().toISOString(), body: null, error });
  }
}

/** The daily brief waits for the morning check-up: every service has a schedule analysis that ended since `since`. */
export function checkupDone(store: Store, services: string[], since: Date): boolean {
  const from = since.toISOString();
  return services.every((s) => store.analyses(s, 20).some((a) => a.trigger === "schedule" && a.state !== "running" && a.startedAt >= from));
}
