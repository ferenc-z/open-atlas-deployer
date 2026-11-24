// pages-rethink §10.1 ⑰ (saving tokens): the check-up's brief. Each check-up used to spend 20–49 model turns, most of
// them describe and look calls whose answers were sent again with every later turn. The brief is what those first calls
// gathered, compact, built by the Deployer: in the first message of the sessions it opens (analyses.ts) and from
// describe {brief: true} for the scheduled one (whose first message OMA keeps fixed). With it the agent records most
// services without another describe or look, and looks only for what the brief does not say.
//
// S39 step 7: the check-up no longer builds the business model (businesses are registered by their owners, not found by
// the AI), so the brief carries no skeleton draft, no replay of one and no "rebuild or not". What it keeps of the model's
// state is whether the canvas changed where something is registered since the revision was published: the Deployer has
// opened a to-do for the owner then (registered.ts canvasChangeTodos); the check-up only says it in the analysis.
//
// The canvas' fingerprint (flowcounts.topologyFingerprint, structure only) is kept with each published revision; with
// the registration switch on, only the registered groups' part of the canvas is compared (registered.ts).

import type { Store } from "../store.ts";
import { topologyFingerprint, type Topology } from "./flowcounts.ts";
import { canvasChanges, registeredFingerprint, registeredGroupIds } from "./registered.ts";
import { registeredGroupsOn } from "./watch.ts";

export interface ModelState {
  revision: number; publishedAt: string;
  /** unchanged: the canvas (the registered groups' part of it, with the switch on) has the structure it had when the revision was published; unknown: no snapshot then or now. */
  topology: "unchanged" | "changed" | "unknown";
  fingerprint: { published: string | null; now: string | null };
  /** Switch on: the registered businesses and modules whose groups changed (a to-do for the owner is open). */
  changed: { owner: string; name: string; groups: string[] }[];
  note: string;
}

/** The fingerprint the canvas had when revision m was published: kept with it, or (older rows) the snapshot then. */
export function publishedFingerprint(store: Store, service: string, m: { topologyFp?: string | null; publishedAt: string }): string | null {
  if (m.topologyFp) return m.topologyFp;
  return topologyFingerprint(store.latestTopology(service, m.publishedAt)?.body as Topology | undefined);
}

export function modelState(store: Store, service: string, on = registeredGroupsOn()): ModelState | null {
  const m = store.flowModel(service);
  if (!m) return null;
  let published: string | null, now: string | null;
  if (on) {
    const ids = registeredGroupIds(store, service);
    published = registeredFingerprint(store.latestTopology(service, m.publishedAt)?.body as Topology | undefined, ids);
    now = registeredFingerprint(store.latestTopology(service)?.body as Topology | undefined, ids);
  } else {
    published = publishedFingerprint(store, service, m);
    now = topologyFingerprint(store.latestTopology(service)?.body as Topology | undefined);
  }
  const changed = on ? canvasChanges(store, service).map((c) => ({ owner: c.owner, name: c.name, groups: c.groups.map((g) => g.text) })) : [];
  const topology = changed.length ? "changed" : !published || !now ? "unknown" : published === now ? "unchanged" : "changed";
  const note = topology === "unchanged"
    ? `拓扑未变，沿用已发布模型 r${m.revision}: the canvas has not changed since revision ${m.revision}. Do not build or publish a business model; look at the machine and the businesses' health only.`
    : topology === "changed"
      ? `The canvas changed since revision ${m.revision}${changed.length ? ` where something is registered (${changed.map((c) => c.name).slice(0, 5).join(", ")}); the Deployer opened a to-do for its owner to confirm` : ""}. Do not build or publish a business model: say it in the analysis and leave the to-do to the owner.`
      : `Whether the canvas changed since revision ${m.revision} is not known (no canvas snapshot from then or now).`;
  return { revision: m.revision, publishedAt: m.publishedAt, topology, fingerprint: { published, now }, changed, note };
}
