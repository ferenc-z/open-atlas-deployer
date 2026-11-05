// Shared by the Services pages (list, detail, configuration, takeover): times, member states, conf directories.
import type { Finding, MemberStatus, RegisteredService, ServiceSummary } from "./api.ts";

export const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { hour12: false }) : "—");

export const STATE: Record<MemberStatus["state"], { label: string; tone: string; title: string }> = {
  running: { label: "Running", tone: "ok", title: "Running at the host's newest discovery" },
  stopped: { label: "Stopped", tone: "bad", title: "Found but not running at the host's newest discovery" },
  "not-found": { label: "Not found", tone: "warn", title: "The host's newest discovery did not see this installation (not running, or not in a scanned directory)" },
  unknown: { label: "Not discovered", tone: "muted", title: "No finished discovery on this host yet" },
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
  return <span className={`badge ${tone}`} title="Running at each host's newest discovery (phase 1 has no live probes)">{s.running}/{s.members} up</span>;
}

/** The executor and version notes beside the up badge. */
export function StatusNotes({ s }: { s: ServiceSummary | null }) {
  if (!s) return null;
  return <>
    {s.executorsOnline < s.members && <span className="badge warn" title="A member's service executor is offline: its state is as of the last discovery">{s.members - s.executorsOnline} executor offline</span>}
    {s.versionsSeen.length > 0 && <span className="badge warn" title="Discovery saw a version different from the registered one">seen {s.versionsSeen.join(", ")}</span>}
  </>;
}

/** Phase 1 has no alerts: the takeover's node differences (a cluster) stand in for them. */
export function DifferenceBadge({ s, cluster }: { s: ServiceSummary | null; cluster: boolean }) {
  if (!s || !cluster) return null;
  return s.differences
    ? <span className="badge warn" title="Configuration differences between the nodes found at takeover">{s.differences} node difference{s.differences > 1 ? "s" : ""}</span>
    : <span className="badge muted" title="No configuration differences between the nodes at takeover">No node differences</span>;
}
