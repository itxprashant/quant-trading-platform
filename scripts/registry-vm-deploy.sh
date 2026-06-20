#!/usr/bin/env bash
# Pull tagged images from a registry and restart the stack on the Azure VM.
#
# Prerequisites on VM: az acr login (or docker login) once.
#
# Usage (from laptop, after CI published images):
#   REGISTRY=quantadevclub.azurecr.io IMAGE_TAG=sha-abc1234 ./scripts/registry-vm-deploy.sh
#   SKIP_PROVISION=1 REGISTRY=... IMAGE_TAG=... ./scripts/registry-vm-deploy.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

REGISTRY="${REGISTRY:?set REGISTRY e.g. quantadevclub.azurecr.io}"
IMAGE_TAG="${IMAGE_TAG:?set IMAGE_TAG e.g. sha from CI or git rev-parse --short HEAD}"

RESOURCE_GROUP="${RESOURCE_GROUP:-quanta-rg}"
VM_NAME="${VM_NAME:-quanta-b2ms}"
ADMIN_USER="${ADMIN_USER:-azureuser}"
DEPLOY_DIR="${DEPLOY_DIR:-/home/${ADMIN_USER}/quanta}"
SSH_KEY="${HOME}/.ssh/quanta_azure"

PUBLIC_IP="$(az vm list-ip-addresses \
  --resource-group "$RESOURCE_GROUP" \
  --name "$VM_NAME" \
  --query "[0].virtualMachine.network.publicIpAddresses[0].ipAddress" -o tsv)"

echo "==> Registry deploy to $PUBLIC_IP ($REGISTRY / $IMAGE_TAG)"

# Sync compose + nginx + env only (no source build needed)
ssh -o StrictHostKeyChecking=no -i "$SSH_KEY" "${ADMIN_USER}@${PUBLIC_IP}" "mkdir -p ${DEPLOY_DIR}"
rsync -az \
  -e "ssh -o StrictHostKeyChecking=no -i ${SSH_KEY}" \
  "$ROOT/docker-compose.prod.yml" \
  "$ROOT/docker-compose.registry.yml" \
  "${ADMIN_USER}@${PUBLIC_IP}:${DEPLOY_DIR}/"
rsync -az \
  -e "ssh -o StrictHostKeyChecking=no -i ${SSH_KEY}" \
  "$ROOT/infra/nginx/" \
  "${ADMIN_USER}@${PUBLIC_IP}:${DEPLOY_DIR}/infra/nginx/"

if [[ -f "$ROOT/.env.prod" ]]; then
  scp -o StrictHostKeyChecking=no -i "$SSH_KEY" \
    "$ROOT/.env.prod" "${ADMIN_USER}@${PUBLIC_IP}:${DEPLOY_DIR}/.env"
fi

ssh -o StrictHostKeyChecking=no -i "$SSH_KEY" "${ADMIN_USER}@${PUBLIC_IP}" bash <<REMOTE
set -euo pipefail
cd ${DEPLOY_DIR}
# sudo strips exported env — pass registry vars inline
compose() {
  sudo REGISTRY=${REGISTRY} IMAGE_TAG=${IMAGE_TAG} docker compose "\$@"
}
compose -f docker-compose.prod.yml -f docker-compose.registry.yml pull
compose -f docker-compose.prod.yml -f docker-compose.registry.yml --env-file .env up -d
sleep 6
sudo docker compose -f docker-compose.prod.yml restart nginx 2>/dev/null || true
sudo docker compose -f docker-compose.prod.yml ps
REMOTE

echo "==> Live at ${PUBLIC_BASE_URL:-https://quanta.devclub.in} (images: ${REGISTRY}/*:${IMAGE_TAG})"
