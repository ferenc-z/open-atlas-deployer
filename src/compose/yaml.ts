// Minimal YAML emitter for generated compose files: block maps and lists, strings always double-quoted
// (JSON string syntax is valid YAML), so no value can be misread as a number, boolean or anchor.

export type Yaml = string | number | boolean | null | Yaml[] | { [key: string]: Yaml };

const PLAIN_KEY = /^[A-Za-z0-9_.\/-]+$/;

function scalar(value: string | number | boolean | null): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function key(name: string): string {
  return PLAIN_KEY.test(name) ? name : JSON.stringify(name);
}

function isEmpty(value: Yaml): boolean {
  return Array.isArray(value) ? value.length === 0 : value !== null && typeof value === "object" && Object.keys(value).length === 0;
}

function lines(value: Yaml, indent: string): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (item !== null && typeof item === "object" && !isEmpty(item)) {
        const [first, ...rest] = lines(item, indent + "  ");
        return [`${indent}- ${first.trimStart()}`, ...rest];
      }
      return [`${indent}- ${isEmpty(item) ? (Array.isArray(item) ? "[]" : "{}") : scalar(item as string)}`];
    });
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([name, item]) => {
      if (item !== null && typeof item === "object" && !isEmpty(item)) return [`${indent}${key(name)}:`, ...lines(item, indent + "  ")];
      return [`${indent}${key(name)}: ${isEmpty(item) ? (Array.isArray(item) ? "[]" : "{}") : scalar(item as string)}`];
    });
  }
  return [`${indent}${scalar(value)}`];
}

export function toYaml(value: Yaml, header?: string): string {
  return [...(header ? header.split("\n").map((line) => `# ${line}`) : []), ...lines(value, "")].join("\n") + "\n";
}
