// Service ops §7, §16.3: a cluster's configuration in layers. Each file has a template in the common layer, and each node
// what differs from it: keys set or removed, or the whole file instead when it cannot be split (XML that differs, a file
// only some nodes have). A revision still holds every node's complete files (ServiceConfigBody.members): those are what
// plans, drift and comparisons look at, and they are always rendered from the layers here. Revision 1 is as installed;
// a cluster is split when first edited. A standalone has no layers, its files are edited directly.

import { createHash } from "node:crypto";
import type { SecretBox } from "../secretbox.ts";
import { openFile, sealFile, type ConfigFileRecord, type ConfigLayers, type ConfigMember, type LayerFile, type LayerValue, type NodeFileLayer, type ServiceConfigBody } from "./config.ts";
import { ConfigDocError, effectiveProperties, isSecretKey, parsePropertyEntries, writeProperties, type WrittenProperty } from "./configdoc.ts";
import { installKey } from "./draft.ts";

function bytesOf(f: Omit<LayerFile, "redacted" | "secrets" | "format" | "size">, box: SecretBox): Buffer {
  const opened = openFile(f as ConfigFileRecord, box);
  if (!opened.ok) throw new ConfigDocError(opened.code, opened.message);
  return opened.bytes;
}

function layerFile(name: string, bytes: Buffer, box: SecretBox): LayerFile {
  const { path: _p, modifiedAt: _m, ...f } = sealFile({ name, path: "", modifiedAt: "" }, bytes, box);
  return f;
}

/** A node's value as a layer keeps it: a secret sealed, unless empty (redacted copies show those too). */
function layerValue({ key, value }: WrittenProperty, box: SecretBox): LayerValue {
  const name = parsePropertyEntries(`${key}=`)[0]?.name ?? key;
  return value !== "" && isSecretKey(name) ? { key, sealed: box.seal(value) } : { key, value };
}

const written = (v: LayerValue, box: SecretBox): WrittenProperty => ("sealed" in v ? { key: v.key, value: box.open(v.sealed) } : v);

/** A node's bytes of a file in the layers; a file it has neither from the common layer nor of its own is null. */
export function renderFile(layers: ConfigLayers, node: string, name: string, box: SecretBox): Buffer | null {
  const own = layers.nodes[node]?.[name];
  if (own && "replace" in own) return bytesOf(own.replace, box);
  const common = layers.common[name];
  if (!common) {
    if (own) throw new ConfigDocError("config/layer-mismatch", `${node} has values for ${name}, which has no common copy`);
    return null;
  }
  const template = bytesOf(common, box);
  return own ? writeProperties(template, own.set.map((v) => written(v, box)), own.unset) : template;
}

/** The members' files rendered from the layers, in the same order; each keeps its path, and its record while the bytes
 *  are the same. The layers must cover exactly the files each member has: nothing is dropped or added silently. */
export function renderBody(members: readonly ConfigMember[], layers: ConfigLayers, box: SecretBox): ServiceConfigBody {
  const keys = new Set(members.map(installKey));
  const stranger = Object.keys(layers.nodes).find((node) => !keys.has(node));
  if (stranger) throw new ConfigDocError("config/layer-mismatch", `The layers have ${stranger}, which is not a member`);
  const rendered = members.map((m) => {
    const node = installKey(m);
    const names = new Set([...Object.keys(layers.common), ...Object.entries(layers.nodes[node] ?? {}).filter(([, l]) => "replace" in l).map(([name]) => name)]);
    const had = m.files.map((f) => f.name);
    const extra = had.find((name) => !names.has(name)) ?? [...names].find((name) => !had.includes(name));
    if (extra) throw new ConfigDocError("config/layer-mismatch", `${node} and the layers differ on having ${extra}`);
    return { ...m, files: m.files.map((f) => {
      const bytes = renderFile(layers, node, f.name, box)!;
      return createHash("sha256").update(bytes).digest("hex") === f.sha256 ? f : sealFile(f, bytes, box);
    }) };
  });
  return { members: rendered, layers };
}

/** A properties file all nodes have, with its differences moved into node layers. The template is the first node's file,
 *  so its comments and order are the ones kept; a key that differs stays at its place with no value. */
function splitProperties(name: string, files: { node: string; bytes: Buffer }[], box: SecretBox, layers: ConfigLayers) {
  const maps = files.map((f) => effectiveProperties(f.bytes));
  const first = maps[0]!;
  const differing = [...new Set(maps.flatMap((m) => [...m.keys()]))].filter((k) => new Set(maps.map((m) => m.get(k)?.value)).size > 1);
  const blanks = differing.flatMap((k) => { const e = first.get(k); return e ? [{ key: e.key, value: "" }] : []; });
  layers.common[name] = layerFile(name, writeProperties(files[0]!.bytes, blanks), box);
  files.forEach(({ node }, i) => {
    const set = differing.flatMap((k) => { const e = maps[i]!.get(k); return e ? [layerValue(e, box)] : []; });
    const unset = differing.filter((k) => !maps[i]!.has(k) && first.has(k)).map((k) => first.get(k)!.key);
    if (set.length || unset.length) layers.nodes[node]![name] = { set, unset };
  });
}

/** The first edit of a cluster: its body with layers, and its members rendered from them. Values the same on every node
 *  go to the common layer, the rest to the nodes (a key scope:cluster wants the same too: the checks report it). Nodes
 *  differing only in comments or order end up with the first node's: the same to NiFi, not the same bytes. A file that
 *  cannot be opened as kept (config/reimport) refuses the split, since it could not be written back. */
export function splitBody(body: ServiceConfigBody, box: SecretBox): ServiceConfigBody {
  if (body.layers) return body;
  const layers: ConfigLayers = { common: {}, nodes: Object.fromEntries(body.members.map((m) => [installKey(m), {} as Record<string, NodeFileLayer>])) };
  const opened = body.members.map((m) => ({ node: installKey(m), files: new Map(m.files.map((f) => [f.name, bytesOf(f, box)])) }));
  for (const name of new Set(body.members.flatMap((m) => m.files.map((f) => f.name)))) {
    const files = opened.flatMap((m) => { const bytes = m.files.get(name); return bytes ? [{ node: m.node, bytes }] : []; });
    const everywhere = files.length === opened.length;
    if (everywhere && files.every((f) => f.bytes.equals(files[0]!.bytes))) layers.common[name] = layerFile(name, files[0]!.bytes, box);
    else if (everywhere && /\.(properties|conf)$/.test(name)) splitProperties(name, files, box, layers);
    else for (const f of files) layers.nodes[f.node]![name] = { replace: layerFile(name, f.bytes, box) };
  }
  return renderBody(body.members, layers, box);
}

/** Whether two properties files mean the same to NiFi: only comments, order or layout differ. */
export function sameProperties(a: Buffer, b: Buffer): boolean {
  const left = effectiveProperties(a), right = effectiveProperties(b);
  return left.size === right.size && [...left].every(([k, v]) => right.get(k)?.value === v.value);
}
