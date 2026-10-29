**English** | [中文](updates.md)

# Auto-Update Release Guide

## v0.5.2 (2026-10-29)

Desktop source version is `0.5.2`. Changes include persistent PDF attachment recovery, preview and download, conditional file caching, conversation persona and draft recovery, and model configuration and supplementary-practice error fixes; see the [Changelog](../CHANGELOG.md).

The coordinated backend target is HexClaw `v0.5.2` with Hub `v0.1.0`; the backend owns Hub resource references. The `Makefile` currently retains the existing `refs/tags/v0.5.1` so builds do not check out an unavailable tag. Release order is: verify backend CI and deployment for the fixed source → publish the immutable backend `v0.5.2` tag → update Desktop `HEXCLAW_REF` and this guide → verify Desktop CI and four-platform installers from the fixed commit → publish the Desktop tag and installers.

This version preparation does not create tags, publish installers, or update a running service. Continue using `make sidecar-local` / `make build-local` for uncommitted local backend source. Record real model, file, and IM acceptance against their actual source and artifact identities; the `0.5.2` version alone does not establish that a running artifact includes the fixes.

## v0.5.1 (2026-10-26)

Desktop version metadata is `0.5.1`; see the [Changelog](../CHANGELOG.md) for the source changes. The backend source is pinned to `refs/tags/v0.5.1`, resolving to commit [`899ce739f128`](https://github.com/hexagon-codes/hexclaw/commit/899ce739f128a01bc23fec0af5d7ff33686ecace), which passed [backend CI](https://github.com/hexagon-codes/hexclaw/actions/runs/40328692622) and the [deployment workflow](https://github.com/hexagon-codes/hexclaw/actions/runs/40329970325).

The Desktop Release workflow checks out this immutable tag to build the Sidecar. The [backend Release](https://github.com/hexagon-codes/hexclaw/releases/tag/v0.5.1) is published, and all five platform archives and checksums have been downloaded and verified. The [release workflow](https://github.com/hexagon-codes/hexclaw/actions/runs/40331306722) recovered successfully without changing the tag target.

`HEXCLAW_REF` in `Makefile` and the current-version documentation remain synchronized. Desktop releases independently verify CI, four-platform packaging for the same fixed commit, and the tag publication result. Matching version numbers, a successful backend render workflow alone, or a local workspace build do not establish backend source identity or remote CI success.

This version preparation keeps the existing CI / Release workflows, four-platform matrix, unsigned macOS distribution, and Homebrew Cask. Tauri updater signing and Apple code signing retain their separate roles described below.

## v0.5.0 (2026-10-19)

Desktop version metadata is `0.5.0`, with release backend source pinned to `refs/tags/v0.5.0`. See the [Changelog](../CHANGELOG.md) for the October 21 source additions. A matching version number does not establish that a published installer, installed app, or cloud service includes those commits; verify source commits and artifact identities separately.

Release packaging must use a published backend tag containing the relevant fixes and passing the existing CI. The existing `v0.5.0` tag does not gain later fixes when a working tree changes. Subsequent releases need a new valid version; do not move pushed tags or change the pinned source as part of documentation synchronization. Use `make sidecar-local` / `make build-local` to verify current local ecosystem source. Workflows, platform matrices, deployment branches, and distribution channels remain unchanged.

## v0.5.0-beta.3 (2026-10-04)

This Desktop version is `v0.5.0-beta.3`, with backend source kept at `v0.5.0-beta.1`; see the [Changelog](../CHANGELOG.md). The two workflow entry points, `CI` and `Release`, share the existing gates. A manual `Release` run only builds test installers; a Desktop version tag builds a draft Release and publishes it after every platform build succeeds. Results for these stages are recorded separately; local checks do not establish that a GitHub Release has been published.

HexClaw Desktop uses Tauri updater. To make the in-app “Check for Updates / Download and Install” flow actually work, all 4 conditions below must be true:

1. `plugins.updater.endpoints` in `src-tauri/tauri.conf.json` points to a stable, reachable update feed
2. `plugins.updater.pubkey` in `src-tauri/tauri.conf.json` matches the private signing key
3. The GitHub Actions `Release` workflow has access to `TAURI_SIGNING_PRIVATE_KEY`
4. Production builds are published from a tag so the workflow can generate signed updater artifacts and `latest.json`

## Local Packaging vs Production Releases

### Local Packaging

Use this for UI testing, internal QA, or manual installation.

- You can build without an updater private key
- Both manual packaging and tag publication in `Release` disable updater artifacts automatically when the signing key is missing
- The resulting packages can still be installed manually
- A package built without the signing key and with updater artifact generation disabled cannot be an update target; the installed app can still check its configured feed for later valid signed versions

After preparing bundled components using the [README source development steps](../README.en.md#source-development), you can disable updater artifact generation for a single local build if you only need manually installable packages:

```bash
pnpm tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}'
```

This overrides only that build, without changing the project defaults or CI. Release artifacts intended for automatic updates still use the signing flow below.

### Production Releases

Use this when you want real in-app auto updates.

- The updater private key is required
- When `TAURI_SIGNING_PRIVATE_KEY` is missing, the `Release` workflow disables updater artifacts automatically and still produces manually installable packages, but that version cannot be an updater target
- For auto updates to work, the GitHub Release must contain `latest.json` and signed updater artifacts

## One-Time Setup

### 1. Generate updater signing keys

```bash
pnpm tauri signer generate -w ~/.tauri/hexclaw-updater.key
```

This gives you:

- a private key file
- a public key string

### 2. Commit the public key

Write the generated public key into [src-tauri/tauri.conf.json](../src-tauri/tauri.conf.json):

```json
{
  "plugins": {
    "updater": {
      "pubkey": "..."
    }
  }
}
```

### 3. Configure GitHub Secrets

Set these repository secrets:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

If your private key has no password, the second secret can stay empty or be omitted.

> **About macOS code signing**: the current release flow builds an **unsigned DMG** — no Apple code signing or notarization is performed. `TAURI_SIGNING_PRIVATE_KEY` is used only to sign updater artifacts and is unrelated to Apple code signing.

## Release Flow

1. Update the version in all of these files:
   - `package.json`
   - `src-tauri/tauri.conf.json`
   - `src-tauri/Cargo.toml`
   - the `hexclaw-desktop` root package version in `src-tauri/Cargo.lock`
2. Confirm that the backend commit containing the required fixes has passed CI and has an immutable SemVer tag, then verify that `HEXCLAW_REF` in `Makefile` pins that tag, currently configured as `refs/tags/v0.5.1`. Metadata may be prepared earlier, but remote release builds must wait until the tag is available. Check publication of backend Release artifacts separately; backend and Desktop source versions remain independent. The bundled Sidecar artifact identity is injected from its Desktop release version; verify the actual backend source commit as well, since that identity alone does not prove the source was updated.
3. Commit and push your changes, and confirm that routine CI passes. Trigger `Release` manually with the fixed SHA of the pushed commit and confirm that all four platform installer builds pass. A manual run uploads workflow artifacts without publishing a GitHub Release:

```bash
DESKTOP_REF="$(git rev-parse HEAD)"
gh workflow run release.yml -f ref="$DESKTOP_REF"
```

4. Verify those build results, then create and push the Desktop release tag. Do not delete or move a published tag. These commands illustrate the entry point:

```bash
DESKTOP_TAG="v$(node -p "require('./package.json').version.replace(/^v/, '')")"
git tag "$DESKTOP_TAG"
git push origin "$DESKTOP_TAG"
```

5. Wait for the tag-triggered `Release` workflow to finish; the Release remains a draft during builds and becomes public only after every platform succeeds
6. Confirm the public GitHub Release contains:
   - platform installers for macOS / Windows / Linux
   - `latest.json` and matching signed updater artifacts when updater signing is enabled

### Homebrew Cask and Beta Releases

The `Release` workflow updates the Cask after each tag Release is published, using the same flow for stable and Beta versions. Manual packaging does not update the Tap. The one-line installer selects the latest published Release, including Beta, and does not install Draft releases.

Publish the Desktop release and confirm that both macOS DMGs are downloadable before updating the [Homebrew Cask](https://github.com/hexagon-codes/homebrew-tap/blob/main/Casks/hexclaw.rb). Its version must match the Desktop Release. Calculate the ARM and Intel SHA256 values from the published `HexClaw_<version>_aarch64.dmg` and `HexClaw_<version>_x64.dmg`, respectively, and verify that both architecture URLs point to the correct installers for that version. A successful backend tag release does not verify the Desktop installers or Cask. macOS distribution continues to use unsigned DMGs without Apple code signing or notarization.

## In-App Experience

The desktop app now covers both user-facing paths:

- a silent update check on launch
- a manual check/install entry on the **About** page

A version without Tauri-signed updater artifacts cannot be installed through the updater, but its update-check entry remains available and can read later valid versions from the configured feed. The feed must provide the correct platform artifact and signature, with a target version accepted by the updater. A macOS build without Apple code signing can still have updater-signed artifacts.

## FAQ

### Why does local `pnpm tauri build` complain about a missing private key?

Because [src-tauri/tauri.conf.json](../src-tauri/tauri.conf.json) enables:

```json
{
  "bundle": {
    "createUpdaterArtifacts": true
  }
}
```

That tells Tauri to generate updater artifacts and sign them during build. If `TAURI_SIGNING_PRIVATE_KEY` is not exported in your shell, Tauri reports the missing signing key.

### Does this affect manual `.app` / `.dmg` distribution?

Not for the Tauri updater key alone. That only affects updater signing, not the ordinary installer packages.

Because the current release is an unsigned DMG (no Apple code signing or notarization), browser-downloaded `.dmg` / `.app` bundles are likely to be blocked by Gatekeeper as "damaged", and users will need to clear the quarantine flag manually (e.g. `xattr -dr com.apple.quarantine`).

### What does the workflow validate now?

- Routine `CI` retains lint, type-check, existing unit tests, package gates, the web build, and `cargo check`; `Release` reuses those CI gates. Tests read private prototypes and fixtures with read-only credentials; model, IM, and native-window acceptance remain outside routine CI.
- Manual packaging and tag publication in `Release` use the same four-platform installer build steps. Manual runs only upload workflow artifacts; tag runs publish the draft Release after every build succeeds.
- `Release` disables updater artifacts when `TAURI_SIGNING_PRIVATE_KEY` is missing and still produces manually installable unsigned packages.
- `Release` validates that the Desktop versions across `package.json` / `tauri.conf.json` / `Cargo.toml` match the release tag and independently checks that `HEXCLAW_REF` in `Makefile` is a fixed valid backend SemVer tag. The backend source does not have to share the Desktop version; the bundled Sidecar artifact identity still matches its Desktop release version.

### Do prereleases auto-update?

The current updater endpoint uses GitHub Releases `latest/download/latest.json`, which behaves like a stable channel. Whether prereleases should participate later is a separate channel decision.
