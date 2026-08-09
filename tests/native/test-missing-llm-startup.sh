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

umask 077
TEST_HOME="$(mktemp -d "${TMPDIR:-/tmp}/hexclaw-missing-llm.XXXXXX")"
chmod 700 "${TEST_HOME}"
mkdir -p "${TEST_HOME}/tmp"
chmod 700 "${TEST_HOME}/tmp"
PROCESS_START_ID_HELPER="${TEST_HOME}/tmp/process-start-identity"
PROCESS_START_ID_PLATFORM=""
LOG_FILE="${TEST_HOME}/native.log"
APP_PID_FILE="${TEST_HOME}/app.pid"
APP_STATUS_FILE="${TEST_HOME}/app.status"
SUPERVISOR_START_FILE="${TEST_HOME}/supervisor.start"
WATCHDOG_PID_FILE="${TEST_HOME}/watchdog.pid"
SUPERVISOR_IDENTITY_FILE="${TEST_HOME}/supervisor.identity.json"
WATCHDOG_IDENTITY_FILE="${TEST_HOME}/watchdog.identity.json"
WATCHDOG_READY_FILE="${TEST_HOME}/watchdog.ready"
APP_PID=""
APP_PGID=""
APP_WAIT_STATUS=""
SUPERVISOR_PID=""
SUPERVISOR_WAITED=0
CALLER_SHELL_PID="$$"
CALLER_SHELL_PGID=""
CALLER_SHELL_START_ID=""
CALLER_SHELL_COMMAND_ID=""
SIDECAR_PID=""
SUPERVISOR_START_ID=""
SUPERVISOR_COMMAND_ID=""
WATCHDOG_PID=""
WATCHDOG_START_ID=""
WATCHDOG_COMMAND_ID=""
WATCHDOG_WAITED=0
PROCESS_PARENT_PID=""
PROCESS_GROUP_ID=""
PROCESS_STATE=""

build_process_start_identity_helper() {
  PROCESS_START_ID_PLATFORM="$(uname -s)"
  case "${PROCESS_START_ID_PLATFORM}" in
    Darwin)
      if [[ ! -x /usr/bin/cc ]]; then
        echo "native missing-LLM test requires the macOS C compiler for process identity" >&2
        return 1
      fi
      if ! printf '%s\n' \
        '#include <errno.h>' \
        '#include <inttypes.h>' \
        '#include <libproc.h>' \
        '#include <stdio.h>' \
        '#include <stdlib.h>' \
        '#include <sys/proc_info.h>' \
        'int main(int argc, char **argv) {' \
        '  char *end = NULL;' \
        '  long value;' \
        '  struct proc_bsdinfo info;' \
        '  int size;' \
        '  if (argc != 2) return 64;' \
        '  errno = 0;' \
        '  value = strtol(argv[1], &end, 10);' \
        "  if (errno != 0 || end == argv[1] || *end != '\\0' || value <= 0) return 64;" \
        '  size = proc_pidinfo((int)value, PROC_PIDTBSDINFO, 0, &info, sizeof(info));' \
        '  if (size != (int)sizeof(info)) return 1;' \
        '  printf("darwin:%" PRIu64 ":%06" PRIu64 "\n", info.pbi_start_tvsec, info.pbi_start_tvusec);' \
        '  return 0;' \
        '}' |
        /usr/bin/cc -x c -std=c11 -O2 -Wall -Wextra -Werror - -o "${PROCESS_START_ID_HELPER}"; then
        echo "native missing-LLM test could not build its process identity helper" >&2
        return 1
      fi
      chmod 700 "${PROCESS_START_ID_HELPER}"
      ;;
    Linux) ;;
    *)
      echo "native missing-LLM test does not support high-resolution process identity on this platform" >&2
      return 1
      ;;
  esac
}

if ! build_process_start_identity_helper; then
  rm -rf "${TEST_HOME}" || true
  exit 1
fi

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

process_group_has_live_members() {
  [[ -n "${APP_PGID}" ]] || return 1
  ps -axo pgid=,stat= | awk -v pgid="${APP_PGID}" '
    $1 == pgid && $2 !~ /^Z/ { found = 1 }
    END { exit(found ? 0 : 1) }
  '
}

process_group_has_members() {
  [[ -n "${APP_PGID}" ]] || return 1
  ps -axo pgid= | awk -v pgid="${APP_PGID}" '
    $1 == pgid { found = 1 }
    END { exit(found ? 0 : 1) }
  '
}

load_process_identity() {
  local pid="$1"
  local identity=""
  PROCESS_PARENT_PID=""
  PROCESS_GROUP_ID=""
  PROCESS_STATE=""
  [[ "${pid}" =~ ^[0-9]+$ ]] || return 1
  identity="$(
    ps -o ppid=,pgid=,stat= -p "${pid}" 2>/dev/null |
      awk 'NR == 1 { print $1, $2, $3 }' || true
  )"
  [[ -n "${identity}" ]] || return 1
  read -r PROCESS_PARENT_PID PROCESS_GROUP_ID PROCESS_STATE <<<"${identity}"
  [[ "${PROCESS_PARENT_PID}" =~ ^[0-9]+$ ]] || return 1
  [[ "${PROCESS_GROUP_ID}" =~ ^[0-9]+$ ]] || return 1
  [[ -n "${PROCESS_STATE}" ]] || return 1
}

process_state_is_live() {
  [[ -n "${PROCESS_STATE}" && "${PROCESS_STATE}" != Z* ]]
}

read_process_start_id() {
  local pid="$1"
  local proc_stat=""
  case "${PROCESS_START_ID_PLATFORM}" in
    Darwin)
      "${PROCESS_START_ID_HELPER}" "${pid}" 2>/dev/null
      ;;
    Linux)
      [[ -r "/proc/${pid}/stat" ]] || return 1
      IFS= read -r proc_stat <"/proc/${pid}/stat" || return 1
      proc_stat="${proc_stat##*) }"
      printf 'linux:%s\n' "$(printf '%s\n' "${proc_stat}" | awk '{ print $20 }')"
      ;;
    *) return 1 ;;
  esac
}

read_process_command_id() {
  local pid="$1"
  local command=""
  command="$(
    LC_ALL=C ps -o command= -p "${pid}" 2>/dev/null |
      awk 'NR == 1 { $1 = $1; print; exit }'
  )"
  [[ -n "${command}" ]] || return 1
  printf '%s\n' "${command}" | shasum -a 256 | awk '{ print $1 }'
}

write_process_identity_file() {
  local target="$1"
  local role="$2"
  local pid="$3"
  local parent_pid="$4"
  local pgid="$5"
  local start_id="$6"
  local command_id="$7"
  printf '{"version":1,"role":"%s","pid":%s,"parentPid":%s,"pgid":%s,"startId":"%s","commandId":"%s"}\n' \
    "${role}" "${pid}" "${parent_pid}" "${pgid}" "${start_id}" "${command_id}" >"${target}.tmp"
  mv "${target}.tmp" "${target}"
}

write_watchdog_ready_file() {
  printf '{"version":1,"owner":{"pid":%s,"pgid":%s,"startId":"%s","commandId":"%s"},"supervisor":{"pid":%s,"pgid":%s,"startId":"%s","commandId":"%s"},"watchdog":{"pid":%s,"pgid":%s,"startId":"%s","commandId":"%s"}}\n' \
    "${CALLER_SHELL_PID}" "${CALLER_SHELL_PGID}" "${CALLER_SHELL_START_ID}" "${CALLER_SHELL_COMMAND_ID}" \
    "${SUPERVISOR_PID}" "${APP_PGID}" "${SUPERVISOR_START_ID}" "${SUPERVISOR_COMMAND_ID}" \
    "${WATCHDOG_PID}" "${WATCHDOG_PID}" "${WATCHDOG_START_ID}" "${WATCHDOG_COMMAND_ID}" >"${WATCHDOG_READY_FILE}.tmp"
  mv "${WATCHDOG_READY_FILE}.tmp" "${WATCHDOG_READY_FILE}"
}

claim_supervisor_process_group() {
  local parent_pid=""
  local candidate=""
  local process_state=""
  load_process_identity "${SUPERVISOR_PID}" || return 1
  parent_pid="${PROCESS_PARENT_PID}"
  candidate="${PROCESS_GROUP_ID}"
  process_state="${PROCESS_STATE}"
  [[ "${candidate}" =~ ^[0-9]+$ ]] || return 1
  [[ "${candidate}" == "${SUPERVISOR_PID}" ]] || return 1
  [[ "${parent_pid}" == "${CALLER_SHELL_PID}" ]] || return 1
  [[ "${candidate}" != "${CALLER_SHELL_PGID}" ]] || return 1
  [[ "${process_state}" != Z* ]] || return 1
  APP_PGID="${candidate}"
}

claim_app_process() {
  load_process_identity "${APP_PID}" || return 1
  [[ "${PROCESS_PARENT_PID}" == "${SUPERVISOR_PID}" ]] || return 1
  [[ "${PROCESS_GROUP_ID}" == "${APP_PGID}" ]] || return 1
  process_state_is_live
}

claim_sidecar_listener() {
  local parent_pid=""
  local candidate=""
  local process_state=""
  load_process_identity "${SIDECAR_PID}" || return 1
  parent_pid="${PROCESS_PARENT_PID}"
  candidate="${PROCESS_GROUP_ID}"
  process_state="${PROCESS_STATE}"
  [[ "${parent_pid}" == "${APP_PID}" ]] || return 1
  [[ "${candidate}" == "${APP_PGID}" ]] || return 1
  [[ "${process_state}" != Z* ]] || return 1
}

supervisor_is_live_direct_child() {
  local current_start_id=""
  local current_command_id=""
  load_process_identity "${SUPERVISOR_PID}" || return 1
  [[ "${PROCESS_PARENT_PID}" == "${CALLER_SHELL_PID}" ]] || return 1
  process_state_is_live || return 1
  if [[ -n "${SUPERVISOR_START_ID}" ]]; then
    current_start_id="$(read_process_start_id "${SUPERVISOR_PID}" || true)"
    [[ "${current_start_id}" == "${SUPERVISOR_START_ID}" ]] || return 1
  fi
  if [[ -n "${SUPERVISOR_COMMAND_ID}" ]]; then
    current_command_id="$(read_process_command_id "${SUPERVISOR_PID}" || true)"
    [[ "${current_command_id}" == "${SUPERVISOR_COMMAND_ID}" ]] || return 1
  fi
}

supervisor_is_live_owned_group_leader() {
  [[ -n "${APP_PGID}" ]] || return 1
  supervisor_is_live_direct_child || return 1
  [[ "${PROCESS_GROUP_ID}" == "${APP_PGID}" ]]
}

watchdog_is_live_direct_child() {
  local current_start_id=""
  local current_command_id=""
  load_process_identity "${WATCHDOG_PID}" || return 1
  [[ "${PROCESS_PARENT_PID}" == "${CALLER_SHELL_PID}" ]] || return 1
  [[ "${PROCESS_GROUP_ID}" == "${WATCHDOG_PID}" ]] || return 1
  [[ "${PROCESS_GROUP_ID}" != "${CALLER_SHELL_PGID}" ]] || return 1
  [[ "${PROCESS_GROUP_ID}" != "${APP_PGID}" ]] || return 1
  process_state_is_live || return 1
  current_start_id="$(read_process_start_id "${WATCHDOG_PID}" || true)"
  [[ -n "${current_start_id}" && "${current_start_id}" == "${WATCHDOG_START_ID}" ]] || return 1
  current_command_id="$(read_process_command_id "${WATCHDOG_PID}" || true)"
  [[ -n "${current_command_id}" && "${current_command_id}" == "${WATCHDOG_COMMAND_ID}" ]]
}

watchdog_owner_is_current() {
  local current_start_id=""
  local current_command_id=""
  load_process_identity "${CALLER_SHELL_PID}" || return 1
  [[ "${PROCESS_GROUP_ID}" == "${CALLER_SHELL_PGID}" ]] || return 1
  process_state_is_live || return 1
  current_start_id="$(read_process_start_id "${CALLER_SHELL_PID}" || true)"
  [[ -n "${current_start_id}" && "${current_start_id}" == "${CALLER_SHELL_START_ID}" ]] || return 1
  current_command_id="$(read_process_command_id "${CALLER_SHELL_PID}" || true)"
  [[ -n "${current_command_id}" && "${current_command_id}" == "${CALLER_SHELL_COMMAND_ID}" ]]
}

watchdog_supervisor_claim_is_current() {
  local current_start_id=""
  local current_command_id=""
  load_process_identity "${SUPERVISOR_PID}" || return 1
  [[ "${PROCESS_GROUP_ID}" == "${APP_PGID}" ]] || return 1
  [[ "${SUPERVISOR_PID}" == "${APP_PGID}" ]] || return 1
  [[ "${APP_PGID}" != "${CALLER_SHELL_PGID}" ]] || return 1
  process_state_is_live || return 1
  current_start_id="$(read_process_start_id "${SUPERVISOR_PID}" || true)"
  [[ -n "${current_start_id}" && "${current_start_id}" == "${SUPERVISOR_START_ID}" ]] || return 1
  current_command_id="$(read_process_command_id "${SUPERVISOR_PID}" || true)"
  [[ -n "${current_command_id}" && "${current_command_id}" == "${SUPERVISOR_COMMAND_ID}" ]]
}

app_is_live_owned_process() {
  [[ -n "${APP_PID}" ]] || return 1
  load_process_identity "${APP_PID}" || return 1
  [[ "${PROCESS_PARENT_PID}" == "${SUPERVISOR_PID}" ]] || return 1
  [[ "${PROCESS_GROUP_ID}" == "${APP_PGID}" ]] || return 1
  process_state_is_live
}

validated_process_group_is_armed() {
  [[ "${APP_PGID}" =~ ^[0-9]+$ ]] || return 1
  [[ "${APP_PGID}" == "${SUPERVISOR_PID}" ]] || return 1
  [[ "${APP_PGID}" != "${CALLER_SHELL_PGID}" ]] || return 1
  supervisor_is_live_owned_group_leader
}

capture_live_process_group_members() {
  local candidate_pids=""
  local member_pid=""
  local member_start_id=""
  local member_command_id=""
  local confirmed_start_id=""
  local confirmed_command_id=""
  candidate_pids="$(
    ps -axo pid=,pgid=,stat= | awk -v pgid="${APP_PGID}" '
      $2 == pgid && $3 !~ /^Z/ { print $1 }
    '
  )"
  while IFS= read -r member_pid; do
    [[ "${member_pid}" =~ ^[0-9]+$ ]] || continue
    if ! load_process_identity "${member_pid}" ||
      [[ "${PROCESS_GROUP_ID}" != "${APP_PGID}" ]] ||
      ! process_state_is_live; then
      continue
    fi
    member_start_id="$(read_process_start_id "${member_pid}" || true)"
    member_command_id="$(read_process_command_id "${member_pid}" || true)"
    [[ -n "${member_start_id}" && "${member_command_id}" =~ ^[0-9a-f]{64}$ ]] || continue

    # 身份读取期间进程可能退出或被复用，发布快照前必须二次确认。
    if ! load_process_identity "${member_pid}" ||
      [[ "${PROCESS_GROUP_ID}" != "${APP_PGID}" ]] ||
      ! process_state_is_live; then
      continue
    fi
    confirmed_start_id="$(read_process_start_id "${member_pid}" || true)"
    confirmed_command_id="$(read_process_command_id "${member_pid}" || true)"
    if [[ "${confirmed_start_id}" == "${member_start_id}" &&
      "${confirmed_command_id}" == "${member_command_id}" ]]; then
      printf '%s\t%s\t%s\n' "${member_pid}" "${member_start_id}" "${member_command_id}"
    fi
  done <<<"${candidate_pids}"
}

snapshot_has_live_group_member() {
  local snapshot="$1"
  local member_pid=""
  local expected_start_id=""
  local expected_command_id=""
  local current_start_id=""
  local current_command_id=""
  while IFS=$'\t' read -r member_pid expected_start_id expected_command_id; do
    [[ "${member_pid}" =~ ^[0-9]+$ ]] || continue
    [[ -n "${expected_start_id}" && "${expected_command_id}" =~ ^[0-9a-f]{64}$ ]] || continue
    if load_process_identity "${member_pid}" &&
      [[ "${PROCESS_GROUP_ID}" == "${APP_PGID}" ]] &&
      process_state_is_live; then
      current_start_id="$(read_process_start_id "${member_pid}" || true)"
      current_command_id="$(read_process_command_id "${member_pid}" || true)"
      if [[ "${current_start_id}" == "${expected_start_id}" &&
        "${current_command_id}" == "${expected_command_id}" ]]; then
        return 0
      fi
    fi
  done <<<"${snapshot}"
  return 1
}

wait_for_process_group_state() {
  local attempts="$1"
  local predicate="$2"
  for _ in $(seq 1 "${attempts}"); do
    if ! "${predicate}"; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

supervisor_job_is_running() {
  local current_job_pid=""
  [[ -n "${SUPERVISOR_PID}" ]] || return 1
  current_job_pid="$(jobs -pr %+ 2>/dev/null || true)"
  [[ "${current_job_pid}" == "${SUPERVISOR_PID}" ]]
}

reap_supervisor_process() {
  if [[ -z "${SUPERVISOR_PID}" || "${SUPERVISOR_WAITED}" -eq 1 ]]; then
    return 0
  fi
  wait "${SUPERVISOR_PID}" 2>/dev/null || true
  SUPERVISOR_WAITED=1
}

load_app_exit_status() {
  local status=""
  [[ -f "${APP_STATUS_FILE}" ]] || return 1
  IFS= read -r status <"${APP_STATUS_FILE}" || true
  if [[ "${status}" =~ ^[0-9]+$ ]]; then
    APP_WAIT_STATUS="${status}"
  else
    APP_WAIT_STATUS="invalid"
  fi
  return 0
}

wait_for_app_exit_status() {
  local attempts="$1"
  for _ in $(seq 1 "${attempts}"); do
    if load_app_exit_status; then
      return 0
    fi
    sleep 0.05
  done
  return 1
}

terminate_exact_direct_child() {
  local ownership_error=0
  if [[ -z "${SUPERVISOR_PID}" ]]; then
    return 0
  fi

  # 未完成进程组认领时只允许通过 Bash 作业表终止当前精确子进程。
  if supervisor_job_is_running; then
    kill -TERM "${SUPERVISOR_PID}" 2>/dev/null || true
    if ! wait_for_process_group_state 100 supervisor_job_is_running; then
      if supervisor_job_is_running; then
        kill -KILL "${SUPERVISOR_PID}" 2>/dev/null || true
      fi
      if ! wait_for_process_group_state 100 supervisor_job_is_running; then
        echo "native missing-LLM test direct child did not terminate: ${SUPERVISOR_PID}" >&2
        ownership_error=1
      fi
    fi
  fi

  if [[ "${ownership_error}" -eq 0 ]]; then
    reap_supervisor_process
  fi
  return "${ownership_error}"
}

terminate_owned_process_group() {
  local member_snapshot=""
  if [[ -z "${APP_PGID}" ]]; then
    terminate_exact_direct_child
    return $?
  fi

  if process_group_has_live_members; then
    if ! validated_process_group_is_armed; then
      echo "native missing-LLM test refused to signal an unverified process group: ${APP_PGID}" >&2
      return 1
    fi
    member_snapshot="$(capture_live_process_group_members)"
    [[ -n "${member_snapshot}" ]] || return 1
    kill -TERM -- "-${APP_PGID}" 2>/dev/null || true
    if ! wait_for_process_group_state 100 process_group_has_live_members; then
      if ! snapshot_has_live_group_member "${member_snapshot}"; then
        echo "native missing-LLM test refused to kill a reused process group: ${APP_PGID}" >&2
        return 1
      fi
      kill -KILL -- "-${APP_PGID}" 2>/dev/null || true
      if ! wait_for_process_group_state 100 process_group_has_live_members; then
        echo "native missing-LLM test process group did not terminate: ${APP_PGID}" >&2
        return 1
      fi
    fi
  fi

  reap_supervisor_process
  if ! wait_for_process_group_state 100 process_group_has_members; then
    echo "native missing-LLM test process group was not fully reaped: ${APP_PGID}" >&2
    return 1
  fi
  return 0
}

watchdog_cleanup_owned_process_group() {
  local cleanup_status=0
  local member_snapshot=""
  if process_group_has_live_members; then
    if ! watchdog_supervisor_claim_is_current; then
      echo "native missing-LLM watchdog refused an unverified process group: ${APP_PGID}" >&2
      cleanup_status=1
    else
      member_snapshot="$(capture_live_process_group_members)"
      if [[ -z "${member_snapshot}" ]]; then
        cleanup_status=1
      else
        kill -TERM -- "-${APP_PGID}" 2>/dev/null || true
        if ! wait_for_process_group_state 100 process_group_has_live_members; then
          if ! snapshot_has_live_group_member "${member_snapshot}"; then
            echo "native missing-LLM watchdog refused to kill a reused process group: ${APP_PGID}" >&2
            cleanup_status=1
          else
            kill -KILL -- "-${APP_PGID}" 2>/dev/null || true
            if ! wait_for_process_group_state 100 process_group_has_live_members; then
              echo "native missing-LLM watchdog process group did not terminate: ${APP_PGID}" >&2
              cleanup_status=1
            fi
          fi
        fi
      fi
    fi
  fi
  if ! wait_for_process_group_state 100 process_group_has_members; then
    echo "native missing-LLM watchdog process group was not fully reaped: ${APP_PGID}" >&2
    cleanup_status=1
  fi
  if ! wait_for_port_release 100; then
    echo "native missing-LLM watchdog sidecar port did not release: ${PORT}" >&2
    cleanup_status=1
  fi
  if ! rm -rf "${TEST_HOME}"; then
    echo "native missing-LLM watchdog could not remove its isolated test home" >&2
    cleanup_status=1
  fi
  return "${cleanup_status}"
}

start_cleanup_watchdog() {
  set -m
  (
    trap - EXIT
    trap 'exit 0' HUP INT TERM
    while watchdog_owner_is_current; do
      sleep 0.05
    done
    watchdog_cleanup_owned_process_group
  ) &
  WATCHDOG_PID=$!
  set +m
  WATCHDOG_START_ID="$(read_process_start_id "${WATCHDOG_PID}" || true)"
  [[ -n "${WATCHDOG_START_ID}" ]] || return 1
  WATCHDOG_COMMAND_ID="$(read_process_command_id "${WATCHDOG_PID}" || true)"
  [[ -n "${WATCHDOG_COMMAND_ID}" ]] || return 1
  watchdog_is_live_direct_child || return 1
  watchdog_supervisor_claim_is_current || return 1
  write_process_identity_file "${WATCHDOG_IDENTITY_FILE}" "watchdog" "${WATCHDOG_PID}" \
    "${CALLER_SHELL_PID}" "${WATCHDOG_PID}" "${WATCHDOG_START_ID}" "${WATCHDOG_COMMAND_ID}" || return 1
  printf '%s\n' "${WATCHDOG_PID}" >"${WATCHDOG_PID_FILE}.tmp" || return 1
  mv "${WATCHDOG_PID_FILE}.tmp" "${WATCHDOG_PID_FILE}"
  write_watchdog_ready_file
}

stop_cleanup_watchdog() {
  if [[ -z "${WATCHDOG_PID}" || "${WATCHDOG_WAITED}" -eq 1 ]]; then
    return 0
  fi
  if ! watchdog_is_live_direct_child; then
    if kill -0 "${WATCHDOG_PID}" 2>/dev/null; then
      echo "native missing-LLM test refused to signal an unverified cleanup watchdog: ${WATCHDOG_PID}" >&2
      return 1
    fi
    wait "${WATCHDOG_PID}" 2>/dev/null || true
    WATCHDOG_WAITED=1
    return 0
  fi
  kill -TERM "${WATCHDOG_PID}" 2>/dev/null || true
  wait "${WATCHDOG_PID}" 2>/dev/null || true
  WATCHDOG_WAITED=1
}

cleanup() {
  local prior_status="$1"
  local cleanup_status=0
  local detected_status=0
  if [[ "${prior_status}" -eq 0 && -n "${APP_PID}" ]] &&
    { load_app_exit_status || ! app_is_live_owned_process; }; then
    load_app_exit_status || wait_for_app_exit_status 20 || true
    echo "native app exited before test cleanup (status ${APP_WAIT_STATUS:-unknown})" >&2
    detected_status=1
  fi
  if ! terminate_owned_process_group; then
    cleanup_status=1
  fi
  if ! wait_for_port_release 100; then
    echo "native missing-LLM test sidecar port did not release: ${PORT}" >&2
    cleanup_status=1
  fi
  if ! stop_cleanup_watchdog; then
    cleanup_status=1
  fi
  if [[ "${WATCHDOG_WAITED}" -eq 1 ]]; then
    if ! rm -rf "${TEST_HOME}"; then
      echo "native missing-LLM test could not remove its isolated test home" >&2
      cleanup_status=1
    fi
  else
    echo "native missing-LLM test retained its isolated home for the cleanup watchdog" >&2
    cleanup_status=1
  fi
  if [[ "${prior_status}" -ne 0 ]]; then
    if [[ "${cleanup_status}" -ne 0 ]]; then
      echo "native missing-LLM cleanup also failed (status ${cleanup_status})" >&2
    fi
    return "${prior_status}"
  fi
  if [[ "${detected_status}" -ne 0 ]]; then
    return "${detected_status}"
  fi
  return "${cleanup_status}"
}

cleanup_on_exit() {
  local prior_status=$?
  trap - EXIT
  cleanup "${prior_status}"
}
trap cleanup_on_exit EXIT

# 进程启动前先隔离所有用户目录和临时目录，禁止依赖应用内部二次修正。
CALLER_SHELL_PGID="$(ps -o pgid= -p "${CALLER_SHELL_PID}" 2>/dev/null | tr -d '[:space:]' || true)"
if [[ ! "${CALLER_SHELL_PGID}" =~ ^[0-9]+$ ]]; then
  echo "native missing-LLM test could not identify the caller shell process group" >&2
  exit 1
fi
CALLER_SHELL_START_ID="$(read_process_start_id "${CALLER_SHELL_PID}" || true)"
if [[ -z "${CALLER_SHELL_START_ID}" ]]; then
  echo "native missing-LLM test could not identify the caller shell start time" >&2
  exit 1
fi
CALLER_SHELL_COMMAND_ID="$(read_process_command_id "${CALLER_SHELL_PID}" || true)"
if [[ -z "${CALLER_SHELL_COMMAND_ID}" ]]; then
  echo "native missing-LLM test could not identify the caller shell command" >&2
  exit 1
fi
set -m
(
  # supervisor 在父进程主动清理前不得因子命令失败自行退出，以持续占有 PGID。
  set +e
  set +m
  # 外层完成直属子进程与独立进程组认领后，才允许启动真实 App。
  while [[ ! -f "${SUPERVISOR_START_FILE}" ]]; do
    if ! watchdog_owner_is_current; then
      rm -rf "${TEST_HOME}" || true
      exit 0
    fi
    sleep 0.01
  done
  HOME="${TEST_HOME}" \
  USERPROFILE="${TEST_HOME}" \
  CFFIXED_USER_HOME="${TEST_HOME}" \
  TMPDIR="${TEST_HOME}/tmp" \
  TEMP="${TEST_HOME}/tmp" \
  TMP="${TEST_HOME}/tmp" \
  HEXCLAW_TEST_MODE=1 \
  HEXCLAW_TEST_HOME="${TEST_HOME}" \
  HEXCLAW_SIDECAR_PORT="${PORT}" \
  "${APP_EXECUTABLE}" >"${LOG_FILE}" 2>&1 &
  supervised_app_pid=$!
  printf '%s\n' "${supervised_app_pid}" >"${APP_PID_FILE}.tmp"
  mv "${APP_PID_FILE}.tmp" "${APP_PID_FILE}"
  wait "${supervised_app_pid}"
  supervised_app_status=$?
  printf '%s\n' "${supervised_app_status}" >"${APP_STATUS_FILE}.tmp"
  mv "${APP_STATUS_FILE}.tmp" "${APP_STATUS_FILE}"
  # App 提前退出后保留已认领的进程组锚点，防止 PGID 被复用。
  while :; do
    sleep 1
  done
) &
SUPERVISOR_PID=$!
set +m
if ! claim_supervisor_process_group; then
  echo "native missing-LLM test could not isolate the app process group" >&2
  exit 1
fi
SUPERVISOR_START_ID="$(read_process_start_id "${SUPERVISOR_PID}" || true)"
if [[ -z "${SUPERVISOR_START_ID}" ]]; then
  echo "native missing-LLM test could not identify the app supervisor start time" >&2
  exit 1
fi
SUPERVISOR_COMMAND_ID="$(read_process_command_id "${SUPERVISOR_PID}" || true)"
if [[ -z "${SUPERVISOR_COMMAND_ID}" ]]; then
  echo "native missing-LLM test could not identify the app supervisor command" >&2
  exit 1
fi
write_process_identity_file "${SUPERVISOR_IDENTITY_FILE}" "supervisor" "${SUPERVISOR_PID}" \
  "${CALLER_SHELL_PID}" "${APP_PGID}" "${SUPERVISOR_START_ID}" "${SUPERVISOR_COMMAND_ID}"
if ! start_cleanup_watchdog; then
  echo "native missing-LLM test could not start its cleanup watchdog" >&2
  exit 1
fi
: >"${SUPERVISOR_START_FILE}"
for _ in {1..100}; do
  [[ -f "${APP_PID_FILE}" ]] && break
  if ! supervisor_is_live_owned_group_leader; then
    cat "${LOG_FILE}" >&2 || true
    echo "native app supervisor exited before publishing the app PID" >&2
    exit 1
  fi
  sleep 0.05
done
if [[ ! -f "${APP_PID_FILE}" ]]; then
  echo "native app supervisor did not publish the app PID" >&2
  exit 1
fi
IFS= read -r APP_PID <"${APP_PID_FILE}"
if [[ ! "${APP_PID}" =~ ^[0-9]+$ ]] || ! claim_app_process; then
  cat "${LOG_FILE}" >&2 || true
  if load_app_exit_status; then
    echo "native app exited before health became reachable" >&2
  else
    echo "native missing-LLM test could not verify the supervised app process" >&2
  fi
  exit 1
fi

for _ in {1..300}; do
  if load_app_exit_status || ! app_is_live_owned_process; then
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
SIDECAR_PIDS=()
while IFS= read -r listener_pid; do
  [[ -n "${listener_pid}" ]] && SIDECAR_PIDS+=("${listener_pid}")
done < <(lsof -nP -tiTCP:"${PORT}" -sTCP:LISTEN | sort -u)
if [[ "${#SIDECAR_PIDS[@]}" -ne 1 ]]; then
  echo "native missing-LLM test must own exactly one sidecar listener" >&2
  exit 1
fi
SIDECAR_PID="${SIDECAR_PIDS[0]}"
if ! claim_sidecar_listener; then
  if app_is_live_owned_process; then
    echo "native missing-LLM listener is not owned by the isolated app process group" >&2
  else
    echo "native app exited before test cleanup (status unknown)" >&2
  fi
  exit 1
fi

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

LLM_CONFIG_STATUS="$(curl --silent --show-error --max-time 2 --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:${PORT}/api/v1/config/llm")"
if [[ "${LLM_CONFIG_STATUS}" != "401" ]]; then
  echo "native missing-LLM runner expected unauthenticated config to require the sidecar capability, got HTTP ${LLM_CONFIG_STATUS}" >&2
  exit 1
fi

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
  throw new Error("profile catch-up advanced or was not the frozen overdue fixture: " + JSON.stringify(payload.profile));
}
  ' "${PHASE_FILE}"
fi

FINAL_CLEANUP_STATUS=0
cleanup 0 || FINAL_CLEANUP_STATUS=$?
trap - EXIT
if [[ "${FINAL_CLEANUP_STATUS}" -ne 0 ]]; then
  exit "${FINAL_CLEANUP_STATUS}"
fi
echo "REG-FIX-20260727-MISSING-LLM-STARTUP-001 native ${LLM_CONFIG_MODE} LLM startup (profile-catchup=${PROFILE_CATCHUP}): PASS"
