#!/usr/bin/env bash
# Records the frame sequences deck A plays (slides/media/, gitignored): the full k6 journey, and the flag
# search box with the debounce in place and removed. Needs the running stack and out/local.env (posthog/seed.sh).
# Leaves meetup-no-debounce off.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source out/local.env

flag() { # key true|false
  local id
  id=$(curl -fsS -H "Authorization: Bearer $POSTHOG_PERSONAL_API_KEY" "$BASE_URL/api/projects/1/feature_flags/?search=$1" |
    node -e "console.log(JSON.parse(require('fs').readFileSync(0)).results.find((f) => f.key === process.argv[1]).id)" "$1")
  curl -fsS -X PATCH -H "Authorization: Bearer $POSTHOG_PERSONAL_API_KEY" -H 'Content-Type: application/json' \
    "$BASE_URL/api/projects/1/feature_flags/$id/" -d "{\"active\": $2}" > /dev/null
}

rec() { # name script [VAR=value ...]
  local dir name=$1 script=$2
  shift 2
  dir=$(pwd)/slides/media/$name
  rm -rf "$dir" && mkdir -p "$dir"
  env FRAMES_DIR="$dir" RUN_ID="rec-$(date +%s)" "$@" k6 run -q "$script" 2>&1 |
    sed -n 's/.*msg="FRAME \([^ ]*\) \([0-9]*\) \([0-9]*\)".*/{"f":"\1","t":\2,"calls":\3}/p' |
    paste -sd, - | sed 's/^/[/; s/$/]/' > "$dir/frames.json"
  echo "$name: $(find "$dir" -name '*.jpg' | wc -l | tr -d ' ') frames"
}

trap 'flag meetup-no-debounce false' EXIT
flag meetup-no-debounce false
rec k6-journey k6/journey.js TERM=checkout
rec search-debounced slides/record-search.js
flag meetup-no-debounce true
rec search-no-debounce slides/record-search.js WAIT_FOR_FLAG=meetup-no-debounce
