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

import type { Store } from "../store.ts";
import { topologyFingerprint, type Topology } from "./flowcounts.ts";
import { clip } from "./look-summary.ts";

export interface ModelState {
  revision: number; publishedAt: string;
  /** unchanged: the canvas has the fingerprint it had when the revision was published; unknown: no snapshot then or now. */
  topology: "unchanged" | "changed" | "unknown";
  fingerprint: { published: string | null; now: string | null };
  /** A person's feedback on a business of this service since the revision ("these are two flows", "not right"). */
  feedback: { flow: string | null; kind: string; at: string; text: string | null }[];
  /** Whether this check-up should rebuild the business model (look kind model → run_model → publish_model). */
  rebuild: boolean;
  note: string;
}

/** The fingerprint the canvas had when revision m was published: kept with it, or (older rows) the snapshot then. */
export function publishedFingerprint(store: Store, service: string, m: { topologyFp?: string | null; publishedAt: string }): string | null {
  if (m.topologyFp) return m.topologyFp;
  return topologyFingerprint(store.latestTopology(service, m.publishedAt)?.body as Topology | undefined);
}

export function modelState(store: Store, service: string): ModelState | null {
  const m = store.flowModel(service);
  if (!m) return null;
  const published = publishedFingerprint(store, service, m);
  const now = topologyFingerprint(store.latestTopology(service)?.body as Topology | undefined);
  const topology = !published || !now ? "unknown" : published === now ? "unchanged" : "changed";
  const feedback = store.flowChanges({ service, limit: 200 })
    .filter((c) => (c.kind === "split-asked" || c.kind === "not-right") && c.at > m.publishedAt)
    .map((c) => ({ flow: c.flow, kind: c.kind, at: c.at, text: clip(c.text, 200) }));
  const rebuild = topology !== "unchanged" || feedback.length > 0;
  const note = !rebuild
    ? `拓扑未变，沿用已发布模型 r${m.revision}: the canvas has not changed since revision ${m.revision} and nobody gave feedback since. Do not rebuild the business model (no look kind model, run_model or publish_model for it); look at the machine and the businesses' health only.`
    : feedback.length
      ? `A person gave feedback on ${feedback.length} business(es) since revision ${m.revision}: rebuild the model for it (look kind model → run_model → publish_model).`
      : topology === "changed"
        ? `The canvas changed since revision ${m.revision} (fingerprint ${published} → ${now}): rebuild the model (look kind model → run_model → publish_model).`
        : `Whether the canvas changed since revision ${m.revision} is not known (no canvas snapshot from then or now): check the model as the gaps say.`;
  return { revision: m.revision, publishedAt: m.publishedAt, topology, fingerprint: { published, now }, feedback, rebuild, note };
}
