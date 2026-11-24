// S39 business-registration §7.4 (step 2): the real "read a group now". It hands the service executor's nifi-groups job
// (step 1) to the first member whose executor names nifi-groups@1 and answers; the next member when one fails. The
// registration code (registration.ts) only knows the GroupReader interface.

import { newJobId, type Handoff } from "../handoff.ts";
import type { ServiceLogs } from "./logs.ts";
import type { Topology } from "./flowcounts.ts";
import { RegError, type GroupInfo, type GroupReader, type GroupScan } from "./registration.ts";

/** The capability a service executor names when it can read groups now (service executor 0.9.7). */
export const GROUPS_READ_KIND = "nifi-groups@1";

export class HandoffGroupReader implements GroupReader {
  private handoff: Handoff;
  private logs: ServiceLogs;
  private opts: { waitMs?: number; pollMs?: number };

  constructor(handoff: Handoff, logs: ServiceLogs, opts: { waitMs?: number; pollMs?: number } = {}) {
    this.handoff = handoff;
    this.logs = logs;
    this.opts = opts;
  }

  async read(service: string, ids: string[]): Promise<GroupInfo[]> {
    return (await this.scan(service, ids)).groups;
  }

  /** The groups and the answer's scoped topology (§7.4: exactly these groups, one hop out). */
  async scan(service: string, ids: string[]): Promise<GroupScan> {
    const members = this.logs.members(service);
    if (!members) throw new RegError("register/unknown-address", `No managed service ${service}.`);
    const online = members.filter((m) => m.executor.online);
    if (!online.length) throw new RegError("register/executor-offline", `No member of ${service} has a service executor online (${members[0]?.executor.reason ?? "none"}); groups are read through it.`);
    const usable = online.filter((m) => {
      const kinds = this.handoff.executor(m.host, "service").heartbeat?.kinds;
      return Array.isArray(kinds) && kinds.includes(GROUPS_READ_KIND);
    });
    if (!usable.length) throw new RegError("register/executor-old", `No member of ${service} has a service executor that reads groups (its heartbeat does not name ${GROUPS_READ_KIND}): upgrade it to 0.9.7 or later first.`);

    const waitMs = this.opts.waitMs ?? 40_000;
    let last = "";
    for (const m of usable) {
      const id = newJobId("nifi-groups");
      try {
        this.handoff.submit(id, { kind: "nifi-groups", member: m.key, groups: ids, timeoutSeconds: 30, requestedBy: "deployer", expiresAt: new Date(Date.now() + waitMs + 5_000).toISOString() }, m.host, "service");
      } catch (error) { last = `${m.label}: ${(error as Error).message}`; continue; }
      const status = await this.handoff.awaitJob(id, waitMs, this.opts.pollMs ?? 200);
      if (!status) { last = `${m.label}: the service executor did not answer in time (job ${id})`; continue; }
      // A refusal is about the request (a bad id, too many): the next member would refuse it too.
      if (status.state === "refused") throw new RegError("register/bad-request", `${m.label}: ${status.message ?? "the request was refused"}`);
      const result = status.result as { groups?: unknown; topology?: unknown } | undefined;
      const groups = result?.groups;
      if (status.state !== "succeeded" || !Array.isArray(groups)) { last = `${m.label}: ${status.message ?? (status.state === "succeeded" ? "the answer has no groups" : status.state)}`; continue; }
      const t = result?.topology as Topology | undefined;
      return {
        groups: groups.filter((g): g is GroupInfo => Boolean(g) && typeof (g as GroupInfo).id === "string" && typeof (g as GroupInfo).exists === "boolean"),
        topology: t && typeof t === "object" && Array.isArray(t.groups) ? t : null,
      };
    }
    throw new RegError("register/executor-offline", `No member of ${service} could read the groups: ${last}.`);
  }
}
