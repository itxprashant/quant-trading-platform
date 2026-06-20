#!/usr/bin/env bash
# Push ACR credentials to GitHub Actions (requires gh CLI).
#
# Usage:
#   ./scripts/setup-github-secrets.sh
#   GITHUB_REPO=itxprashant/quant-trading-platform ./scripts/setup-github-secrets.sh
#   ./scripts/setup-github-secrets.sh --create-repo   # create repo if missing

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SECRETS_FILE="$ROOT/.acr-github-secrets.env"
CREATE_REPO=0
GITHUB_REPO="${GITHUB_REPO:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --create-repo) CREATE_REPO=1; shift ;;
    -R|--repo) GITHUB_REPO="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$GITHUB_REPO" ]]; then
  if git -C "$ROOT" remote get-url origin &>/dev/null; then
    GITHUB_REPO="$(git -C "$ROOT" remote get-url origin | sed -E 's#.*github.com[:/](.+/.+?)(\.git)?$#\1#')"
  else
    GITHUB_REPO="itxprashant/quant-trading-platform"
  fi
fi

gh_repo() { gh "$@" --repo "$GITHUB_REPO"; }

if [[ ! -f "$SECRETS_FILE" ]]; then
  echo "Run ./scripts/setup-ci-registry.sh first." >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$SECRETS_FILE"

if ! command -v gh >/dev/null 2>&1; then
  cat <<EOF
Install GitHub CLI (gh) or add secrets manually.

Variables:
  ACR_LOGIN_SERVER = ${ACR_LOGIN_SERVER}
  NEXT_PUBLIC_API_URL = ${NEXT_PUBLIC_API_URL}
  NEXT_PUBLIC_WS_URL = ${NEXT_PUBLIC_WS_URL}

Secrets:
  ACR_USERNAME = ${ACR_USERNAME}
  ACR_PASSWORD = (see ${SECRETS_FILE})
EOF
  exit 1
fi

if [[ "$CREATE_REPO" == "1" ]] && ! gh repo view "$GITHUB_REPO" &>/dev/null; then
  echo "==> Creating GitHub repo $GITHUB_REPO..."
  gh repo create "$GITHUB_REPO" --private --description "Quanta quant trading competition platform"
fi

if ! gh repo view "$GITHUB_REPO" &>/dev/null; then
  echo "ERROR: GitHub repo $GITHUB_REPO not found." >&2
  echo "Create it or run: $0 --create-repo" >&2
  exit 1
fi

echo "==> Configuring GitHub Actions for $GITHUB_REPO..."
gh_repo variable set ACR_LOGIN_SERVER --body "$ACR_LOGIN_SERVER"
gh_repo variable set NEXT_PUBLIC_API_URL --body "$NEXT_PUBLIC_API_URL"
gh_repo variable set NEXT_PUBLIC_WS_URL --body "$NEXT_PUBLIC_WS_URL"
gh_repo secret set ACR_USERNAME --body "$ACR_USERNAME"
gh_repo secret set ACR_PASSWORD --body "$ACR_PASSWORD"
echo "==> Done. Push to main on $GITHUB_REPO or run Actions → Publish Docker Images."
