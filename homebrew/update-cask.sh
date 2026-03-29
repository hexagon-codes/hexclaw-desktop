#!/usr/bin/env bash
# Update Homebrew Cask version and SHA256 checksums after a new release.
#
# Usage: ./homebrew/update-cask.sh v0.3.0
#        (downloads DMGs, computes sha256, patches hexclaw.rb)

set -euo pipefail

REPO="hexagon-codes/hexclaw-desktop"
CASK_FILE="$(dirname "$0")/hexclaw.rb"

TAG="${1:?Usage: $0 <tag>  (e.g. v0.3.0)}"
VERSION="${TAG#v}"

echo "==> Updating cask to ${VERSION} (${TAG})"

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

for ARCH in aarch64 x86_64; do
  DMG="HexClaw_${VERSION}_${ARCH}.dmg"
  URL="https://github.com/${REPO}/releases/download/${TAG}/${DMG}"
  echo "  Downloading ${DMG}..."
  curl -fSL -o "${TMP_DIR}/${DMG}" "$URL"
  SHA=$(shasum -a 256 "${TMP_DIR}/${DMG}" | awk '{print $1}')
  echo "  SHA256 (${ARCH}): ${SHA}"

  if [[ "$ARCH" == "aarch64" ]]; then
    SHA_ARM="$SHA"
  else
    SHA_INTEL="$SHA"
  fi
done

# Patch cask file
sed -i '' "s/^  version \".*\"/  version \"${VERSION}\"/" "$CASK_FILE"

# Replace ARM sha256
sed -i '' "/on_arm/,/end/{s/sha256 .*/sha256 \"${SHA_ARM}\"/;}" "$CASK_FILE"
# Replace Intel sha256
sed -i '' "/on_intel/,/end/{s/sha256 .*/sha256 \"${SHA_INTEL}\"/;}" "$CASK_FILE"

echo "==> Updated ${CASK_FILE}"
echo "    version: ${VERSION}"
echo "    arm64:   ${SHA_ARM}"
echo "    x86_64:  ${SHA_INTEL}"
