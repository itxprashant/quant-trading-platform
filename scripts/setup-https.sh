#!/usr/bin/env bash
# Obtain Let's Encrypt certs via certbot (webroot) and enable HTTPS in nginx.
#
# Prerequisites:
#   - DNS A record: quanta.devclub.in → VM public IP
#   - Stack running with bootstrap nginx (port 80)
#   - Azure NSG allows 80 and 443
#
# Usage (on VM):
#   cd ~/quanta && ./scripts/setup-https.sh
#   CERTBOT_EMAIL=you@devclub.in ./scripts/setup-https.sh
#
# Usage (from laptop):
#   SKIP_PROVISION=1 ./scripts/setup-https.sh --remote

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DOMAIN="${DOMAIN:-quanta.devclub.in}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-.env}"
NGINX_CONF_DIR="$ROOT/infra/nginx/conf.d"
REMOTE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --remote) REMOTE=1; shift ;;
    -h|--help)
      sed -n '3,14p' "$0" | tail -n +2
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

run_remote() {
  RESOURCE_GROUP="${RESOURCE_GROUP:-quanta-rg}"
  VM_NAME="${VM_NAME:-quanta-b2ms}"
  ADMIN_USER="${ADMIN_USER:-azureuser}"
  SSH_KEY="${HOME}/.ssh/quanta_azure"
  DEPLOY_DIR="${DEPLOY_DIR:-/home/${ADMIN_USER}/quanta}"

  PUBLIC_IP="$(az vm list-ip-addresses \
    --resource-group "$RESOURCE_GROUP" \
    --name "$VM_NAME" \
    --query "[0].virtualMachine.network.publicIpAddresses[0].ipAddress" -o tsv)"

  echo "==> Opening HTTPS on Azure NSG..."
  NSG="$(az network nsg list --resource-group "$RESOURCE_GROUP" --query "[0].name" -o tsv)"
  az network nsg rule create \
    --resource-group "$RESOURCE_GROUP" \
    --nsg-name "$NSG" \
    --name AllowHTTPS \
    --priority 1002 \
    --destination-port-ranges 443 \
    --access Allow \
    --protocol Tcp \
    --output none 2>/dev/null || true

  echo "==> Syncing nginx + scripts to VM..."
  rsync -az \
    -e "ssh -o StrictHostKeyChecking=no -i ${SSH_KEY}" \
    "$ROOT/infra/nginx/" "${ADMIN_USER}@${PUBLIC_IP}:${DEPLOY_DIR}/infra/nginx/"
  rsync -az \
    -e "ssh -o StrictHostKeyChecking=no -i ${SSH_KEY}" \
    "$ROOT/scripts/setup-https.sh" \
    "$ROOT/scripts/certbot-renew.sh" \
    "$ROOT/docker-compose.prod.yml" \
    "${ADMIN_USER}@${PUBLIC_IP}:${DEPLOY_DIR}/"

  ssh -o StrictHostKeyChecking=no -i "$SSH_KEY" "${ADMIN_USER}@${PUBLIC_IP}" bash <<REMOTE
set -euo pipefail
cd ${DEPLOY_DIR}
chmod +x scripts/setup-https.sh scripts/certbot-renew.sh
DOMAIN=${DOMAIN} CERTBOT_EMAIL=${CERTBOT_EMAIL} ./scripts/setup-https.sh
REMOTE
  enable_ssl_nginx "$ROOT/infra/nginx/conf.d"
  exit 0
}

enable_ssl_nginx() {
  local conf_dir="$1"
  rm -f "$conf_dir/01-http-bootstrap.conf"
  if [[ -f "$conf_dir/01-http-production.conf.disabled" ]]; then
    mv -f "$conf_dir/01-http-production.conf.disabled" "$conf_dir/01-http-production.conf"
  fi
  if [[ -f "$conf_dir/02-https.conf.disabled" ]]; then
    mv -f "$conf_dir/02-https.conf.disabled" "$conf_dir/02-https.conf"
  fi
}

ensure_bootstrap_nginx() {
  local conf_dir="$1"
  if [[ ! -f "$conf_dir/01-http-bootstrap.conf" && ! -f "$conf_dir/01-http-production.conf" ]]; then
    echo "ERROR: missing nginx conf.d snippets in $conf_dir" >&2
    exit 1
  fi
  if [[ -f "$conf_dir/02-https.conf" ]]; then
    echo "==> HTTPS nginx config already enabled"
    return 0
  fi
  if [[ ! -f "$conf_dir/01-http-bootstrap.conf" ]]; then
    echo "==> Restoring bootstrap nginx for cert renewal..."
    rm -f "$conf_dir/01-http-production.conf"
    cp "$ROOT/infra/nginx/conf.d/01-http-bootstrap.conf" "$conf_dir/01-http-bootstrap.conf"
  fi
}

compose() {
  sudo docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

[[ "$REMOTE" == "1" ]] && run_remote

if [[ -z "$CERTBOT_EMAIL" ]]; then
  echo "Set CERTBOT_EMAIL for Let's Encrypt expiry notices." >&2
  echo "Example: CERTBOT_EMAIL=admin@devclub.in $0" >&2
  exit 1
fi

ensure_bootstrap_nginx "$NGINX_CONF_DIR"

echo "==> Ensuring nginx + certbot volumes are up..."
compose up -d nginx

if compose run --rm --entrypoint sh certbot -c "test -f /etc/letsencrypt/live/${DOMAIN}/fullchain.pem" 2>/dev/null; then
  echo "==> Certificate already exists for ${DOMAIN}"
else
  echo "==> Requesting certificate for ${DOMAIN}..."
  compose run --rm certbot certonly \
    --webroot -w /var/www/certbot \
    --email "$CERTBOT_EMAIL" \
    --agree-tos --no-eff-email \
    -d "$DOMAIN"
fi

echo "==> Enabling HTTPS nginx config..."
enable_ssl_nginx "$NGINX_CONF_DIR"
compose up -d nginx
compose exec nginx nginx -t
compose exec nginx nginx -s reload

echo "==> Installing certbot renewal cron..."
CRON_LINE="0 3 * * * cd $ROOT && ./scripts/certbot-renew.sh >> /var/log/quanta-certbot-renew.log 2>&1"
( crontab -l 2>/dev/null | grep -v certbot-renew.sh || true
  echo "$CRON_LINE"
) | crontab -

echo ""
echo "============================================"
echo "  HTTPS enabled: https://${DOMAIN}"
echo "  Renew cron:    daily 03:00 (certbot-renew.sh)"
echo "============================================"
