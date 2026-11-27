// S41 step 6: expiry warnings by certificate, not by service. Every library version in use gets at most one alert, however
// many services use it ("corp-nifi v2 expires in 12 days, used by 5 services"); the days are the services' certificate
// thresholds (the rules' certWarnDays / certCritDays: attention within the first, failing within the second or expired;
// the largest of the services using it, so none is warned late). S27's reading of the keystore on the hosts stays as a
// cross-check: a service whose host keystore is not the bound version's certificate is a finding of its own.

import type { Store } from "../store.ts";
import { thresholdsOf } from "../services/status.ts";

export interface CertAlert {
  cert: string; name: string; version: number; subject: string; notAfter: string;
  days: number; light: "attention" | "failing"; usedBy: string[]; text: string;
}
export interface CertMismatch { service: string; cert: string; name: string; version: number; boundNotAfter: string; hostNotAfter: string | null; text: string }
export interface CertWarnings { alerts: CertAlert[]; mismatches: CertMismatch[] }

const DAY = 86_400_000;

export function certWarnings(store: Store, now: Date = new Date()): CertWarnings {
  const profiles = new Map([...store.clusters(), ...store.standalones()].map((s) => [s.id, s.profile] as const));
  const alerts: CertAlert[] = [], mismatches: CertMismatch[] = [];
  const library = store.nifiCerts();
  for (const entry of library) {
    for (const v of entry.versions) {
      if (!v.usedBy.length) continue;
      let warn = 0, crit = 0;
      for (const id of v.usedBy) {
        const t = thresholdsOf(store, id, profiles.get(id) ?? "").effective;
        warn = Math.max(warn, t.certWarnDays); crit = Math.max(crit, t.certCritDays);
      }
      const days = Math.floor((Date.parse(v.notAfter) - now.getTime()) / DAY);
      if (days > warn) continue;
      const light = days < 0 || days <= crit ? "failing" : "attention";
      const n = v.usedBy.length;
      alerts.push({
        cert: entry.id, name: entry.name, version: v.version, subject: v.subject, notAfter: v.notAfter, days, light, usedBy: [...v.usedBy],
        text: `${entry.name} v${v.version} ${days < 0 ? `expired ${-days} day${days === -1 ? "" : "s"} ago` : `expires in ${days} day${days === 1 ? "" : "s"}`}, used by ${n} service${n === 1 ? "" : "s"}`,
      });
    }
  }
  alerts.sort((a, b) => a.days - b.days || (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version - b.version));
  // The cross-check: the keystore's own certificate as the hosts' last reading has it against the bound version.
  for (const b of store.serviceCertBindings()) {
    const entry = library.find((c) => c.id === b.cert), v = entry?.versions.find((x) => x.version === b.version);
    if (!entry || !v) continue;
    const leaves = store.serviceCerts(b.service).filter((c) => c.store === "keystore" && !c.error && c.notAfter);
    if (!leaves.length || leaves.some((c) => Date.parse(c.notAfter!) === Date.parse(v.notAfter))) continue;
    const host = leaves.map((c) => c.notAfter!).sort()[0]!;
    mismatches.push({
      service: b.service, cert: entry.id, name: entry.name, version: v.version, boundNotAfter: v.notAfter, hostNotAfter: host,
      text: `${b.service}: the keystore on the host expires ${host.slice(0, 10)}, but the bound certificate ${entry.name} v${v.version} expires ${v.notAfter.slice(0, 10)}`,
    });
  }
  return { alerts, mismatches };
}
