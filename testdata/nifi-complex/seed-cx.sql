-- 复杂流程实验（testdata/nifi-complex/spec.yaml 的 e2e 段）：两个跨实例的 schedule 和最近 5 小时的运行记录。
-- 201 invoice_mail_parse：n112 mail_attachment_reader → n112 invoice_pdf_extractor → c250 invoice_erp_poster →
--     invoice_approval_notifier（只在 schedule 里，画布上没有）；第 7 次运行在 invoice_pdf_extractor 失败。
-- 202 customs_receipt：n192 customs_receipt_reader → n112 customs_status_mapper → c250 customs_erp_updater。
-- 不清空其他 schedule（101/102/103 照旧），先删掉 201/202 再写，可重复执行。时间相对 now()。
--   sh testdata/nifi-complex/seed-cx.sh

ALTER TABLE e2e_trace.schedule_header DELETE WHERE schedule_id IN (201, 202) SETTINGS mutations_sync = 1;
ALTER TABLE e2e_trace.schedule_detail DELETE WHERE schedule_id IN (201, 202) SETTINGS mutations_sync = 1;
ALTER TABLE e2e_trace.rt_dwd_l1_trace_log DELETE WHERE schedule_id IN (201, 202) SETTINGS mutations_sync = 1;

INSERT INTO e2e_trace.schedule_header (schedule_id, schedule_name, schedule_desc, schedule_type, manager_id, manager_name, manager_mq_name, trigger_exchange_name, trigger_routing_key, final_schedule_seq, final_worker_id, project_name, on_demand_flag, entry_datetime) VALUES (201, 'invoice_mail_parse', 'Invoice mails: attachments read on the edge, PDF extracted, posted to the ERP, approval notified', 'business', 21, 'invoice_mail_manager', 'q.invoice_mail_manager', 'ex.trigger', 'invoice.mail', 4, 2104, 'finance', 'auto', now64(3)), (202, 'customs_receipt', 'Customs receipts from the legacy gateway, mapped on the edge, written back to the ERP', 'business', 22, 'customs_manager', 'q.customs_manager', 'ex.trigger', 'customs.receipt', 3, 2203, 'customs', 'auto', now64(3));

INSERT INTO e2e_trace.schedule_detail (schedule_id, schedule_name, schedule_seq, worker_id, worker_name, worker_message_name, previous_worker_id, previous_worker_name, worker_exchange_name, worker_routing_key, manager_exchange_name, manager_routing_key, entry_datetime) VALUES (201, 'invoice_mail_parse', 1, 2101, 'mail_attachment_reader', 'msg.mail_attachment_reader', 0, '', 'ex.worker', 'invoice.mail_attachment_reader', 'ex.manager', 'invoice_mail_manager.reply', now64(3)), (201, 'invoice_mail_parse', 2, 2102, 'invoice_pdf_extractor', 'msg.invoice_pdf_extractor', 2101, 'mail_attachment_reader', 'ex.worker', 'invoice.invoice_pdf_extractor', 'ex.manager', 'invoice_mail_manager.reply', now64(3)), (201, 'invoice_mail_parse', 3, 2103, 'invoice_erp_poster', 'msg.invoice_erp_poster', 2102, 'invoice_pdf_extractor', 'ex.worker', 'invoice.invoice_erp_poster', 'ex.manager', 'invoice_mail_manager.reply', now64(3)), (201, 'invoice_mail_parse', 4, 2104, 'invoice_approval_notifier', 'msg.invoice_approval_notifier', 2103, 'invoice_erp_poster', 'ex.worker', 'invoice.invoice_approval_notifier', 'ex.manager', 'invoice_mail_manager.reply', now64(3)), (202, 'customs_receipt', 1, 2201, 'customs_receipt_reader', 'msg.customs_receipt_reader', 0, '', 'ex.worker', 'customs.customs_receipt_reader', 'ex.manager', 'customs_manager.reply', now64(3)), (202, 'customs_receipt', 2, 2202, 'customs_status_mapper', 'msg.customs_status_mapper', 2201, 'customs_receipt_reader', 'ex.worker', 'customs.customs_status_mapper', 'ex.manager', 'customs_manager.reply', now64(3)), (202, 'customs_receipt', 3, 2203, 'customs_erp_updater', 'msg.customs_erp_updater', 2202, 'customs_status_mapper', 'ex.worker', 'customs.customs_erp_updater', 'ex.manager', 'customs_manager.reply', now64(3));

INSERT INTO e2e_trace.rt_dwd_l1_trace_log (entity_name, correlation_id, schedule_id, schedule_name, schedule_seq, manager_id, manager_name, worker_id, worker_name, worker_message_name, process_stage, process_status, on_demand_flag, node_name, file_name, has_next_worker, final_schedule_seq, final_worker_id, final_worker_name, receive_datetime, entry_datetime)
WITH ['mail_attachment_reader', 'invoice_pdf_extractor', 'invoice_erp_poster', 'invoice_approval_notifier'] AS w
SELECT 'invoice', toUUID(concat('c0000201-0000-4000-8000-', leftPad(toString(run), 12, '0'))), 201, 'invoice_mail_parse', seq, 21, 'invoice_mail_manager',
  2100 + seq, arrayElement(w, seq), concat('msg.', arrayElement(w, seq)), stage, if(run = 7 AND seq = 2 AND stage = 'end', 'failure', 'success'), 'auto',
  arrayElement(['n112', 'n112', 'c250-1', 'approval-svc'], seq), concat('INV-', toString(run), '.pdf'),
  if(seq = 4 OR (run = 7 AND seq = 2), 0, 1), 4, 2104, 'invoice_approval_notifier',
  now64(3) - toIntervalSecond(run * 600 - seq * 20 - if(stage = 'end', 10, 0)),
  now64(3) - toIntervalSecond(run * 600 - seq * 20 - if(stage = 'end', 10, 0)) + INTERVAL 2 SECOND
FROM (SELECT number + 1 AS run FROM numbers(30)) AS r
CROSS JOIN (SELECT arrayJoin([1, 2, 3, 4]) AS seq) AS s
CROSS JOIN (SELECT arrayJoin(['start', 'end']) AS stage) AS g
WHERE NOT (run = 7 AND seq > 2);

INSERT INTO e2e_trace.rt_dwd_l1_trace_log (entity_name, correlation_id, schedule_id, schedule_name, schedule_seq, manager_id, manager_name, worker_id, worker_name, worker_message_name, process_stage, process_status, on_demand_flag, node_name, file_name, has_next_worker, final_schedule_seq, final_worker_id, final_worker_name, receive_datetime, entry_datetime)
WITH ['customs_receipt_reader', 'customs_status_mapper', 'customs_erp_updater'] AS w
SELECT 'customs_receipt', toUUID(concat('c0000202-0000-4000-8000-', leftPad(toString(run), 12, '0'))), 202, 'customs_receipt', seq, 22, 'customs_manager',
  2200 + seq, arrayElement(w, seq), concat('msg.', arrayElement(w, seq)), stage, 'success', 'auto',
  arrayElement(['n192', 'n112', 'c250-2'], seq), concat('RCPT-', toString(run), '.edi'),
  if(seq = 3, 0, 1), 3, 2203, 'customs_erp_updater',
  now64(3) - toIntervalSecond(run * 450 - seq * 30 - if(stage = 'end', 15, 0)),
  now64(3) - toIntervalSecond(run * 450 - seq * 30 - if(stage = 'end', 15, 0)) + INTERVAL 2 SECOND
FROM (SELECT number + 1 AS run FROM numbers(40)) AS r
CROSS JOIN (SELECT arrayJoin([1, 2, 3]) AS seq) AS s
CROSS JOIN (SELECT arrayJoin(['start', 'end']) AS stage) AS g;

SELECT schedule_id, count() FROM e2e_trace.rt_dwd_l1_trace_log WHERE schedule_id IN (201, 202) GROUP BY schedule_id ORDER BY schedule_id;
SELECT schedule_id, schedule_name FROM e2e_trace.schedule_header FINAL ORDER BY schedule_id;
