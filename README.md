# posthog-all-the-way-down

> Using PostHog to Test PostHog with Grafana k6 and PostHog and the Grafana k6 MCP,
> presented at the Grafana Meetup at PostHog.

A protocol load test is a cached model of browser behavior. This project keeps comparing
a k6 protocol test with the traffic a real browser (k6 browser) generates against
self-hosted PostHog. It cross-checks against PostHog's own network metrics and fails when
a frontend change makes the load test stale. Claude Code, with the Grafana k6 MCP server,
then repairs the test, and the agent is evaluated too.

**Status:** design only. Nothing is built yet.

- [DESIGN.md](DESIGN.md): the build spec. Start with section 9, the verification checklist.
- [TALK.md](TALK.md): the 25-minute talk outline.

Not affiliated with PostHog or Grafana Labs.

## License

MIT, see [LICENSE](LICENSE). The planned `posthog/frontend.patch` will contain code from
PostHog, Inc., also under the MIT license; a NOTICE file will accompany it. Never publish the
built Docker image: it includes PostHog's `ee/` code, which may not be redistributed.
