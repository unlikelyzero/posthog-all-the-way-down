# posthog-all-the-way-down: design (handoff)

> Using PostHog to Test PostHog with Grafana k6 and PostHog and the Grafana k6 MCP,
> presented at the Grafana Meetup at PostHog. Talk outline: [TALK.md](TALK.md).

**Thesis:** A protocol load test is a cached model of browser behavior. Keep comparing it
with observed browser traffic, or a green test may be generating yesterday's load.

**Status:** code written, not yet run against a live PostHog. Pinned to PostHog
`54c04a0f494dc0821b87e95c19dcade17a633591` (node image `6bcb56fb6e5ff2200852f2080339050d32b98d20`,
the last `nodejs/` change at or before it). §9 items 1, 6 and 7 are verified; the rest need the
running stack. Every unverified assumption is listed in [§9 Verification checklist](#9-verification-checklist-do-first).
Do that section first; it decides whether the rest works as written.

---

## 1. Architecture

```
                 ┌──────────── self-hosted PostHog (system under test) ────────────┐
                 │  patched frontend: 2 behaviors behind PostHog feature flags     │
                 │  SELF_CAPTURE=true → the UI records itself into project 1       │
                 └──────▲───────────────────────────┬──────────────────────────────┘
                        │ UI clicks                 │ posthog-js network metrics
   k6/journey.js ───────┘                           ▼
   (k6 browser)                          posthog.metrics  (CROSS-CHECK only)
        │ page.on('request')                        │
        ▼                                           │
   browser.json ──► REFERENCE  ─────┐               │
                                    ▼               ▼
   k6/api.js ──► protocol.json ──► eval/score.js ──► report + exit code
   (k6 protocol, the test that        │                └──► eval results sent back to PostHog as events
    goes stale)                       ▼
                     Claude Code + k6 MCP repairs api.js   (agent-eval/ measures how well)
```

**Roles, deliberately separated:**

| Role | Source | Why |
|---|---|---|
| Ground truth (gates the build) | k6 browser `page.on('request')` | Immediate, deterministic, sees request bodies. No ingestion lag and no alpha product on the stage-critical path. |
| Cross-check ("PostHog saw it too") | PostHog `posthog.metrics` (posthog-js network metrics) | Shown next to the score. Never gates the result: if ingestion is late, the demo still works. |
| Drift switch | PostHog feature flags (in the project PostHog uses for its own flags) | Flip live in the PostHog UI, with no rebuild. |
| Results store | PostHog events (`meetup_eval_result`) | Eval history on a PostHog dashboard, completing the recursion joke. |
| Repair | Claude Code + Grafana k6 MCP | `get_documentation` → edit → `validate_script` → `run_script`. |

## 2. Repository layout

The smallest file set that works. Don't add files beyond this without a reason.

```
posthog-all-the-way-down/
├── README.md                 # not-affiliated line, quickstart, license note for the patch
├── LICENSE                   # MIT
├── NOTICE                    # "posthog/frontend.patch contains code from PostHog, Inc. (MIT)"
├── .mcp.json                 # k6 MCP (+ optional PostHog MCP)
├── posthog/
│   ├── Dockerfile            # overlay image on a pinned posthog/posthog:<sha>
│   ├── frontend.patch        # 2 flagged behaviors + run-id metric attribute
│   └── docker-compose.override.yml
├── k6/
│   ├── route.js              # shared route-key rule (imported by k6 AND node)
│   ├── journey.js            # k6 browser: reference traffic
│   └── api.js                # k6 protocol: the test that goes stale
├── eval/
│   └── score.js              # node, zero deps; has --selftest
└── agent-eval/
    ├── tasks.yaml            # PostHog-MCP-evals style task set
    └── run.sh                # trials × conditions → results.jsonl
```

Never commit or publish the built image: it contains PostHog's `ee/` code, whose license
forbids redistribution. Ship the patch and the Dockerfile only.

## 3. PostHog setup (`posthog/`)

### 3.1 Pin a version
Pick one `posthog/posthog:<sha>` from **after 2026-09-14**. That's when network metrics
landed, in posthog-js #4918 and the posthog app change that enabled them. Use the same SHA for the
source checkout that `frontend.patch` is built against. Pin `posthog-node` to a matching tag too.

### 3.2 `Dockerfile` (overlay)
```dockerfile
ARG POSTHOG_SHA
FROM posthog/posthog:${POSTHOG_SHA}
COPY --chown=posthog:posthog dist/ /code/frontend/dist/
# Static assets are served from /code/staticfiles (WhiteNoise manifest storage,
# posthog/settings/web.py:449-473). Replacing dist alone would still serve the old JS.
RUN python manage.py collectstatic --noinput
```
Build `dist/` locally from the patched checkout at the same SHA (PostHog's frontend build).
**Check:** the served JS contains the marker string `MEETUP_PATCH_V1`.

### 3.3 `docker-compose.override.yml`
Apply this on top of PostHog's `docker-compose.hobby.yml`, the Docker Compose file its self-hosted install uses.
```yaml
services:
  web:
    image: posthog-meetup:local
    environment:
      SELF_CAPTURE: 'true'          # posthog/settings/base_variables.py:51 (env-overridable)
      POSTHOG_SELF_TEAM_ID: '1'     # posthog/utils.py:546-556 → UI captures + evaluates flags against team 1
  worker:
    image: posthog-meetup:local
  # The self-hosted compose file does NOT run the service that moves metrics from Kafka
  # topic `metrics_ingestion` (written by capture-logs) to `clickhouse_metrics` (read by
  # ClickHouse). Without it, posthog.metrics stays empty. Code:
  # nodejs/src/servers/ingestion-metrics-server.ts
  ingestion-metrics:
    extends: { file: docker-compose.base.yml, service: ingestion-logs }
    image: ${REGISTRY_URL}-node:${POSTHOG_NODE_TAG}
    environment:
      PLUGIN_SERVER_MODE: 'ingestion-metrics'   # verified, §9 #1
    depends_on: [db, redis7, kafka]
```
Only the cross-check needs the metrics pipeline. If it can't be made to work, drop the
cross-check slide; the demo still stands.

### 3.4 `frontend.patch`
All changes are in MIT-licensed paths (`frontend/src/…`, not `ee/`).

| Change | File | Behavior |
|---|---|---|
| Flag `meetup-no-debounce` | `frontend/src/scenes/feature-flags/featureFlagsLogic.ts` (~L731-736) | When the flag is on, skip `await breakpoint(300)`. Every keystroke calls `loadFeatureFlags()`. |
| Flag `meetup-n-plus-one` | same file, `loadFeatureFlagsSuccess` | When the flag is on, `GET` each result's activity endpoint (`…/feature_flags/:id/activity/`), one request per row. The baseline never calls this route, so coverage fails; the detail route would only shift the mix. |
| Run-id attribute | `frontend/src/loadPostHogJS.tsx` (`metrics:` option, ~L63) | Add `meetup.run_id` from `localStorage.meetup_run_id` to each network metric, via the network-metrics `attributes` hook (posthog-js `network-metrics.ts:112`): `metrics.network = { attributes: (request, response) => ({…}) }`, verified §9 #6. |
| Marker | any loaded module | `console.debug('MEETUP_PATCH_V1')` |

Read flags with literal keys through the existing feature-flag logic. They don't need to be
registered in `FEATURE_FLAGS` unless you use the constant. Create both flags in **project 1**
(the self team) in the PostHog UI, both off by default.

## 4. Traffic capture (`k6/`)

### 4.1 `route.js`: the route key (shared)
One rule, imported by `journey.js`, `api.js` checks, and `score.js`, so it can't drift.
```
routeKey(method, url, body?) =
  METHOD + ' ' + template(pathname)
  + (pathname ends with '/query/' && body.query.kind ? '#' + body.query.kind : '')

template: replace path segments that are all digits, or ≥8 chars of [0-9a-f-] containing
a digit, with ':id'. This is copied from posthog-js network-metrics.ts:18-26 so the route
keys match PostHog's url.template exactly. Also map the project segment
(/api/projects/<n>/, /api/environments/<n>/) to :id (it is all digits, so already covered).
Drop query strings (same as PostHog).
```
The `#kind` suffix fills PostHog's blind spot: the network metrics can't see the body of
`POST /query/`, and most of the UI's traffic goes there. The PostHog cross-check therefore
compares on the key *without* `#kind`.

### 4.2 `journey.js`: k6 browser, the reference
- **Auth:** log in once in `setup()`, or load a pre-validated storage state. Never sign up or log in on stage.
- **Before navigating:** set `localStorage.meetup_run_id = __ENV.RUN_ID` (init script).
- **Journey (keep under 30 s):** open Feature flags → type `checkout` into `[data-attr="feature-flag-search"]`
  at a fixed per-key delay → open one flag → open a dashboard.
- **Capture:** `page.on('request')`. For each fetch/XHR to the app origin, excluding `/i/v1/*`, `/flags`
  and static assets, add 1 to a Counter `api_calls` tagged `{route: routeKey(...)}`.
- **Teardown:** `await page.evaluate(() => window.posthog?.metrics?.flush())` before closing.
  Without it, metrics recorded since the last 10-second batch are lost when the page closes
  (posthog-metrics.ts:87-99).
- **Output:** `k6 run --out json=out/browser-$RUN_ID.json journey.js`
- **Repetitions:** the reference is **3 runs** (`R=3`) with different search terms, not one.

### 4.3 `api.js`: the protocol test (the thing that goes stale)
- Hand-written to match the baseline journey. It must look like a *real* load test,
  because the agent-eval realism gates enforce this:
  - auth in `setup()`
  - `scenarios` with >1 VU
  - `sleep()` think time
  - `check()` on status
  - search terms parameterized from a small array, not hard-coded
- Tag every request `{ route: routeKey(...) }`.
- **Output:** `k6 run --out json=out/protocol-$RUN_ID.json api.js`

## 5. Scoring (`eval/score.js`)

Node, zero dependencies. Input: the browser JSON files (the reference), one protocol JSON
file, and an optional run id for the PostHog cross-check. Output: a terminal report, optional
JSON, and exit code 0 or 1.

### 5.1 Definitions
- `w_r`: the reference distribution. Share of calls to route *r*, pooled across the R browser runs.
- `q_r`: the protocol distribution. Share of `http_reqs` to route *r*.

| Gate | Formula | Default threshold | Catches |
|---|---|---|---|
| Coverage **C** | `Σ_r w_r · [q_r > 0]` | ≥ 0.95, **and** every route in `CRITICAL_ROUTES` covered | New routes (N+1) |
| Mix **M** | `1 − ½ Σ_r \|w_r − q_r\|` | ≥ calibrated (start 0.85) | Volume shifts (no-debounce) |
| Stale **E** | share of protocol calls whose route is absent from the reference or returns 404/410 | ≤ 0.02 | Removed or renamed routes |
| Errors | protocol non-2xx/3xx rate | ≤ 0.01 | Broken test |

Each gate passes or fails **independently**. A combined score may be displayed but never
gates the result, because good mix must not hide 404s.

### 5.2 Calibrating the thresholds (so they aren't arbitrary)
Run the unchanged baseline 5 times: 5 browser references against 5 protocol runs. Set
each threshold just beyond the worst baseline value seen, with a small margin. Then confirm that
each seeded drift fails its intended gate:
- `no-debounce` must fail M and pass C.
- `n-plus-one` must fail C.

Record the calibration numbers in the README. On stage, say "calibrated from 5 baseline runs."

### 5.3 PostHog cross-check (display only)
```sql
SELECT attributes['http.request.method'] AS method,
       attributes['url.template']        AS route,
       sum(count)                        AS calls   -- histogram rows are pre-aggregated windows
FROM posthog.metrics                               -- note the posthog. namespace
WHERE metric_name = 'http.client.request.duration'
  AND service_name = 'posthog-app'
  AND attributes['meetup.run_id'] = {run_id}        -- per-run filter, not a time window
GROUP BY method, route
```
Run it through `POST /api/projects/1/query/` (`{"query":{"kind":"HogQLQuery","query":…}}`)
with a personal API key that has `query:read`. Poll with a **hard 20-second deadline**. Compare with
the browser reference on the key without `#kind` and print an agreement ratio. If the deadline
passes, print "PostHog cross-check pending" and carry on.

Fallback if the run-id attribute can't be added: filter by a tight time window around the
run, taken from the journey's start and end timestamps. Batches are timestamped when
they're sent, so pad the window by 15 s.

### 5.4 Send results to PostHog
After scoring, `POST /i/v0/e/` with the project API key:
- event `meetup_eval_result`
- properties: `{run_id, scenario, C, M, E, errors, pass, crosscheck_agreement}`

A PostHog dashboard over these events is the closing "PostHogs all the way down" slide.

### 5.5 `--selftest`
Built-in asserts on synthetic distributions:
- identical distributions give M = 1
- disjoint distributions give M = 0
- a new route drops C
- a 404 counts toward E
- the route template matches the posthog-js examples

## 6. Agent eval (`agent-eval/`)

This follows PostHog's own MCP evals (`services/mcp/evals/README.md` in the PostHog repo):
a task set with `intent`, `expected_tools` and `success_criteria`. It also borrows their
two-mode idea: deterministic checks first, then the agent run.

### 6.1 `tasks.yaml`
```yaml
version: 1
tasks:
  - id: repair-no-debounce
    flags: { meetup-no-debounce: true }
    intent: "The load test in k6/api.js no longer matches real browser traffic. Here is the drift report. Fix api.js."
    expected_tools: [get_documentation, validate_script, run_script]
    success_criteria: all score.js gates pass on a HELD-OUT reference + realism gates
  - id: repair-n-plus-one
    flags: { meetup-n-plus-one: true }
    …
  - id: repair-both
    flags: { meetup-no-debounce: true, meetup-n-plus-one: true }
    …
```

### 6.2 Protocol
- **Conditions:** `with-k6-mcp` vs `no-mcp` (the same agent with shell k6 only). This
  answers "is the MCP bolted on?" with data.
- **Trials:** 5 per task per condition, so 30 runs. Run them **before** the talk.
- **Agent input:** the drift report from training references (R=3).
- **Grading:** against a **held-out** reference: 3 fresh browser runs with different search
  terms, which the agent never saw. This prevents it from overfitting to the trace.
- **Realism gates:** these stop an agent from simply replaying the route list. Checked statically plus by a `k6 run`:
  - has `setup()` auth
  - `scenarios` with >1 VU
  - has `sleep(`
  - has `check(`
  - no hard-coded IDs copied from the reference
  - search terms come from an array
  - ponytail: these are regex checks on the script text; a clever agent could fool them. Use an AST check if that happens.
- **Tool sequence:** from `claude -p --output-format stream-json`, record the order of
  MCP tool calls. "Correct" means `validate_script` ran before `run_script` and before finishing.

### 6.3 `run.sh`
For each (task, condition, trial):
1. Reset `api.js` to baseline.
2. Set the flags through the PostHog API.
3. Collect training references.
4. Run `claude -p` with `--mcp-config` (the real config or an empty one).
5. Collect held-out references.
6. Run `score.js`.
7. Append a line to `results.jsonl`:
   `{task, condition, trial, pass, gates, tools_sequence, turns, cost_usd}`.

Also send each row to PostHog as a `meetup_agent_trial` event.

Braintrust (a third-party eval platform, the one PostHog's MCP evals use) is **optional**. The JSONL maps one-to-one onto a
Braintrust experiment if you want the same UI PostHog uses. It isn't required for the talk.

### 6.4 Reporting (honest statistics)
- Report **successes/trials** (e.g. 4/5) with a Wilson 95% interval, and call it a **pilot**.
- pass@1 is the headline number. Only use "pass@k" in its real sense: the probability that
  at least one of k attempts succeeds.
- Headline comparison: with MCP vs without MCP, on pass rate and on how often
  `validate_script` caught an invalid k6 API before the run.

## 7. `.mcp.json`
```json
{
  "mcpServers": {
    "k6": { "command": "mcp-k6" }
  }
}
```
Optional second server: the PostHog MCP (repo `services/mcp`, run locally with
`POSTHOG_API_BASE_URL=https://<your-host>`). It lets the agent query `posthog.metrics` itself.
Whether it works against a self-hosted instance is unverified, so it's a stretch goal.

## 8. Demo runbook

**Hardware:** a dedicated, pre-warmed machine if possible. If using the 24 GB laptop, give
Docker 16 GB, close everything else, and rehearse under that limit while watching swap.

**T-1 day:** record a video of every stage step, finish all agent-eval trials, calibrate the thresholds.

**T-30 min:**
- start the stack
- open the PostHog UI (logged in) and a terminal
- run the baseline journey once to warm caches
- run `score.js --selftest`

**On stage (7 min):**
1. Show the baseline report (all gates green) and the PostHog cross-check agreement.
2. In the PostHog UI, turn on `meetup-no-debounce`. The journey hard-reloads and polls
   `posthog.getFeatureFlag('meetup-no-debounce')` until it's true, then runs. Then run
   `api.js` and `score.js`. **Expect C pass, M fail.** Timeout: 60 s, then play the video.
3. `n-plus-one`: shown as a recording or screenshot. C fails, and the report names the new route.
4. Agent repair: recorded, sped up 4×. Finish with **live** `validate_script` + `run_script` + `score.js` on
   the repaired `api.js`. These are deterministic, so they're safe to run live.
5. Agent-eval table from `results.jsonl`: with MCP vs without, Wilson intervals.

**Needs network on stage:** nothing on the critical path. The agent step is recorded.

## 9. Verification checklist (do first)

Each item says how to confirm it and what to do if it fails.

| # | Assumption | How to verify | If false | Result |
|---|---|---|---|---|
| 1 | `PLUGIN_SERVER_MODE` value for the metrics ingestion server | Read `nodejs/src/servers/ingestion-metrics-server.ts` and the mode switch in `nodejs/src` at the pinned SHA | Use the correct value. If there's no such mode in the image, drop the cross-check. | **Verified:** `ingestion-metrics` (`nodejs/src/common/config.ts`, `PluginServerMode.ingestion_metrics`). It also reads `METRICS_REDIS_HOST`. |
| 2 | Metrics reach `posthog.metrics` on self-hosted | Send one sentinel metric; query it within 20 s | Drop the cross-check. The demo still works. |
| 3 | `collectstatic` overlay serves the patched JS | `curl` the page and its JS for `MEETUP_PATCH_V1` | Build the full image from the patched source instead (slow but reliable). |
| 4 | Self-capture works outside dev mode | Events and `$feature_flag_called` appear in project 1 | Point `JS_POSTHOG_*` at PostHog Cloud (as a recorder only, not a test target). Note: Cloud's terms bar publishing performance results of Cloud itself. |
| 5 | Flag flip reaches the page | Hard reload, then `posthog.getFeatureFlag(key)` returns true within 10 s | Increase the poll; worst case, restart `web` (pre-recorded fallback). |
| 6 | posthog-js network-metrics `attributes` config shape | Read posthog-js types for `metrics.network` at the pinned version | Use the time-window fallback in §5.3. | **Verified:** `metrics.network` takes `{ name?, attributes?(request, response) }`; `attributes` is merged over the defaults (`packages/types/src/posthog-config.ts` `NetworkMetricsConfig`). |
| 7 | k6 v2 browser `page.on('request')` and `request.postData()` | A tiny k6 script against any page | Use `page.route` or HAR; worst case, capture with Chrome DevTools Protocol. | **Verified** on k6 v2.3.0: both work. `resourceType()` returns `Fetch` / `XHR` (capitalized). |
| 8 | Headless k6 browser isn't filtered as a bot | Network metrics appear for the k6 run (the user-agent opt-out only applies on `localhost`, loadPostHogJS.tsx:46) | Serve on `localhost`, or override the user agent in the k6 browser context. |
| 9 | Local HTTPS and auth | k6 logs in with the stored state against `https://<DOMAIN>` | Trust Caddy's local CA and use one hostname everywhere. |
| 10 | Memory | Rehearse the full demo while watching swap | Disable non-essential services (Temporal UI, Elasticsearch if unused), or use a remote machine. |

## 10. Explicitly out of scope

- Payload fidelity beyond `#kind`, and latency/SLO fidelity. Mention them as limits on stage.
- Replay-to-test generation, PostHog self-driving, and LLM-judge graders.
- Production RUM mixes. The reference is a *journey contract*, not a model of the user population. Say so.
