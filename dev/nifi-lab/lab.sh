#!/usr/bin/env bash
# Start / stop / check the local NiFi lab (see setup.sh).
#
#   lab.sh start  [name...]   ZooKeeper (if a cluster member is named) + NiFi
#   lab.sh stop   [name...]   NiFi, then ZooKeeper when all are named
#   lab.sh status [name...]   process, system-diagnostics with the monitor cert,
#                             cluster connection summary
#   lab.sh wait   [name...]   wait until system-diagnostics answers (max 5 min)
#   lab.sh grant              (once after first start) give monitor/nginx/
#                             operator their policies, using the operator cert
#   lab.sh curl NAME PATH [cert]   GET https://localhost:PORT/nifi-api/PATH
#                             with cert monitor (default) | operator | nginx
#
# Names: n112 n200 c250-1 c250-2 (lab.conf); none = all.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/lab.conf"
PEM="$LAB/certs/pem"
ZKHOME="$LAB/dist/zookeeper-$ZK_VERSION"

cmd="${1:-status}"; shift || true
names=("$@"); [ ${#names[@]} -eq 0 ] && names=($(instances))

is_member() { [ "$(inst_field "$1" 6)" != "-" ]; }
any_member() { for n in "${names[@]}"; do is_member "$n" && return 0; done; return 1; }

zk() {
  ZOOCFGDIR="$LAB/zk/conf" ZOO_LOG_DIR="$LAB/zk/logs" JAVA_HOME="$LAB/jdk/11" \
    setsid "$ZKHOME/bin/zkServer.sh" "$@" </dev/null
}

app_pid() { # name -> pid of the NiFi JVM (not the bootstrap), empty if none
  pgrep -u "$(id -u)" -f "nifi.properties.file.path=$LAB/instances/$1/(\./)?conf/nifi.properties .*org.apache.nifi.NiFi" | head -1
}

api() { # name path [cert]
  local port; port=$(inst_field "$1" 4); local c="${3:-monitor}"
  curl -sS --max-time 20 --cacert "$PEM/ca.crt" --cert "$PEM/$c.crt" --key "$PEM/$c.key" \
    "https://localhost:$port/nifi-api/$2"
}

diag() { # name -> "HTTP <code> version <v> heap <used>/<max>"
  local port; port=$(inst_field "$1" 4)
  local out code
  out=$(curl -sS --max-time 20 -w '\n%{http_code}' --cacert "$PEM/ca.crt" \
    --cert "$PEM/monitor.crt" --key "$PEM/monitor.key" \
    "https://localhost:$port/nifi-api/system-diagnostics" 2>/dev/null)
  code="${out##*$'\n'}"
  if [ "$code" = 200 ]; then
    echo "${out%$'\n'*}" | python3 -I -c '
import json,sys
d=json.load(sys.stdin)["systemDiagnostics"]["aggregateSnapshot"]
v=d.get("versionInfo",{})
print("HTTP 200 nifi", v.get("niFiVersion"), "java", v.get("javaVersion"), "heap", d.get("usedHeap"), "/", d.get("maxHeap"))'
  else
    echo "HTTP $code"
  fi
}

case "$cmd" in
  start)
    if any_member; then zk start; fi
    for n in "${names[@]}"; do
      # setsid + nohup: survive the end of the calling (wsl -e) session.
      echo "== start $n"; setsid nohup "$LAB/instances/$n/bin/nifi.sh" start </dev/null >/dev/null 2>&1 || echo "start $n failed"
    done ;;
  stop)
    for n in "${names[@]}"; do
      echo "== stop $n"; "$LAB/instances/$n/bin/nifi.sh" stop >/dev/null 2>&1
    done
    [ ${#names[@]} -eq "$(instances | wc -l)" ] && zk stop ;;
  status)
    if any_member; then printf '%-8s %s\n' zk "$(echo srvr | curl -s --max-time 3 telnet://127.0.0.1:$ZK_PORT 2>/dev/null | head -1 || true)"; fi
    for n in "${names[@]}"; do
      p=$(app_pid "$n"); st="${p:+pid $p}"; st="${st:-stopped}"
      printf '%-8s %-6s %-6s %-12s %s\n' "$n" "$(inst_field "$n" 2)" "$(inst_field "$n" 4)" "$st" "$(diag "$n")"
    done
    for n in "${names[@]}"; do
      if is_member "$n"; then
        printf '%-8s %s\n' cluster "$(api "$n" flow/cluster/summary | python3 -I -c '
import json,sys
try:
  s=json.load(sys.stdin)["clusterSummary"]; print("connected", s["connectedNodes"], "clustered", s["clustered"])
except Exception as e: print("unavailable", e)')"
        break
      fi
    done ;;
  wait)
    for n in "${names[@]}"; do
      for i in $(seq 1 60); do
        r=$(diag "$n")
        case "$r" in
          "HTTP 200"*) echo "$n up"; break;;
          # 403: NiFi answers but policies are not granted yet.
          "HTTP 403"*) echo "$n up (403, run grant)"; break;;
        esac
        if [ $i -gt 6 ] && [ -z "$(app_pid "$n")" ]; then
          echo "$n not running, see $LAB/instances/$n/logs/nifi-app.log"; break
        fi
        sleep 5
      done
    done ;;
  grant)
    gr=(
      "/flow|read|$CLIENT_MONITOR" "/system|read|$CLIENT_MONITOR" "/controller|read|$CLIENT_MONITOR"
      "/proxy|read|$CLIENT_NGINX" "/proxy|write|$CLIENT_NGINX"
      "/system|read|$CLIENT_OPERATOR" "/provenance|read|$CLIENT_OPERATOR"
    )
    done_cluster=""
    for n in "${names[@]}"; do
      if is_member "$n"; then [ -n "$done_cluster" ] && continue; done_cluster=1; fi
      echo "== grant on $n"
      python3 -I "$HERE/grant.py" "https://localhost:$(inst_field "$n" 4)/nifi-api" \
        "$PEM/operator.crt" "$PEM/operator.key" "$PEM/ca.crt" "${gr[@]}"
    done ;;
  curl)
    api "${names[0]}" "${names[1]}" "${names[2]:-monitor}"; echo ;;
  *) sed -n '2,16p' "$0"; exit 2 ;;
esac
