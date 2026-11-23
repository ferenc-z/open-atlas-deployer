// pages-rethink §10.1 ⑰ (saving tokens, second round): run_model and publish_model take the draft as a base and a list
// of changes instead of the whole model. A whole draft is 15–25 KB on a service of twenty groups, and the check-up sent
// it in every run_model and publish_model (60–120 KB of tool arguments a session), after reading it whole first. With
// {from: "skeleton" | "current", changes} the Deployer builds the draft itself: the skeleton's draft
// (flowmodel.draftFromSkeleton) or the current model, then the changes in order. The result is an ordinary ModelDraft,
// so parseDraft and the gate judge it exactly as a draft sent whole; nothing here decides what is right.
//
// The changes are the model's own structure, nothing NiFi-specific: put segments in a business (merge, split, a new
// key), make them shared steps, remove them, add one, set a segment's fields, add / change / remove an entry or an exit
// (an S2S or MQ hand-over to another service is an exit here and an entry there), rename a business key, and the
// business notes (name, summary, reason, risks, stuck, ignore).

import type { Endpoint, Exit, FlowNote, ModelDraft, Segment } from "./trace/model.ts";

type Any = Record<string, any>;
export type ModelBase = "skeleton" | "current";
export const CHANGE_OPS = ["assign", "share", "remove", "add-segment", "set", "add-entry", "set-entry", "remove-entry", "add-exit", "set-exit", "remove-exit", "rekey", "note"] as const;
export type ChangeOp = (typeof CHANGE_OPS)[number];
export const CHANGES_MAX = 200;

/** What each op takes, for the tool's description and the refusals. */
export const CHANGE_HELP = [
  "assign {segments: [id…], flow: flw_…|new:<key>} puts segments in one business (merge pieces, split some off to a new key; a shared step becomes a segment)",
  "share {segments: [id…]} makes them shared steps (no business)",
  "remove {segments: [id…]} leaves them out",
  "add-segment {segment: {…whole segment}}",
  "set {segment: id, name?, slice?, match?, steps?, group?} replaces those fields",
  "add-entry / add-exit {segment: id, entry|exit: {id?, step?, channel, component (exit), relationship?, keyAttribute?, cues?, when?}} (id and step default to the next free id and the segment's first step)",
  "set-entry / set-exit {segment: id, id, …fields} changes the fields given of that entry or exit",
  "remove-entry / remove-exit {segment: id, id}",
  "rekey {from: flw_…|new:<key>, to: flw_…|new:<key>} renames a business key in every segment and note",
  "note {flow, name?, summary?, reason?, risks?, stuck?, ignore?} what you say about a business (merged into its note)",
].join("; ");

const ids = (v: unknown): string[] | null => (Array.isArray(v) && v.length && v.every((x) => typeof x === "string") ? v as string[] : null);
const nextId = (taken: { id: string }[], prefix: string) => { let i = taken.length + 1; while (taken.some((x) => x.id === `${prefix}-${i}`)) i++; return `${prefix}-${i}`; };

/** The base draft with the changes applied in order; every change that cannot apply is an error (none applied then). */
export function applyChanges(base: ModelDraft, changes: unknown): { draft: ModelDraft; errors: string[] } {
  const errors: string[] = [];
  const draft: ModelDraft = structuredClone({ ...base, flows: base.flows ?? [] });
  if (!Array.isArray(changes)) return { draft, errors: ["changes is a list of {op, …}."] };
  if (changes.length > CHANGES_MAX) return { draft, errors: [`At most ${CHANGES_MAX} changes.`] };
  const seg = (id: unknown, at: string): Segment | null => {
    const s = typeof id === "string" ? draft.segments.find((x) => x.id === id) : undefined;
    if (!s) errors.push(`${at}: no segment ${String(id)} in the draft (the brief's skeletonDraft or look kind model lists them).`);
    return s ?? null;
  };
  const segs = (list: unknown, at: string) => { const l = ids(list); if (!l) { errors.push(`${at}.segments is a list of segment ids.`); return []; } return l.map((id) => seg(id, at)).filter((s): s is Segment => Boolean(s)); };
  const note = (flow: string): FlowNote => { let n = draft.flows!.find((x) => x.flow === flow); if (!n) { n = { flow }; draft.flows!.push(n); } return n; };
  for (const [i, raw] of changes.entries()) {
    const c = (raw ?? {}) as Any;
    const at = `changes[${i}] (${String(c.op)})`;
    switch (c.op as ChangeOp) {
      case "assign": {
        if (typeof c.flow !== "string" || !c.flow) { errors.push(`${at}.flow is a business id (flw_…) or new:<key>.`); break; }
        for (const s of segs(c.segments, at)) { s.role = "segment"; s.flow = c.flow; }
        break;
      }
      case "share": for (const s of segs(c.segments, at)) { s.role = "shared"; delete s.flow; } break;
      case "remove": { const gone = new Set(segs(c.segments, at).map((s) => s.id)); draft.segments = draft.segments.filter((s) => !gone.has(s.id)); break; }
      case "add-segment": {
        const s = c.segment as Any;
        if (!s || typeof s !== "object" || typeof s.id !== "string") { errors.push(`${at}.segment is a whole segment with an id.`); break; }
        if (draft.segments.some((x) => x.id === s.id)) { errors.push(`${at}: segment ${s.id} exists already (use set).`); break; }
        draft.segments.push(s as Segment);
        break;
      }
      case "set": {
        const s = seg(c.segment, at);
        if (!s) break;
        const fields = ["name", "slice", "match", "steps", "group"].filter((k) => c[k] !== undefined);
        if (!fields.length) { errors.push(`${at}: give at least one of name, slice, match, steps, group.`); break; }
        for (const k of fields) (s as Any)[k] = c[k];
        break;
      }
      case "add-entry": case "add-exit": {
        const s = seg(c.segment, at);
        const kind = c.op === "add-entry" ? "entries" : "exits";
        const e = (c.op === "add-entry" ? c.entry : c.exit) as Any;
        if (!s) break;
        if (!e || typeof e !== "object" || !e.channel) { errors.push(`${at}.${c.op === "add-entry" ? "entry" : "exit"} is {channel, …}.`); break; }
        const list = s[kind] as Endpoint[];
        const id = typeof e.id === "string" && e.id ? e.id : nextId(list, c.op === "add-entry" ? "in" : "out");
        if (list.some((x) => x.id === id)) { errors.push(`${at}: ${kind} of ${s.id} has ${id} already (use ${c.op === "add-entry" ? "set-entry" : "set-exit"}).`); break; }
        list.push({ ...e, id, step: typeof e.step === "string" && e.step ? e.step : s.steps[0]?.id ?? "g" } as Exit);
        break;
      }
      case "set-entry": case "set-exit": {
        const s = seg(c.segment, at);
        if (!s) break;
        const list = (c.op === "set-entry" ? s.entries : s.exits) as Any[];
        const e = list.find((x) => x.id === c.id);
        if (!e) { errors.push(`${at}: ${s.id} has no ${c.op === "set-entry" ? "entry" : "exit"} ${String(c.id)}.`); break; }
        const { op: _o, segment: _s, id: _i, ...fields } = c;
        if (!Object.keys(fields).length) { errors.push(`${at}: give the fields to change.`); break; }
        for (const [k, v] of Object.entries(fields)) { if (v === null) delete e[k]; else e[k] = v; }
        break;
      }
      case "remove-entry": case "remove-exit": {
        const s = seg(c.segment, at);
        if (!s) break;
        const key = c.op === "remove-entry" ? "entries" : "exits";
        const before = (s[key] as Endpoint[]).length;
        (s as Any)[key] = (s[key] as Endpoint[]).filter((x) => x.id !== c.id);
        if ((s[key] as Endpoint[]).length === before) errors.push(`${at}: ${s.id} has no ${c.op === "remove-entry" ? "entry" : "exit"} ${String(c.id)}.`);
        break;
      }
      case "rekey": {
        if (typeof c.from !== "string" || typeof c.to !== "string" || !c.from || !c.to) { errors.push(`${at}: from and to are business keys.`); break; }
        let n = 0;
        for (const s of draft.segments) if (s.flow === c.from) { s.flow = c.to; n++; }
        for (const x of draft.flows!) if (x.flow === c.from) x.flow = c.to;
        if (!n) errors.push(`${at}: no segment is in ${c.from}.`);
        break;
      }
      case "note": {
        if (typeof c.flow !== "string" || !c.flow) { errors.push(`${at}.flow is a business key.`); break; }
        const { op: _o, flow, ...fields } = c;
        Object.assign(note(flow), fields);
        break;
      }
      default: errors.push(`${at}: op is one of ${CHANGE_OPS.join(", ")}.`);
    }
  }
  // Notes of keys no segment has any more (merged away) would only confuse the gate's notes.
  const live = new Set(draft.segments.map((s) => s.flow).filter(Boolean));
  draft.flows = draft.flows!.filter((n) => live.has(n.flow) || n.flow.startsWith("flw_"));
  return { draft, errors };
}

/** The assembled draft in a line per segment (what run_model and publish_model answer instead of the model). */
export function draftLines(d: ModelDraft) {
  const ch = (c: Any) => [c.type, c.service, c.port ?? c.exchange ?? c.system, c.routingKey].filter(Boolean).join(":");
  return {
    segments: d.segments.length,
    lines: d.segments.map((s) => ({
      id: s.id, flow: s.flow ?? null, group: s.group?.name, slice: s.slice, role: s.role,
      entries: s.entries.map((e) => `${e.id} ${ch(e.channel)}`),
      exits: s.exits.map((e) => `${e.id} ${ch(e.channel)} @${e.component}${e.relationship ? `/${e.relationship}` : ""}`),
    })),
    flows: (d.flows ?? []).map((n) => ({ flow: n.flow, ...(n.name ? { name: n.name } : {}), ...(n.ignore ? { ignore: true } : {}) })),
  };
}
