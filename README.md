# posthog-all-the-way-down

> Using PostHog to Test PostHog with Grafana k6 and PostHog MCP and the Grafana k6 MCP,
> presented at the Grafana Meetup at PostHog.

A protocol load test is a cached model of browser behavior. This project keeps comparing
a k6 protocol test with the traffic a real browser (k6 browser) generates against
self-hosted PostHog. It cross-checks against PostHog's own network metrics and fails when
a frontend change makes the load test stale. In production, those metrics record what real users'
browsers send, so they can replace the k6 browser as the reference (`--reference posthog`). Claude Code, with the Grafana k6 MCP server,
then repairs the test, and the agent is evaluated too.

**Status:** runs end to end against a live self-hosted PostHog. DESIGN.md §9 lists what is verified.

## Quickstart

```bash
node eval/score.js --selftest && node agent-eval/report.js --selftest   # no stack needed

# Stack: PostHog's hobby compose at the pinned SHA, plus posthog/docker-compose.override.yml.
docker pull posthog/posthog:sha-54c04a0f494dc0821b87e95c19dcade17a633591
docker pull ghcr.io/posthog/posthog-node:6bcb56fb6e5ff2200852f2080339050d32b98d20
docker tag ghcr.io/posthog/posthog-node:6bcb56fb6e5ff2200852f2080339050d32b98d20 posthog/posthog-node:meetup
# Build frontend/dist with PostHog's own Dockerfile stage, from a checkout at the pinned SHA
# with posthog/frontend.patch applied, and copy it to posthog/dist/:
#   (cd <posthog-checkout> && git apply <this-repo>/posthog/frontend.patch \
#     && docker build --target frontend-build -t posthog-meetup-frontend .)
#   docker cp "$(docker create posthog-meetup-frontend)":/code/frontend/dist posthog/dist
# then:
docker build --build-arg POSTHOG_SHA=54c04a0f494dc0821b87e95c19dcade17a633591 -t posthog-meetup:local posthog/
# Fast path without a frontend build: -f posthog/Dockerfile.hotpatch applies the same changes to the built JS.
POSTHOG_NODE_TAG=meetup docker compose -f docker-compose.hobby.yml -f docker-compose.override.yml up -d

# Traffic and score (PH_EMAIL / PH_PASSWORD: the local test user; BASE_URL: the stack)
RUN_ID=b1 TERM=checkout k6 run --out json=out/browser-b1.json k6/journey.js
RUN_ID=p1 k6 run --out json=out/protocol-p1.json k6/api.js
node eval/score.js --ref out/browser-b1.json --protocol out/protocol-p1.json --run-id b1
```

`k6/api.js` matches the per-route mix of the real baseline journey.

**Calibration** (DESIGN.md §5.2): 5 baseline browser runs, each scored against its own protocol run.

| Gate | Baseline runs | Worst | Threshold |
|---|---|---|---|
| Coverage C | 0.964 0.965 0.964 0.966 0.964 | 0.964 | ≥ 0.95 |
| Mix M | 0.931 0.915 0.931 0.900 0.931 | 0.900 | ≥ 0.85 |
| Stale E | 0 0 0 0 0 | 0 | ≤ 0.02 |
| Errors | 0 0 0 0 0 | 0 | ≤ 0.01 |

The seeded drifts fail their intended gates: no-debounce fails M only (C 0.977, M 0.762); N+1 fails C
(0.589) and the report names `GET /api/projects/:id/feature_flags/:id/activity/`.
`./demo.sh baseline|no-debounce|n-plus-one|repaired` runs a stage live and falls back to seeded offline fixtures
(`eval/fixtures.js`) if the stack fails or takes over 60 s; `./demo.sh check` asserts the offline pass/fail pattern.
`./demo.sh users [15m]` scores the stage protocol run against every session PostHog recorded in the window.
`agent-eval/run.sh` runs the agent eval; it needs `mcp-k6` (`brew install mcp-k6` from the `grafana/grafana` tap).

- [DESIGN.md](DESIGN.md): the build spec. Start with section 9, the verification checklist.
- [TALK.md](TALK.md): the 25-minute talk outline.
- [slides/](slides/): three draft reveal.js decks (A recursion, B data-forward, C one idea per slide).
  Serve with `python3 -m http.server -d slides 8766` and open http://127.0.0.1:8766/.
  Mascot images live in `slides/mascots/`, which is gitignored until PostHog and Grafana approve their use; the counters fall back to emoji without them.

Not affiliated with PostHog or Grafana Labs.

## License

MIT, see [LICENSE](LICENSE). `posthog/frontend.patch` contains code from PostHog, Inc., also
under the MIT license; see [NOTICE](NOTICE). Never publish the
built Docker image: it includes PostHog's `ee/` code, which may not be redistributed.
