-- 生产 ClickHouse e2e_trace 三张表的 DDL（owner 2026-11-18 提供，SHOW CREATE TABLE 原样）
-- 用途：pages-rethink.md §6 第 7 步在本地 ClickHouse 22.8 建表、造测试数据。

CREATE TABLE e2e_trace.schedule_header
(
    `schedule_id` Int32 COMMENT 'schedule_id',
    `schedule_name` LowCardinality(String) COMMENT 'schedule_name',
    `schedule_desc` Nullable(String) COMMENT 'schedule_desc',
    `schedule_type` LowCardinality(String) COMMENT 'schedule_type:data/business',
    `manager_id` Int32 COMMENT 'manager_id',
    `manager_name` LowCardinality(String) COMMENT 'manager_name',
    `manager_mq_name` LowCardinality(Nullable(String)) COMMENT 'manager_mq_name',
    `trigger_exchange_name` LowCardinality(Nullable(String)) COMMENT 'trigger_exchange_name:trigger -> manager',
    `trigger_routing_key` LowCardinality(Nullable(String)) COMMENT 'trigger_routing_key:trigger -> manager',
    `final_schedule_seq` Nullable(Int32) COMMENT 'final_schedule_seq: -> next trigger',
    `final_worker_id` Nullable(Int32) COMMENT 'final_worker_id: -> next trigger',
    `project_name` LowCardinality(Nullable(String)) COMMENT 'project_name',
    `on_demand_flag` LowCardinality(String) COMMENT 'on_demand_flag:on_demand/auto',
    `entry_datetime` DateTime64(3) DEFAULT now() COMMENT 'entry_datetime'
)
ENGINE = ReplacingMergeTree(entry_datetime)
ORDER BY schedule_id
SETTINGS index_granularity = 8192;

CREATE TABLE e2e_trace.schedule_detail
(
    `schedule_id` Int32 COMMENT 'schedule_id',
    `schedule_name` LowCardinality(String) COMMENT 'schedule_name',
    `schedule_seq` Int32 COMMENT 'schedule_seq',
    `worker_id` Int32 COMMENT 'worker_id',
    `worker_name` LowCardinality(String) COMMENT 'worker_name',
    `worker_message_name` LowCardinality(String) COMMENT 'worker_message_name',
    `previous_worker_id` Int32 COMMENT 'previous_worker_id',
    `previous_worker_name` LowCardinality(String) COMMENT 'previous_worker_name',
    `worker_exchange_name` LowCardinality(Nullable(String)) COMMENT 'worker_exchange_name:manager -> worker',
    `worker_routing_key` LowCardinality(Nullable(String)) COMMENT 'worker_routing_key:manager -> worker',
    `manager_exchange_name` LowCardinality(Nullable(String)) COMMENT 'manager_exchange_name:worker -> manager',
    `manager_routing_key` LowCardinality(Nullable(String)) COMMENT 'manager_routing_key:worker -> manager',
    `entry_datetime` DateTime64(3) DEFAULT now() COMMENT 'entry_datetime'
)
ENGINE = ReplacingMergeTree(entry_datetime)
ORDER BY (schedule_id, schedule_seq, worker_id)
SETTINGS index_granularity = 8192;

CREATE TABLE e2e_trace.rt_dwd_l1_trace_log
(
    `entity_name` LowCardinality(String) COMMENT 'entity_name',
    `correlation_id` UUID COMMENT 'correlation_id',
    `schedule_id` Nullable(Int32) COMMENT 'schedule_id',
    `schedule_name` LowCardinality(Nullable(String)) COMMENT 'schedule_name',
    `schedule_seq` Nullable(Int32) COMMENT 'schedule_seq',
    `manager_id` Nullable(Int32) COMMENT 'manager_id',
    `manager_name` LowCardinality(String) COMMENT 'manager_name',
    `worker_id` Nullable(Int32) COMMENT 'worker_id',
    `worker_name` LowCardinality(String) COMMENT 'worker_name',
    `reply_to` LowCardinality(Nullable(String)) COMMENT 'reply_to',
    `worker_message_name` LowCardinality(String) COMMENT 'worker_message_name',
    `process_stage` LowCardinality(String) COMMENT 'process_stage:start/end/processing',
    `process_status` LowCardinality(String) COMMENT 'process_status:success/failure',
    `on_demand_flag` LowCardinality(String) COMMENT 'on_demand_flag:on_demand/auto',
    `node_name` LowCardinality(String) COMMENT 'node_name',
    `edge_local_path` Nullable(String) COMMENT 'edge_local_path',
    `source_path` Nullable(String) COMMENT 'source_path',
    `source_type` LowCardinality(Nullable(String)) COMMENT 'source_type',
    `interchange_type` LowCardinality(Nullable(String)) COMMENT 'interchange_type',
    `project_conf_key` LowCardinality(Nullable(String)) COMMENT 'project_conf_key',
    `file_conf_key` LowCardinality(Nullable(String)) COMMENT 'file_conf_key',
    `entity_url` Nullable(String) COMMENT 'entity_url',
    `attachment_url` Nullable(String) COMMENT 'attachment_url',
    `file_name` Nullable(String) COMMENT 'file_name',
    `original_file_size` Nullable(String) COMMENT 'original_file_size',
    `file_size` Nullable(String) COMMENT 'file_size',
    `file_type` LowCardinality(Nullable(String)) COMMENT 'file_type',
    `file_md5` Nullable(String) COMMENT 'file_md5',
    `file_id` Nullable(UUID) COMMENT 'file_id',
    `biz_country_code` LowCardinality(Nullable(String)) COMMENT 'biz_country_code',
    `biz_category` LowCardinality(Nullable(String)) COMMENT 'biz_category',
    `biz_domain` LowCardinality(Nullable(String)) COMMENT 'biz_domain',
    `biz_partner_name` LowCardinality(Nullable(String)) COMMENT 'biz_partner_name',
    `biz_partner_category` LowCardinality(Nullable(String)) COMMENT 'biz_partner_category',
    `biz_project_name` LowCardinality(Nullable(String)) COMMENT 'biz_project_name',
    `biz_project_owner` LowCardinality(Nullable(String)) COMMENT 'biz_project_owner',
    `biz_process_code` LowCardinality(Nullable(String)) COMMENT 'biz_process_code',
    `biz_process_name` LowCardinality(Nullable(String)) COMMENT 'biz_process_name',
    `original_email_name` Nullable(String) COMMENT 'original_email_name',
    `email_attachment_count` Nullable(Int32) COMMENT 'email_attachment_count',
    `email_from` Nullable(String) COMMENT 'email_from',
    `email_to` Nullable(String) COMMENT 'email_to',
    `email_cc` Nullable(String) COMMENT 'email_cc',
    `email_bcc` Nullable(String) COMMENT 'email_bcc',
    `email_message_id` Nullable(String) COMMENT 'email_message_id',
    `email_received_date` Nullable(DateTime64(3)) COMMENT 'email_received_date',
    `email_sent_date` Nullable(DateTime64(3)) COMMENT 'email_sent_date',
    `email_subject` Nullable(String) COMMENT 'email_subject',
    `previous_worker_id` Nullable(Int32) COMMENT 'previous_worker_id: get from schedule_detail ',
    `previous_worker_name` LowCardinality(Nullable(String)) COMMENT 'previous_worker_name: get from schedule_detail ',
    `next_worker_ids` Array(Nullable(Int32)) COMMENT 'next_worker_ids: get from schedule_detail',
    `next_worker_names` Array(LowCardinality(Nullable(String))) COMMENT 'next_worker_names: get from schedule_detail',
    `has_next_worker` UInt8 DEFAULT 1 COMMENT 'has_next_worker: 1=has next, 0=no next',
    `final_schedule_seq` Nullable(Int32) COMMENT 'final_schedule_seq: -> next trigger',
    `final_worker_id` Nullable(Int32) COMMENT 'final_worker_id: get from schedule_header',
    `final_worker_name` LowCardinality(Nullable(String)) COMMENT 'final_worker_name: get from schedule_header',
    `receive_datetime` DateTime64(3) COMMENT 'receive_datetime',
    `entry_datetime` DateTime64(3) COMMENT 'entry_datetime',
    `etl_datetime` DateTime64(3) DEFAULT now() COMMENT 'etl_datetime'
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(receive_datetime)
ORDER BY (toStartOfHour(receive_datetime), manager_name, worker_name, correlation_id)
SETTINGS index_granularity = 3000;
