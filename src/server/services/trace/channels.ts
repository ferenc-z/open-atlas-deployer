// S37 step 5 (§4.2.0 T2): segments are joined by channels, never by referring to each other. An exit whose channel is
// another service's entry channel is linked to it, whoever wrote either model; an exit or entry (S2S, MQ) with no
// counterpart is "dangling" and shown in the model's health. External channels lead outside and are never dangling.

import type { Endpoint, TraceModel } from "./model.ts";

export interface EndpointRef { service: string; business: string; endpoint: string }
export interface Link { channel: string; from: EndpointRef; to: EndpointRef }
export interface Dangling extends EndpointRef { side: "entry" | "exit"; channel: string; message: string }

/** The channel's identity, the same string on both sides; null for an external channel (it is not joined). */
export function channelKey(service: string, e: Endpoint, side: "entry" | "exit"): string | null {
  const c = e.channel;
  if (c.type === "s2s") return `s2s:${side === "entry" ? service : c.service}/${c.port}`;
  if (c.type === "mq") return `mq:${c.exchange}/${c.routingKey}`;
  return null;
}

export const channelLabel = (key: string) => key.replace(/^s2s:/, "S2S ").replace(/^mq:/, "MQ ");

function sides(models: TraceModel[]) {
  const entries = new Map<string, EndpointRef[]>(), exits = new Map<string, EndpointRef[]>();
  for (const m of models) for (const b of m.businesses) {
    for (const [side, list, map] of [["entry", b.entries, entries], ["exit", b.exits, exits]] as const)
      for (const e of list) {
        const key = channelKey(m.service, e, side);
        if (key) map.set(key, [...(map.get(key) ?? []), { service: m.service, business: b.id, endpoint: e.id }]);
      }
  }
  return { entries, exits };
}

/** Every exit linked to every entry with the same channel (one exit may reach several entries; the receiving
 *  business's match rules pick the right one when the engine follows the data). */
export function links(models: TraceModel[]): Link[] {
  const { entries, exits } = sides(models);
  const out: Link[] = [];
  for (const [channel, from] of exits) for (const f of from) for (const t of entries.get(channel) ?? []) out.push({ channel, from: f, to: t });
  return out;
}

/** Exits nobody receives and entries nobody sends to, among the models given (all services' models). */
export function dangling(models: TraceModel[]): Dangling[] {
  const { entries, exits } = sides(models);
  const out: Dangling[] = [];
  for (const [channel, refs] of exits) if (!entries.has(channel)) for (const r of refs)
    out.push({ ...r, side: "exit", channel, message: `Exit ${r.endpoint} sends to ${channelLabel(channel)}, but no service's model has an entry on that channel.` });
  for (const [channel, refs] of entries) if (!exits.has(channel)) for (const r of refs)
    out.push({ ...r, side: "entry", channel, message: `Entry ${r.endpoint} receives on ${channelLabel(channel)}, but no service's model has an exit on that channel.` });
  return out;
}

/** The entries an exit of a service's business is linked to. */
export function targetsOf(models: TraceModel[], from: EndpointRef): Link[] {
  return links(models).filter((l) => l.from.service === from.service && l.from.business === from.business && l.from.endpoint === from.endpoint);
}
