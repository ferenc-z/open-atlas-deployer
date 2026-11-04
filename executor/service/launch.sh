#!/bin/sh
# Starts the service executor (design S18, §8.6) for systemd, or by hand on a host without root (see install.sh).
# Installed once beside the releases and rarely changed: it is what takes the executor back to the previous release
# when a new one does not start.
#
# An upgrade points `current` at the new release and writes <work>/upgrade-pending holding the previous release's
# directory name. The executor deletes that file once its self-check passes. Until then each start counts; after three
# failed starts this switches `current` back.
set -eu
base=${EXECUTOR_BASE:-/opt/open-atlas-deployer/service-executor}
work=${EXECUTOR_WORK:-/var/lib/open-atlas-service-executor}
marker="$work/upgrade-pending"
if [ -f "$marker" ]; then
  count_file="$work/upgrade-starts"
  count=$(( $(cat "$count_file" 2>/dev/null || echo 0) + 1 ))
  echo "$count" > "$count_file"
  if [ "$count" -gt 3 ]; then
    previous=$(cat "$marker")
    if [ -n "$previous" ] && [ -d "$base/releases/$previous" ]; then
      ln -sfn "releases/$previous" "$base/current.tmp" && mv -T "$base/current.tmp" "$base/current"
      echo "service executor upgrade failed $((count - 1)) starts in a row; back on $previous" >&2
      echo "{\"rolledBackTo\": \"$previous\", \"at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > "$work/upgrade-failed.json"
    fi
    rm -f "$marker" "$count_file"
  fi
else
  rm -f "$work/upgrade-starts"
fi
exec python3 "$base/current/service_executor.py" serve
