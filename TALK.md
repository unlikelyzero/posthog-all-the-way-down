# Using PostHog to Test PostHog with Grafana k6 and PostHog MCP and the Grafana k6 MCP
### presented at the Grafana Meetup at PostHog

*Subtitle slide:* Your load test passed. It's also lying.

*Title slide gag:* the title gets longer with each click, then collapses into a recursion
diagram. PostHog (the app under test) → k6 browser → PostHog (sees the traffic too)
→ k6 protocol test → PostHog (the flags that break it) → Claude + k6 MCP → PostHog
(stores the eval results). "Yes, every arrow is real."

**Thesis:** A protocol load test is a cached model of browser behavior. Keep comparing it
with observed browser traffic, or a green test may be generating yesterday's load.

**Budget:** 25 min = 20 min talk + 5 min Q&A/slack. About 12 slides.
Build spec: [DESIGN.md](DESIGN.md).

---

## 0:00–2:00 · Hook (1 slide)

- Two bar charts: the k6 load test's requests per route next to the reference browser journey's.
  They match.
- *Click.* One frontend change behind a feature flag. The browser chart jumps about 8× on one route.
  The load test's chart doesn't move.
- "Our load test is still green. It's now testing an app that no longer exists."

## 2:00–4:00 · The problem (1 slide)

- A protocol test is a cached model of what the frontend used to send, and nothing
  tells you when that cache goes stale.
- Code review can see that a debounce was removed. It can't tell you what that does to the
  load profile, or whether the load test changed with it.
- PostHog deploys every merge to master. *Cite the development-process handbook page.*

## 4:00–7:00 · The idea (2 slides)

- **Reference journey:** k6 browser drives the real UI and records every API call it makes
  (`page.on('request')`), including which query type each `/query/` call sends.
- **PostHog sees it too:** the same calls show up in PostHog's own network metrics,
  recorded by PostHog about PostHog. That makes it a cross-check, not the judge.
- **Score the protocol test against it:** coverage, mix and staleness are *independent*
  pass/fail checks. Thresholds were calibrated from 5 baseline runs, not chosen by feel.
- Say it honestly: "This is a journey contract, not a model of your whole user population."

## 7:00–14:00 · Demo (7 min)

1. **Baseline (1 min):** all gates green, and the PostHog cross-check agrees.
2. **Ship a change (3 min, live):** turn on `meetup-no-debounce` in the PostHog UI. The journey
   reloads and waits until it sees the flag, then runs. **Coverage passes and mix fails.** *This is the
   key point: an endpoint checklist alone would have passed.*
3. **Second change (30 s, recorded):** `meetup-n-plus-one`. Coverage fails, and the report names the new route.
4. **Repair (2.5 min):** a recorded agent run, sped up 4×. Claude + **k6 MCP**:
   `get_documentation` → edit → `validate_script` catches a wrong k6 API → `run_script`.
   Then **live:** `validate_script` + `run_script` + score on the repaired test. The score is green again.

Each step has a 60 s timeout, then plays its video fallback.

## 14:00–17:00 · Evaluating the agent (2 slides)

- 3 scenarios × 5 trials, **with the k6 MCP vs without**. Graded on held-out browser runs
  the agent never saw, plus realism checks so it can't just replay the route list.
- Show successes/5 with confidence intervals, and call it a pilot.
- The comparison that answers "is the MCP bolted on?": pass rate, and how often
  `validate_script` caught a mistake before the run.
- "This is how PostHog evaluates its own MCP server." *Cite services/mcp/evals README.*

## 17:00–19:00 · Limits + "doesn't PostHog / Grafana already do this?" (1 slide)

| Question | Answer |
|---|---|
| k6 Studio can regenerate the test from a recording | Yes. This tells you *when* to regenerate. |
| Just run browser VUs at load | Grafana recommends mostly protocol VUs plus a few browser VUs for cost. This keeps the protocol side honest. |
| Faro / Beyla / OTel instead of PostHog? | Any real-user telemetry works. The comparison method is the point. |
| Replay's network tab / Alerts / self-driving | One session at a time / says traffic changed, not what's stale / fixes product code, not test code. |

Limits: request bodies beyond the query type aren't compared, latency fidelity isn't
measured, the reference is a single journey, and PostHog's metrics product is in alpha.

## 19:00–20:00 · Takeaways (1 slide)

1. Your load test is a cached model of the frontend. Check it for staleness.
2. Compare it against real browser traffic, with independent gates and calibrated thresholds.
3. Let agents fix it, and eval the agent too: with vs without the tools, on held-out data.

Closing slide: a PostHog dashboard of the eval results ("PostHogs all the way down") +
a QR code to `posthog-all-the-way-down`.
Title-slide footer: *Not affiliated with PostHog (just standing in their office).*
Ask the hosts before using the hedgehog art; PostHog's brand guidelines require permission.

## 20:00–25:00 · Q&A + slack

---

## Cut list if running long

1. The second change becomes one screenshot (−30 s).
2. The agent-eval section shrinks to one table (−1.5 min).
3. The limits slide folds into Q&A (−2 min).
