# Browser Runtime

This directory is populated by `scripts/ci/browser-runtime-package.mjs` before packaging.
It contains the pinned Node.js runtime, official Playwright MCP dependencies and the
matching Chromium distribution. Generated resources are not committed.

The tracked directory allows `cargo check` to run without downloading a browser.
Only a verified `manifest.json` and complete resource inventory indicate a usable runtime.

The bundled browser features require macOS 14 or later. The application baseline
is macOS 12; component requirements are tracked separately. The release
resource targets are macOS arm64/x64, Linux x64 and Windows x64. Linux requires the
system libraries listed in the matching Playwright browser documentation; successful
cross-target staging does not establish execution compatibility on that platform.
