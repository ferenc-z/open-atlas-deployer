// Validates a deploy manifest (format v1, D28): the JSON Schema keywords the schema uses, then the
// rules a schema cannot say (dependsOn targets exist and do not cycle, migration targets).
// The schema is a copy of open-atlas-docs docs/proposals/deploy-manifest-v1.schema.json.

import { readFileSync } from "node:fs";
import type { Manifest } from "../compose/generate.ts";

type Schema = Record<string, any>;

const ROOT: Schema = JSON.parse(readFileSync(new URL("../../schema/deploy-manifest-v1.schema.json", import.meta.url), "utf8"));

const resolve = (ref: string): Schema => ref.replace(/^#\//, "").split("/").reduce((o: Schema, k) => o[k], ROOT);
const typeOf = (v: unknown) => (Array.isArray(v) ? "array" : v === null ? "null" : Number.isInteger(v) ? "integer" : typeof v);

function check(s: Schema, v: any, path: string): string[] {
  if (s.$ref) return check(resolve(s.$ref), v, path);
  if (s.type && !(s.type === typeOf(v) || (s.type === "number" && typeof v === "number"))) return [`${path}: expected ${s.type}`];
  const errs: string[] = [];
  if ("const" in s && v !== s.const) errs.push(`${path}: expected ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.includes(v)) errs.push(`${path}: not one of ${s.enum.join(", ")}`);
  if (s.pattern && typeof v === "string" && !new RegExp(s.pattern).test(v)) errs.push(`${path}: "${v}" does not match ${s.pattern}`);
  if (s.minimum !== undefined && v < s.minimum) errs.push(`${path}: below ${s.minimum}`);
  if (s.maximum !== undefined && v > s.maximum) errs.push(`${path}: above ${s.maximum}`);
  if (Array.isArray(v)) {
    if (s.minItems && v.length < s.minItems) errs.push(`${path}: fewer than ${s.minItems} items`);
    if (s.uniqueItems && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) errs.push(`${path}: duplicate items`);
    if (s.items) v.forEach((x, i) => errs.push(...check(s.items, x, `${path}[${i}]`)));
  }
  if (typeOf(v) === "object") {
    for (const k of s.required ?? []) if (!(k in v)) errs.push(`${path}: missing ${k}`);
    for (const [k, x] of Object.entries(v)) {
      if (s.propertyNames) errs.push(...check(s.propertyNames, k, `${path}.${k}(name)`));
      if (s.properties?.[k]) errs.push(...check(s.properties[k], x, `${path}.${k}`));
      else if (s.additionalProperties === false) errs.push(`${path}: unknown key ${k}`);
      else if (typeof s.additionalProperties === "object") errs.push(...check(s.additionalProperties, x, `${path}.${k}`));
    }
  }
  if (s.oneOf) {
    const results = s.oneOf.map((x: Schema) => check(x, v, path));
    const ok = results.filter((r: string[]) => r.length === 0).length;
    if (ok !== 1) errs.push(ok === 0 ? `${path}: matches no allowed shape; closest: ${results.sort((a: string[], b: string[]) => a.length - b.length)[0].join("; ")}` : `${path}: matches ${ok} shapes`);
  }
  if (s.anyOf && !s.anyOf.some((x: Schema) => check(x, v, path).length === 0)) errs.push(`${path}: matches no allowed shape`);
  if (s.not && check(s.not, v, path).length === 0) errs.push(`${path}: matches a forbidden shape ${JSON.stringify(s.not)}`);
  return errs;
}

function crossCheck(m: Manifest): string[] {
  const errs: string[] = [];
  const ids = new Map(m.components.map((c) => [c.id, c]));
  if (ids.size !== m.components.length) errs.push("component ids are not unique");
  for (const c of m.components) {
    for (const d of c.dependsOn ?? []) if (!ids.has(d)) errs.push(`${c.id}: dependsOn unknown ${d}`);
    const target = (c as { target?: string }).target;
    if (c.type === "db-migration" && ids.get(target ?? "")?.type !== "compose-service") errs.push(`${c.id}: target is not a compose-service`);
  }
  const done = new Set<string>(), stack = new Set<string>();
  const visit = (id: string) => {
    if (stack.has(id)) errs.push(`dependency cycle at ${id}`);
    if (done.has(id) || stack.has(id)) return;
    stack.add(id);
    for (const d of ids.get(id)?.dependsOn ?? []) visit(d);
    stack.delete(id);
    done.add(id);
  };
  ids.forEach((_, id) => visit(id));
  return errs;
}

/** Empty when the value is a valid v1 manifest. */
export function validateManifest(value: unknown): string[] {
  const errs = check(ROOT, value, "manifest");
  return errs.length ? errs : crossCheck(value as Manifest);
}

/** Services and host ports share one deploy root, so they must be unique across apps. */
export function crossAppConflicts(manifests: Manifest[]): string[] {
  const errs: string[] = [];
  const services = new Map<string, string>(), ports = new Map<number, string>();
  for (const m of manifests) for (const c of m.components.filter((x) => x.type === "compose-service")) {
    const prior = services.get(c.service!);
    if (prior && prior !== m.app) errs.push(`service ${c.service} is used by both ${prior} and ${m.app}`);
    services.set(c.service!, m.app);
    for (const p of c.ports ?? []) if (p.host) {
      const owner = ports.get(p.host);
      if (owner && !owner.startsWith(`${m.app}/`)) errs.push(`host port ${p.host} is used by both ${owner} and ${m.app}/${c.id}`);
      ports.set(p.host, `${m.app}/${c.id}`);
    }
  }
  return errs;
}
