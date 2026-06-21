#!/usr/bin/env bash
# Deploy current git HEAD to production via ACR registry images.
#
# Prerequisites:
#   - GitHub Actions "Publish Docker Images" succeeded for this commit
#   - az CLI logged in, SSH key at ~/.ssh/quanta_azure
#   - .env.prod in repo root (optional; copied to VM)
#
# Usage:
#   ./scripts/deploy-head.sh              # deploy sha-$(git rev-parse --short HEAD)
#   ./scripts/deploy-head.sh --wait-ci    # wait for publish workflow, then deploy
#   IMAGE_TAG=sha-abc1234 ./scripts/deploy-head.sh   # override tag

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

REGISTRY="${REGISTRY:-quantadevclub.azurecr.io}"
WAIT_CI=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --wait-ci) WAIT_CI=1; shift ;;
    -h | --help)
      sed -n '2,14p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "Unknown option: $1 (try --help)" >&2
      exit 1
      ;;
  esac
done

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error: not inside a git repository" >&2
  exit 1
fi

SHORT_SHA="$(git rev-parse --short HEAD)"
IMAGE_TAG="${IMAGE_TAG:-sha-${SHORT_SHA}}"

echo "==> Deploy HEAD ${SHORT_SHA} (${REGISTRY} / ${IMAGE_TAG})"

if [[ "$WAIT_CI" == "1" ]]; then
  if ! command -v gh >/dev/null 2>&1; then
    echo "error: --wait-ci requires GitHub CLI (gh)" >&2
    exit 1
  fi
  echo "==> Waiting for Publish Docker Images workflow on $(git rev-parse HEAD)..."
  RUN_ID="$(gh run list --workflow=publish-images.yml --commit="$(git rev-parse HEAD)" --limit 1 --json databaseId -q '.[0].databaseId')"
  if [[ -z "$RUN_ID" || "$RUN_ID" == "null" ]]; then
    echo "error: no publish-images run found for this commit; push to main first" >&2
    exit 1
  fi
  gh run watch "$RUN_ID" --exit-status
fi

exec env REGISTRY="$REGISTRY" IMAGE_TAG="$IMAGE_TAG" "$ROOT/scripts/registry-vm-deploy.sh"
