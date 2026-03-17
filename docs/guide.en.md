**English** | [中文](guide.md)

# HexClaw Desktop User Guide

## Table of Contents

- [Installation & First Launch](#installation--first-launch)
- [Interface Overview](#interface-overview)
- [AI Chat](#ai-chat)
- [Agent Management](#agent-management)
- [Skill System](#skill-system)
- [Workflow Canvas](#workflow-canvas)
- [MCP Tool Integration](#mcp-tool-integration)
- [Knowledge Base](#knowledge-base)
- [Memory System](#memory-system)
- [Scheduled Tasks](#scheduled-tasks)
- [Team Collaboration](#team-collaboration)
- [Settings & Configuration](#settings--configuration)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [System Tray](#system-tray)
- [Troubleshooting](#troubleshooting)

---

## Installation & First Launch

### System Requirements

| Platform | Minimum Version |
|----------|----------------|
| macOS | 11.0 (Big Sur) or later |
| Windows | 10 (1809) or later |
| Linux | Ubuntu 20.04 / Fedora 36 or later |

### Installation

**macOS (Homebrew)**

```bash
brew tap hexagon-codes/tap
brew install --cask hexclaw
```

**macOS / Windows / Linux (Manual download)**

1. Go to the [GitHub Releases](https://github.com/hexagon-codes/hexclaw-desktop/releases) page
2. Download the installer for your platform:
   - macOS: `.dmg` file — double-click and drag to Applications
   - Windows: `.msi` or `.exe` installer
   - Linux: `.deb` (Debian/Ubuntu) or `.AppImage`
3. Launch HexClaw

### First Launch

1. **Start the app** — double-click the HexClaw icon
2. **Wait for engine** — the status indicator in the sidebar bottom turns from red to green (Engine running)
3. **Configure LLM** — go to **Settings → LLM Configuration**, select a Provider and enter your API Key
4. **Start chatting** — switch to the Chat page and send your first message

> **Tip**: Even without an LLM API Key, the HexClaw engine starts normally. You can browse the interface, manage Agents and Skills, but AI chat will not be available.

### macOS Security Warning

First launch may show "Cannot verify developer". To resolve:

- **Option A**: System Settings → Privacy & Security → find HexClaw → click "Open Anyway"
- **Option B**: Run in terminal: `xattr -cr /Applications/HexClaw.app`

---

## Interface Overview

HexClaw uses a classic three-column layout:

```
┌──────────────────────────────────────────────────────┐
│  Title Bar (HexClaw Logo + Window Controls)           │
├──────┬───────────────────────────────────────────────┤
│      │                                               │
│Sidebar│           Main Content Area                  │
│      │                                               │
│  Nav  │  (Chat/Agent/Settings page content)          │
│      │                                               │
│      │                                               │
│  ───  │                                               │
│Status │                                               │
│Settings│                                              │
└──────┴───────────────────────────────────────────────┘
```

### Sidebar Navigation

| Icon | Page | Description |
|------|------|-------------|
| Dashboard | Dashboard | System overview and quick access |
| Chat | Chat | AI multi-turn conversation |
| Agents | Agents | Agent role management |
| Tasks | Tasks | Scheduled task management |
| Skills | Skills | Skill marketplace and management |
| Knowledge | Knowledge | RAG knowledge management |
| Memory | Memory | Long-term memory management |
| MCP | MCP | External tool integration |
| Logs | Logs | Real-time runtime logs |
| Canvas | Canvas | Workflow orchestration |
| Team | Team | Multi-user collaboration |
| Settings | Settings | App configuration |

### Engine Status Indicator

The sidebar bottom shows the HexClaw Engine runtime status:

- **Green + "Engine running"** — backend service is healthy, all features available
- **Red + "Engine stopped"** — backend service is not ready, AI features unavailable

---

## AI Chat

### Basic Usage

1. Click **Chat** in the sidebar
2. Type your message in the input box at the bottom, press `Enter` to send
3. AI responses support Markdown rendering and syntax highlighting
4. Use `Shift+Enter` to insert a newline for multi-line input

### Session Management

- **New session**: Click the "+" button on the left side of the chat page
- **Switch session**: Click a history session in the session list
- **Search sessions**: Use the search feature to find past conversations
- **Export session**: Export chat history is supported

### Model Selection

Supported LLM Providers:

| Provider | Model Examples |
|----------|---------------|
| OpenAI | gpt-4o, gpt-4o-mini |
| DeepSeek | deepseek-chat, deepseek-coder |
| Anthropic | claude-sonnet-4-20250514 |
| Google Gemini | gemini-2.0-flash |
| Qwen (Alibaba) | qwen-max, qwen-plus |
| Doubao (Ark) | doubao-pro |
| Ollama | llama3, mistral (local models) |

Configure in **Settings → LLM Configuration**: select Provider, enter API Key and model name.

### Quick Chat

Press `⌘+Shift+H` (macOS) or `Ctrl+Shift+H` (Windows/Linux) to summon the Quick Chat window from anywhere, without switching to the main interface.

---

## Agent Management

### Creating an Agent

1. Go to the **Agents** page
2. Click "New Agent"
3. Fill in:
   - **Name** — display name of the Agent
   - **Goal** — description of the Agent's working goal
   - **Backstory** — role background and behavioral rules
4. Save to start using

### Agent Role Templates

Built-in preset roles:

| Role | Use Case |
|------|----------|
| Assistant | General-purpose assistant |
| Researcher | Information research |
| Writer | Content writing |
| Coder | Code development |
| Translator | Translation |
| Analyst | Data analysis |

### Multi-Agent Collaboration

Supports multiple Agents collaborating in the same session. Use Agent conference mode to have multiple roles engage in cross-discussion.

---

## Skill System

Skills are external tool capabilities that Agents can invoke.

### Built-in Skills

| Skill | Description | Default State |
|-------|-------------|---------------|
| Search | Web search | Enabled |
| Weather | Weather query | Enabled |
| Translate | Translation | Enabled |
| Summary | Text summarization | Enabled |
| Browser | Web browsing | Enabled |
| Code | Code execution | **Disabled** (high risk) |
| Shell | Command execution | **Disabled** (high risk) |

### Skill Marketplace

Browse and install third-party Skills contributed by the community, with one-click install/uninstall.

---

## Workflow Canvas

Visually orchestrate Agent workflows:

1. Go to the **Canvas** page
2. Drag nodes from the left panel (Agent / Tool / Condition etc.)
3. Connect nodes to establish execution flow
4. Click "Run" to execute the entire workflow

Supports DAG (Directed Acyclic Graph) execution engine with automatic parallel processing of independent nodes.

---

## MCP Tool Integration

[Model Context Protocol (MCP)](https://modelcontextprotocol.io/) is a standardized AI tool integration protocol.

### Adding an MCP Server

1. Go to the **MCP** page
2. Click "Add Server"
3. Configure the connection:
   - **stdio** — local process communication
   - **SSE** — Server-Sent Events
   - **Streamable HTTP** — HTTP streaming
4. Once connected, tools provided by the server are automatically registered to the Agent's available tool list

### Configuring in Settings

In **Settings → MCP** you can configure the default protocol and auto-reconnect behavior.

---

## Knowledge Base

RAG (Retrieval-Augmented Generation) based knowledge management:

### Upload Documents

1. Go to the **Knowledge** page
2. Click "Upload Document"
3. Supported formats: PDF / Markdown / TXT / DOCX
4. Documents are automatically parsed, chunked, and vectorized

### Using the Knowledge Base

During conversations, Agents automatically retrieve relevant content from the knowledge base as context to provide more accurate answers.

---

## Memory System

HexClaw supports cross-session long-term memory:

- **Short-term memory** — current session context (up to 50 turns, auto-summarized when exceeded)
- **Long-term memory** — cross-session persistent knowledge and preferences
- **Semantic search** — retrieve relevant memories based on vector similarity

In the **Memory** page you can view, search, and manage stored memories.

---

## Scheduled Tasks

Use Cron expressions to periodically execute Agent tasks:

1. Go to the **Tasks** page
2. Click "New Task"
3. Configure:
   - **Name** — task description
   - **Cron expression** — e.g. `0 9 * * *` (daily at 9:00)
   - **Prompt** — the Agent instruction to execute
4. Tasks run automatically on schedule, results are sent as system notifications

---

## Team Collaboration

The **Team** page provides multi-user collaboration features:

- Create and manage workspaces
- Invite team members
- Share Agent configurations and session records
- Centrally manage team LLM usage and quotas

---

## Settings & Configuration

### LLM Configuration

| Option | Description |
|--------|-------------|
| Provider | LLM service provider |
| Model | Model name |
| API Key | Provider API key |
| Base URL | Custom API endpoint (optional) |
| Temperature | Generation randomness (0-2) |
| Max Tokens | Maximum output token count |

### Security Configuration

| Option | Description |
|--------|-------------|
| Security Gateway | Enable/disable request security checks |
| Injection Detection | Prompt injection protection |
| PII Filtering | Automatic sensitive personal information masking |
| Content Filtering | Harmful content interception |
| Single Token Limit | Max tokens per request |
| Rate Limit | Max requests per minute |

### Appearance

- **Theme**: Light / Dark / Follow system
- Changes take effect immediately

### Notification Settings

- System notification toggle
- Sound alerts
- Agent task completion notifications
- Heartbeat check notifications

### Runtime Engine

View backend engine runtime status, including:

| Component | Description |
|-----------|-------------|
| HexClaw Engine | Go backend service (port 16060) |
| Hexagon Agent Engine | AI Agent core engine |
| ai-core | LLM capability foundation |

Each component shows runtime status (green/red), version, and key info. Click the refresh button to manually refresh status.

---

## Keyboard Shortcuts

### Global Shortcuts

| Shortcut | Action |
|----------|--------|
| `⌘+Shift+H` | Summon Quick Chat window |

### In-app Shortcuts

| Shortcut | Action |
|----------|--------|
| `⌘+1` | Switch to Chat page |
| `⌘+2` | Switch to Agents page |
| `⌘+3` | Switch to Tasks page |
| `⌘+N` | New conversation |
| `⌘+,` | Open Settings |
| `⌘+K` | Open Command Palette |

> Windows/Linux users replace `⌘` with `Ctrl`.

### Command Palette

Press `⌘+K` to open the Command Palette, which supports fuzzy search to quickly execute actions:

- Switch pages
- Create new conversation/Agent
- Toggle theme
- Open settings

---

## System Tray

When the main window is closed, HexClaw minimizes to the system tray rather than quitting:

- **Left-click tray icon** — show/hide main window
- **Right-click menu**:
  - Show main window
  - New conversation
  - Quick Chat
  - Settings
  - Quit

---

## Troubleshooting

### Engine Status Red (Engine stopped)

**Cause**: The HexClaw backend Sidecar process has not started or is unhealthy.

**Steps to diagnose**:

```bash
# 1. Check if the process is running
ps aux | grep hexclaw

# 2. Check port listening
lsof -i :16060

# 3. Manually test health check
curl http://localhost:16060/health
# Expected response: {"status":"healthy"}
```

**Common causes**:
- Port 16060 is occupied by another process
- hexclaw binary does not exist or is corrupted
- Permission issue (macOS security policy blocking)

### Chat Not Responding

1. Confirm engine status is green (Engine running)
2. Confirm LLM API Key is configured in settings
3. Check network connection (LLM Provider API access required)
4. Check the Logs page for detailed error information

### App Crash

Check system logs:
- macOS: `Console.app` → search for "HexClaw"
- Or launch directly from terminal to see output:

```bash
# macOS
/Applications/HexClaw.app/Contents/MacOS/hexclaw-desktop

# View sidecar logs
~/.hexclaw/hexclaw.log
```

### Reset App Data

To completely reset:

```bash
# Delete app data
rm -rf ~/.hexclaw

# Delete app config (Tauri Store)
rm -rf ~/Library/Application\ Support/com.hexagon-codes.hexclaw
```

> **Warning**: This will erase all conversation history, Agent configurations, and memory data. This action is irreversible.

---

## HexClaw Desktop vs OpenClaw Feature Comparison

[OpenClaw](https://github.com/openclaw/openclaw) is a local-first personal AI assistant platform known for its broad messaging platform integrations and local gateway architecture. HexClaw Desktop is positioned as an enterprise-grade secure AI Agent desktop client, emphasizing security and Agent orchestration. Here is a detailed comparison:

### Product Positioning

| Dimension | HexClaw Desktop | OpenClaw |
|-----------|----------------|----------|
| Positioning | Enterprise-grade secure AI Agent desktop client | Local-first personal AI assistant |
| Target users | Enterprise / Team / Developer | Individual / Power user |
| Core philosophy | Security + Agent orchestration + visualization | Local + Fast + Always-on |
| License | Apache-2.0 | MIT |

### Architecture & Tech Stack

| Dimension | HexClaw Desktop | OpenClaw |
|-----------|----------------|----------|
| Client tech | Tauri v2 + Vue 3 + TypeScript | Node.js >= 22 + TypeScript |
| Backend engine | Go (HexClaw Engine + Hexagon Agent) | Node.js (Gateway + WebSocket) |
| Installation | Native desktop packages (.dmg/.msi/.deb) | `npm install -g openclaw` |
| Runtime | Standalone desktop app (Sidecar backend) | CLI + background daemon |
| Data storage | SQLite + Qdrant (vector) | Local filesystem |
| Communication | Tauri IPC + REST API | WebSocket control plane (`ws://127.0.0.1:18789`) |

### LLM Provider Support

| Provider | HexClaw Desktop | OpenClaw |
|----------|----------------|----------|
| OpenAI | ✅ | ✅ |
| Anthropic (Claude) | ✅ | ✅ |
| DeepSeek | ✅ | ✅ (via OpenAI compat) |
| Google Gemini | ✅ | ✅ |
| Qwen (Alibaba) | ✅ | - |
| Doubao (Ark) | ✅ | - |
| Ollama (local models) | ✅ | ✅ |
| Custom/third-party | ✅ | ✅ (OpenAI compat) |
| Multi-provider management | ✅ (OpenCat standard) | ✅ |
| In-chat model switching | ✅ | ✅ |

### Core Feature Comparison

| Feature | HexClaw Desktop | OpenClaw |
|---------|----------------|----------|
| AI multi-turn chat | ✅ | ✅ |
| Streaming output (SSE) | ✅ | ✅ |
| Session management (create/delete/search) | ✅ | ✅ |
| Chat export | ✅ | - |
| Agent role system | ✅ (custom roles + templates) | ✅ (multi-Agent routing) |
| Multi-Agent collaboration | ✅ (Agent conference mode) | ✅ (Session tool coordination) |
| Workflow canvas | ✅ (DAG visual orchestration) | ✅ (A2UI visual workspace) |
| Skill system | ✅ (built-in + marketplace) | ✅ (Bundled + Managed + ClawHub) |
| MCP tool integration | ✅ (stdio/SSE/HTTP) | - |
| Knowledge base (RAG) | ✅ (PDF/MD/TXT/DOCX) | - |
| Long-term memory | ✅ (semantic retrieval) | ✅ (Context/Memory) |
| Scheduled tasks (Cron) | ✅ | ✅ (Scheduler) |
| Team collaboration | ✅ | - |
| Token/cost tracking | - | ✅ |

### Security Features

| Security | HexClaw Desktop | OpenClaw |
|---------|----------------|----------|
| Security gateway | ✅ | - |
| Prompt injection detection | ✅ | - |
| PII auto-masking | ✅ | - |
| Content filtering | ✅ | - |
| API Key encrypted storage | ✅ (AES-GCM / Tauri Store) | ✅ (local config file) |
| Rate limiting | ✅ | - |
| DM pairing approval | - | ✅ |

### Messaging Platforms & Access

| Channel | HexClaw Desktop | OpenClaw |
|---------|----------------|----------|
| Native desktop UI | ✅ | - |
| Quick Chat window | ✅ | - |
| System tray | ✅ | ✅ (menu bar app) |
| WhatsApp / Telegram / Slack | - | ✅ |
| Discord / Signal / iMessage | - | ✅ |
| Lark / LINE / Teams | - | ✅ |
| Web chat | - | ✅ |
| Voice interaction | - | ✅ (wake word + TTS) |

### Deployment & Operations

| Dimension | HexClaw Desktop | OpenClaw |
|-----------|----------------|----------|
| Installation | Homebrew / DMG / MSI | npm / Docker / Nix |
| Remote access | - | ✅ (SSH / Tailscale) |
| Multi-device sync | - | ✅ (macOS + iOS + Android nodes) |
| Auto update | ✅ (Tauri Updater) | ✅ (stable/beta/dev channels) |
| Browser control | - | ✅ (Chrome DevTools Protocol) |

### Which Should You Choose?

**Choose HexClaw Desktop if you need:**
- Enterprise-grade security (injection detection, PII filtering, content review)
- Visual Agent workflow orchestration (DAG Canvas)
- RAG knowledge base and semantic memory
- Native Chinese LLM support (Qwen, Doubao)
- Team collaboration and centralized management
- A polished native desktop experience

**Choose OpenClaw if you need:**
- Unified AI management across 20+ messaging platforms
- Local gateway + remote access (Tailscale)
- Voice interaction and wake words
- Multi-device node coordination (Mac + iPhone + Android)
- Browser automation
- Lightweight CLI-driven workflow without a GUI

### Complementary, Not Competing

HexClaw Desktop and OpenClaw serve different scenarios and can be used together:

- **OpenClaw** excels at "connecting everything" — unifying AI interaction across all messaging platforms, ideal for individuals integrating all chat tools into one AI assistant
- **HexClaw Desktop** excels at "security and orchestration" — providing enterprise-grade security, visual workflows, and knowledge management, ideal for scenarios requiring fine-grained control and team collaboration

Both follow the **local-first** principle: data is never uploaded to third-party servers, and users retain full control of their privacy.

---

## More Help

- **GitHub Issues**: [Submit a bug or feature request](https://github.com/hexagon-codes/hexclaw-desktop/issues)
- **GitHub Discussions**: [Community discussion](https://github.com/hexagon-codes/hexclaw-desktop/discussions)
- **HexClaw AI**: ai@hexclaw.net
- **HexClaw Support**: support@hexclaw.net
- **About page**: System menu → HexClaw → About HexClaw
