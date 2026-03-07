#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tf_dir="$repo_root/infra/terraform"

command="${1:-}"
if [ -z "$command" ]; then
  echo "Usage: bash ./scripts/infra.sh <fmt|validate|plan|apply> [staging|prod] [terraform args...]"
  exit 1
fi
shift

environment="${1:-}"
if [ "$command" = "plan" ] || [ "$command" = "apply" ]; then
  if [ -n "$environment" ]; then
    shift
  fi
fi

run_terraform() {
  terraform -chdir="$tf_dir" "$@"
}

init_terraform() {
  run_terraform init -backend=false -input=false >/dev/null
}

case "$command" in
  fmt)
    run_terraform fmt -check -recursive
    ;;
  validate)
    init_terraform
    run_terraform validate
    ;;
  plan|apply)
    if [ -z "$environment" ]; then
      echo "Environment is required for $command."
      exit 1
    fi

    init_terraform

    tfvars_file="$tf_dir/${environment}.tfvars"
    args=(-var "environment=$environment")
    if [ -f "$tfvars_file" ]; then
      args+=(-var-file "$tfvars_file")
    fi
    if [ "$#" -gt 0 ]; then
      args+=("$@")
    fi

    if [ "$command" = "plan" ]; then
      run_terraform plan "${args[@]}"
    else
      run_terraform apply "${args[@]}"
    fi
    ;;
  *)
    echo "Unsupported command: $command"
    exit 1
    ;;
esac
