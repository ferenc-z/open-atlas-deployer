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
| What needs doing on one service now | `get_service_health {id}` | **start here**: verdict, to-dos worst first (rule, severity, since, member, evidence, template cause, actions), one row per node, preventive risks |
| Why did it misbehave in a window | `investigate_service {id, member?, from?, to?, focus?}` | the Deployer's evidence cards (restarts and OOM, bulletins by component, new or surging log patterns, metrics off the day-before baseline, changes in the 24 h before), weighted high to none; take a to-do's `member`, `since` and `rule` as `focus` |
| Where did a piece of business data go | `trace_business_data {id, file_name? / email_from? / email_subject?, business?, from?, to?}` | across services by the business models; verdict completed / failed / stuck / handover-lost / insufficient with where it stopped. Prefer it to raw provenance when the person speaks of a file, an email or a business |
| Has this happened before | `list_service_cases {id, rule?}` | earlier AI analyses with the **outcome people wrote**; cite a matching one |
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
| Does the server still have what is kept? | `get_service_drift {id}`, then `{id, member}` for the changed lines | `known: false`: some member cannot tell (its `reason` says why); never read that as "no drift". A person adopts a drifted file, or writes back what is kept, on the Changes tab |
| Was it applied or restarted from here? | `list_service_changes {id}`, `get_service_change {id, change}` | `active` holds the service while it runs or waits for a person (`stopped`: read `message`). Changes made by hand on the host are not listed: say you do not know about those |
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

## Bulletins: node events or a processor failing

- A bulletin whose category or source is `FLOW_CONTROLLER` (or the cluster coordinator) is a **node connection event**: a node disconnected, reconnected, missed heartbeats, the coordinator changed. Count it as a node or cluster problem (look at `get_cluster_status`, `list_events`, the ZooKeeper and heartbeat log lines), never as a processor error.
- A processor's (or port's, controller service's) error has that component as its source, with its id and group: that is the flow failing. `investigate_service`'s bulletin card groups both by source; say which kind each is.

## Service case (the pages' "Let the AI analyse", a CRIT alert)

The first message holds the evidence (an investigation, a trace answer, or an alert with its investigation) and earlier cases of the same service and rule. Then:

1. Read the cards by weight (high first; the weight is a priority, not a verdict) or the trace's verdict and where it stopped. Use `get_service_health`, `investigate_service`, `trace_business_data`, `search_logs` and the others only for what the evidence leaves open; keep the windows tight.
2. If an earlier case matches (same rule, same node or component, same pattern), say so and use what its outcome says people found.
3. Separate what the evidence shows from what you infer; when it does not show the cause, say so and lower the confidence.
4. Change nothing. A configuration change you may draft (`draft_service_config`, see below) and put in `proposals` as `{"kind": "config", "draft": "<id>"}`; a start, stop or restart you only propose (`{"kind": "restart", "members": ["<member key>"]}`): the page shows it as a card that opens the plan on the Changes tab, where a person confirms it.
5. End with the single JSON block the message asks for (`cause`, `evidence`, `next`, `confidence`, `proposals`), the strings in Chinese. Follow-up questions in the same session: answer in Markdown, briefly, no JSON needed.

## Turning a sentence into trace conditions

When asked to turn a person's sentence into trace conditions (the Data trace page), reply with **only** the JSON block asked for: no tools, no text before or after. The message gives the current time and a calendar of the days around it, worked out by the Deployer: read dates from it, do not work out weekdays yourself.

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

`draft_service_config` refuses secrets (`config/secret-by-person`) and drafts nothing, so leave them out and draft the rest. Tell the person which key to enter themselves on the Configuration tab. Saving and applying are only on the page: the person saves the draft as a revision on the Changes tab, then looks at the plan for applying it and confirms it there. You do neither.

## Rules

- Say "as of" with every state: the samples have a time (`asOf`); an executor offline means you do not know the current state.
- Quote log lines and bulletins with node and time, a few at most; summarize the rest by count.
- `[hidden]` and `(hidden)` are redacted secrets. Never ask for them, guess them or tell people how to read them.
- Besides a draft, nothing can be changed from here: saving and applying configuration, restarts and threshold changes are done on the page by people with the right role. `open_service_change` is the only card for services, and only with a draft you just made.
