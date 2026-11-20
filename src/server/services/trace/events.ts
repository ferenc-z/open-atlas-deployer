// S37 step 5 (pages-rethink §4.2.0, S38): the first layer of the business data trace. Every evidence source — NiFi
// provenance, the e2e_trace run records read through Studio, later throughput statistics, logs, bulletins — is an
// adapter that answers with the same observed events and says what it can be asked. Version differences live only in
// an adapter (a request format, a version allowlist); nothing above this layer asks which NiFi version a service runs.

/** A correlation key: what carries one piece of business data through a segment ("flowfile" for a FlowFile uuid,
 *  otherwise an attribute or a run-record field such as "correlation_id" or "filename"). */
export interface CorrelationKey { name: string; value: string }

/** Where in a service an event happened: a process group, a port, a processor or an e2e_trace worker. */
export type PositionKind = "process-group" | "input-port" | "output-port" | "processor" | "worker";
export const POSITION_KINDS: readonly PositionKind[] = ["process-group", "input-port", "output-port", "processor", "worker"];
export interface Position { kind: PositionKind; id: string; name?: string }

/** What the event says happened to the data at its position. "sent" is a hand-over out (S2S SEND, an MQ publish);
 *  "received" one in (S2S RECEIVE, a consume); "dropped" its end there. */
export type EventState = "received" | "start" | "end" | "success" | "failure" | "sent" | "dropped" | "other";

/** The observed event every adapter outputs: {key, position, time, state, attributes} (§4.2.0 layer 1). */
export interface ObservedEvent {
  /** The adapter that saw it (its id). */
  source: string;
  service: string;
  key: CorrelationKey;
  position: Position;
  /** ISO time. */
  at: string;
  state: EventState;
  attrs: Record<string, string>;
  /** Keys the data went on under inside the segment (a FlowFile's children: CLONE, FORK, a split); the engine follows them. */
  children?: CorrelationKey[];
  /** Where the event can be looked at (a NiFi deep link, a run record id), shown as evidence. */
  ref?: { node?: string; eventId?: string | number; url?: string };
}

/** The hand-over channel types (T2); within a segment steps are joined by the flow's connections. */
export type ChannelType = "s2s" | "mq" | "external";

/** What an adapter can be asked (§4.2.0): by a correlation key (which key names; "*" any attribute it indexes), by a
 *  position and a time range, and across which hand-overs it can pair the two sides itself. */
export interface Capabilities { byKey: string[] | "*"; byPosition: boolean; handover: ChannelType[] }

/** An adapter's answer. complete=false when it could not answer for the whole range: `reason` says why. */
export interface AdapterAnswer {
  events: ObservedEvent[];
  /** unavailable: the source cannot be asked now (executor offline, Studio down, no token); expired: its evidence for
   *  the range is gone (T4: judged by the earliest event the source still holds, not by a configured retention);
   *  incapable (S37 step 9): it cannot be asked this at all (a key it does not index); the engine skips it quietly. */
  missing?: { reason: "unavailable" | "expired" | "error" | "incapable"; message: string; earliest?: string };
}

export interface KeyQuery { service: string; key: CorrelationKey; from: string; to: string; position?: Position }
export interface PositionQuery { service: string; position: Position; from: string; to: string; /** only events whose attribute matches */ where?: CorrelationKey }
export interface HandoverQuery { service: string; channel: ChannelType; /** the sender's event at the exit */ sent: ObservedEvent; position: Position; from: string; to: string }

export interface EvidenceAdapter {
  readonly id: string;
  capabilities(service: string): Capabilities;
  byKey?(q: KeyQuery): Promise<AdapterAnswer>;
  byPosition?(q: PositionQuery): Promise<AdapterAnswer>;
  /** Pairs a hand-over on the receiving side from the sender's event (S2S: the receiver's RECEIVE whose source
   *  FlowFile id is the sender's uuid, in a time window — the provenance adapter's rule, T3). */
  handover?(q: HandoverQuery): Promise<AdapterAnswer>;
}

/** Whether an adapter can be asked by this key name. */
export const canByKey = (c: Capabilities, name: string) => c.byKey === "*" || c.byKey.includes(name);

/** S37 step 6 (T10): a step's allowed time can come from a source that knows better than a fixed value (e2e_trace:
 *  the step's historical P95). An adapter that implements `allowance` answers in seconds, or undefined (no opinion);
 *  the model's own maxSeconds for the step still wins, and without either the engine's default applies. */
export interface AllowanceQuery { service: string; business: string; step: string; position: Position }
export interface EvidenceAdapter {
  allowance?(q: AllowanceQuery): Promise<number | undefined>;
}
