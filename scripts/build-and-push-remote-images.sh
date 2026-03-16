#!/usr/bin/env bash

set -euo pipefail

target="${1:-all}"

case "$target" in
  all|backend|worker|runtime|frontend)
    ;;
  *)
    echo "Usage: bash ./scripts/build-and-push-remote-images.sh [all|backend|worker|runtime|frontend]"
    exit 1
    ;;
esac

project_id="${GCP_PROJECT_ID:-${GOOGLE_CLOUD_PROJECT:-}}"
region="${GCP_REGION:-us-central1}"
repository="${ARTIFACT_REGISTRY_REPO:-}"
registry="${ARTIFACT_REGISTRY:-}"
image_tag="${IMAGE_TAG:-$(date +%Y%m%d-%H%M%S)}"
backend_image_name="${BACKEND_IMAGE_NAME:-backend}"
worker_image_name="${REMOTE_WORKER_IMAGE_NAME:-remote-browser-worker}"
runtime_image_name="${AUTOMATION_RUNTIME_IMAGE_NAME:-automation-runtime}"
frontend_image_name="${FRONTEND_IMAGE_NAME:-web-frontend}"

if [ -z "$project_id" ]; then
  echo "GCP_PROJECT_ID or GOOGLE_CLOUD_PROJECT must be set."
  exit 1
fi

if [ -z "$registry" ]; then
  if [ -z "$repository" ]; then
    echo "Set ARTIFACT_REGISTRY or ARTIFACT_REGISTRY_REPO."
    exit 1
  fi
  registry="${region}-docker.pkg.dev/${project_id}/${repository}"
fi

backend_image_uri="${registry}/${backend_image_name}:${image_tag}"
worker_image_uri="${registry}/${worker_image_name}:${image_tag}"
runtime_image_uri="${registry}/${runtime_image_name}:${image_tag}"
frontend_image_uri="${registry}/${frontend_image_name}:${image_tag}"

build_worker() {
  tmp_config="$(mktemp -t oye-remote-worker-cloudbuild.XXXXXX.yaml)"
  cat >"$tmp_config" <<'YAML'
steps:
  - name: gcr.io/cloud-builders/docker
    args:
      - build
      - -f
      - apps/frontend/desktop/Dockerfile.remote-worker
      - -t
      - ${_IMAGE_URI}
      - .
images:
  - ${_IMAGE_URI}
YAML

  gcloud builds submit . \
    --project="$project_id" \
    --config="$tmp_config" \
    --substitutions="_IMAGE_URI=${worker_image_uri}"

  rm -f "$tmp_config"
}

build_backend() {
  gcloud builds submit apps/backend \
    --project="$project_id" \
    --tag "$backend_image_uri"
}

build_runtime() {
  tmp_config="$(mktemp -t oye-automation-runtime-cloudbuild.XXXXXX.yaml)"
  cat >"$tmp_config" <<'YAML'
steps:
  - name: gcr.io/cloud-builders/docker
    args:
      - build
      - -f
      - apps/automation-runtime/Dockerfile
      - -t
      - ${_IMAGE_URI}
      - .
images:
  - ${_IMAGE_URI}
YAML

  gcloud builds submit . \
    --project="$project_id" \
    --config="$tmp_config" \
    --substitutions="_IMAGE_URI=${runtime_image_uri}"

  rm -f "$tmp_config"
}

build_frontend() {
  : "${VITE_OI_API_URL:?VITE_OI_API_URL must be set for frontend builds.}"
  : "${VITE_FIREBASE_API_KEY:?VITE_FIREBASE_API_KEY must be set for frontend builds.}"
  : "${VITE_FIREBASE_AUTH_DOMAIN:?VITE_FIREBASE_AUTH_DOMAIN must be set for frontend builds.}"
  : "${VITE_FIREBASE_PROJECT_ID:?VITE_FIREBASE_PROJECT_ID must be set for frontend builds.}"
  : "${VITE_FIREBASE_APP_ID:?VITE_FIREBASE_APP_ID must be set for frontend builds.}"

  tmp_config="$(mktemp -t oye-web-frontend-cloudbuild.XXXXXX.yaml)"
  cat >"$tmp_config" <<'YAML'
steps:
  - name: gcr.io/cloud-builders/docker
    args:
      - build
      - -f
      - apps/frontend/web/Dockerfile
      - -t
      - ${_IMAGE_URI}
      - --build-arg
      - VITE_OI_API_URL=${_VITE_OI_API_URL}
      - --build-arg
      - VITE_FIREBASE_API_KEY=${_VITE_FIREBASE_API_KEY}
      - --build-arg
      - VITE_FIREBASE_AUTH_DOMAIN=${_VITE_FIREBASE_AUTH_DOMAIN}
      - --build-arg
      - VITE_FIREBASE_PROJECT_ID=${_VITE_FIREBASE_PROJECT_ID}
      - --build-arg
      - VITE_FIREBASE_STORAGE_BUCKET=${_VITE_FIREBASE_STORAGE_BUCKET}
      - --build-arg
      - VITE_FIREBASE_APP_ID=${_VITE_FIREBASE_APP_ID}
      - --build-arg
      - VITE_FIREBASE_MESSAGING_SENDER_ID=${_VITE_FIREBASE_MESSAGING_SENDER_ID}
      - --build-arg
      - VITE_FIREBASE_MEASUREMENT_ID=${_VITE_FIREBASE_MEASUREMENT_ID}
      - --build-arg
      - VITE_BYPASS_WEB_AUTH=${_VITE_BYPASS_WEB_AUTH}
      - .
images:
  - ${_IMAGE_URI}
YAML

  gcloud builds submit . \
    --project="$project_id" \
    --config="$tmp_config" \
    --substitutions="_IMAGE_URI=${frontend_image_uri},_VITE_OI_API_URL=${VITE_OI_API_URL},_VITE_FIREBASE_API_KEY=${VITE_FIREBASE_API_KEY},_VITE_FIREBASE_AUTH_DOMAIN=${VITE_FIREBASE_AUTH_DOMAIN},_VITE_FIREBASE_PROJECT_ID=${VITE_FIREBASE_PROJECT_ID},_VITE_FIREBASE_STORAGE_BUCKET=${VITE_FIREBASE_STORAGE_BUCKET:-},_VITE_FIREBASE_APP_ID=${VITE_FIREBASE_APP_ID},_VITE_FIREBASE_MESSAGING_SENDER_ID=${VITE_FIREBASE_MESSAGING_SENDER_ID:-},_VITE_FIREBASE_MEASUREMENT_ID=${VITE_FIREBASE_MEASUREMENT_ID:-},_VITE_BYPASS_WEB_AUTH=${VITE_BYPASS_WEB_AUTH:-false}"

  rm -f "$tmp_config"
}

if [ "$target" = "all" ] || [ "$target" = "worker" ]; then
  echo "Building worker image: $worker_image_uri"
  build_worker
fi

if [ "$target" = "all" ] || [ "$target" = "backend" ]; then
  echo "Building backend image: $backend_image_uri"
  build_backend
fi

if [ "$target" = "all" ] || [ "$target" = "runtime" ]; then
  echo "Building automation runtime image: $runtime_image_uri"
  build_runtime
fi

if [ "$target" = "all" ] || [ "$target" = "frontend" ]; then
  echo "Building frontend image: $frontend_image_uri"
  build_frontend
fi

echo "BACKEND_IMAGE_URI=$backend_image_uri"
echo "REMOTE_WORKER_IMAGE_URI=$worker_image_uri"
echo "AUTOMATION_RUNTIME_IMAGE_URI=$runtime_image_uri"
echo "FRONTEND_IMAGE_URI=$frontend_image_uri"
