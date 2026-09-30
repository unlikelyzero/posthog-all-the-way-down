// Shared route-key rule. Imported by k6/journey.js, k6/api.js and eval/score.js,
// so the browser reference, the protocol test and the scorer can't disagree.
// The template rule is copied from posthog-js network-metrics.ts (isIdLikeSegment),
// so keys match PostHog's own `url.template` attribute.

const isIdLikeSegment = (s) => /^\d+$/.test(s) || (s.length >= 8 && /^[0-9a-f-]*\d[0-9a-f-]*$/i.test(s))

export const template = (pathname) =>
  pathname.split('/').map((s) => (isIdLikeSegment(s) ? ':id' : s)).join('/')

// k6 has no URL global, so parse by hand: strip scheme+host, query and fragment.
export const pathOf = (url) => url.replace(/^[a-z]+:\/\/[^/]+/i, '').split(/[?#]/)[0] || '/'

export function routeKey(method, url, body) {
  const path = template(pathOf(url))
  let kind = ''
  if (path.endsWith('/query/') && body) {
    try {
      const q = (typeof body === 'string' ? JSON.parse(body) : body).query
      if (q && q.kind) kind = '#' + q.kind
    } catch (_) {
      // non-JSON body: no kind suffix
    }
  }
  return method.toUpperCase() + ' ' + path + kind
}

// PostHog's own metrics can't see request bodies, so the cross-check compares without #kind.
export const withoutKind = (key) => key.split('#')[0]
