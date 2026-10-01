// k6 protocol test replaying one hand-clicked session (Persons page), per-route call counts taken from
// posthog-js network metrics for 2026-10-01 01:48:00-01:53:00 UTC. Login routes are skipped: setup() logs in.
//   RUN_ID=s1 k6 run --out json=out/protocol-s1.json k6/session.js
import http from 'k6/http'
import { check, sleep } from 'k6'
import { BASE, login } from './auth.js'
import { routeKey } from './route.js'

export const options = {
  scenarios: {
    session: { executor: 'per-vu-iterations', vus: 3, iterations: 4 },
  },
}

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

const sceneLoad = (p, headers, scene) => {
  req('POST', `${p}/file_system/log_view/`, headers, { type: 'scene', ref: scene })
  get(`${p}/file_system?parent=&depth=1`, headers)
}

const hogql = (p, headers) => req('POST', `${p}/query/HogQLQuery/`, headers, { query: { kind: 'HogQLQuery', query: LIB_HOST_QUERY } })

export default function ({ headers }) {
  const p = '/api/projects/1'

  // Page load: app shell, once each
  get('/api/billing/', headers)
  get(`${p}/file_system_shortcut/`, headers)
  get(`${p}/file_system/log_view?type=scene`, headers)
  get(`${p}/conversations/`, headers)
  get(`${p}/health_issues/summary/`, headers)
  get(`${p}/event_ingestion_restrictions/`, headers)
  get(`${p}/event_definitions/?limit=100`, headers)
  get(`${p}/dashboards/?limit=100`, headers)
  get('/api/organizations/@current/integrations/', headers)
  sleep(1)

  // Persons list
  sceneLoad(p, headers, 'Persons')
  hogql(p, headers)
  get(`${p}/customer_profile_configs`, headers)
  get(`${p}/column_configurations`, headers)
  req('POST', `${p}/query/ActorsQuery/`, headers, {
    query: { kind: 'ActorsQuery', select: ['id', 'person_display_name -- Person', 'created_at'], orderBy: ['created_at DESC'], limit: 100 },
  })
  sleep(3)

  // Second scene
  sceneLoad(p, headers, 'Dashboards')
  hogql(p, headers)
  get(`${p}/customer_profile_configs`, headers)
  sleep(2)
}
