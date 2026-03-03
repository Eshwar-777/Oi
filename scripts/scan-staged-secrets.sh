#!/usr/bin/env bash

set -euo pipefail

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

staged_files="$(git diff --cached --name-only --diff-filter=ACM)"
if [ -z "$staged_files" ]; then
  exit 0
fi

skip_path_regex='(^|/)(node_modules|\.venv|\.git|dist|build|\.next|coverage)/'
skip_ext_regex='\.(png|jpg|jpeg|gif|webp|ico|pdf|svg|lock|jar|bin|exe|dll|so|dylib|ttf|woff|woff2)$'

patterns=(
  "AWS Access Key:::AKIA[0-9A-Z]{16}"
  "GitHub Token:::(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,})"
  "OpenAI Token:::sk-[A-Za-z0-9]{20,}"
  "Google API Key:::AIza[0-9A-Za-z_-]{35}"
  "Slack Token:::xox[baprs]-[A-Za-z0-9-]{10,}"
  "Private Key Header:::-----BEGIN (RSA|OPENSSH|EC|DSA|PRIVATE) KEY-----"
  "Credential Assignment:::(api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|password)[[:space:]]*[:=][[:space:]]*[\"'][^\"']{8,}[\"']"
)

found=0

while IFS= read -r file; do
  [ -z "$file" ] && continue

  if echo "$file" | grep -Eq "$skip_path_regex"; then
    continue
  fi
  if echo "$file" | grep -Eiq "$skip_ext_regex"; then
    continue
  fi

  staged_blob="$(git show ":$file" 2>/dev/null || true)"
  [ -z "$staged_blob" ] && continue

  for entry in "${patterns[@]}"; do
    label="${entry%%:::*}"
    regex="${entry#*:::}"

    matches="$(printf '%s\n' "$staged_blob" | grep -Ein -- "$regex" || true)"
    if [ -n "$matches" ]; then
      if [ "$found" -eq 0 ]; then
        echo "Secret scan failed: potential sensitive content detected in staged changes."
      fi
      found=1
      echo
      echo "[$label] $file"
      printf '%s\n' "$matches" | sed 's/^/  line /'
    fi
  done
done <<< "$staged_files"

if [ "$found" -eq 1 ]; then
  echo
  echo "Commit blocked. Remove/rotate secrets, or move values to env/secret manager."
  exit 1
fi

exit 0
