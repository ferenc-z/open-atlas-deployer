// S39 step 8: what the Businesses, Register and business-detail pages read from the registration API
// (business-registration.md 7.5). Written to the contract, ahead of the server: the preview shape is 7.5's `Preview`; the
// list and the registration block of the detail are what the pages need and are not in 7.5 (see the report of step 8).

import type { Anomaly, FlowDetail, Light } from "../server/services/ops-types.ts";

// ---- 7.5 `Preview` (the right side of the Register page) ----

export type EdgeKindP = "link" | "s2s" | "mq" | "schedule" | "shared-entry" | "shared-exit" | "declared";
export type GapKind = "disconnected" | "exit-unregistered" | "entry-unregistered" | "s2s-unpaired" | "mq-unpaired";

export interface PreviewGroup { ref: string; service: string; group: { id: string; name: string; path?: string }; link?: string; state: "ok" | "missing" | "taken" | "nested"; takenBy?: { flow: string; name: string } }
export interface PreviewSegment { id: string; service: string; group: { id: string; name: string }; slice: string; role: "segment" | "shared"; module?: string; origin?: string; steps?: string[]; link?: string }
export interface PreviewEdge { from: string; to: string; kind: EdgeKindP; via?: string; basis?: string; inferred?: boolean; quote?: string; handoff?: string }
export interface PreviewGap { id: string; kind: GapKind; segment: string; text: string; neighbor?: { service: string; group: { id: string; name: string }; link?: string }; candidates?: { component: string; name: string }[] }
export interface Preview {
  name?: string;
  groups: PreviewGroup[];
  segments: PreviewSegment[];
  /** Columns from upstream to downstream; the segments in one column run in parallel. */
  layers: string[][];
  edges: PreviewEdge[];
  entries: { segment: string; label: string; channel?: string }[];
  exits: { segment: string; label: string; component?: string }[];
  gaps: PreviewGap[];
  notes?: string[];
}

/** A link the person pasted; `service` is the hint for an address Deployer cannot place (7.6). */
export type LinkInput = string | { link: string; service?: string };

/** 7.5 `declare-handoff` (also the `handoffs` of preview and commit). */
export interface HandoffInput {
  from: { service: string; group: string; component: string; relationship?: string };
  to: { service: string; group: string } | { system: string };
  quote: string;
}

export interface Revisions { service: string; revision: number }
export interface CommitResult { flow: string; name: string; revisions: Revisions[]; verdict: "published"; preview: Preview }

// ---- The Businesses page ----

export interface BusinessRow {
  id: string; name: string; light: Light; sentence: string;
  /** What lit it (the first problem's kind), for the pill beside the light. */
  anomalies: Anomaly[];
  /** The services it runs on, upstream first. */
  services: string[];
  groupCount: number;
  /** How many handoffs the owner described. */
  handoffCount: number;
  registeredBy: string;
  /** The principal ids that count as "mine" (the page compares them with the signed-in person). */
  registeredById?: string;
  registeredAt: string;
}
export interface SharedModuleRow {
  id: string; name: string; service: string;
  /** "In: … · Out: …" in the owner's words, written by the server from the entries and exits. */
  ports: string;
  usedBy: { id: string; name: string }[];
  light: Light;
}
export interface BusinessList { businesses: BusinessRow[]; shared: SharedModuleRow[] }

// ---- The business detail's registration block ----

export interface RegisteredGroup { service: string; id: string; name: string; path?: string; how: string; nifiUrl?: string | null }
export interface RegistrationInfo {
  by: string; at: string;
  groups: RegisteredGroup[];
  shared: { id: string; name: string }[];
  /** Registration history, newest first; the server merges the per-service rows of one action (7.7 item 8). */
  changes: { at: string; by: string; text: string; quote?: string }[];
}
/** FlowDetail (the existing business detail) plus what registration adds. */
export type BusinessDetail = FlowDetail & { registration?: RegistrationInfo };
