# Related Work / 相关项目

HexClaw is an independently implemented local-first AI Agent desktop stack.

This document records public projects in the same problem space for transparency. It is not a third-party license notice and does not imply that HexClaw is based on, derived from, or dependent on these projects.

## Scope

- HexClaw does not copy source code, documentation text, prompts, images, trademarks, or other assets from the projects below unless explicitly stated in a third-party notice.
- Similarity at the level of problem space, such as memory, skills, tool use, messaging adapters, self-improving workflows, or local-first execution, should be treated as related work rather than dependency or lineage.
- If HexClaw ever copies, adapts, or vendors third-party code, documentation, or assets, the original copyright and license notices must be preserved in the relevant source files and/or a dedicated third-party notice file.
- External ownership or originality disputes between other projects are outside the scope of this document.

## Related Public Projects

### OpenClaw

- Project: https://github.com/openclaw/openclaw
- Relevance: multi-platform messaging adapters, local gateway architecture, and broad IM/Bot integration.
- HexClaw boundary: HexClaw focuses on a local desktop workbench, Go sidecar delivery, local data ownership, MCP runtime management, and Hexagon Agent orchestration.

### EvoMap / Evolver

- Project: https://github.com/EvoMap/evolver
- Relevance: self-evolution for agent systems, auditable evolution assets, protocol-constrained evolution prompts, and reviewable capability iteration.
- HexClaw boundary: HexClaw's Skills loop is designed around Hexagon Agent, Go-sidecar execution, local desktop workflows, and human-reviewable Skill drafts. HexClaw does not copy Evolver source code, documentation, prompts, or assets.

### Hermes Agent

- Project: https://github.com/NousResearch/hermes-agent
- Relevance: writable runtime, dynamic Skill write-back, multi-provider agent execution, and public discussion around self-learning Agent workflows.
- HexClaw boundary: HexClaw treats Hermes Agent as related work in the broader agent ecosystem. HexClaw does not copy Hermes Agent source code, documentation, prompts, or assets.

## HexClaw Implementation Stance

HexClaw's own architecture is built around:

- Hexagon Agent
- Go sidecar architecture
- Tauri desktop delivery
- local-first data ownership
- human-reviewable Skill drafts
- MCP runtime management
- explicit safety boundaries for tool execution, memory, and Skill updates

The goal is to solve local desktop Agent workflows with transparent execution, reviewable evolution, and private data ownership. Public projects in the same ecosystem can help describe the problem space, but HexClaw's implementation, release path, and safety model remain its own.

## Attribution Policy

- Use `Related Work` when discussing public projects that address similar problems.
- Use `THIRD_PARTY_NOTICES.md`, source-file headers, or license-preserving notices when third-party code, documentation, prompts, or assets are copied or adapted.
- Do not describe HexClaw as "based on", "derived from", or "built on top of" another project unless that is technically true and the dependency/license notices are present.
