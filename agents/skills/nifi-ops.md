---
name: nifi-ops
description: Looking into the NiFi clusters and standalone instances the Deployer manages - status, alerts, events, metrics, bulletins, logs, configuration, node differences, FlowFile provenance and property meanings - with the Deployer's read-only service tools, and drafting a configuration change for a person to review.
---

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
| What changed between two revisions | `diff_service_config {id, from?, to?, member?}` | either one is enough: `to` alone compares it with the revision it came from; a changed secret is only named |
| Does the server still have what is kept? Was it applied or restarted from here? | `get_service_drift {id}`, `list_service_changes {id}`, `get_service_change {id, change}` | not there yet: drift answers `known: false` and the list is empty. Say you do not know; never read that as "no drift" |
| Where did a FlowFile go, where did it stop? | `search_provenance {id, uuid or field+value, from, to}` → `get_lineage {id, uuid, node?}` → `get_provenance_event {id, eventId, node?}` | NiFi provenance (the FlowFile trace); a time range is required, keep it tight; on a cluster pass the event's `clusterNodeId` as `node` for lineage and event |
| What a property means, its default, restart needed? | `lookup_property {service, key}` or `{version, q}` | answer by the service's version; `otherVersions` = the key exists in another version only |

## The overall picture first, then drill down (design §9.4)

- "How is it doing / 整体怎么样", "which cluster has the worst queue / 哪个集群积压最严重": answer from the Deployer's **samples**: `list_service_clusters`, `get_cluster_status`, `list_alerts`, `get_metrics` (fields `queuedCount`, `bpFull`, `bpMaxPct`, `heapPct`, `repoContentPct`, `diskPct`). They are at most a minute or two old and cost NiFi nothing.
- Only when the question is about **one component** (a queue, a processor, a process group) go further: through Studio's `nifi-ops` graph, the `mcp__open-atlas-nifi-ops__*` tools. Each service has its own entities, `nifi.<service>.<object>` (e.g. `nifi.n112.processor`, `nifi.prod-c1.connection`); `list_entities` shows them. Then `execute_eql`:
  - the flow controller (no input): `[:nifi.<s>.controller/queued-count :nifi.<s>.controller/running :nifi.<s>.controller/invalid]`;
  - one process group, one level at a time, `"root"` for the top, named by an ident join: `[{[:nifi.<s>.pg/id "root"] [:nifi.<s>.pg/name {:nifi.<s>.pg/groups [:nifi.<s>.pg/id :nifi.<s>.pg/name :nifi.<s>.pg/queued-count]} {:nifi.<s>.pg/connections [:nifi.<s>.connection/name :nifi.<s>.connection/queued-count :nifi.<s>.connection/percent-use-count]} {:nifi.<s>.pg/processors [:nifi.<s>.processor/name :nifi.<s>.processor/run-status]}]}]`, then the child group's id to go down;
  - cluster nodes `{:nifi.<s>.node/all [...]}`, each node's JVM and disks `{:nifi.<s>.jvm/nodes [...]}` (a standalone's are on the controller), the bulletin board `{:nifi.<s>.bulletin/recent [...]}`.
  Each call goes to NiFi through nginx (two at a time, 5 seconds): walk down from the group the samples or bulletins point at, not the whole flow. Times are in NiFi's time zone (`controller/timezone`). Without these tools (the package was published without the graph), say the Deployer does not show components and name what the samples do show (e.g. how many connections are at back pressure and the fullest one's percentage).
- Never query NiFi component by component to answer an overall question.

## Typical investigations

- **A node disconnected / 节点断开**: `get_cluster_status` (which node, as of when, the coordinator's view) → `list_events` around that time (restart? version change?) → `search_logs {levels: [WARN, ERROR], from: 10 min before, to: 5 min after}` for heartbeats, ZooKeeper (`ConnectionLoss`, `Curator`, `Unable to determine leader`) and OutOfMemory → `get_metrics {fields: [heapPct, gcMsPerMin, cpuPct], range: 6h}` for memory pressure before.
- **No coordinator / ZooKeeper errors**: the ZooKeeper alert says how many came from bulletins and from `nifi-app.log`; ZooKeeper itself is not managed here (S22): say what NiFi reports and that ZooKeeper must be checked by operations.
- **Back pressure / 积压**: `get_cluster_status` → `summary.backpressure` (the newest reading: connections at their threshold, the fullest percentage, the most congested queues by name and group; read every 5 minutes by default, so it can be that old); `get_metrics {fields: [queuedCount, queuedBytes, bpFull, bpMaxPct, activeThreads]}` for how long it has lasted; `get_bulletins {level: ERROR}` for the processor downstream of the congested queue that fails.
- **Disk / repositories**: `get_metrics {fields: [repoContentPct, repoFlowfilePct, repoProvenancePct, diskPct], range: 2d}`; say the trend (how fast it grows), not only the value.
- **A FlowFile did not arrive / 文件没到下游**: `search_provenance` by its `uuid` (or `field: Filename`) in the hour around when it should have arrived → the last event says where it stopped (`DROP`/`EXPIRE` = removed, `ROUTE` with relationship `failure` = a processor failed it, no event after the last component = still queued there) → `get_lineage` with the event's `node` for clones, splits and merges → the logs (`search_logs` around that event's time, the component's id as query) and `get_bulletins` of that component. Provenance is read from NiFi through the Deployer's service executor (not Studio); at most 100 events per search, so narrow by time or field when `limitReached`. `get_provenance_event` gives the FlowFile's attributes (the monitoring identity may view the data; `attributesHidden` only where a NiFi does not grant it), with secret-looking values hidden; content is never read.
- **Certificates**: `get_cluster_status` lists every certificate with its expiry; renewals are done by operations.
- **"Why is this setting different on node2"**: `diff_service_config` → `lookup_property` for the key (scope cluster means the nodes must agree).

## Changing a configuration

"把 prod-a 的堆调到 8g", "raise the banner text": you write a **draft**, a person does the rest.

1. `get_service_config {id, file}` for the current value and revision, `lookup_property {service, key}` for what the key means and the valid values for this version. `bootstrap.conf` heap is `java.arg.N` lines (`-Xmx`, `-Xms`).
2. `draft_service_config {id, changes, note, base, request_id}`. On a cluster without `member` the change is for all nodes; if `diff_service_config` shows the key differs between nodes, give each node's `member`.
3. Say what the answer means, in the person's words: the findings as they are (an error holds up applying, nothing holds up saving), and `restart`: `none`, `restart` (a standalone instance stops and starts), `rolling` (one node at a time; the cluster stays up), or `whole-cluster` (`fullBecause`: **the whole cluster stops**; say so plainly).
4. End with the card, with the change and its consequence and no secret value:

````
```app-actions
{"actions":[{"operation":"open_service_change","label":"Review the draft · prod-a","payload":{"service":"prod-a","draft":"cfg-..."},"display":[{"label":"-Xmx (bootstrap.conf)","before":"4g","after":"8g"},{"label":"When applied","after":"Rolling restart"}]}]}
```
````

`draft_service_config` refuses secrets (`config/secret-by-person`) and drafts nothing, so leave them out and draft the rest. Tell the person which key to enter themselves on the Configuration tab. Saving and applying are only on the page; applying a revision is not there yet, so do not promise it.

## Rules

- Say "as of" with every state: the samples have a time (`asOf`); an executor offline means you do not know the current state.
- Quote log lines and bulletins with node and time, a few at most; summarize the rest by count.
- `[hidden]` and `(hidden)` are redacted secrets. Never ask for them, guess them or tell people how to read them.
- Besides a draft, nothing can be changed from here: saving and applying configuration, restarts and threshold changes are done on the page by people with the right role. `open_service_change` is the only card for services, and only with a draft you just made.
