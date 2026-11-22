#!/bin/sh
# 复杂流程实验的 e2e_trace 造数（schedule 201、202 和运行记录），写进本地 ClickHouse oa-e2e-clickhouse
# （testdata/e2e-trace/clickhouse.sh start 起的那个）。不动其他 schedule，可重复执行。
set -eu
here=$(cd "$(dirname "$0")" && pwd)
docker exec -i oa-e2e-clickhouse clickhouse-client -u e2e --password e2e-test --multiquery < "$here/seed-cx.sql"
