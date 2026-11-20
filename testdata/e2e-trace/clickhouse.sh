#!/bin/sh
# S37 step 7: a local ClickHouse 22.8 (the production version) with the e2e_trace tables from the production DDL
# (ddl.sql, as given by the owner) and the test data (seed.sql). On the open-atlas_default network as oa-e2e-clickhouse,
# so Studio containers reach it at http://oa-e2e-clickhouse:8123; on the host at 127.0.0.1:18123 (HTTP).
#   sh testdata/e2e-trace/clickhouse.sh start   create (first time) or start the container, create the tables once
#   sh testdata/e2e-trace/clickhouse.sh seed    reload the test data (times are relative to now)
#   sh testdata/e2e-trace/clickhouse.sh stop | sql '<query>'
set -eu
here=$(cd "$(dirname "$0")" && pwd)
name=oa-e2e-clickhouse
q() { docker exec -i "$name" clickhouse-client --multiquery "$@"; }
case "${1:-}" in
start)
  if docker inspect "$name" >/dev/null 2>&1; then docker start "$name" >/dev/null
  else docker run -d --name "$name" --network open-atlas_default -p 127.0.0.1:18123:8123 --ulimit nofile=262144:262144 \
    -e CLICKHOUSE_DB=e2e_trace -e CLICKHOUSE_USER=e2e -e CLICKHOUSE_PASSWORD=e2e-test -e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 \
    clickhouse/clickhouse-server:22.8 >/dev/null
  fi
  i=0; until docker exec "$name" clickhouse-client -u e2e --password e2e-test -q 'SELECT 1' >/dev/null 2>&1; do i=$((i+1)); [ $i -gt 60 ] && { echo "ClickHouse did not come up"; exit 1; }; sleep 1; done
  if [ "$(q -u e2e --password e2e-test -q "EXISTS TABLE e2e_trace.rt_dwd_l1_trace_log")" != 1 ]; then
    q -u e2e --password e2e-test < "$here/ddl.sql"; echo "tables created"
  fi
  echo "$name up";;
seed) q -u e2e --password e2e-test < "$here/seed.sql"; q -u e2e --password e2e-test -q "SELECT count() FROM e2e_trace.rt_dwd_l1_trace_log";;
sql) shift; q -u e2e --password e2e-test -q "$*";;
stop) docker stop "$name" >/dev/null; echo stopped;;
*) echo "usage: $0 start|seed|sql <query>|stop"; exit 2;;
esac
