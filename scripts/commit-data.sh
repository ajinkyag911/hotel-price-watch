#!/usr/bin/env bash
# Commit data files and the site data built from them, then push.
#
# Queued workflow runs check out the commit that triggered them, so by the time a run
# pushes, main may already hold another run's readings. The JSONL files merge cleanly
# (each is appended by one workflow only, and .gitattributes unions them anyway); the
# generated site files are never merged, only rebuilt from whatever main now holds.
#
# usage: scripts/commit-data.sh <data-path> <commit-message> [more data paths...]
#   e.g. scripts/commit-data.sh data/history.jsonl "chore: price reading"
#        scripts/commit-data.sh data/finder "chore: deal finder run"
set -euo pipefail

data_paths=("$1")
message=$2
shift 2
data_paths+=("$@")
site_files=(docs/data/history.json docs/data/finder.json)

git config user.name "hotelwatch[bot]"
git config user.email "hotelwatch[bot]@users.noreply.github.com"
# Keep the upstream side of the generated files during rebase; they are rebuilt below.
git config merge.regenerate.driver true

git add -- "${data_paths[@]}"
if git diff --cached --quiet; then
  echo "no new data"
  exit 0
fi
git commit --quiet -m "$message"
for f in "${site_files[@]}"; do
  git checkout -- "$f" 2>/dev/null || true
done

for attempt in 1 2 3 4 5; do
  git pull --rebase --quiet
  hotelwatch build
  for f in "${site_files[@]}"; do
    [ -e "$f" ] && git add "$f"
  done
  git diff --cached --quiet || git commit --quiet --amend --no-edit
  if git push --quiet; then
    echo "pushed on attempt $attempt"
    exit 0
  fi
  sleep $((attempt * 5))
done
echo "::error::could not push after 5 attempts"
exit 1
