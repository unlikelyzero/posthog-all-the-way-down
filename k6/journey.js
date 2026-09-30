// k6 browser: the reference. Drives the real PostHog UI and counts every app API call by route.
//   RUN_ID=b1 TERM=checkout k6 run --out json=out/browser-b1.json k6/journey.js
import { browser } from 'k6/browser'
import { Counter } from 'k6/metrics'
import { BASE, login } from './auth.js'
import { routeKey } from './route.js'

export const options = {
  scenarios: {
    journey: { executor: 'shared-iterations', vus: 1, iterations: 1, options: { browser: { type: 'chromium' } } },
  },
}

const apiCalls = new Counter('api_calls')
const RUN_ID = __ENV.RUN_ID || `run-${Date.now()}`
const TERM = __ENV.TERM || 'checkout'
const KEY_DELAY_MS = 120 // fixed per-key delay so debounce behavior is reproducible
// Client-side route changes fire no load event, so waitForLoadState returns at once; give each page time to fetch.
const SETTLE_MS = 3000
// Flags the journey waits for before running (drift demo): e.g. WAIT_FOR_FLAG=meetup-no-debounce
const WAIT_FOR_FLAG = __ENV.WAIT_FOR_FLAG

// Excluded: posthog-js's own traffic (/i/v1/, /e/, /flags, /decide, /api/surveys) and static assets.
const IGNORED = /^\/(i\/v\d|e\/|flags|decide|api\/surveys|static|batch|s\/|_)/
const isAppApi = (req) => {
  const type = req.resourceType().toLowerCase() // k6 reports 'Fetch' / 'XHR'
  if (type !== 'fetch' && type !== 'xhr') return false
  const url = req.url()
  if (!url.startsWith(BASE)) return false
  return !IGNORED.test(url.slice(BASE.length))
}

export function setup() {
  return login()
}

export default async function (auth) {
  const context = await browser.newContext()
  const host = BASE.replace(/^https?:\/\//, '').split(/[:/]/)[0]
  await context.addCookies([
    { name: 'sessionid', value: auth.sessionid, domain: host, path: '/' },
    { name: 'posthog_csrftoken', value: auth.csrf, domain: host, path: '/' },
  ])
  await context.addInitScript(`localStorage.setItem('meetup_run_id', ${JSON.stringify(RUN_ID)})`)
  const page = await context.newPage()
  page.on('request', (req) => {
    if (isAppApi(req)) apiCalls.add(1, { route: routeKey(req.method(), req.url(), req.postData()) })
  })

  try {
    await page.goto(`${BASE}/feature_flags`, { waitUntil: 'networkidle' })
    if (WAIT_FOR_FLAG) await waitForFlag(page, WAIT_FOR_FLAG)

    const search = page.locator('[data-attr="feature-flag-search"] input, input[data-attr="feature-flag-search"]')
    await search.first().type(TERM, { delay: KEY_DELAY_MS })
    await page.waitForTimeout(SETTLE_MS)

    await page.locator('[data-attr="feature-flag-table"] tbody tr a').first().click()
    await page.waitForTimeout(SETTLE_MS)

    await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' })
    await page.locator('[data-attr="dashboards-table"] tbody tr a').first().click()
    await page.waitForTimeout(SETTLE_MS)

    // posthog-js batches metrics every 10 s; flush so the cross-check sees the tail of the run.
    await page.evaluate(() => window.posthog?.metrics?.flush())
  } finally {
    await page.close()
    await context.close()
  }
}

// The drift switch is a PostHog flag in project 1: reload until the page sees it, or give up at 60 s.
async function waitForFlag(page, key) {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    await page.evaluate(() => window.posthog?.reloadFeatureFlags())
    await page.waitForTimeout(2000)
    if (await page.evaluate((k) => !!window.posthog?.isFeatureEnabled(k), key)) {
      await page.reload({ waitUntil: 'networkidle' })
      return
    }
  }
  throw new Error(`flag ${key} never turned on`)
}
