#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

missing=0

check_cmd() {
  local name="$1"
  if command -v "$name" >/dev/null 2>&1; then
    printf "ok   %s\n" "$name"
  else
    printf "miss %s\n" "$name"
    missing=1
  fi
}

check_file() {
  local path="$1"
  if [ -f "$path" ]; then
    printf "ok   %s\n" "$path"
  else
    printf "miss %s\n" "$path"
    missing=1
  fi
}

check_cmd node
check_cmd pnpm
check_cmd python3
check_cmd gcloud
check_cmd terraform
check_cmd make

check_file "package.json"
check_file "apps/backend/requirements.txt"
check_file "infra/terraform/main.tf"

if [ -f "apps/backend/.env" ]; then
  if rg -q "^GOOGLE_CLOUD_PROJECT=.+" "apps/backend/.env"; then
    echo "ok   apps/backend/.env project configured"
  else
    echo "warn apps/backend/.env exists but GOOGLE_CLOUD_PROJECT is empty"
    missing=1
  fi
else
  echo "warn apps/backend/.env is missing"
  missing=1
fi

if [ "$missing" -ne 0 ]; then
  echo "Environment check failed."
  exit 1
fi

echo "Environment check passed."
