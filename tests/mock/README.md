# Desktop mock test stack

This directory is the local Docker deployment shell for deterministic HexClaw
Desktop tests. MockServer owns protocol fixtures; Docker Compose owns only
process isolation and lifecycle. Kubernetes is intentionally not involved.

## Safety boundary

- Published ports use a random host port bound to `127.0.0.1`.
- The Compose network is `internal`, so mock containers have no outbound route.
- Images are version-and-digest pinned. Fixtures are mounted read-only; there is
  no Docker socket mount.
- Containers are read-only, capability-free, memory/PID limited, and use
  `no-new-privileges` plus a bounded tmpfs.
- MockServer proxy fallback, MCP, live-LLM configuration, WASM, persistence, and
  executable response templates are disabled. The contract test admits only
  passive `httpResponse` fixture actions.
- Cleanup selects both `com.hexclaw.test-stack=mock` and the exact run label. It
  never runs a Docker-wide prune.

Do not add real user documents, images, tokens, webhooks, or captured personal
data here. Add synthetic cases to both `fixtures/manifest.json` and
`fixtures/mockserverInitialization.json`; `pnpm mock:validate` verifies their
one-to-one mapping and action allowlist.

The smoke matrix currently exercises OpenAI JSON/SSE, Ollama JSON/NDJSON and
DingTalk token/media/send/recall endpoints. These fixtures admit the selected
engine; they are not a second provider contract source of truth.

## Commands

```sh
pnpm mock:validate
pnpm mock:preflight
pnpm mock:up
pnpm mock:wait
pnpm mock:logs
pnpm mock:down
```

`mock:up` stores the random endpoint in
`test-results/mock-stack/manual/endpoints.env` and writes a mode-0600
`run-manifest.json` beside it. The manifest records the Desktop revision/dirty
state, selected HexClaw source, fixture and ownership hashes, test lane, and
pinned MockServer digest. It never copies arbitrary environment variables.
For an automated, uniquely labelled lifecycle use the wrapper directly:

```sh
tests/mock/mock-stack.sh run -- your-test-command
```

Set `HEX_MOCK_TEST_LANE` to a key in `ownership.json`; the default is
`l3-engine-smoke`. `pnpm test:e2e:mock` selects `l4a-browser-sidecar` and an
explicit local HexClaw source automatically.

Set `HEX_MOCK_CHAOS=1` to include Toxiproxy. Its control and proxy ports are
also random and loopback-only; create only proxies whose upstream is another
container on `mock_isolated`.

Docker Engine 28 or newer is required because older engines do not meet the
loopback publishing security baseline. The legacy override printed by
`mock:preflight` is for an explicitly isolated machine only.

## Playwright L4 lane

`playwright.mock.config.ts` is for Browser UI + real Sidecar tests, not native
Tauri-window tests. Start the test-sandbox Sidecar first and explicitly publish
its loopback URL:

```sh
export HEX_E2E_SIDECAR_URL=http://127.0.0.1:16060
pnpm test:e2e:mock
```

The lifecycle wrapper exports the random `HEX_MOCKSERVER_URL` to Playwright.
Each `browser-mock-*.spec.ts` should use that value to configure its sandboxed
provider/channel. Global setup probes both the real Sidecar `/health` endpoint
and the synthetic MockServer ping before a scenario starts. Workers stay at 1;
trace, screenshot, video, Compose logs, and container inspection are retained
when a run fails.
