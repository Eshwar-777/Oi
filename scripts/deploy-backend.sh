#!/usr/bin/env bash

set -euo pipefail

environment="${1:-}"

if [ -z "$environment" ]; then
  echo "Usage: bash ./scripts/deploy-backend.sh <staging|prod>"
  exit 1
fi

if [ "$environment" != "staging" ] && [ "$environment" != "prod" ]; then
  echo "Environment must be staging or prod."
  exit 1
fi

region="${GCP_REGION:-us-central1}"
service_name="${CLOUD_RUN_SERVICE:-oi-backend-$environment}"
registry="${ARTIFACT_REGISTRY:?ARTIFACT_REGISTRY must be set}"
image_tag="${IMAGE_TAG:-$(git rev-parse --short HEAD)}"
image_uri="$registry/backend:$image_tag"

gcloud builds submit apps/backend --tag "$image_uri"
gcloud run deploy "$service_name" \
  --image "$image_uri" \
  --region "$region" \
  --allow-unauthenticated \
  --quiet

service_url="$(gcloud run services describe "$service_name" --region "$region" --format='value(status.url)')"
bash ./scripts/smoke-backend.sh "$service_url"

echo "Backend deployed to $service_url"
