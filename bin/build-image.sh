#!/bin/sh
# Builds the Deployer's image <registry>/open-atlas-deployer:<package.json version> (design §8.6), and the executor's
# release of the same commit into dist/executor (executor/package.sh). Pushing the image and attaching the executor's
# release are left to whoever holds the registry login and the GitHub permission.
#   bin/build-image.sh [registry]   (default ghcr.io/ferenc-z; DEPLOYER_BASE_PATH changes the page's path)
set -eu
cd "$(dirname "$0")/.."
registry=${1:-ghcr.io/ferenc-z}
version=$(node -p 'require("./package.json").version')
revision=$(git rev-parse HEAD 2>/dev/null || echo unknown)
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  echo "warning: the working tree has uncommitted changes; the image will not match $revision" >&2
fi
image="$registry/open-atlas-deployer:$version"
docker build --build-arg VERSION="$version" --build-arg REVISION="$revision" \
  --build-arg DEPLOYER_BASE_PATH="${DEPLOYER_BASE_PATH:-/deploy}" -t "$image" .
sh executor/package.sh dist/executor
echo "built $image"
echo "push with: docker push $image"
