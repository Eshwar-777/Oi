#!/usr/bin/env bash

set -euo pipefail

repo="${GITHUB_REPO:-Eshwar-777/Oi}"
environment="${GITHUB_ENVIRONMENT:-production}"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "Missing required environment variable: $name" >&2
    exit 1
  fi
}

set_env_var() {
  local name="$1"
  local value="$2"
  printf '%s' "$value" | gh variable set "$name" --repo "$repo" --env "$environment" --body -
}

set_repo_secret() {
  local name="$1"
  local value="$2"
  printf '%s' "$value" | gh secret set "$name" --repo "$repo" --body -
}

set_env_secret() {
  local name="$1"
  local value="$2"
  printf '%s' "$value" | gh secret set "$name" --repo "$repo" --env "$environment" --body -
}

require_cmd gh
gh auth status >/dev/null

require_env ARTIFACT_REGISTRY
require_env GCP_WORKLOAD_IDENTITY_PROVIDER
require_env GCP_SERVICE_ACCOUNT
require_env VITE_OI_API_URL
require_env VITE_FIREBASE_API_KEY
require_env VITE_FIREBASE_AUTH_DOMAIN
require_env VITE_FIREBASE_PROJECT_ID
require_env VITE_FIREBASE_STORAGE_BUCKET
require_env VITE_FIREBASE_APP_ID
require_env VITE_FIREBASE_MESSAGING_SENDER_ID
require_env VITE_FIREBASE_MEASUREMENT_ID
require_env EXPO_PUBLIC_API_URL
require_env EXPO_PUBLIC_API_PORT
require_env EXPO_TOKEN

set_repo_secret ARTIFACT_REGISTRY "$ARTIFACT_REGISTRY"
set_repo_secret GCP_WORKLOAD_IDENTITY_PROVIDER "$GCP_WORKLOAD_IDENTITY_PROVIDER"
set_repo_secret GCP_SERVICE_ACCOUNT "$GCP_SERVICE_ACCOUNT"

if [ -n "${FIREBASE_SERVICE_ACCOUNT:-}" ]; then
  set_repo_secret FIREBASE_SERVICE_ACCOUNT "$FIREBASE_SERVICE_ACCOUNT"
fi

set_env_var VITE_OI_API_URL "$VITE_OI_API_URL"
set_env_var VITE_FIREBASE_AUTH_DOMAIN "$VITE_FIREBASE_AUTH_DOMAIN"
set_env_var VITE_FIREBASE_PROJECT_ID "$VITE_FIREBASE_PROJECT_ID"
set_env_var VITE_FIREBASE_STORAGE_BUCKET "$VITE_FIREBASE_STORAGE_BUCKET"
set_env_var VITE_FIREBASE_MESSAGING_SENDER_ID "$VITE_FIREBASE_MESSAGING_SENDER_ID"
set_env_var VITE_FIREBASE_MEASUREMENT_ID "$VITE_FIREBASE_MEASUREMENT_ID"
set_env_var EXPO_PUBLIC_API_URL "$EXPO_PUBLIC_API_URL"
set_env_var EXPO_PUBLIC_API_PORT "$EXPO_PUBLIC_API_PORT"

set_env_secret VITE_FIREBASE_API_KEY "$VITE_FIREBASE_API_KEY"
set_env_secret VITE_FIREBASE_APP_ID "$VITE_FIREBASE_APP_ID"
set_env_secret EXPO_TOKEN "$EXPO_TOKEN"

if [ -n "${VITE_DESKTOP_DOWNLOAD_URL:-}" ]; then
  set_env_var VITE_DESKTOP_DOWNLOAD_URL "$VITE_DESKTOP_DOWNLOAD_URL"
fi

if [ -n "${VITE_EXTENSION_DOWNLOAD_URL:-}" ]; then
  set_env_var VITE_EXTENSION_DOWNLOAD_URL "$VITE_EXTENSION_DOWNLOAD_URL"
fi

if [ -n "${VITE_IOS_DOWNLOAD_URL:-}" ]; then
  set_env_var VITE_IOS_DOWNLOAD_URL "$VITE_IOS_DOWNLOAD_URL"
fi

if [ -n "${VITE_ANDROID_DOWNLOAD_URL:-}" ]; then
  set_env_var VITE_ANDROID_DOWNLOAD_URL "$VITE_ANDROID_DOWNLOAD_URL"
fi

echo "GitHub repo secrets and ${environment} environment values updated for ${repo}."
