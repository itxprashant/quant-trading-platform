#!/usr/bin/env bash
# Start, stop, or check the Quanta production Azure VM.
#
# Requires: Azure CLI logged in (az login)
#
# Usage:
#   ./scripts/vm-power.sh start      # power on (Docker stacks auto-start if configured)
#   ./scripts/vm-power.sh stop       # deallocate (stops compute billing; disks kept)
#   ./scripts/vm-power.sh status     # show power state + public IP
#   ./scripts/vm-power.sh restart    # deallocate then start
#
# Env overrides:
#   RESOURCE_GROUP=quanta-rg VM_NAME=quanta-b2ms

set -euo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-quanta-rg}"
VM_NAME="${VM_NAME:-quanta-b2ms}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://quanta.devclub.in}"

usage() {
  sed -n '4,12p' "$0" | sed 's/^# \?//'
  exit "${1:-0}"
}

require_az() {
  if ! command -v az >/dev/null 2>&1; then
    echo "error: Azure CLI (az) not found" >&2
    exit 1
  fi
  az account show >/dev/null 2>&1 || {
    echo "error: not logged in — run: az login" >&2
    exit 1
  }
}

vm_power_state() {
  az vm get-instance-view \
    --resource-group "$RESOURCE_GROUP" \
    --name "$VM_NAME" \
    --query "instanceView.statuses[?starts_with(code, 'PowerState/')].displayStatus | [0]" \
    -o tsv 2>/dev/null || echo "unknown"
}

vm_public_ip() {
  az vm list-ip-addresses \
    --resource-group "$RESOURCE_GROUP" \
    --name "$VM_NAME" \
    --query "[0].virtualMachine.network.publicIpAddresses[0].ipAddress" \
    -o tsv 2>/dev/null || true
}

cmd_status() {
  local state ip
  state="$(vm_power_state)"
  ip="$(vm_public_ip)"
  echo "VM:            $VM_NAME"
  echo "Resource group: $RESOURCE_GROUP"
  echo "Power state:   $state"
  echo "Public IP:     ${ip:-n/a}"
  echo "Site:          $PUBLIC_BASE_URL"
}

cmd_start() {
  echo "==> Starting $VM_NAME in $RESOURCE_GROUP..."
  az vm start --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" --no-wait
  echo "==> Start requested. Waiting for power state..."
  for _ in $(seq 1 60); do
    local state
    state="$(vm_power_state)"
    echo "    $state"
    case "$state" in
      *running*) break ;;
    esac
    sleep 5
  done
  cmd_status
  echo ""
  echo "Note: allow ~1–2 min after 'running' for Docker services to come up."
}

cmd_stop() {
  echo "==> Deallocating $VM_NAME (stops compute billing)..."
  az vm deallocate --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" --no-wait
  echo "==> Stop requested. Waiting for deallocated state..."
  for _ in $(seq 1 60); do
    local state
    state="$(vm_power_state)"
    echo "    $state"
    case "$state" in
      *deallocated*|*stopped*) break ;;
    esac
    sleep 5
  done
  cmd_status
}

cmd_restart() {
  cmd_stop
  echo ""
  cmd_start
}

ACTION="${1:-}"
case "$ACTION" in
  start) require_az; cmd_start ;;
  stop) require_az; cmd_stop ;;
  status) require_az; cmd_status ;;
  restart) require_az; cmd_restart ;;
  -h | --help | help) usage 0 ;;
  "")
    echo "error: missing command (start|stop|status|restart)" >&2
    usage 1
    ;;
  *)
    echo "error: unknown command '$ACTION' (use start|stop|status|restart)" >&2
    exit 1
    ;;
esac
