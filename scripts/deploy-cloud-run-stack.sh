#!/usr/bin/env bash

set -euo pipefail

environment="${1:-prod}"

case "$environment" in
  prod|production)
    environment="prod"
    ;;
  staging)
    ;;
  *)
    echo "Usage: bash ./scripts/deploy-cloud-run-stack.sh [prod|staging]"
    exit 1
    ;;
esac

require_env() {
  local key="$1"
  if [ -z "${!key:-}" ]; then
    echo "$key must be set."
    exit 1
  fi
}

lookup_cloud_run_env() {
  local service="$1"
  local key="$2"
  gcloud run services describe "$service" \
    --project="$project_id" \
    --region="$region" \
    --format="value(spec.template.spec.containers[0].env[?name='${key}'].value)" 2>/dev/null || true
}

project_id="${GCP_PROJECT_ID:-${GOOGLE_CLOUD_PROJECT:-}}"
region="${GCP_REGION:-us-central1}"
repository="${ARTIFACT_REGISTRY_REPO:-}"
registry="${ARTIFACT_REGISTRY:-}"
image_tag="${IMAGE_TAG:-$(date +%Y%m%d-%H%M%S)}"
backend_service="${BACKEND_SERVICE_NAME:-oi-backend-$environment}"
runtime_service="${AUTOMATION_RUNTIME_SERVICE_NAME:-oye-automation-runtime-$environment}"
frontend_service="${FRONTEND_SERVICE_NAME:-oye-web-$environment}"
backend_service_account="${BACKEND_SERVICE_ACCOUNT:-oi-backend-$environment@${project_id}.iam.gserviceaccount.com}"
worker_service_account="${REMOTE_WORKER_SERVICE_ACCOUNT:-oi-remote-browser-$environment@${project_id}.iam.gserviceaccount.com}"
frontend_service_account="${FRONTEND_SERVICE_ACCOUNT:-oi-frontend-$environment@${project_id}.iam.gserviceaccount.com}"
frontend_origin="${FRONTEND_ORIGIN:-}"
runner_shared_secret="${RUNNER_SHARED_SECRET:-}"
runtime_shared_secret="${AUTOMATION_RUNTIME_SHARED_SECRET:-}"

require_env project_id
require_env VITE_FIREBASE_API_KEY
require_env VITE_FIREBASE_AUTH_DOMAIN
require_env VITE_FIREBASE_PROJECT_ID
require_env VITE_FIREBASE_APP_ID

if [ -z "$runner_shared_secret" ]; then
  runner_shared_secret="$(lookup_cloud_run_env "$backend_service" "RUNNER_SHARED_SECRET")"
fi

if [ -z "$runtime_shared_secret" ]; then
  runtime_shared_secret="$(lookup_cloud_run_env "$runtime_service" "AUTOMATION_RUNTIME_SHARED_SECRET")"
fi

if [ -z "$runtime_shared_secret" ]; then
  runtime_shared_secret="$(lookup_cloud_run_env "$backend_service" "AUTOMATION_RUNTIME_SHARED_SECRET")"
fi

require_env runner_shared_secret
require_env runtime_shared_secret

if [ -z "$registry" ]; then
  if [ -z "$repository" ]; then
    echo "Set ARTIFACT_REGISTRY or ARTIFACT_REGISTRY_REPO."
    exit 1
  fi
  registry="${region}-docker.pkg.dev/${project_id}/${repository}"
fi

backend_image_uri="${registry}/${BACKEND_IMAGE_NAME:-backend}:${image_tag}"
worker_image_uri="${registry}/${REMOTE_WORKER_IMAGE_NAME:-remote-browser-worker}:${image_tag}"
runtime_image_uri="${registry}/${AUTOMATION_RUNTIME_IMAGE_NAME:-automation-runtime}:${image_tag}"
frontend_image_uri="${registry}/${FRONTEND_IMAGE_NAME:-web-frontend}:${image_tag}"

ensure_service_account() {
  local email="$1"
  local account_id="${email%@*}"
  account_id="${account_id##*/}"
  local short_id="${account_id%@${project_id}}"
  short_id="${short_id%-}"
  gcloud iam service-accounts describe "$email" --project="$project_id" >/dev/null 2>&1 || \
    gcloud iam service-accounts create "$short_id" --project="$project_id" --display-name="$short_id"
}

grant_project_role() {
  local member="$1"
  local role="$2"
  gcloud projects add-iam-policy-binding "$project_id" \
    --member="$member" \
    --role="$role" \
    --quiet >/dev/null
}

gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  iam.googleapis.com \
  firestore.googleapis.com \
  pubsub.googleapis.com \
  aiplatform.googleapis.com \
  firebase.googleapis.com \
  --project="$project_id" >/dev/null

gcloud artifacts repositories describe "${repository:-${registry##*/}}" \
  --location="$region" \
  --project="$project_id" >/dev/null 2>&1 || \
  gcloud artifacts repositories create "${repository:-${registry##*/}}" \
    --repository-format=docker \
    --location="$region" \
    --project="$project_id" \
    --description="Oye ${environment} images" >/dev/null

ensure_service_account "$backend_service_account"
ensure_service_account "$worker_service_account"
ensure_service_account "$frontend_service_account"

for role in \
  roles/datastore.user \
  roles/pubsub.editor \
  roles/storage.objectAdmin \
  roles/secretmanager.secretAccessor \
  roles/aiplatform.user \
  roles/firebase.admin \
  roles/logging.logWriter \
  roles/run.admin
do
  grant_project_role "serviceAccount:$backend_service_account" "$role"
done

grant_project_role "serviceAccount:$worker_service_account" "roles/logging.logWriter"
grant_project_role "serviceAccount:$frontend_service_account" "roles/logging.logWriter"

gcloud iam service-accounts add-iam-policy-binding "$worker_service_account" \
  --member="serviceAccount:$backend_service_account" \
  --role="roles/iam.serviceAccountUser" \
  --project="$project_id" \
  --quiet >/dev/null

GCP_PROJECT_ID="$project_id" \
GCP_REGION="$region" \
ARTIFACT_REGISTRY="$registry" \
IMAGE_TAG="$image_tag" \
bash ./scripts/build-and-push-remote-images.sh worker

GCP_PROJECT_ID="$project_id" \
GCP_REGION="$region" \
ARTIFACT_REGISTRY="$registry" \
IMAGE_TAG="$image_tag" \
bash ./scripts/build-and-push-remote-images.sh backend

GCP_PROJECT_ID="$project_id" \
GCP_REGION="$region" \
ARTIFACT_REGISTRY="$registry" \
IMAGE_TAG="$image_tag" \
bash ./scripts/build-and-push-remote-images.sh runtime

runtime_env_file="$(mktemp -t oye-runtime-env.XXXXXX.yaml)"
backend_env_file="$(mktemp -t oye-backend-env.XXXXXX.yaml)"
trap 'rm -f "$runtime_env_file" "$backend_env_file"' EXIT

cat >"$runtime_env_file" <<EOF
ENV: ${environment}
AUTOMATION_RUNTIME_HOST: 0.0.0.0
AUTOMATION_RUNTIME_PORT: "8787"
AUTOMATION_RUNTIME_SHARED_SECRET: ${runtime_shared_secret}
AUTOMATION_RUNTIME_GCP_PROJECT: ${project_id}
AUTOMATION_RUNTIME_GCP_LOCATION: ${region}
AUTOMATION_RUNTIME_GOOGLE_GENAI_USE_VERTEXAI: "true"
GEMINI_MODEL: ${GEMINI_MODEL:-gemini-2.5-flash}
GOOGLE_CLOUD_PROJECT: ${project_id}
GOOGLE_CLOUD_LOCATION: ${region}
GOOGLE_GENAI_USE_VERTEXAI: "true"
EOF

gcloud run deploy "$runtime_service" \
  --project="$project_id" \
  --region="$region" \
  --image="$runtime_image_uri" \
  --service-account="$backend_service_account" \
  --allow-unauthenticated \
  --port=8787 \
  --memory="${AUTOMATION_RUNTIME_MEMORY:-2Gi}" \
  --cpu="${AUTOMATION_RUNTIME_CPU:-1}" \
  --min-instances="${AUTOMATION_RUNTIME_MIN_INSTANCES:-0}" \
  --max-instances="${AUTOMATION_RUNTIME_MAX_INSTANCES:-3}" \
  --env-vars-file="$runtime_env_file" \
  --quiet >/dev/null

runtime_url="$(gcloud run services describe "$runtime_service" --project="$project_id" --region="$region" --format='value(status.url)')"

cat >"$backend_env_file" <<EOF
ENV: ${environment}
APP_PORT: "8080"
APP_HOST: 0.0.0.0
LOG_FORMAT: json
GOOGLE_CLOUD_PROJECT: ${project_id}
GOOGLE_CLOUD_LOCATION: ${region}
GOOGLE_GENAI_USE_VERTEXAI: "true"
FIREBASE_PROJECT_ID: ${FIREBASE_PROJECT_ID:-$project_id}
ALLOWED_ORIGINS: ${frontend_origin:-https://placeholder.invalid}
RUNNER_SHARED_SECRET: ${runner_shared_secret}
AUTOMATION_RUNTIME_ENABLED: "true"
AUTOMATION_RUNTIME_BASE_URL: ${runtime_url}
AUTOMATION_RUNTIME_SHARED_SECRET: ${runtime_shared_secret}
SERVER_RUNNER_ENABLED: "true"
SERVER_RUNNER_BACKEND: cloud_run
SERVER_RUNNER_API_BASE_URL: https://placeholder.invalid
SERVER_RUNNER_BOOTSTRAP_URL: ${SERVER_RUNNER_BOOTSTRAP_URL:-https://example.com}
SERVER_RUNNER_CLOUD_RUN_SERVICE_PREFIX: ${SERVER_RUNNER_CLOUD_RUN_SERVICE_PREFIX:-oi-remote-session}
SERVER_RUNNER_CLOUD_RUN_WORKER_IMAGE: ${worker_image_uri}
SERVER_RUNNER_CLOUD_RUN_SERVICE_ACCOUNT: ${worker_service_account}
SERVER_RUNNER_CLOUD_RUN_CPU: "${SERVER_RUNNER_CLOUD_RUN_CPU:-1}"
SERVER_RUNNER_CLOUD_RUN_MEMORY: "${SERVER_RUNNER_CLOUD_RUN_MEMORY:-2Gi}"
SERVER_RUNNER_CLOUD_RUN_TIMEOUT_SECONDS: "${SERVER_RUNNER_CLOUD_RUN_TIMEOUT_SECONDS:-3600}"
SERVER_RUNNER_CLOUD_RUN_MIN_INSTANCES: "${SERVER_RUNNER_CLOUD_RUN_MIN_INSTANCES:-1}"
SERVER_RUNNER_CLOUD_RUN_MAX_INSTANCES: "${SERVER_RUNNER_CLOUD_RUN_MAX_INSTANCES:-1}"
SERVER_RUNNER_CLOUD_RUN_INGRESS: "${SERVER_RUNNER_CLOUD_RUN_INGRESS:-internal}"
EOF

gcloud run deploy "$backend_service" \
  --project="$project_id" \
  --region="$region" \
  --image="$backend_image_uri" \
  --service-account="$backend_service_account" \
  --allow-unauthenticated \
  --memory="${BACKEND_MEMORY:-2Gi}" \
  --cpu="${BACKEND_CPU:-2}" \
  --min-instances="${BACKEND_MIN_INSTANCES:-0}" \
  --max-instances="${BACKEND_MAX_INSTANCES:-5}" \
  --env-vars-file="$backend_env_file" \
  --quiet >/dev/null

backend_url="$(gcloud run services describe "$backend_service" --project="$project_id" --region="$region" --format='value(status.url)')"

cat >"$backend_env_file" <<EOF
ENV: ${environment}
APP_PORT: "8080"
APP_HOST: 0.0.0.0
LOG_FORMAT: json
GOOGLE_CLOUD_PROJECT: ${project_id}
GOOGLE_CLOUD_LOCATION: ${region}
GOOGLE_GENAI_USE_VERTEXAI: "true"
FIREBASE_PROJECT_ID: ${FIREBASE_PROJECT_ID:-$project_id}
ALLOWED_ORIGINS: ${frontend_origin}
RUNNER_SHARED_SECRET: ${runner_shared_secret}
AUTOMATION_RUNTIME_ENABLED: "true"
AUTOMATION_RUNTIME_BASE_URL: ${runtime_url}
AUTOMATION_RUNTIME_SHARED_SECRET: ${runtime_shared_secret}
SERVER_RUNNER_ENABLED: "true"
SERVER_RUNNER_BACKEND: cloud_run
SERVER_RUNNER_API_BASE_URL: ${backend_url}
SERVER_RUNNER_BOOTSTRAP_URL: ${SERVER_RUNNER_BOOTSTRAP_URL:-https://example.com}
SERVER_RUNNER_CLOUD_RUN_SERVICE_PREFIX: ${SERVER_RUNNER_CLOUD_RUN_SERVICE_PREFIX:-oi-remote-session}
SERVER_RUNNER_CLOUD_RUN_WORKER_IMAGE: ${worker_image_uri}
SERVER_RUNNER_CLOUD_RUN_SERVICE_ACCOUNT: ${worker_service_account}
SERVER_RUNNER_CLOUD_RUN_CPU: "${SERVER_RUNNER_CLOUD_RUN_CPU:-1}"
SERVER_RUNNER_CLOUD_RUN_MEMORY: "${SERVER_RUNNER_CLOUD_RUN_MEMORY:-2Gi}"
SERVER_RUNNER_CLOUD_RUN_TIMEOUT_SECONDS: "${SERVER_RUNNER_CLOUD_RUN_TIMEOUT_SECONDS:-3600}"
SERVER_RUNNER_CLOUD_RUN_MIN_INSTANCES: "${SERVER_RUNNER_CLOUD_RUN_MIN_INSTANCES:-1}"
SERVER_RUNNER_CLOUD_RUN_MAX_INSTANCES: "${SERVER_RUNNER_CLOUD_RUN_MAX_INSTANCES:-1}"
SERVER_RUNNER_CLOUD_RUN_INGRESS: "${SERVER_RUNNER_CLOUD_RUN_INGRESS:-internal}"
EOF

gcloud run services update "$backend_service" \
  --project="$project_id" \
  --region="$region" \
  --env-vars-file="$backend_env_file" \
  --quiet >/dev/null

GCP_PROJECT_ID="$project_id" \
GCP_REGION="$region" \
ARTIFACT_REGISTRY="$registry" \
IMAGE_TAG="$image_tag" \
VITE_OI_API_URL="${VITE_OI_API_URL:-$backend_url}" \
VITE_FIREBASE_API_KEY="$VITE_FIREBASE_API_KEY" \
VITE_FIREBASE_AUTH_DOMAIN="$VITE_FIREBASE_AUTH_DOMAIN" \
VITE_FIREBASE_PROJECT_ID="$VITE_FIREBASE_PROJECT_ID" \
VITE_FIREBASE_STORAGE_BUCKET="${VITE_FIREBASE_STORAGE_BUCKET:-}" \
VITE_FIREBASE_APP_ID="$VITE_FIREBASE_APP_ID" \
VITE_FIREBASE_MESSAGING_SENDER_ID="${VITE_FIREBASE_MESSAGING_SENDER_ID:-}" \
VITE_FIREBASE_MEASUREMENT_ID="${VITE_FIREBASE_MEASUREMENT_ID:-}" \
VITE_BYPASS_WEB_AUTH="${VITE_BYPASS_WEB_AUTH:-false}" \
bash ./scripts/build-and-push-remote-images.sh frontend

gcloud run deploy "$frontend_service" \
  --project="$project_id" \
  --region="$region" \
  --image="$frontend_image_uri" \
  --service-account="$frontend_service_account" \
  --allow-unauthenticated \
  --port=8080 \
  --memory="${FRONTEND_MEMORY:-512Mi}" \
  --cpu="${FRONTEND_CPU:-1}" \
  --min-instances="${FRONTEND_MIN_INSTANCES:-0}" \
  --max-instances="${FRONTEND_MAX_INSTANCES:-3}" \
  --quiet >/dev/null

frontend_url="$(gcloud run services describe "$frontend_service" --project="$project_id" --region="$region" --format='value(status.url)')"

cat >"$backend_env_file" <<EOF
ENV: ${environment}
APP_PORT: "8080"
APP_HOST: 0.0.0.0
LOG_FORMAT: json
GOOGLE_CLOUD_PROJECT: ${project_id}
GOOGLE_CLOUD_LOCATION: ${region}
GOOGLE_GENAI_USE_VERTEXAI: "true"
FIREBASE_PROJECT_ID: ${FIREBASE_PROJECT_ID:-$project_id}
ALLOWED_ORIGINS: ${frontend_origin:+${frontend_origin},}${frontend_url}
RUNNER_SHARED_SECRET: ${runner_shared_secret}
AUTOMATION_RUNTIME_ENABLED: "true"
AUTOMATION_RUNTIME_BASE_URL: ${runtime_url}
AUTOMATION_RUNTIME_SHARED_SECRET: ${runtime_shared_secret}
SERVER_RUNNER_ENABLED: "true"
SERVER_RUNNER_BACKEND: cloud_run
SERVER_RUNNER_API_BASE_URL: ${backend_url}
SERVER_RUNNER_BOOTSTRAP_URL: ${SERVER_RUNNER_BOOTSTRAP_URL:-https://example.com}
SERVER_RUNNER_CLOUD_RUN_SERVICE_PREFIX: ${SERVER_RUNNER_CLOUD_RUN_SERVICE_PREFIX:-oi-remote-session}
SERVER_RUNNER_CLOUD_RUN_WORKER_IMAGE: ${worker_image_uri}
SERVER_RUNNER_CLOUD_RUN_SERVICE_ACCOUNT: ${worker_service_account}
SERVER_RUNNER_CLOUD_RUN_CPU: "${SERVER_RUNNER_CLOUD_RUN_CPU:-1}"
SERVER_RUNNER_CLOUD_RUN_MEMORY: "${SERVER_RUNNER_CLOUD_RUN_MEMORY:-2Gi}"
SERVER_RUNNER_CLOUD_RUN_TIMEOUT_SECONDS: "${SERVER_RUNNER_CLOUD_RUN_TIMEOUT_SECONDS:-3600}"
SERVER_RUNNER_CLOUD_RUN_MIN_INSTANCES: "${SERVER_RUNNER_CLOUD_RUN_MIN_INSTANCES:-1}"
SERVER_RUNNER_CLOUD_RUN_MAX_INSTANCES: "${SERVER_RUNNER_CLOUD_RUN_MAX_INSTANCES:-1}"
SERVER_RUNNER_CLOUD_RUN_INGRESS: "${SERVER_RUNNER_CLOUD_RUN_INGRESS:-internal}"
EOF

gcloud run services update "$backend_service" \
  --project="$project_id" \
  --region="$region" \
  --env-vars-file="$backend_env_file" \
  --quiet >/dev/null

bash ./scripts/smoke-backend.sh "$backend_url"

curl -fsS "$runtime_url/health" >/dev/null
curl -fsS "$runtime_url/ready" >/dev/null
curl -fsS "$frontend_url" >/dev/null

echo "BACKEND_URL=$backend_url"
echo "AUTOMATION_RUNTIME_URL=$runtime_url"
echo "FRONTEND_URL=$frontend_url"
echo "BACKEND_IMAGE_URI=$backend_image_uri"
echo "REMOTE_WORKER_IMAGE_URI=$worker_image_uri"
echo "AUTOMATION_RUNTIME_IMAGE_URI=$runtime_image_uri"
echo "FRONTEND_IMAGE_URI=$frontend_image_uri"
