#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud CLI is not installed. Install it first: https://cloud.google.com/sdk/docs/install"
  exit 1
fi

PROJECT_ID="$(awk -F= '/^GOOGLE_CLOUD_PROJECT=/{print $2}' .env | tr -d '[:space:]')"
if [ -z "${PROJECT_ID}" ] || [ "${PROJECT_ID}" = "your-gcp-project-id" ]; then
  echo "Set GOOGLE_CLOUD_PROJECT in .env before running ADC setup."
  exit 1
fi

echo "Using project: ${PROJECT_ID}"
gcloud config set project "${PROJECT_ID}"

echo "Starting browser login for user credentials..."
gcloud auth login

echo "Starting ADC login..."
gcloud auth application-default login

echo "Setting ADC quota project..."
gcloud auth application-default set-quota-project "${PROJECT_ID}"

echo "ADC setup complete. Restart server: make dev"
