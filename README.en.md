<div align="center">

**English** | [中文](README.md)

<img src=".github/assets/logo.png" alt="HexClaw Logo" width="160">

# HexClaw Desktop

**Enterprise-grade secure personal AI Agent all-in-one desktop client**

[![CI](https://github.com/hexagon-codes/hexclaw-desktop/workflows/CI/badge.svg)](https://github.com/hexagon-codes/hexclaw-desktop/actions)
[![Release](https://img.shields.io/github/v/release/hexagon-codes/hexclaw-desktop?include_prereleases)](https://github.com/hexagon-codes/hexclaw-desktop/releases)
[![License](https://img.shields.io/github/license/hexagon-codes/hexclaw-desktop)](https://github.com/hexagon-codes/hexclaw-desktop/blob/main/LICENSE)
[![Downloads](https://img.shields.io/github/downloads/hexagon-codes/hexclaw-desktop/total)](https://github.com/hexagon-codes/hexclaw-desktop/releases)
[![Stars](https://img.shields.io/github/stars/hexagon-codes/hexclaw-desktop?style=social)](https://github.com/hexagon-codes/hexclaw-desktop)

**Built with**

[![Tauri](https://img.shields.io/badge/Tauri-v2-FFC131?logo=tauri&logoColor=white)](https://v2.tauri.app)
[![Vue](https://img.shields.io/badge/Vue-3-4FC08D?logo=vuedotjs&logoColor=white)](https://vuejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Rust](https://img.shields.io/badge/Rust-2021-DEA584?logo=rust&logoColor=white)](https://www.rust-lang.org)
[![Go](https://img.shields.io/badge/Go-1.23-00ADD8?logo=go&logoColor=white)](https://go.dev)

**Powered by**

<a href="https://github.com/hexagon-codes/hexagon"><img src="https://img.shields.io/badge/🔷_Hexagon-Agent_Engine-4A90D9?style=for-the-badge" alt="Hexagon"></a>
<a href="https://github.com/hexagon-codes/hexclaw"><img src="https://img.shields.io/badge/🦀_HexClaw-Backend-F74C00?style=for-the-badge" alt="HexClaw"></a>

[**🌐 hexclaw.net**](https://hexclaw.net) · [📖 Docs](https://hexclaw.net/en/docs/) · [⬇️ Download](https://github.com/hexagon-codes/hexclaw-desktop/releases)

Native macOS / Windows / Linux · Sidecar local deployment · Zero cloud dependency · Full data privacy

</div>

---

<!-- TODO: Add screenshots
<p align="center">
  <img src=".github/assets/screenshots/chat.png" alt="Chat UI" width="800" />
</p>
-->

## Features

| Feature | Description |
|---------|-------------|
| **AI Chat** | Multi-model support: OpenAI / DeepSeek / Anthropic / Gemini / Qwen / Ollama, streaming output, Markdown rendering, syntax highlighting |
| **Agent Orchestration** | Custom Agent roles/goals/backstory, multi-Agent collaboration, Agent conference mode, role template library |
| **Skill System** | Skill marketplace + custom skills, tool registration and permission management |
| **Workflow Canvas** | Visual drag-and-drop Agent workflow orchestration, DAG execution engine |
| **MCP Protocol** | Model Context Protocol tool integration, plug-and-play external tools |
| **Knowledge Base (RAG)** | Document upload/parsing/vector retrieval, supports PDF / Markdown / TXT and more; Auto-RAG automatically retrieves knowledge base context before sending (score >= 0.35) |
| **Memory System** | Long-term + short-term memory + semantic search, cross-session memory persistence |
| **Scheduled Tasks** | Cron scheduling, periodic Agent task execution |
| **Security Gateway** | Prompt injection detection / PII filtering / content filtering / RBAC access control |
| **Team Collaboration** | *(Planned)* Multi-user workspaces, shared Agents and sessions |
| **IM Channels** | Lark / DingTalk / WeCom / WeChat / Slack / Discord / Telegram — chat with AI remotely via IM |
| **Deep Research** | 4-phase autonomous investigation (search → analyze → synthesize → report), powered by Hexagon Plan-and-Execute engine |
| **Document Parsing** | Upload PDF / Word / Excel / CSV directly in chat, text auto-extracted as context; document detail view supports full content retrieval (API fetch + chunk reassembly fallback) |
| **Webhook Notifications** | WeCom / Lark / DingTalk bot webhook push, auto-notify on task completion |
| **ClawHub Skill Market** | Browse, search, and install OpenClaw community Skills, filter by category (coding/research/writing/data/automation) |
| **Onboarding Wizard** | 3-step Welcome guide (choose Provider → choose model → test connection), zero-config barrier |
| **Real-time Logs** | WebSocket streaming logs, full Agent execution chain tracing |
| **Internationalization** | Chinese / English, vue-i18n |
| **System Tray** | Minimize to tray, tray menu quick actions |
| **Global Shortcut** | `⌘+Shift+H` to summon Quick Chat window anytime |
| **Auto Update** | Tauri Updater, one-click in-app upgrade |

## Ecosystem

```
toolkit → ai-core → hexagon → hexclaw → hexclaw-desktop
                                       → hexclaw-ui
                                       → hexagon-ui
```

| Project | Role | Language |
|---------|------|----------|
| [toolkit](https://github.com/hexagon-codes/toolkit) | General toolbox — infrastructure library (logging/config/HTTP/concurrency/error chain) | Go |
| [ai-core](https://github.com/hexagon-codes/ai-core) | AI capability foundation — LLM Provider/Embedding/Vector/Memory | Go |
| [hexagon](https://github.com/hexagon-codes/hexagon) | Full-featured AI Agent framework — ReAct/Plan-and-Execute/Tool dispatch | Go |
| [hexclaw](https://github.com/hexagon-codes/hexclaw) | HexClaw backend — Sidecar service (RESTful API/RAG/Cron/Security Gateway) | Go |
| [hexclaw-hub](https://github.com/hexagon-codes/hexclaw-hub) | Skill marketplace data — online catalog (`index.json` + Markdown skills) | Data repo |
| **hexclaw-desktop** | **HexClaw desktop client (this repo)** | **Rust + Vue 3** |
| [hexclaw-ui](https://github.com/hexagon-codes/hexclaw-ui) | HexClaw Web client (also reused as desktop UI render layer) | Vue 3 |
| [hexagon-ui](https://github.com/hexagon-codes/hexagon-ui) | Agent Observatory — observability dashboard (trace/reasoning replay/performance analysis) | Vue 3 |

## Architecture

```
HexClaw.app
┌───────────────────────────────────────────────────────────────────┐
│  Tauri Shell (Rust)                                               │
│  Window management · System tray · Native menu · Global shortcut  │
│  Single instance · Auto update                                    │
│  API proxy (CORS bypass) · Sidecar process management            │
├───────────────────────────────────────────────────────────────────┤
│  Vue 3 Frontend (WebView)                                         │
│  ┌────────┬────────┬────────┬────────┬────────┬────────┬───────┐ │
│  │Overview│  Chat  │ Agents │Knowledg│Automati│Integrat│  Logs │ │
│  │        │        │        │Doc|Mem │Task|Can│Skl|MCP │       │ │
│  │        │        │        │        │        │IM|Diag │       │ │
│  └───┬────┴───┬────┴───┬────┴───┬────┴───┬────┴───┬────┴───────┘ │
│      │  Pinia Store    │  Vue Router      │  Tauri invoke (IPC)   │
├──────┴─────────────────┴──────────────────┴───────────────────────┤
│  Tauri Commands (Rust → Go)                                       │
│  check_engine_health · proxy_api_request · get_sidecar_status     │
│  backend_chat · stream_chat · restart_sidecar · get_platform_info │
├───────────────────────────────────────────────────────────────────┤
│  HTTP / WebSocket  ←→  localhost:16060                            │
├───────────────────────────────────────────────────────────────────┤
│  hexclaw serve (Go Sidecar)                                       │
│  Agent Engine · LLM Router · RAG · MCP · CORS · Security · Cron  │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │  Hexagon Framework  ←  ai-core (LLM/Tool/Memory)          │   │
│  │                     ←  toolkit (Log/Config/HTTP/Concurrency)│  │
│  └────────────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────────┘
```

Same design pattern as **Docker Desktop managing Docker Engine** — the Tauri shell manages the Go Sidecar process.
Frontend and backend communicate via **Tauri IPC proxy** (resolving WebView CORS limitations), fully decoupled.

> The Go Sidecar listens on `localhost:16060` by default. Port can be changed in the hexclaw config file.

## Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Desktop framework | Tauri | v2 |
| Frontend framework | Vue 3 (Composition API) | 3.5+ |
| Language | TypeScript | 5.9+ |
| State management | Pinia | 3.x |
| UI component library | Naive UI + Custom design system | - |
| Styling | Tailwind CSS | 4.x |
| Routing | Vue Router | 5.x |
| Internationalization | vue-i18n | 11.x |
| Icons | Lucide Vue | - |
| Markdown | markdown-it + Shiki (syntax highlighting) | - |
| Document parsing | pdfjs-dist + mammoth + xlsx | - |
| Data storage | SQLite (tauri-plugin-sql) + Tauri Store | - |
| HTTP client | ofetch (frontend) / reqwest (Rust proxy) | - |
| Build tool | Vite | 7.x |
| Testing | Vitest + @vue/test-utils | - |
| Lint | ESLint + oxlint + Prettier | - |
| Backend Sidecar | hexclaw serve (Go) | Go 1.23+ |
| Agent framework | Hexagon | - |
| Rust layer | Tauri Shell + plugin ecosystem | Rust 2021 edition |

## Installation

### One-line Install (macOS)

```bash
curl -fsSL https://raw.githubusercontent.com/hexagon-codes/hexclaw-desktop/main/install.sh | bash
```

Detects CPU architecture (Apple Silicon / Intel), downloads the latest release, installs to `/Applications`, and clears the Gatekeeper quarantine flag automatically.

### Homebrew (macOS)

```bash
brew tap hexagon-codes/tap
brew install --cask hexclaw
```

Upgrade later: `brew upgrade --cask hexclaw`

### GitHub Releases

Go to [Releases](https://github.com/hexagon-codes/hexclaw-desktop/releases) to download the installer for your platform:

| Platform | Format |
|----------|--------|
| macOS (Apple Silicon) | `.dmg` |
| macOS (Intel) | `.dmg` |
| Windows | `.msi` / `.exe` (NSIS) |
| Linux | `.deb` / `.AppImage` |

> **macOS users**: Browser-downloaded `.dmg` files may be blocked by Gatekeeper. Use the one-line install script or Homebrew above — they handle this automatically.
> For manual DMG installs, run `xattr -cr /Applications/HexClaw.app` in Terminal.

### CI / Packaging / Release Flow

- `push / PR -> CI`: runs lint, type-check, tests, and web build automatically
- `Actions -> Package -> Run workflow`: builds test installers for all platforms and uploads them as workflow artifacts
- `git tag vX.Y.Z && git push origin vX.Y.Z -> Release`: builds and publishes the official GitHub Release assets
- Stable releases automatically update the [Homebrew Tap](https://github.com/hexagon-codes/homebrew-tap) (computes DMG SHA256 and pushes Cask update)

Before creating a release tag, make sure:

- `package.json` and `src-tauri/tauri.conf.json` versions match the tag
- the Tauri updater public key is committed at `src-tauri/tauri.conf.json -> plugins.updater.pubkey`
- GitHub Actions secrets include `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- macOS releases also require Apple code-signing secrets: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`
- macOS releases also need one notarization credential set (choose one):
- Apple ID flow: `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`
- App Store Connect flow: `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_PRIVATE_KEY` (the workflow writes it to `private_keys/AuthKey_<APPLE_API_KEY>.p8`)

If those macOS secrets are missing, the `Release` and `Package` workflows now fail early instead of publishing browser-downloaded bundles that Gatekeeper flags as "damaged".

If you already have the `.p12` certificate and `AuthKey_*.p8`, you can start from:

```bash
make macos-release-secrets-help
make macos-release-bootstrap-help
```

For the Apple-side setup, see [macOS Release Setup](docs/macos-release.en.md).

See the [User Guide](docs/guide.en.md) for detailed instructions.

## Development

### Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | >= 20.19 or >= 22.12 | JavaScript runtime |
| pnpm | >= 9 | Package manager |
| Rust | stable (2021 edition) | Required for Tauri compilation |
| Go | >= 1.23 | Required for Sidecar compilation |

### Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/hexagon-codes/hexclaw-desktop.git
cd hexclaw-desktop

# 2. Install dependencies
make install
# Equivalent to: pnpm install && cd src-tauri && cargo fetch

# 3. Compile Go sidecar (required on first setup, pulls remote GitHub hexclaw v0.1.0-beta by default)
make sidecar

# 4. Start development mode
make dev
```

> **Note**:
> - `make sidecar` pulls `refs/tags/v0.1.0-beta` from `https://github.com/hexagon-codes/hexclaw.git` into `/tmp/hexclaw-gith-src` by default
> - To build another backend version, pass it explicitly: `make sidecar HEXCLAW_REF=refs/tags/<tag>`
> - The Skill Marketplace uses `https://github.com/hexagon-codes/hexclaw-hub` at tag `v0.0.1` by default; override it at runtime via `skills.hub` in `~/.hexclaw/hexclaw.yaml`

### Make Commands

| Command | Description |
|---------|-------------|
| `make dev` | Development mode (Vite HMR + Tauri window) |
| `make build` | Build production release |
| `make build-web` | Build frontend only |
| `make sidecar` | Compile Go sidecar (current platform) |
| `make sidecar-all` | Cross-compile sidecar for all platforms |
| `make lint` | Code linting (oxlint + ESLint) |
| `make lint-fix` | Lint and auto-fix |
| `make format` | Code formatting (Prettier) |
| `make type-check` | TypeScript type checking |
| `make test` | Run unit tests |
| `make clean` | Clean build artifacts |
| `make install` | Install all dependencies |

### Project Structure

```
hexclaw-desktop/
├── src/                          # Vue 3 frontend source
│   ├── api/                      # API clients (Tauri IPC + HTTP fallback)
│   │   ├── client.ts             # HTTP/WS/IPC base client
│   │   ├── chat.ts               # Chat API (WebSocket + HTTP fallback)
│   │   ├── agents.ts             # Agent management API
│   │   ├── skills.ts             # Skill + ClawHub marketplace API
│   │   ├── canvas.ts             # Workflow canvas API
│   │   ├── mcp.ts                # MCP protocol API
│   │   ├── knowledge.ts          # Knowledge base API
│   │   ├── memory.ts             # Memory system API
│   │   ├── tasks.ts              # Scheduled tasks API
│   │   ├── config.ts             # LLM config API (Tauri proxy)
│   │   ├── desktop.ts            # Desktop features API (notifications/clipboard)
│   │   ├── im-channels.ts        # IM channel API (Lark/DingTalk/WeCom etc.)
│   │   ├── team.ts               # Team collaboration API
│   │   ├── voice.ts              # Voice API (TTS/STT)
│   │   ├── webhook.ts            # Webhook notification API
│   │   ├── websocket.ts          # Chat WebSocket client
│   │   ├── logs.ts               # Logs API + WebSocket stream
│   │   ├── settings.ts           # Settings API
│   │   └── system.ts             # System info API
│   ├── components/               # Components
│   │   ├── layout/               # Layout (AppLayout/Sidebar/TitleBar/ContextBar/DetailPanel)
│   │   ├── chat/                 # Chat (ChatInput/SessionList/MarkdownRenderer/TemplatePopup/ResearchProgress etc.)
│   │   ├── agent/                # Agent (AgentCard/AgentForm/AgentStatus/AgentConference)
│   │   ├── agents/               # Multi-Agent collaboration (AgentConference)
│   │   ├── artifacts/            # Artifacts (ArtifactsPanel/ArtifactPreview/CodeView/DiffView)
│   │   ├── inspector/            # Inspector (InspectorContext/ContextCard/KeyValueRow/TimelineItem)
│   │   ├── canvas/               # Canvas (TemplateGallery)
│   │   ├── settings/             # Settings (SettingsNotification/SettingsSecurity)
│   │   ├── logs/                 # Logs (LogEntry/LogFilter/LogStats)
│   │   └── common/               # Shared (CommandPalette/ConfirmDialog/Toast/ErrorBoundary etc.)
│   ├── views/                    # Page views
│   │   ├── DashboardView.vue     # Dashboard (stats overview + recent activity)
│   │   ├── ChatView.vue          # AI chat (sessions/attachments/Artifacts/model switching)
│   │   ├── AgentsView.vue        # Agent management (templates/running/rules/conference)
│   │   ├── KnowledgeCenterView.vue # Knowledge center (Documents + Memory tabs)
│   │   ├── KnowledgeView.vue     # Knowledge base (document CRUD/upload/search)
│   │   ├── MemoryView.vue        # Memory management (edit/search/clear)
│   │   ├── AutomationView.vue    # Automation (Tasks + Canvas tabs)
│   │   ├── TasksView.vue         # Scheduled tasks (Cron management)
│   │   ├── CanvasView.vue        # Workflow canvas (DAG orchestration)
│   │   ├── IntegrationView.vue   # Integration (Skills + MCP + IM + Diagnostics tabs)
│   │   ├── SkillsView.vue        # Skill management + ClawHub marketplace
│   │   ├── McpView.vue           # MCP management (servers/tools/testing)
│   │   ├── IMChannelsView.vue    # IM channel management (Lark/DingTalk/WeCom etc.)
│   │   ├── LogsView.vue          # Log viewer (real-time stream/filter/stats)
│   │   ├── SettingsView.vue      # Settings (LLM/security/notification/webhook/theme/locale)
│   │   ├── AboutView.vue         # About (separate window)
│   │   ├── QuickChatView.vue     # Quick chat (separate window)
│   │   └── WelcomeView.vue       # Onboarding wizard (Provider → model → test)
│   ├── stores/                   # Pinia state management (thin store, business logic delegated to services/)
│   │   ├── app.ts                # Global state (connection/sidebar/detail panel)
│   │   ├── chat.ts               # Chat (sessions/messages/streaming/Artifacts, SQLite persistence)
│   │   ├── agents.ts             # Agent roles
│   │   ├── canvas.ts             # Canvas (nodes/edges/workflows/run)
│   │   ├── logs.ts               # Logs (WebSocket stream/filter/stats)
│   │   └── settings.ts           # Settings (LLM + security + notification, Tauri Store persistence)
│   ├── composables/              # Composable functions
│   │   ├── useHexclaw.ts         # hexclaw connection status + health check polling
│   │   ├── useWebSocket.ts       # WebSocket wrapper (auto-reconnect)
│   │   ├── useSSE.ts             # SSE streaming requests
│   │   ├── useShortcuts.ts       # In-app shortcuts (⌘1~7 page switching)
│   │   ├── useTheme.ts           # Theme (dark/light/follow system)
│   │   ├── useAutoStart.ts       # Auto-start (Tauri autostart)
│   │   ├── useAutoUpdate.ts      # Auto-update (Tauri updater)
│   │   ├── useValidation.ts      # Form validation
│   │   ├── useKeyboardNav.ts     # Keyboard navigation + focus trap
│   │   ├── usePlatform.ts        # Platform detection (macOS/Windows/Linux)
│   │   ├── useChatSend.ts        # Send message + Auto-RAG knowledge retrieval
│   │   ├── useChatActions.ts     # Chat actions (resend/edit/delete etc.)
│   │   └── useConversationAutomation.ts # Conversation automation (auto-title etc.)
│   ├── services/                 # Business logic service layer
│   │   ├── chatService.ts        # Chat service (WebSocket/HTTP send)
│   │   └── messageService.ts     # Message service (build/persist messages)
│   ├── i18n/                     # Internationalization (Chinese/English)
│   ├── router/                   # Router (dynamically built from navigation.ts)
│   ├── types/                    # TypeScript type definitions
│   ├── utils/                    # Utility functions
│   │   └── file-parser.ts        # Document parser (PDF/Word/Excel/CSV)
│   ├── db/                       # Local database (SQLite: chat/artifacts/knowledge/templates/outbox)
│   ├── config/                   # Frontend config
│   │   ├── env.ts                # Environment config
│   │   ├── navigation.ts         # Navigation registry (3-tier groups: core/integration/system)
│   │   └── providers.ts          # LLM Provider config
│   └── assets/                   # Static assets (Logo/icons/IM logos)
├── src-tauri/                    # Tauri (Rust) layer
│   ├── src/
│   │   ├── main.rs               # Entry point
│   │   ├── lib.rs                # App initialization & plugin registration
│   │   ├── commands.rs           # Tauri IPC commands (health check/API proxy/streaming chat)
│   │   ├── sidecar.rs            # Go Sidecar process management
│   │   ├── tray.rs               # System tray
│   │   ├── menu.rs               # macOS native menu
│   │   └── window.rs             # Window management & global shortcuts
│   ├── binaries/                 # Go sidecar binaries (compiled output)
│   ├── icons/                    # App icons
│   ├── capabilities/             # Tauri v2 permission config
│   ├── tauri.conf.json           # Tauri config
│   ├── build.rs                  # Rust build script
│   └── Cargo.toml                # Rust dependencies
├── docs/                         # Documentation
│   ├── guide.md                  # User guide (Chinese)
│   ├── guide.en.md               # User guide (English)
│   ├── updates.md                # Auto-update release guide (Chinese)
│   ├── updates.en.md             # Auto-update release guide (English)
│   ├── overview.md               # Product overview (Chinese)
│   └── overview.en.md            # Product overview (English)
├── homebrew/                     # Homebrew Cask definition + update script
├── install.sh                    # macOS one-line install script
├── scripts/                      # CI/build scripts
├── .github/                      # GitHub CI/CD
├── Makefile                      # Dev commands
├── vite.config.ts                # Vite config
├── vitest.config.ts              # Vitest test config
├── eslint.config.ts              # ESLint config
├── tsconfig.json                 # TypeScript config
├── package.json                  # Node dependencies
├── LICENSE                       # Apache 2.0 license
└── README.md
```

## Building

### Production Build

```bash
# Full build (frontend + Tauri packaging)
make build

# Output locations:
#   macOS: src-tauri/target/release/bundle/macos/HexClaw.app
#   DMG:   src-tauri/target/release/bundle/dmg/HexClaw_*.dmg
```

### Target Platform Build

```bash
# macOS Intel
npx @tauri-apps/cli build --target x86_64-apple-darwin

# macOS Apple Silicon
npx @tauri-apps/cli build --target aarch64-apple-darwin
```

### Sidecar Cross-compilation

```bash
# Compile all platforms
make sidecar-all

# Or compile specific platforms
make sidecar-darwin-arm64    # macOS Apple Silicon
make sidecar-darwin-amd64    # macOS Intel
make sidecar-linux-amd64     # Linux x86_64
make sidecar-windows-amd64   # Windows x86_64
```

Sidecar binaries are output to `src-tauri/binaries/` and automatically bundled during Tauri packaging. Builds now inject the actual tag / commit / built timestamp so the installed app can report the backend version accurately.

## Testing

```bash
# Run unit tests
pnpm test:unit

# Or using Make
make test
```

Test file conventions:
- Test files live alongside source files, named `*.test.ts` or `*.spec.ts`
- Store tests go in `src/stores/__tests__/`
- Uses Vitest + @vue/test-utils

## Troubleshooting

### macOS: "Cannot be opened" or "damaged"

Use the one-line install script or Homebrew (they handle Gatekeeper automatically):

```bash
# Option 1: One-line install
curl -fsSL https://raw.githubusercontent.com/hexagon-codes/hexclaw-desktop/main/install.sh | bash

# Option 2: Homebrew
brew tap hexagon-codes/tap && brew install --cask hexclaw
```

If you already downloaded the DMG manually, run in Terminal:

```bash
xattr -cr /Applications/HexClaw.app
```

### Sidebar shows "Engine stopped" but backend is running

1. Verify hexclaw process is running: `ps aux | grep hexclaw`
2. Verify port is listening: `curl http://localhost:16060/health`
3. If curl succeeds but frontend still shows stopped, check if you're on an old build (run `make build` and reinstall)

### `make sidecar` compilation fails

1. Verify Go >= 1.23 is installed: `go version`
2. Verify GitHub access and the remote source tag: `git ls-remote --tags https://github.com/hexagon-codes/hexclaw.git v0.1.0-beta`
3. Verify Rust toolchain is installed (needed for platform triple detection): `rustc -vV`

### `make dev` starts but shows white screen

Sidecar may not be compiled or there's a port conflict. Check:
1. Confirm `make sidecar` has been run
2. Confirm port `16060` is not in use: `lsof -i :16060`

### hexclaw backend fails to start

1. Check error logs: `~/.hexclaw/hexclaw.log`
2. Run sidecar directly to see output: `./src-tauri/binaries/hexclaw-$(rustc -vV | grep host | awk '{print $2}') serve --desktop`
3. Even without an LLM API Key configured, hexclaw should start normally (LLM features degraded, base API still available)

## Contributing

### Workflow

1. Fork this repository
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Commit your changes: `git commit -m "feat: add new feature"`
4. Push the branch: `git push origin feat/your-feature`
5. Create a Pull Request

### Code Standards

- **Formatting**: `make format` (Prettier)
- **Linting**: `make lint` (ESLint + oxlint, check-only)
- **Type checking**: `make type-check` (vue-tsc)

### Commit Message Format

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add new feature
fix: fix a bug
docs: documentation update
style: code style adjustment
refactor: refactoring
test: test-related changes
chore: build/toolchain changes
```

## Resources

- 🌐 Website: [hexclaw.net](https://hexclaw.net)
- 📖 Chinese Docs: [hexclaw.net/zh/docs](https://hexclaw.net/zh/docs/)
- 📖 English Docs: [hexclaw.net/en/docs](https://hexclaw.net/en/docs/)
- 🐙 GitHub: [hexagon-codes/hexclaw-desktop](https://github.com/hexagon-codes/hexclaw-desktop)

## Contact

- GitHub Issues: [hexclaw-desktop/issues](https://github.com/hexagon-codes/hexclaw-desktop/issues)
- HexClaw AI: ai@hexclaw.net
- HexClaw Support: support@hexclaw.net

## License

[Apache License 2.0](LICENSE)
