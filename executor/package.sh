#!/bin/sh
# Builds the executor's release (design §8.6): <out>/open-atlas-deployer-executor-<version>.tar.gz and SHA256SUMS.
# Attach both to the GitHub release executor-v<version>, or copy them to <directory>/executor-v<version>/ for hosts
# whose EXECUTOR_UPGRADE_FROM is a directory. A first installation unpacks the same archive and runs its install.sh.
#   executor/package.sh <out directory>
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out=${1:?usage: package.sh <out directory>}
version=$(sed -n 's/^VERSION = "\(.*\)"/\1/p' "$here/deployer_executor.py")
name=open-atlas-deployer-executor-$version
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/$name"
for f in deployer_executor.py launch.sh switch install.sh open-atlas-deployer-executor.service executor.env.example; do
  cp "$here/$f" "$tmp/$name/"
done
chmod 755 "$tmp/$name/launch.sh" "$tmp/$name/switch" "$tmp/$name/install.sh"
chmod 644 "$tmp/$name/deployer_executor.py" "$tmp/$name/open-atlas-deployer-executor.service" "$tmp/$name/executor.env.example"
mkdir -p "$out"
tar -C "$tmp" --owner=0 --group=0 -czf "$out/$name.tar.gz" "$name"
(cd "$out" && sha256sum "$name.tar.gz" > SHA256SUMS)
echo "$out/$name.tar.gz"
echo "attach it and SHA256SUMS to the release executor-v$version"
