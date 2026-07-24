#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ARTIFACT_DIR="${HEX_NATIVE_MATH_ARTIFACT_DIR:-${REPO_ROOT}/test-results/native-wkwebview-math}"
BUILD_DIR="${ARTIFACT_DIR}/build"
FIXTURE_HTML="${ARTIFACT_DIR}/fixture.html"
REPORT="${ARTIFACT_DIR}/report.json"
SCREENSHOT="${ARTIFACT_DIR}/wkwebview-math.png"
PROBE_EXECUTABLE="${BUILD_DIR}/WKWebViewMathVisibilityProbe"
SERVER_LOG="${ARTIFACT_DIR}/fixture-server.log"
SERVER_PORT=16062
SERVER_PID=""

cleanup() {
  local probe_status=$?
  trap - EXIT INT TERM
  if [[ -n "${SERVER_PID}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    kill -TERM "${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
  fi
  exit "${probe_status}"
}

trap cleanup EXIT INT TERM

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf 'native WKWebView math visibility probe currently supports macOS only\n' >&2
  exit 1
fi

for tool in curl lsof node rg swiftc; do
  if ! command -v "${tool}" >/dev/null 2>&1; then
    printf 'missing required command: %s\n' "${tool}" >&2
    exit 1
  fi
done

shopt -s nullglob
DIST_ASSET_DIR="${REPO_ROOT}/dist/assets"
BUILT_INDEX_CSS_FILES=("${DIST_ASSET_DIR}"/index-*.css)
BUILT_CSS_FILES=("${DIST_ASSET_DIR}"/*.css)
if [[ "${#BUILT_INDEX_CSS_FILES[@]}" -ne 1 || "${#BUILT_CSS_FILES[@]}" -lt 2 ]]; then
  printf 'expected a complete production CSS build with index and lazy chunks; run pnpm build first\n' >&2
  printf 'found %s index CSS candidate(s) and %s total CSS asset(s) under %s\n' \
    "${#BUILT_INDEX_CSS_FILES[@]}" "${#BUILT_CSS_FILES[@]}" "${DIST_ASSET_DIR}" >&2
  exit 1
fi
if ! rg --quiet 'hc-msg__math--display' "${BUILT_CSS_FILES[@]}"; then
  printf 'production CSS chunks are missing the MessageText display-math rule\n' >&2
  printf 'found %s candidate(s) under %s\n' \
    "${#BUILT_CSS_FILES[@]}" "${DIST_ASSET_DIR}" >&2
  exit 1
fi
if ! rg --quiet 'hc-math-viewport--scrollable' "${BUILT_CSS_FILES[@]}"; then
  printf 'production CSS chunks are missing the structural math viewport rule\n' >&2
  exit 1
fi
if ! rg --quiet 'padding-block:0?\.4em' "${BUILT_CSS_FILES[@]}"; then
  printf 'production CSS chunks are missing the evidence-backed 0.4em math viewport guard\n' >&2
  exit 1
fi
if rg --quiet -- \
  '--hc-math-scroll-padding-block-(start|end)' \
  "${BUILT_CSS_FILES[@]}"; then
  printf 'production CSS still contains the abandoned dynamic ink-padding contract\n' >&2
  exit 1
fi

mkdir -p "${BUILD_DIR}"
node "${SCRIPT_DIR}/wkwebview-math-fixture.mjs" "${DIST_ASSET_DIR}" "${FIXTURE_HTML}"
if [[ -n "$(lsof -nP -iTCP:"${SERVER_PORT}" -sTCP:LISTEN -t 2>/dev/null || true)" ]]; then
  printf 'native WKWebView fixture port %s is already occupied\n' "${SERVER_PORT}" >&2
  exit 1
fi
node "${SCRIPT_DIR}/wkwebview-math-fixture.mjs" \
  --serve \
  "${ARTIFACT_DIR}" \
  "${DIST_ASSET_DIR}" \
  "${SERVER_PORT}" \
  >"${SERVER_LOG}" 2>&1 &
SERVER_PID=$!

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl --fail --silent --show-error \
    "http://127.0.0.1:${SERVER_PORT}/fixture.html" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done
if ! curl --fail --silent --show-error \
  "http://127.0.0.1:${SERVER_PORT}/fixture.html" >/dev/null; then
  printf 'native WKWebView fixture server did not become ready; log=%s\n' \
    "${SERVER_LOG}" >&2
  exit 1
fi

xcrun swiftc \
  -framework AppKit \
  -framework WebKit \
  "${SCRIPT_DIR}/WKWebViewMathVisibilityProbe.swift" \
  -o "${PROBE_EXECUTABLE}"

"${PROBE_EXECUTABLE}" \
  "http://127.0.0.1:${SERVER_PORT}/fixture.html" \
  "${REPO_ROOT}" \
  "${REPORT}" \
  "${SCREENSHOT}"
