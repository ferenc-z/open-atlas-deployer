-- Engine test 2026-11-22 (pages-rethink §10.1 "业务发现引擎实测"): the schedule definitions change after seed.sql — a new
-- schedule 103 lab_heartbeat whose workers are the lab c250's ops-lab processors (Generate → Log), and schedule 101
-- invoice_email removed. Load after seed.sql:
--   docker exec -i oa-e2e-clickhouse clickhouse-client -u e2e --password e2e-test --multiquery < testdata/e2e-trace/change.sql

INSERT INTO e2e_trace.schedule_header (schedule_id, schedule_name, schedule_desc, schedule_type, manager_id, manager_name, manager_mq_name, trigger_exchange_name, trigger_routing_key, final_schedule_seq, final_worker_id, project_name, on_demand_flag, entry_datetime)
SELECT 103, 'lab_heartbeat', 'A generated heartbeat, logged', 'data', 3, 'lab_manager', 'q.lab_manager', 'ex.trigger', 'lab.trigger', 2, 32, 'lab', 'auto', now64(3);

INSERT INTO e2e_trace.schedule_detail (schedule_id, schedule_name, schedule_seq, worker_id, worker_name, worker_message_name, previous_worker_id, previous_worker_name, worker_exchange_name, worker_routing_key, manager_exchange_name, manager_routing_key, entry_datetime)
SELECT 103, 'lab_heartbeat', 1, 31, 'Generate', 'msg.Generate', 0, '', 'ex.worker', 'lab.Generate', 'ex.manager', 'lab_manager.reply', now64(3);

INSERT INTO e2e_trace.schedule_detail (schedule_id, schedule_name, schedule_seq, worker_id, worker_name, worker_message_name, previous_worker_id, previous_worker_name, worker_exchange_name, worker_routing_key, manager_exchange_name, manager_routing_key, entry_datetime)
SELECT 103, 'lab_heartbeat', 2, 32, 'Log', 'msg.Log', 31, 'Generate', 'ex.worker', 'lab.Log', 'ex.manager', 'lab_manager.reply', now64(3);

ALTER TABLE e2e_trace.schedule_header DELETE WHERE schedule_id = 101 SETTINGS mutations_sync = 1;
ALTER TABLE e2e_trace.schedule_detail DELETE WHERE schedule_id = 101 SETTINGS mutations_sync = 1;

SELECT schedule_id, schedule_name FROM e2e_trace.schedule_header FINAL ORDER BY schedule_id;
