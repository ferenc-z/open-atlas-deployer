// S37 step 9's cases are gone (pages-rethink §10.2.5, ops step 4): record (the MCP verb) writes analyses and to-dos
// instead, and service_cases is no longer read or written. Opening an OMA session and waiting for its answer moved to
// oma-turn.ts. Only the types are left, for the old web pages (src/web/api.ts) until step 6a's removal of them is merged.

export type CaseKind = "investigate" | "trace" | "alert";
export type Proposal =
  | { kind: "config"; draft: string; label: string }
  | { kind: "start" | "stop" | "restart"; members: string[]; label: string };
export interface CaseAnswer { cause: string; evidence: string[]; next: string[]; confidence?: string; proposals: Proposal[] }
export interface CaseMessage { role: "person" | "assistant"; text: string; at: string; by?: string }
export interface ServiceCase {
  id: number; service: string; kind: CaseKind; rule: string | null; alertId: number | null; member: string | null; title: string;
  evidence: unknown; state: "running" | "done" | "failed"; session: string | null; requestedAt: string; requestedBy: string;
  turnAt: string; asked: number; finishedAt: string | null; answer: CaseAnswer | null; text: string | null; error: string | null;
  messages: CaseMessage[]; outcome: { text: string; by: string; at: string } | null;
}
