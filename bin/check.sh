#!/bin/sh
# Runs what the release workflow checks, locally: types, the server tests, the page build and the executor's tests.
# Output goes to .check/<commit>.log; only a one-line result is printed, plus the failing step's tail on failure.
# .check/last holds "<commit> ok|failed <step>" for the last run.
#   bin/check.sh          (exit 0 when everything passes, 1 otherwise)
# Without a Python on PATH (Windows), the executor's tests run in WSL (CHECK_WSL_DISTRO, default Ubuntu).
set -u
cd "$(dirname "$0")/.."
mkdir -p .check
rev=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
log=".check/$rev.log"
: > "$log"
start=$(date +%s)

python_tests() (
  cd executor || return 1
  if python3 -c 'import sys' >/dev/null 2>&1; then
    PYTHONDONTWRITEBYTECODE=1 python3 -m unittest test_deployer_executor
  else
    # The tests import from their own directory; bytecode stays out of the tracked executor/__pycache__.
    dir=$(pwd -W 2>/dev/null || pwd)
    MSYS_NO_PATHCONV=1 wsl.exe -d "${CHECK_WSL_DISTRO:-Ubuntu}" --cd "$dir" -- env PYTHONDONTWRITEBYTECODE=1 python3 -m unittest test_deployer_executor
  fi
)

run() {
  step=$1; shift
  echo "== $step" >> "$log"
  if ! "$@" >> "$log" 2>&1; then
    echo "$rev failed $step" > .check/last
    echo "check $rev: FAILED at $step ($(( $(date +%s) - start ))s), log $log"
    tail -n 40 "$log"
    exit 1
  fi
}

run typecheck npm run typecheck
run test npm test
run build:web npm run build:web
run executor python_tests
echo "$rev ok" > .check/last
echo "check $rev: ok ($(( $(date +%s) - start ))s)"
