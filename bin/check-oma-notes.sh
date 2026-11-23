#!/bin/sh
# D47 (owner 2026-11-16): the Deployer does not publish its own agents. A version whose changes reach the Deploy
# Assistant or the Onboarding Assessor (prompts agents/*.md, Skills agents/skills/<name>/SKILL.md, package and allowed tools
# templates/<agent>.oma.json) must say so in its CHANGELOG section with a checklist line "- [ ] OMA: ...", so whoever
# upgrades an environment knows to republish them on that environment's OMA (bin/publish-assistant.ts).
#
# A file moved without a change of text (an exact rename) is not a change to the agent.
# Usage: sh bin/check-oma-notes.sh <version> [<previous tag>]   (default: the newest v* tag before HEAD)
set -eu
version=$1
prev=${2:-$(git describe --tags --abbrev=0 --match 'v*' HEAD^ 2>/dev/null || true)}
[ -n "$prev" ] || { echo "check-oma-notes: no earlier tag, skipped"; exit 0; }
changed=$(git diff --name-only -M100% --diff-filter=ACMTD "$prev" HEAD -- agents templates/deploy-assistant.oma.json templates/onboarding-assessor.oma.json)
[ -n "$changed" ] || { echo "check-oma-notes: no agent changes since $prev"; exit 0; }
notes=$(awk -v v="## $version" '$0 == v || index($0, v " ") == 1 { on = 1; next } on && /^## / { exit } on' CHANGELOG.md)
if printf '%s\n' "$notes" | grep -q '^- \[ \] OMA:'; then echo "check-oma-notes: ok"; exit 0; fi
echo "::error::agent definitions changed since $prev but CHANGELOG.md ## $version has no '- [ ] OMA:' line:"
printf '%s\n' "$changed" | sed 's/^/  /'
exit 1
