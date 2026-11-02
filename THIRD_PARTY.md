# Third-Party Software

HexClaw Desktop includes the following third-party software:

## Ollama

- **Project:** https://github.com/ollama/ollama
- **License:** MIT License
- **Usage:** Embedded as the local LLM inference engine for running models on-device.
- **Copyright:** Copyright (c) Ollama

The full MIT License text is available at:
https://github.com/ollama/ollama/blob/main/LICENSE

## Pandoc

- **Project:** https://github.com/jgm/pandoc
- **License:** GPL-2.0-or-later
- **Usage:** Bundled as a standalone subprocess binary, invoked via `exec.Command` to render markdown into docx / pdf / epub / odt / rtf / txt / html. Pandoc runs in its own process; HexClaw source code does **not** link against Pandoc as a library, so the GPL does not extend beyond the Pandoc binary itself.
- **Copyright:** Copyright (c) John MacFarlane

The full GPL-2.0-or-later License text is available at:
https://github.com/jgm/pandoc/blob/main/COPYRIGHT

## Typst

- **Project:** https://github.com/typst/typst
- **License:** Apache-2.0
- **Usage:** Bundled as a standalone subprocess binary, used by Pandoc as the default PDF engine (`--pdf-engine=typst`).
- **Copyright:** Copyright (c) The Typst Project Developers

The full Apache-2.0 License text is available at:
https://github.com/typst/typst/blob/main/LICENSE

## Node.js

- **Project:** https://nodejs.org/
- **License:** MIT, with bundled third-party notices
- **Version:** 22.23.4
- **Usage:** Bundled runtime for the managed browser MCP process. No system Node.js installation is required.

The distribution license and third-party notices are included in `browser-runtime/node/LICENSE`.

## Playwright and Playwright MCP

- **Projects:** https://github.com/microsoft/playwright and https://github.com/microsoft/playwright-mcp
- **License:** Apache-2.0
- **Versions:** Playwright MCP 0.0.84; Playwright and playwright-core 1.65.0-alpha-2026-10-30
- **Usage:** The official MCP server and browser driver run as a managed subprocess.

Original license and notice files are retained in the corresponding packages under `browser-runtime/node_modules/`.

## Chromium / Chrome for Testing

- **Projects:** https://www.chromium.org/ and https://github.com/GoogleChromeLabs/chrome-for-testing
- **Version:** 157.0.8103.15 (Playwright browser revision 1252)
- **Usage:** Matching browser distribution delivered through the official Playwright CDN.

Chromium and its components have their respective licenses, including the Chromium BSD license.
The browser's bundled third-party notices are available at `chrome://credits`; license files in
the official browser archive are retained. Chrome for Testing distribution terms are available
at https://www.google.com/chrome/terms/.

This browser runtime requires macOS 14 or later for browser features; the application's
existing macOS minimum is unchanged. Linux and Windows runtime requirements follow the
matching Playwright distribution, and resource staging alone is not a platform acceptance result.
