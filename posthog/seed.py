# Seeds a fresh local stack: owner user, project 1, a personal API key, both meetup flags (off),
# flags for the journey to search, and the eval-results dashboard. Idempotent. Run through posthog/seed.sh.
import os

from django.utils import timezone

from posthog.models import User
from posthog.models.personal_api_key import PersonalAPIKey
from posthog.models.utils import hash_key_value, mask_key_value

from products.dashboards.backend.models.dashboard import Dashboard
from products.dashboards.backend.models.dashboard_tile import DashboardTile
from products.feature_flags.backend.models.feature_flag import FeatureFlag
from products.product_analytics.backend.models.insight import Insight

email, password, key = os.environ["PH_EMAIL"], os.environ["PH_PASSWORD"], os.environ["POSTHOG_PERSONAL_API_KEY"]

user = User.objects.filter(email=email).first()
if user is None:
    _, team, user = User.objects.bootstrap("Meetup", email, password, first_name="Meetup")
else:
    team = user.team
assert team.id == 1, f"expected the self team to be id 1, got {team.id}"

if not PersonalAPIKey.objects.filter(secure_value=hash_key_value(key)).exists():
    PersonalAPIKey.objects.create(
        user=user, label="meetup", secure_value=hash_key_value(key), mask_value=mask_key_value(key), scopes=["*"]
    )
user.credentials_reviewed_at = user.credentials_reviewed_at or timezone.now()
user.save()

rollout = {"groups": [{"properties": [], "rollout_percentage": 100}]}
keys = ["meetup-no-debounce", "meetup-n-plus-one"]
keys += [f"checkout-{n}" for n in ["v2", "express", "upsell", "coupons", "wallet", "paypal", "one-click", "tax"]]
keys += [f"{area}-{n}" for area in ["billing", "onboarding", "beta", "pricing", "search"] for n in ["new-ui", "flow", "banner"]]
for k in keys:
    FeatureFlag.objects.get_or_create(
        team=team, key=k, defaults={"created_by": user, "filters": rollout, "active": not k.startswith("meetup-")}
    )
# The closing "PostHogs all the way down" dashboard, over the events score.js and agent-eval/run.sh send.
dashboard, _ = Dashboard.objects.get_or_create(team=team, name="Meetup eval results", defaults={"created_by": user})


def sql(query, display="ActionsTable"):
    return {"kind": "DataVisualizationNode", "source": {"kind": "HogQLQuery", "query": query}, "display": display}


def events_avg(prop):
    return {"kind": "EventsNode", "event": "meetup_eval_result", "name": prop, "math": "avg", "math_property": prop}


tiles = {
    "Agent eval: pass@1 by task and condition": sql(
        """SELECT properties.task AS task, properties.condition AS condition,
       countIf(toString(properties.pass) = 'true') AS passed, count() AS trials,
       round(passed / trials * 100) AS pass_pct
FROM events WHERE event = 'meetup_agent_trial'
GROUP BY task, condition ORDER BY task, condition"""
    ),
    "Drift gates per scored run (C, M, E)": {
        "kind": "InsightVizNode",
        "source": {
            "kind": "TrendsQuery",
            "series": [events_avg("C"), events_avg("M"), events_avg("E")],
            "interval": "hour",
            "dateRange": {"date_from": "-7d"},
        },
    },
    "Latest scored runs": sql(
        """SELECT timestamp, properties.scenario AS scenario, properties.run_id AS run_id,
       round(toFloat(properties.C), 3) AS C, round(toFloat(properties.M), 3) AS M, round(toFloat(properties.E), 3) AS E,
       properties.pass AS pass, properties.crosscheck_agreement AS posthog_agreement
FROM events WHERE event = 'meetup_eval_result' ORDER BY timestamp DESC LIMIT 20"""
    ),
}
for name, query in tiles.items():
    insight, _ = Insight.objects.get_or_create(
        team=team, name=name, defaults={"query": query, "created_by": user, "saved": True}
    )
    DashboardTile.objects.get_or_create(dashboard=dashboard, insight=insight)
print(f"seeded team {team.id}: project api key {team.api_token}")
