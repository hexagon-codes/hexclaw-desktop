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
