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
LOCKED_APP_16060_FIXTURE="${HEX_NATIVE_LOCKED_APP_16060_FIXTURE:-0}"
PROVIDER_FIXTURE="${HEX_NATIVE_PROVIDER_FIXTURE:-0}"
UI_HOLD_RELEASE_FILE="${HEX_NATIVE_UI_HOLD_RELEASE_FILE:-}"
TEST_LLM_CONFIG_MODE=""
CHILD_PID_FILE="${HEX_NATIVE_CHILD_PID_FILE:-}"
CHILD_EXIT_STATUS_FILE="${HEX_NATIVE_CHILD_EXIT_STATUS_FILE:-}"

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
  HEX_NATIVE_LOCKED_APP_16060_FIXTURE=1
                                 Permit port 16060 only for an isolated mock
                                 Test.app fixture.
  HEX_NATIVE_PROVIDER_FIXTURE=1 Preseed an isolated Provider config fixture.
  HEX_NATIVE_UI_HOLD_RELEASE_FILE
                                 Hold after health until this file exists.
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
  if (( PORT == 16060 )) && [[ "${LOCKED_APP_16060_FIXTURE}" != "1" ]]; then
    printf 'HEX_NATIVE_PORT must not use the production port 16060\n' >&2
    return 1
  fi
  if (( PORT == 16060 )) && [[ "${EXPECTED_BUNDLE_ID}" != "com.hexclaw.desktop.mock" ]]; then
    printf 'port 16060 fixture requires com.hexclaw.desktop.mock\n' >&2
    return 1
  fi
  if [[ "${PROVIDER_FIXTURE}" == "1" && "${LOCKED_APP_16060_FIXTURE}" != "1" ]]; then
    printf 'provider fixture requires HEX_NATIVE_LOCKED_APP_16060_FIXTURE=1\n' >&2
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
  if (( PORT != 16060 )); then
    node -e "const c=JSON.parse(require('node:fs').readFileSync(process.argv[1])); if(c.identifier!=='com.hexclaw.desktop.mock'||!c.app.security.csp.includes('localhost:16061')||c.app.security.csp.includes('localhost:11434')) process.exit(1)" "${OVERLAY}"
  fi
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
  local pid command app_exit_status="not-started"
  trap - EXIT INT TERM

  if [[ -n "${APP_PID}" ]]; then
    if kill -0 "${APP_PID}" 2>/dev/null; then
      kill -TERM "${APP_PID}" 2>/dev/null || true
      for _ in 1 2 3 4 5; do
        kill -0 "${APP_PID}" 2>/dev/null || break
        sleep 1
      done
      kill -KILL "${APP_PID}" 2>/dev/null || true
    fi
    if wait "${APP_PID}" 2>/dev/null; then
      app_exit_status=0
    else
      app_exit_status=$?
    fi
  fi

  if [[ -n "${CHILD_EXIT_STATUS_FILE}" ]]; then
    printf 'pid=%s\nexit_status=%s\n' "${APP_PID}" "${app_exit_status}" > "${CHILD_EXIT_STATUS_FILE}"
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

assert_protected_sidecar_requires_capability() {
  local status
  status="$(curl --silent --show-error --connect-timeout 1 --max-time 2 \
    --output /dev/null --write-out '%{http_code}' \
    "http://localhost:${PORT}/api/v1/knowledge/operations?corpus_id=default")"
  if [[ "${status}" != "401" ]]; then
    printf 'anonymous protected Sidecar request returned %s, want 401\n' "${status}" >&2
    return 1
  fi
}

write_provider_fixture_config() {
  if [[ "${PROVIDER_FIXTURE}" != "1" ]]; then
    return
  fi
  TEST_LLM_CONFIG_MODE="preseeded-owner-yaml"
  mkdir -p "${SANDBOX}/.hexclaw"
  chmod 700 "${SANDBOX}/.hexclaw"
  cat > "${SANDBOX}/.hexclaw/hexclaw.yaml" <<EOF
server:
  host: 127.0.0.1
  port: ${PORT}
  mode: development
platforms:
  web:
    enabled: true
llm:
  default: fixture
  providers:
    openai:
      provider_instance_id: pvd_v1_00000000000000000000000000000006
      display_name: OpenAI Fixture
      type: openai
      api_key: local-fixture-only
      base_url: http://127.0.0.1:${PORT}/v1
      model: fixture-openai-model
      models:
        - fixture-openai-model
      model_specs_mode: explicit
      model_specs:
        - id: fixture-openai-model
          display_name: Fixture OpenAI Model
          capabilities:
            - text
      compatible: openai
      locality: cloud
      tools_enabled: false
      enabled: true
    fixture:
      provider_instance_id: pvd_v1_00000000000000000000000000000004
      display_name: Fixture Provider
      api_key: local-fixture-only
      base_url: http://127.0.0.1:${PORT}/v1
      model: fixture-model
      models:
        - fixture-model
      model_specs_mode: explicit
      model_specs:
        - id: fixture-model
          display_name: Fixture Model
          capabilities:
            - text
      compatible: openai
      locality: cloud
      tools_enabled: false
      enabled: true
    fixture-local-embedding:
      provider_instance_id: pvd_v1_00000000000000000000000000000005
      display_name: Fixture Local Embedding
      api_key: local-fixture-only
      base_url: http://127.0.0.1:${PORT}/v1
      model: fixture-embedding
      models:
        - fixture-embedding
      model_specs_mode: explicit
      model_specs:
        - id: fixture-embedding
          display_name: Fixture Embedding
          capabilities:
            - text
            - embedding
          embedding:
            protocol: openai_embeddings
            dimension: 3
            normalization: l2
      compatible: openai
      locality: local
      tools_enabled: false
      enabled: true
  routing:
    enabled: false
  cache:
    enabled: false
  tools:
    enabled: "off"
storage:
  driver: sqlite
  sqlite:
    path: ${SANDBOX}/.hexclaw/data.db
knowledge:
  enabled: false
  embedding:
    provider: fixture-local-embedding
    model: fixture-embedding
    disable_auto_install: true
memory:
  long_term:
    enabled: false
  vector:
    enabled: false
file_memory:
  enabled: false
heartbeat:
  enabled: false
mcp:
  enabled: false
EOF
  chmod 600 "${SANDBOX}/.hexclaw/hexclaw.yaml"
}

wait_for_ui_capture_release() {
  if [[ -z "${UI_HOLD_RELEASE_FILE}" ]]; then
    return
  fi
  printf 'native smoke UI capture hold: release=%s\n' "${UI_HOLD_RELEASE_FILE}"
  while [[ ! -e "${UI_HOLD_RELEASE_FILE}" ]]; do
    sleep 1
  done
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
  write_provider_fixture_config
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
  ${TEST_LLM_CONFIG_MODE:+HEXCLAW_TEST_LLM_CONFIG_MODE="${TEST_LLM_CONFIG_MODE}"} \
    "${APP_EXECUTABLE}" >"${ARTIFACT_DIR}/app.log" 2>&1 &
  APP_PID=$!
  if [[ -n "${CHILD_PID_FILE}" ]]; then
    printf '%s\n' "${APP_PID}" > "${CHILD_PID_FILE}"
  fi

  wait_for_health
  assert_protected_sidecar_requires_capability
  test -f "${SANDBOX}/.hexclaw/hexclaw.yaml"
  grep -q "port: ${PORT}" "${SANDBOX}/.hexclaw/hexclaw.yaml"
  grep -q "${SANDBOX}/.hexclaw/data.db" "${SANDBOX}/.hexclaw/hexclaw.yaml"
  test -f "${SANDBOX}/.hexclaw/data.db"
  wait_for_ui_capture_release
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
