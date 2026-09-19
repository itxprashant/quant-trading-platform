#!/usr/bin/env bash
# Renew Let's Encrypt certs and reload nginx. Run via cron on the VM.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-.env}"

sudo docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" run --rm certbot renew \
  --webroot -w /var/www/certbot --no-random-sleep-on-renew

sudo docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec nginx nginx -s reload
