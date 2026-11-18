-- S37 step 7: e2e_trace test data (pages-rethink §6: the run-record cases normal / failure / stuck at the MQ hand-over /
-- a missing piece). Times are relative to now(), so load it shortly before a test. Two schedules for the import:
-- 101 invoice_email (three workers, mail entry) and 102 sftp_orders (two workers). 101's header also has an older
-- revision, so a query without FINAL (or the latest entry_datetime) would read the wrong name.

TRUNCATE TABLE IF EXISTS e2e_trace.schedule_header;
TRUNCATE TABLE IF EXISTS e2e_trace.schedule_detail;
TRUNCATE TABLE IF EXISTS e2e_trace.rt_dwd_l1_trace_log;

INSERT INTO e2e_trace.schedule_header (schedule_id, schedule_name, schedule_desc, schedule_type, manager_id, manager_name, manager_mq_name, trigger_exchange_name, trigger_routing_key, final_schedule_seq, final_worker_id, project_name, on_demand_flag, entry_datetime)
SELECT 101, 'invoice_email_old', 'old revision', 'business', 1, 'invoice_manager', 'q.invoice_manager', 'ex.trigger', 'invoice.trigger', 2, 12, 'finance', 'auto', now64(3) - INTERVAL 30 DAY;

INSERT INTO e2e_trace.schedule_header (schedule_id, schedule_name, schedule_desc, schedule_type, manager_id, manager_name, manager_mq_name, trigger_exchange_name, trigger_routing_key, final_schedule_seq, final_worker_id, project_name, on_demand_flag, entry_datetime)
SELECT 101, 'invoice_email', 'Invoices sent by mail, parsed and pushed to the ERP', 'business', 1, 'invoice_manager', 'q.invoice_manager', 'ex.trigger', 'invoice.trigger', 3, 13, 'finance', 'auto', now64(3) - INTERVAL 1 DAY;

INSERT INTO e2e_trace.schedule_header (schedule_id, schedule_name, schedule_desc, schedule_type, manager_id, manager_name, manager_mq_name, trigger_exchange_name, trigger_routing_key, final_schedule_seq, final_worker_id, project_name, on_demand_flag, entry_datetime)
SELECT 102, 'sftp_orders', NULL, 'data', 2, 'orders_manager', NULL, 'ex.trigger', 'orders.trigger', 2, 22, NULL, 'on_demand', now64(3) - INTERVAL 1 DAY;

INSERT INTO e2e_trace.schedule_detail (schedule_id, schedule_name, schedule_seq, worker_id, worker_name, worker_message_name, previous_worker_id, previous_worker_name, worker_exchange_name, worker_routing_key, manager_exchange_name, manager_routing_key, entry_datetime)
SELECT 101, 'invoice_email', 1, 11, 'mail_reader', 'msg.mail_reader', 0, '', 'ex.worker', 'invoice.mail_reader', 'ex.manager', 'invoice_manager.reply', now64(3) - INTERVAL 1 DAY;

INSERT INTO e2e_trace.schedule_detail (schedule_id, schedule_name, schedule_seq, worker_id, worker_name, worker_message_name, previous_worker_id, previous_worker_name, worker_exchange_name, worker_routing_key, manager_exchange_name, manager_routing_key, entry_datetime)
SELECT 101, 'invoice_email', 2, 12, 'pdf_parser', 'msg.pdf_parser', 11, 'mail_reader', 'ex.worker', 'invoice.pdf_parser', 'ex.manager', 'invoice_manager.reply', now64(3) - INTERVAL 1 DAY;

INSERT INTO e2e_trace.schedule_detail (schedule_id, schedule_name, schedule_seq, worker_id, worker_name, worker_message_name, previous_worker_id, previous_worker_name, worker_exchange_name, worker_routing_key, manager_exchange_name, manager_routing_key, entry_datetime)
SELECT 101, 'invoice_email', 3, 13, 'erp_pusher', 'msg.erp_pusher', 12, 'pdf_parser', 'ex.worker', 'invoice.erp_pusher', 'ex.manager', 'invoice_manager.reply', now64(3) - INTERVAL 1 DAY;

INSERT INTO e2e_trace.schedule_detail (schedule_id, schedule_name, schedule_seq, worker_id, worker_name, worker_message_name, previous_worker_id, previous_worker_name, worker_exchange_name, worker_routing_key, manager_exchange_name, manager_routing_key, entry_datetime)
SELECT 101, 'invoice_email', 2, 12, 'pdf_parser', 'msg.pdf_parser_v0', 11, 'mail_reader', NULL, NULL, NULL, NULL, now64(3) - INTERVAL 30 DAY;

INSERT INTO e2e_trace.schedule_detail (schedule_id, schedule_name, schedule_seq, worker_id, worker_name, worker_message_name, previous_worker_id, previous_worker_name, worker_exchange_name, worker_routing_key, manager_exchange_name, manager_routing_key, entry_datetime)
SELECT 102, 'sftp_orders', 1, 21, 'sftp_fetcher', 'msg.sftp_fetcher', 0, '', 'ex.worker', 'orders.sftp_fetcher', 'ex.manager', 'orders_manager.reply', now64(3) - INTERVAL 1 DAY;

INSERT INTO e2e_trace.schedule_detail (schedule_id, schedule_name, schedule_seq, worker_id, worker_name, worker_message_name, previous_worker_id, previous_worker_name, worker_exchange_name, worker_routing_key, manager_exchange_name, manager_routing_key, entry_datetime)
SELECT 102, 'sftp_orders', 2, 22, 'order_loader', 'msg.order_loader', 21, 'sftp_fetcher', 'ex.worker', 'orders.order_loader', 'ex.manager', 'orders_manager.reply', now64(3) - INTERVAL 1 DAY;

-- Run records. One row per (case, seq, stage): (correlation_id, case letter, seq, stage, status, seconds before now, has_next_worker).
INSERT INTO e2e_trace.rt_dwd_l1_trace_log (entity_name, correlation_id, schedule_id, schedule_name, schedule_seq, manager_id, manager_name, worker_id, worker_name, reply_to, worker_message_name, process_stage, process_status, on_demand_flag, node_name, source_type, file_name, file_type, email_from, email_to, email_subject, email_message_id, email_received_date, previous_worker_id, previous_worker_name, next_worker_ids, next_worker_names, has_next_worker, final_schedule_seq, final_worker_id, final_worker_name, receive_datetime, entry_datetime)
SELECT 'invoice', toUUID(r.1), 101, 'invoice_email', r.3, 1, 'invoice_manager',
  10 + r.3, arrayElement(['mail_reader', 'pdf_parser', 'erp_pusher'], r.3), 'q.invoice_manager', concat('msg.', arrayElement(['mail_reader', 'pdf_parser', 'erp_pusher'], r.3)),
  r.4, r.5, 'auto', if(r.3 = 2, 'c250-2', 'c250-1'), 'email',
  concat('INV-', r.2, '-001.pdf'), 'pdf', concat('billing-', lower(r.2), '@supplier.example'), 'invoices@corp.example', concat('Invoice ', r.2, '-001'), concat('<', r.2, '@mail.example>'),
  now64(3) - toIntervalSecond(r.6 + 30),
  if(r.3 = 1, NULL, 9 + r.3), if(r.3 = 1, NULL, arrayElement(['mail_reader', 'pdf_parser'], r.3 - 1)),
  if(r.3 = 3, [], [toNullable(toInt32(11 + r.3))]), if(r.3 = 3, [], [toNullable(arrayElement(['pdf_parser', 'erp_pusher'], r.3))]),
  r.7, 3, 13, 'erp_pusher',
  now64(3) - toIntervalSecond(r.6), now64(3) - toIntervalSecond(r.6) + INTERVAL 2 SECOND
FROM (SELECT arrayJoin([
  -- A: normal, all three workers ended, the final one has no next worker.
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'A', 1, 'start', 'success', 2400, 1),
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'A', 1, 'end', 'success', 2390, 1),
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'A', 2, 'start', 'success', 2380, 1),
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'A', 2, 'end', 'success', 2350, 1),
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'A', 3, 'start', 'success', 2340, 1),
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'A', 3, 'end', 'success', 2320, 0),
  -- B: pdf_parser ends in failure.
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'B', 1, 'start', 'success', 2100, 1),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'B', 1, 'end', 'success', 2090, 1),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'B', 2, 'start', 'success', 2080, 1),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'B', 2, 'end', 'failure', 2060, 0),
  -- C: mail_reader ended an hour ago with a next worker; pdf_parser never started (stuck at the MQ hand-over).
  ('cccccccc-0000-4000-8000-00000000000c', 'C', 1, 'start', 'success', 3600, 1),
  ('cccccccc-0000-4000-8000-00000000000c', 'C', 1, 'end', 'success', 3590, 1),
  -- D: pdf_parser's records are missing (NiFi down), erp_pusher's are there: a gap in the run records.
  ('dddddddd-0000-4000-8000-00000000000d', 'D', 1, 'start', 'success', 1800, 1),
  ('dddddddd-0000-4000-8000-00000000000d', 'D', 1, 'end', 'success', 1790, 1),
  ('dddddddd-0000-4000-8000-00000000000d', 'D', 3, 'start', 'success', 1700, 1),
  ('dddddddd-0000-4000-8000-00000000000d', 'D', 3, 'end', 'success', 1690, 0)
]) AS r);

-- History for the T10 P95: 40 normal runs over the last three days, each worker taking 10 to 59 s.
INSERT INTO e2e_trace.rt_dwd_l1_trace_log (entity_name, correlation_id, schedule_id, schedule_name, schedule_seq, manager_id, manager_name, worker_id, worker_name, worker_message_name, process_stage, process_status, on_demand_flag, node_name, file_name, has_next_worker, final_schedule_seq, final_worker_id, final_worker_name, receive_datetime, entry_datetime)
SELECT 'invoice', cid, 101, 'invoice_email', seq, 1, 'invoice_manager', 10 + seq, arrayElement(['mail_reader', 'pdf_parser', 'erp_pusher'], seq), concat('msg.', arrayElement(['mail_reader', 'pdf_parser', 'erp_pusher'], seq)),
  stage, 'success', 'auto', 'c250-1', concat('HIST-', toString(n), '.pdf'), if(seq = 3 AND stage = 'end', 0, 1), 3, 13, 'erp_pusher',
  t, t
FROM (
  SELECT n, cid, p.1 AS seq, p.2 AS stage,
    now64(3) - toIntervalSecond(7200 + n * 5400) + toIntervalSecond((seq - 1) * 120 + if(stage = 'end', 10 + (n * 7 + seq * 13) % 50, 0)) AS t
  FROM (SELECT number AS n, generateUUIDv4() AS cid FROM numbers(40))
  ARRAY JOIN [(1, 'start'), (1, 'end'), (2, 'start'), (2, 'end'), (3, 'start'), (3, 'end')] AS p
);
