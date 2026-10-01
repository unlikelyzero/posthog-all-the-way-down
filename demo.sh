#!/usr/bin/env bash
# Stage runner (DESIGN.md §8). Runs the live path; if it fails or passes TIMEOUT seconds,
# scores the offline fixtures instead (eval/fixtures.js).
#   ./demo.sh baseline | no-debounce | n-plus-one | repaired   (repaired: DRIFT=n-plus-one|no-debounce)
#   ./demo.sh offline <baseline|no-debounce|n-plus-one|repaired>
#   ./demo.sh check                                           # offline fixtures, asserts the stage pattern
#   ./demo.sh prepare                                         # T-30 min: record the stale protocol run once
#   ./demo.sh users [15m]                                     # score it against what PostHog saw users send
set -u
cd "$(dirname "$0")"
# shellcheck disable=SC1091
[ -f out/local.env ] && source out/local.env
TIMEOUT=${TIMEOUT:-60}
DRIFT=${DRIFT:-n-plus-one}
# The stale api.js doesn't change on stage, so its run is recorded once beforehand (prepare) and only the
# browser journey runs live; a live journey plus a live api.js run doesn't fit in TIMEOUT.
export PROTOCOL=out/protocol-stage.json

live() { # $1 = scenario the UI is in (flag to wait for, or baseline)
  local id="demo-$(date +%s)" wait=""
  [ "$1" != baseline ] && wait="meetup-$1"
  mkdir -p out
  RUN_ID=$id WAIT_FOR_FLAG=$wait k6 run -q --out json=out/browser-$id.json k6/journey.js || return 3
  local proto=$PROTOCOL
  if [ "$2" = repaired ] || [ ! -s "$proto" ]; then # the repaired api.js is new, so it runs live
    proto=out/protocol-$id.json
    RUN_ID=$id k6 run -q --out json="$proto" k6/api.js || return 3
  fi
  [ -s out/browser-$id.json ] || return 3
  node eval/score.js --ref out/browser-$id.json --protocol "$proto" --run-id "$id" --scenario "$2"
}

offline() { # $1 = scenario of the reference runs, $2 = protocol fixture
  echo "=== (offline fallback) $1 ==="
  node eval/fixtures.js
  local f=out/fixtures
  node eval/score.js --ref $f/browser-$1-1.json --ref $f/browser-$1-2.json --ref $f/browser-$1-3.json \
    --protocol $f/protocol-$2.json --scenario "$1"
}

stage() { # $1 = ui scenario, $2 = protocol fixture for the fallback, $3 = scenario label
  export -f live
  # macOS has no `timeout`: run the live path in its own process group, kill the group at the deadline (exit 124).
  perl -e '$t = shift; $p = fork; if (!$p) { setpgrp; exec @ARGV }
    $SIG{ALRM} = sub { kill "TERM", -$p; exit 124 }; alarm $t; waitpid $p, 0; exit($? >> 8)' \
    "$TIMEOUT" bash -c 'live "$@"' _ "$1" "$3"
  local rc=$?
  [ $rc -le 1 ] && exit $rc # 0 pass, 1 gates failed: both are real results
  [ $rc = 124 ] && echo "live path timed out after ${TIMEOUT}s" || echo "live path failed (exit $rc)"
  offline "$1" "$2"
}

case "${1:-}" in
  baseline | no-debounce | n-plus-one) stage "$1" baseline "$1" ;;
  repaired) stage "$DRIFT" "$DRIFT" repaired ;;
  offline)
    case "${2:-}" in
      repaired) offline "$DRIFT" "$DRIFT" ;;
      baseline | no-debounce | n-plus-one) offline "$2" baseline ;;
      *) echo "usage: $0 offline <baseline|no-debounce|n-plus-one|repaired>" >&2; exit 2 ;;
    esac ;;
  check) node eval/fixtures.js --check ;;
  users)
    [ -s "$PROTOCOL" ] || { echo "no $PROTOCOL: run ./demo.sh prepare first" >&2; exit 2; }
    node eval/score.js --reference posthog --since "${2:-15m}" --protocol "$PROTOCOL" --scenario users ;;
  prepare) mkdir -p out && RUN_ID="stage-$(date +%s)" k6 run -q --out json="$PROTOCOL" k6/api.js && echo "saved $PROTOCOL" ;;
  *) echo "usage: $0 <baseline|no-debounce|n-plus-one|repaired|offline <scenario>|users [window]|check|prepare>" >&2; exit 2 ;;
esac
