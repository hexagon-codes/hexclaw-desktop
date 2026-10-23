**English** | [中文](CONTRIBUTING.md)

# Contributing to HexClaw Desktop

Use [Issues](https://github.com/hexagon-codes/hexclaw-desktop/issues) to report problems or discuss proposals, and [Pull Requests](https://github.com/hexagon-codes/hexclaw-desktop/pulls) to submit changes. This guide explains how to start from the public repository and what environments different checks require.

## Report a problem

Use the [bug report form](https://github.com/hexagon-codes/hexclaw-desktop/issues/new?template=bug_report.yml) and provide the information available to you:

- App version, operating system, and architecture.
- Whether you use a local or cloud service.
- Provider and model, when relevant.
- Reproduction steps, expected result, and actual result.

Remove API Keys, access tokens, and personal data from logs and screenshots. For image, file, or IM issues, state whether you received the actual output so connection, processing, and delivery issues can be distinguished.

## Prepare the development environment

| Tool | Requirement |
| --- | --- |
| Node.js | Version 22.12.0 or later is recommended; the supported range is defined by `engines` in `package.json`. |
| pnpm | 10.30.3, pinned in `package.json`. |
| Rust | 1.94.0, pinned in `rust-toolchain.toml`. |
| Go | The current mainline backend needs 1.25.13 or later; use the selected backend version's `go.mod` for other versions. |
| System tools | Git, Make, Python 3, and curl. |
| Native dependencies | Install the dependencies for your platform from the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/). |

The current bundled local inference and document rendering components require macOS 14 or later. Linux releases are built on Ubuntu 22.04 and depend on WebKitGTK 4.1. See the [README](README.en.md#installation) for user installation.

```bash
git clone https://github.com/hexagon-codes/hexclaw-desktop.git
cd hexclaw-desktop
pnpm install --frozen-lockfile
```

## Native development on macOS

Prepare the Sidecar and bundled components, then start the desktop window:

```bash
make sidecar
make render-bundle
make ollama
make dev
```

The current Desktop source version is `0.5.0`. `make sidecar` builds the backend selected by `HEXCLAW_REF=refs/tags/v0.5.0` in the `Makefile` from the public HexClaw repository. Release packaging requires publishing that backend tag with the final fixes before building Desktop. Updating version metadata in both repositories does not create the tag or publish installers. The default source does not follow main; use `make sidecar-local` / `make build-local` to verify uncommitted backend changes during development. To use the latest main branch explicitly, use `make sidecar HEXCLAW_REF=origin/main` and check that frontend and backend contracts match.

The current `make render-bundle` shortcut applies to macOS. See the [Release workflow](.github/workflows/release.yml) for Windows and Linux native dependencies and component preparation.

Pinned official renderer archives are cached in `.render-bundle-cache/render-archives` beside the output directory, or under `RENDER_BUNDLE_CACHE_ROOT` when provided. Every reuse verifies archive hashes, sizes, members and extraction limits; invalid cache entries are downloaded again. Existing outputs remain until candidates are ready, and unchanged binary bytes retain their timestamps. The cache does not replace the version manifest or change build budgets.

Use `pnpm dev` to start only the frontend; actual tasks still require an accessible HexClaw service. Verify native files, previews, exports, printing, and installation through the corresponding desktop flow.

## Change the backend and desktop together

Place `hexclaw`, `ai-core`, `hexagon`, and `toolkit` beside the desktop repository, reference these modules in a `go.work` file in the parent directory, and run:

```bash
make sidecar-local
make render-bundle
make ollama
make dev
```

`make sidecar-local` includes committed code and uncommitted workspace changes. Rebuild the Sidecar after changing Go code. `make package-local` generates macOS installation artifacts from a complete local ecosystem workspace; it is not the default starting point for a standalone desktop clone.

## Synchronize product facts

About reads ecosystem links from `src/generated/product-facts.json`. The authoritative source is `engine/product_facts.json` in the HexClaw backend. Update that source first, then run these commands from the Desktop repository:

```bash
node scripts/sync-product-facts.mjs
node scripts/sync-product-facts.mjs --check
```

The default source is the adjacent `../hexclaw` checkout; set `HEXCLAW_SOURCE_ROOT` for another location. The generator recursively excludes objects marked `visibility: internal`, underscore-prefixed fields, and existing digest fields. It creates a public projection with stable key ordering and a `facts_digest`. Commit the script and generated JSON together rather than editing the generated file directly. These commands do not start services or call models. They are not currently wired into package scripts or CI; a manual check is not an existing automated gate.

## Choose checks relevant to the change

These frontend checks need only the public repository and installed Node.js dependencies:

```bash
pnpm lint
pnpm type-check
pnpm build-only
```

They correspond to CI linting, type checking, and frontend building. `pnpm build` also combines type checking and frontend building.

| Check | Environment and evidence |
| --- | --- |
| Relevant isolated unit tests | Run existing test files. For example, the knowledge retry contract test below uses repository code and API test doubles without live models or IM. Passing it proves only that program contract. |
| Full `pnpm test:unit` | Some cases depend on reference material or fixtures supplied by maintainers; a clean public clone does not include all of those dependencies. |
| Contract generation and checks | `pnpm contracts:check` needs sibling HexClaw backend source and the corresponding Go environment. |
| Rust and native builds | Require platform dependencies, the Rust toolchain, and prepared Sidecar, rendering engines, and resources. |
| Visual, live API, model, IM, and installation verification | Prepare the relevant references, active service, model, connected channel, or native app. Frontend builds and test doubles do not replace real outputs. |

Example isolated test command:

```bash
pnpm exec vitest run src/api/__tests__/knowledge-retry-intent.test.ts
```

See [package.json](package.json) for the complete command list. If reference material or an environment is missing, state what is missing and coordinate the corresponding check with maintainers. Do not remove assertions or skip failures to claim success. Existing CI gates remain unchanged; forks without maintainer resources are not guaranteed to run or pass every CI check directly.

### Maintain the test environment and current contracts

- jsdom is not a browser. Adapt missing standard APIs in the shared [Vitest setup](src/test/vitest-setup.ts). For example, use the standard `CSS.escape` polyfill rather than changing production selectors or returning unescaped values for fixtures. The `ResizeObserver` adapter supplies lifecycle methods only; it does not verify layout or dimensions.
- Test authors must follow the [current CI workflow](.github/workflows/ci.yml) and this section's testing rules, including toolchains, lockfiles, actual commands, shared initialization, and the pinned `HEXCLAW_DOCS_TEST_REF`. An uncommitted local prototype is not the CI reference. Run the relevant entry points before delivery and record platform differences; isolated passing cases do not establish CI readiness.
- Prefer real pure functions, Markdown parsers, and sanitizers. Necessary module doubles should preserve unrelated real exports and replace only controlled boundaries such as HTTP or native bridges. A newly exported helper should not disappear from unrelated tests because of a whole-module fake.
- When a component depends on routing, service scope, or durable tasks, establish that context in its fixture. Preserve request, ownership, state, idempotency, and receipt assertions; do not dismiss a real contract failure as a mock issue.
- Unit tests verify requests, identity, state, idempotency, data, and side effects. Remove tests of layout, font size, colors, icons, fixed copy, classes, or source inventories when they provide no independent business checks, rather than rewriting assertions after every UI change. Preserve concrete HTTP contracts and action behavior. Verify display against the actual page and prototype; source strings and unit tests do not replace that evidence.
- Before a full run, explain why targeted evidence is insufficient and reuse evidence whose relevant conditions have not changed. Preserve fixed CI gates and obtain the applicable authorization for live models, IM, and native operations. A local result describes its recorded environment; it does not mean that an unexecuted GitHub Actions run passed.

## Submit a Pull Request

Describe the problem, scope, verification method, and results. Clearly identify native, model, or delivery boundaries that have not been checked. Update relevant user documentation and contracts when public APIs or task behavior change.

Update the corresponding Chinese and English documentation in the same Pull Request. Keep usage summaries in the README and link detailed contracts to the backend or scenario API guide. Release notes must describe the actual Tag; distinguish installer, backend, and screenshot versions. Updating source documentation does not publish an installer or deploy the website.

Keep changes focused, preserving unrelated code and effective checks. Maintain shared behavior through existing components and modules rather than introducing a separate task flow for a single page.

## Resources

- [User guide](docs/guide.en.md) / [中文指南](docs/guide.md).
- [Claude Code development SOP (Chinese)](docs/claude-code-practices/README.md): design-driven development, verification, and multi-agent collaboration methods, plus reusable commands and templates.
- [License](LICENSE) / [Third-party components](THIRD_PARTY.md).
