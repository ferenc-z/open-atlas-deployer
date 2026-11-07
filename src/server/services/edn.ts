// A small EDN writer for the Studio Semantic Contract the Deployer generates (services/graph.ts). Plain values map to
// EDN as: string → string, number → number, boolean → boolean, null → nil, array → vector, object → map whose keys
// are keywords when they start with ":" and strings otherwise. kw(), set() and map() cover what plain values cannot.

export class Kw { readonly name: string; constructor(name: string) { this.name = name; } }
export class EdnSet { readonly items: unknown[]; constructor(items: unknown[]) { this.items = items; } }
/** A map with keys of any kind (vectors as keys, e.g. a contract's :selection). */
export class EdnMap { readonly entries: [unknown, unknown][]; constructor(entries: [unknown, unknown][]) { this.entries = entries; } }

export const kw = (name: string) => new Kw(name.replace(/^:/, ""));
export const set = (items: unknown[]) => new EdnSet(items);
export const map = (entries: [unknown, unknown][]) => new EdnMap(entries);

const str = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;

/** The value as EDN text; nested maps and vectors break onto new lines past `width` characters. */
export function edn(value: unknown, indent = 0, width = 110): string {
  const flat = write(value, null);
  if (flat.length + indent <= width) return flat;
  return write(value, indent, width);
}

function key(k: string): unknown { return k.startsWith(":") ? kw(k) : k; }

function write(value: unknown, indent: number | null, width = 110): string {
  if (value === null || value === undefined) return "nil";
  if (typeof value === "string") return str(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`EDN: ${value} is not a number EDN can carry`);
    return String(value);
  }
  if (typeof value === "boolean") return String(value);
  if (value instanceof Kw) return `:${value.name}`;
  const child = (v: unknown, at: number) => (indent === null ? write(v, null) : edn(v, at, width));
  if (value instanceof EdnSet) return `#{${value.items.map((v) => write(v, null)).join(" ")}}`;
  if (Array.isArray(value)) {
    if (indent === null) return `[${value.map((v) => write(v, null)).join(" ")}]`;
    return `[${value.map((v, i) => (i ? " ".repeat(indent + 1) : "") + child(v, indent + 1)).join("\n")}]`;
  }
  const entries: [unknown, unknown][] = value instanceof EdnMap ? value.entries
    : Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).map(([k, v]) => [key(k), v]);
  if (indent === null) return `{${entries.map(([k, v]) => `${write(k, null)} ${write(v, null)}`).join(" ")}}`;
  return `{${entries.map(([k, v], i) => {
    const ks = write(k, null);
    return (i ? " ".repeat(indent + 1) : "") + ks + " " + child(v, indent + 2 + ks.length);
  }).join("\n")}}`;
}
