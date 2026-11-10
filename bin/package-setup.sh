#!/bin/sh
# Builds the setup archive attached to the release v<version> (design §15.6 ⑦): one download for a new host, holding
# bootstrap.sh, the Deployer's compose.yaml and deployer.env.example, and the executors' files with their install.sh
# (executor/: the deploy executor; service-executor/: the service executor for managed services such as NiFi, §16.4 step 16).
#   bin/package-setup.sh <out directory>        → <out>/open-atlas-deployer-setup-<version>.tar.gz and SHA256SUMS
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
out=${1:?usage: package-setup.sh <out directory>}
version=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$root/package.json" | head -n 1)
name=open-atlas-deployer-setup-$version
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/$name/deployer" "$tmp/$name/executor" "$tmp/$name/service-executor"
printf '%s\n' "$version" > "$tmp/$name/VERSION"
install -m 755 "$root/bin/bootstrap.sh" "$tmp/$name/bootstrap.sh"
install -m 644 "$root/examples/deployer/compose.yaml" "$root/examples/deployer/deployer.env.example" "$tmp/$name/deployer/"
for f in launch.sh switch install.sh; do install -m 755 "$root/executor/$f" "$tmp/$name/executor/"; done
for f in open-atlas-deployer-executor.service executor.env.example; do install -m 644 "$root/executor/$f" "$tmp/$name/executor/"; done
# S18: the executor as one file, executor_core.py bundled in (as in its own release, executor/package.sh).
"${PYTHON:-python3}" "$root/executor/bundle.py" "$root/executor/deployer_executor.py" "$tmp/$name/executor/deployer_executor.py"
chmod 644 "$tmp/$name/executor/deployer_executor.py"
# The service executor (laid out as executor/service/package.sh does); its version must be the deploy executor's.
for f in launch.sh switch install.sh; do install -m 755 "$root/executor/service/$f" "$tmp/$name/service-executor/"; done
for f in open-atlas-service-executor.service service-executor.env.example; do install -m 644 "$root/executor/service/$f" "$tmp/$name/service-executor/"; done
"${PYTHON:-python3}" "$root/executor/bundle.py" "$root/executor/service_executor.py" "$tmp/$name/service-executor/service_executor.py"
chmod 644 "$tmp/$name/service-executor/service_executor.py"
deploy_version=$(sed -n 's/^VERSION = "\(.*\)"/\1/p' "$root/executor/deployer_executor.py")
service_version=$(sed -n 's/^VERSION = "\(.*\)"/\1/p' "$root/executor/service_executor.py")
[ "$deploy_version" = "$service_version" ] || { echo "executor versions differ: deploy $deploy_version, service $service_version" >&2; exit 1; }
mkdir -p "$out"
tar -C "$tmp" --owner=0 --group=0 -czf "$out/$name.tar.gz" "$name"
(cd "$out" && sha256sum "$name.tar.gz" > SHA256SUMS)
echo "$out/$name.tar.gz"
