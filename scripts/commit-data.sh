#!/usr/bin/env bash
# Commit one append-only data file and the site data built from it, then push.
#
# Queued workflow runs check out the commit that triggered them, so by the time a run
# pushes, main may already hold another run's readings. The JSONL files merge cleanly
# (each is appended by one workflow only, and .gitattributes unions them anyway); the
# generated site file is never merged, only rebuilt from whatever main now holds.
#
# usage: scripts/commit-data.sh <data-file> <commit-message>
set -euo pipefail

data_file=$1
message=$2
site_file=docs/data/history.json

git config user.name "hotelwatch[bot]"
git config user.email "hotelwatch[bot]@users.noreply.github.com"
# Keep the upstream side of the generated file during rebase; it is rebuilt below.
git config merge.regenerate.driver true

git add "$data_file"
if git diff --cached --quiet; then
  echo "no new data"
  exit 0
fi
git commit --quiet -m "$message"
git checkout -- "$site_file" 2>/dev/null || true

for attempt in 1 2 3 4 5; do
  git pull --rebase --quiet
  hotelwatch build
  git add "$site_file"
  git diff --cached --quiet || git commit --quiet --amend --no-edit
  if git push --quiet; then
    echo "pushed on attempt $attempt"
    exit 0
  fi
  sleep $((attempt * 5))
done
echo "::error::could not push after 5 attempts"
exit 1
