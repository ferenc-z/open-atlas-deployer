// S37 step 7 (pages-rethink §7 Q2, T8): the Studio graph the e2e_trace evidence source reads. One `sql` source on the
// ClickHouse database e2e_trace; entities are query windows (every run-record query carries a time range, because
// the table's sort key starts with toStartOfHour(receive_datetime)) and the schedule definitions (FINAL: both are
// ReplacingMergeTree). The Deployer reads it only through the saved queries below (run_saved_query on the data plane,
// never EQL it builds), so the queries' names and parameters are this file's contract with the adapter (e2e-trace.ts).

import { edn, kw, map, set } from "../edn.ts";

export const E2E_SOURCE_ID = "e2e-trace-ch";
type Type = "string" | "integer";
/** [name, label, type, column (as the SQL selects it), nullable] */
type Col = [string, string, Type, boolean?];

const RECORD: Col[] = [
  ["row_key", "Row key (correlation id, seq, stage, time)", "string", false],
  ["correlation_id", "Correlation id (the business key carried over MQ)", "string", false],
  ["schedule_id", "Schedule id", "integer"],
  ["schedule_name", "Schedule (business process)", "string"],
  ["schedule_seq", "Step number in the schedule", "integer"],
  ["manager_name", "Manager", "string"],
  ["worker_id", "Worker id", "integer"],
  ["worker_name", "Worker", "string"],
  ["process_stage", "Stage: start, processing or end", "string"],
  ["process_status", "Status: success or failure", "string"],
  ["node_name", "NiFi node that ran it", "string"],
  ["has_next_worker", "1 when a next worker is expected", "integer"],
  ["next_worker_names", "Expected next workers (comma separated)", "string"],
  ["final_worker_name", "The schedule's final worker", "string"],
  ["file_name", "File name", "string"],
  ["source_path", "Source path", "string"],
  ["email_from", "Mail sender", "string"],
  ["email_subject", "Mail subject", "string"],
  ["received_at", "Received at (ISO, UTC)", "string", false],
];
const RECORD_SQL = `SELECT concat(toString(correlation_id), '|', toString(ifNull(schedule_seq, -1)), '|', process_stage, '|', toString(toUnixTimestamp64Milli(receive_datetime))) AS row_key,
 toString(correlation_id) AS correlation_key, schedule_id, schedule_name, schedule_seq, manager_name, worker_id, worker_name, process_stage, process_status,
 node_name, toInt32(has_next_worker) AS has_next_worker, arrayStringConcat(arrayMap(x -> ifNull(toString(x), ''), next_worker_names), ',') AS next_worker_names,
 final_worker_name, file_name, source_path, email_from, email_subject, concat(replaceOne(toString(receive_datetime, 'UTC'), ' ', 'T'), 'Z') AS received_at
FROM e2e_trace.rt_dwd_l1_trace_log
WHERE receive_datetime >= parseDateTime64BestEffort(:from, 3) AND receive_datetime < parseDateTime64BestEffort(:to, 3)`;

const HEADER: Col[] = [
  ["schedule_id", "Schedule id", "integer", false], ["schedule_name", "Schedule name", "string", false], ["schedule_desc", "Description", "string"],
  ["schedule_type", "Type: data or business", "string"], ["manager_id", "Manager id", "integer"], ["manager_name", "Manager", "string"],
  ["manager_mq_name", "Manager queue", "string"], ["trigger_exchange_name", "Trigger exchange (trigger → manager)", "string"],
  ["trigger_routing_key", "Trigger routing key", "string"], ["final_schedule_seq", "Final step number", "integer"],
  ["final_worker_id", "Final worker id", "integer"], ["project_name", "Project", "string"], ["on_demand_flag", "on_demand or auto", "string"],
];
const DETAIL: Col[] = [
  ["row_key", "Row key (schedule, seq, worker)", "string", false], ["schedule_id", "Schedule id", "integer", false], ["schedule_name", "Schedule name", "string"],
  ["schedule_seq", "Step number", "integer"], ["worker_id", "Worker id", "integer"], ["worker_name", "Worker", "string"],
  ["worker_message_name", "Worker message", "string"], ["previous_worker_id", "Previous worker id", "integer"], ["previous_worker_name", "Previous worker", "string"],
  ["worker_exchange_name", "Exchange manager → worker", "string"], ["worker_routing_key", "Routing key manager → worker", "string"],
  ["manager_exchange_name", "Exchange worker → manager", "string"], ["manager_routing_key", "Routing key worker → manager", "string"],
];
const DURATION: Col[] = [
  ["row_key", "Schedule and worker", "string", false], ["schedule_name", "Schedule", "string"], ["worker_name", "Worker", "string"],
  ["p95_seconds", "P95 of start → end, seconds", "integer"], ["samples", "Runs counted", "integer"],
];

/** A record window: the clue it is found by (one required parameter) and how the SQL matches it. */
const WINDOWS: { entity: string; label: string; key: string; where: string; limit: number }[] = [
  { entity: "by_correlation", label: "Run records of one correlation id", key: "correlation_id", where: "correlation_id = toUUID(:correlation_id)", limit: 500 },
  { entity: "by_file", label: "Run records by file name", key: "file_name", where: "file_name = :file_name", limit: 200 },
  { entity: "by_subject", label: "Run records whose mail subject contains a text", key: "email_subject", where: "positionCaseInsensitive(ifNull(email_subject, ''), :email_subject) > 0", limit: 200 },
  { entity: "by_sender", label: "Run records whose mail sender contains a text", key: "email_from", where: "positionCaseInsensitive(ifNull(email_from, ''), :email_from) > 0", limit: 200 },
];

const A = (entity: string, name: string) => kw(`e2e.${entity}/${name}`);

/** The contract (Semantic Contract 2.0 EDN). Workspace and graph ids are placeholders publishContract replaces. */
export function e2eTraceContract(): string {
  const entities: Record<string, unknown> = {};
  const attributes: [unknown, unknown][] = [];
  const resolvers: Record<string, unknown> = {};
  const bindings: Record<string, unknown> = {};
  const selection: [unknown, unknown][] = [];
  const attr = (entity: string, [n, label, type, nullable]: Col) => attributes.push([A(entity, n), { ":attribute/label": label, ":attribute/type": kw(type), ":attribute/nullable?": nullable ?? true }]);
  const ref = (entity: string, n: string, label: string, target: string) => attributes.push([A(entity, n), { ":attribute/label": label, ":attribute/type": kw("ref"), ":attribute/target": `e2e.${target}`, ":attribute/cardinality": kw("many"), ":attribute/nullable?": false }]);
  const addRow = (entity: string, label: string, cols: Col[], key: string) => {
    entities[`e2e.${entity}`] = { ":entity/label": label, ":entity/identity": [A(entity, key)], ":entity/attributes": cols.map((c) => A(entity, c[0])) };
    cols.forEach((c) => attr(entity, c));
  };
  const resolver = (id: string, label: string, input: ReturnType<typeof kw>[], root: ReturnType<typeof kw>, row: string, cols: Col[], sql: string, inputMap: [unknown, string][], max: number, sort: string) => {
    const sortBy = A(row, sort);
    resolvers[id] = { ":label": label, ":effect": kw("read"), ":result/cardinality": kw("many"), ":input": input, ":output": [map([[root, cols.map((c) => A(row, c[0]))]])], // Studio appends the ORDER BY and LIMIT to the statement (sql narrowing), so the SQL has neither.
      ":pagination": { ":default": max, ":max": max }, ":sort": { ":allowed": [sortBy], ":default": [sortBy, kw("asc")] } };
    bindings[`${id}-sql`] = {
      ":binding/for": [kw("resolver"), id], ":binding/source": E2E_SOURCE_ID, ":binding/effect": kw("read"),
      ":binding/implementation": { ":query": sql }, ":binding/input-map": map(inputMap),
      // A SELECT alias shadows the table's column in WHERE (ClickHouse), so the text form of the UUID has its own name.
      ":binding/output-map": map([[root, root.name.split("/")[1]!], ...cols.map((c): [unknown, string] => [A(row, c[0]), c[0] === "correlation_id" ? "correlation_key" : c[0]])]),
    };
    selection.push([[kw("resolver"), id], `${id}-sql`]);
  };

  addRow("record", "Run record (one row of rt_dwd_l1_trace_log)", RECORD, "row_key");
  for (const w of WINDOWS) {
    const keyCol: Col = [w.key, w.key === "correlation_id" ? "Correlation id" : w.key.replace("_", " "), "string", false];
    const ids = [keyCol, ["from", "From (ISO time, inclusive)", "string", false], ["to", "To (ISO time, exclusive)", "string", false]] as Col[];
    entities[`e2e.${w.entity}`] = { ":entity/label": w.label, ":entity/identity": ids.map((c) => A(w.entity, c[0])), ":entity/attributes": [...ids.map((c) => A(w.entity, c[0])), A(w.entity, "records")] };
    ids.forEach((c) => attr(w.entity, c));
    ref(w.entity, "records", "Run records in the window, oldest first", "record");
    resolver(`records-${w.entity.replace("_", "-")}`, w.label, ids.map((c) => A(w.entity, c[0])), A(w.entity, "records"), "record", RECORD,
      `${RECORD_SQL} AND ${w.where}`, ids.map((c): [unknown, string] => [A(w.entity, c[0]), c[0]]), w.limit, "received_at");
  }
  // P3 (2026-11-22): the failure records in a time range, for the business light's e2e-failed (BusinessScanner).
  const fIds: Col[] = [["from", "From (ISO time, inclusive)", "string", false], ["to", "To (ISO time, exclusive)", "string", false]];
  entities["e2e.failures"] = { ":entity/label": "Failure records in a window", ":entity/identity": fIds.map((c) => A("failures", c[0])), ":entity/attributes": [...fIds.map((c) => A("failures", c[0])), A("failures", "records")] };
  fIds.forEach((c) => attr("failures", c));
  ref("failures", "records", "Run records that ended in failure, oldest first", "record");
  resolver("records-failures", "Failure records in a window", fIds.map((c) => A("failures", c[0])), A("failures", "records"), "record", RECORD,
    `${RECORD_SQL} AND process_status = 'failure'`, fIds.map((c): [unknown, string] => [A("failures", c[0]), c[0]]), 200, "received_at");
  // The definitions (FINAL: the latest entry_datetime of each key) and the per-worker durations for T10.
  addRow("schedule", "Schedule (business process)", HEADER, "schedule_id");
  addRow("step", "Schedule step (a worker)", DETAIL, "row_key");
  // Read at the root ([{:e2e.schedule/all [...]}]): the collection hangs on its own entity.
  (entities["e2e.schedule"] as { ":entity/attributes": unknown[] })[":entity/attributes"].push(A("schedule", "all"));
  (entities["e2e.step"] as { ":entity/attributes": unknown[] })[":entity/attributes"].push(A("step", "all"));
  ref("schedule", "all", "Every schedule (schedule_header FINAL)", "schedule");
  ref("step", "all", "Every schedule step (schedule_detail FINAL)", "step");
  resolver("schedules", "Schedule headers", [], A("schedule", "all"), "schedule", HEADER,
    `SELECT ${HEADER.map((c) => c[0]).join(", ")} FROM e2e_trace.schedule_header FINAL`, [], 500, "schedule_id");
  resolver("steps", "Schedule steps", [], A("step", "all"), "step", DETAIL,
    `SELECT concat(toString(schedule_id), '|', toString(schedule_seq), '|', toString(worker_id)) AS row_key, ${DETAIL.slice(1).map((c) => c[0]).join(", ")} FROM e2e_trace.schedule_detail FINAL`, [], 2000, "row_key");
  const dIds: Col[] = [["from", "From (ISO time)", "string", false], ["to", "To (ISO time)", "string", false]];
  entities["e2e.durations"] = { ":entity/label": "Worker durations in a window", ":entity/identity": dIds.map((c) => A("durations", c[0])), ":entity/attributes": [...dIds.map((c) => A("durations", c[0])), A("durations", "workers")] };
  dIds.forEach((c) => attr("durations", c));
  ref("durations", "workers", "Each worker's P95 duration", "duration");
  addRow("duration", "A worker's historical duration", DURATION, "row_key");
  resolver("durations", "P95 of each worker's start → end", dIds.map((c) => A("durations", c[0])), A("durations", "workers"), "duration", DURATION,
    `SELECT concat(ifNull(schedule_name, ''), '|', worker_name) AS row_key, schedule_name, worker_name, toInt32(ceil(quantile(0.95)(d))) AS p95_seconds, toInt32(count()) AS samples
FROM (SELECT correlation_id, any(schedule_name) AS schedule_name, worker_name,
  (toUnixTimestamp64Milli(maxIf(receive_datetime, process_stage = 'end')) - toUnixTimestamp64Milli(minIf(receive_datetime, process_stage = 'start'))) / 1000 AS d
  FROM e2e_trace.rt_dwd_l1_trace_log
  WHERE receive_datetime >= parseDateTime64BestEffort(:from, 3) AND receive_datetime < parseDateTime64BestEffort(:to, 3)
  GROUP BY correlation_id, worker_name HAVING countIf(process_stage = 'start') > 0 AND countIf(process_stage = 'end') > 0 AND countIf(process_status = 'failure') = 0)
GROUP BY schedule_name, worker_name`, dIds.map((c): [unknown, string] => [A("durations", c[0]), c[0]]), 1000, "row_key");

  const entityIds = Object.keys(entities), resolverIds = Object.keys(resolvers);
  const doc = {
    ":contract": { ":contract/family": "atlas-semantic", ":contract/version": "2.0.0" },
    ":workspace": { ":workspace/id": "deployer" },
    ":graph": {
      ":graph/id": "e2e-trace", ":graph/label": "e2e_trace run records", ":graph/exposure": kw("restricted"),
      ":graph/entities": entityIds, ":graph/resolvers": resolverIds, ":graph/operations": [], ":graph/terms": [], ":graph/dependencies": [],
      ":graph/usage-guide": {
        ":guide/purpose": "The run records NiFi 2.x writes to ClickHouse e2e_trace (one row per worker start/end, keyed by correlation_id) and the schedule definitions, for the Open Atlas Deployer's business data trace.",
        ":guide/asset-scope": "rt_dwd_l1_trace_log (by time range plus a correlation id, file name, mail subject or sender), schedule_header and schedule_detail (latest revisions), each worker's historical P95 duration.",
        ":guide/applicability": "Use the saved queries; every run-record query needs a time range (from, to as ISO times).",
        ":guide/limitations": ["Read only", "Run records can miss rows while a NiFi node is down: absence is not proof", "At most 500 rows per correlation id, 200 per clue"],
      },
    },
    ":vocabulary": { ":entities": entities, ":attributes": map(attributes) },
    ":execution": { ":resolvers": resolvers, ":operations": {}, ":sources": { [E2E_SOURCE_ID]: { ":source/kind": "sql", ":source/effects": set([kw("read")]) } }, ":bindings": bindings, ":selection": map(selection) },
    ":ownership": { ":entities": Object.fromEntries(entityIds.map((e) => [e, "e2e-trace"])), ":resolvers": Object.fromEntries(resolverIds.map((r) => [r, "e2e-trace"])), ":operations": {}, ":terms": {} },
    ":publication": {
      ":release/version": "1.0.0", ":source/revision": 1,
      ":required-capabilities": set([kw("semantic/core-v1"), kw("graph/single-owner-v1"), kw("deployment/source-slot-v1"), kw("artifact/embedded-closure-v1"), kw("connector/sql"), kw("query/pagination-v1"), kw("query/sort-v1")]),
    },
  };
  return `;; Generated by the Open Atlas Deployer (services/trace/e2e-graph.ts).\n${edn(doc)}\n`;
}

export interface SavedQueryParam { name: string; type: "string"; required: boolean; description: string; example: string }
export interface E2eSavedQuery { name: string; description: string; params: SavedQueryParam[]; eql: string }

const RECORD_EQL = `[${RECORD.map((c) => `:e2e.record/${c[0]}`).join(" ")}]`;
const range = (from: string, to: string): SavedQueryParam[] => [
  { name: "from", type: "string", required: true, description: "Start of the time range, ISO time (inclusive).", example: from },
  { name: "to", type: "string", required: true, description: "End of the time range, ISO time (exclusive).", example: to },
];
const EX = { from: "2020-01-01T00:00:00Z", to: "2100-01-01T00:00:00Z" };

/** The saved queries the adapter runs (run_saved_query). Names are its contract; examples make the save-time check run. */
export const E2E_SAVED_QUERIES: E2eSavedQuery[] = [
  ...WINDOWS.map((w): E2eSavedQuery => ({
    name: `e2e_records_${w.entity}`,
    description: `${w.label}, in a time range (required), oldest first; at most ${w.limit}.`,
    params: [{ name: w.key, type: "string", required: true, description: `The ${w.key.replace("_", " ")} to look for.`, example: w.key === "correlation_id" ? "aaaaaaaa-0000-4000-8000-00000000000a" : w.key === "file_name" ? "INV-A-001.pdf" : w.key === "email_subject" ? "Invoice" : "billing" }, ...range(EX.from, EX.to)],
    eql: `{:entity {:e2e.${w.entity}/${w.key} ?${w.key} :e2e.${w.entity}/from ?from :e2e.${w.entity}/to ?to} :query [{:e2e.${w.entity}/records ${RECORD_EQL}}]}`,
  })),
  { name: "e2e_failures", description: "Run records that ended in failure (process_status failure), in a time range (required), oldest first; at most 200.", params: range(EX.from, EX.to),
    eql: `{:entity {:e2e.failures/from ?from :e2e.failures/to ?to} :query [{:e2e.failures/records ${RECORD_EQL}}]}` },
  { name: "e2e_schedules", description: "Every schedule (business process) with its manager, trigger and final worker: schedule_header, latest revision.", params: [],
    eql: `[{:e2e.schedule/all [${HEADER.map((c) => `:e2e.schedule/${c[0]}`).join(" ")}]}]` },
  { name: "e2e_schedule_steps", description: "Every schedule's steps in order (worker, exchanges, routing keys): schedule_detail, latest revision.", params: [],
    eql: `[{:e2e.step/all [${DETAIL.map((c) => `:e2e.step/${c[0]}`).join(" ")}]}]` },
  { name: "e2e_worker_durations", description: "Each worker's P95 duration (start → end, successful runs) and the number of runs counted, in a time range.", params: range(EX.from, EX.to),
    eql: `{:entity {:e2e.durations/from ?from :e2e.durations/to ?to} :query [{:e2e.durations/workers [${DURATION.map((c) => `:e2e.duration/${c[0]}`).join(" ")}]}]}` },
];
