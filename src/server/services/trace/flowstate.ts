// S37 step 6 (§4.2.0 T11): where stuck data waits, from what the collector already has — the newest back pressure
// reading of the service (the fullest queues with their source and destination, and the processors not running;
// read every few minutes by the service executor). Nothing is asked of NiFi here: a part the reading does not have
// (the connection is not among the fullest, an executor before 0.9.4 that lists no processor states) is said so.

import type { Store } from "../../store.ts";
import type { StuckAsk, StuckContext } from "./engine.ts";

type Any = Record<string, any>;
/** How far back the reading is looked for (3 of the longest interval, as the status page does). */
const LOOKBACK_MS = 3 * 3600_000;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export function stuckContextFrom(store: Store, now: () => Date = () => new Date()) {
  return (q: StuckAsk): StuckContext => {
    const got = store.latestServiceBackpressure(q.service, new Date(now().getTime() - LOOKBACK_MS).toISOString());
    if (!got) return { at: null, queue: null, downstream: null, notes: [`The collector has no back pressure reading of ${q.service} from the last 3 hours: the queue and whether ${q.to.name ?? q.to.id} runs are not known.`] };
    const b = got.backpressure as Any;
    const at = typeof b.at === "string" ? b.at : got.at;
    const top = (Array.isArray(b.top) ? b.top : []) as Any[];
    const notes: string[] = [];
    const into = (c: Any) => c.destinationId === q.to.id || (!c.destinationId && q.to.name && c.destinationName === q.to.name);
    const conn = top.find((c) => into(c) && (!q.from || c.sourceId === q.from.id || (!c.sourceId && q.from.name && c.sourceName === q.from.name))) ?? top.find(into);
    let queue: StuckContext["queue"] = null;
    if (conn) {
      const percent = Math.max(num(conn.percentUseCount) ?? 0, num(conn.percentUseBytes) ?? 0);
      queue = { name: conn.name ?? null, ...(num(conn.flowFilesQueued) !== undefined ? { flowFilesQueued: num(conn.flowFilesQueued) } : {}), ...(num(conn.bytesQueued) !== undefined ? { bytesQueued: num(conn.bytesQueued) } : {}), percent, backpressure: percent >= 100 };
    } else notes.push(top.length
      ? `The connection into ${q.to.name ?? q.to.id} is not among the ${top.length} fullest queues the collector keeps (as of ${at}): its queue is small or empty.`
      : `No queue of ${q.service} was above 0 % of its back pressure threshold (as of ${at}): the connection into ${q.to.name ?? q.to.id} holds little or nothing.`);
    let downstream: StuckContext["downstream"] = null;
    if (q.to.kind === "processor") {
      if (Array.isArray(b.notRunning)) {
        const off = (b.notRunning as Any[]).find((p) => p.id === q.to.id);
        downstream = { id: q.to.id, name: off?.name ?? q.to.name ?? null, running: !off, runStatus: off?.runStatus ?? "Running" };
      } else {
        downstream = { id: q.to.id, name: q.to.name ?? null, running: null };
        notes.push("The service executor does not report processor states (it is older than 0.9.4): whether the component runs is not known.");
      }
    }
    return { at, queue, downstream, notes };
  };
}
