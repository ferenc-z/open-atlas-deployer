// JSON Patch (RFC 6902) for the admin tools (§10.8, D38): a manifest or the environment settings change by the
// operations an AI sends, applied to the revision it read (base), never by rewriting the whole document. A bad
// operation is refused as a finding naming the operation and the path, and nothing is changed.

export class PatchError extends Error {
  readonly at: string[];
  constructor(message: string, at: string[]) {
    super(message);
    this.at = at;
  }
}

export interface Operation { op: string; path: string; from?: string; value?: unknown }

type Json = unknown;
const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const isObject = (v: Json): v is Record<string, Json> => typeof v === "object" && v !== null && !Array.isArray(v);

function tokens(pointer: string, at: string[]): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new PatchError(`${pointer} is not a JSON pointer (it starts with /)`, at);
  return pointer.slice(1).split("/").map((t) => t.replaceAll("~1", "/").replaceAll("~0", "~"));
}

/** The parent container and the last token; the parent must exist. */
function locate(doc: Json, pointer: string, at: string[]): { parent: Json; key: string } {
  const path = tokens(pointer, at);
  if (!path.length) throw new PatchError("the operation cannot target the whole document", at);
  let parent = doc;
  for (const t of path.slice(0, -1)) {
    if (Array.isArray(parent)) parent = parent[index(parent, t, at, false)];
    else if (isObject(parent) && t in parent) parent = parent[t];
    else throw new PatchError(`${pointer}: ${t} does not exist`, at);
  }
  if (!Array.isArray(parent) && !isObject(parent)) throw new PatchError(`${pointer}: the parent is not an object or array`, at);
  return { parent, key: path.at(-1)! };
}

function index(arr: Json[], token: string, at: string[], append: boolean): number {
  if (append && token === "-") return arr.length;
  if (!/^(0|[1-9]\d*)$/.test(token)) throw new PatchError(`${token} is not an array index`, at);
  const i = Number(token);
  if (i > arr.length || (!append && i === arr.length)) throw new PatchError(`index ${i} is out of range (length ${arr.length})`, at);
  return i;
}

function get(doc: Json, pointer: string, at: string[]): Json {
  let v = doc;
  for (const t of tokens(pointer, at)) {
    if (Array.isArray(v)) v = v[index(v, t, at, false)];
    else if (isObject(v) && t in v) v = v[t];
    else throw new PatchError(`${pointer} does not exist`, at);
  }
  return v;
}

function remove(doc: Json, pointer: string, at: string[]): Json {
  const { parent, key } = locate(doc, pointer, at);
  if (Array.isArray(parent)) return parent.splice(index(parent, key, at, false), 1)[0];
  if (!(key in (parent as Record<string, Json>))) throw new PatchError(`${pointer} does not exist`, at);
  const old = (parent as Record<string, Json>)[key];
  delete (parent as Record<string, Json>)[key];
  return old;
}

function add(doc: Json, pointer: string, value: Json, at: string[]) {
  const { parent, key } = locate(doc, pointer, at);
  if (Array.isArray(parent)) parent.splice(index(parent, key, at, true), 0, value);
  else (parent as Record<string, Json>)[key] = value;
}

/** Applies the operations to a copy of the document; the original is untouched. */
export function applyPatch<T>(document: T, operations: unknown): T {
  if (!Array.isArray(operations) || !operations.length) throw new PatchError("the patch is a non-empty array of operations", ["patch"]);
  let doc = clone(document) as Json;
  operations.forEach((raw, i) => {
    const at = ["patch", String(i)];
    if (!isObject(raw) || typeof raw.op !== "string" || typeof raw.path !== "string") throw new PatchError("each operation has op and path", at);
    const o = raw as unknown as Operation;
    const needsValue = o.op === "add" || o.op === "replace" || o.op === "test";
    if (needsValue && !("value" in raw)) throw new PatchError(`${o.op} needs a value`, at);
    if ((o.op === "move" || o.op === "copy") && typeof o.from !== "string") throw new PatchError(`${o.op} needs from`, at);
    switch (o.op) {
      case "add": add(doc, o.path, clone(o.value), at); break;
      case "remove": remove(doc, o.path, at); break;
      case "replace": remove(doc, o.path, at); add(doc, o.path, clone(o.value), at); break;
      case "move": { if (o.path.startsWith(`${o.from}/`)) throw new PatchError("cannot move a value into itself", at); const v = remove(doc, o.from!, at); add(doc, o.path, v, at); break; }
      case "copy": add(doc, o.path, clone(get(doc, o.from!, at)), at); break;
      case "test": if (JSON.stringify(get(doc, o.path, at)) !== JSON.stringify(o.value)) throw new PatchError(`${o.path} is not the tested value`, at); break;
      default: throw new PatchError(`${o.op} is not a JSON Patch operation (add, remove, replace, move, copy, test)`, at);
    }
    if (doc === undefined) doc = null;
  });
  return doc as T;
}

/** The paths that differ between two documents, for revision records ("apps.shop.version"). */
export function changedPaths(before: Json, after: Json, prefix = "", depth = 3): string[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (depth === 0 || !isObject(before) || !isObject(after)) return [prefix || "(document)"];
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.flatMap((k) => changedPaths(before[k], after[k], prefix ? `${prefix}.${k}` : k, depth - 1));
}
