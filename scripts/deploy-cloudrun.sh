#!/usr/bin/env bash
# Tour Scout on Google Cloud Run: idempotent setup and deploy (docs/DEPLOY.md has the full guide).
#
#   scripts/deploy-cloudrun.sh plan                 print what would be created, change nothing
#   scripts/deploy-cloudrun.sh setup                APIs, service account, data bucket, secrets
#   BILLING_ACCOUNT=XXXXXX-XXXXXX-XXXXXX scripts/deploy-cloudrun.sh budget   alert-only budget (no cap)
#   CONFIRM_PUBLIC=1 scripts/deploy-cloudrun.sh deploy   build from source and deploy (public URL)
#   scripts/deploy-cloudrun.sh verify               health check and a preset smoke test
#   scripts/deploy-cloudrun.sh judging-on           judging window: min instances 1 + higher caps
#   scripts/deploy-cloudrun.sh judging-off          back to scale-to-zero and the normal caps
#
# Runs in bash on Linux (incl. WSL2 Ubuntu) or macOS; uses only bash, grep, cut, sed, tr and curl.
# Needs: gcloud, logged in (`gcloud auth login`) with the project set (`gcloud config set project ID`).
# Secrets are read from the environment or .env.local and piped to Secret Manager; never printed.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT=${PROJECT:-$(gcloud config get-value project 2>/dev/null)}
REGION=${REGION:-us-central1}          # Tier-1 pricing; Cloud Run's free tier applies per billing account
SERVICE=${SERVICE:-tour-scout}
BUCKET=${BUCKET:-${PROJECT}-tour-scout-data}
SA_NAME=tour-scout-run
SA="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
# Alert-only budget in the billing account's own currency (a budget must use it, e.g. INR):
# BUDGET_AMOUNT=850 BUDGET_CURRENCY=INR, or leave the currency out to read it from the account.
BUDGET_AMOUNT=${BUDGET_AMOUNT:-${BUDGET_USD:-10}}
[[ -n "$PROJECT" ]] || { echo "No project: run gcloud config set project <PROJECT_ID>" >&2; exit 1; }

say() { printf '\n== %s\n' "$*"; }

# Value of KEY from the environment, else from .env.local (KEY=value), without echoing it.
secret_value() {
  local key=$1 v=${!1:-}
  # tr -d '\r': a .env.local saved on Windows has CRLF line endings.
  if [[ -z "$v" && -f .env.local ]]; then v=$(tr -d '\r' < .env.local | grep -E "^${key}=" | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'); fi
  printf '%s' "$v"
}

plan() {
  cat <<EOF
Project        $PROJECT
Region         $REGION
Service        $SERVICE  (min 0, max 1 instance; 1 vCPU, 1 GiB; gen2; startup CPU boost; public)
Service acct   $SA  (secret accessor on 2 secrets; object user on the bucket; nothing else)
Data bucket    gs://$BUCKET  (mounted at /data: share links, LLM day counter, place-name cache)
Secrets        qloo-api-key <- QLOO_API_KEY, claude-api-key <- CLAUDE_API_KEY (from env or .env.local)
Env            deploy/cloudrun.env.yaml (caps: 3 tours/visitor/h, 40 tours/day, 30 model calls/day, \$1.50 model spend ceiling)
Judging env    deploy/cloudrun.judging.env.yaml (20 tours/visitor/h, 120 tours/day, 45 model calls/day, \$4 ceiling)
Build perms    default compute SA gets roles/cloudbuild.builds.builder and roles/run.builder (source deploys on a new project)
Budget         alert-only budget of ${BUDGET_AMOUNT} in the billing account's currency, at 50%, 90%, 100% (email to billing admins; no cap)
EOF
}

setup() {
  say "APIs"
  gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
    secretmanager.googleapis.com storage.googleapis.com iam.googleapis.com billingbudgets.googleapis.com --project "$PROJECT"
  say "Build permissions (source deploys on a new project build as the default compute service account)"
  local number
  number=$(gcloud projects describe "$PROJECT" --format 'value(projectNumber)')
  for role in roles/cloudbuild.builds.builder roles/run.builder; do
    gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:${number}-compute@developer.gserviceaccount.com" \
      --role "$role" --condition None >/dev/null
  done
  say "Service account"
  gcloud iam service-accounts describe "$SA" --project "$PROJECT" >/dev/null 2>&1 \
    || gcloud iam service-accounts create "$SA_NAME" --display-name "Tour Scout (Cloud Run runtime)" --project "$PROJECT"
  say "Data bucket"
  gcloud storage buckets describe "gs://$BUCKET" >/dev/null 2>&1 \
    || gcloud storage buckets create "gs://$BUCKET" --project "$PROJECT" --location "$REGION" --uniform-bucket-level-access --public-access-prevention
  gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member "serviceAccount:$SA" --role roles/storage.objectUser >/dev/null
  say "Secrets"
  for pair in qloo-api-key:QLOO_API_KEY claude-api-key:CLAUDE_API_KEY; do
    local name=${pair%%:*} key=${pair##*:} value
    value=$(secret_value "$key")
    if ! gcloud secrets describe "$name" --project "$PROJECT" >/dev/null 2>&1; then
      [[ -n "$value" ]] || { echo "$key is not set (env or .env.local)" >&2; exit 1; }
      printf '%s' "$value" | gcloud secrets create "$name" --project "$PROJECT" --replication-policy automatic --data-file=- >/dev/null
      echo "created secret $name"
    elif [[ "${ROTATE:-}" == "1" && -n "$value" ]]; then
      printf '%s' "$value" | gcloud secrets versions add "$name" --project "$PROJECT" --data-file=- >/dev/null
      echo "added a new version of $name"
    else
      echo "secret $name exists (ROTATE=1 to add a new version)"
    fi
    gcloud secrets add-iam-policy-binding "$name" --project "$PROJECT" --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor >/dev/null
  done
}

budget() {
  [[ -n "${BILLING_ACCOUNT:-}" ]] || { echo "Set BILLING_ACCOUNT (gcloud billing accounts list)" >&2; exit 1; }
  if gcloud billing budgets list --billing-account "$BILLING_ACCOUNT" --format 'value(displayName)' | grep -qx "tour-scout"; then
    echo "budget tour-scout exists"; return
  fi
  # Alerts only: a budget never stops spending; the caps in deploy/cloudrun.env.yaml bound usage.
  # The amount must be in the billing account's currency.
  local currency=${BUDGET_CURRENCY:-$(gcloud billing accounts describe "$BILLING_ACCOUNT" --format 'value(currencyCode)')}
  gcloud billing budgets create --billing-account "$BILLING_ACCOUNT" --display-name tour-scout \
    --budget-amount "${BUDGET_AMOUNT}${currency:-USD}" --filter-projects "projects/$PROJECT" \
    --threshold-rule percent=0.5 --threshold-rule percent=0.9 --threshold-rule percent=1.0
}

deploy() {
  [[ "${CONFIRM_PUBLIC:-}" == "1" ]] || { echo "Deploying makes the demo public. Re-run with CONFIRM_PUBLIC=1 once approved." >&2; exit 1; }
  say "Build (Cloud Build, Dockerfile) and deploy"
  gcloud run deploy "$SERVICE" --project "$PROJECT" --region "$REGION" --source . \
    --service-account "$SA" --allow-unauthenticated \
    --execution-environment gen2 --cpu 1 --memory 1Gi --cpu-boost \
    --min-instances 0 --max-instances 1 --concurrency 40 --timeout 300 \
    --env-vars-file deploy/cloudrun.env.yaml \
    --set-secrets "QLOO_API_KEY=qloo-api-key:latest,CLAUDE_API_KEY=claude-api-key:latest" \
    --add-volume "name=data,type=cloud-storage,bucket=$BUCKET,mount-options=uid=1000;gid=1000;implicit-dirs" \
    --add-volume-mount "volume=data,mount-path=/data"
  verify
}

verify() {
  local url
  url=$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format 'value(status.url)')
  say "Health: $url/api/health"
  curl -fsS "$url/api/health"; echo
  say "Preset replay (no API calls)"
  curl -fsS -o /dev/null -w "demo page %{http_code} in %{time_total}s\n" "$url/?demo=us-emerging"
  curl -fsS -o /dev/null -w "preset data %{http_code}\n" "$url/presets/us-emerging.json"
}

# Env file (KEY: "value" lines) as KEY=value,KEY=value for --update-env-vars.
env_pairs() { grep -E '^[A-Z_]+: ' "$1" | sed -E 's/^([A-Z_]+): "([^"]*)".*/\1=\2/' | paste -sd, -; }

judging() {
  if [[ "$1" == on ]]; then
    gcloud run services update "$SERVICE" --project "$PROJECT" --region "$REGION" --min-instances 1 \
      --update-env-vars "$(env_pairs deploy/cloudrun.judging.env.yaml)"
  else
    gcloud run services update "$SERVICE" --project "$PROJECT" --region "$REGION" --min-instances 0 \
      --update-env-vars "$(env_pairs deploy/cloudrun.env.yaml | tr , '\n' | grep -E "^($(grep -oE '^[A-Z_]+' deploy/cloudrun.judging.env.yaml | paste -sd'|' -))=" | paste -sd, -)"
  fi
  verify
}

case "${1:-plan}" in
  plan) plan ;;
  setup) plan; setup ;;
  budget) budget ;;
  deploy) deploy ;;
  verify) verify ;;
  judging-on) judging on ;;
  judging-off) judging off ;;
  *) echo "usage: $0 plan|setup|budget|deploy|verify|judging-on|judging-off" >&2; exit 2 ;;
esac
