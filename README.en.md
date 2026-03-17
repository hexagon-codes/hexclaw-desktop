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
  <img src="docs/screenshots/chat.png" alt="Chat UI" width="800" />
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
| **Knowledge Base (RAG)** | Document upload/parsing/vector retrieval, supports PDF / Markdown / TXT and more |
| **Memory System** | Long-term + short-term memory + semantic search, cross-session memory persistence |
| **Scheduled Tasks** | Cron scheduling, periodic Agent task execution |
| **Security Gateway** | Prompt injection detection / PII filtering / content filtering / RBAC access control |
| **Team Collaboration** | *(Planned)* Multi-user workspaces, shared Agents and sessions |
| **IM Channels** | Lark / DingTalk / WeCom / WeChat / Slack / Discord / Telegram — chat with AI remotely via IM |
| **Deep Research** | 4-phase autonomous investigation (search → analyze → synthesize → report), powered by Hexagon Plan-and-Execute engine |
| **Document Parsing** | Upload PDF / Word / Excel / CSV directly in chat, text auto-extracted as context |
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
│  │Dashboard│  Chat  │ Agents │ Skills │ Canvas │Knowledge│  MCP  │ │
│  ├────────┼────────┼────────┼────────┼────────┼────────┼───────┤ │
│  │ Memory  │  Logs  │ Tasks  │   IM   │Settings│ About  │ Quick │ │
│  └───┬────┴───┬────┴───┬────┴───┬────┴───┬────┴───┬────┴───────┘ │
│      │  Pinia Store    │  Vue Router      │  Tauri invoke (IPC)   │
├──────┴─────────────────┴──────────────────┴───────────────────────┤
│  Tauri Commands (Rust → Go)                                       │
│  check_engine_health · proxy_api_request · get_sidecar_status    │
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
| UI component library | Custom design system (Apple-Inspired) | - |
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

### Homebrew (macOS)

```bash
brew tap hexagon-codes/tap
brew install --cask hexclaw
```

### GitHub Releases

Go to [Releases](https://github.com/hexagon-codes/hexclaw-desktop/releases) to download the installer for your platform:

| Platform | Format |
|----------|--------|
| macOS (Apple Silicon) | `.dmg` |
| macOS (Intel) | `.dmg` |
| Windows | `.msi` / `.exe` (NSIS) |
| Linux | `.deb` / `.AppImage` |

> First launch on macOS may require allowing the app in **System Settings → Privacy & Security**.

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

# 3. Compile Go sidecar (required on first setup, needs hexclaw repo in sibling directory)
make sidecar

# 4. Start development mode
make dev
```

> **Note**: `make sidecar` requires the [hexclaw](https://github.com/hexagon-codes/hexclaw) repository to be cloned in the sibling directory:
> ```
> work/
> ├── hexclaw/           # Go backend repo
> └── hexclaw-desktop/   # This repo
> ```

### Make Commands

| Command | Description |
|---------|-------------|
| `make dev` | Development mode (Vite HMR + Tauri window) |
| `make build` | Build production release |
| `make build-web` | Build frontend only |
| `make sidecar` | Compile Go sidecar (current platform) |
| `make sidecar-all` | Cross-compile sidecar for all platforms |
| `make lint` | Code linting (oxlint + ESLint) |
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
│   │   ├── chat.ts               # Chat API
│   │   ├── agents.ts             # Agent management API
│   │   ├── skills.ts             # Skill API
│   │   ├── canvas.ts             # Workflow canvas API
│   │   ├── mcp.ts                # MCP protocol API
│   │   ├── knowledge.ts          # Knowledge base API
│   │   ├── memory.ts             # Memory system API
│   │   ├── tasks.ts              # Scheduled tasks API
│   │   ├── im-channels.ts        # IM channel API (Lark/DingTalk/WeCom etc.)
│   │   ├── webhook.ts            # Webhook notification API
│   │   ├── logs.ts               # Logs API
│   │   ├── settings.ts           # Settings API
│   │   └── system.ts             # System info API
│   ├── components/               # Components
│   │   ├── chat/                 # Chat components
│   │   │   ├── ResearchProgress.vue  # Deep research progress panel
│   │   ├── agent/                # Agent components
│   │   ├── canvas/               # Canvas components
│   │   ├── common/               # Shared components (CommandPalette/ContextMenu/Toast etc.)
│   │   ├── layout/               # Layout components (AppLayout/Sidebar/TitleBar)
│   │   └── logs/                 # Log components
│   ├── views/                    # Page views
│   │   ├── DashboardView.vue     # Dashboard (home)
│   │   ├── ChatView.vue          # AI chat
│   │   ├── AgentsView.vue        # Agent management
│   │   ├── SkillsView.vue        # Skill marketplace
│   │   ├── CanvasView.vue        # Workflow canvas
│   │   ├── McpView.vue           # MCP management
│   │   ├── KnowledgeView.vue     # Knowledge base
│   │   ├── MemoryView.vue        # Memory management
│   │   ├── TasksView.vue         # Scheduled tasks
│   │   ├── LogsView.vue          # Log viewer
│   │   ├── IMChannelsView.vue    # IM channel management
│   │   ├── TeamView.vue          # Team collaboration (planned)
│   │   ├── SettingsView.vue      # Settings
│   │   ├── AboutView.vue         # About (separate window)
│   │   ├── QuickChatView.vue     # Quick chat (separate window)
│   │   └── WelcomeView.vue       # Welcome page
│   ├── stores/                   # Pinia state management
│   ├── composables/              # Composable functions
│   ├── i18n/                     # Internationalization resources
│   ├── router/                   # Router configuration
│   ├── types/                    # TypeScript type definitions
│   ├── utils/                    # Utility functions
│   │   ├── file-parser.ts        # Document parser (PDF/Word/Excel/CSV)
│   ├── config/                   # Frontend config (env.ts etc.)
│   └── assets/                   # Static assets (Logo/icons)
├── src-tauri/                    # Tauri (Rust) layer
│   ├── src/
│   │   ├── main.rs               # Entry point
│   │   ├── lib.rs                # App initialization & plugin registration
│   │   ├── commands.rs           # Tauri IPC commands (health check/API proxy)
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
│   └── guide.en.md               # User guide (English)
├── Casks/                        # Homebrew Cask definition
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

Sidecar binaries are output to `src-tauri/binaries/` and automatically bundled during Tauri packaging.

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

### macOS: "Cannot be opened because the developer cannot be verified"

Go to **System Settings → Privacy & Security**, find HexClaw, and click "Open Anyway". Or run in terminal:

```bash
xattr -cr /Applications/HexClaw.app
```

### Sidebar shows "Engine stopped" but backend is running

1. Verify hexclaw process is running: `ps aux | grep hexclaw`
2. Verify port is listening: `curl http://localhost:16060/health`
3. If curl succeeds but frontend still shows stopped, check if you're on an old build (run `make build` and reinstall)

### `make sidecar` compilation fails

1. Verify Go >= 1.23 is installed: `go version`
2. Verify `hexclaw` repo exists in sibling directory: `ls ../hexclaw/cmd/hexclaw`
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
- **Linting**: `make lint` (ESLint + oxlint)
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
