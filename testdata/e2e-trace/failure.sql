-- Engine test 2026-11-22 (P3 e2e-failed): one lab_heartbeat run (schedule 103 from change.sql) that fails at its second
-- worker, Log, a minute ago. The business scan reads it within 5 minutes and the business that has schedule-103 turns
-- attention with an e2e-failed problem. Load after change.sql:
--   docker exec -i oa-e2e-clickhouse clickhouse-client -u e2e --password e2e-test --multiquery < testdata/e2e-trace/failure.sql

INSERT INTO e2e_trace.rt_dwd_l1_trace_log (entity_name, correlation_id, schedule_id, schedule_name, schedule_seq, manager_id, manager_name, worker_id, worker_name, worker_message_name, process_stage, process_status, on_demand_flag, node_name, file_name, has_next_worker, final_schedule_seq, final_worker_id, final_worker_name, receive_datetime, entry_datetime)
SELECT 'lab', toUUID('ffffffff-0000-4000-8000-00000000000f'), 103, 'lab_heartbeat', p.1, 3, 'lab_manager', 30 + p.1, arrayElement(['Generate', 'Log'], p.1), concat('msg.', arrayElement(['Generate', 'Log'], p.1)),
  p.2, p.3, 'auto', 'c250-1', 'HB-F-001.txt', if(p.1 = 2, 0, 1), 2, 32, 'Log', now64(3) - toIntervalSecond(p.4), now64(3) - toIntervalSecond(p.4)
FROM (SELECT arrayJoin([(1, 'start', 'success', 90), (1, 'end', 'success', 85), (2, 'start', 'success', 80), (2, 'end', 'failure', 60)]) AS p);

SELECT worker_name, process_stage, process_status, receive_datetime FROM e2e_trace.rt_dwd_l1_trace_log WHERE schedule_id = 103 ORDER BY receive_datetime;
