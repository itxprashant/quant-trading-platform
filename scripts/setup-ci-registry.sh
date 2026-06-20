#!/usr/bin/env bash
# One-time Azure Container Registry + VM pull access for CI deploys.
#
# Creates ACR, enables admin creds for GitHub Actions, logs the VM into the registry.
# Prints GitHub Actions variables/secrets to add (or writes .acr-github-secrets.env).
#
# Usage:
#   ./scripts/setup-ci-registry.sh
#   ACR_NAME=quantadevclub ./scripts/setup-ci-registry.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RESOURCE_GROUP="${RESOURCE_GROUP:-quanta-rg}"
LOCATION="${LOCATION:-southeastasia}"
ACR_NAME="${ACR_NAME:-quantadevclub}"
VM_NAME="${VM_NAME:-quanta-b2ms}"
ADMIN_USER="${ADMIN_USER:-azureuser}"
SSH_KEY="${HOME}/.ssh/quanta_azure"
DOMAIN="${DOMAIN:-quanta.devclub.in}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://${DOMAIN}}"
SECRETS_FILE="$ROOT/.acr-github-secrets.env"

echo "==> CI registry setup (ACR: $ACR_NAME)"

if ! az group show --name "$RESOURCE_GROUP" &>/dev/null; then
  echo "ERROR: resource group $RESOURCE_GROUP not found. Run azure-deploy.sh first." >&2
  exit 1
fi

if ! az provider show -n Microsoft.ContainerRegistry --query registrationState -o tsv 2>/dev/null | grep -qi registered; then
  echo "==> Registering Microsoft.ContainerRegistry (first time, ~1 min)..."
  az provider register --namespace Microsoft.ContainerRegistry --wait
fi

if az acr show --name "$ACR_NAME" &>/dev/null; then
  echo "==> ACR $ACR_NAME already exists"
else
  echo "==> Creating ACR $ACR_NAME in $LOCATION..."
  az acr create \
    --resource-group "$RESOURCE_GROUP" \
    --name "$ACR_NAME" \
    --sku Basic \
    --location "$LOCATION" \
    --output none
fi

LOGIN_SERVER="$(az acr show --name "$ACR_NAME" --query loginServer -o tsv)"
echo "==> Registry: $LOGIN_SERVER"

echo "==> Enabling ACR admin user (for GitHub Actions + VM docker login)..."
az acr update --name "$ACR_NAME" --admin-enabled true --output none

ACR_USERNAME="$(az acr credential show --name "$ACR_NAME" --query username -o tsv)"
ACR_PASSWORD="$(az acr credential show --name "$ACR_NAME" --query "passwords[0].value" -o tsv)"

# VM managed identity + AcrPull (for az acr login if Azure CLI is added later)
if az vm show -g "$RESOURCE_GROUP" -n "$VM_NAME" &>/dev/null; then
  echo "==> Assigning AcrPull to VM managed identity..."
  az vm identity assign -g "$RESOURCE_GROUP" -n "$VM_NAME" --output none 2>/dev/null || true
  ACR_ID="$(az acr show -n "$ACR_NAME" --query id -o tsv)"
  PRINCIPAL="$(az vm show -g "$RESOURCE_GROUP" -n "$VM_NAME" --query identity.principalId -o tsv)"
  if [[ -n "$PRINCIPAL" && "$PRINCIPAL" != "null" ]]; then
    az role assignment create \
      --assignee "$PRINCIPAL" \
      --role AcrPull \
      --scope "$ACR_ID" \
      --output none 2>/dev/null || true
  fi

  PUBLIC_IP="$(az vm list-ip-addresses -g "$RESOURCE_GROUP" -n "$VM_NAME" \
    --query "[0].virtualMachine.network.publicIpAddresses[0].ipAddress" -o tsv)"
  echo "==> Docker login on VM ($PUBLIC_IP)..."
  ssh -o StrictHostKeyChecking=no -i "$SSH_KEY" "${ADMIN_USER}@${PUBLIC_IP}" bash <<REMOTE
set -euo pipefail
echo '${ACR_PASSWORD}' | sudo docker login ${LOGIN_SERVER} -u '${ACR_USERNAME}' --password-stdin
echo "==> VM logged into ${LOGIN_SERVER}"
REMOTE
else
  echo "WARN: VM $VM_NAME not found — skip VM docker login" >&2
fi

cat > "$SECRETS_FILE" <<EOF
# Add these in GitHub: Settings → Secrets and variables → Actions
# (This file is gitignored — delete after copying to GitHub)

# --- Variables ---
ACR_LOGIN_SERVER=${LOGIN_SERVER}
NEXT_PUBLIC_API_URL=${PUBLIC_BASE_URL}
NEXT_PUBLIC_WS_URL=wss://${DOMAIN}

# --- Secrets ---
ACR_USERNAME=${ACR_USERNAME}
ACR_PASSWORD=${ACR_PASSWORD}
EOF
chmod 600 "$SECRETS_FILE"

cat <<EOF

============================================
  ACR ready: ${LOGIN_SERVER}

  GitHub Actions configuration
  -----------------------------
  Variables (Settings → Actions → Variables):
    ACR_LOGIN_SERVER = ${LOGIN_SERVER}
    NEXT_PUBLIC_API_URL = ${PUBLIC_BASE_URL}
    NEXT_PUBLIC_WS_URL = wss://${DOMAIN}

  Secrets (Settings → Actions → Secrets):
    ACR_USERNAME = ${ACR_USERNAME}
    ACR_PASSWORD = (see ${SECRETS_FILE})

  Workflow: .github/workflows/publish-images.yml
  Trigger:  push to main, or Actions → Publish Docker Images

  Deploy from registry (after CI build):
    REGISTRY=${LOGIN_SERVER} \\
    IMAGE_TAG=sha-\$(git rev-parse --short HEAD) \\
    ./scripts/registry-vm-deploy.sh

  Credentials saved to: ${SECRETS_FILE}
============================================
EOF
