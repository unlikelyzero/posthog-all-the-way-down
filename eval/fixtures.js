#!/usr/bin/env node
// Offline fallback for the demo: writes k6 `--out json` files that stand in for live runs.
// Deterministic (seeded), zero dependencies.
//
//   node eval/fixtures.js            # writes out/fixtures/{browser-<scenario>-<n>,protocol-<scenario>}.json
//   node eval/fixtures.js --check    # also scores each scenario against protocol-baseline and asserts the stage pattern
//
// Scenarios mirror posthog/frontend.patch: `no-debounce` fires one list request per keystroke,
// `n-plus-one` fetches each listed flag's activity/ after every list load. protocol-<drift>.json is what a
// repaired api.js emits for that drift.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { routeKey } from '../k6/route.js'
import { readPoints, score } from './score.js'

const OUT = 'out/fixtures'
const H = 'http://localhost:8000'
const P = 1 // project id
export const SCENARIOS = ['baseline', 'no-debounce', 'n-plus-one']
const TERMS = ['checkout', 'billing', 'onboarding'] // the three reference runs (DESIGN §4.2)
const LISTED = 20 // flags on the unfiltered list page
const MATCHES = { checkout: 3, billing: 2, onboarding: 4 } // flags matching each term

// mulberry32: small seeded PRNG so reruns are byte-identical.
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const q = (kind) => routeKey('POST', `${H}/api/environments/${P}/query/`, { query: { kind } })
const R = {
  me: routeKey('GET', `${H}/api/users/@me/`),
  flags: routeKey('GET', `${H}/api/projects/${P}/feature_flags/?limit=100&offset=0`),
  flag: routeKey('GET', `${H}/api/projects/${P}/feature_flags/42/`),
  activity: routeKey('GET', `${H}/api/projects/${P}/feature_flags/42/activity/`), // n-plus-one only
  dashboards: routeKey('GET', `${H}/api/environments/${P}/dashboards/?limit=100`),
  dashboard: routeKey('GET', `${H}/api/environments/${P}/dashboards/7/`),
  hogql: q('HogQLQuery'),
  trends: q('TrendsQuery'),
}

// One browser journey: open flags, search, open a flag, open a dashboard. Returns [route, count] pairs.
function journey(scenario, term, rand) {
  const listLoads = scenario === 'no-debounce' ? 1 + term.length : 2
  const nPlusOne = scenario === 'n-plus-one' ? LISTED + MATCHES[term] : 0
  return [
    [R.me, 1],
    [R.flags, listLoads],
    [R.flag, 1],
    [R.activity, nPlusOne],
    [R.dashboards, 1],
    [R.dashboard, 1],
    [R.hogql, 1 + Math.floor(rand() * 2)], // dashboard tiles vary a little between runs
    [R.trends, 2 + Math.floor(rand() * 2)],
  ]
}

function ndjson(metric, calls, rand, status) {
  const lines = [JSON.stringify({ type: 'Metric', data: { name: metric, type: 'counter', contains: 'default', thresholds: [], submetrics: null }, metric })]
  let t = Date.parse('2026-09-30T18:00:00Z')
  for (const [route, n] of calls)
    for (let i = 0; i < n; i++) {
      t += Math.floor(50 + rand() * 400)
      const tags = status ? { method: route.split(' ')[0], route, scenario: 'flags_journey', status: '200' } : { route }
      lines.push(JSON.stringify({ metric, type: 'Point', data: { time: new Date(t).toISOString(), value: 1, tags } }))
    }
  return lines.join('\n') + '\n'
}

export function generate() {
  mkdirSync(OUT, { recursive: true })
  SCENARIOS.forEach((scenario, s) => {
    TERMS.forEach((term, i) => {
      const rand = rng(100 * s + i + 1)
      writeFileSync(`${OUT}/browser-${scenario}-${i + 1}.json`, ndjson('api_calls', journey(scenario, term, rand), rand))
    })
    // Protocol: 3 VUs x 30 s, about 12 iterations of the same journey, terms drawn from api.js's list.
    const rand = rng(1000 + s)
    const calls = []
    for (let it = 0; it < 12; it++) calls.push(...journey(scenario, TERMS[it % TERMS.length], rand))
    writeFileSync(`${OUT}/protocol-${scenario}.json`, ndjson('http_reqs', calls, rand, true))
  })
}

export const load = (scenario, protocol = 'baseline') => {
  const refs = [1, 2, 3].map((i) => readPoints(readFileSync(`${OUT}/browser-${scenario}-${i}.json`, 'utf8'), 'api_calls'))
  return score(refs.flat(), readPoints(readFileSync(`${OUT}/protocol-${protocol}.json`, 'utf8'), 'http_reqs'))
}

function check() {
  const want = { baseline: [true, true], 'no-debounce': [true, false], 'n-plus-one': [false, null] } // [C, M], null = either
  let ok = true
  for (const [scenario, [C, M]] of Object.entries(want)) {
    const s = load(scenario)
    const named = C || s.missing.includes(R.activity)
    const good = named && s.gates.C === C && (M === null || s.gates.M === M) && s.gates.E && s.gates.errors
    console.log(`${good ? 'ok  ' : 'BAD '} ${scenario.padEnd(12)} C=${s.C.toFixed(3)} M=${s.M.toFixed(3)} missing=${s.missing.join(', ') || '-'}`)
    ok &&= good
  }
  for (const drift of SCENARIOS.slice(1)) {
    const s = load(drift, drift)
    console.log(`${s.pass ? 'ok  ' : 'BAD '} repaired ${drift.padEnd(12)} C=${s.C.toFixed(3)} M=${s.M.toFixed(3)}`)
    ok &&= s.pass
  }
  if (!ok) process.exit(1)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  generate()
  if (process.argv.includes('--check')) check()
}
