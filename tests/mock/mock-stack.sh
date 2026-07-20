#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/compose.yaml"
COMMAND="${1:-help}"
MOCK_IMAGE="${HEX_MOCKSERVER_IMAGE:-mockserver/mockserver:7.4.0@sha256:fed9b2089e021947f785d1f0bfda3723352bb2c1634ce7b0bcd42dfd1b0fd02f}"
GATEWAY_IMAGE="${HEX_MOCK_GATEWAY_IMAGE:-haproxy:3.2.21-alpine@sha256:66e25cc9a8332635f4e897f7f4b1e5622c25f09f0ee23cddc6ce9bdb3a24772a}"

if [[ "${COMMAND}" == "run" && -z "${HEX_MOCK_RUN_ID:-}" ]]; then
  RUN_ID="$(date +%Y%m%dT%H%M%S)-$$"
else
  RUN_ID="${HEX_MOCK_RUN_ID:-manual}"
fi
RUN_ID="$(printf '%s' "${RUN_ID}" | tr -cs '[:alnum:]_.-' '-')"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-hexclaw-mock-${RUN_ID}}"
PROJECT_NAME="$(printf '%s' "${PROJECT_NAME}" | tr '[:upper:]' '[:lower:]' | tr -cs '[:alnum:]_-' '-')"

export HEX_MOCK_RUN_ID="${RUN_ID}"
export COMPOSE_PROJECT_NAME="${PROJECT_NAME}"
export HEX_MOCK_ARTIFACT_DIR="${HEX_MOCK_ARTIFACT_DIR:-${REPO_ROOT}/test-results/mock-stack/${RUN_ID}}"
FAILURE_CAPTURED=0
STACK_TORN_DOWN=0

usage() {
  cat <<'USAGE'
Usage: tests/mock/mock-stack.sh <command> [-- command ...]

Commands:
  validate    Validate Compose and fixture files without contacting the daemon
  preflight   Validate tools, Docker daemon/version, and local security assumptions
  up          Start MockServer (and optional chaos profile), then wait until ready
  wait        Wait a bounded time for the synthetic ping fixture
  endpoint    Print the loopback MockServer endpoint
  logs        Print logs and save them under the run artifact directory
  down        Save final state and remove this labelled run
  cleanup     Remove only containers/networks carrying this run's labels
  run -- CMD  Start, execute CMD, retain failure artifacts, and tear down

Environment:
  HEX_MOCK_RUN_ID             Stable run label (default: manual; unique for run)
  HEX_MOCK_TEST_LANE          ownership.json lane (default: l3-engine-smoke)
  HEX_MOCK_WAIT_SECONDS       Readiness timeout (default: 60)
  HEX_MOCK_CHAOS=1            Enable the optional Toxiproxy profile
  HEX_MOCK_ALLOW_LEGACY_DOCKER=1
                              Explicitly bypass the Docker Engine >= 28 guard
USAGE
}

compose() {
  docker compose --project-name "${PROJECT_NAME}" --file "${COMPOSE_FILE}" "$@"
}

compose_profiled() {
  if [[ "${HEX_MOCK_CHAOS:-0}" == "1" ]]; then
    compose --profile chaos "$@"
  else
    compose "$@"
  fi
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'missing required command: %s\n' "$1" >&2
    return 1
  fi
}

write_run_manifest() {
  local manifest_args
  manifest_args=(
    "${SCRIPT_DIR}/run-manifest.mjs"
    --artifact-dir "${HEX_MOCK_ARTIFACT_DIR}"
    --desktop-root "${REPO_ROOT}"
    --fixture-manifest "${SCRIPT_DIR}/fixtures/manifest.json"
    --ownership "${SCRIPT_DIR}/ownership.json"
    --lane "${HEX_MOCK_TEST_LANE:-l3-engine-smoke}"
    --mockserver-image "${MOCK_IMAGE}"
    --gateway-image "${GATEWAY_IMAGE}"
  )
  if [[ "${HEX_MOCK_ALLOW_UNKNOWN_GIT:-0}" == "1" ]]; then
    manifest_args+=(--allow-unknown-git)
  fi
  node "${manifest_args[@]}"
}

validate_stack() {
  require_command docker
  require_command node
  docker compose version >/dev/null
  compose_profiled config --quiet
  node --check "${SCRIPT_DIR}/contract.test.mjs" >/dev/null
  node -e "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')); JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'))" \
    "${SCRIPT_DIR}/fixtures/manifest.json" \
    "${SCRIPT_DIR}/fixtures/mockserverInitialization.json"
  printf 'mock stack static validation passed\n'
}

preflight() {
  validate_stack
  require_command curl
  if ! docker info >/dev/null 2>&1; then
    printf 'Docker daemon is unavailable. Start Docker Desktop and retry.\n' >&2
    return 1
  fi

  local server_version server_major
  server_version="$(docker version --format '{{.Server.Version}}')"
  server_major="${server_version%%.*}"
  if [[ ! "${server_major}" =~ ^[0-9]+$ ]]; then
    printf 'could not parse Docker Engine version: %s\n' "${server_version}" >&2
    return 1
  fi
  if (( server_major < 28 )) && [[ "${HEX_MOCK_ALLOW_LEGACY_DOCKER:-0}" != "1" ]]; then
    printf 'Docker Engine %s is below the loopback publishing security baseline (28.x).\n' "${server_version}" >&2
    printf 'Upgrade Docker Desktop, or set HEX_MOCK_ALLOW_LEGACY_DOCKER=1 only on an isolated machine.\n' >&2
    return 1
  fi
  printf 'mock stack preflight passed (Docker Engine %s)\n' "${server_version}"
}

endpoint() {
  local binding
  binding="$(compose_profiled port loopback_gateway 18080 2>/dev/null | tail -n 1)"
  if [[ ! "${binding}" =~ ^127\.0\.0\.1:[0-9]+$ ]]; then
    printf 'unexpected or missing MockServer port binding: %s\n' "${binding:-<none>}" >&2
    return 1
  fi
  printf 'http://%s\n' "${binding}"
}

wait_for_mockserver() {
  local timeout_seconds deadline url
  timeout_seconds="${HEX_MOCK_WAIT_SECONDS:-60}"
  if [[ ! "${timeout_seconds}" =~ ^[1-9][0-9]*$ ]]; then
    printf 'HEX_MOCK_WAIT_SECONDS must be a positive integer\n' >&2
    return 1
  fi
  deadline=$((SECONDS + timeout_seconds))

  while (( SECONDS < deadline )); do
    if url="$(endpoint 2>/dev/null)" && \
      curl --fail --silent --show-error --connect-timeout 1 --max-time 2 \
        "${url}/__hexclaw_mock__/ping" >/dev/null 2>&1; then
      printf 'MockServer ready at %s\n' "${url}"
      return 0
    fi
    sleep 1
  done

  printf 'MockServer did not become ready within %ss\n' "${timeout_seconds}" >&2
  compose_profiled ps --all >&2 || true
  return 1
}

labelled_container_ids() {
  docker ps --all --quiet \
    --filter 'label=com.hexclaw.test-stack=mock' \
    --filter "label=com.hexclaw.test-run=${RUN_ID}"
}

labelled_network_ids() {
  docker network ls --quiet \
    --filter 'label=com.hexclaw.test-stack=mock' \
    --filter "label=com.hexclaw.test-run=${RUN_ID}"
}

capture_failure() {
  local container_id
  mkdir -p "${HEX_MOCK_ARTIFACT_DIR}"
  compose_profiled ps --all \
    >"${HEX_MOCK_ARTIFACT_DIR}/compose-ps.txt" 2>&1 || true
  compose_profiled logs --no-color --timestamps \
    >"${HEX_MOCK_ARTIFACT_DIR}/compose.log" 2>&1 || true
  for container_id in $(labelled_container_ids 2>/dev/null); do
    docker inspect "${container_id}" \
      >"${HEX_MOCK_ARTIFACT_DIR}/container-${container_id}.inspect.json" 2>&1 || true
  done
  FAILURE_CAPTURED=1
  printf 'failure artifacts: %s\n' "${HEX_MOCK_ARTIFACT_DIR}" >&2
}

cleanup_labeled() {
  local ids
  if ! docker info >/dev/null 2>&1; then
    printf 'Docker daemon is unavailable; labelled cleanup skipped.\n' >&2
    return 1
  fi

  ids="$(labelled_container_ids)"
  if [[ -n "${ids}" ]]; then
    # shellcheck disable=SC2086
    docker rm --force ${ids} >/dev/null
  fi
  ids="$(labelled_network_ids)"
  if [[ -n "${ids}" ]]; then
    # shellcheck disable=SC2086
    docker network rm ${ids} >/dev/null
  fi
}

up_stack() {
  local mockserver_url
  preflight
  mkdir -p "${HEX_MOCK_ARTIFACT_DIR}"
  write_run_manifest
  compose_profiled up --detach --remove-orphans
  if ! wait_for_mockserver; then
    capture_failure
    down_stack || true
    return 1
  fi
  mockserver_url="$(endpoint)"
  export HEX_MOCKSERVER_URL="${mockserver_url}"
  printf 'HEX_MOCKSERVER_URL=%s\n' "${mockserver_url}" \
    >"${HEX_MOCK_ARTIFACT_DIR}/endpoints.env"
  printf 'endpoint file: %s/endpoints.env\n' "${HEX_MOCK_ARTIFACT_DIR}"
}

show_logs() {
  mkdir -p "${HEX_MOCK_ARTIFACT_DIR}"
  compose_profiled logs --no-color --timestamps \
    | tee "${HEX_MOCK_ARTIFACT_DIR}/compose.log"
}

down_stack() {
  if ! docker info >/dev/null 2>&1; then
    printf 'Docker daemon is unavailable; cannot tear down run %s.\n' "${RUN_ID}" >&2
    return 1
  fi
  mkdir -p "${HEX_MOCK_ARTIFACT_DIR}"
  compose_profiled ps --all \
    >"${HEX_MOCK_ARTIFACT_DIR}/compose-ps-final.txt" 2>&1 || true
  compose_profiled logs --no-color --timestamps \
    >"${HEX_MOCK_ARTIFACT_DIR}/compose-final.log" 2>&1 || true
  compose_profiled down --remove-orphans --volumes || true
  cleanup_labeled
  STACK_TORN_DOWN=1
}

run_command() {
  shift
  if [[ "${1:-}" == "--" ]]; then
    shift
  fi
  if (( $# == 0 )); then
    printf 'run requires a command after --\n' >&2
    return 2
  fi

  finish_run() {
    local status=$?
    trap - EXIT INT TERM
    if (( status != 0 && FAILURE_CAPTURED == 0 )); then
      capture_failure
    fi
    if (( STACK_TORN_DOWN == 0 )); then
      down_stack || true
    fi
    exit "${status}"
  }
  trap finish_run EXIT INT TERM

  up_stack
  "$@"
}

case "${COMMAND}" in
  validate)
    validate_stack
    ;;
  preflight)
    preflight
    ;;
  up)
    up_stack
    ;;
  wait)
    wait_for_mockserver
    ;;
  endpoint)
    endpoint
    ;;
  logs)
    show_logs
    ;;
  down)
    down_stack
    ;;
  cleanup)
    cleanup_labeled
    ;;
  run)
    run_command "$@"
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
