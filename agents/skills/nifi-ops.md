# Skill: NiFi operations

How to look into the NiFi clusters and standalone instances the Deployer manages. Answer in the person's language, conclusion first, then a short table, then one `Source / 来源` line naming the tools and the key evidence (an alert, a log line with its node and time, a metric with its value).

## Where each kind of fact comes from

| Question | Tool | Notes |
|---|---|---|
| What is there, which version, how many up | `list_service_clusters` | one row per cluster or standalone; ids for everything below |
| One service now: members, running or not, as of when, cluster connection, certificates | `get_cluster_status {id}` | `members[].key` is the member key the other tools take; `state` lost = its executor is offline, unknown = no recent sample |
| What is wrong now | `list_alerts` (all services) or `list_alerts {id}` | open first; CRIT before WARN; `member` `*` = the whole service |
| What happened before | `list_events {id, from?, to?}` | restarts, disconnects, version changes, threshold changes, alerts; **look at what changed just before a problem** |
| How it has been doing | `get_metrics {id, range, fields?}` | per member last / min / max / avg; `series: true` only when the shape over time matters |
| NiFi's own warnings | `get_bulletins {id, level?}` | last 2 days; source component and node |
| Log lines | `search_logs {id, from, to, levels?, query?}` | all nodes at once, merged by time; keep the window tight |
| The newest lines of one file | `tail_logs {id, member?, lines?}` | a snapshot, not a stream; member can be left out for a standalone |
| Configuration | `get_service_config {id, member?, file?}` | the files as kept; secrets read `(hidden)` |
| Nodes disagree? | `diff_service_config {id}` | only differences; error = must agree, warning = should, info = per node by design |
| What a property means, its default, restart needed? | `lookup_property {service, key}` or `{version, q}` | answer by the service's version; `otherVersions` = the key exists in another version only |

## The overall picture first, then drill down (design §9.4)

- "How is it doing / 整体怎么样", "which cluster has the worst queue / 哪个集群积压最严重": answer from the Deployer's **samples**: `list_service_clusters`, `get_cluster_status`, `list_alerts`, `get_metrics` (fields `queuedCount`, `bpFull`, `bpMaxPct`, `heapPct`, `repoContentPct`, `diskPct`). They are at most a minute or two old and cost NiFi nothing.
- Only when the question is about **one component** (a queue, a processor, a process group, a provenance event) go further: through Studio's `nifi-ops` Graph, when you have that tool. Without it, say the Deployer does not show components yet and name what the samples do show (e.g. how many connections are at back pressure and the fullest one's percentage).
- Never query NiFi component by component to answer an overall question.

## Typical investigations

- **A node disconnected / 节点断开**: `get_cluster_status` (which node, as of when, the coordinator's view) → `list_events` around that time (restart? version change?) → `search_logs {levels: [WARN, ERROR], from: 10 min before, to: 5 min after}` for heartbeats, ZooKeeper (`ConnectionLoss`, `Curator`, `Unable to determine leader`) and OutOfMemory → `get_metrics {fields: [heapPct, gcMsPerMin, cpuPct], range: 6h}` for memory pressure before.
- **No coordinator / ZooKeeper errors**: the ZooKeeper alert says how many came from bulletins and from `nifi-app.log`; ZooKeeper itself is not managed here (S22): say what NiFi reports and that ZooKeeper must be checked by operations.
- **Back pressure / 积压**: `get_metrics {fields: [queuedCount, queuedBytes, bpFull, bpMaxPct, activeThreads]}`; `get_bulletins {level: ERROR}` for the processor downstream that fails.
- **Disk / repositories**: `get_metrics {fields: [repoContentPct, repoFlowfilePct, repoProvenancePct, diskPct], range: 2d}`; say the trend (how fast it grows), not only the value.
- **Certificates**: `get_cluster_status` lists every certificate with its expiry; renewals are done by operations.
- **"Why is this setting different on node2"**: `diff_service_config` → `lookup_property` for the key (scope cluster means the nodes must agree).

## Rules

- Say "as of" with every state: the samples have a time (`asOf`); an executor offline means you do not know the current state.
- Quote log lines and bulletins with node and time, a few at most; summarize the rest by count.
- `[hidden]` and `(hidden)` are redacted secrets: never ask for them, guess them or tell people how to read them.
- Nothing can be changed from here: configuration changes, restarts and threshold changes are done on the page by people with the right role. Do not offer cards for services.
