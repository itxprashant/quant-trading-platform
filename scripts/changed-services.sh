#!/usr/bin/env bash
# Print docker-compose service names that need rebuilding based on changed files.
#
# Usage:
#   ./scripts/changed-services.sh --all
#   ./scripts/changed-services.sh --git [BASE_REF]     # default: last deploy ref or HEAD~1
#   ./scripts/changed-services.sh --since REF
#   ./scripts/changed-services.sh path/to/file ...
#   git diff --name-only HEAD~1 | ./scripts/changed-services.sh
#
# Env:
#   DEPLOY_REF_FILE  path to last deployed git sha (default: .deploy/last-commit)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/lib/service-graph.sh
source "$ROOT/scripts/lib/service-graph.sh"

DEPLOY_REF_FILE="${DEPLOY_REF_FILE:-$ROOT/.deploy/last-commit}"
MODE="git"
BASE_REF=""
PATHS=()

usage() {
  sed -n '3,12p' "$0" | tail -n +2
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage 0 ;;
    --all)
      MODE="all"
      shift
      ;;
    --git)
      MODE="git"
      shift
      [[ $# -gt 0 && "$1" != --* ]] && { BASE_REF="$1"; shift; }
      ;;
    --since)
      MODE="since"
      BASE_REF="${2:?--since requires a git ref}"
      shift 2
      ;;
    --)
      shift
      PATHS+=("$@")
      break
      ;;
    --*) echo "Unknown option: $1" >&2; usage 1 ;;
    *) PATHS+=("$1"); shift ;;
  esac
done

if [[ "$MODE" == "all" ]]; then
  printf '%s\n' "${ALL_BUILD_SERVICES[@]}"
  exit 0
fi

collect_git_paths() {
  local ref="$1"
  if [[ -z "$ref" ]]; then
    if [[ -f "$DEPLOY_REF_FILE" ]]; then
      ref="$(tr -d '[:space:]' < "$DEPLOY_REF_FILE")"
    elif git -C "$ROOT" rev-parse HEAD~1 >/dev/null 2>&1; then
      ref="HEAD~1"
    else
      # First commit / shallow clone — rebuild everything
      printf '%s\n' "${ALL_BUILD_SERVICES[@]}"
      exit 0
    fi
  fi

  if ! git -C "$ROOT" rev-parse "$ref" >/dev/null 2>&1; then
    echo "WARN: ref '$ref' not found — rebuilding all services" >&2
    printf '%s\n' "${ALL_BUILD_SERVICES[@]}"
    exit 0
  fi

  git -C "$ROOT" diff --name-only "$ref" HEAD
}

CHANGED_PATHS=()
if [[ ${#PATHS[@]} -gt 0 ]]; then
  CHANGED_PATHS=("${PATHS[@]}")
elif [[ "$MODE" == "since" || "$MODE" == "git" ]]; then
  mapfile -t CHANGED_PATHS < <(collect_git_paths "$BASE_REF")
elif [[ ! -t 0 ]]; then
  mapfile -t CHANGED_PATHS
else
  echo "No changed paths. Pass --git, --all, file paths, or pipe git diff." >&2
  usage 1
fi

if [[ ${#CHANGED_PATHS[@]} -eq 0 ]]; then
  exit 0
fi

mapfile -t SERVICES < <(qtp_resolve_changed_services "${CHANGED_PATHS[@]}")
if [[ ${#SERVICES[@]} -eq 0 ]]; then
  exit 0
fi

printf '%s\n' "${SERVICES[@]}"
