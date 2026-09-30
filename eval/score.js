#!/usr/bin/env node
// Scores a k6 protocol run against k6 browser reference runs. Zero dependencies.
//
//   node eval/score.js --ref out/browser-a.json --ref out/browser-b.json \
//     --protocol out/protocol-a.json [--run-id ID] [--scenario NAME] [--json out.json]
//   node eval/score.js --selftest
//
// Env (all optional): POSTHOG_HOST, POSTHOG_PERSONAL_API_KEY (cross-check, query:read),
// POSTHOG_PROJECT_API_KEY (sends meetup_eval_result).
// Exit code: 0 when every gate passes, 1 otherwise.
import { readFileSync, writeFileSync } from 'node:fs'
import { isIgnoredPath, routeKey, template, withoutKind } from '../k6/route.js'

// Starting values from DESIGN.md §5.1; replace with the calibrated numbers (§5.2).
export const THRESHOLDS = { C: 0.95, M: 0.85, E: 0.02, errors: 0.01 }
export const CRITICAL_ROUTES = ['GET /api/projects/:id/feature_flags/']

// k6 --out json is one JSON object per line. Reference runs count `api_calls` by route;
// the protocol run counts `http_reqs` by route and status.
export function readPoints(text, metric) {
  const points = []
  for (const line of text.split('\n')) {
    if (!line.includes('"Point"') || !line.includes(`"${metric}"`)) continue
    const p = JSON.parse(line)
    if (p.type === 'Point' && p.metric === metric && p.data.tags?.route) {
      points.push({ route: p.data.tags.route, status: Number(p.data.tags.status || 0), value: p.data.value })
    }
  }
  return points
}

const tally = (points) => {
  const counts = {}
  for (const p of points) counts[p.route] = (counts[p.route] || 0) + p.value
  return counts
}

const share = (counts) => {
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  const out = {}
  for (const [r, n] of Object.entries(counts)) out[r] = total ? n / total : 0
  return out
}

// ref: [{route, value}] pooled across the R browser runs. proto: [{route, status, value}].
export function score(ref, proto) {
  const w = share(tally(ref))
  const q = share(tally(proto))
  const routes = new Set([...Object.keys(w), ...Object.keys(q)])

  const C = Object.entries(w).reduce((a, [r, wr]) => a + (q[r] > 0 ? wr : 0), 0)
  let l1 = 0
  for (const r of routes) l1 += Math.abs((w[r] || 0) - (q[r] || 0))
  const M = 1 - l1 / 2

  const total = proto.reduce((a, p) => a + p.value, 0)
  const stale = proto.filter((p) => !(p.route in w) || p.status === 404 || p.status === 410)
  const bad = proto.filter((p) => !(p.status >= 200 && p.status < 400))
  const E = total ? stale.reduce((a, p) => a + p.value, 0) / total : 0
  const errors = total ? bad.reduce((a, p) => a + p.value, 0) / total : 0

  const uncoveredCritical = CRITICAL_ROUTES.filter((r) => r in w && !(q[r] > 0))
  const missing = Object.keys(w).filter((r) => !(q[r] > 0)).sort((a, b) => w[b] - w[a])
  const unknown = [...new Set(stale.map((p) => p.route))]
  const gates = {
    C: C >= THRESHOLDS.C && uncoveredCritical.length === 0,
    M: M >= THRESHOLDS.M,
    E: E <= THRESHOLDS.E,
    errors: errors <= THRESHOLDS.errors,
  }
  return { C, M, E, errors, gates, pass: Object.values(gates).every(Boolean), w, q, missing, unknown, uncoveredCritical }
}

// Agreement between the browser reference and PostHog's own network metrics, on keys without #kind.
export function agreement(ref, posthogRows) {
  const a = share(tally(ref.map((p) => ({ ...p, route: withoutKind(p.route) }))))
  const b = share(tally(posthogRows))
  let l1 = 0
  for (const r of new Set([...Object.keys(a), ...Object.keys(b)])) l1 += Math.abs((a[r] || 0) - (b[r] || 0))
  return 1 - l1 / 2
}

// Metric attributes live on posthog.metric_series, keyed by series_fingerprint; posthog.metrics holds the
// pre-aggregated histogram rows, so calls = sum(count).
const CROSSCHECK_SQL = `SELECT s.attributes['http.request.method'] AS method,
       s.attributes['url.template'] AS route,
       sum(m.count) AS calls
FROM posthog.metrics AS m
JOIN (SELECT series_fingerprint, any(attributes) AS attributes FROM posthog.metric_series GROUP BY series_fingerprint) AS s
  ON m.series_fingerprint = s.series_fingerprint
WHERE m.metric_name = 'http.client.request.duration'
  AND m.service_name = 'posthog-app'
  AND s.attributes['meetup.run_id'] = {run_id}
GROUP BY method, route`

async function crosscheck(runId, deadlineMs = 20000) {
  const { POSTHOG_HOST: host, POSTHOG_PERSONAL_API_KEY: key } = process.env
  if (!host || !key || !runId) return null
  const end = Date.now() + deadlineMs
  while (Date.now() < end) {
    try {
      const res = await fetch(`${host}/api/projects/1/query/`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: { kind: 'HogQLQuery', query: CROSSCHECK_SQL, values: { run_id: runId } } }),
        signal: AbortSignal.timeout(Math.max(1000, end - Date.now())),
      })
      if (res.ok) {
        const rows = (await res.json()).results || []
        const kept = rows.filter(([, r]) => !isIgnoredPath(r))
        if (kept.length) return kept.map(([m, r, n]) => ({ route: `${m} ${r}`, value: Number(n) }))
      }
    } catch (_) {
      // retry until the deadline
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return null
}

async function sendResult(props) {
  const { POSTHOG_HOST: host, POSTHOG_PROJECT_API_KEY: key } = process.env
  if (!host || !key) return
  try {
    await fetch(`${host}/i/v0/e/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, event: 'meetup_eval_result', distinct_id: 'meetup-eval', properties: props }),
      signal: AbortSignal.timeout(5000),
    })
  } catch (e) {
    console.error(`could not send meetup_eval_result: ${e.message}`)
  }
}

const pct = (x) => (x * 100).toFixed(1) + '%'
const mark = (ok) => (ok ? 'PASS' : 'FAIL')

function report(s, agree) {
  const t = THRESHOLDS
  console.log(`Coverage C  ${pct(s.C).padStart(7)}  (>= ${pct(t.C)})  ${mark(s.gates.C)}`)
  console.log(`Mix      M  ${pct(s.M).padStart(7)}  (>= ${pct(t.M)})  ${mark(s.gates.M)}`)
  console.log(`Stale    E  ${pct(s.E).padStart(7)}  (<= ${pct(t.E)})  ${mark(s.gates.E)}`)
  console.log(`Errors      ${pct(s.errors).padStart(7)}  (<= ${pct(t.errors)})  ${mark(s.gates.errors)}`)
  for (const r of s.missing) console.log(`  missing from protocol: ${r}  (${pct(s.w[r])} of browser calls)`)
  for (const r of s.uncoveredCritical) console.log(`  critical route uncovered: ${r}`)
  for (const r of s.unknown) console.log(`  stale in protocol: ${r}`)
  const drift = Object.keys({ ...s.w, ...s.q })
    .map((r) => [r, (s.q[r] || 0) - (s.w[r] || 0)])
    .filter(([, d]) => Math.abs(d) >= 0.05)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
  for (const [r, d] of drift) console.log(`  mix ${d > 0 ? 'over' : 'under'} by ${pct(Math.abs(d))}: ${r}`)
  console.log(agree == null ? 'PostHog cross-check pending' : `PostHog cross-check agreement ${pct(agree)}`)
  console.log(s.pass ? 'RESULT: PASS' : 'RESULT: FAIL')
}

function selftest() {
  const assert = (ok, msg) => {
    if (!ok) throw new Error('selftest failed: ' + msg)
  }
  const pts = (obj, status = 200) => Object.entries(obj).map(([route, value]) => ({ route, value, status }))
  const base = { 'GET /a/': 6, 'GET /b/': 3, 'POST /q/#X': 1 }

  const same = score(pts(base), pts(base))
  assert(Math.abs(same.M - 1) < 1e-9 && Math.abs(same.C - 1) < 1e-9 && same.pass, 'identical distributions give M = 1')
  assert(score(pts({ 'GET /a/': 1 }), pts({ 'GET /z/': 1 })).M === 0, 'disjoint distributions give M = 0')
  const nPlusOne = score(pts({ ...base, 'GET /a/:id/': 10 }), pts(base))
  assert(nPlusOne.C < THRESHOLDS.C && !nPlusOne.gates.C && nPlusOne.missing[0] === 'GET /a/:id/', 'a new route drops C')
  const gone = score(pts(base), [...pts(base), ...pts({ 'GET /a/': 1 }, 404)])
  assert(gone.E > 0 && gone.errors > 0, 'a 404 counts toward E')
  const noDebounce = score(pts({ 'GET /a/': 60, 'GET /b/': 3 }), pts(base))
  assert(noDebounce.gates.C && !noDebounce.gates.M, 'volume shift fails M and passes C')
  const critical = score(pts({ [CRITICAL_ROUTES[0]]: 1, 'GET /a/': 99 }), pts({ 'GET /a/': 1 }))
  assert(!critical.gates.C, 'an uncovered critical route fails C')

  // posthog-js network-metrics.test.ts examples
  for (const [input, want] of [
    ['/api/projects/123/tasks/550e8400-e29b-41d4-a716-446655440000/', '/api/projects/:id/tasks/:id/'],
    ['/api/keys/5f3a9c2e1b4d', '/api/keys/:id'],
    ['/api/skills/short-name/files/config.ts', '/api/skills/short-name/files/config.ts'],
    ['/invoices/38217.pdf', '/invoices/38217.pdf'],
    ['/customers/cus_a1b2c3d4e5', '/customers/cus_a1b2c3d4e5'],
    ['/api/v2/things', '/api/v2/things'],
    ['/', '/'],
  ])
    assert(template(input) === want, `template(${input})`)
  assert(routeKey('GET', 'https://h/api/things?limit=10') === 'GET /api/things', 'query string dropped')
  assert(routeKey('GET', '/api/things#section') === 'GET /api/things', 'fragment dropped')
  assert(
    routeKey('POST', 'https://h/api/environments/1/query/', '{"query":{"kind":"HogQLQuery"}}') ===
      'POST /api/environments/:id/query/#HogQLQuery',
    'query kind suffix'
  )
  assert(agreement(pts({ 'POST /q/#X': 2, 'POST /q/#Y': 2 }), pts({ 'POST /q/': 4 })) === 1, 'cross-check ignores #kind')
  console.log('selftest: ok')
}

function parseArgs(argv) {
  const args = { ref: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--selftest') args.selftest = true
    else if (a === '--ref') args.ref.push(argv[++i])
    else if (a.startsWith('--')) args[a.slice(2).replace(/-(.)/g, (_, c) => c.toUpperCase())] = argv[++i]
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.selftest) return selftest()
  if (!args.ref.length || !args.protocol) {
    console.error('usage: score.js --ref browser.json [--ref ...] --protocol protocol.json [--run-id ID] [--scenario NAME] [--json out.json]')
    process.exit(2)
  }
  const ref = args.ref.flatMap((f) => readPoints(readFileSync(f, 'utf8'), 'api_calls'))
  const proto = readPoints(readFileSync(args.protocol, 'utf8'), 'http_reqs')
  if (!ref.length || !proto.length) {
    console.error(`no route-tagged points found (reference: ${ref.length}, protocol: ${proto.length})`)
    process.exit(2)
  }
  const s = score(ref, proto)
  const rows = await crosscheck(args.runId)
  const agree = rows ? agreement(ref, rows) : null
  report(s, agree)
  const result = {
    run_id: args.runId || null,
    scenario: args.scenario || null,
    C: s.C,
    M: s.M,
    E: s.E,
    errors: s.errors,
    gates: s.gates,
    pass: s.pass,
    missing: s.missing,
    unknown: s.unknown,
    crosscheck_agreement: agree,
  }
  if (args.json) writeFileSync(args.json, JSON.stringify(result, null, 2))
  await sendResult(result)
  process.exit(s.pass ? 0 : 1)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
