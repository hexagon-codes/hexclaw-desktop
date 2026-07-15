#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
RUN_ID="${HEX_MOCK_RUN_ID:-internal-poc-$(date +%Y%m%dT%H%M%S)-$$}"
RUN_ID="$(printf '%s' "${RUN_ID}" | tr -cs '[:alnum:]_.-' '-')"
NETWORK="hexclaw-${RUN_ID}"
CONTAINER="hexclaw-mockserver-${RUN_ID}"
ARTIFACT_DIR="${HEX_MOCK_ARTIFACT_DIR:-${REPO_ROOT}/test-results/mock-stack/${RUN_ID}}"
MOCK_IMAGE="${HEX_MOCKSERVER_IMAGE:-mockserver/mockserver:7.4.0@sha256:fed9b2089e021947f785d1f0bfda3723352bb2c1634ce7b0bcd42dfd1b0fd02f}"
PROBE_IMAGE="${HEX_MOCK_PROBE_IMAGE:-curlimages/curl:8.13.0@sha256:d43bdb28bae0be0998f3be83199bfb2b81e0a30b034b6d7586ce7e05de34c3fd}"

ensure_artifact_dir() {
  mkdir -p -- "${ARTIFACT_DIR}"
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  ensure_artifact_dir
  docker logs "${CONTAINER}" >"${ARTIFACT_DIR}/mockserver.log" 2>&1 || true
  docker inspect "${CONTAINER}" >"${ARTIFACT_DIR}/mockserver.inspect.json" 2>&1 || true
  docker rm --force "${CONTAINER}" >/dev/null 2>&1 || true
  docker network rm "${NETWORK}" >/dev/null 2>&1 || true
  exit "${status}"
}
trap cleanup EXIT INT TERM

if ! docker info >/dev/null 2>&1; then
  printf 'Docker daemon is unavailable. Start Docker Desktop and retry.\n' >&2
  exit 1
fi

ensure_artifact_dir
docker network create --internal \
  --label com.hexclaw.test-stack=mock \
  --label "com.hexclaw.test-run=${RUN_ID}" \
  "${NETWORK}" >/dev/null

# Deliberately no host port mapping: this admission PoC is safe on legacy
# Docker engines but cannot drive the host-side Desktop E2E lane.
docker run --detach \
  --name "${CONTAINER}" \
  --network "${NETWORK}" \
  --network-alias mockserver \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --memory 1g \
  --pids-limit 256 \
  --tmpfs /tmp:size=128m,mode=1777 \
  --label com.hexclaw.test-stack=mock \
  --label "com.hexclaw.test-run=${RUN_ID}" \
  -e MOCKSERVER_PROPERTY_FILE=/config/mockserver.properties \
  -e 'JAVA_TOOL_OPTIONS=-Xms64m -Xmx512m -XX:+ExitOnOutOfMemoryError' \
  -v "${SCRIPT_DIR}/fixtures:/config:ro" \
  "${MOCK_IMAGE}" >/dev/null

health=""
for _ in $(seq 1 "${HEX_MOCK_WAIT_SECONDS:-45}"); do
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${CONTAINER}")"
  if [[ "${health}" == "healthy" ]]; then
    break
  fi
  if [[ "$(docker inspect --format '{{.State.Running}}' "${CONTAINER}")" != "true" ]]; then
    printf 'MockServer exited before becoming healthy\n' >&2
    exit 1
  fi
  sleep 1
done
if [[ "${health}" != "healthy" ]]; then
  printf 'MockServer failed health admission: %s\n' "${health}" >&2
  exit 1
fi

ping_body="$(docker run --rm --network "${NETWORK}" "${PROBE_IMAGE}" \
  --fail --silent --show-error http://mockserver:1080/__hexclaw_mock__/ping)"
if [[ "${ping_body}" != *"hexclaw-infrastructure-ping"* ]]; then
  printf 'unexpected ping fixture: %s\n' "${ping_body}" >&2
  exit 1
fi

mock_curl() {
  docker run --rm --network "${NETWORK}" "${PROBE_IMAGE}" \
    --fail --silent --show-error "$@"
}

openai_nonstream="$(mock_curl \
  -H 'content-type: application/json' \
  -d '{"model":"hexclaw-mock","stream":false,"messages":[{"role":"user","content":"ping"}]}' \
  http://mockserver:1080/v1/chat/completions)"
if [[ "${openai_nonstream}" != *"HEXCLAW_MOCK_CHAT_OK"* ]]; then
  printf 'unexpected OpenAI non-stream fixture response\n' >&2
  exit 1
fi

openai_sse="$(mock_curl \
  --write-out $'\n%{content_type}' \
  -H 'content-type: application/json' \
  -d '{"model":"hexclaw-mock","stream":true,"messages":[{"role":"user","content":"ping"}]}' \
  http://mockserver:1080/v1/chat/completions)"
if [[ "${openai_sse}" != *"text/event-stream"* || \
      "${openai_sse}" != *"HEXCLAW_MOCK_CHAT_OK"* || \
      "${openai_sse}" != *"data: [DONE]"* ]]; then
  printf 'unexpected OpenAI SSE fixture response\n' >&2
  exit 1
fi

ollama_tags="$(mock_curl http://mockserver:1080/api/tags)"
if [[ "${ollama_tags}" != *'"models"'* || "${ollama_tags}" != *"hexclaw-mock:latest"* ]]; then
  printf 'unexpected Ollama tags fixture response\n' >&2
  exit 1
fi

ollama_embed="$(mock_curl \
  -H 'content-type: application/json' \
  -d '{"model":"hexclaw-embed:latest","input":["synthetic"]}' \
  http://mockserver:1080/api/embed)"
if [[ "${ollama_embed}" != *'"embeddings"'* ]]; then
  printf 'unexpected Ollama embed fixture response\n' >&2
  exit 1
fi

ollama_chat="$(mock_curl \
  --write-out $'\n%{content_type}' \
  -H 'content-type: application/json' \
  -d '{"model":"hexclaw-mock:latest","stream":true,"messages":[{"role":"user","content":"ping"}]}' \
  http://mockserver:1080/api/chat)"
if [[ "${ollama_chat}" != *"application/x-ndjson"* || \
      "${ollama_chat}" != *"HEXCLAW_MOCK_CHAT_OK"* ]]; then
  printf 'unexpected Ollama chat NDJSON fixture response\n' >&2
  exit 1
fi

ollama_pull="$(mock_curl \
  --write-out $'\n%{content_type}' \
  -H 'content-type: application/json' \
  -d '{"model":"hexclaw-mock:latest","stream":true}' \
  http://mockserver:1080/api/pull)"
if [[ "${ollama_pull}" != *"application/x-ndjson"* || \
      "${ollama_pull}" != *'"status":"success"'* ]]; then
  printf 'unexpected Ollama pull NDJSON fixture response\n' >&2
  exit 1
fi

ollama_delete="$(mock_curl \
  -X DELETE \
  -H 'content-type: application/json' \
  -d '{"model":"hexclaw-mock:latest"}' \
  http://mockserver:1080/api/delete)"
if [[ "${ollama_delete}" != *'"status":"success"'* ]]; then
  printf 'unexpected Ollama delete fixture response\n' >&2
  exit 1
fi

dingtalk_token="$(mock_curl \
  -H 'content-type: application/json' \
  -d '{"appKey":"synthetic-app-key","appSecret":"synthetic-app-secret"}' \
  http://mockserver:1080/v1.0/oauth2/accessToken)"
if [[ "${dingtalk_token}" != *'"accessToken"'* ]]; then
  printf 'unexpected DingTalk token fixture response\n' >&2
  exit 1
fi

dingtalk_media="$(mock_curl \
  -F 'type=image' \
  -F 'media=synthetic-media' \
  http://mockserver:1080/media/upload)"
if [[ "${dingtalk_media}" != *'"media_id"'* ]]; then
  printf 'unexpected DingTalk media fixture response\n' >&2
  exit 1
fi

dingtalk_send="$(mock_curl \
  -H 'content-type: application/json' \
  -d '{"robotCode":"synthetic-robot","userIds":["synthetic-user"],"msgKey":"sampleText","msgParam":"{}"}' \
  http://mockserver:1080/v1.0/robot/oToMessages/batchSend)"
if [[ "${dingtalk_send}" != *'"processQueryKey"'* ]]; then
  printf 'unexpected DingTalk send fixture response\n' >&2
  exit 1
fi

dingtalk_recall="$(mock_curl \
  -H 'content-type: application/json' \
  -d '{"robotCode":"synthetic-robot","processQueryKeys":["synthetic-process-query-key"]}' \
  http://mockserver:1080/v1.0/robot/otoMessages/batchRecall)"
if [[ "${dingtalk_recall}" != *'"successResult"'* ]]; then
  printf 'unexpected DingTalk recall fixture response\n' >&2
  exit 1
fi

unmatched_code="$(docker run --rm --network "${NETWORK}" "${PROBE_IMAGE}" \
  --silent --output /dev/null --write-out '%{http_code}' \
  http://mockserver:1080/not-configured)"
if [[ "${unmatched_code}" != "404" ]]; then
  printf 'unmatched request returned %s instead of 404\n' "${unmatched_code}" >&2
  exit 1
fi

if docker run --rm --network "${NETWORK}" "${PROBE_IMAGE}" \
  --fail --silent --connect-timeout 2 --max-time 3 \
  https://example.com >/dev/null 2>&1; then
  printf 'internal network unexpectedly reached the public internet\n' >&2
  exit 1
fi

docker stats --no-stream \
  --format 'name={{.Name}} mem={{.MemUsage}} cpu={{.CPUPerc}}' \
  "${CONTAINER}" | tee "${ARTIFACT_DIR}/resources.txt"
printf 'internal MockServer PoC passed: health=%s ping=200 protocol-matrix=passed unmatched=%s egress=blocked\n' \
  "${health}" "${unmatched_code}"
