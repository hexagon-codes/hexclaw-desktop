#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 /absolute/path/to/HexClaw-desktop-executable" >&2
  exit 64
fi

APP_EXECUTABLE="$1"
if [[ "${APP_EXECUTABLE}" != /* || ! -x "${APP_EXECUTABLE}" ]]; then
  echo "native executable must be an existing absolute Desktop executable path" >&2
  exit 64
fi

BUNDLE_ID="${HEXCLAW_NATIVE_BUNDLE_ID:-com.hexclaw.desktop.missing-llm}"
PORT="${HEXCLAW_NATIVE_SIDECAR_PORT:-16163}"
LLM_CONFIG_MODE="${HEXCLAW_TEST_LLM_CONFIG_MODE:-missing}"
case "${LLM_CONFIG_MODE}" in
  missing|explicit-empty) ;;
  *)
    echo "HEXCLAW_TEST_LLM_CONFIG_MODE must be missing or explicit-empty" >&2
    exit 64
    ;;
esac
PROFILE_CATCHUP="${HEXCLAW_TEST_PROFILE_CATCHUP:-0}"
if [[ "${PROFILE_CATCHUP}" != "0" && "${PROFILE_CATCHUP}" != "1" ]]; then
  echo "HEXCLAW_TEST_PROFILE_CATCHUP must be 0 or 1" >&2
  exit 64
fi
if lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "native missing-LLM test port already has a listener: ${PORT}" >&2
  exit 1
fi
TEST_HOME="$(mktemp -d "${TMPDIR:-/tmp}/hexclaw-missing-llm.XXXXXX")"
LOG_FILE="${TEST_HOME}/native.log"
APP_PID=""
SIDECAR_PID=""

wait_for_port_release() {
  local attempts="$1"
  for _ in $(seq 1 "${attempts}"); do
    if ! lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

cleanup() {
  local prior_status=$?
  local cleanup_status=0
  if [[ -n "${APP_PID}" ]] && kill -0 "${APP_PID}" 2>/dev/null; then
    kill -TERM "${APP_PID}" 2>/dev/null || true
    for _ in {1..100}; do
      kill -0 "${APP_PID}" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL "${APP_PID}" 2>/dev/null || true
    wait "${APP_PID}" 2>/dev/null || true
  fi
  if ! wait_for_port_release 20; then
    if [[ -n "${SIDECAR_PID}" ]] && \
      lsof -nP -a -p "${SIDECAR_PID}" -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
      kill -TERM "${SIDECAR_PID}" 2>/dev/null || true
    fi
    if ! wait_for_port_release 100; then
      echo "native missing-LLM test sidecar port did not release: ${PORT}" >&2
      cleanup_status=1
    fi
  fi
  if [[ "${cleanup_status}" -eq 0 ]]; then
    rm -rf "${TEST_HOME}"
  else
    echo "preserving isolated test home after failed sidecar cleanup: ${TEST_HOME}" >&2
  fi
  if [[ "${prior_status}" -ne 0 ]]; then
    return "${prior_status}"
  fi
  return "${cleanup_status}"
}
trap cleanup EXIT

HEXCLAW_TEST_MODE=1 \
HEXCLAW_TEST_HOME="${TEST_HOME}" \
HEXCLAW_SIDECAR_PORT="${PORT}" \
"${APP_EXECUTABLE}" >"${LOG_FILE}" 2>&1 &
APP_PID=$!

for _ in {1..300}; do
  if ! kill -0 "${APP_PID}" 2>/dev/null; then
    cat "${LOG_FILE}" >&2
    echo "native app exited before health became reachable" >&2
    exit 1
  fi
  if curl --silent --fail --max-time 1 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
curl --silent --fail --max-time 2 "http://127.0.0.1:${PORT}/health" >/dev/null
SIDECAR_PIDS=( $(lsof -nP -tiTCP:"${PORT}" -sTCP:LISTEN | sort -u) )
if [[ "${#SIDECAR_PIDS[@]}" -ne 1 ]]; then
  echo "native missing-LLM test must own exactly one sidecar listener" >&2
  exit 1
fi
SIDECAR_PID="${SIDECAR_PIDS[0]}"

CONFIG_FILE="${TEST_HOME}/.hexclaw/hexclaw.yaml"
if [[ ! -f "${CONFIG_FILE}" ]]; then
  echo "missing isolated config: ${CONFIG_FILE}" >&2
  exit 1
fi
case "${LLM_CONFIG_MODE}" in
  missing)
    if rg -n '^[[:space:]]*llm:' "${CONFIG_FILE}" >/dev/null; then
      echo "isolated generated config unexpectedly contains an llm section" >&2
      exit 1
    fi
    ;;
  explicit-empty)
    if ! rg -U -n '^llm:\n  providers: \{\}\n?$' "${CONFIG_FILE}" >/dev/null; then
      echo "isolated generated config must contain exactly an explicit empty llm.providers block" >&2
      exit 1
    fi
    ;;
esac

LLM_CONFIG="$(curl --silent --show-error --fail --max-time 2 "http://127.0.0.1:${PORT}/api/v1/config/llm")"
node -e '
const payload = JSON.parse(process.argv[1]);
if (payload.providers == null || typeof payload.providers !== "object" || Array.isArray(payload.providers) || Object.keys(payload.providers).length !== 0) {
  throw new Error(`providers=${JSON.stringify(payload.providers)}, want empty object`);
}
if (typeof payload.default !== "string") throw new Error(`default=${JSON.stringify(payload.default)}, want a string`);
if (payload.default !== "" && Object.hasOwn(payload.providers, payload.default)) {
  throw new Error(`default=${JSON.stringify(payload.default)} unexpectedly names a configured provider`);
}
' "${LLM_CONFIG}"

if [[ "${PROFILE_CATCHUP}" == "1" ]]; then
  MEMORY_FILE="${TEST_HOME}/.hexclaw/memory/_global/MEMORY.md"
  PHASE_FILE="${TEST_HOME}/.hexclaw/memory/.phase_state.json"
  if [[ ! -f "${MEMORY_FILE}" || ! -f "${PHASE_FILE}" ]]; then
    echo "missing isolated overdue profile catch-up fixture" >&2
    exit 1
  fi
  if [[ "$(rg -c '^- \[[0-9]{2}:[0-9]{2}\] \[fact:manual\] ' "${MEMORY_FILE}")" != "3" ]]; then
    echo "profile catch-up fixture must contain exactly three non-sensitive fact entries" >&2
    exit 1
  fi
  sleep 1
  node -e '
const payload = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
if (payload.profile !== "2000-01-01T00:00:00Z") {
  throw new Error(`profile catch-up advanced or was not the frozen overdue fixture: ${JSON.stringify(payload.profile)}`);
}
' "${PHASE_FILE}"
fi

echo "REG-FIX-20260727-MISSING-LLM-STARTUP-001 native ${LLM_CONFIG_MODE} LLM startup (profile-catchup=${PROFILE_CATCHUP}): PASS"
