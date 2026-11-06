// Shared by the Services pages (list, detail, configuration, takeover): times, member states, conf directories.
import type { Finding, MemberStatus, RegisteredService, ServiceSummary } from "./api.ts";

export const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { hour12: false }) : "—");
/** "12 s ago", "5 min ago", "3 h ago", else the date. */
export const ago = (iso?: string | null, now = Date.now()) => {
  if (!iso) return "—";
  const s = Math.round((now - Date.parse(iso)) / 1000);
  return s < 90 ? `${Math.max(0, s)} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : when(iso);
};

// Phase 2: the state is live, from the collector's samples (§15.2); a member never sampled is as of its host's newest discovery.
export const STATE: Record<MemberStatus["state"], { label: string; tone: string; title: string }> = {
  running: { label: "Running", tone: "ok", title: "Running at the newest sample (or, never sampled yet, at the host's newest discovery)" },
  stopped: { label: "Stopped", tone: "bad", title: "Not running at the newest sample (or at the host's newest discovery)" },
  "not-found": { label: "Not found", tone: "warn", title: "Never sampled, and the host's newest discovery did not see this installation" },
  unknown: { label: "Unknown", tone: "muted", title: "No sample for more than 3 sampling periods (or nothing at all yet)" },
  lost: { label: "Lost", tone: "bad", title: "The host's service executor is offline: nothing is known since its last sample" },
};

export const SEVERITY: Record<Finding["severity"], { tone: string; mark: string }> = { error: { tone: "bad", mark: "✕" }, warning: { tone: "warn", mark: "!" }, info: { tone: "info", mark: "i" } };

export const membersOf = (s: RegisteredService) => (s.kind === "cluster" ? s.nodes : [s.member]);
const trimDir = (d: string) => d.replace(/\/+$/, "") || "/";
/** The conf directory (nifi.properties): the one recorded, else <install>/conf. */
export const confOf = (m: { installDir: string; confDir?: string | null }) => trimDir(m.confDir || `${trimDir(m.installDir)}/conf`);
/** The conf directory when it is not <install>/conf: what to show beside the install directory. */
export const confElsewhere = (m: { installDir: string; confDir?: string | null }) => (confOf(m) === `${trimDir(m.installDir)}/conf` ? null : confOf(m));
export const memberKey = (m: { host: string; installDir: string; confDir?: string | null }) => `${m.host}:${m.installDir}:${confOf(m)}`;
export const ConfCell = ({ m }: { m: { installDir: string; confDir?: string | null } }) =>
  <td className="mono">{confElsewhere(m) ?? <span className="muted" title="NiFi's default, <install>/conf">{confOf(m)}</span>}</td>;
/** The port a member's UI answers on (HTTPS first). */
export const webPort = (ports: { https?: number | null; http?: number | null }) => ports.https ?? ports.http ?? null;
export const serviceName = (service: string) => (service === "nifi" ? "NiFi" : service);

/** "2/2 up", green when all are, red when none. */
export function UpBadge({ s }: { s: ServiceSummary | null }) {
  if (!s) return <span className="muted">—</span>;
  const tone = s.running === s.members ? "ok" : s.running === 0 ? "bad" : "warn";
  return <span className={`badge ${tone}`} title={`Running as of each member's newest sample${s.asOf ? ` (oldest ${when(s.asOf)})` : ""}`}>{s.running}/{s.members} up</span>;
}

/** The executor and version notes beside the up badge. */
export function StatusNotes({ s }: { s: ServiceSummary | null }) {
  if (!s) return null;
  return <>
    {s.executorsOnline < s.members && <span className="badge warn" title="A member's service executor is offline: the member is lost">{s.members - s.executorsOnline} executor offline</span>}
    {s.versionsSeen.length > 0 && <span className="badge warn" title="A sample or discovery saw a version different from the registered one">seen {s.versionsSeen.join(", ")}</span>}
  </>;
}

/** Phase 1 has no alerts: the takeover's node differences (a cluster) stand in for them. */
export function DifferenceBadge({ s, cluster }: { s: ServiceSummary | null; cluster: boolean }) {
  if (!s || !cluster) return null;
  return s.differences
    ? <span className="badge warn" title="Configuration differences between the nodes found at takeover">{s.differences} node difference{s.differences > 1 ? "s" : ""}</span>
    : <span className="badge muted" title="No configuration differences between the nodes at takeover">No node differences</span>;
}

// Phase 2 step 2: numbers and certificates.
export const fmtBytes = (v: number | null | undefined) => {
  if (v === null || v === undefined) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0, x = v;
  while (Math.abs(x) >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return `${x >= 100 || i === 0 ? Math.round(x) : x.toFixed(1)} ${units[i]}`;
};
export const fmtNumber = (v: number | null | undefined, digits = 1) => (v === null || v === undefined ? "—" : Math.abs(v) >= 10000 ? Math.round(v).toLocaleString("en-US") : String(Math.round(v * 10 ** digits) / 10 ** digits));
/** A value in its field's unit. */
export const fmtUnit = (v: number | null | undefined, unit: string) =>
  v === null || v === undefined ? "—" : unit === "bytes" ? fmtBytes(v) : unit === "%" ? `${fmtNumber(v)} %` : unit === "bool" ? (v >= 0.5 ? "up" : "down") : `${fmtNumber(v)}${unit === "count" ? "" : ` ${unit}`}`;

/** S27 and the step 3 rule's defaults: 7 days or less (or expired) critical, 30 days or less a warning. */
export const certTone = (days: number) => (days <= 7 ? "bad" : days <= 30 ? "warn" : "muted");
export const daysLeft = (notAfter: string, now = Date.now()) => Math.floor((Date.parse(notAfter) - now) / 86_400_000);
export const daysText = (days: number) => (days < 0 ? `expired ${-days}d ago` : `${days}d`);

/** "cert 23d": the soonest-expiring certificate; also says when some store could not be read. */
export function CertBadge({ s, only30 = false }: { s: ServiceSummary | null; only30?: boolean }) {
  if (!s) return null;
  const c = s.cert;
  const unread = s.certErrors > 0 && <span className="badge warn" title="A keystore or truststore could not be read (see the certificates on Overview)">cert unreadable</span>;
  if (!c) return unread || null;
  if (only30 && c.days > 30) return unread || null;
  return <>
    <span className={`badge ${certTone(c.days)}`} title={`Soonest certificate expiry: ${c.subject ?? "?"} in the ${c.store} of ${c.member}, ${when(c.notAfter)}`}>cert {daysText(c.days)}</span>
    {unread}
  </>;
}
