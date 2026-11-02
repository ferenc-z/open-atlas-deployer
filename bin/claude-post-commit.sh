#!/bin/sh
# Claude Code hook (PostToolUse on Bash, async with rewake; .claude/settings.json): after a `git commit`, runs
# bin/check.sh in the background. Silent when it passes; on failure exits 2 with the summary, which wakes the session.
cd "$(dirname "$0")/.."
command=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).tool_input.command||"")}catch{}})')
case "$command" in
  *"git commit"*|*"git -C "*" commit"*) ;;
  *) exit 0 ;;
esac
out=$(sh bin/check.sh 2>&1) && exit 0
echo "$out" >&2
exit 2
