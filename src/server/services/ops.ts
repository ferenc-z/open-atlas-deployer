// S37 step 10 (pages-rethink §3, "cross-service layer"): the ops desk. Every registered service's to-dos, from the same
// health() the Status tab and get_service_health use, merged into one queue worst first, and a one-sentence verdict per
// service (also built from health(); nothing is worked out again here). The daily brief reads the same body.

import type { Store } from "../store.ts";
import { health, type ServiceHealth, type Todo } from "./rules.ts";

type Executor = Parameters<typeof health>[1];

export interface OpsService { id: string; kind: "standalone" | "cluster"; environment: string; verdict: ServiceHealth["verdict"]; sentence: string; counts: ServiceHealth["counts"]; asOf: string }
export interface OpsTodo extends Todo { service: string; environment: string }
export interface OpsDesk { services: OpsService[]; queue: OpsTodo[] }

const ORDER = { CRIT: 0, WARN: 1, INFO: 2 } as const;

/** One sentence: the verdict and, when something needs doing, the worst to-do. */
export function sentenceOf(h: ServiceHealth): string {
  if (!h.todos.length) return "Normal. Nothing needs doing.";
  const first = h.todos[0]!;
  const more = h.todos.length - 1;
  const word = h.verdict === "critical" ? "Critical" : "Needs attention";
  return `${word}: ${first.memberLabel ? `${first.memberLabel}: ` : ""}${first.cause}${more > 0 ? ` (+${more} more)` : ""}`;
}

export function opsDesk(store: Store, executor: Executor, now: Date = new Date()): OpsDesk {
  const services: OpsService[] = [];
  const queue: OpsTodo[] = [];
  for (const s of [...store.clusters(), ...store.standalones()]) {
    const h = health(store, executor, s.id, now);
    if (!h) continue;
    services.push({ id: s.id, kind: s.kind, environment: s.environment, verdict: h.verdict, sentence: sentenceOf(h), counts: h.counts, asOf: h.asOf });
    for (const t of h.todos) queue.push({ ...t, service: s.id, environment: s.environment });
  }
  const VERDICT = { critical: 0, attention: 1, ok: 2 } as const;
  services.sort((a, b) => VERDICT[a.verdict] - VERDICT[b.verdict] || (a.id < b.id ? -1 : 1));
  queue.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || (a.since < b.since ? -1 : a.since > b.since ? 1 : 0) || (a.service < b.service ? -1 : 1));
  return { services, queue };
}
