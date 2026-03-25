#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash ./scripts/ci/set-github-macos-secrets.sh \
    --repo <owner/repo> \
    --certificate <path/to/cert.p12> \
    --certificate-password <password> \
    [--signing-identity "Developer ID Application: Example Inc. (TEAMID)"] \
    [--apple-id <email> --apple-password <app-specific-password> --apple-team-id <TEAMID>] \
    [--api-key-id <KEYID> --api-issuer <ISSUER> --api-private-key <path/to/AuthKey.p8>] \
    [--dry-run]

Examples:
  bash ./scripts/ci/set-github-macos-secrets.sh \
    --repo hexagon-codes/hexclaw-desktop \
    --certificate ~/Downloads/developer-id.p12 \
    --certificate-password '***' \
    --api-key-id ABC123XYZ9 \
    --api-issuer 11111111-2222-3333-4444-555555555555 \
    --api-private-key ~/Downloads/AuthKey_ABC123XYZ9.p8

  bash ./scripts/ci/set-github-macos-secrets.sh \
    --repo hexagon-codes/hexclaw-desktop \
    --certificate ~/Downloads/developer-id.p12 \
    --certificate-password '***' \
    --apple-id dev@example.com \
    --apple-password 'xxxx-xxxx-xxxx-xxxx' \
    --apple-team-id TEAMID1234
EOF
}

repo=""
certificate=""
certificate_password=""
signing_identity=""
apple_id=""
apple_password=""
apple_team_id=""
api_key_id=""
api_issuer=""
api_private_key=""
dry_run=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      repo="${2:-}"
      shift 2
      ;;
    --certificate)
      certificate="${2:-}"
      shift 2
      ;;
    --certificate-password)
      certificate_password="${2:-}"
      shift 2
      ;;
    --signing-identity)
      signing_identity="${2:-}"
      shift 2
      ;;
    --apple-id)
      apple_id="${2:-}"
      shift 2
      ;;
    --apple-password)
      apple_password="${2:-}"
      shift 2
      ;;
    --apple-team-id)
      apple_team_id="${2:-}"
      shift 2
      ;;
    --api-key-id)
      api_key_id="${2:-}"
      shift 2
      ;;
    --api-issuer)
      api_issuer="${2:-}"
      shift 2
      ;;
    --api-private-key)
      api_private_key="${2:-}"
      shift 2
      ;;
    --dry-run)
      dry_run=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

require_value() {
  local name="$1"
  local value="$2"
  if [[ -z "$value" ]]; then
    echo "Missing required argument: $name" >&2
    exit 1
  fi
}

require_file() {
  local name="$1"
  local path="$2"
  if [[ ! -f "$path" ]]; then
    echo "$name not found: $path" >&2
    exit 1
  fi
}

set_secret() {
  local name="$1"
  local value="$2"
  if [[ "$dry_run" == "true" ]]; then
    printf 'Would set %s (%s bytes)\n' "$name" "$(printf '%s' "$value" | wc -c | tr -d ' ')"
    return
  fi

  gh secret set -R "$repo" "$name" --body "$value" >/dev/null
  printf 'Set %s\n' "$name"
}

require_value "--repo" "$repo"
require_value "--certificate" "$certificate"
require_value "--certificate-password" "$certificate_password"
require_file "Certificate" "$certificate"

has_apple_id_auth=false
if [[ -n "$apple_id" || -n "$apple_password" || -n "$apple_team_id" ]]; then
  has_apple_id_auth=true
  require_value "--apple-id" "$apple_id"
  require_value "--apple-password" "$apple_password"
  require_value "--apple-team-id" "$apple_team_id"
fi

has_api_key_auth=false
if [[ -n "$api_key_id" || -n "$api_issuer" || -n "$api_private_key" ]]; then
  has_api_key_auth=true
  require_value "--api-key-id" "$api_key_id"
  require_value "--api-issuer" "$api_issuer"
  require_value "--api-private-key" "$api_private_key"
  require_file "API private key" "$api_private_key"
fi

if [[ "$has_apple_id_auth" == "false" && "$has_api_key_auth" == "false" ]]; then
  echo "Provide either Apple ID notarization args or App Store Connect API key args." >&2
  exit 1
fi

if [[ "$dry_run" != "true" ]] && ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI (gh) is required unless --dry-run is used." >&2
  exit 1
fi

if [[ "$dry_run" != "true" ]]; then
  gh auth status -h github.com >/dev/null
fi

certificate_b64="$(base64 < "$certificate" | tr -d '\n')"

set_secret "APPLE_CERTIFICATE" "$certificate_b64"
set_secret "APPLE_CERTIFICATE_PASSWORD" "$certificate_password"

if [[ -n "$signing_identity" ]]; then
  set_secret "APPLE_SIGNING_IDENTITY" "$signing_identity"
fi

if [[ "$has_apple_id_auth" == "true" ]]; then
  set_secret "APPLE_ID" "$apple_id"
  set_secret "APPLE_PASSWORD" "$apple_password"
  set_secret "APPLE_TEAM_ID" "$apple_team_id"
fi

if [[ "$has_api_key_auth" == "true" ]]; then
  api_private_key_value="$(cat "$api_private_key")"
  set_secret "APPLE_API_KEY" "$api_key_id"
  set_secret "APPLE_API_ISSUER" "$api_issuer"
  set_secret "APPLE_API_PRIVATE_KEY" "$api_private_key_value"
fi

printf 'macOS release secrets are ready for %s.\n' "$repo"
