# Changelog

A tag `v<version>` publishes the image and the GitHub release (`.github/workflows/release.yml`); the release notes are
the section of this file under `## <version>`. A version with a `-` (such as `0.1.0-rc.1`) is a pre-release.

## 0.3.0-rc.17

- S41 step 4a: a configuration draft can replace a NiFi's key or trust store whole (`keystore`, `truststore`, binary,
  one node at a time). It is kept sealed like the other files; pages, diffs, the audit and the AI see only its sha256
  and size, never its bytes. Applying, comparing, checks (a store change needs a restart, node by node), drift,
  adopting and rolling back handle it like any other file. A store outside the conf directory cannot be written: the
  plan says to move it into the conf directory first. Service executor 0.9.9: takeover and drift reads include the
  stores where `nifi.security.keystore` / `nifi.security.truststore` name them (`svc-read@3`); it writes a store only
  inside the conf directory, mode 600, owner as before, the old one backed up (`svc-write@2`).
- S40 (S41 step 5): the service executor connects to its NiFi with the certificate chosen for the service from the
  certificate library, the NiFi's own (e.g. `CN=S2S, OU=NIFI`), for reads, the collector, the FlowFile trace and a
  cluster's node disconnect/connect alike; the monitor and operator certificates are gone. The heartbeat's watch
  entries name the bound version only; the executor fetches the PEM chain, key and CA bundle with its own token from
  `GET /executor/v1/nifi-certs/<service>` (only services on its host; another host's or an unknown one is 404) when
  that version changes, and keeps it in memory (the key touches disk only in a mode-600 temporary file while ssl
  loads it). While a change puts another library version's key store on the nodes, that version's CA joins the
  bundle; the client certificate stays the bound one until the binding moves. No certificate chosen: the REST state
  is `no-certificate` and the to-do says to choose one. The takeover draft has a certificate step per item (confirm
  waits for it) and shows the DN, as the certificate has it, to copy into NiFi; the Takeover page lists the policies
  for that one identity (standalone: add it as a user first). Service executor 0.9.10 (`nifi-certs@1`):
  `EXECUTOR_NIFI_CLIENT_CERT/KEY`, `EXECUTOR_NIFI_OPERATOR_CERT/KEY`, `EXECUTOR_NIFI_CA` and
  `EXECUTOR_NIFI_CA_RELAXED` are ignored, with one line at start naming those still set; `VERIFY_X509_STRICT` is
  always off for the NiFi connection (nifi-toolkit CAs do not mark Basic Constraints critical; only the bundle is
  trusted and the host name is checked). The lab's `lab.sh grant` gives the policies to each NiFi's node identity.

### After upgrading

- [ ] Upgrade the service executors to 0.9.9 (the Executors page) before a draft replaces a key or trust store; a
  service taken over before needs its stores read in (a new takeover read) before they can be changed.
- [ ] Before the service executors go to 0.9.10: upload each NiFi's certificate to the certificate library and bind
  every service taken over before to it, and give its DN the policies on the Takeover page (`modify the controller`
  too on a cluster); until then 0.9.10 cannot call that NiFi. Then remove the `EXECUTOR_NIFI_*` certificate lines
  from `service-executor.env`.

## 0.3.0-rc.16

- S39 §7.8 ⑦ (owner 2026-11-25): what a registered shared module receives (an error module's failures) is only the
  module's own health; a business fails only in its own segments. Before, every business sending into an error module
  showed the module's total as its own processing-failed; those open entries close on the next check.
- S39 pre-release UAT (2026-11-25): the sentence "Tell the AI" copies after a refused Register no longer doubles the
  full stops of the server's gap sentences ("…in。；…in。。").
- S39 §7.8 8 and 9 (owner 2026-11-25): a business may end in a shared module, also in a module after a module: a module
  without exits, or one that writes out of NiFi, or one whose exit leads into a module that can end, no longer leaves
  `exit-unregistered` ("模块的出口没有接回…"); only a module whose exits all lead on to unregistered groups does. So a
  business's last group can be taken over into a module. `look topology` with `draft` and `group` reads a group of
  that registration draft, or a neighbor its gaps name, from NiFi now; anywhere else it still shows only registered
  groups. The Deploy Assistant's prompt and the `nifi-ops` skill: a processor that writes out of NiFi is a module's (or
  business's) end and is listed as an exit; making a shared module (also a takeover) is committed by the Assistant
  itself after the owner's yes, nothing waits on the page.
- S39 UAT fixes (2026-11-25): a shared module whose exits only write out of NiFi (an error log, an audit trail, a dead
  letter store) no longer makes every business sending into it report `exit-unregistered`. A schedule whose worker
  names match processors (or groups named like them) in the registered groups now joins the chain as questions
  (`worker-unplaced` with candidates) instead of being left out. Service executor 0.9.8: reading only the registered
  groups, a fragment names up to 200 processors (was 5), so such workers can be offered as candidates. The Register
  page no longer says "This draft is gone" right after registering. The `nifi-ops` skill: a hand-over NiFi does not
  show is recorded only after the owner described or confirmed it (the quote is their words about it), and `look
  topology` shows only registered groups. The business graph draws a shared module once (not also as the old
  "公共环节"). The "登记的组在画布上变了" to-do no longer opens when nothing inside the groups changed (a neighbour
  registered, a group just registered or just added, the executor upgrade); the old "Confirm the flows the AI found"
  to-do is closed once registration is on.
- S39 step 9 (registration is the default): `DEPLOYER_REGISTERED_GROUPS` is now **on by default**; set it to `0` to turn
  it off, an emergency way back to reading the whole canvas. With it on, a service shows only what was registered: a
  service with no registration has no businesses and no gaps. The businesses and models of the old whole-canvas way are
  not carried over: on upgrade clear `flows`, `flow_segments`, `flow_changes`, `flow_anomalies` and `flow_models`
  (nothing is migrated) and register again through the Deploy Assistant. The service executor must be 0.9.7
  (`flow-groups@1`, `nifi-groups@1`), else the gap `executor-old` shows.
- S39 step 7 (monitoring looks at what is registered): with `DEPLOYER_REGISTERED_GROUPS=1`, describe, the brief, the
  business light and the flows page list only registered businesses and shared modules, and the gaps (`no-exit`,
  `s2s-unpaired`, `topology-changed`, `unconfirmed`, `no-stuck-times`) only count their groups; a service with nothing
  registered has no gaps. New gap `executor-old` (the service executor does not name `flow-groups@1`). A registered group
  renamed, gone, with a vanished slice or changed on the canvas opens a to-do `canvas:<owner>` "需要负责人确认" (closes by
  itself). The runtime handover-lost check uses the gate's bucket rule (only buckets both sides have, not the first of
  either). The business graph draws `port:`/`link:` as inside and a module node by its `module`. The check-up no longer
  builds the model: the brief has no skeleton draft or rebuild flag, `look kind model` no `draft`, `run_model` /
  `publish_model` refuse `from: "skeleton"`, `publish_model` refuses to change segments a registration wrote, and
  `service-checkup` loses the model part and the two verbs from its `allowed_tools`.

- Service executor 0.9.7 (S39 step 1, reading only the registered businesses): a watch entry with `groups` (ids of
  process groups at any depth) has only those groups read: each group's recursive status
  (`flow/process-groups/<id>/status`) for the counts, and for the topology each group with its subgroups plus one hop
  out (the connections in its parent that end at its ports: `neighbors`, and `links` between two registered groups;
  an RPG beside it counts as its S2S exit). The topology body says `scope: "groups"`; its groups carry `parent` and
  `path`, and `missing` lists the registered groups NiFi does not have. `groups: []` reads no counts and no topology
  (the machine's numbers as ever); no `groups` key reads the whole canvas as before. The 500-group cap on the whole
  canvas is gone: the round's time budget (20 seconds; with groups 10 + 2 per group, at most 120) is the only limit.
  New read job `nifi-groups` (`nifi-groups@1`): up to 20 groups read now, each with its name, path, ports, ends, S2S,
  sizes, pieces and neighbors, plus the scoped topology. The heartbeat names `flow-groups@1` and `nifi-groups@1`. The
  Deployer gives a cluster's groups to one node (the first whose executor is fresh, names `flow-groups@1` and whose
  NiFi answered) and `[]` to the others. Nothing is registered yet (step 2), so every service is still read whole.

- S39 step 2 (second half): registering reads the group through the service executor's `nifi-groups` job (the first
  member whose heartbeat names `nifi-groups@1`, the next member when one fails; no such executor: `register/executor-old`).
  `registeredGroups(store, service)` reads `flow_registrations` (a business's and a shared module's groups), and is
  `undefined`, never `[]`, for a service with none. **It is off by default**: only `DEPLOYER_REGISTERED_GROUPS=1` makes the
  watch carry `groups`, because the skeleton, the model and the gates still assume the whole canvas (until the chaining,
  step 3, is in) and a service read by groups would lose its counts and topology outside them. Registrations are stored
  either way. Registration drafts (`registration_drafts`, a draft nobody touched for 24 hours goes): `POST
  /api/registrations/drafts` makes one (`rgd_…`), `GET /api/registrations/drafts/<id>` reads it with the last preview, and
  `register` add / remove / rename / declare-handoff with `draft` change only the draft. Preview and commit of a draft
  still answer `register/not-implemented`.

- S39 step 4: `register preview` (a draft's groups, kept on the draft; a business's plus links; or links alone) reads the
  groups now (`nifi-groups` topology), adds e2e_trace's schedule definitions (a note when they cannot be read), the
  shared modules, the told hand-overs and worker places, and answers `chain()`'s preview; no `request_id`. `register
  place-worker` (with `draft` or `flow`; table `worker_places`, `registration_drafts.places`) says where a schedule's
  worker runs, or `outside: true`; `worker-unplaced` gaps carry `worker` and candidate `places` (a registered group with
  a processor of that name, or a similar group name) for the AI to ask about. `register shared` registers a shared
  module (one group; entries = its input ports, S2S or MQ; exits = output ports, S2S sends or ends, with `when`);
  `takeover: true` moves a group a business has into the module (that business and every business joined to it get a
  `shared` history line). `GET /api/registrations/modules` lists modules with their own health (the group's counts in
  the last hour), `GET …/modules/<id>` adds who uses it now; unregistering a module still used answers
  `register/module-in-use`. Nothing is published yet (step 5).

- S39 step 5: a registration takes effect at once, no approval. `register commit` (a draft, which then goes, or `name` +
  `links` + `handoffs?`), and `add` (now with `handoffs?`), `remove`, `declare-handoff`, `place-worker` of a registered
  business, `shared` with `commit: true` and `unregister` chain the registration again on what NiFi has now, refuse
  while a gap is open (`register/gaps-open`, 409, with the gaps; a change to a registered business is refused only for
  gaps it opens), write the chain into the model of every service it touches and publish them all in one transaction
  (model source `register`; a service whose model comes out the same gets no revision). A business's segment is its
  registered group (exits: the hand-overs to its other segments, the modules, told hand-overs with `declared`, the ends;
  entries: its starts, with a file-name cue, and the hand-overs in); a module's segment is `role: "shared"` with
  `module: "shm_…"` and its registered entries and exits. Two registered groups joined on the canvas name the same
  channel on both sides (external `port:<module port id>` or `link:<connection / funnel / schedule step>`): the trace
  follows the data across them under the same key, so it now passes through a module's canvas ports (`declared:` stays
  unfollowed). The model parser keeps `module` and `declared`. The registration gate (`services/register-gate.ts`) judges
  the new models together, on registered businesses only: coverage (every registered group is a segment), reachable,
  no-dangling (told hand-overs are not dangling), s2s-balance (per 5-minute bucket both sides were counted in) and
  no-regression; a refusal (`register/gate-rejected`, 409) names the business, the group and its link or both sides of
  the hand-over. `flows` / `flow_segments` follow the registration (person's name, confirmed, upstream first);
  `GET /api/registrations/modules` gives each module's model `segments`; `flow_changes` rows of one action carry the same
  `op` (new column), one per service with that service's revision. `rename` still changes only the name (the models do
  not carry it). **`DEPLOYER_REGISTERED_GROUPS` stays off by default**: with it on (checked on the lab dev instance) the
  watch reads exactly the registered groups and the registration publishes and gates on that, but the old whole-canvas
  paths (skeleton draft, `publish_model`'s gate, describe's gaps, the business graph drawing `port:` / `link:` as
  outside, the runtime hand-over check on a partial first hour) are not adapted yet (steps 7–9); turning it on is step 9.

- S39 step 6: the eighth MCP verb `register` (people and the Deploy Assistant; not the check-up's key) passes every
  registration action through: `draft` (new, or `flow` for a copy of a registered business), `show`, `preview`, `add`,
  `remove`, `rename`, `declare-handoff`, `place-worker`, `shared`, `modules`, `commit`, `unregister`. A refusal keeps the
  route's details for the AI (`gaps`, `preview`, `problems`, `taken`, `candidates`…). The Assistant's key changes drafts
  only: `commit`, `unregister` and a registered business's changes without a draft answer `register/person-only` (403);
  a person presses Register / confirms on the page. `POST /api/registrations/drafts` takes `flow`: the draft starts as
  that business (groups, told hand-overs, worker places, name; `registration_drafts.flow`, new column), and its `commit`
  applies the difference as one change (chained, refused only for gaps it opens, gated, published; one history line per
  kind). `publish_model` is no longer the Assistant's (internal; whether it leaves MCP is step 7). The Assistant's
  prompt and the Skill `nifi-ops` describe the registration conversation instead of the business model.

- Skills follow the Agent Skills layout OMA reads: `agents/skills/<name>/SKILL.md` (a folder named as the Skill, the
  frontmatter `name` the same), so the folder zips straight into OMA's Skill upload. `bin/publish-assistant.ts` reads
  the folders (a loose `*.md` there is an error); the Skill's text is unchanged, so no new Skill version and nothing to
  republish. `bin/check-oma-notes.sh` does not count a file moved without a change of text.

### After upgrading

- [ ] OMA: republish the Deploy Assistant (`agents/deploy-assistant.md`: `register` in and `publish_model` out of
  `allowed_tools`; the Skill `nifi-ops`: the registration conversation, hand-overs only after the owner described them,
  modules as business ends, `look topology` with `draft`) and the Service Check-up (`service-checkup`: the model part and
  `run_model` / `publish_model` are gone). Run `bin/publish-assistant.ts` against this environment's OMA, then point
  `DEPLOYER_OMA_AGENT` (and the Workbench Business Agent "Deploy Assistant") and `DEPLOYER_OMA_CHECKUP_AGENT` at the new
  agents. Existing conversations keep the old agent: start a new chat.
- [ ] Upgrade the service executors to 0.9.8 (the Executors page; 0.9.7 or later is required for `flow-groups@1` /
  `nifi-groups@1`, else the gap `executor-old` shows). The deploy executor is moved to 0.9.8 as well (no code change) so
  both go out in one executor release.
- [ ] Registration is on by default now (`DEPLOYER_REGISTERED_GROUPS=0` turns it off): clear `flows`, `flow_segments`,
  `flow_changes`, `flow_anomalies` and `flow_models` (nothing is migrated), then register each service's businesses
  again through the Deploy Assistant.

## 0.3.0-rc.15

- `bin/publish-assistant.ts`: `OMA_CONTEXT_WINDOW_TOKENS` / `OMA_CONTEXT_OUTPUT_TOKENS` put the model's context into the agent's metadata (`context_window_tokens` / `context_output_tokens`), for a model OMA's own table does not know (deepseek: OMA fell back to a 32K window and failed compacting).

- Check-up token savings, round 2 (⑰): `run_model` / `publish_model` take `{from: "skeleton" | "current", changes}`
  (assign, share, remove, add-segment, set, add/set/remove-entry and -exit, rekey, note): the Deployer builds the draft
  and answers the gate's result with the built draft in a line per segment, not the model (the whole `model` stays as
  a fallback). `look kind model` gives the drafts in lines (the whole draft with `detail: "full"`); the brief's
  `skeletonDraft` lists the skeleton draft's segments when the model is rebuilt. Every default answer of the service
  verbs stays under OMA's 16 KiB inline limit (a longer one is cut, saying so); `describe {brief: true}` without a
  service gives a line per service when the briefs together do not fit.
- Check-up token savings (⑰): the first message of a check-up the Deployer opens carries each service's brief (the
  lights and the checks that are not healthy, the businesses, to-dos, gaps, the model's state, a topology summary, the
  skeleton draft against the model and its `run_model`); the scheduled one gets it from `describe {brief: true}` (its
  fixed message says so; the OMA schedule is updated by itself). `look` topology / model / provenance / bulletins / logs
  and `describe` answer a summary by default (`detail: "full"`, topology `group`, `offset` for the rest). The Deployer
  keeps the canvas' structural fingerprint with each published model revision: when it is unchanged and nobody gave
  feedback since, the brief says "拓扑未变，沿用已发布模型 rN" and the check-up does not rebuild the model; the gap
  `topology-changed` now needs a structural change. The gate and the skeleton are unchanged.
- `DEPLOYER_CHECKUP_AUTO=off`: turns the automatic check-ups off (pauses the OMA schedule, no machine-red or user-visit starts); Check now and flows feedback still start one. Default on.
- A business holds one change waiting for a person per service, not one in all: the downstream services of an S2S
  fan-out no longer overwrite each other's join, a service's new publish replaces only its own, and confirming the
  business applies each in turn (stops at the first the gate rejects). Old single rows are read as a list of one.
- Refusing a merge sticks: "not right" or "these are two flows" on a business while a merge of it waits drops that
  merge and marks the business as not to be joined (split-asked), so the next check-up does not hold it again.

- Engine test round 2 (2026-11-22/23): service executor 0.9.5 reports, for each S2S sending port, the components whose
  connections lead into it (`s2sOut[].sources`), and the skeleton's draft gives an S2S exit that component and
  relationship (before, every S2S exit was left for the AI to place and the gate refused the drafts). The gate waits for
  the other side of a new S2S hand-over when the other service's model is not on that group yet (two services that both
  had models could not take a new hand-over: neither could publish first). The check-up prompt says how to join the
  skeleton's pieces (across a shared validation step by the routing attribute, two pieces handed over by a directory).
- Engine test round 3 (2026-11-23): what a remote input port received is counted from its status's out (NiFi leaves
  its in at 0), so the S2S balance check and handover-lost no longer see every hand-over as lost (the check-up had
  turned the S2S hops into external ones to get past the gate). The skeleton draft gives each RPG port of a fan-out its
  own target, and exits to a shared step (dead letters) theirs. reachable joins two groups linked only through a shared
  step. The check-up prompt: a directory hand-over is modelled as an `mq` exit and entry.
- Engine test round 5 (2026-11-23): service executor 0.9.6 reports the flow's ends: processors of a writing type (by
  NiFi's naming convention, Put…/Publish…/Post…/Send… and the like; `EXECUTOR_EXIT_TYPES` replaces the pattern) whose
  connections lead nowhere else on the canvas, with the relationships they auto-terminate. The skeleton draft makes
  them the units' external exits, so data written out is not read as dropped. A port several services send to is
  balanced against their sum. The check-up prompt's examples no longer name any particular flow's processors or
  attributes.
- Check-up prompt: a model change is checked with `run_model` in the same check-up, and a gate result or refusal
  reason quotes only what this check-up's `run_model` / `publish_model` returned (check and object); nothing is
  carried over from an earlier analysis ("本次未检查" when it did not run).
- Business skeleton (complex lab flows 2026-11-22): edges to and from a shared step (error handling, audit, dead letters)
  no longer count when deciding whether two segments are one business, so a group that also sends its errors to the
  shared handler still merges with its next group and with the other service's S2S port (before, every such business
  stayed in pieces with a fan-out question). Test bed: `testdata/nifi-complex/` (spec with the right answers,
  `build.py` for the lab NiFis, `seed-cx.sql` for two cross-instance e2e_trace schedules).
- Business discovery from e2e_trace (engine test 2026-11-22): `describe {service}` has the gap `e2e-unplaced` when the
  service has e2e_trace and some schedule is in no service's model, and `look kind model` lists the schedules under `e2e`
  (id `schedule-<n>`, workers, entry, the services whose model places each), so the check-up can publish with
  `source: "e2e_trace"` (before, nothing told the AI the source or the schedule ids). The graph's definitions are the
  environment's, not one service's: a schedule the draft does not place is left out with a note (placing none is still
  refused). e2e-failed works (P3): the Studio graph has a new saved query `e2e_failures` (failure records in a time
  range), the business scan reads it and places a failure on the segment whose step is that worker. Studio graphs made
  with `testdata/e2e-trace/studio-setup.ts` need it run again for the new saved query. A segment from a schedule the
  definitions no longer have shows as gap `e2e-gone` (`e2e.gone`) and loses its e2e origin when republished. Two gate
  fixes: a publish drops what an earlier publish of the service held and it does not hold again (and closes the flows
  to-do when nothing waits); a group of one part given its only fragment's key as slice is the whole group (`*`), not a
  new group plus a gone one; a cross-service business whose part in one service the draft moves to a new business is a
  split waiting for a person (it was read as the same business renamed, so "split" feedback was silently undone). Test data for the definitions changing: `testdata/e2e-trace/change.sql`, `failure.sql`.

- Managed-service pages (UAT feedback 2026-11-22): the sentence beside each light is the AI's. `record` takes
  `analysis.machineSentence` and `analysis.businessSentence` (one plain Chinese sentence each, at most 200 characters)
  and uses `analysis.flows[].sentence` beside each business; the overview and the service page show them while that light
  is still the one recorded with the analysis (and for 6 hours at most), else the rules' sentence. `record` now keeps the
  two lights (and each business's) as they are when it writes, so an analysis is no longer "out of date" right after the
  AI published a model. The rules' business sentence says how many flows wait for confirmation (they do not light the
  lamp); the service page always shows it. The flows to-do the gate opens is one sentence ("AI 识别出 2 条新业务（…）、1 处
  跨服务连接，等你在流程页确认。") under the fixed title "Confirm the flows the AI found". The overview's check-up line reads
  "AI check-up 15:47 · next 19:47" (the prototype), the analysis line "started by Check now"; a card with an AI action
  says "· AI has a plan"; the business card says when you confirmed the flows.

- Ops step 5 (pages-rethink A1): the AI's analyses of the managed services, by the Service Check-up agent
  (`DEPLOYER_OMA_CHECKUP_AGENT`, `_ENVIRONMENT`, `_VAULTS` with its `dpc_` key). Each is a running row in
  `service_analyses` first, then an OMA session whose first message names the analysis ids; the agent writes back with
  `record`; a turn that ends without a record, an error or no answer in time (10 minutes, more for several services)
  fails it. Started by: the scheduled check-up (an OMA agent schedule `deployer-checkup-<environment>` the Deployer
  creates or puts back at start and every 15 minutes, `DEPLOYER_CHECKUP_CRON` default `0 */4 * * *`,
  `DEPLOYER_CHECKUP_TIMEZONE` default `Asia/Shanghai`; its records make one round), a machine light turning red, a
  person opening the overview or a service page while a service is not green and its analysis is out of date (at most
  once a service an hour), `POST /api/services/:id/analyses` (Look again now), `POST /api/analyses` (Check now, one
  round), `GET /api/analyses/:analysis`, and "These are two flows" / "Not right" on the flows page (flows-feedback). The
  daily brief waits up to an hour for the morning check-up and carries its conclusions. The overview's `nextCheckAt` is
  the schedule's next run.

- Ops step 4 (pages-rethink §9.1 C3, §10.2.3): the managed-service MCP is seven verbs — `describe` (the machine and
  business lights, the businesses, open to-dos, the newest AI analysis, the model's gaps, each with the verb that fixes
  it), `look` (raw data by `kind`: metrics, logs, provenance, lineage, event, bulletins, queues, members, topology,
  flow-counts, events, evidence, components, config, config-diff, drift, changes, property, model), `trace`,
  `run_model`, `publish_model`, `record` (the AI's analysis and to-dos, a to-do with at most one suggested action) and
  `draft_change` (was `draft_service_config`). The 22 old service tools are gone (`list_service_clusters`,
  `get_cluster_status`, `get_metrics`, `list_alerts`, `list_events`, `get_bulletins`, `search_logs`, `tail_logs`,
  `search_provenance`, `get_lineage`, `get_provenance_event`, `get_service_config`, `diff_service_config`,
  `draft_service_config`, `list_service_changes`, `get_service_change`, `get_service_drift`, `lookup_property`,
  `get_service_health`, `investigate_service`, `list_service_cases`, `trace_business_data`). A new key kind, the
  check-up's `dpc_` (made by an administrator, `POST /api/keys {kind: "checkup"}`), sees the verbs but not
  `draft_change`; the Assistant's `dps_` may also `publish_model` and `record` to-dos (only to-dos); for a personal key
  both are for administrators. New tables `service_todos` and `service_analyses`; the gate's to-dos go to
  `service_todos`; `POST /api/todos/:todo/state` and `POST /api/todos/:todo/draft` (a to-do's change drafted as the
  person). `POST trace-business-data` is now `POST /api/services/:id/trace`. The cases are gone (their five routes, the
  CRIT alerts' own analysis; `service_cases` is kept but no longer used).
- S37 step 9 (Q4, S9): "Let the AI analyse" on the Investigate and Data trace tabs sends the page's result (the
  investigation worked out again compact and redacted; the trace answer trimmed and redacted) to the Deploy Assistant
  in a background OMA session; the answer comes in three parts (likely cause, evidence, next steps) and the person can
  ask follow-up questions in the same session. A CRIT alert opened within the hour is analysed once by itself, at most
  3 a service an hour; the conclusion shows with the alert (`analysis` on alert views). Every analysis is a case (table
  `service_cases`: evidence, answer, conversation, the outcome a person writes; `/api/services/:id/cases`); the prompt
  carries the newest cases of the same service and rule, and the new read-only MCP tool `list_service_cases` reads
  more. What the AI proposes to change is a card: a configuration draft opens on the Changes tab, a start, stop or
  restart shows its plan there for a person to confirm. The Data trace's "Investigate" button opens the Investigate
  tab on the node and time where the data stopped. A trace source that cannot be asked a key (provenance and a key its
  NiFi does not index) is skipped quietly; only when no source could be asked does "insufficient evidence" say so.
- S37 step 3: a service page opens on a new Status tab: verdict, the to-do list with next-step buttons, the node strip
  (Start, Restart, Stop with a plan first), preventive risks and the newest changes and restarts, all from
  `GET /api/services/:id/health`. The Business model tab is read-only for non-admins (`canEdit` in the model response).
- S37 step 2: `GET /api/services/:id/health` and the MCP tool `get_service_health` give a service's to-do list (rule,
  severity CRIT/WARN/INFO, since, member, evidence, template cause, actions), a verdict and one row per node. Two new
  findings-only rules: collection incomplete (REST reading not ok, or a member not found in NiFi's node list) and
  preventive risk (disk full in days, heap baseline rising, a certificate expiring within 90 days). The tool is not
  in the Deploy Assistant's whitelist yet (step 9).
- D52: the Onboarding Assessor's `draft_*` tools answer with a receipt (`{ok, operation, target, changes}`) instead
  of the whole assessment, which made OMA fail with a context-too-large harness error. New read-only tool
  `get_draft` (draft, manifest, findings); `draft_env_key` takes `keys` to write several env keys in one call
  (all or none); a version assessment's first message carries the manifest it starts from.
- Overview redesigned (prototype of 2026-11-19): "Needs you" first (offline executors, upgrades, a newer Deployer,
  one button each), then the apps, then "Hosts & executors" (each host's deploy and service executor side by side)
  beside the services and the brief. A host shows only the executors it has: one with only a service executor no
  longer shows an offline deploy executor (same rule as the Hosts page).
- The deploy and the service executor have their own shipped versions (`EXECUTOR_VERSIONS` in `handoff.ts`, each
  executor's `VERSION`); each is offered an upgrade only when its own version moved. A change to `executor_core.py`
  moves both. Each archive goes to the release `executor-v<its version>`. `/api/platform` adds `shippedVersions`,
  `hosts` and each row's `shipped`; `/api/hosts` adds `executorVersions`.
  This release ships deploy executor 0.9.3 (unchanged) and service executor 0.9.4.
- Slow Overview on servers that cannot reach GitHub (or the UAT Deployer): a failed version list is cached for a
  minute instead of being fetched (8 s timeout) on every 10-second refresh; an older list is returned at once while
  a fresh one is fetched; a failed release check and an unreachable UAT are cached the same way.
- S34: a cluster member's JVM, flow and repository numbers no longer stay empty when its NiFis share one port (a NiFi
  per machine) and the member's recorded node address is written differently from the API address NiFi lists (an IP,
  a short name, none). Service executor 0.9.4 finds its own node by port and its names or a local address and sends
  `nifi.selfNodeId`; the Deployer reads the node by that id (the Metrics tab, live states, a rolling restart's
  "node connected" check). With an older executor it matches port and address as before, now case-insensitively,
  and a point it cannot match carries `_unmatched`.
- S37 step 5 (S38): the business data trace's core. A service's page has a "Business model" tab: businesses with
  match rules, ordered steps bound to a NiFi component (found by name through the service executor; executor 0.9.4
  adds the read-only `flow-search` op), entry and exit endpoints by channel (S2S, MQ, external) and on entries which
  field a clue is searched by. Exits join other services' entries with the same channel; unmatched ones show as
  dangling. `POST /api/services/:id/trace-business-data` runs the trace engine; no evidence source is connected yet.
- S37 step 6: NiFi provenance is the trace's first evidence source, for every NiFi version: a file found by name at an
  entry, followed step by step and over S2S (the receiver's RECEIVE names the sender's FlowFile as its source; when it
  cannot be paired, the same file name within 2 minutes, marked inferred), "expired" judged by each node's oldest
  event. The provenance search and the trace now accept NiFi 1.9 and later of 1.x (S33); the component search for
  model positions works on any version. A model may leave its sources out (provenance then, after any source asked by
  business keys); steps get 600 s by default; a stuck verdict says the queue, back pressure and whether the next
  processor runs; a dangling exit names the model that lacks the entry; an external exit or entry says where NiFi's
  part ends. Service executor 0.9.4: provenance with attributes and the `oldest` op, back pressure names queue ends
  and processors not running.
- S37 step 7: the e2e_trace evidence source. A service gets it when an admin sets a Studio Graph and a graph token
  in the Business model tab (pasted, or issued through the Builder MCP; kept sealed); the Deployer reads the run
  records through Studio's data plane (new setting `DEPLOYER_STUDIO_DATA_URL`) with the graph's saved queries only,
  always with a time range. MQ hops follow `correlation_id`; a step missing from the run records while a later one
  is there is reported as incomplete, so the next source is asked. A worker's historical P95 (7 days, 20 runs, at
  least 60 s) is its allowed time. "Import businesses from e2e_trace" turns schedule_header/schedule_detail into
  businesses in the editor. The graph's contract and saved queries: `src/server/services/trace/e2e-graph.ts`.
- S37 step 4: a service page's "Investigate" tab gathers the evidence of a window (at most 24 hours) without AI:
  process starts, stops, disconnections and out-of-memory signs; bulletins by component with "Open in NiFi" (the
  component selected); WARN/ERROR log patterns new or surging against the same hours a day before; metrics far from
  that baseline (with the curve); configuration changes, Deployer changes and drift of the 24 hours before. It starts
  from a to-do (the Status tab's "Investigate" now opens it), an alert, or a node and a window. Same body from
  `GET /api/services/:id/investigate` and the MCP tool `investigate_service` (compact, redacted; not in the Deploy
  Assistant's whitelist yet, step 9). Bulletins now keep their component and process group ids.
- S37 step 8: a service's Data trace tab for "my data did not arrive". Clues (business, file name, email sender and
  subject, a time range, the last 24 hours by default) give the end-to-end steps across services, each with state, node,
  time, evidence source, "inferred" where it is a guess and the allowed time; the step where the data stopped is
  highlighted, the verdict's message, its queue / back pressure / downstream context and its actions are buttons (edit
  the other service's model, Open in NiFi), and evidence cards link into NiFi. A sentence in the box on top is read into
  the conditions by a one-shot Deploy Assistant session (only the sentence, the business names and the time go out; no
  answer in 5 seconds means the plain form). New read-only MCP tool `trace_business_data` (not on the Assistant's
  allow-list until step 9).

### After upgrading

- [ ] OMA: publish the Service Check-up, the Deploy Assistant and the Onboarding Assessor again (`agents/*.md`, the Skill
  `nifi-ops` and the templates changed since 0.3.0-rc.14: the seven service verbs, changes instead of whole models, summaries,
  the check-up's record fields, `get_draft` / `keys` for the Assessor). Run `bin/publish-assistant.ts` for each against this
  environment's OMA (`OMA_CONTEXT_WINDOW_TOKENS` / `OMA_CONTEXT_OUTPUT_TOKENS` put the model's context into the agent), then
  point `DEPLOYER_OMA_CHECKUP_AGENT`, `DEPLOYER_OMA_AGENT` (and the Workbench Business Agent "Deploy Assistant") and
  `DEPLOYER_OMA_ASSESSOR_AGENT` at the new agents. An environment with no Service Check-up agent yet creates it
  (`bin/publish-assistant.ts … service-checkup`, with a `dpc_` key in its Vault) and sets `DEPLOYER_OMA_CHECKUP_AGENT`,
  `DEPLOYER_OMA_CHECKUP_ENVIRONMENT` and `DEPLOYER_OMA_CHECKUP_VAULTS`. Not published to PROD automatically (D47).
- [ ] Upgrade the service executors to 0.9.6 (the Executors page) so clusters on one port get their numbers, and the skeleton
  places S2S exits and the flow's ends. The deploy executor is moved to 0.9.6 as well (no code change) so both go out in one
  executor release.

## 0.3.0-rc.14

- D51: a first install starts from the defaults: when the first import finds no env file on the server and the
  manifest uses a template the Deployer keeps (an assessment's), a revision with the template's defaults (never
  secrets) is saved on top of the import, for a person to check and write. A repository's `.env.example` is not used
  for this: its values are samples.
- `draft_env_key` takes `optional` (the app runs without it); the assessment's template writes such a key as
  `#KEY=`, so the env page shows it as optional instead of missing. Before, every key of an assessment's template
  counted as required.

### After upgrading

- [ ] OMA: republish the Onboarding Assessor (`optional` for env keys), then set `DEPLOYER_OMA_ASSESSOR_AGENT` to the
  new agent.

## 0.3.0-rc.13

- D51: an app whose manifest declares no env file still has one in UAT, `<app>.env`, without a template: Environment
  variables (and the MCP env tools) import, edit and write it as usual, with keys added by hand. Once the first write
  succeeds, the Deployer saves a manifest revision that names the file and has every compose service read it
  (`manifest.env-added` in the audit log); the containers read it from the next deploy. In PROD such an app still has
  no env file until the manifest comes from UAT.
- The Onboarding Assessor declares every variable an operator may need to change, defaults included.

### After upgrading

- [ ] OMA: republish the Onboarding Assessor (env keys with defaults are declared too), then set
  `DEPLOYER_OMA_ASSESSOR_AGENT` to the new agent.

## 0.3.0-rc.12

- An MCP command's `request_id` replays the earlier answer only for the same tool with the same arguments; a reused
  `request_id` with other arguments (for example another assessment's task token) is refused with
  `mcp/request-id-reused` instead of returning the other call's answer.

## 0.3.0-rc.11

- The Overview's app list links each deployed app that has an ingress ("Open ↗", a new tab); `/api/status`
  returns the URLs as `urls`.

## 0.3.0-rc.10

- A published image is never level C for want of the Deployer's registry setup (design D50): a private image counts
  as published. In a registry the environment lists → A (pull credentials live on the executors, which the
  Onboarding Assessor cannot see); in a registry or namespace it does not list → B, the draft names a new registry
  and the report starts with the administrator's step (register it in Environment settings, give the executors pull
  access). `draft_report` refuses A while a component's registry is not registered (`draft/registry-unregistered`).

### After upgrading

- [ ] OMA: republish the Onboarding Assessor (level table rows for published images; `draft_source` describes
  unregistered registries), then set `DEPLOYER_OMA_ASSESSOR_AGENT` to the new agent.

## 0.3.0-rc.9

- The Onboarding Assessor writes its report and issues in Chinese: the Deployer's first message says so, since its
  English task lines made some models answer in English. Golden cases (`bin/golden.ts`): the Assessor's sessions can
  run in their own environment (`GOLDEN_ASSESSOR_ENVIRONMENT`, one sandbox per session), a report not in Chinese
  fails, quoted text in a shell line is not taken for a command, and a capability issue is allowed for dossier-clj.

### After upgrading

- [ ] OMA: republish the Onboarding Assessor (the report language line), then set `DEPLOYER_OMA_ASSESSOR_AGENT` to
  the new agent.

## 0.3.0-rc.8

- Executor 0.9.3, a plain Dockerfile build (design D49): a component's `source.build` is either
  `{script: "build-images.sh"}` (the release tools, the repository has `tools.lock`) or `{dockerfile, prefix?}`.
  The executor puts the tag's files (`git archive`, under `prefix` when the Dockerfile copies `apps/<name>/...`)
  into an empty context and runs `docker build` with the labels `org.open-atlas.app/version/commit`, then pushes.
  Nothing from the repository runs on the host: its own build scripts never run; the Dockerfile runs only in
  BuildKit's build containers (no `--ssh`, `--secret`, host network). The image is `open-atlas-<app>` or
  `open-atlas-<app>-<component>`. A repository without `tools.lock` but with a self-contained Dockerfile (a
  multi-stage `mvn package`, for example) is now deployable instead of level C.
- The agents' prompts hold less to the model's judgement, so different models reach the same result: the
  Onboarding Assessor follows fixed steps and a level table, and the server holds its rules (`draft_report`
  refuses `unchanged` outside a version assessment, A/B without a draft that passes `validate_draft`, C/D with
  components in the draft, C without an onboarding issue; a failed assessment takes no more changes). Golden cases
  for both agents against a real OMA: `node bin/golden.ts <assistant|assessor|all>` (`golden/cases.ts`).
- The Deploy Assistant can read service configuration changes and drift: `list_service_changes`,
  `get_service_change`, `get_service_drift`, `draft_service_config` join its allowed tools.

### After upgrading

- [ ] Upgrade the executors to 0.9.3 before deploying a manifest with `build.dockerfile`: 0.9.2 refuses it.
- [ ] OMA: republish the Deploy Assistant (four service configuration tools in its allowed tools), then point
  `DEPLOYER_OMA_AGENT` and the Workbench Business Agent at it. Open a new chat afterwards.
- [ ] OMA: republish the Onboarding Assessor (new steps and level table: a self-contained Dockerfile is A; `draft_source`
  describes `build.dockerfile` and `prefix`), then set `DEPLOYER_OMA_ASSESSOR_AGENT` to the new agent.
- [ ] Re-assess repositories rated C only for "no tools.lock" (dossier-clj).

## 0.3.0-rc.7

- The Deploy Assistant knows what is open on the page: the assessment on Onboarding, the service on Services, the
  app on Environment variables and Apps & manifests (page context `assessment`, `service`, `app`). It can read
  assessments: new read-only MCP tool `list_assessments`; `list_assessments` and `onboarding_draft` are in its
  allowed tools.
- Assessments need the Deployer's read-only SSH key (`DEPLOYER_GIT_SSH_KEY_FILE`, design D46): without it the page
  says so and refuses to start one (`assessment/no-git-key`), instead of letting the sandbox clone, which fails
  behind a company proxy (no CA, no credentials) and produced a misleading level C report. The Onboarding Assessor
  never clones; when the attached source cannot be read it reports level `unreadable`, and the assessment fails
  with that reason, without a level or an issue for the repository's author.

### After upgrading

- [ ] OMA: republish the Deploy Assistant (allowed tools gain `list_assessments`, `onboarding_draft`; the prompt
  names the new page context). Run `bin/publish-assistant.ts` against this environment's OMA, then point
  `DEPLOYER_OMA_AGENT` and the Workbench Business Agent "Deploy Assistant" at the new agent id. Existing assistant
  conversations keep the old agent: start a new chat to use the new one.
- [ ] OMA: republish the Onboarding Assessor (its prompt no longer clones and knows level `unreadable`): the same
  `bin/publish-assistant.ts` run with `onboarding-assessor` at the end, then set `DEPLOYER_OMA_ASSESSOR_AGENT` to
  the new agent id.
- [ ] Before assessing: set `DEPLOYER_GIT_SSH_KEY_FILE` (Environment variables, Deployer card) to a read-only key
  without a passphrase, if it is not set yet.

## 0.3.0-rc.6

- Executor 0.9.2: `EXECUTOR_REGISTRY_AUTH=<host>=<file>` makes the executor log in to a registry itself (a Harbor
  robot account) before each build, deploy or Deployer upgrade that uses it. The file holds the user name and the
  password on two lines, root's with mode 600, read each time; the password goes through stdin, never the log.

## 0.3.0-rc.5

No changes beyond the version: a version to upgrade to for a Deployer that went to 0.3.0-rc.4 before its executor
went to 0.9.1. With `EXECUTOR_DEPLOYER_USER` set (and the executor restarted), upgrading to this one from the page
runs the Deployer as that user.

## 0.3.0-rc.4

- Executor 0.9.1 (both executors; `EXECUTOR_VERSION` with it): `EXECUTOR_DEPLOYER_USER=<user>` in the executor.env
  of the host that runs the Deployer makes the page's Upgrade run the Deployer as that user: it writes the user's
  uid/gid into `.env`, adds the `user:` line to a `compose.yaml` without one (the old file kept as
  `compose.yaml.before-user`) and hands `data/`, `secrets/` and the directory's files to the user; a rollback gives
  them their owners back. Versions whose image lacks the `org.open-atlas.any-user` label are refused while it is set.
  Order: upgrade the executors from the Overview, set it and restart the executor, then upgrade the Deployer.
- The Deployer can run as a host user of your choice instead of uid 1000: `sudo ./bootstrap.sh --user nifi` writes
  that user's uid and gid into `.env` (`DEPLOYER_UID`, `DEPLOYER_GID`), which the compose file's new
  `user: "${DEPLOYER_UID:-1000}:${DEPLOYER_GID:-1000}"` reads, and hands `data/`, `secrets/`, `compose.yaml`, `.env`,
  `deployer.env` and `emergency-password` to that user (`backups/` stays root's, the executor writes it). Run it again
  on an existing install to move it over: a `compose.yaml` without the `user:` line gets it (the old one is kept as
  `compose.yaml.before-user`) and the Deployer restarts. Without `--user` nothing changes. The image now has
  `libnss-wrapper`: ssh refuses a uid the image does not know, so git and ssh borrow a passwd entry through it.

## 0.3.0-rc.3

- The SSH private key can be pasted on the page (Environment variables → Deployer → `DEPLOYER_GIT_SSH_KEY_FILE`):
  0.3.0-rc.2 refused it because its BEGIN/END lines have spaces ("paste the token alone, without spaces").

## 0.3.0-rc.2

- Repositories are read with git over SSH once `DEPLOYER_GIT_SSH_KEY_FILE` is set (design D46): the version list,
  and for a version assessment every deploy-related file changed between the two tags (no 300-file cut, however many
  versions lie between) and the commit messages, which stand in for release notes a host such as Bitbucket does not
  have. The assessment's source goes to the OMA sandbox as an archive (`source.tar.gz`), so the sandbox no longer
  clones and needs no credentials or certificates. Without the key, the GitHub API is used as before. The image now
  has `git` and `openssh-client`. Republish the Onboarding Assessor (its prompt changed).
- An assessment whose OMA session has more than 200 events no longer stays "assessing" after the report: the
  Deployer read only the first page of events and never saw the turn end; it now reads every page (`after_seq`).

## 0.3.0-rc.1

Managed services, phases 1 to 3 (NiFi 1.x and 2.x): every NiFi on the hosts in one place (phase 1), looking into
them without logging on to a server (phase 2: samples and metrics, health rules, alerts and a timeline, logs, the
AI's read-only tools, Studio's `nifi-ops` graph, the FlowFile trace), and changing them (phase 3: configuration
revisions and drift, start, stop and restart of a standalone instance or a cluster, removing a service). Executor
0.9.0 (both executors; `EXECUTOR_VERSION` with it). A release candidate: try it on UAT before PROD.

**Service executor**
- **Run `install.sh` again on hosts with a service executor before it starts or stops anything** (a self-upgrade does
  not update the systemd unit): the unit now has `KillMode=process` and `TasksMax=infinity`, and no longer
  `NoNewPrivileges`, `ProtectSystem` or `PrivateTmp`, which a NiFi it starts would inherit. Under another `KillMode` a
  start is refused.
- `svc-control`: starts and stops a NiFi as its service user (`runuser`; never root) with its start environment and
  limits (`env -i`, `prlimit`), and confirms by pid and start time that a stop really ended; a timeout never kills, a
  `kill` is its own request. Disconnects, offloads and connects nodes with the operator certificate
  (`EXECUTOR_NIFI_OPERATOR_CERT`, `EXECUTOR_NIFI_OPERATOR_KEY`), which reads and samples never get.
- Samples say how many encrypted values (`enc{`) the flow holds (`flow.encrypted`, a count, never a value), so a plan
  changing `nifi.sensitive.props.key` or `.algorithm` can say whether NiFi will start; without it (an older executor)
  the plan says it may not.
- A second executor, installed only where services are managed: `open-atlas-service-executor-<version>.tar.gz` in
  the same `executor-v<version>` release, its own `install.sh` (no Docker check; runs as root or as a plain user, who
  then sees only their own processes). The deploy executor and the service executor share `executor_core.py`, and
  each release file is still one script (`bundle.py`), so a 0.7.x deploy executor upgrades as before.
- Self-upgrade of the service executor: Hosts (next to the service executor) and Overview (a row for it beside the
  deploy executor's, and "Upgrade outdated" takes it in) start it, `POST /api/hosts/:id/upgrade-executor` takes
  `{executor: "deploy" | "service"}`. It goes through the service executor's own queue and release (its own
  `EXECUTOR_UPGRADE_FROM`). It waits while a change on that host is running, paused or stopped; the deploy executor
  is not held by changes. A self-upgrade does not update the systemd unit (see the `KillMode=process` note above). When the service executor's heartbeat reports a `KillMode` other than `process`, the upgrade is refused (`upgrade/killmode-unsafe`; the Hosts and Overview confirm dialog explains and has its button disabled): add `KillMode=process` to the unit and `systemctl daemon-reload` first. A heartbeat without `control.killMode` (0.8.0 and older) is let through.
- The setup archive `open-atlas-deployer-setup-<version>.tar.gz` also holds the service executor
  (`service-executor/`, its `install.sh`); `bootstrap.sh --service-executor` installs it, it is not installed by default.
- A token belongs to one executor of a host; the heartbeat says which (`executor: deploy|service`) and a mismatch is
  refused. Deploy jobs never go to a service executor. The Hosts page shows the service executor, its version and
  whether it runs as root.
- Read jobs run in parallel (`EXECUTOR_READ_SLOTS`, a time limit per job), changes wait for them.
- `svc-discover` finds NiFi installations from their processes (1.x `RunNiFi`, 2.x `BootstrapProcess`), the usual
  directories and directories typed in: version, owner and service user, ports, cluster settings, heap, storage
  devices, autostart units, the configuration's keys and file hashes. Secret values come back hidden, with a keyed
  fingerprint so nodes can still be compared.
- `svc-read` reads an installation's configuration files (size limits), sent to the Deployer outside the job state.
- An installation and its conf directory are kept apart (`installDir`, `confDir`): the installation comes from the
  class path's `lib/` jars (then the working directory), the conf directory from `-Dnifi.properties.file.path` or
  `conf.dir` in bootstrap.conf, so NiFi unpacked in one place with its configuration and repositories elsewhere is
  read right. One installation may run several instances, each with its own conf directory. Directories to read can
  be given as `{install, conf}`; the directories scanned are set with `EXECUTOR_SCAN_DIRS`.
- The heartbeat's `kinds` say what each read job can do: `svc-discover@2` (`{install, conf}` entries) and
  `svc-read@2` (`confDir`, `bootstrapFile`). The Deployer checks a job's needs against them: a job the executor
  does not name is refused when it is submitted (409 `executor/unsupported`), or, queued before the executor said,
  refused when the executor asks for it, so an older executor never gets a request it would misread.
- Phase 2, the collector: beside the jobs, every `EXECUTOR_COLLECT_SECONDS` (60, 30-300) the service executor samples
  each NiFi the Deployer registered on its host. The list comes with every heartbeat reply (`watch`); nothing else
  is sampled. A sample holds the process (running, pid, start time, memory, CPU) and the host (load, memory), the
  disks of the repositories and logs (once per device), the REST API's about, system diagnostics (per node on a
  cluster), flow status, cluster nodes, new bulletins and back pressure (the root group's recursive status: connections
  at their threshold, the fullest ones), called with the host's monitor certificate
  (`EXECUTOR_NIFI_CLIENT_CERT`, `_KEY`, `EXECUTOR_NIFI_CA`; the name checked is `nifi.web.https.host`;
  `EXECUTOR_NIFI_CA_RELAXED=1` for a CA without critical Basic Constraints), and once an hour the certificates of the
  keystore and truststore (JKS or PKCS12, through the NiFi's own `keytool`, the password passed in the environment)
  and of the monitor certificate, with their expiry. Without the certificate only `/proc` and the disks are sampled.
  One NiFi costs at most 10 seconds of a round; samples go to `POST /executor/v1/samples`, 20 at a time, and wait in
  memory up to 30 minutes while the Deployer cannot take them.
- Phase 2 logs: each sample carries the WARN/ERROR summary of `nifi-app.log` since the last one (followed by inode
  and offset kept in the work directory; counts by pattern, with the first and newest entry cut at 2 KiB after
  passwords, tokens and keys are hidden). New read jobs `log-read` (list, last lines, search by time, level, text or
  regular expression including `.gz` files: 5000 lines / 4 MiB / 30 s; download as tar.gz up to 50 MiB) and
  `log-tail` (up to 120 s, by inode and offset across a rollover, a chunk every second or two to
  `POST /executor/v1/jobs/:id/chunk`, ended early when nobody follows). Lines and archives go over the binary
  `PUT /executor/v1/jobs/:id/content`. Only files below the log directories of watched installations, compared
  after realpath (no `..`, no symbolic link out).

**Services in the Deployer**
- Service profiles `nifi-1.x` and `nifi-2.x`: the configuration files and a catalog of keys (cluster or node scope,
  restart needed, secret, since/until), checked against 1.12.1, 2.0.0 and 2.5.0.
- Takeover: discoveries become a draft, nodes grouped into clusters by their cluster and ZooKeeper settings;
  differences between nodes, port conflicts and other risks are found by rules (errors, warnings, notes). The AI can
  explain the findings through OMA; takeover works without it. An admin confirms the whole draft: the standalone
  instances and clusters are registered and each installation's files are imported, sealed, as configuration
  revision 1 (a redacted copy for the page). Files changed since the discovery are refused.
- A new Services group on the page: **Instances & clusters** (list and details: version, nodes, executor online,
  running or stopped, the redacted revision 1) and **Takeover** (discover per host, make
  a draft, review and edit it, confirm or discard).
- `GET /api/services`, `GET /api/services/:id/status`, `GET /api/services/:id/config`, the draft routes under
  `/api/services/drafts` and `POST|GET /api/hosts/:id/discover`; every change goes to the audit.
- Read-only MCP tools `list_service_clusters` and `get_cluster_status`.
- A service executor's heartbeat reply lists the installations registered on its host (`watch`); its samples are
  kept for those only (`service_samples`). A takeover warns (`host/multiple-nifi`) when a host would
  have more than one NiFi registered.
- Phase 2 metrics: each sample is kept 2 days with its numbers (heap, GC time from the counters, threads, the node's
  queue share, back pressure, repository disks, process CPU from `cpuSeconds`, RSS, host load, memory and disks),
  rolled up every 5 minutes (average, maximum, last; kept 30 days); cleaned up hourly. Bulletins go to
  `service_bulletins`, dated from NiFi's time of day (the zone from the cluster view or the newest bulletin), each once
  by node, id and time (ids start from 0 again after a restart). Certificates go to `service_certs`, only the newest
  reading (by `readAt`).
- Live state: a member is running or stopped as of its newest sample (`asOf`), unknown after 3 sampling periods
  without one, lost while its service executor is offline; never sampled, as of the newest discovery. A cluster's
  node connections come from the coordinator's view. `/status` and `get_cluster_status` carry it, with the live pid,
  version, numbers and every certificate.
- `GET /api/services/:id/metrics` (`range=1h|6h|2d|30d` or `from`/`to`, `step`, `member`, `fields`) and
  `GET /api/services/:id/bulletins`.
- The service page: a **Metrics** tab (heap, GC, threads, queue, back pressure, repositories, host; a line per node;
  1 hour, 6 hours, 2 days, 30 days), key numbers, the newest bulletins and the certificates on **Overview**, the
  soonest expiry in the summary line (`cert 23d`) and per node on **Nodes**; the list cards show the last hour's heap
  and queue and a certificate expiring within 30 days.
- Phase 2 health rules (`services/rules.ts`), run in the Deployer as samples come in and once a minute: executor
  lost (after `executorLostMinutes`), no samples, process not running, node disconnected (coordinator's view), no
  coordinator, back pressure for N minutes (one alert per service: it is flow-wide), repository disk 80/90 %, heap
  above 85 % for 5 minutes, ERROR bulletins, ZooKeeper messages in bulletins, versions differ, no monitor certificate,
  certificate expiring (30 days WARN, 7 days or expired CRIT), certificate unreadable. The profile gives the defaults,
  `PUT /api/services/:id/thresholds` (admin, audited) overrides them per service. One open alert per rule and member
  (`service_alerts`), resolved when the rule no longer holds; a rule that cannot tell leaves it open. A timeline per
  service (`service_events`): alerts opening, changing level and resolving, nodes disconnecting and reconnecting,
  restarts (start time), version changes, takeover, imported configuration (services from before get the last two).
  `GET /api/services/:id/alerts`, `…/events`, `GET /api/alerts`. Pages: **Events and alerts** tab (open alerts,
  timeline, resolved, thresholds with what each means), problems and timeline on **Overview**, the alert count on the
  cards, the table and the summary line, **Alerts** in the sidebar (with the open count), a services health card on
  the home Overview. `status.events` now comes from the timeline (kind `taken-over` in place of `registered`).
- `bin/executor-token.ts <data> <host> <file> service` issues a service executor token, `--revoke deploy|service`
  revokes one, without the page.
- An `environment.json` without `apps` no longer breaks `GET /api/setup` (500).
- For a local development instance only: `DEPLOYER_DEV=1` with `DEPLOYER_DEV_SKIP_SETUP=1` counts setup as complete
  (a banner says so); ignored with `NODE_ENV=production`, as in the image.
- `dev/nifi-lab`: an nginx of the lab's own (`nginx.conf`, `lab.sh nginx start|stop|status`), bound to 127.0.0.1,
  holding the lab's `nginx` client certificate, one address per instance or cluster; `lab.sh grant` gives that
  identity the monitoring reads and `/provenance`.
- New tables only (`executor_beats`, `service_*`) and a column on `executor_tokens`. 0.2.4 opens the database, but
  would take a service executor token for a deploy executor one: revoke it before going back.

- Phase 2 logs: `service_log_patterns` and 5-minute counts from the samples (the ZooKeeper rule counts them with
  the bulletins); `GET /api/services/:id/logs` (members, summary), `…/logs/files`, `…/logs/lines`,
  `POST …/logs/search` (every node in parallel, merged by time), `GET …/logs/download` (audited), `GET …/logs/tail`
  (Server-Sent Events; one tail per node and file, shared, renewed from its cursor while someone follows). A Logs
  tab on the service page: follow, search, download, the WARN/ERROR summary. Log jobs only go to an executor whose
  heartbeat names them.
- Phase 2 read-only MCP tools (deploy-viewer, as the pages): `get_metrics` (last / min / max / avg per member and
  field, points with `series`), `list_alerts`, `list_events`, `get_bulletins`, `search_logs`, `tail_logs` (the last
  N lines, not a stream; no member needed for a standalone), `get_service_config`, `diff_service_config` (a
  cluster's nodes; two revisions come with phase 3) and `lookup_property` (the profile's catalog,
  `GET /api/service-properties`). Log lines, bulletins and the texts of alerts, events and configuration are
  redacted before they reach the AI (`services/redact.ts`, the service executor's rules); the pages still show
  people with deploy-viewer the raw logs and bulletins. The Deploy Assistant's package allows these tools and its
  NiFi operations skill (`agents/skills/nifi-ops.md`: the overall picture from the samples, components only through
  Studio) is an OMA Skill of its own (below).
- `/mcp` answers a refused log read or an executor that cannot run a job with its error code (was a 500).
- Studio's `nifi-ops` graph (§9.4): an admin gives a standalone instance or cluster its **nginx address** on the
  Overview (`PUT /api/services/:id/nginx`; operations put every node behind it, nginx holds the NiFi client
  certificate); the Deployer checks `/flow/about` through it and shows the result. The Deployer writes the graph
  (`services/graph.ts`): per service an `api` source at `<nginx>/nifi-api` (GET only, 2 at a time, 5 s, no retries)
  only (Studio 2.11 removed the `nifi` source type; provenance is the Deployer's own, below); entities per service
  `nifi.<service>.*` (flow controller, nodes and their JVMs, process groups one level at a time, processors,
  connections, bulletins). It is published through
  the studio-graph path (sources declared, the graph made the first time, uploaded, published) after a takeover and
  an nginx address change, into `DEPLOYER_NIFI_OPS_GRAPH` (default `nifi-ops`); every run is recorded
  (`GET /api/services/graph`, `POST /api/services/graph/publish`). One graph serves 1.x and 2.x (checked against
  responses recorded from 1.12.1 and a 2.5.0 cluster, `testdata/nifi-graph`). `bin/publish-assistant.ts` with `NIFI_OPS_MCP_URL` adds the graph's read
  tools to the Deploy Assistant.
- FlowFile trace (S28, §9.5): the service executor's new read job `nifi-provenance` (heartbeat `nifi-provenance@1`)
  reads a watched NiFi's provenance with the monitor certificate — events of a FlowFile UUID or a searchable field
  in a time range, a lineage (an event's parents and children too), one event, the searchable fields; NiFi's queries
  are submitted, polled and always deleted, at most 100 events, 4 MiB per answer, 30 seconds; never replay, content
  or a flow change. A cluster is searched as a whole through one node (the next member if that one fails); lineage and
  events go to the event's node. NiFi before 1.14 takes plain search terms; a 2.x cluster in a zone printed as "CST"
  runs the dates hours off on replication, which the executor detects from the echoed request and corrects.
  `GET /api/services/:id/provenance` (support and members), `…/provenance/options`, `POST …/provenance` (time range
  required), `POST …/lineage`, `GET …/provenance/events/:eventId` (deploy-viewer; two queries per service at a
  time). A **FlowFile trace** tab: search, events by time with component and relationship, lineage, event details,
  the logs and bulletins around an event; versions other than 1.12+ and 2.x are marked not supported. MCP read-only
  tools `search_provenance`, `get_lineage`, `get_provenance_event` (attributes with secret-looking names and every
  text redacted), allowed for the Deploy Assistant and in its NiFi skill. The monitor certificate's identity needs
  "query provenance" and "view provenance" on the flow (`lab.sh grant` gives them in the lab; `grant.py` takes
  `@root` for the root process group).
- The Deploy Assistant's Skills are kept in OMA (owner 2026-11-07): `bin/publish-assistant.ts` creates each
  `agents/skills/*.md` as an OMA Skill (one SKILL.md; the files now start with OMA's `name`/`description`
  frontmatter), adds a version only when its text changed, and the package references that version instead of
  pasting the text into `system`. It needs `OMA_URL` and `OMA_API_KEY_FILE` (OMA's Skills API: the Builder MCP can
  create a Skill but not add a version); the state file keeps the Skills' ids. The Assistant gets OMA's `read` tool
  alone, to open the SKILL.md OMA mounts in its sandbox (OMA puts only a summary in the prompt unless it runs with
  `OMA_SKILL_EAGER_PROMPT=1`).
- An nginx address may carry a path (`https://nginx.example/nifi-prod-a`): one nginx telling the NiFi apart by path,
  as at the company; the Deployer appends `/nifi-api`, so nginx passes `<prefix>/nifi-api/` on. The lab's nginx has
  such an entry (127.0.0.1:18546, `/n112`, `/n200`, `/c250`); a 404 names the path nginx should pass.
- FlowFile attributes in the trace (owner 2026-11-07): the monitor identity is given NiFi's "view the data" on the
  root group (`/data/process-groups/<root>`, read; on a cluster every node's identity too, as NiFi checks the proxy
  chain), so event details carry the attributes. The page shows them as they are; the AI gets them redacted as
  before. The Takeover page lists every policy the monitor identity needs; `lab.sh grant` gives them in the lab. The
  redaction cases are shared by the Deployer's and the service executor's tests (`testdata/redact/cases.json`).
- Back pressure less often and only as a summary (owner 2026-11-07): the service executor reads the root group's
  recursive status every `EXECUTOR_BACKPRESSURE_SECONDS` (default 300, 30-3600) instead of every sample and sends
  the connections at their threshold, the fullest percentage and the fullest `EXECUTOR_BACKPRESSURE_TOP` queues
  (default 5, 1-50). The service status carries the newest reading (`summary.backpressure`, stale after 3
  intervals); the Overview shows it and the most congested queues, the Metrics charts join the readings, and the
  back pressure rule looks 3 intervals back (a stale reading cannot tell). Samples of an executor that sent it every
  round still read as before.

**Phase 3: changing a service**
- Configuration as revisions: the files imported at takeover are revision 1, sealed byte for byte; edits keep every
  untouched byte and comment. A cluster has a common layer and per-node overrides. Each edit is checked against the
  profile's catalog: keys that need a restart, keys that can roll node by node (`rolling`) or need the whole cluster
  stopped (`full`), and moving `nifi.sensitive.props.key` / `.algorithm` (whether the flow's `enc{` values still open).
- Drafts and revisions: `…/config/drafts` routes, a **Changes** tab on the service page (edit, diff against the running
  files and between revisions, review, discard). The AI drafts through MCP tools and the result is reviewed on the
  page; it never applies anything.
- Drift: the files on a node are compared with the current revision; a difference is shown and can be adopted as a new
  revision or overwritten by the next apply.
- Applying a revision, start, stop and restart: a standalone instance, a rolling change on a cluster (disconnect,
  offload, write, restart, reconnect, one node at a time) and a full-cluster stop and start, each shown as a plan
  first, then run step by step (pause, stop, resume) with a backup of every file written. Service executor jobs
  `svc-state`, `svc-write` and `svc-control` (as the service user, never root). Tried on the lab's 1.12.1, 2.0.0 and
  2.5.0 cluster, including a node that does not come back.
- Removing a service (admin): the Deployer stops managing it; NiFi is not touched.
- The service executor upgrades from the page (Hosts, Overview); the upgrade is refused while its unit's `KillMode`
  is not `process` (see Service executor above). The setup archive carries the service executor.

**Known limits**
- Alerts are not pushed (S13).
- Not yet: turning a standalone instance into a cluster; alert diagnosis and briefs (phase 4); upgrading and new
  installs of NiFi (phase 5); flow-level operations.
- Not tried on a real server yet: the service executor installed as root with its systemd unit, SELinux, a 1.x
  cluster, an offload, a forced kill.
- Alerts, events and the facts behind them are not pruned yet; the back pressure reading is still the root group's
  whole recursive status (only less often), large on a large flow.

## 0.2.4

Executor 0.7.3, unchanged.

- The Deployer's own settings on the page (D45): Environment variables has a "Deployer" card for administrators.
  - What the Deployer needs before it opens its state database stays in `deployer.env` and is only shown there: the
    credential and compare keys and the emergency password hash (shown only as set or not), the peer key hashes,
    secure cookies, where it listens, its base path, data directory and `environment.json`.
  - Workbench's addresses, the release and issue repositories, OMA's address and ids, the Builder addresses, UAT's
    address and the daily brief's hour can be set there. They are kept in the state database, checked together before
    any is kept, and each change goes to the audit.
  - Tokens (the `*_FILE` settings) are pasted there, kept sealed with `DEPLOYER_CREDENTIAL_ENCRYPTION_KEY` and never
    shown again. The Workbench API key works as before: checked against Workbench and in effect at once.
  - A value set in `deployer.env` wins and the page cannot change it: remove the line there to set it on the page.
  - A change applies at the next start. The page marks what is waiting and can restart the Deployer: it exits and the
    container's restart policy (`restart: unless-stopped`) starts it again; refused while a job is running. Only in
    the image (`DEPLOYER_RESTART_BY_EXIT=true`).

**Tried before this release**
- On a test container built from this version (no Workbench, the emergency account): a batch with a bad value is
  refused as a whole, a token never comes back, the restart came back in 2 seconds through the restart policy, and
  the saved values were in effect afterwards while the file's value still won.

## 0.2.3

Executor 0.7.3, unchanged; only the page changed.

- Apps & manifests: the form for registering an app or changing its manifest says what to do in three steps
  (paste or open deploy.json, Check, Save), opens the file from disk or takes it dropped on the box, offers a starting
  template for a new app, and says why Check is not available yet. Changing the text after a check asks for a new
  check before Save, so what is saved is what was checked. An empty registry says how to add the first app.

## 0.2.2

Executor 0.7.3, unchanged; only the page changed.

- Confirmations open in the page's own dialog, in its style and colour scheme, instead of the browser's `confirm()`.
  Each confirm button is named after its action; on destructive ones (remove, revoke, stop a deploy, go back a
  version) it is red and Enter stays on Cancel. Escape or a click outside cancels.

## 0.2.1

Executor 0.7.3; the Deployer is unchanged apart from carrying it. Upgrade the executors from the Overview after the
Deployer.

- Executor 0.7.3: a data directory made beforehand and still empty (by another account on the host) now goes to the user
  the image runs as, like a new one, and the job log says so; before, only a missing directory did, and Workbench
  (1000) could not write to one made by another account. A directory with files in it keeps its owner.

## 0.2.0

First setup (D41): a new installation goes from `bootstrap.sh` on the server to Workbench signing people in on one
Setup page, and then lists what the AI features still need. Executor 0.7.2, unchanged. An installation on 0.1.0
upgrades from the Overview as before; it opens on the Setup page until its Workbench is 1.24.0 or newer and the
deploy groups exist, both done from that page.

**First setup (D41, phase 1)**
- A new installation opens on a Setup page, the only page until Workbench signs people in and the Deployer has its
  Workbench API key. Each step is checked on the spot: environment settings, executors, the Workbench manifest,
  deploying Workbench, signing in with Workbench, the API key.
- The first environment settings can be made from a form on that page; `environment.json` is still imported when present.
- The image ships Workbench's manifest (from 1.25.1, image from GHCR, no build) for a one-click import while the
  registry has no Workbench. PROD still takes its manifests from UAT.
- The emergency account can issue and revoke executor tokens, so a new host can be connected before Workbench exists.
- Each release attaches `open-atlas-deployer-setup-<version>.tar.gz`: `bootstrap.sh` installs the executor, lays out
  the Deployer's directory with its keys generated into `deployer.env` (the emergency password goes to a mode 600
  file, never printed), creates the apps' network as compose would, and starts the Deployer.

**First setup (D41, phase 2)**
- The Deployer's Workbench API key can be pasted on the Setup page: it is tried against Workbench, kept sealed with
  the credential key and used at once. A key in `DEPLOYER_WORKBENCH_API_KEY_FILE` still wins. API keys and the
  maintenance notice now work with either.
- A new Workbench's environment variables are generated on the Setup page; the initial admin's password is in that
  answer only. Workbench's app menu gets a link to the Deployer (`WORKBENCH_APP_LINKS`).
- A Workbench the Deployer did not deploy (1.24.0 or newer) is taken over: import its env file, deploy it once.
- Setup checks that the Workbench API key works and creates the missing deploy groups; it is complete once the
  Deployer runs Workbench, the key works and the groups exist.
- When Workbench is behind nginx, the recommended nginx configuration is saved from the Workbench step, since the
  Ingress page is not open until setup is complete.

**First setup (D41, phase 3)**
- Once setup is complete, the Setup page lists what the AI features need (L3), each checked on the spot against OMA
  and Workbench: OMA deployed by this Deployer and answering, the Deployer's OMA key and Application, the Deploy
  Assistant and the Onboarding Assessor with its Environment, a service key in an OMA Vault for the Deployer's
  `/mcp`, the "Deploy Assistant" Business Agent, and the Deployer's entry in Workbench (`chat.embed`).
  `GET /api/setup/ai`; deploys do not depend on it. OMA shows a Vault's credentials only to its owner, so when the
  Deployer's key cannot list them, a service key that has been used counts; the Application id is a note, not a step.
- An installation whose Workbench (deployed by the Deployer) is older than 1.24.0 is asked to deploy 1.25.1 or newer
  from the Setup page before the deploy groups are created.
- The Overview's "Setup complete" line says how many AI items are open; the Deploy Assistant panel and the
  Onboarding page say what they still miss.
- The Deployer registers itself in Workbench's application list with one click (an application entry that embeds
  the chat, visible to the deploy groups); an entry that is there keeps its other fields. An address the browser
  would not embed on Workbench's page (http inside https, another site) is refused, and an entry with one is not done.
- `examples/oma.manifest.json`: a starting point for registering OMA (no build, `oma-beta-v{version}` images, one
  data directory for both services).

**Tried before this release**
- On the local UAT (a real Workbench and OMA), upgraded in place from 0.1.0: Workbench 1.23.1 to 1.25.1 from the Setup
  page, the deploy groups, the AI checklist against what runs, registering the Deployer in Workbench and opening it
  from there with the embedded chat, OMA 0.1.0-beta.8 to beta.9 with the example manifest.

**Known limits**
- `bootstrap.sh` on a fresh server and the setup steps before Workbench answers have run only in tests and on a
  local test instance, not on a real server.
- OMA's settings stay in `deployer.env` (a restart after changing them); the Business Agent is created in Workbench.

## 0.1.0

The first release: the same code as 0.1.0-rc.5, with executor 0.7.2. What it does is under 0.1.0-rc.1; the release
candidates after it fixed what trying them turned up.

**What it does**
- Deploys apps from manifests the Deployer keeps (per app and version range), through an executor on each host, with
  a plan before every deploy, backups, rollback and an audit log.
- Promotes to PROD only what UAT has run, by UAT's image digests and with UAT's manifest revision; an administrator
  can skip the rule with a reason.
- Upgrades itself and its executors from the Overview's Platform area, from this repository's releases.
- Environment variables, environment settings and nginx configuration as revisions; API keys and an MCP endpoint,
  with admin tools for manifests and settings; the Deploy Assistant and failure diagnosis through OMA.

**Tried before this release**
- On a local UAT and PROD (one machine): installing from this repository's releases, upgrading the Deployer and the
  executors from the page, a missing version refused before anything stops, promotion and its block, the admin MCP
  tools.

**Known limits**
- Not yet installed on a real server: the executor's `install.sh` (root, systemd) and a system nginx have not run
  there. Report what a first installation runs into; fixes follow in 0.1.x.
- Checking that the versions affected by a manifest's new image source have images there follows in 0.1.x (saving
  such a manifest warns).
- The Deployer's version list is cached for 5 minutes: a release just published may need "Other version…".

## 0.1.0-rc.5

- Executor 0.7.2, for upgrading the Deployer (D16):
  - when `docker compose up` itself fails on the new version (a port taken, a container in the way), the upgrade goes
    back to the previous image and state; before, it stopped there with `.env` already naming the new version;
  - it refuses before touching anything when the Deployer's `compose.yaml` names a different project than
    `EXECUTOR_DEPLOYER_PROJECT` (the executor's `-p` wins over the file, so it would have stopped another project).
- Found upgrading a local UAT and PROD on one machine; upgrade the executors from the Platform area after the Deployer.

## 0.1.0-rc.4

- MCP: an administrator's personal key can revoke API keys with `revoke_key` (it was listed but always refused, since
  `/mcp` takes only keys). Making a key stays on the page.
- Tried the admin MCP tools from a client: reading and saving environment settings (a repeated `request_id` saves
  once), manifests read-only on PROD, PROD deploys refused to keys, every call in the audit log with its key.

## 0.1.0-rc.3

- Environment variables: values saved before the first import (a new environment, where the file does not exist on
  the server yet) are no longer buried under the empty imported revision: they come back as the newest revision, so
  the next write still carries them. Importing a file the Deployer already wrote or imported adds no revision.
- Tried on a local UAT and PROD together: promotion by UAT's digests, the block on versions UAT has not run, the
  administrator override.
- Not in 0.1.0: checking that the versions affected by a manifest's new image source have images there. Saving such
  a manifest still warns to deploy those versions in UAT again first; the check follows in 0.1.x.

## 0.1.0-rc.2

- The Deploy Assistant says why it is blank: when Workbench's chat has not loaded after 10 seconds (Workbench
  unreachable, or a certificate the browser does not trust), the panel says so, links to Workbench in a new tab and
  offers to try again.
- Executor 0.7.1: the same code as 0.7.0, released so hosts can try upgrading an executor from GitHub.
- Development: `npm run dev:web` no longer sends the page's own `api.ts` to the API server.

## 0.1.0-rc.1

The first release candidate: everything below is new.

**Deploying**
- Manifests per app and version range turn into compose fragments; deploys run from a plan (versions, hosts, steps,
  blocking findings) through an executor on each host; failed deploys roll back, and rollback keeps the manifest the
  version was deployed with.
- Promotion: PROD deploys only versions UAT has run, and takes UAT's manifest revision with them (PROD manifests are
  read-only). The registry page on PROD can take every app's manifests from UAT at once.
- App drivers for Workbench applications, Studio graphs and OMA agents; env files with schemas and encrypted values;
  ingress through nginx with saved configuration revisions.

**Running the platform**
- The Deployer is a container image (`ghcr.io/ferenc-z/open-atlas-deployer`), installed with `examples/deployer`.
- Executors (Python 3.9+, systemd) talk to the Deployer over HTTPS long-poll with per-host tokens, and upgrade
  themselves from the release `executor-v<version>`, checked against its SHA256SUMS, rolling back if the new one does
  not start.
- The Deployer upgrades itself through the executor on its host (D16): back up the data, switch the image, wait for
  the new version, otherwise restore.
- Overview's Platform area holds every upgrade: the Deployer (versions from `DEPLOYER_RELEASE_REPO`, plan first,
  confirmation for older versions) and the executors (one host at a time, stopping on failure).
- Environment settings live in the state database with revisions (imported from `environment.json` on the first
  start), edited on the Environment settings page.

**People and agents**
- Sign-in through Workbench; personal and service API keys; an MCP endpoint with deploy tools and, for admins, tools
  to read and save manifests, environment settings and nginx configuration, revoke tokens and keys, and read the audit.
- The Deploy Assistant beside the page, failure diagnosis and the daily brief through OMA, assessments of new apps and
  versions, drift reports.

**Before 0.1.0**
- Not yet run on real UAT and PROD servers together; MCP admin tools not yet tried from a real client.
- Checking that the versions affected by a manifest's new image source have images there is not done yet.
