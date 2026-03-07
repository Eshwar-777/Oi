#!/usr/bin/env bash

set -euo pipefail

base_url="${1:-${BACKEND_BASE_URL:-}}"

if [ -z "$base_url" ]; then
  echo "Usage: bash ./scripts/smoke-backend.sh <base-url>"
  exit 1
fi

health_response="$(curl -fsS "$base_url/health")"
ready_response="$(curl -fsS "$base_url/ready")"

echo "$health_response" | rg '"status":"ok"' >/dev/null
echo "$ready_response" | rg '"status":"ok"' >/dev/null

echo "Smoke checks passed for $base_url"
