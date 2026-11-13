#!/bin/sh
# L0 of the first setup (design §15.4 step 0, §15.6 ⑦), run once as root on the host that runs the Deployer, from the
# unpacked setup archive of a release (open-atlas-deployer-setup-<version>.tar.gz):
#   sudo ./bootstrap.sh [--dir /webapp/data/open-atlas/deployer] [--workbench-public-url https://uat.example.internal:8443/]
#                       [--compare-key-file <file>] [--project open-atlas] [--user <name>] [--no-executor]
#                       [--service-executor] [--no-start]
# It installs the executor when the host has none, lays out the Deployer's directory (compose.yaml, .env, deployer.env,
# data/, secrets/) and starts it. The secrets in deployer.env are generated straight into the file and never printed:
# the credential key, the compare key (PROD: pass UAT's with --compare-key-file, they must be equal) and the emergency
# password's hash; the emergency password itself goes to emergency-password beside it, mode 600. Files that exist are
# left as they are, so running it again only fills in what is missing. Then open https://<domain>/deploy/ and sign in
# with the emergency account: the Setup page takes over from there.
# --user names the host user the Deployer's container runs as (DEPLOYER_UID/DEPLOYER_GID in .env) and who owns its
# directory's files, e.g. the login user who looks after it; without it, uid 1000. Run again with --user to move an
# existing install over: it hands data/, secrets/ and the files over to that user and restarts the Deployer.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
version=$(cat "$here/VERSION")
image=ghcr.io/ferenc-z/open-atlas-deployer
dir=/webapp/data/open-atlas/deployer
public_url=
compare_file=
project=open-atlas
user=
executor=yes
service_executor=no
start=yes
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) dir=$2; shift 2 ;;
    --workbench-public-url) public_url=$2; shift 2 ;;
    --compare-key-file) compare_file=$2; shift 2 ;;
    --project) project=$2; shift 2 ;;
    --user) user=$2; shift 2 ;;
    --no-executor) executor=no; shift ;;
    --service-executor) service_executor=yes; shift ;;
    --no-start) start=no; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }
if [ -n "$user" ]; then
  uid=$(id -u "$user" 2>/dev/null) || { echo "no user $user on this host" >&2; exit 1; }
  gid=$(id -g "$user")
  [ "$uid" != 0 ] || { echo "--user must not be root" >&2; exit 1; }
else
  uid=1000 gid=1000
fi

# The executor (§8.6): installed once by hand, later versions come from the Overview.
if [ "$executor" = yes ]; then
  if [ -e /opt/open-atlas-deployer/executor/current ]; then
    echo "executor: already installed ($(readlink /opt/open-atlas-deployer/executor/current))"
  else
    sh "$here/executor/install.sh"
  fi
fi

# The service executor (managed services such as NiFi; no Docker) is only installed where asked: it needs its own token
# from the Hosts page, and a host that runs no NiFi does not need it. Run service-executor/install.sh later if wanted.
if [ "$service_executor" = yes ]; then
  if [ -e /opt/open-atlas-deployer/service-executor/current ]; then
    echo "service executor: already installed ($(readlink /opt/open-atlas-deployer/service-executor/current))"
  else
    sh "$here/service-executor/install.sh"
  fi
fi

docker pull -q "$image:$version" >/dev/null
mkdir -p "$dir/data" "$dir/secrets"
chmod 700 "$dir/secrets"
[ -f "$dir/compose.yaml" ] || { cp "$here/deployer/compose.yaml" "$dir/compose.yaml"; echo "wrote $dir/compose.yaml"; }
[ -f "$dir/.env" ] || { echo "DEPLOYER_IMAGE=$image:$version" > "$dir/.env"; echo "wrote $dir/.env ($image:$version)"; }
if [ -n "$user" ]; then
  # The user it runs as: kept in .env beside the image (the executor's upgrades change only DEPLOYER_IMAGE).
  grep -Ev '^DEPLOYER_(UID|GID)=' "$dir/.env" > "$dir/.env.part" || true
  printf 'DEPLOYER_UID=%s\nDEPLOYER_GID=%s\n' "$uid" "$gid" >> "$dir/.env.part"
  mv "$dir/.env.part" "$dir/.env"
  echo "runs as $user ($uid:$gid), written to $dir/.env"
  # A compose.yaml from before --user has no user: line: add it under the image line (kept as compose.yaml.before-user).
  if ! grep -q 'DEPLOYER_UID' "$dir/compose.yaml"; then
    if grep -q '^    image: "\${DEPLOYER_IMAGE' "$dir/compose.yaml"; then
      cp -p "$dir/compose.yaml" "$dir/compose.yaml.before-user"
      sed -i '/^    image: "\${DEPLOYER_IMAGE/a\    user: "${DEPLOYER_UID:-1000}:${DEPLOYER_GID:-1000}"' "$dir/compose.yaml"
      echo "added user: to $dir/compose.yaml (previous one in compose.yaml.before-user)"
    else
      echo "WARNING: add  user: \"\${DEPLOYER_UID:-1000}:\${DEPLOYER_GID:-1000}\"  under services.deployer in $dir/compose.yaml, or it keeps running as 1000" >&2
    fi
  fi
fi

if [ -f "$dir/deployer.env" ]; then
  echo "deployer.env: exists, left as it is"
else
  umask 077
  password=$(openssl rand -base64 33 | tr -d '/+=\n')
  # The hash is made by the Deployer's own image (no Node on the host); the password goes in on stdin only.
  hash=$(printf '%s' "$password" | docker run --rm -i --entrypoint node "$image:$version" bin/hash-password.ts)
  printf '%s\n' "$password" > "$dir/emergency-password"
  password=
  if [ -n "$compare_file" ]; then compare=$(tr -d '\n' < "$compare_file"); else compare=$(openssl rand -base64 32); fi
  {
    grep -Ev '^#?(DEPLOYER_CREDENTIAL_ENCRYPTION_KEY|DEPLOYER_COMPARE_KEY|DEPLOYER_EMERGENCY_PASSWORD_HASH|DEPLOYER_WORKBENCH_PUBLIC_URL)=' "$here/deployer/deployer.env.example"
    echo ""
    echo "# Generated by bootstrap.sh $version on $(date -u +%Y-%m-%d). Back up the credential key apart from data/."
    echo "DEPLOYER_CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -base64 32)"
    echo "DEPLOYER_COMPARE_KEY=$compare"
    echo "$hash"
    echo "DEPLOYER_WORKBENCH_PUBLIC_URL=${public_url:-/}"
  } > "$dir/deployer.env"
  compare=
  hash=
  chmod 600 "$dir/deployer.env" "$dir/emergency-password"
  echo "wrote $dir/deployer.env (keys generated, not shown)"
  echo "wrote $dir/emergency-password (mode 600): the emergency account's password"
fi
# The Deployer's user owns what it reads and writes. With --user that is the whole directory, so that user can look
# after it (backups/ stays root's: the executor writes it, see EXECUTOR_BACKUPS).
if [ -n "$user" ]; then
  chown -R "$uid:$gid" "$dir/data" "$dir/secrets"
  for f in compose.yaml compose.yaml.before-user .env deployer.env emergency-password; do [ ! -f "$dir/$f" ] || chown "$uid:$gid" "$dir/$f"; done
  for f in deployer.env emergency-password; do [ ! -f "$dir/$f" ] || chmod 600 "$dir/$f"; done
else
  chown 1000:1000 "$dir/data" "$dir/secrets"
fi

# The apps' compose network, which the Deployer joins. Compose itself makes it, for the apps' project with a stand-in
# service that is removed again, so the first app deploy adopts it as its own instead of finding a stranger's network.
network="${project}_default"
if ! docker network inspect "$network" >/dev/null 2>&1; then
  stub=$(mktemp -d)
  printf 'services:\n  network-stub:\n    image: %s\n    command: ["true"]\n' "$image:$version" > "$stub/compose.yaml"
  docker compose -p "$project" -f "$stub/compose.yaml" create >/dev/null 2>&1
  docker compose -p "$project" -f "$stub/compose.yaml" rm -f >/dev/null 2>&1
  rm -rf "$stub"
  echo "created network $network"
fi

if [ "$start" = yes ]; then
  (cd "$dir" && docker compose up -d)
  echo "started the Deployer on 127.0.0.1:8095 as $uid:$gid"
fi
cat <<EOF

Next:
  1. nginx: forward https://<domain>/deploy/ to 127.0.0.1:8095 (the Deployer's Ingress page writes the full configuration later).
  2. Executor: edit /etc/open-atlas-deployer/executor.env (EXECUTOR_ROOT, EXECUTOR_REGISTRIES, EXECUTOR_TOKEN_FILE; on this host
     also EXECUTOR_DEPLOYER_DIR=$dir and EXECUTOR_DEPLOYER_IMAGE=$image). The token comes from the Setup page.
  3. Managed services (NiFi): sudo ./service-executor/install.sh on each host that runs one (or rerun this with
     --service-executor), then set /etc/open-atlas-deployer/service-executor.env; its token comes from the Hosts page.
  4. Open the Deployer, sign in with the emergency account (password in $dir/emergency-password) and follow Setup.
EOF
