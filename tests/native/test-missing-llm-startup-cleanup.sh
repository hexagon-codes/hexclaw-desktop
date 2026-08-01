#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 /absolute/path/to/HexClaw-desktop-executable" >&2
  exit 64
fi

APP_EXECUTABLE="$1"
PORT="${HEXCLAW_NATIVE_SIDECAR_PORT:?HEXCLAW_NATIVE_SIDECAR_PORT is required}"
if [[ "${APP_EXECUTABLE}" != /* || ! -x "${APP_EXECUTABLE}" ]]; then
  echo "native executable must be an existing absolute Desktop executable path" >&2
  exit 64
fi
if lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "test port must be free before missing-LLM startup" >&2
  exit 1
fi

bash "$(dirname "$0")/test-missing-llm-startup.sh" "${APP_EXECUTABLE}"

if lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "missing-LLM startup returned before its dedicated sidecar port was released" >&2
  exit 1
fi

echo "REG-FIX-20260727-MISSING-LLM-STARTUP-002 isolated sidecar cleanup: PASS"
