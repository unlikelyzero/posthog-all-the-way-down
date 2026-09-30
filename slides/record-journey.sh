#!/usr/bin/env bash
# Records the k6 browser journey as JPEG frames for deck A's "k6 driving PostHog" slide.
# Needs the running stack and out/local.env (posthog/seed.sh). Output: slides/media/k6-journey/.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source out/local.env
dir=$(pwd)/slides/media/k6-journey
rm -rf "$dir" && mkdir -p "$dir"
FRAMES_DIR=$dir RUN_ID=rec-$(date +%s) TERM=checkout K6_BROWSER_HEADLESS=${HEADLESS:-true} k6 run -q k6/journey.js 2>&1 |
  sed -n 's/.*msg="FRAME \([^ ]*\) \([0-9]*\) \([0-9]*\)".*/{"f":"\1","t":\2,"calls":\3}/p' |
  paste -sd, - | sed 's/^/[/; s/$/]/' > "$dir/frames.json"
echo "$(find "$dir" -name '*.jpg' | wc -l | tr -d ' ') frames in $dir"
