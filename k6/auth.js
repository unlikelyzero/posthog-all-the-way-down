// Session login shared by journey.js and api.js. Runs in setup(), never on stage.
// PH_EMAIL / PH_PASSWORD are the local stack's test user.
import http from 'k6/http'

export const BASE = __ENV.BASE_URL || 'http://localhost:8000'

export function login() {
  const jar = http.cookieJar()
  http.get(`${BASE}/login`) // sets posthog_csrftoken (posthog/settings/web.py CSRF_COOKIE_NAME)
  const csrf = jar.cookiesForURL(BASE).posthog_csrftoken?.[0] || ''
  const res = http.post(
    `${BASE}/api/login`,
    JSON.stringify({ email: __ENV.PH_EMAIL, password: __ENV.PH_PASSWORD }),
    { headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf, Referer: `${BASE}/login` } }
  )
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${res.body}`)
  const cookies = jar.cookiesForURL(BASE)
  return { sessionid: cookies.sessionid[0], csrf: cookies.posthog_csrftoken?.[0] || csrf }
}
