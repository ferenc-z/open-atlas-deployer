#!/bin/sh
# Builds the service executor's release (design S18, §8.6): <out>/open-atlas-service-executor-<version>.tar.gz, and
# SHA256SUMS over every executor archive in <out>. It goes in the same release executor-v<version> as the deploy
# executor's (executor/package.sh), which has the same version: run both into the same directory.
# service_executor.py goes in bundled with executor_core.py (bundle.py). Needs python3 (or $PYTHON).
#   executor/service/package.sh <out directory>
set -eu
here=$(cd "$(dirname "$0")" && pwd)
code=$(cd "$here/.." && pwd)
out=${1:?usage: package.sh <out directory>}
version=$(sed -n 's/^VERSION = "\(.*\)"/\1/p' "$code/service_executor.py")
name=open-atlas-service-executor-$version
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/$name"
"${PYTHON:-python3}" "$code/bundle.py" "$code/service_executor.py" "$tmp/$name/service_executor.py"
for f in launch.sh switch install.sh open-atlas-service-executor.service service-executor.env.example; do
  cp "$here/$f" "$tmp/$name/"
done
chmod 755 "$tmp/$name/launch.sh" "$tmp/$name/switch" "$tmp/$name/install.sh"
chmod 644 "$tmp/$name/service_executor.py" "$tmp/$name/open-atlas-service-executor.service" "$tmp/$name/service-executor.env.example"
mkdir -p "$out"
tar -C "$tmp" --owner=0 --group=0 -czf "$out/$name.tar.gz" "$name"
(cd "$out" && sha256sum open-atlas-*executor-*.tar.gz > SHA256SUMS)
echo "$out/$name.tar.gz"
echo "attach it and SHA256SUMS to the release executor-v$version"
