// pages-rethink §10.1 ⑰ (saving tokens): the check-up's brief. Each check-up used to spend 20–49 model turns, most of
// them describe and look calls whose answers were sent again with every later turn. The brief is what those first calls
// gathered, compact, built by the Deployer: in the first message of the sessions it opens (analyses.ts) and from
// describe {brief: true} for the scheduled one (whose first message OMA keeps fixed). With it the agent records most
// services without another describe or look, and looks only for what the brief does not say.
//
// The model's state (topology unchanged or not) is what lets a check-up skip rebuilding the business model: the
// Deployer keeps the canvas' fingerprint (flowcounts.topologyFingerprint, structure only) with each published revision;
// when the canvas still has it and no person gave feedback on a business since, the brief says so and the check-up only
// looks at the machine and the businesses' health. The gate and the skeleton are not touched by any of this.
//
// A hand-over to another managed service is the exception (engine test 2026-11-23): a model published while the other
// side had no model yet (or could not be seen) keeps such a hand-over as an external source or system, and the canvas
// never changes to say otherwise. So the model is rebuilt too when the canvas has an S2S link with another service
// (the skeleton's edges) that the model does not carry as S2S on that group, and that service published a model after
// this one. Once the model carries the link, or while the other side publishes nothing new, it is left alone.

import type { Store } from "../store.ts";
import { topologyFingerprint, type Topology } from "./flowcounts.ts";
import { clip } from "./look-summary.ts";
import { skeletonOf, type Skeleton } from "./skeleton.ts";

export interface ModelState {
  revision: number; publishedAt: string;
  /** unchanged: the canvas has the fingerprint it had when the revision was published; unknown: no snapshot then or now. */
  topology: "unchanged" | "changed" | "unknown";
  fingerprint: { published: string | null; now: string | null };
  /** A person's feedback on a business of this service since the revision ("these are two flows", "not right"). */
  feedback: { flow: string | null; kind: string; at: string; text: string | null }[];
  /** S2S links with another managed service the canvas has and the model does not carry, that service's model being newer. */
  handovers: StaleHandover[];
  /** Whether this check-up should rebuild the business model (look kind model → run_model → publish_model). */
  rebuild: boolean;
  note: string;
}

export interface StaleHandover { peer: string; group: string; side: "in" | "out" }

interface ModelLike { publishedAt: string; model: { segments: { group: { id: string }; entries: { channel: { type: string } }[]; exits: { channel: { type: string } }[] }[] } }

/** The canvas' S2S links between this service and another (sk.edges) that the published model does not carry as S2S on the
 *  group's side (an entry for what comes in, an exit for what goes out), counted only when the other service published a
 *  model after this one (else nothing new is known about that side). */
export function staleHandovers(sk: Skeleton, service: string, m: ModelLike, peerPublishedAt: (service: string) => string | null): StaleHandover[] {
  const segs = new Map([...sk.flows.flatMap((f) => f.segments), ...sk.shared].map((s) => [s.id, s]));
  const out = new Map<string, StaleHandover>();
  for (const e of sk.edges) {
    if (e.kind !== "s2s") continue;
    const a = segs.get(e.from), b = segs.get(e.to);
    if (!a || !b || a.service === b.service) continue;
    const pair = a.service === service ? { mine: a, peer: b, side: "out" as const } : b.service === service ? { mine: b, peer: a, side: "in" as const } : null;
    if (!pair) continue;
    const peerAt = peerPublishedAt(pair.peer.service);
    if (!peerAt || peerAt <= m.publishedAt) continue;
    const carried = m.model.segments.filter((s) => s.group.id === pair.mine.group.id)
      .some((s) => (pair.side === "in" ? s.entries : s.exits).some((x) => x.channel?.type === "s2s"));
    if (!carried) out.set(`${pair.peer.service}\0${pair.mine.group.id}\0${pair.side}`, { peer: pair.peer.service, group: pair.mine.group.name, side: pair.side });
  }
  return [...out.values()];
}

/** The fingerprint the canvas had when revision m was published: kept with it, or (older rows) the snapshot then. */
export function publishedFingerprint(store: Store, service: string, m: { topologyFp?: string | null; publishedAt: string }): string | null {
  if (m.topologyFp) return m.topologyFp;
  return topologyFingerprint(store.latestTopology(service, m.publishedAt)?.body as Topology | undefined);
}

export function modelState(store: Store, service: string, sk?: Skeleton): ModelState | null {
  const m = store.flowModel(service);
  if (!m) return null;
  const published = publishedFingerprint(store, service, m);
  const now = topologyFingerprint(store.latestTopology(service)?.body as Topology | undefined);
  const topology = !published || !now ? "unknown" : published === now ? "unchanged" : "changed";
  const feedback = store.flowChanges({ service, limit: 200 })
    .filter((c) => (c.kind === "split-asked" || c.kind === "not-right") && c.at > m.publishedAt)
    .map((c) => ({ flow: c.flow, kind: c.kind, at: c.at, text: clip(c.text, 200) }));
  const handovers = staleHandovers(sk ?? skeletonOf(store, new Date()), service, m as ModelLike, (s) => store.flowModel(s)?.publishedAt ?? null);
  const rebuild = topology !== "unchanged" || feedback.length > 0 || handovers.length > 0;
  const note = !rebuild
    ? `拓扑未变，沿用已发布模型 r${m.revision}: the canvas has not changed since revision ${m.revision} and nobody gave feedback since. Do not rebuild the business model (no look kind model, run_model or publish_model for it); look at the machine and the businesses' health only.`
    : topology === "unchanged" && !feedback.length
      ? `拓扑未变，但跨服务交接要更新: the canvas has S2S links with ${[...new Set(handovers.map((h) => h.peer))].join(", ")} that revision ${m.revision} does not carry as S2S (${handovers.map((h) => `${h.group} ${h.side}`).join("; ")}), and that service published a model since. Rebuild the model for these hand-overs only (from: "current", changes → run_model → publish_model).`
    : feedback.length
      ? `A person gave feedback on ${feedback.length} business(es) since revision ${m.revision}: rebuild the model for it (look kind model → run_model → publish_model).`
      : topology === "changed"
        ? `The canvas changed since revision ${m.revision} (fingerprint ${published} → ${now}): rebuild the model (look kind model → run_model → publish_model).`
        : `Whether the canvas changed since revision ${m.revision} is not known (no canvas snapshot from then or now): check the model as the gaps say.`;
  return { revision: m.revision, publishedAt: m.publishedAt, topology, fingerprint: { published, now }, feedback, handovers, rebuild, note };
}
