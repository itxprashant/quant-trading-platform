#!/usr/bin/env bash
# Maps changed repo paths → docker-compose.prod.yml build services.
# shellcheck shell=bash

ALL_BUILD_SERVICES=(migrate api gateway engine scoring web)

# Rebuild every app image when these paths change.
GLOBAL_REBUILD_PATTERNS=(
  "pnpm-lock.yaml"
  "package.json"
  "pnpm-workspace.yaml"
  ".npmrc"
  "turbo.json"
  "tsconfig.base.json"
  "docker-compose.prod.yml"
  "infra/docker/Dockerfile.service"
)

# Returns 0 when path matches any global rebuild pattern.
qtp_path_is_global() {
  local path="$1" pattern
  for pattern in "${GLOBAL_REBUILD_PATTERNS[@]}"; do
    if [[ "$path" == "$pattern" || "$path" == "$pattern/"* ]]; then
      return 0
    fi
  done
  return 1
}

# Append service names (space-separated) affected by a single changed path.
qtp_services_for_path() {
  local path="$1"

  if qtp_path_is_global "$path"; then
    printf '%s\n' "${ALL_BUILD_SERVICES[@]}"
    return
  fi

  case "$path" in
    infra/docker/Dockerfile.migrate|infra/docker/Dockerfile.migrate.*)
      echo migrate
      ;;
    infra/docker/Dockerfile.web|infra/docker/Dockerfile.web.*)
      echo web
      ;;
    infra/nginx/*)
      # nginx has no image build; caller may restart separately
      ;;
    packages/shared/*|packages/shared)
      printf '%s\n' migrate api gateway engine scoring web
      ;;
    packages/db/*|packages/db)
      printf '%s\n' migrate api gateway engine scoring
      ;;
    packages/bus/*|packages/bus)
      printf '%s\n' api gateway engine scoring
      ;;
    packages/core/*|packages/core)
      printf '%s\n' api engine scoring
      ;;
    packages/config/*|packages/config)
      printf '%s\n' "${ALL_BUILD_SERVICES[@]}"
      ;;
    apps/api/*|apps/api)
      echo api
      ;;
    apps/gateway/*|apps/gateway)
      echo gateway
      ;;
    apps/engine/*|apps/engine)
      echo engine
      ;;
    apps/scoring/*|apps/scoring)
      echo scoring
      ;;
    apps/web/*|apps/web)
      echo web
      ;;
  esac
}

# Read paths from args or stdin; print unique sorted service names.
qtp_resolve_changed_services() {
  local -A seen=()
  local path svc services=()

  if [[ $# -gt 0 ]]; then
    for path in "$@"; do
      [[ -n "$path" ]] || continue
      while IFS= read -r svc; do
        [[ -n "$svc" ]] || continue
        if [[ -z "${seen[$svc]+x}" ]]; then
          seen[$svc]=1
          services+=("$svc")
        fi
      done < <(qtp_services_for_path "$path")
    done
  else
    while IFS= read -r path; do
      [[ -n "$path" ]] || continue
      while IFS= read -r svc; do
        [[ -n "$svc" ]] || continue
        if [[ -z "${seen[$svc]+x}" ]]; then
          seen[$svc]=1
          services+=("$svc")
        fi
      done < <(qtp_services_for_path "$path")
    done
  fi

  if [[ ${#services[@]} -eq 0 ]]; then
    return 0
  fi

  # Stable order matching ALL_BUILD_SERVICES
  local ordered=() s
  for s in "${ALL_BUILD_SERVICES[@]}"; do
    if [[ -n "${seen[$s]+x}" ]]; then
      ordered+=("$s")
    fi
  done
  printf '%s\n' "${ordered[@]}"
}

qtp_needs_nginx_restart() {
  local path
  for path in "$@"; do
    case "$path" in
      infra/nginx/*|docker-compose.prod.yml) return 0 ;;
    esac
  done
  return 1
}
