#!/usr/bin/env bash
# Seeds the running stack (run from the hobby compose directory, or pass it as $1) and writes the
# generated local test credentials to out/local.env in this repo (gitignored). Source that file
# before running k6, score.js or agent-eval.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
stack=${1:-.}
env_file="$repo/out/local.env"
mkdir -p "$repo/out"
if [ ! -f "$env_file" ]; then
  cat > "$env_file" <<EOT
export BASE_URL=http://localhost
export POSTHOG_HOST=http://localhost
export PH_EMAIL=meetup@example.test
export PH_PASSWORD=$(openssl rand -hex 16)
export POSTHOG_PERSONAL_API_KEY=phx_$(openssl rand -hex 24)
EOT
fi
# shellcheck disable=SC1090
source "$env_file"
out=$(cd "$stack" && docker compose exec -T -e PH_EMAIL -e PH_PASSWORD -e POSTHOG_PERSONAL_API_KEY \
  web python manage.py shell < "$repo/posthog/seed.py" | tail -1)
echo "$out"
token=${out##* }
grep -q POSTHOG_PROJECT_API_KEY "$env_file" || echo "export POSTHOG_PROJECT_API_KEY=$token" >> "$env_file"
