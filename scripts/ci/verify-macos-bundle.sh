#!/usr/bin/env bash

set -euo pipefail

target="${1:-}"

if [[ -z "$target" ]]; then
  echo "Usage: bash ./scripts/ci/verify-macos-bundle.sh <target-triple>" >&2
  exit 1
fi

bundle_root="src-tauri/target/${target}/release/bundle"
if [[ ! -d "$bundle_root" ]]; then
  bundle_root="src-tauri/target/release/bundle"
fi

if [[ ! -d "$bundle_root" ]]; then
  echo "Bundle directory not found for target ${target}." >&2
  exit 1
fi

app_path="$(find "${bundle_root}" -path '*/macos/*.app' -print -quit)"
dmg_path="$(find "${bundle_root}" -path '*/dmg/*.dmg' -print -quit)"

if [[ -z "$app_path" ]]; then
  echo "No .app bundle found under ${bundle_root}." >&2
  exit 1
fi

echo "Verifying app bundle: ${app_path}"
codesign --verify --deep --strict --verbose=2 "${app_path}"
spctl -a -vv "${app_path}"

if command -v xcrun >/dev/null 2>&1; then
  if [[ -n "$dmg_path" ]]; then
    echo "Validating stapled DMG ticket: ${dmg_path}"
    xcrun stapler validate "${dmg_path}"
  else
    echo "Validating stapled app ticket: ${app_path}"
    xcrun stapler validate "${app_path}"
  fi
fi

echo "macOS bundle verification passed for ${target}."
