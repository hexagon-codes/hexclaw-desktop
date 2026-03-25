#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash ./scripts/ci/bootstrap-macos-release.sh \
    --repo <owner/repo> \
    --certificate <path/to/cert.p12> \
    --certificate-password <password> \
    [--signing-identity "Developer ID Application: Example Inc. (TEAMID)"] \
    [--apple-id <email> --apple-password <app-specific-password> --apple-team-id <TEAMID>] \
    [--api-key-id <KEYID> --api-issuer <ISSUER> --api-private-key <path/to/AuthKey.p8>] \
    [--package-ref <git-ref>] \
    [--trigger-package] \
    [--dry-run]

Examples:
  bash ./scripts/ci/bootstrap-macos-release.sh \
    --repo hexagon-codes/hexclaw-desktop \
    --certificate ~/Downloads/developer-id-application.p12 \
    --certificate-password '***' \
    --api-key-id ABC123XYZ9 \
    --api-issuer 11111111-2222-3333-4444-555555555555 \
    --api-private-key ~/Downloads/AuthKey_ABC123XYZ9.p8 \
    --trigger-package \
    --package-ref main

  bash ./scripts/ci/bootstrap-macos-release.sh \
    --repo hexagon-codes/hexclaw-desktop \
    --certificate ~/Downloads/developer-id-application.p12 \
    --certificate-password '***' \
    --apple-id dev@example.com \
    --apple-password 'xxxx-xxxx-xxxx-xxxx' \
    --apple-team-id TEAMID1234 \
    --dry-run
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
package_ref="main"
trigger_package=false
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
    --package-ref)
      package_ref="${2:-}"
      shift 2
      ;;
    --trigger-package)
      trigger_package=true
      shift
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

if [[ -z "$repo" || -z "$certificate" || -z "$certificate_password" ]]; then
  usage >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
set_secret_script="${script_dir}/set-github-macos-secrets.sh"

cmd=(
  bash "$set_secret_script"
  --repo "$repo"
  --certificate "$certificate"
  --certificate-password "$certificate_password"
)

if [[ -n "$signing_identity" ]]; then
  cmd+=(--signing-identity "$signing_identity")
fi

if [[ -n "$apple_id" || -n "$apple_password" || -n "$apple_team_id" ]]; then
  cmd+=(--apple-id "$apple_id" --apple-password "$apple_password" --apple-team-id "$apple_team_id")
fi

if [[ -n "$api_key_id" || -n "$api_issuer" || -n "$api_private_key" ]]; then
  cmd+=(--api-key-id "$api_key_id" --api-issuer "$api_issuer" --api-private-key "$api_private_key")
fi

if [[ "$dry_run" == "true" ]]; then
  cmd+=(--dry-run)
fi

printf 'Step 1/2: writing macOS release secrets for %s\n' "$repo"
"${cmd[@]}"

if [[ "$trigger_package" == "false" ]]; then
  cat <<EOF
Step 2/2: skipped workflow trigger.

Next options:
  - Trigger a packaging test in GitHub Actions -> Package
  - Or run:
      gh workflow run package.yml -R "$repo" -f ref="$package_ref"
  - Or create and push a release tag when you are ready
EOF
  exit 0
fi

if [[ "$dry_run" == "true" ]]; then
  printf 'Step 2/2: would trigger package workflow for ref %s\n' "$package_ref"
  exit 0
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI (gh) is required to trigger the Package workflow." >&2
  exit 1
fi

gh auth status -h github.com >/dev/null

printf 'Step 2/2: triggering Package workflow for ref %s\n' "$package_ref"
gh workflow run package.yml -R "$repo" -f ref="$package_ref"
printf 'Package workflow requested for %s at ref %s.\n' "$repo" "$package_ref"
