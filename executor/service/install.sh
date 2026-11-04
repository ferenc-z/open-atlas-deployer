#!/bin/sh
# First installation of the service executor on a host (design S18, §8.6), from an unpacked release (or from the
# source: executor/service/install.sh). Needs Python 3.9+; no Docker.
#
#   sudo ./install.sh     the system service: /opt/open-atlas-deployer/service-executor, /etc/open-atlas-deployer,
#                         the systemd unit open-atlas-service-executor
#   ./install.sh          as an ordinary user: EXECUTOR_BASE and EXECUTOR_ENV_FILE must name places that user can
#                         write; no systemd unit. It then sees and manages only that user's services.
#
# Later versions are installed from the Deployer's Hosts page (executor-upgrade, with EXECUTOR_UPGRADE_FROM set);
# rerun this only when the release notes say launch.sh or the systemd unit changed.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
# From a release, the code is beside this file; from the source, one directory up.
code=$here
[ -f "$code/service_executor.py" ] || code=$(cd "$here/.." && pwd)
version=$(sed -n 's/^VERSION = "\(.*\)"/\1/p' "$code/service_executor.py")
python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))' || { echo "python3 >= 3.9 is required" >&2; exit 1; }
if [ "$(id -u)" = 0 ]; then
  base=${EXECUTOR_BASE:-/opt/open-atlas-deployer/service-executor}
  env_file=${EXECUTOR_ENV_FILE:-/etc/open-atlas-deployer/service-executor.env}
else
  base=${EXECUTOR_BASE:?not root: set EXECUTOR_BASE (and EXECUTOR_ENV_FILE) to places this user can write}
  env_file=${EXECUTOR_ENV_FILE:?not root: set EXECUTOR_ENV_FILE}
fi

mkdir -p "$base/releases/$version"
for f in launch.sh switch install.sh open-atlas-service-executor.service service-executor.env.example; do
  cp "$here/$f" "$base/releases/$version/"
done
if grep -q "^from executor_core import" "$code/service_executor.py"; then
  # From the source (S18): the release file is service_executor.py with executor_core.py bundled in, as package.sh makes it.
  python3 "$code/bundle.py" "$code/service_executor.py" "$base/releases/$version/service_executor.py"
else
  cp "$code/service_executor.py" "$base/releases/$version/"
fi
chmod 644 "$base/releases/$version/service_executor.py" "$base/releases/$version/open-atlas-service-executor.service" "$base/releases/$version/service-executor.env.example"
chmod 755 "$base/releases/$version/launch.sh" "$base/releases/$version/switch" "$base/releases/$version/install.sh"
install -m 755 "$here/launch.sh" "$base/launch.sh"
install -m 755 "$here/switch" "$base/switch"
ln -sfn "releases/$version" "$base/current.tmp" && mv -T "$base/current.tmp" "$base/current"

mkdir -p "$(dirname "$env_file")"
if [ ! -f "$env_file" ]; then
  install -m 600 "$here/service-executor.env.example" "$env_file"
  echo "wrote $env_file: set EXECUTOR_DEPLOYER_URL and the token (issued on the Hosts page as this host's service executor token)"
fi
if [ "$(id -u)" = 0 ]; then
  install -m 644 "$here/open-atlas-service-executor.service" /etc/systemd/system/open-atlas-service-executor.service
  systemctl daemon-reload
  systemctl enable open-atlas-service-executor
  echo "installed service executor $version; after editing $env_file: systemctl restart open-atlas-service-executor"
else
  echo "installed service executor $version as $(id -un) (not root: it manages only this user's services); no systemd unit."
  echo "start it with the settings in $env_file, e.g.: set -a; . $env_file; set +a; $base/launch.sh"
fi
echo "check with: python3 $base/current/service_executor.py check --env-file $env_file"
