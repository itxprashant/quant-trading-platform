#!/usr/bin/env bash
# Build selected compose services on the current machine (typically the Azure VM).
#
# Usage:
#   ./scripts/vm-compose-build.sh api web
#   BUILD_ALL=1 ./scripts/vm-compose-build.sh
#   SERVICES="$(./scripts/changed-services.sh --git)" ./scripts/vm-compose-build.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-.env}"
BUILD_ALL="${BUILD_ALL:-0}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE" >&2
  exit 1
fi

if [[ "$BUILD_ALL" == "1" || $# -eq 0 ]]; then
  set -- migrate api gateway engine scoring web
fi

SERVICES=("$@")
echo "==> Building services: ${SERVICES[*]}"

export COMPOSE_PARALLEL_LIMIT="${COMPOSE_PARALLEL_LIMIT:-1}"
for svc in "${SERVICES[@]}"; do
  echo "=== building $svc ==="
  sudo docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" build "$svc"
done

echo "==> Starting stack"
sudo docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d

sleep 8
sudo docker compose -f "$COMPOSE_FILE" restart nginx 2>/dev/null || true
sleep 2
sudo docker compose -f "$COMPOSE_FILE" ps
