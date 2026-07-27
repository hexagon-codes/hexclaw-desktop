#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
OVERLAY="${REPO_ROOT}/src-tauri/tauri.mock.conf.json"
APP_BUNDLE="${HEX_NATIVE_APP_BUNDLE:-${REPO_ROOT}/src-tauri/target/release/bundle/macos/HexClaw Test.app}"
APP_EXECUTABLE=""
ARTIFACT_DIR="${HEX_NATIVE_ARTIFACT_DIR:-${REPO_ROOT}/test-results/native-smoke}"
EXPECTED_BUNDLE_ID="${HEX_NATIVE_EXPECTED_BUNDLE_ID:-com.hexclaw.desktop.mock}"
PORT="${HEX_NATIVE_PORT:-16061}"
COMMAND="${1:-run}"
APP_PID=""
SANDBOX=""

usage() {
  cat <<'USAGE'
Usage: tests/native/native-smoke.sh <command>

Commands:
  validate       Check the overlay and script prerequisites without launching
  build          Build the isolated macOS test .app with the test CSP overlay
  run            Launch an existing test .app and verify Sidecar isolation
  build-and-run  Build, then execute the native smoke test

The lane is macOS-only. It never starts the managed Ollama bundle and never
loads the user's ~/.hexclaw directory or provider/DingTalk credentials.

Environment:
  HEX_NATIVE_EXPECTED_BUNDLE_ID  Expected bundle identifier. Defaults to
                                 com.hexclaw.desktop.mock; production requires
                                 the explicit value com.hexclaw.desktop.
  HEX_NATIVE_PORT                Dedicated unprivileged Sidecar port. Defaults
                                 to 16061; production port 16060 is forbidden.
USAGE
}

validate_expected_bundle_id() {
  case "${EXPECTED_BUNDLE_ID}" in
    com.hexclaw.desktop.mock)
      ;;
    com.hexclaw.desktop)
      if [[ "${HEX_NATIVE_EXPECTED_BUNDLE_ID:-}" != "com.hexclaw.desktop" ]]; then
        printf 'production bundle identifier requires explicit HEX_NATIVE_EXPECTED_BUNDLE_ID=com.hexclaw.desktop\n' >&2
        return 1
      fi
      ;;
    *)
      printf 'unsupported HEX_NATIVE_EXPECTED_BUNDLE_ID: %s\n' "${EXPECTED_BUNDLE_ID}" >&2
      return 1
      ;;
  esac
}

validate_port() {
  if [[ ! "${PORT}" =~ ^[0-9]+$ ]]; then
    printf 'HEX_NATIVE_PORT must be a numeric TCP port\n' >&2
    return 1
  fi
  PORT="$((10#${PORT}))"
  if (( PORT < 1024 || PORT > 65535 )); then
    printf 'HEX_NATIVE_PORT must be an unprivileged TCP port between 1024 and 65535\n' >&2
    return 1
  fi
  if (( PORT == 16060 )); then
    printf 'HEX_NATIVE_PORT must not use the production port 16060\n' >&2
    return 1
  fi
}

validate() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    printf 'native Tauri smoke currently supports macOS only\n' >&2
    return 1
  fi
  for tool in curl lsof node plutil pnpm; do
    if ! command -v "${tool}" >/dev/null 2>&1; then
      printf 'missing required command: %s\n' "${tool}" >&2
      return 1
    fi
  done
  validate_expected_bundle_id
  validate_port
  node -e "const c=JSON.parse(require('node:fs').readFileSync(process.argv[1])); if(c.identifier!=='com.hexclaw.desktop.mock'||!c.app.security.csp.includes('localhost:16061')||c.app.security.csp.includes('localhost:11434')) process.exit(1)" "${OVERLAY}"
  bash -n "${BASH_SOURCE[0]}"
}

resolve_app_executable() {
  local executable_name bundle_identifier
  executable_name="$(plutil -extract CFBundleExecutable raw -o - "${APP_BUNDLE}/Contents/Info.plist")"
  bundle_identifier="$(plutil -extract CFBundleIdentifier raw -o - "${APP_BUNDLE}/Contents/Info.plist")"
  if [[ "${bundle_identifier}" != "${EXPECTED_BUNDLE_ID}" ]]; then
    printf 'unexpected native-smoke bundle identifier: expected %s, got %s\n' \
      "${EXPECTED_BUNDLE_ID}" "${bundle_identifier}" >&2
    return 1
  fi
  APP_EXECUTABLE="${APP_BUNDLE}/Contents/MacOS/${executable_name}"
}

build_app() {
  validate
  cd "${REPO_ROOT}"
  pnpm tauri build --config "${OVERLAY}" --bundles app
}

listener_pids() {
  lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN -t 2>/dev/null || true
}

cleanup() {
  local status=$?
  local pid command
  trap - EXIT INT TERM

  if [[ -n "${APP_PID}" ]] && kill -0 "${APP_PID}" 2>/dev/null; then
    kill -TERM "${APP_PID}" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      kill -0 "${APP_PID}" 2>/dev/null || break
      sleep 1
    done
    kill -KILL "${APP_PID}" 2>/dev/null || true
    wait "${APP_PID}" 2>/dev/null || true
  fi

  for pid in $(listener_pids); do
    command="$(ps -p "${pid}" -o command= 2>/dev/null || true)"
    if [[ "${command}" == *"/hexclaw serve --desktop"* ]]; then
      kill -TERM "${pid}" 2>/dev/null || true
    fi
  done

  if [[ -n "${SANDBOX}" && -d "${SANDBOX}" ]]; then
    if (( status != 0 )); then
      mkdir -p "${ARTIFACT_DIR}"
      cp -R "${SANDBOX}" "${ARTIFACT_DIR}/sandbox" 2>/dev/null || true
      printf 'native smoke artifacts: %s\n' "${ARTIFACT_DIR}" >&2
    fi
    rm -rf "${SANDBOX}"
  fi
  exit "${status}"
}

wait_for_health() {
  local deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    if [[ -n "${APP_PID}" ]] && ! kill -0 "${APP_PID}" 2>/dev/null; then
      printf 'HexClaw Test exited before Sidecar became healthy\n' >&2
      return 1
    fi
    if curl --fail --silent --show-error --connect-timeout 1 --max-time 2 \
      "http://localhost:${PORT}/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  printf 'Sidecar did not become healthy on localhost:%s within 60s\n' "${PORT}" >&2
  return 1
}

run_smoke() {
  validate
  if [[ ! -f "${APP_BUNDLE}/Contents/Info.plist" ]]; then
    printf 'test app bundle is missing: %s\nRun: pnpm test:e2e:native-smoke:build\n' "${APP_BUNDLE}" >&2
    return 1
  fi
  resolve_app_executable
  if [[ ! -x "${APP_EXECUTABLE}" ]]; then
    printf 'test app is missing: %s\nRun: pnpm test:e2e:native-smoke:build\n' "${APP_EXECUTABLE}" >&2
    return 1
  fi
  if [[ -n "$(listener_pids)" ]]; then
    printf 'dedicated native-smoke port %s is already occupied\n' "${PORT}" >&2
    return 1
  fi

  mkdir -p "${ARTIFACT_DIR}"
  SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/hexclaw-native-smoke.XXXXXX")"
  SANDBOX="$(cd "${SANDBOX}" && pwd -P)"
  mkdir -p "${SANDBOX}/tmp"
  trap cleanup EXIT INT TERM

  HOME="${SANDBOX}" \
  USERPROFILE="${SANDBOX}" \
  CFFIXED_USER_HOME="${SANDBOX}" \
  TMPDIR="${SANDBOX}/tmp" \
  TEMP="${SANDBOX}/tmp" \
  TMP="${SANDBOX}/tmp" \
  HEXCLAW_TEST_MODE=1 \
  HEXCLAW_TEST_HOME="${SANDBOX}" \
  HEXCLAW_SIDECAR_PORT="${PORT}" \
    "${APP_EXECUTABLE}" >"${ARTIFACT_DIR}/app.log" 2>&1 &
  APP_PID=$!

  wait_for_health
  test -f "${SANDBOX}/.hexclaw/hexclaw.yaml"
  grep -q "port: ${PORT}" "${SANDBOX}/.hexclaw/hexclaw.yaml"
  grep -q "${SANDBOX}/.hexclaw/data.db" "${SANDBOX}/.hexclaw/hexclaw.yaml"
  test -f "${SANDBOX}/.hexclaw/data.db"
  printf 'native Tauri smoke passed: app=%s sidecar=http://localhost:%s sandbox=%s\n' \
    "${APP_BUNDLE}" "${PORT}" "${SANDBOX}"
}

case "${COMMAND}" in
  validate)
    validate
    ;;
  build)
    build_app
    ;;
  run)
    run_smoke
    ;;
  build-and-run)
    build_app
    run_smoke
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    printf 'unknown command: %s\n\n' "${COMMAND}" >&2
    usage >&2
    exit 2
    ;;
esac
