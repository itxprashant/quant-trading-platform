#!/usr/bin/env bash
# Provision a Standard_B2ms Azure VM and deploy Quanta via Docker Compose.
#
# Prerequisites: az login, ssh key at ~/.ssh/id_rsa.pub (or auto-generated)
#
# Usage:
#   ./scripts/azure-deploy.sh              # create VM if missing, then deploy
#   SKIP_PROVISION=1 ./scripts/azure-deploy.sh   # deploy only (VM must exist)
#   ./scripts/deploy-changed.sh              # rebuild only changed services (recommended)
#   BUILD_ALL=1 ./scripts/azure-deploy.sh    # force full rebuild
#   BUILD_SERVICES="api web" ./scripts/azure-deploy.sh
#   LOCATION=southeastasia ./scripts/azure-deploy.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RESOURCE_GROUP="${RESOURCE_GROUP:-quanta-rg}"
LOCATION="${LOCATION:-southeastasia}"
VM_NAME="${VM_NAME:-quanta-b2ms}"
VM_SIZE="${VM_SIZE:-Standard_B2ms}"
ADMIN_USER="${ADMIN_USER:-azureuser}"
DEPLOY_DIR="${DEPLOY_DIR:-/home/${ADMIN_USER}/quanta}"
DOMAIN="${DOMAIN:-quanta.devclub.in}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://${DOMAIN}}"

echo "==> Azure deploy: $VM_NAME ($VM_SIZE) in $LOCATION"

# --- SSH key (project-specific to avoid mismatches with existing VMs) ---
SSH_KEY="${HOME}/.ssh/quanta_azure"
SSH_PUB="${SSH_KEY}.pub"
if [[ ! -f "$SSH_PUB" ]]; then
  echo "==> Generating SSH key at $SSH_KEY"
  ssh-keygen -t ed25519 -f "$SSH_KEY" -N "" -q
fi

# --- Resource group (must match LOCATION) ---
EXISTING_LOC="$(az group show --name "$RESOURCE_GROUP" --query location -o tsv 2>/dev/null || true)"
if [[ -n "$EXISTING_LOC" && "$EXISTING_LOC" != "$LOCATION" ]]; then
  echo "ERROR: Resource group '$RESOURCE_GROUP' is in $EXISTING_LOC but LOCATION=$LOCATION." >&2
  echo "Use LOCATION=$EXISTING_LOC or a different RESOURCE_GROUP. Refusing to delete existing infra." >&2
  exit 1
fi
if ! az group show --name "$RESOURCE_GROUP" &>/dev/null; then
  if [[ "${SKIP_PROVISION:-0}" == "1" ]]; then
    echo "ERROR: SKIP_PROVISION=1 but resource group $RESOURCE_GROUP does not exist." >&2
    exit 1
  fi
  echo "==> Creating resource group $RESOURCE_GROUP in $LOCATION"
  az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none
fi

# --- VM (skip entire block when VM already exists, or when SKIP_PROVISION=1) ---
if az vm show --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" &>/dev/null; then
  echo "==> VM $VM_NAME already exists — skipping provision, deploy only"
elif [[ "${SKIP_PROVISION:-0}" == "1" ]]; then
  echo "ERROR: SKIP_PROVISION=1 but VM $VM_NAME not found in $RESOURCE_GROUP." >&2
  exit 1
else
  SIZES=("$VM_SIZE" "Standard_D2s_v3" "Standard_B2s" "Standard_B2ms")
  CREATED=false
  for SIZE in "${SIZES[@]}"; do
    echo "==> Creating VM size $SIZE (2–3 min)..."
    if az vm create \
      --resource-group "$RESOURCE_GROUP" \
      --name "$VM_NAME" \
      --image "Canonical:ubuntu-24_04-lts:server:latest" \
      --size "$SIZE" \
      --admin-username "$ADMIN_USER" \
      --ssh-key-values "$SSH_PUB" \
      --public-ip-sku Standard \
      --nsg-rule SSH \
      --custom-data "$ROOT/infra/azure/cloud-init.yaml" \
      --output none 2>/tmp/quanta-vm-create.err; then
      VM_SIZE="$SIZE"
      CREATED=true
      break
    fi
    echo "    $SIZE unavailable, trying next..."
  done
  if [[ "$CREATED" != true ]]; then
    cat /tmp/quanta-vm-create.err >&2
    echo "No VM size available in $LOCATION" >&2
    exit 1
  fi
  echo "==> VM created: $VM_SIZE"
fi

# Ensure HTTP is reachable whenever the VM exists (also covers SKIP_PROVISION deploys).
if az vm show --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" &>/dev/null; then
  NSG="$(az network nsg list --resource-group "$RESOURCE_GROUP" --query "[0].name" -o tsv)"
  az network nsg rule create \
    --resource-group "$RESOURCE_GROUP" \
    --nsg-name "$NSG" \
    --name AllowHTTP \
    --priority 1001 \
    --destination-port-ranges 80 \
    --access Allow \
    --protocol Tcp \
    --output none 2>/dev/null || true
  az network nsg rule create \
    --resource-group "$RESOURCE_GROUP" \
    --nsg-name "$NSG" \
    --name AllowHTTPS \
    --priority 1002 \
    --destination-port-ranges 443 \
    --access Allow \
    --protocol Tcp \
    --output none 2>/dev/null || true
fi

PUBLIC_IP="$(az vm list-ip-addresses \
  --resource-group "$RESOURCE_GROUP" \
  --name "$VM_NAME" \
  --query "[0].virtualMachine.network.publicIpAddresses[0].ipAddress" -o tsv)"

if [[ -z "$PUBLIC_IP" ]]; then
  echo "Could not resolve public IP for $VM_NAME" >&2
  exit 1
fi

echo "==> Public IP: $PUBLIC_IP"

# --- Wait for SSH (simple probe — cloud-init --wait can hang) ---
echo "==> Waiting for SSH..."
SSH_READY=false
for i in $(seq 1 36); do
  if ssh -o StrictHostKeyChecking=no -o ConnectTimeout=8 -o BatchMode=yes -i "$SSH_KEY" \
    "${ADMIN_USER}@${PUBLIC_IP}" "echo ok" 2>/dev/null; then
    SSH_READY=true
    break
  fi
  printf "  attempt %s/36...\n" "$i"
  sleep 10
done
if [[ "$SSH_READY" != true ]]; then
  echo "SSH timed out. Check NSG port 22 and key at $SSH_KEY" >&2
  exit 1
fi
echo "==> SSH ready, waiting for Docker..."
ssh -o StrictHostKeyChecking=no -i "$SSH_KEY" "${ADMIN_USER}@${PUBLIC_IP}" \
  "for i in \$(seq 1 30); do command -v docker >/dev/null && sudo docker info >/dev/null 2>&1 && exit 0; sleep 10; done; exit 1"

# --- Secrets ---
ENV_FILE="$ROOT/.env.prod"
if [[ ! -f "$ENV_FILE" ]]; then
  JWT_SECRET="$(openssl rand -hex 32)"
  POSTGRES_PASSWORD="$(openssl rand -hex 16)"
  cat > "$ENV_FILE" <<EOF
POSTGRES_USER=qtp
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_DB=qtp
JWT_SECRET=${JWT_SECRET}
JWT_EXPIRES_IN=86400
CORS_ORIGINS=${PUBLIC_BASE_URL}
NEXT_PUBLIC_API_URL=${PUBLIC_BASE_URL}
NEXT_PUBLIC_WS_URL=wss://${DOMAIN}
ENGINE_TICK_MS=1000
DOMAIN=${DOMAIN}
EOF
  echo "==> Wrote $ENV_FILE (keep this file safe)"
else
  echo "==> Using existing $ENV_FILE"
  sed -i "s|^CORS_ORIGINS=.*|CORS_ORIGINS=${PUBLIC_BASE_URL}|" "$ENV_FILE"
  sed -i "s|^NEXT_PUBLIC_API_URL=.*|NEXT_PUBLIC_API_URL=${PUBLIC_BASE_URL}|" "$ENV_FILE"
  sed -i "s|^NEXT_PUBLIC_WS_URL=.*|NEXT_PUBLIC_WS_URL=wss://${DOMAIN}|" "$ENV_FILE"
  grep -q '^DOMAIN=' "$ENV_FILE" && sed -i "s|^DOMAIN=.*|DOMAIN=${DOMAIN}|" "$ENV_FILE" || echo "DOMAIN=${DOMAIN}" >> "$ENV_FILE"
fi

# --- Sync project ---
echo "==> Syncing project to VM..."
ssh -o StrictHostKeyChecking=no -i "$SSH_KEY" "${ADMIN_USER}@${PUBLIC_IP}" \
  "mkdir -p ${DEPLOY_DIR}"

rsync -az --delete \
  -e "ssh -o StrictHostKeyChecking=no -i ${SSH_KEY}" \
  --exclude node_modules \
  --exclude .next \
  --exclude .turbo \
  --exclude dist \
  --exclude .git \
  --exclude .env \
  --exclude .env.prod \
  --exclude .deploy \
  "$ROOT/" "${ADMIN_USER}@${PUBLIC_IP}:${DEPLOY_DIR}/"

scp -o StrictHostKeyChecking=no -i "$SSH_KEY" \
  "$ENV_FILE" "${ADMIN_USER}@${PUBLIC_IP}:${DEPLOY_DIR}/.env"

# --- Decide which services to rebuild ---
DEPLOY_REF_FILE="$ROOT/.deploy/last-commit"
if [[ "${BUILD_ALL:-0}" == "1" ]]; then
  BUILD_SERVICES="migrate api gateway engine scoring web"
elif [[ -n "${BUILD_SERVICES:-}" ]]; then
  : # set by deploy-changed.sh or caller
elif [[ -f "$DEPLOY_REF_FILE" ]] || git rev-parse HEAD~1 >/dev/null 2>&1; then
  mapfile -t _svc_list < <("$ROOT/scripts/changed-services.sh" --git)
  BUILD_SERVICES="${_svc_list[*]:-}"
else
  BUILD_SERVICES="migrate api gateway engine scoring web"
fi

if [[ -z "${BUILD_SERVICES// /}" ]]; then
  echo "==> No service images need rebuilding (config-only or docs change)."
  REMOTE_BUILD='sudo docker compose -f docker-compose.prod.yml --env-file .env up -d
sleep 4
sudo docker compose -f docker-compose.prod.yml restart nginx 2>/dev/null || true
sleep 2
sudo docker compose -f docker-compose.prod.yml ps'
else
  echo "==> Building on VM: ${BUILD_SERVICES}"
  REMOTE_BUILD="chmod +x scripts/vm-compose-build.sh && ./scripts/vm-compose-build.sh ${BUILD_SERVICES}"
fi

# --- Build & start ---
echo "==> Deploying on VM..."
ssh -o StrictHostKeyChecking=no -i "$SSH_KEY" "${ADMIN_USER}@${PUBLIC_IP}" bash <<REMOTE
set -euo pipefail
cd ${DEPLOY_DIR}
${REMOTE_BUILD}
REMOTE

mkdir -p "$ROOT/.deploy"
if git -C "$ROOT" rev-parse HEAD >/dev/null 2>&1; then
  git -C "$ROOT" rev-parse HEAD > "$DEPLOY_REF_FILE"
  echo "==> Recorded deploy ref $(cat "$DEPLOY_REF_FILE")"
fi

echo ""
echo "============================================"
echo "  Quanta deployed on Azure B2ms"
echo "  URL:      ${PUBLIC_BASE_URL}  (http://${PUBLIC_IP})"
echo "  HTTPS:    ./scripts/setup-https.sh --remote  (after DNS points here)"
echo "  Admin:    admin / admin1234"
echo "  Traders:  trader1..8 / trader1234"
echo "  SSH:      ssh -i ${SSH_KEY} ${ADMIN_USER}@${PUBLIC_IP}"
echo "  Logs:     ssh ... 'cd ${DEPLOY_DIR} && sudo docker compose -f docker-compose.prod.yml logs -f'"
echo "  Stop VM:  az vm deallocate -g ${RESOURCE_GROUP} -n ${VM_NAME}"
echo "============================================"
