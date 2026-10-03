**English** | [中文](updates.md)

# Auto-Update Release Guide

## v0.5.0-beta (2026-10-03)

This version updates CI checks and release documentation; see the [Changelog](../CHANGELOG.md). Routine CI validates source, `Package` builds installers on demand, and a version tag triggers `Release`. Results for these stages are recorded separately; local checks do not establish that a GitHub Release has been published.

HexClaw Desktop uses Tauri updater. To make the in-app “Check for Updates / Download and Install” flow actually work, all 4 conditions below must be true:

1. `plugins.updater.endpoints` in `src-tauri/tauri.conf.json` points to a stable, reachable update feed
2. `plugins.updater.pubkey` in `src-tauri/tauri.conf.json` matches the private signing key
3. The GitHub Actions `Release` workflow has access to `TAURI_SIGNING_PRIVATE_KEY`
4. Production builds are published from a tag so the workflow can generate signed updater artifacts and `latest.json`

## Local Packaging vs Production Releases

### Local Packaging

Use this for UI testing, internal QA, or manual installation.

- You can build without an updater private key
- The `Package` workflow disables updater artifacts automatically when the signing key is missing
- The resulting packages can still be installed manually
- In-app auto updates will not work

### Production Releases

Use this when you want real in-app auto updates.

- The updater private key is required
- When `TAURI_SIGNING_PRIVATE_KEY` is missing, the `Release` workflow disables updater artifacts automatically and still produces manually installable unsigned packages, but in-app auto updates will not work
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
"plugins": {
  "updater": {
    "pubkey": "..."
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
   - `HEXCLAW_REF` in `Makefile` (it must be `refs/tags/v<version>`)
2. Commit and push your changes
3. Verify the release version and matching backend tag, then create and push the release tag. Do not delete or move a published tag. These commands illustrate the entry point:

```bash
git tag v0.5.0-beta
git push origin v0.5.0-beta
```

4. Wait for the GitHub Actions `Release` workflow to finish
5. Confirm the GitHub Release contains:
   - `latest.json`
   - platform installers for macOS / Windows / Linux
   - the matching signed updater artifacts

## In-App Experience

The desktop app now covers both user-facing paths:

- a silent update check on launch
- a manual check/install entry on the **About** page

If the release has no artifacts signed for Tauri updater, the UI entry still exists, but users will not receive an installable updater package. A macOS build without Apple code signing can still have updater-signed artifacts.

## FAQ

### Why does local `pnpm tauri build` complain about a missing private key?

Because [src-tauri/tauri.conf.json](../src-tauri/tauri.conf.json) enables:

```json
"createUpdaterArtifacts": true
```

That tells Tauri to generate updater artifacts and sign them during build. If `TAURI_SIGNING_PRIVATE_KEY` is not exported in your shell, Tauri reports the missing signing key.

### Does this affect manual `.app` / `.dmg` distribution?

Not for the Tauri updater key alone. That only affects updater signing, not the ordinary installer packages.

Because the current release is an unsigned DMG (no Apple code signing or notarization), browser-downloaded `.dmg` / `.app` bundles are likely to be blocked by Gatekeeper as "damaged", and users will need to clear the quarantine flag manually (e.g. `xattr -dr com.apple.quarantine`).

### What does the workflow validate now?

- Routine `CI` retains lint, type-check, existing unit tests, the web build, and `cargo check`. Tests read private prototypes and fixtures with read-only credentials; model, IM, and native-window acceptance remain outside routine CI.
- `Package` and `Release` disable updater artifacts when `TAURI_SIGNING_PRIVATE_KEY` is missing and still produce manually installable unsigned packages.
- `Release` validates that the versions across `package.json` / `tauri.conf.json` / `Cargo.toml` and `HEXCLAW_REF` in `Makefile` match the tag.

### Do prereleases auto-update?

The current updater endpoint uses GitHub Releases `latest/download/latest.json`, which behaves like a stable channel. Whether prereleases should participate later is a separate channel decision.
