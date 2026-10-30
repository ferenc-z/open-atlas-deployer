// Versions are plain semver (M.m.p, optional -pre). A manifest applies from its appliesFrom up to
// the next manifest's appliesFrom (D28), so the one covering a version is the latest that starts
// at or before it.

const parse = (v: string) => {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(v);
  if (!m) throw new Error(`not a version: ${v}`);
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] };
};

export function compareVersions(a: string, b: string): number {
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! - y.core[i]!;
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre.localeCompare(y.pre, "en", { numeric: true });
}

export function covering<T extends { appliesFrom: string }>(manifests: T[], version: string): T | undefined {
  return manifests
    .filter((m) => compareVersions(m.appliesFrom, version) <= 0)
    .sort((a, b) => compareVersions(b.appliesFrom, a.appliesFrom))[0];
}
