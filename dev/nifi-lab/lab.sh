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
#   lab.sh nginx start|stop|status  the lab's nginx (nginx.conf, 127.0.0.1:18543-18546)
#                             as this user; status asks each address for flow/about
#
# Names: n112 n200 c250-1 c250-2 (lab.conf); none = all.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/lab.conf"
PEM="$LAB/certs/pem"
ZKHOME="$LAB/dist/zookeeper-$ZK_VERSION"

cmd="${1:-status}"; shift || true
if [ "$cmd" = nginx ]; then ncmd="${1:-status}"; set --; fi
names=("$@"); [ ${#names[@]} -eq 0 ] && names=($(instances))
NGX="$LAB/nginx"
# address|what it fronts (nginx.conf)
NGINX_TABLE="18543|n112
18544|n200
18545|c250-1 c250-2
18546/n112|n112 (by path)
18546/n200|n200 (by path)
18546/c250|c250 (by path)"

nginx_run() { nginx -p "$NGX" -e "$NGX/logs/error.log" -c "$NGX/nginx.conf" "$@"; }

is_member() { [ "$(inst_field "$1" 6)" != "-" ]; }
any_member() { for n in "${names[@]}"; do is_member "$n" && return 0; done; return 1; }

zk() {
  ZOOCFGDIR="$LAB/zk/conf" ZOO_LOG_DIR="$LAB/zk/logs" JAVA_HOME="$LAB/jdk/11" \
    setsid "$ZKHOME/bin/zkServer.sh" "$@" </dev/null
}

app_pid() { # name -> pid of the NiFi JVM (not the bootstrap), empty if none
  local props="$LAB/instances/$1/(\./)?conf/nifi.properties"
  is_split "$1" && props="$(inst_conf "$1")/nifi.properties"
  pgrep -u "$(id -u)" -f "nifi.properties.file.path=$props .*org.apache.nifi.NiFi" | head -1
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
      # S28: the service executor queries provenance with the monitor certificate: "query provenance" and "view
      # provenance" of the whole flow (the root process group; components inherit it).
      "/provenance|read|$CLIENT_MONITOR" "/provenance-data/process-groups/@root|read|$CLIENT_MONITOR"
      # Owner 2026-11-07: and "view the data" of the whole flow, so provenance events carry the FlowFile attributes
      # (NiFi hides them without it; it would also allow reading content, which the executor never asks for).
      "/data/process-groups/@root|read|$CLIENT_MONITOR"
      "/proxy|read|$CLIENT_NGINX" "/proxy|write|$CLIENT_NGINX"
      # P8: nginx calls NiFi as itself for Studio (S20): monitoring reads (provenance is the Deployer's own since S28).
      "/flow|read|$CLIENT_NGINX" "/system|read|$CLIENT_NGINX" "/controller|read|$CLIENT_NGINX"
      "/system|read|$CLIENT_OPERATOR" "/provenance|read|$CLIENT_OPERATOR"
    )
    done_cluster=""
    for n in "${names[@]}"; do
      if is_member "$n"; then [ -n "$done_cluster" ] && continue; done_cluster=1; fi
      # A cluster replicates a request to the node that holds the data with the receiving node as proxy, and NiFi
      # checks "view the data" for every identity in the chain: the nodes need it too, or attributes stay hidden.
      extra=()
      if is_member "$n"; then
        for m in $(instances); do is_member "$m" && extra+=("/data/process-groups/@root|read|$(node_dn "$(inst_field "$m" 5)")"); done
      fi
      echo "== grant on $n"
      python3 -I "$HERE/grant.py" "https://localhost:$(inst_field "$n" 4)/nifi-api" \
        "$PEM/operator.crt" "$PEM/operator.key" "$PEM/ca.crt" "${gr[@]}" "${extra[@]}"
    done ;;
  curl)
    api "${names[0]}" "${names[1]}" "${names[2]:-monitor}"; echo ;;
  nginx)
    command -v nginx >/dev/null || { echo "nginx is not installed (sudo apt-get install -y nginx-light, then sudo systemctl disable --now nginx)"; exit 1; }
    case "$ncmd" in
      start)
        mkdir -p "$NGX/logs" "$NGX/run" "$NGX/tmp"
        sed "s#@LAB@#$LAB#g" "$HERE/nginx.conf" > "$NGX/nginx.conf"
        if [ -f "$NGX/run/nginx.pid" ] && kill -0 "$(cat "$NGX/run/nginx.pid")" 2>/dev/null; then nginx_run -s reload && echo "nginx reloaded"
        else nginx_run -t -q && nginx_run </dev/null && echo "nginx started (daemon)"; fi ;;
      stop)
        [ -f "$NGX/run/nginx.pid" ] && nginx_run -s quit && echo "nginx stopped" || echo "nginx not running" ;;
      status)
        if [ -f "$NGX/run/nginx.pid" ] && kill -0 "$(cat "$NGX/run/nginx.pid")" 2>/dev/null; then echo "nginx pid $(cat "$NGX/run/nginx.pid")"; else echo "nginx stopped"; fi
        echo "$NGINX_TABLE" | while IFS='|' read -r port what; do
          printf '%-11s %-16s %s
' "$port" "$what" "$(curl -sS --max-time 10 -w ' HTTP %{http_code}' "http://127.0.0.1:$port/nifi-api/flow/about" 2>&1 | python3 -I -c '
import json,sys
t=sys.stdin.read(); body,_,code=t.rpartition(" HTTP ")
try: print("HTTP", code, "nifi", json.loads(body)["about"]["version"])
except Exception: print("HTTP", code, body[:120].strip())')"
        done ;;
      *) echo "usage: lab.sh nginx start|stop|status"; exit 2 ;;
    esac ;;
  *) sed -n '2,16p' "$0"; exit 2 ;;
esac
