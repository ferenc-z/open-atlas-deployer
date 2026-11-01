#!/bin/sh
# First installation of the executor on a host (design §8.6, D29), run once by hand as root from an unpacked
# release: sudo ./install.sh. Later versions are installed from the Deployer's Hosts page (executor-upgrade, with
# EXECUTOR_UPGRADE_FROM set in executor.env); rerun this only when the release notes say launch.sh or the systemd
# unit changed.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
version=$(sed -n 's/^VERSION = "\(.*\)"/\1/p' "$here/deployer_executor.py")
base=/opt/open-atlas-deployer/executor
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))' || { echo "python3 >= 3.9 is required" >&2; exit 1; }

mkdir -p "$base/releases/$version"
for f in deployer_executor.py launch.sh switch install.sh open-atlas-deployer-executor.service executor.env.example; do
  [ -f "$here/$f" ] && cp "$here/$f" "$base/releases/$version/"
done
install -m 755 "$here/launch.sh" "$base/launch.sh"
install -m 755 "$here/switch" "$base/switch"
ln -sfn "releases/$version" "$base/current.tmp" && mv -T "$base/current.tmp" "$base/current"

mkdir -p /etc/open-atlas-deployer
if [ ! -f /etc/open-atlas-deployer/executor.env ]; then
  install -m 600 "$here/executor.env.example" /etc/open-atlas-deployer/executor.env
  echo "wrote /etc/open-atlas-deployer/executor.env: set EXECUTOR_ROOT, EXECUTOR_REGISTRIES and the token, then start again"
fi
install -m 644 "$here/open-atlas-deployer-executor.service" /etc/systemd/system/open-atlas-deployer-executor.service
systemctl daemon-reload
systemctl enable open-atlas-deployer-executor
echo "installed executor $version; after editing executor.env: systemctl restart open-atlas-deployer-executor"
echo "check with: python3 $base/current/deployer_executor.py check"
