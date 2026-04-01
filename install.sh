#!/usr/bin/env bash
# HexClaw Desktop — macOS one-line installer
# Usage: curl -fsSL https://raw.githubusercontent.com/hexagon-codes/hexclaw-desktop/main/install.sh | bash
#
# What this script does:
#   1. Detects your Mac's CPU architecture (Apple Silicon / Intel)
#   2. Downloads the latest .dmg from GitHub Releases
#   3. Mounts it, copies HexClaw.app to /Applications
#   4. Removes the quarantine flag so Gatekeeper won't block it
#   5. Cleans up

set -euo pipefail

REPO="hexagon-codes/hexclaw-desktop"
APP_NAME="HexClaw"
INSTALL_DIR="/Applications"

# ─── Colors ──────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

info()  { echo -e "${CYAN}${BOLD}==>${RESET} $*"; }
ok()    { echo -e "${GREEN}${BOLD}  ✓${RESET} $*"; }
warn()  { echo -e "${YELLOW}${BOLD}  !${RESET} $*"; }
fail()  { echo -e "${RED}${BOLD}  ✗ $*${RESET}"; exit 1; }

# ─── Pre-flight checks ──────────────────────────────
[[ "$(uname -s)" == "Darwin" ]] || fail "This installer only supports macOS."
command -v curl >/dev/null || fail "curl is required but not found."

# ─── Detect architecture ─────────────────────────────
ARCH="$(uname -m)"
case "$ARCH" in
  arm64)  DMG_ARCH="aarch64" ;;
  x86_64) DMG_ARCH="x64"     ;;
  *)      fail "Unsupported architecture: $ARCH" ;;
esac
info "Detected architecture: ${BOLD}${ARCH}${RESET} (${DMG_ARCH})"

# ─── Fetch latest release tag ────────────────────────
info "Fetching latest release from GitHub..."
LATEST_TAG=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
  | grep -o '"tag_name": *"[^"]*"' | head -1 | grep -o '"v[^"]*"' | tr -d '"')

if [[ -z "$LATEST_TAG" ]]; then
  # Fallback: list all releases and pick the first tag
  LATEST_TAG=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases" \
    | grep -o '"tag_name": *"[^"]*"' | head -1 | grep -o '"v[^"]*"' | tr -d '"')
fi

[[ -n "$LATEST_TAG" ]] || fail "Could not determine latest release. Check https://github.com/${REPO}/releases"

VERSION="${LATEST_TAG#v}"
ok "Latest version: ${BOLD}${VERSION}${RESET} (${LATEST_TAG})"

# ─── Download DMG ────────────────────────────────────
DMG_NAME="${APP_NAME}_${VERSION}_${DMG_ARCH}.dmg"
DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${LATEST_TAG}/${DMG_NAME}"
TMP_DIR=$(mktemp -d)
DMG_PATH="${TMP_DIR}/${DMG_NAME}"

info "Downloading ${BOLD}${DMG_NAME}${RESET}..."
HTTP_CODE=$(curl -fSL -w '%{http_code}' -o "$DMG_PATH" "$DOWNLOAD_URL" 2>/dev/null) || true

if [[ "$HTTP_CODE" != "200" ]] || [[ ! -f "$DMG_PATH" ]] || [[ ! -s "$DMG_PATH" ]]; then
  rm -rf "$TMP_DIR"
  fail "Download failed (HTTP ${HTTP_CODE}). URL: ${DOWNLOAD_URL}\nCheck https://github.com/${REPO}/releases for available assets."
fi

ok "Downloaded $(du -h "$DMG_PATH" | awk '{print $1}')"

# ─── Mount & Install ─────────────────────────────────
info "Installing ${APP_NAME}.app to ${INSTALL_DIR}..."
MOUNT_POINT=$(hdiutil attach -nobrowse -readonly "$DMG_PATH" 2>/dev/null \
  | grep '/Volumes/' | awk -F'\t' '{print $NF}')

[[ -n "$MOUNT_POINT" ]] || fail "Failed to mount DMG."

APP_SRC="${MOUNT_POINT}/${APP_NAME}.app"
[[ -d "$APP_SRC" ]] || { hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null; fail "${APP_NAME}.app not found in DMG."; }

# Remove old version if exists
if [[ -d "${INSTALL_DIR}/${APP_NAME}.app" ]]; then
  warn "Removing existing ${APP_NAME}.app..."
  rm -rf "${INSTALL_DIR}/${APP_NAME}.app"
fi

cp -R "$APP_SRC" "$INSTALL_DIR/"
ok "Copied to ${INSTALL_DIR}/${APP_NAME}.app"

# ─── Remove quarantine flag ──────────────────────────
xattr -cr "${INSTALL_DIR}/${APP_NAME}.app" 2>/dev/null || true
ok "Removed quarantine flag (Gatekeeper bypass)"

# ─── Cleanup ─────────────────────────────────────────
hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true
rm -rf "$TMP_DIR"
ok "Cleaned up temporary files"

# ─── Done ────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}  ✅ ${APP_NAME} ${VERSION} installed successfully!${RESET}"
echo ""
echo -e "  Open from Launchpad or run:  ${CYAN}open -a ${APP_NAME}${RESET}"
echo ""
