**English** | [中文](updates.md)

# Auto-Update Release Guide

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
- The `Release` workflow now fails immediately when `TAURI_SIGNING_PRIVATE_KEY` is missing
- A successful GitHub Release must contain `latest.json` and signed updater artifacts

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

## Release Flow

1. Update the version in all of these files:
   - `package.json`
   - `src-tauri/tauri.conf.json`
   - `src-tauri/Cargo.toml`
2. Commit and push your changes
3. Create and push a tag, for example:

```bash
git tag v0.0.3
git push origin v0.0.3
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

If you publish an unsigned build, the UI entry still exists, but users will not receive a real installable updater package.

## FAQ

### Why does local `pnpm tauri build` complain about a missing private key?

Because [src-tauri/tauri.conf.json](../src-tauri/tauri.conf.json) enables:

```json
"createUpdaterArtifacts": true
```

That tells Tauri to generate updater artifacts and sign them during build. If `TAURI_SIGNING_PRIVATE_KEY` is not exported in your shell, Tauri reports the missing signing key.

### Does this affect manual `.app` / `.dmg` distribution?

No. It affects updater signing, not the ordinary installer packages.

### Do prereleases auto-update?

The current updater endpoint uses GitHub Releases `latest/download/latest.json`, which behaves like a stable channel. Whether prereleases should participate later is a separate channel decision.
