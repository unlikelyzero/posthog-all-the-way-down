// Records the feature-flag search box for deck A's hook slide: typing "checkout" with the debounce in place,
// or with it removed (WAIT_FOR_FLAG=meetup-no-debounce). Frames count only flag-list requests. Run by slides/record.sh.
import { browser } from 'k6/browser'
import { BASE, login } from '../k6/auth.js'
import { record, waitForFlag } from '../k6/journey.js'
import { routeKey } from '../k6/route.js'

export const options = {
  scenarios: { s: { executor: 'shared-iterations', options: { browser: { type: 'chromium' } } } },
}

export function setup() {
  return login()
}

export default async function (auth) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.addCookies([{ name: 'sessionid', value: auth.sessionid, domain: 'localhost', path: '/' }])
  await context.addInitScript(`new MutationObserver(() => document.getElementById('bottom-notice')?.remove())
    .observe(document, { childList: true, subtree: true })`)
  const page = await context.newPage()
  let lists = 0
  page.on('request', (req) => {
    if (routeKey(req.method(), req.url()) === 'GET /api/projects/:id/feature_flags/') lists++
  })
  try {
    await page.goto(`${BASE}/feature_flags`, { waitUntil: 'networkidle' })
    if (__ENV.WAIT_FOR_FLAG) await waitForFlag(page, __ENV.WAIT_FOR_FLAG)
    const search = page.locator('input[data-attr="feature-flag-search"]')
    const box = await search.boundingBox()
    lists = 0
    const recording = record(page, () => lists, { x: box.x - 44, y: box.y - 14, width: 470, height: 300 })
    await page.waitForTimeout(600)
    await search.type('checkout', { delay: 120 })
    await page.waitForTimeout(2500)
    await recording.stop()
  } finally {
    await page.close()
    await context.close()
  }
}
