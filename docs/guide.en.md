**English** | [中文](guide.md)

# HexClaw Desktop User Guide

## Table of Contents

- [Overview](#overview)
- [Installation & First Launch](#installation--first-launch)
- [Auto-Update Releases](#auto-update-releases)
- [Interface Overview](#interface-overview)
- [AI Chat](#ai-chat)
- [Agent Management](#agent-management)
- [Scenario Packs & K12 Tutoring](#scenario-packs--k12-tutoring)
- [Knowledge Center](#knowledge-center)
- [Automation](#automation)
- [Integration](#integration)
- [IM Channels](#im-channels)
- [Logs](#logs)
- [Settings & Configuration](#settings--configuration)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [System Tray](#system-tray)
- [Troubleshooting](#troubleshooting)
- [Changelog](#changelog)

---

## Overview

If you want the fastest way to understand how HexClaw is meant to be used, start with the [Overview](./overview.en.md).

It focuses on three questions:

- what to do after the first launch
- what each main module is responsible for
- how Chat, IM, Knowledge, Agents, Integration, and Automation work together

Then come back to this guide for the detailed workflow and page-level instructions.

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

## Auto-Update Releases

HexClaw already integrates Tauri updater. The app performs a silent update check on launch, and users can manually check or install updates from the **About** page.

If you only need local packaging for testing:

- You do not need an updater private key
- The `Package` workflow disables updater artifacts automatically when the signing key is missing
- Those packages can be installed manually, but they cannot be used for in-app auto updates
- macOS targets still require Apple signing / notarization secrets; otherwise the workflow fails early instead of producing browser-downloaded bundles that Gatekeeper treats as "damaged"

If you want a real auto-update release:

- You must configure the Tauri updater signing private key
- You must keep `plugins.updater.pubkey` in [src-tauri/tauri.conf.json](../src-tauri/tauri.conf.json)
- You must publish through the tag-driven `Release` workflow so it can generate signed updater artifacts and `latest.json`
- If macOS targets are included, you must also configure Apple code-signing and notarization secrets

See [Auto-Update Release Guide](./updates.en.md) for the full setup.

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

The navigation uses a grouped design with 8 top-level entries. The app opens to `Chat` by default.

**Chat** (pinned on top, no group header)

| Page | Description | Sub-tabs |
|------|-------------|----------|
| Chat | AI multi-turn conversation, session management, Artifacts, research mode (default landing) | — |

**Build**

| Page | Description | Sub-tabs |
|------|-------------|----------|
| Agents | Agent templates, running instances, routing rules, conference mode | — |
| Knowledge | Knowledge and memory management | Knowledge · Memory |
| Automation | Scheduled tasks and Webhook notifications | Tasks · Webhooks |

**Connections**

| Page | Description | Sub-tabs |
|------|-------------|----------|
| IM Channels | Feishu / DingTalk / WeCom / Discord / Telegram remote task entries | — |
| Integration | External tools and service integration | Skills · MCP · Prompts |

**System**

| Page | Description |
|------|-------------|
| Logs | Real-time runtime log viewing and filtering |
| Settings | LLM providers, security, notifications, webhooks, theme, locale, etc. |

### Engine Status Indicator

The sidebar bottom shows the HexClaw Engine runtime status:

- **Green + "Engine running"** — backend service is healthy, all features available
- **Red + "Engine stopped"** — backend service is not ready, AI features unavailable

---

## AI Chat

### Basic Usage

1. Click **Chat** in the sidebar
2. Type your message in the input box at the bottom, press `Enter` to send
3. AI responses support Markdown, syntax highlighting, KaTeX math, and mhchem chemistry rendering
4. Use `Shift+Enter` to insert a newline for multi-line input

### Session Management

- **New session**: Click the "+" button on the left side of the chat page
- **Switch session**: Click a history session in the session list
- **Search sessions**: Use the search feature to find past conversations
- **Export session**: Export chat history is supported
- **Scenario sessions**: Scenario-instance sessions are pinned automatically. If the session title is still the internal Agent ID, the list shows the Agent display name instead.

### Message Badges

Chat messages support generic message decorations:

- **Verification badge**: when the backend returns `metadata.verify` or a solve verdict, the message shows verified / disagree / out-of-scope / unverifiable state
- **Record chip**: when the backend writes a result into a record collection, the message shows the target record book and key fields

These badges are rendered from generic contracts, not from a K12-only component.

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

Press `⌘+Shift+H` (macOS) or `Ctrl+Shift+H` (Windows/Linux) to summon the Quick Chat window from anywhere, without switching to the main interface. Quick Chat uses the same Auto-RAG and model parameter pass-through capabilities as the main chat.

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

### Scenario Templates

In addition to generic role templates, the template library can expose scenario-pack templates. The current built-in scenario template is **Homework Tutor**.

Create a Homework Tutor:

1. Go to the **Agents** page
2. Choose **Homework Tutor** from the template library
3. Fill in child name, grade term, and textbook edition
4. Keep the default tutoring skills unless you need to adjust optional skills in the advanced section
5. Create the instance. The display name uses the child name plus the selected grade term, for example “Ming's Study Assistant · 五年级” (a helper that guides parents as professionally as a teacher)

Create one instance per child. Profile, Mistake Book, Notebook, insights, and memory are isolated by Agent instance.

---

## Scenario Packs & K12 Tutoring

K12 Homework Tutor is the current built-in scenario pack. It is not a separate page; it is an enhanced view mounted on an Agent instance.

### Entry Points

After creating a Homework Tutor, you can enter it from:

- **Agent card**: click “Tutor” to enter chat, or “Mistakes” to open the record view
- **Chat page**: select the study assistant session, then use the top “Tutor / Mistakes” tabs

### Tutoring Flow

In the “Tutor” tab you can:

- Type a problem or paste a homework photo
- Use progressive hints: directional hint → specific hint → full explanation
- Provide the child's answer so the system can tailor the next hint
- Read verification badges that distinguish program verification, model review, out-of-scope handling, and unverifiable answers

For homework photos, the frontend calls `/api/k12/recognize` to extract structured problems. After you confirm the recognized problems, each one can be graded separately. Once confirmed, the chat stream automatically inlines a “Tutoring tips for this homework” block that tells the parent how to teach it and where the pitfalls are, so there is no separate panel to open.

### Mistake Book, Notebook, and Insights

The “Mistakes” tab contains three subviews:

- **Mistakes**: the first screen leads with the “Due this week” review queue, showing problems due for review with topic, error cause, and review status; supports “one more to practice” and “mark mastered”. “All mistakes” is a collapsible archive you expand when needed. You can also “Log a mistake” by hand to file offline homework and in-class mistakes
- **Notes**: Chinese / English phrases, poems, grammar points, and writing materials
- **Insights**: new mistakes, review completion, top weak topics, and repeated-setback alerts

Mistake status moves through `To review → Explained → Redone → Mastered → Archived`. The due review queue is returned by the backend and rendered by the frontend through record schemas.

### Tutoring Tips for This Homework

After you confirm the recognized problems, the chat stream automatically inlines a “Tutoring tips for this homework” block. It combines this homework's problems, mistakes, and insights into a one-page “how to teach” card, so the parent never has to open a separate panel.

Each section carries a source label, such as:

- `📖 From textbook`
- `🗂 Local records`
- `✅ Program-verified`
- `🤖 AI summary (for reference)`

The inline tips support copying the text so you can paste it into phone IM.

### Backup, Export, and Automation

- The Mistake Book can generate a “Review paper”: use “One-tap review paper” (zero config, auto-built from the due review queue) or “Custom paper” (customize item count, topics, and other parameters), then print or export as PDF / Word
- Family learning archives can be exported and restored as `.hexbak` files with version header and checksum
- After profile creation, HexClaw attempts to register default automation jobs. If cron is not enabled in the current runtime, it degrades silently and does not block creation
- When IM is bound, family-chat messages can be routed to the correct child's study assistant instance

---

## Knowledge Center

The Knowledge Center combines document knowledge base and long-term memory management, accessible via in-page tabs.

### Knowledge Base (Documents Tab)

RAG (Retrieval-Augmented Generation) based knowledge management:

#### Upload Documents

1. Go to the **Knowledge Center** page, select the **Documents** tab
2. Click "Upload Document"
3. Supported formats: PDF / Markdown / TXT / DOCX
4. Documents are automatically parsed, chunked, and vectorized

#### Using the Knowledge Base

During conversations, Auto-RAG automatically searches the knowledge base before sending each message. Hits with a relevance score >= 0.35 are injected into the backend context, giving the AI more accurate reference material. The user still sees only their original question in the chat UI; the knowledge context is visible only on the backend side.

You can also search documents and rebuild indexes.

#### Document Detail View

Click a document in the knowledge base list to view its full content. The system first tries `GET /documents/{id}` to fetch the complete body; if the backend does not support that endpoint, it falls back to searching the document title and reassembling the content from chunks in order.

### Memory System (Memory Tab)

HexClaw supports cross-session long-term memory:

- **Short-term memory** — current session context (up to 50 turns, auto-summarized when exceeded)
- **Long-term memory** — cross-session persistent knowledge and preferences
- **Semantic search** — retrieve relevant memories based on vector similarity

In the Knowledge Center's **Memory** tab you can view, search, edit, and clear stored memories.

---

## Automation

The Automation page combines scheduled tasks and workflow canvas, accessible via in-page tabs.

### Scheduled Tasks (Tasks Tab)

Use Cron expressions to periodically execute Agent tasks:

1. Go to the **Automation** page, select the **Tasks** tab
2. Click "New Task"
3. Configure:
   - **Name** — task description
   - **Cron expression** — e.g. `0 9 * * *` (daily at 9:00)
   - **Prompt** — the Agent instruction to execute
4. Tasks support pause/resume/manual trigger, with execution history
5. Results are sent as system notifications

### Workflow Canvas (Canvas Tab)

Visually orchestrate Agent workflows:

1. Go to the **Automation** page, select the **Canvas** tab
2. Choose from the template gallery or create manually
3. Add nodes (Agent / Tool / Condition / Output)
4. Connect nodes to establish execution flow
5. Click "Run" to execute the entire workflow

Supports DAG (Directed Acyclic Graph) execution engine with automatic parallel processing of independent nodes. Includes built-in templates (daily digest, email classification, research pipeline, code review, etc.).

---

## Integration

The Integration page manages external tool capabilities, with three sub-tabs: Skills, MCP, and Prompts.

### Skill System (Skills Tab)

Skills are external tool capabilities that Agents can invoke.

**Installed Skills**: View and manage installed Skills, with enable/disable toggle.

**ClawHub Skill Marketplace**: Browse, search, and install community-contributed Skills. Filter by category (coding/research/writing/data/automation), with one-click install/uninstall.

### MCP Tool Integration (MCP Tab)

[Model Context Protocol (MCP)](https://modelcontextprotocol.io/) is a standardized AI tool integration protocol.

1. Go to the **Integration** page, select the **MCP** tab
2. Click "Add Server"
3. Configure the connection:
   - **stdio** — local process communication
   - **SSE** — Server-Sent Events
   - **Streamable HTTP** — HTTP streaming
4. Once connected, tools provided by the server are automatically registered to the Agent's available tool list
5. View tool listings and test tools online

### Prompt Library (Prompts Tab)

The Prompt Library manages reusable prompt templates. You can create, search, and maintain common prompts, then reuse them from chat input.

---

## IM Channels

IM Channels are a separate top-level entry for starting tasks remotely outside the desktop UI.

Chat with AI remotely via IM channels:

1. Go to the **IM Channels** page
2. Click "Add Channel"
3. Supported IM platforms:
   - **Lark** (飞书)
   - **DingTalk** (钉钉)
   - **WeCom** (企业微信)
   - **Slack**
   - **Discord**
   - **Telegram**
   - **WeChat** (微信)
4. Enter the corresponding platform's Bot Token or Webhook URL
5. Test channel connectivity online

---

## Logs

Real-time log viewing and filtering:

1. Go to the **Logs** page
2. Receive real-time log streams via WebSocket
3. Filter by level: debug / info / warn / error
4. Filter by domain for specific module logs
5. Expand individual log entries for details
6. View recent failure summary
7. Download log files

---

## Settings & Configuration

### LLM Configuration

| Option | Description |
|--------|-------------|
| Provider | LLM service provider |
| Model | Model name |
| API Key | Provider API key |
| Base URL | Custom API endpoint (optional) |
| Temperature | Generation randomness (0-2), passed through to backend (WebSocket and HTTP paths) |
| Max Tokens | Maximum output token count, passed through to backend (WebSocket and HTTP paths) |

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
| `⌘+3` | Switch to Knowledge page |
| `⌘+4` | Switch to Automation page |
| `⌘+5` | Switch to IM Channels page |
| `⌘+6` | Switch to Integration page |
| `⌘+7` | Switch to Logs page |
| `⌘+8` | Switch to Settings page |
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
  - Open HexClaw (show main window)
  - Quick Chat... (quick chat window)
  - Logs (view logs)
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

## Changelog

### v0.5.0-beta

**New Features**
- Built-in K12 Homework Tutor scenario pack: Homework Tutor template, child profile, default skill binding, and enhanced Tutor / Mistakes views.
- Added Mistake Book (first screen leads with the “Due this week” review queue, a collapsible “All mistakes” archive, and manual “Log a mistake” entry), Notebook (compact one-line records, low-frequency subject filters, details, and manual entries), insights, inline “Tutoring tips for this homework” (auto-shown after you confirm recognized problems), review-paper (one-tap / custom) print/export, and `.hexbak` family learning archive backup/restore.
- (Finalized in the 2026-07-09 product review) The study assistant display name is unified as “{child}'s Study Assistant”; the lesson prep card becomes tutoring tips inlined after recognition is confirmed; paper generation is unified as “Review paper”; the Mistake Book first screen leads with the review queue and supports manual entry; the study-time metric is removed.
- Chat messages now support verification badges and record chips, rendered from generic contracts for program verification, model review, out-of-scope, unverifiable, and record-save states.
- Markdown rendering supports GitHub-style task lists, strikethrough, and tables, as well as KaTeX math and mhchem chemistry formulas. Tutoring explanations, grading details, retry problems, and record details use the same renderer.

**Experience and Engineering**
- The sidebar shows the HexClaw product version; the Hexagon engine version is shown separately on the About page.
- The splash screen is shown for at least 700ms, and packaged Tauri assets use relative paths to reduce cold-start flashing and asset-loading failures.

**Architecture**
- Added `scenarioRegistry`, view descriptors, record schemas, VerifyResult, and scenario-extension contracts so scenario packs mount through descriptors without changing the generic shell.
- Added frontend `/api/k12/*` type contracts covering recognition, grading, review queue, tutoring tips, insights, profile, backup, export, IM binding, and automation provisioning.
- LLM providers now use a three-layer model contract—catalog, enabled pool, and current default. Catalogs with up to 10 models are enabled automatically; larger catalogs are curated and explicitly applied in the model manager, while chat defaults are restricted to chat-capable models.

### v0.3.0

**Bug Fixes**
- Fixed Ollama model prewarming not working in desktop app (CSP missing port 11434)
- Fixed prewarming triggering even when user selected a non-Ollama provider
- Fixed agent session title not updating in sidebar after navigation
- Fixed MCP server tools remaining visible after server deletion
- Fixed empty AI replies displaying as regular message bubbles (now shows notice style)
- Fixed streaming tool calls not executing (switched to full tool execution loop)
- Fixed reasoning/thinking content lost after closing and reopening sessions (backend now persists reasoning in metadata)

**New Features**
- Dynamic model discovery: automatically fetches available models from provider API after successful connection test
- Auto-test on API Key input: debounced 1.5s auto-validation when typing API Key
- Chip-style model selector: replaced card list with compact clickable chips
- MCP `~` path expansion: cross-platform home directory support in server args
- Feishu thinking placeholder: shows "🤔 Thinking..." while AI processes, then replaces with final reply
- Adaptive chat width: `min(90%, 960px)` for wider messages on large screens

**UI Improvements**
- Settings save button label changed to "Save Config"
- Removed non-functional search box from settings toolbar
- Model chips show "Dynamically fetched · just synced" hint below

---

## More Help

- **GitHub Issues**: [Submit a bug or feature request](https://github.com/hexagon-codes/hexclaw-desktop/issues)
- **GitHub Discussions**: [Community discussion](https://github.com/hexagon-codes/hexclaw-desktop/discussions)
- **HexClaw AI**: ai@hexclaw.net
- **HexClaw Support**: support@hexclaw.net
- **About page**: System menu → HexClaw → About HexClaw
