#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 /absolute/path/to/HexClaw-executable" >&2
  exit 64
fi

APP_EXECUTABLE="$1"
if [[ "${APP_EXECUTABLE}" != /* || ! -x "${APP_EXECUTABLE}" ]]; then
  echo "native executable must be an existing absolute executable path" >&2
  exit 64
fi

REAL_HOME="${HOME:?HOME is required}"
BUNDLE_ID="${HEXCLAW_NATIVE_BUNDLE_ID:-com.hexclaw.desktop.mock}"
PORT="${HEXCLAW_NATIVE_SIDECAR_PORT:-16063}"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/hexclaw-native-home.XXXXXX")"
LOG_FILE="${SANDBOX}/native.log"
PID=""
SIDECAR_PIDS=""

stop_test_sidecars() {
  local sidecar_pid command
  for sidecar_pid in ${SIDECAR_PIDS}; do
    kill -0 "${sidecar_pid}" 2>/dev/null || continue
    command="$(ps -p "${sidecar_pid}" -o command= 2>/dev/null || true)"
    if [[ "${command}" != "/Applications/HexClaw.app/Contents/MacOS/hexclaw serve --desktop" ]]; then
      echo "refusing to terminate unverified listener pid ${sidecar_pid}: ${command}" >&2
      return 1
    fi
    kill -TERM "${sidecar_pid}" 2>/dev/null || true
    for _ in {1..50}; do
      kill -0 "${sidecar_pid}" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL "${sidecar_pid}" 2>/dev/null || true
  done
  SIDECAR_PIDS=""
}

cleanup() {
  if [[ -n "${PID}" ]] && kill -0 "${PID}" 2>/dev/null; then
    kill -TERM "${PID}" 2>/dev/null || true
    for _ in {1..50}; do
      kill -0 "${PID}" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL "${PID}" 2>/dev/null || true
    wait "${PID}" 2>/dev/null || true
  fi
  stop_test_sidecars || true
  rm -rf "${SANDBOX}"
}
trap cleanup EXIT

fingerprint() {
  local path="$1"
  if [[ ! -e "${path}" ]]; then
    printf 'MISSING'
    return
  fi
  local metadata digest
  metadata="$(stat -f '%i:%z:%m' "${path}")"
  digest="$(shasum -a 256 "${path}" | awk '{print $1}')"
  printf '%s:%s' "${metadata}" "${digest}"
}

tree_metadata_fingerprint() {
  local path="$1"
  if [[ ! -d "${path}" ]]; then
    printf 'MISSING'
    return
  fi
  find "${path}" -type f -exec stat -f '%N:inode=%i:size=%z:mtime=%m' {} \; \
    | LC_ALL=C sort \
    | shasum -a 256 \
    | awk '{print $1}'
}

PRODUCTION_CONFIG_DIR="${REAL_HOME}/Library/Application Support/com.hexclaw.desktop"
TARGET_CONFIG_DIR="${REAL_HOME}/Library/Application Support/${BUNDLE_ID}"
REAL_HEXCLAW_DIR="${REAL_HOME}/.hexclaw"
PROTECTED_PATHS=(
  "${PRODUCTION_CONFIG_DIR}/config.dat"
  "${PRODUCTION_CONFIG_DIR}/secure.dat"
  "${TARGET_CONFIG_DIR}/config.dat"
  "${TARGET_CONFIG_DIR}/secure.dat"
  "${REAL_HEXCLAW_DIR}/hexclaw.yaml"
  "${REAL_HEXCLAW_DIR}/data.db"
)

declare -a BEFORE=()
for path in "${PROTECTED_PATHS[@]}"; do
  BEFORE+=("$(fingerprint "${path}")")
done
REAL_HEXCLAW_BEFORE="$(tree_metadata_fingerprint "${REAL_HEXCLAW_DIR}")"

HEXCLAW_TEST_MODE=1 \
HEXCLAW_TEST_HOME="${SANDBOX}" \
HEXCLAW_SIDECAR_PORT="${PORT}" \
"${APP_EXECUTABLE}" >"${LOG_FILE}" 2>&1 &
PID=$!

for _ in {1..300}; do
  if ! kill -0 "${PID}" 2>/dev/null; then
    cat "${LOG_FILE}" >&2
    echo "native app exited before isolated stores were created" >&2
    exit 1
  fi
  if curl --silent --fail --max-time 1 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
curl --silent --fail --max-time 2 "http://127.0.0.1:${PORT}/health" >/dev/null
SIDECAR_PIDS="$(lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN -t 2>/dev/null || true)"
if [[ -z "${SIDECAR_PIDS}" ]]; then
  echo "no sidecar listener PID found for dedicated port ${PORT}" >&2
  exit 1
fi

ISOLATED_APP_DATA="${SANDBOX}/Library/Application Support/${BUNDLE_ID}"
for _ in {1..50}; do
  [[ -f "${ISOLATED_APP_DATA}/config.dat" && -f "${ISOLATED_APP_DATA}/secure.dat" ]] && break
  sleep 0.1
done

EXPECTED_FILES=(
  "${SANDBOX}/.hexclaw/hexclaw.yaml"
  "${SANDBOX}/.hexclaw/data.db"
)
EXPECTED_DIRS=(
  "${SANDBOX}/Library/Application Support"
  "${SANDBOX}/Library/Caches"
  "${SANDBOX}/Library/Logs"
)
for path in "${EXPECTED_FILES[@]}"; do
  if [[ ! -f "${path}" ]]; then
    cat "${LOG_FILE}" >&2
    echo "missing isolated native file: ${path}" >&2
    exit 1
  fi
done
for path in "${EXPECTED_DIRS[@]}"; do
  if [[ ! -d "${path}" ]]; then
    cat "${LOG_FILE}" >&2
    echo "missing isolated native directory: ${path}" >&2
    exit 1
  fi
done
for store in config.dat secure.dat; do
  if [[ -f "${ISOLATED_APP_DATA}/${store}" ]]; then
    echo "isolated Tauri store created: ${ISOLATED_APP_DATA}/${store}"
  else
    echo "isolated Tauri store had no write in this empty-profile run: ${store}"
  fi
done
find "${SANDBOX}" -maxdepth 6 -type f -print | LC_ALL=C sort

kill -TERM "${PID}"
for _ in {1..100}; do
  kill -0 "${PID}" 2>/dev/null || break
  sleep 0.1
done
wait "${PID}" 2>/dev/null || true
PID=""
stop_test_sidecars

for index in "${!PROTECTED_PATHS[@]}"; do
  after="$(fingerprint "${PROTECTED_PATHS[$index]}")"
  if [[ "${after}" != "${BEFORE[$index]}" ]]; then
    echo "real user path changed: ${PROTECTED_PATHS[$index]}" >&2
    exit 1
  fi
done
REAL_HEXCLAW_AFTER="$(tree_metadata_fingerprint "${REAL_HEXCLAW_DIR}")"
if [[ "${REAL_HEXCLAW_AFTER}" != "${REAL_HEXCLAW_BEFORE}" ]]; then
  echo "real ~/.hexclaw aggregate changed" >&2
  exit 1
fi

if lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN -t 2>/dev/null | grep -q .; then
  echo "sidecar port ${PORT} remains after native exit" >&2
  exit 1
fi

echo "BUG-20260727-003 native test-home isolation: PASS"
