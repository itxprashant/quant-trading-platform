#!/usr/bin/env bash
# Local helper: detect changed services from git and build only those on the VM.
# Wraps changed-services.sh + azure-deploy sync (or VM-only build when VM=1).
#
# Usage:
#   ./scripts/deploy-changed.sh              # full azure deploy, changed services only
#   ./scripts/deploy-changed.sh --all        # rebuild every service
#   ./scripts/deploy-changed.sh --since main
#   BUILD_ONLY=1 ./scripts/deploy-changed.sh # skip rsync/provision; SSH build only

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BUILD_ALL=0
SINCE_REF=""
EXTRA_AZURE_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all) BUILD_ALL=1; shift ;;
    --since) SINCE_REF="$2"; shift 2 ;;
    *) EXTRA_AZURE_ARGS+=("$1"); shift ;;
  esac
done

if [[ "$BUILD_ALL" == "1" ]]; then
  BUILD_SERVICES=(migrate api gateway engine scoring web)
else
  if [[ -n "$SINCE_REF" ]]; then
    mapfile -t BUILD_SERVICES < <("$ROOT/scripts/changed-services.sh" --since "$SINCE_REF")
  else
    mapfile -t BUILD_SERVICES < <("$ROOT/scripts/changed-services.sh" --git)
  fi
fi

if [[ ${#BUILD_SERVICES[@]} -eq 0 ]]; then
  echo "==> No rebuild needed (no mapped file changes)."
  echo "    Use --all to force a full rebuild, or change app/package files."
  if [[ "${BUILD_ONLY:-0}" == "1" ]]; then
    exit 0
  fi
  # Still sync + up -d for config/nginx-only changes
  export BUILD_SERVICES=""
  exec "$ROOT/scripts/azure-deploy.sh" "${EXTRA_AZURE_ARGS[@]}"
fi

echo "==> Services to rebuild: ${BUILD_SERVICES[*]}"
export BUILD_SERVICES="${BUILD_SERVICES[*]}"
exec "$ROOT/scripts/azure-deploy.sh" "${EXTRA_AZURE_ARGS[@]}"
