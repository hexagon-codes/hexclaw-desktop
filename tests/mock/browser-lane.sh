#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ARTIFACT_ROOT="${HEX_MOCK_ARTIFACT_DIR:-${REPO_ROOT}/test-results/mock-browser/manual}"
RUN_DIR="${ARTIFACT_ROOT}/browser-sidecar"
TEST_HOME="${RUN_DIR}/home"
CONFIG_FILE="${TEST_HOME}/.hexclaw/hexclaw.yaml"
SIDECAR_LOG="${RUN_DIR}/sidecar.log"
SIDECAR_BIN="${RUN_DIR}/hexclaw-sidecar"
SIDECAR_PID=""
RUN_STATUS=0

usage() {
  cat <<'USAGE'
Usage: tests/mock/browser-lane.sh -- command [args ...]

Builds the exact local HexClaw source, starts it with an isolated HOME and a
synthetic OpenAI provider, then executes the Browser Playwright lane. This
script must run inside mock-stack.sh so HEX_MOCKSERVER_URL is explicit.
USAGE
}

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

cleanup() {
  RUN_STATUS=$?
  trap - EXIT INT TERM
  if [[ -n "${SIDECAR_PID}" ]] && kill -0 "${SIDECAR_PID}" >/dev/null 2>&1; then
    kill "${SIDECAR_PID}" >/dev/null 2>&1 || true
    wait "${SIDECAR_PID}" >/dev/null 2>&1 || true
  fi
  if (( RUN_STATUS == 0 )); then
    rm -rf "${TEST_HOME}" "${SIDECAR_BIN}"
  else
    printf 'browser-sidecar failure artifacts: %s\n' "${RUN_DIR}" >&2
  fi
  exit "${RUN_STATUS}"
}
trap cleanup EXIT INT TERM

if [[ "${1:-}" == "--" ]]; then
  shift
fi
if (( $# == 0 )); then
  usage >&2
  exit 2
fi

for command in node go curl git; do
  command -v "${command}" >/dev/null 2>&1 || fail "missing required command: ${command}"
done

MOCKSERVER_URL="${HEX_MOCKSERVER_URL:-}"
[[ -n "${MOCKSERVER_URL}" ]] || fail 'HEX_MOCKSERVER_URL is required; use tests/mock/mock-stack.sh run'
MOCKSERVER_URL="${MOCKSERVER_URL%/}"
node -e '
  const url = new URL(process.argv[1])
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error("HEX_MOCKSERVER_URL must be loopback HTTP")
  }
' "${MOCKSERVER_URL}"

HEXCLAW_LOCAL_SRC="${HEXCLAW_LOCAL_SRC:-${REPO_ROOT}/../hexclaw}"
[[ -d "${HEXCLAW_LOCAL_SRC}/cmd/hexclaw" ]] || fail "invalid HEXCLAW_LOCAL_SRC: ${HEXCLAW_LOCAL_SRC}"
HEXCLAW_LOCAL_SRC="$(cd "${HEXCLAW_LOCAL_SRC}" && pwd)"

if [[ -n "${HEXCLAW_GOWORK:-}" ]]; then
  [[ -f "${HEXCLAW_GOWORK}" ]] || fail "HEXCLAW_GOWORK does not exist: ${HEXCLAW_GOWORK}"
  GO_WORK="$(cd "$(dirname "${HEXCLAW_GOWORK}")" && pwd)/$(basename "${HEXCLAW_GOWORK}")"
elif [[ -f "${REPO_ROOT}/../go.work" ]]; then
  GO_WORK="$(cd "${REPO_ROOT}/.." && pwd)/go.work"
else
  GO_WORK="off"
fi

SIDECAR_PORT="$(node -e '
  const net = require("node:net")
  const server = net.createServer()
  server.unref()
  server.listen(0, "127.0.0.1", () => {
    const address = server.address()
    if (!address || typeof address === "string") process.exit(1)
    process.stdout.write(String(address.port))
    server.close()
  })
')"
[[ "${SIDECAR_PORT}" =~ ^[0-9]+$ ]] || fail 'failed to allocate an isolated sidecar port'

mkdir -p "${TEST_HOME}/.hexclaw" "${TEST_HOME}/tmp" "${RUN_DIR}"
cat >"${CONFIG_FILE}" <<EOF
server:
  host: 127.0.0.1
  port: ${SIDECAR_PORT}
  mode: development
platforms:
  web:
    enabled: true
llm:
  default: mock-openai
  providers:
    mock-openai:
      api_key: local-synthetic-credential
      base_url: "${MOCKSERVER_URL}/v1"
      model: mock-model
      compatible: openai
      tools_enabled: false
      enabled: true
  routing:
    enabled: false
    strategy: quality-first
  cache:
    enabled: false
  tools:
    enabled: "off"
storage:
  driver: sqlite
  sqlite:
    path: "${TEST_HOME}/.hexclaw/data.db"
knowledge:
  enabled: false
  embedding:
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
skills:
  enabled: false
  auto_load: false
router:
  enabled: false
voice:
  enabled: false
skill:
  sandbox:
    enabled: false
  builtin:
    search: false
    weather: false
    translate: false
    summary: false
    browser: false
    code: false
    shell: false
    code_exec: false
    file_ops: false
    media_gen: false
    send_message: false
    export_doc: false
observe:
  log_level: info
  metrics:
    enabled: false
EOF
chmod 600 "${CONFIG_FILE}"

printf 'building exact local sidecar source: %s\n' "${HEXCLAW_LOCAL_SRC}"
(
  cd "${HEXCLAW_LOCAL_SRC}"
  GOWORK="${GO_WORK}" GOTOOLCHAIN="${HEX_MOCK_GOTOOLCHAIN:-auto}" \
    go build -o "${SIDECAR_BIN}" ./cmd/hexclaw
)

env -i \
  PATH="${PATH}" \
  HOME="${TEST_HOME}" \
  USERPROFILE="${TEST_HOME}" \
  TMPDIR="${TEST_HOME}/tmp" \
  LANG="${LANG:-C.UTF-8}" \
  NO_PROXY='*' \
  no_proxy='*' \
  HEXCLAW_TEST_MODE=1 \
  HEXCLAW_TEST_HOME="${TEST_HOME}" \
  HEXCLAW_SIDECAR_PORT="${SIDECAR_PORT}" \
  HEXCLAW_DISABLE_IM=all \
  "${SIDECAR_BIN}" serve --desktop --config "${CONFIG_FILE}" \
  >"${SIDECAR_LOG}" 2>&1 &
SIDECAR_PID=$!
printf '%s\n' "${SIDECAR_PID}" >"${RUN_DIR}/sidecar.pid"

deadline=$((SECONDS + ${HEX_E2E_SIDECAR_WAIT_SECONDS:-90}))
while (( SECONDS < deadline )); do
  if ! kill -0 "${SIDECAR_PID}" >/dev/null 2>&1; then
    tail -n 200 "${SIDECAR_LOG}" >&2 || true
    fail 'real sidecar exited before readiness'
  fi
  if curl --fail --silent --show-error --connect-timeout 1 --max-time 2 \
    "http://127.0.0.1:${SIDECAR_PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl --fail --silent --show-error --connect-timeout 1 --max-time 2 \
  "http://127.0.0.1:${SIDECAR_PORT}/health" >/dev/null \
  || fail "real sidecar was not ready within ${HEX_E2E_SIDECAR_WAIT_SECONDS:-90}s"

export HEX_E2E_SIDECAR_URL="http://127.0.0.1:${SIDECAR_PORT}"
export HEX_E2E_SIDECAR_WS_URL="ws://127.0.0.1:${SIDECAR_PORT}/ws"
export HEX_E2E_PROVIDER='mock-openai'
export HEX_E2E_MODEL='mock-model'

printf 'real sidecar ready at %s (mock=%s)\n' "${HEX_E2E_SIDECAR_URL}" "${MOCKSERVER_URL}"
"$@"
