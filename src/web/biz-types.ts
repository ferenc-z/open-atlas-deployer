// S39 step 8: what the Businesses, Register and business-detail pages read from the registration API
// (business-registration.md 7.5, as main returns it: server/services/chain.ts Preview, registration-routes.ts, register-chain.ts moduleViews).

import type { Anomaly, FlowDetail, Light } from "../server/services/ops-types.ts";

// ---- 7.5 `Preview` (the right side of the Register page) ----

export type EdgeKindP = "link" | "s2s" | "mq" | "schedule" | "shared-entry" | "shared-exit" | "declared";
export type GapKind = "disconnected" | "exit-unregistered" | "entry-unregistered" | "s2s-unpaired" | "mq-unpaired" | "worker-unplaced" | "group-missing";

/** A group of the preview: `missing` is one NiFi no longer has (a group somebody else holds is refused when it is added, not listed here). */
export interface PreviewGroup { ref: string; service: string; group: { id: string; name: string; path?: string }; link?: string | null; state: "ok" | "missing" }
export interface PreviewSegment { id: string; service: string; group: { id: string; name: string }; slice: string; role: "segment" | "shared"; module?: string; origin?: string; steps?: string[]; link?: string | null }
export interface PreviewEdge { from: string; to: string; kind: EdgeKindP; via?: string; basis?: string; inferred?: boolean; quote?: string; handoff?: string }
export interface PreviewGap {
  id: string; kind: GapKind; segment: string | null; text: string;
  neighbor?: { service: string; group?: { id: string; name: string }; port?: string; link?: string | null };
  component?: string;
  candidates?: { component: string; name: string }[];
  /** disconnected: the segments of the part that is not joined to the rest. */
  segments?: string[];
  /** worker-unplaced: which worker (place-worker takes schedule and name). */
  worker?: { schedule: string; scheduleName: string; seq: number; name: string };
  /** worker-unplaced: groups it may be in (never placed by code: the owner says). */
  places?: { service: string; group: { id: string; name: string }; basis: "processor-name" | "group-name"; processor?: string }[];
}
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

/** `register declare-handoff` (the `handoffs` of a draft). */
export interface HandoffInput {
  from: { service: string; group: string; component: string; relationship?: string };
  to: { service: string; group: string } | { system: string };
  quote: string;
}

// ---- A registration draft (GET registrations/drafts/<id>), the page's and the AI's shared state ----

export interface RegDraftGroup { service: string; group: { id: string; name: string; path: string }; link: string | null; addedBy: string; addedAt: string }
export interface RegDraftHandoff extends HandoffInput { id: string; declaredBy: string; declaredAt: string }
export interface RegDraft {
  draft: string;
  /** The registered business this draft changes; null for a new one. */
  flow: string | null;
  createdBy: string; name: string | null;
  groups: RegDraftGroup[]; handoffs: RegDraftHandoff[];
  places: { schedule: string; worker: string; service: string | null; group: string | null; quote: string }[];
  /** The last preview the chaining made; null until the AI (or the page) asks for one. */
  preview: Preview | null;
  createdAt: string; updatedAt: string;
}

export interface Revisions { service: string; revision: number }
/** What `commit` answers (a draft's: flow, name, revisions, the preview). */
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
/** GET registrations/modules: one shared module. */
export interface ModuleView {
  id: string; name: string;
  groups: { service: string; group: { id: string; name: string; path?: string | null }; link?: string | null }[];
  segments: { service: string; segment: string; revision: number }[];
  entries: { id: string; text: string }[];
  exits: { id: string; text: string; when?: unknown }[];
  health: { light: "ok" | "idle" | "attention" | "unknown"; minutes: number; flowfilesIn: number; flowfilesOut: number; text: string };
  createdBy: string; updatedAt: string;
}
/** GET registrations/modules/<id> adds who is joined to it now (the server reads its group from NiFi for this). */
export type ModuleDetail = ModuleView & { users: { flow: string; name: string; via: string[] }[] };
export interface SharedModuleRow {
  id: string; name: string; service: string;
  /** "In: … · Out: …" in the owner's words, written from the entries and exits. */
  ports: string;
  /** undefined while the server is still reading who uses it. */
  usedBy?: { id: string; name: string }[];
  light: Light;
  /** The module's own health sentence (the last hour). */
  health: string;
}

// ---- The business detail's registration block ----

export interface RegisteredGroup { service: string; id: string; name: string; path?: string; how: string; nifiUrl?: string | null }
export interface RegistrationInfo {
  by: string; at: string;
  groups: RegisteredGroup[];
  shared: { id: string; name: string }[];
  /** The hand-overs the owner described (a draft of changes is compared with them). */
  handoffs: { id: string; from: HandoffInput["from"]; to: HandoffInput["to"]; quote: string }[];
  /** Registration history, newest first; the server merges the per-service rows of one action (7.7 item 8). */
  changes: { at: string; by: string; text: string; quote?: string }[];
}
/** FlowDetail (the existing business detail) plus what registration adds. */
export type BusinessDetail = FlowDetail & { registration?: RegistrationInfo };
