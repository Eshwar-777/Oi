#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

pnpm install --frozen-lockfile
pnpm lint:all
pnpm typecheck:all
pnpm test:all
bash ./scripts/infra.sh validate
