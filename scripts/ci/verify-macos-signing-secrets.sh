#!/usr/bin/env bash

set -euo pipefail

missing=()

require_value() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    missing+=("$name")
  fi
}

require_value "APPLE_CERTIFICATE"
require_value "APPLE_CERTIFICATE_PASSWORD"

has_apple_id_auth=false
if [[ -n "${APPLE_ID:-}" || -n "${APPLE_PASSWORD:-}" || -n "${APPLE_TEAM_ID:-}" ]]; then
  has_apple_id_auth=true
  require_value "APPLE_ID"
  require_value "APPLE_PASSWORD"
  require_value "APPLE_TEAM_ID"
fi

has_api_key_auth=false
if [[ -n "${APPLE_API_KEY:-}" || -n "${APPLE_API_ISSUER:-}" || -n "${APPLE_API_PRIVATE_KEY:-}" || -n "${APPLE_API_KEY_PATH:-}" ]]; then
  has_api_key_auth=true
  require_value "APPLE_API_KEY"
  require_value "APPLE_API_ISSUER"
  if [[ -z "${APPLE_API_PRIVATE_KEY:-}" && -z "${APPLE_API_KEY_PATH:-}" ]]; then
    missing+=("APPLE_API_PRIVATE_KEY or APPLE_API_KEY_PATH")
  fi
fi

if [[ "${has_apple_id_auth}" == "false" && "${has_api_key_auth}" == "false" ]]; then
  missing+=("Apple notarization credentials (APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID or APPLE_API_KEY/APPLE_API_ISSUER/APPLE_API_PRIVATE_KEY)")
fi

if ((${#missing[@]} > 0)); then
  printf '::warning::Missing macOS signing/notarization secrets (build will proceed unsigned):\n' >&2
  for item in "${missing[@]}"; do
    printf '  - %s\n' "$item" >&2
  done
  printf '\n' >&2
  printf 'Unsigned macOS bundles will be blocked by Gatekeeper when downloaded from a browser.\n' >&2
  printf 'Users can install via: curl -fsSL .../install.sh | bash  or  brew install --cask hexclaw\n' >&2
fi

printf 'macOS signing/notarization secrets detected.\n'
