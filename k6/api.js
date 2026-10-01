// k6 protocol test: hand-written to match the baseline journey (feature flags list → search → open a flag →
// dashboards → open a dashboard), per-run call counts taken from the first real k6 browser capture.
// This is the file that goes stale, and the file the agent repairs.
//   RUN_ID=p1 k6 run --out json=out/protocol-p1.json k6/api.js
import http from 'k6/http'
import { check, sleep } from 'k6'
import { BASE, login } from './auth.js'
import { routeKey } from './route.js'

export const options = {
  scenarios: {
    flags_journey: { executor: 'per-vu-iterations', vus: 3, iterations: 4 },
  },
}

const SEARCH_TERMS = ['checkout', 'billing', 'onboarding', 'beta']
const LIB_HOST_QUERY = `SELECT DISTINCT properties.$lib_custom_api_host AS lib_custom_api_host FROM events
WHERE timestamp >= now() - INTERVAL 1 DAY AND timestamp <= now()
AND properties.$lib_custom_api_host IS NOT NULL AND event IN ('$pageview', '$screen') LIMIT 10`

export function setup() {
  const auth = login()
  return { headers: { Cookie: `sessionid=${auth.sessionid}; posthog_csrftoken=${auth.csrf}`, 'X-CSRFToken': auth.csrf } }
}

function req(method, path, headers, body) {
  const url = `${BASE}${path}`
  const payload = body === undefined ? null : JSON.stringify(body)
  const res = http.request(method, url, payload, {
    headers: { ...headers, 'Content-Type': 'application/json', Referer: `${BASE}/` },
    tags: { route: routeKey(method, url, payload) },
  })
  check(res, { 'status is 2xx': (r) => r.status >= 200 && r.status < 300 })
  return res
}
const get = (path, headers) => req('GET', path, headers)

// Every scene logs a view and lists the file system.
function sceneLoad(p, headers, scene) {
  req('POST', `${p}/file_system/log_view/`, headers, { type: 'scene', ref: scene })
  get(`${p}/file_system?parent=&depth=1`, headers)
}

// Every full page load fetches the app shell.
function appShell(p, headers) {
  get('/api/billing/', headers)
  get(`${p}/file_system_shortcut/`, headers)
  get(`${p}/file_system/log_view?type=scene`, headers)
  get(`${p}/conversations/`, headers)
  get(`${p}/health_issues/summary/`, headers)
  get(`${p}/event_ingestion_restrictions/`, headers)
  get(`${p}/event_definitions/?limit=100`, headers)
  get(`${p}/cohorts?limit=100`, headers)
  get(`${p}/dashboards/?limit=100`, headers)
  get(`${p}/dashboard_templates/json_schema/`, headers)
}

const hogql = (p, headers) => req('POST', `${p}/query/HogQLQuery/`, headers, { query: { kind: 'HogQLQuery', query: LIB_HOST_QUERY } })

export default function ({ headers }) {
  const p = '/api/projects/1'
  const flags = `${p}/feature_flags/`

  // Page load 1: feature flags list
  appShell(p, headers)
  sceneLoad(p, headers, 'FeatureFlags')
  sceneLoad(p, headers, 'FeatureFlags')
  hogql(p, headers)
  const list = get(`${flags}?limit=100&offset=0`, headers)
  get(`${p}/default_evaluation_contexts/`, headers)
  get(`${p}/default_release_conditions/`, headers)
  sleep(1)

  // Search, debounced by the UI: one list request per search term, not per keystroke.
  const term = SEARCH_TERMS[Math.floor(Math.random() * SEARCH_TERMS.length)]
  get(`${flags}?limit=100&offset=0&search=${term}`, headers)
  get(`${flags}?limit=100&offset=0&search=${term}&active=true`, headers)
  sleep(2)

  // Open a flag
  const results = list.json('results') || []
  if (results.length) {
    const id = results[Math.floor(Math.random() * results.length)].id
    sceneLoad(p, headers, 'FeatureFlag')
    get(`${flags}${id}/`, headers)
    get(`${flags}${id}/status/`, headers)
    get(`${flags}${id}/dependent_flags/`, headers)
    get(`${flags}?limit=100&offset=0`, headers)
    hogql(p, headers)
  }
  sleep(2)

  // Page load 2: dashboards list, then open one
  appShell(p, headers)
  sceneLoad(p, headers, 'Dashboards')
  hogql(p, headers)
  get(`${p}/dashboard_templates/`, headers)
  const dashboards = get(`${p}/dashboards/?limit=100`, headers).json('results') || []
  if (dashboards.length) {
    sceneLoad(p, headers, 'Dashboard')
    sceneLoad(p, headers, 'Dashboard')
    get(`${p}/dashboards/${dashboards[0].id}/`, headers)
    get(`${p}/insights/?limit=1`, headers)
    get(`${p}/insight_variables/`, headers)
    get(`${p}/data_color_themes/`, headers)
    get(`${p}/events_retention/`, headers)
    hogql(p, headers)
    hogql(p, headers)
  }
  sleep(3)
}
