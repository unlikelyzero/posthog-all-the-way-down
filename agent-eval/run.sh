#!/usr/bin/env bash
# Agent eval: tasks × conditions × trials → agent-eval/results.jsonl. Run before the talk, not on stage.
#   agent-eval/run.sh [trials]            (reads out/local.env from posthog/seed.sh)
#   TASK=repair-no-debounce CONDITION=with-k6-mcp agent-eval/run.sh 1   # a single pilot trial
# Needs: k6, node, claude, and a running patched PostHog with both meetup flags created in project 1.
set -euo pipefail
cd "$(dirname "$0")/.."
# Local test credentials written by posthog/seed.sh.
# shellcheck disable=SC1091
[ -f out/local.env ] && source out/local.env

TRIALS=${1:-5}
MODEL=${MODEL:-claude-sonnet-5-5} # pinned: claude -p otherwise uses whatever the CLI defaults to
HOST=${BASE_URL:-http://localhost}
OUT=out/agent-eval
RESULTS=agent-eval/results.jsonl
TRAIN_TERMS=(checkout billing onboarding)
HELDOUT_TERMS=(beta pricing search)
ALL_FLAGS=(meetup-no-debounce meetup-n-plus-one)
mkdir -p "$OUT"
echo '{"mcpServers":{}}' > "$OUT/empty-mcp.json"
# k6 MCP only: .mcp.json also loads PostHog's MCP, which would muddy the with/without comparison.
echo '{"mcpServers":{"k6":{"command":"mcp-k6"}}}' > "$OUT/k6-mcp.json"

api() { curl -fsS -H "Authorization: Bearer $POSTHOG_PERSONAL_API_KEY" -H 'Content-Type: application/json' "$@"; }

set_flag() { # key active
  local id
  id=$(api "$HOST/api/projects/1/feature_flags/?search=$1" | node -e "
    const r = JSON.parse(require('fs').readFileSync(0)).results.find((f) => f.key === process.argv[1]);
    if (!r) { console.error('flag not found: ' + process.argv[1]); process.exit(1) }
    console.log(r.id)" "$1")
  api -X PATCH "$HOST/api/projects/1/feature_flags/$id/" -d "{\"active\": $2}" > /dev/null
}

references() { # prefix wait_flag terms...
  local prefix=$1 wait=$2; shift 2
  local files=()
  for term in "$@"; do
    RUN_ID="$prefix-$term" TERM="$term" WAIT_FOR_FLAG="$wait" \
      k6 run -q --out "json=$OUT/$prefix-$term.json" k6/journey.js > /dev/null
    files+=(--ref "$OUT/$prefix-$term.json")
  done
  echo "${files[@]}"
}

# ponytail: regex checks on the script text; a clever agent could fool them. Use an AST check if that happens.
realism() {
  local f=k6/api.js fails=()
  grep -q 'export function setup' "$f" || fails+=(no-setup-auth)
  grep -Eq 'vus:[[:space:]]*([2-9]|[1-9][0-9]+)' "$f" || fails+=(single-vu)
  grep -q 'sleep(' "$f" || fails+=(no-sleep)
  grep -q 'check(' "$f" || fails+=(no-check)
  grep -Eq '/[0-9]{2,}/|[0-9a-f]{8}-[0-9a-f]{4}-' "$f" && fails+=(hard-coded-ids)
  grep -Eq "=[[:space:]]*\[[[:space:]]*['\"]" "$f" || fails+=(no-term-array)
  printf '%s\n' "${fails[@]+"${fails[@]}"}" | node -e "console.log(JSON.stringify(require('fs').readFileSync(0,'utf8').split('\n').filter(Boolean)))"
}

# Ordered tool calls, blocked tool calls (a harness problem, not an agent one), turns and cost from claude's stream-json transcript.
transcript_summary() {
  node -e "
    const lines = require('fs').readFileSync(process.argv[1], 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return {} } });
    const tools = lines.filter((m) => m.type === 'assistant').flatMap((m) => m.message.content.filter((c) => c.type === 'tool_use').map((c) => c.name.replace(/^mcp__k6__/, '')));
    const result = lines.find((m) => m.type === 'result') || {};
    const v = tools.indexOf('validate_script'), r = tools.indexOf('run_script');
    console.log(JSON.stringify({ tools_sequence: tools, validate_before_run: v >= 0 && (r < 0 || v < r), permission_denials: (result.permission_denials || []).length, turns: result.num_turns ?? null, cost_usd: result.total_cost_usd ?? null }))
  " "$1"
}

git show HEAD:k6/api.js > "$OUT/api.baseline.js"

while IFS="|" read -r -u 3 task flags intent; do
  [ -n "${TASK:-}" ] && [ "$task" != "$TASK" ] && continue
  for condition in with-k6-mcp no-mcp; do
    [ -n "${CONDITION:-}" ] && [ "$condition" != "$CONDITION" ] && continue
    mcp="$OUT/k6-mcp.json"; [ "$condition" = no-mcp ] && mcp="$OUT/empty-mcp.json"
    for trial in $(seq 1 "$TRIALS"); do
      tag="$task-$condition-$trial"
      echo "== $tag"
      cp "$OUT/api.baseline.js" k6/api.js
      for f in "${ALL_FLAGS[@]}"; do set_flag "$f" false; done
      IFS=, read -ra on <<< "$flags"
      for f in "${on[@]}"; do set_flag "$f" true; done

      read -ra train <<< "$(references "$tag-train" "${on[0]}" "${TRAIN_TERMS[@]}")"
      RUN_ID="$tag-p0" k6 run -q --out "json=$OUT/$tag-p0.json" k6/api.js > /dev/null || true
      report=$(node eval/score.js "${train[@]}" --protocol "$OUT/$tag-p0.json" 2>&1 || true)

      claude -p "$intent

$report

To re-score your fix against the same browser references: run k6/api.js with
\`k6 run --out json=$OUT/$tag-check.json k6/api.js\`, then
\`node eval/score.js ${train[*]} --protocol $OUT/$tag-check.json\`." \
        --model "$MODEL" --mcp-config "$mcp" --strict-mcp-config --output-format stream-json --verbose \
        --permission-mode acceptEdits --allowedTools 'Read' 'Edit' 'Bash(k6:*)' 'Bash(node:*)' 'mcp__k6__*' \
        > "$OUT/$tag.transcript.jsonl" || true

      read -ra heldout <<< "$(references "$tag-heldout" "${on[0]}" "${HELDOUT_TERMS[@]}")"
      RUN_ID="$tag-p1" k6 run -q --out "json=$OUT/$tag-p1.json" k6/api.js > /dev/null || true
      node eval/score.js "${heldout[@]}" --protocol "$OUT/$tag-p1.json" --scenario "$tag" --json "$OUT/$tag.score.json" || true

      row=$(MODEL="$MODEL" node -e "
        const [task, condition, trial, scoreFile, realism, summary] = process.argv.slice(1);
        let s = {}; try { s = JSON.parse(require('fs').readFileSync(scoreFile)) } catch {}
        const realismFails = JSON.parse(realism);
        console.log(JSON.stringify({ task, condition, trial: +trial, model: process.env.MODEL, pass: !!s.pass && realismFails.length === 0,
          gates: s.gates || null, C: s.C, M: s.M, E: s.E, errors: s.errors, realism_fails: realismFails, ...JSON.parse(summary) }))
      " "$task" "$condition" "$trial" "$OUT/$tag.score.json" "$(realism)" "$(transcript_summary "$OUT/$tag.transcript.jsonl")")
      echo "$row" >> "$RESULTS"
      if [ -n "${POSTHOG_PROJECT_API_KEY:-}" ]; then
        curl -fsS "$HOST/i/v0/e/" -H 'Content-Type: application/json' -d "{\"api_key\":\"$POSTHOG_PROJECT_API_KEY\",\"event\":\"meetup_agent_trial\",\"distinct_id\":\"meetup-eval\",\"properties\":$row}" > /dev/null || true
      fi
    done
  done
done 3< <(awk '
  /- id:/ { id = $3 }
  /flags:/ { flags = $2 }
  /intent:/ { sub(/^[^"]*"/, ""); sub(/"[[:space:]]*$/, ""); print id "|" flags "|" $0 }
' agent-eval/tasks.yaml)

cp "$OUT/api.baseline.js" k6/api.js
for f in "${ALL_FLAGS[@]}"; do set_flag "$f" false; done
node agent-eval/report.js "$RESULTS"
