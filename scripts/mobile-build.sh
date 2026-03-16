#!/usr/bin/env bash

set -euo pipefail

profile="${1:-}"
platform="${2:-}"

usage() {
  echo "Usage: bash ./scripts/mobile-build.sh <development|apk|production> [android|all] [extra eas args...]"
    exit 1
    }

    case "$profile" in
      development)
          default_platform="android"
              ;;
                apk)
                    default_platform="android"
                        ;;
                          production)
                              default_platform="all"
                                  ;;
                                    *)
                                        usage
                                            ;;
                                            esac

                                            if [ -z "$platform" ]; then
                                              platform="$default_platform"
                                              else
                                                shift
                                                fi

                                                shift

                                                # Keep helper diagnostics off stdout so callers can safely redirect EAS JSON output.
                                                node ./scripts/prepare-mobile-build.mjs >&2
                                                node ./scripts/check-release-env.mjs mobile >&2

                                                run_eas() {
                                                  if command -v eas >/dev/null 2>&1; then
                                                      eas "$@"
                                                        else
                                                            pnpm dlx eas-cli "$@"
                                                              fi
                                                              }

                                                              cd apps/frontend/mobile
                                                              if [ -f "./google-services.json" ]; then
                                                                export EAS_NO_VCS=1
                                                                fi
                                                                run_eas build --platform "$platform" --profile "$profile" "$@"
                                                                
