#!/usr/bin/env bash
# Both MCPs in one loop: the agent asks the PostHog MCP what users' browsers sent, then fixes k6/api.js and
# validates and runs it through the k6 MCP. Graded with score.js against the same PostHog user traffic.
#   agent-eval/both-mcps.sh [flag]     (default meetup-no-debounce; reads out/local.env)
# Needs the stack, the PostHog MCP on :8787 (docker-compose.override.yml), mcp-k6 and claude.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source out/local.env
FLAG=${1:-meetup-no-debounce}
MODEL=${MODEL:-claude-sonnet-5-5}
OUT=out/both-mcps
mkdir -p "$OUT"
export BUNDLE_ENV=BASE_URL,PH_EMAIL,PH_PASSWORD # run_script can't pass env vars (k6/bundle.js)

api() { curl -fsS -H "Authorization: Bearer $POSTHOG_PERSONAL_API_KEY" -H 'Content-Type: application/json' "$@"; }
set_flag() { # key active
  local id
  id=$(api "$BASE_URL/api/projects/1/feature_flags/?search=$1" |
    node -e "console.log(JSON.parse(require('fs').readFileSync(0)).results.find((f) => f.key === process.argv[1]).id)" "$1")
  api -X PATCH "$BASE_URL/api/projects/1/feature_flags/$id/" -d "{\"active\": $2}" > /dev/null
}
trap 'set_flag "$FLAG" false' EXIT

cat > "$OUT/mcp.json" <<EOF
{"mcpServers": {
  "k6": {"command": "mcp-k6"},
  "posthog": {"type": "http", "url": "http://localhost:8787/mcp", "headers": {"Authorization": "Bearer $POSTHOG_PERSONAL_API_KEY"}}
}}
EOF
chmod 600 "$OUT/mcp.json"

# Users: on a laptop, k6 browsers with the drift flag on stand in for real users.
start=$(date +%s)
set_flag "$FLAG" true
for term in checkout billing pricing; do
  RUN_ID="users-$start-$term" TERM="$term" WAIT_FOR_FLAG="$FLAG" k6 run -q k6/journey.js > /dev/null
done
sleep 15 # let the last metrics batch land

git show HEAD:k6/api.js > k6/api.js
minutes() { echo $(( ($(date +%s) - start) / 60 + 1 )); }

claude -p "Our k6 protocol load test, k6/api.js, may no longer match what users' browsers send to PostHog.

1. Use the PostHog MCP to run this HogQL query in project 1. It returns calls per route that real users'
   browsers made in the last $(( $(minutes) + 5 )) minutes:
   SELECT s.attributes['http.request.method'] AS method, s.attributes['url.template'] AS route, sum(m.count) AS calls
   FROM posthog.metrics AS m
   JOIN (SELECT series_fingerprint, any(attributes) AS attributes FROM posthog.metric_series GROUP BY series_fingerprint) AS s
     ON m.series_fingerprint = s.series_fingerprint
   WHERE m.metric_name = 'http.client.request.duration' AND m.service_name = 'posthog-app'
     AND m.timestamp >= now() - toIntervalMinute($(( $(minutes) + 5 )))
   GROUP BY method, route ORDER BY calls DESC
   Ignore routes under /static, /e/, /i/v0, /flags and /decide.
2. Edit k6/api.js so the share of calls per route matches users. Keep it realistic: setup() auth, more
   than one VU, sleep, check, and no hard-coded ids.
3. Bundle it with \`node k6/bundle.js k6/api.js > out/both-mcps/api.bundle.js\`, then use the k6 MCP:
   validate_script on the bundle, then run_script. Fix anything they report.
Done means validate_script is valid and run_script succeeds. Finish with one line per step." \
  --model "$MODEL" --mcp-config "$OUT/mcp.json" --strict-mcp-config --output-format stream-json --verbose \
  --permission-mode acceptEdits --allowedTools 'Read' 'Edit' 'Bash(node k6/bundle.js:*)' 'mcp__posthog__*' 'mcp__k6__*' \
  > "$OUT/transcript.jsonl" || true

node -e '
  const L = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return {} } })
  const tools = L.filter((m) => m.type === "assistant").flatMap((m) => m.message.content.filter((c) => c.type === "tool_use").map((c) => c.name))
  const r = L.find((m) => m.type === "result") || {}
  console.log("tools:", tools.join(" → "))
  console.log(`turns ${r.num_turns}, $${(r.total_cost_usd || 0).toFixed(2)}`)
  console.log(r.result || "")' "$OUT/transcript.jsonl"

echo "== grading: the repaired api.js against PostHog user traffic"
RUN_ID="both-mcps-$start" k6 run -q --out "json=$OUT/protocol.json" k6/api.js > /dev/null || true
env -u POSTHOG_PROJECT_API_KEY node eval/score.js --reference posthog --since "$(minutes)m" --protocol "$OUT/protocol.json" || true
git diff --stat k6/api.js
