**English** | [中文](guide.md)

# HexClaw Desktop User Guide

Applies to Desktop `v0.5.0-beta.3`, with bundled backend source from `v0.5.0-beta.1`. See the [Changelog](../CHANGELOG.md) for this engineering update and the [Auto-Update Release Guide](./updates.en.md) for installation and update-release requirements.

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

| Platform | Runtime requirements |
|----------|----------------|
| macOS | 14 (Sonoma) or later for the current bundled local inference and document-rendering components; Apple Silicon / Intel |
| Windows | 10 (1809) or later |
| Linux | Release builds use Ubuntu 22.04; the runtime must provide WebKitGTK 4.1 and other Tauri dependencies |

The app shell's configured macOS 11 minimum does not describe the compatibility of bundled components. See the [Ollama macOS requirements](https://docs.ollama.com/macos) and [Tauri Linux distribution dependencies](https://v2.tauri.app/distribute/debian/).

### Installation

**macOS: one-line install (recommended)**

```bash
curl -fsSL https://raw.githubusercontent.com/hexagon-codes/hexclaw-desktop/bb3c12ec91eec91798b67c292bc8c85c4481dc2b/install.sh | bash
```

The script detects Apple Silicon or Intel, downloads a published installer (including prereleases), and installs it at `/Applications/HexClaw.app`.

**macOS (Homebrew)**

```bash
brew tap hexagon-codes/tap
brew install --cask hexclaw
```

**macOS / Windows / Linux (Manual download)**

1. Go to the [GitHub Releases](https://github.com/hexagon-codes/hexclaw-desktop/releases) page
2. Download the installer for your platform:
   - macOS: `.dmg` file — double-click and drag to Applications
   - Windows: `.exe` (NSIS) installer
   - Linux: `.deb` (Debian/Ubuntu) or `.AppImage`
3. Launch HexClaw

### First Launch

1. **Choose a service** — use the local service during initial setup, or enter the address and access token for a cloud HexClaw service.
2. **Check the model** — start a task directly if the selected service already has a working default model; otherwise configure a Provider and model. Online models need the required credentials and address plus a connection test. Local models need a working Ollama instance and a downloaded model, without a cloud API Key.
3. **Start chatting** — open Chat and send your first message or attachment.

Local and cloud services keep separate conversations, model configurations, and business data. Switching services does not migrate or merge them. The service can start without a configured model; AI tasks need an available model, while local Ollama models do not need a cloud API key.

### macOS Security Warning

First launch may show "Cannot verify developer". To resolve:

- **Option A**: System Settings → Privacy & Security → find HexClaw → click "Open Anyway"
- **Option B**: Run in terminal: `xattr -cr /Applications/HexClaw.app`

## Auto-Update Releases

HexClaw already integrates Tauri updater. The app performs a silent update check on launch, and users can manually check or install updates from the **About** page.

If you only need local packaging for testing:

- You do not need an updater private key
- Trigger `Release` manually with a fixed commit SHA to build test installers; it disables updater artifacts automatically when the signing key is missing
- These packages can be installed manually. A version without signed updater artifacts cannot be an update target; an installed app can still check for and install a later valid signed version
- macOS remains an unsigned DMG distributed through the existing Homebrew Cask; Apple Developer ID signing and notarization are not required

If you want a real auto-update release:

- You must configure the Tauri updater signing private key
- You must keep `plugins.updater.pubkey` in [src-tauri/tauri.conf.json](../src-tauri/tauri.conf.json)
- You must publish through the tag-driven `Release` workflow so it can generate signed updater artifacts and `latest.json`
- Tauri updater artifact signing is independent of Apple code signing; macOS remains an unsigned DMG without additional Apple signing or notarization requirements

See [Auto-Update Release Guide](./updates.en.md) for the full setup.

---

## Interface Overview

The window contains sidebar navigation and the active page. Chat can include a session list, conversation area, and an output preview when needed. The example below shows the K12 skin; other pages and tasks display their own content.

![K12 workspace showing an annotated homework image](../.github/assets/desktop-k12-workspace.png)

This is the same official tutorial image used in the [README](../README.en.md); see its caption for version scope. Homework content is an **AI-generated example, not real student work**.

### Sidebar Navigation

The navigation uses a grouped design with 8 top-level entries. The app opens to `Chat` by default.

**Chat** (pinned on top, no group header)

| Page | Description | Sub-tabs |
|------|-------------|----------|
| Chat | AI multi-turn conversation, session management, Artifacts, research mode (default landing) | — |

**Build**

| Page | Description | Sub-tabs |
|------|-------------|----------|
| Agents | Role templates, registered instances, the default Agent, and personas | — |
| Knowledge | Knowledge and memory management | Documents · Long-term Memory |
| Automation | Scheduled tasks, Webhooks, and workflows | Scheduled Tasks · Webhooks · Workflows |

**Connections**

| Page | Description | Sub-tabs |
|------|-------------|----------|
| Connections | IM channels, accounts, and data connectors for the active service, including Lark and DingTalk task entry points | — |
| Capabilities | External tools and service integration | Skills · MCP · Prompt Library |

**System**

| Page | Description |
|------|-------------|
| Logs | Real-time runtime log viewing and filtering |
| Settings | LLM configuration, automation permissions, and system settings; Webhooks are managed in Automation |

### Engine Status Indicator

The sidebar bottom shows the HexClaw Engine runtime status:

- **Green + "Engine running"** — the active backend is ready; model and tool availability depends on their configuration and actual results
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

| Connection | Prerequisites |
| --- | --- |
| Online Providers such as OpenAI, DeepSeek, Anthropic, Gemini, Qwen, and Doubao | Configure the relevant credentials/address on the active service and enable available models |
| Custom OpenAI-compatible service | The service's compatible endpoint, credentials, and model ID |
| Ollama local models | Ollama must be reachable from the executing service, with the selected model downloaded |

If the active service already has an available default model, start a task directly. Otherwise select a Provider and model in **Settings → LLM Configuration**. Online models need the required API Key and address; local Ollama models do not need a cloud API Key.

### Quick Chat

Press `⌘+Shift+H` (macOS) or `Ctrl+Shift+H` (Windows/Linux) to summon the Quick Chat window from anywhere, without switching to the main interface. Quick Chat uses the same Auto-RAG and model parameter pass-through capabilities as the main chat.

---

## Agent Management

### Creating an Agent

1. Open **Agents**, choose Create Agent, then start blank or apply a template.
2. Set the internal name, then the display name and Persona (SOUL) as needed. The internal name is used for `@` mentions and system lookup and cannot be changed after creation; the display name remains editable.
3. Select a Provider/model, reasoning policy, sampling settings, and Skills as needed; leave inherited settings at their defaults when appropriate.
4. Save and enter the instance's conversation from its Agent card.

### Agent Role Templates

Built-in preset roles:

| Role | Use Case |
|------|----------|
| General Assistant | General questions, task planning, and organization |
| Support Agent | Troubleshooting, responses, and ticket workflows |
| Content Writer | Social copy, titles, and topic suggestions |
| Coding Buddy | Code reading, debugging, and command execution |
| Translator | Translation and terminology |
| Daily Report / Email Assistant | Reports, email drafts, and replies |
| Data Analyst / Knowledge Q&A / Research Assistant | Data interpretation, knowledge retrieval, and research |
| Meeting Notes | Turn existing discussion content into notes and action items |

### Multi-Agent Collaboration

Route channel messages to an Agent through Connections. For multi-role tasks, a workflow parallel step can call configured roles and merge their results; see [Workflows](#workflows-workflows-tab).

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

- **Agent card**: enter the child's tutoring conversation and view that instance's learning records and reports
- **Chat page**: select the corresponding tutor conversation, then use Tutoring, Learning Records, and Insights to view tasks and records

### Tutoring Flow

In the “Tutor” tab you can:

- Type a problem or paste a homework photo
- Receive teaching tips and the complete solution for parents, without unlocking the answer through three successive stages
- Optionally provide the child's answer so the explanation can address the actual response
- Read verification badges that distinguish program verification, model review, out-of-scope handling, and unverifiable answers

After you send a homework image, the task automatically recognizes, evaluates, and generates results. You do not need to confirm recognized problems or grade them one at a time. The main output of image grading is the original image with annotations; processing status or explanatory text does not replace that final image. Image solving, writing review, and artwork review return results for their respective tasks.

Content that remains unreadable after automatic recognition is marked as unrecognizable in the result and forms part of the task's final outcome. Readable problems are completed normally. Unreadable content is not guessed, assigned invented answers, marked wrong, or recorded as a mistake or mastery conclusion. You can voluntarily send a clearer photo as a new input.

Technical failures, including Provider timeouts, unknown call outcomes, and protocol errors, are reported separately and are not disguised as unrecognizable content. Avoid repeatedly sending the same request when its outcome is unknown.

The desktop and connected DingTalk channels share the same image-task progression and final outcomes. You do not need to classify a photo as new homework or returned practice. The system links reliably matched historical problems within the current child's scope. If no reliable match is available, it still returns the image without changing historical review status.

### Mistake Book, Notebook, and Insights

View the following in the child's Learning Records and Insights:

- **Mistakes**: the first screen leads with the “Due this week” review queue, showing problems due for review with topic, error cause, and review status; supports “one more to practice” and “mark mastered”. “All mistakes” is a collapsible archive you expand when needed. You can also “Log a mistake” by hand to file offline homework and in-class mistakes
- **Notes**: Chinese / English phrases, poems, grammar points, and writing materials
- **Insights**: new mistakes, review completion, top weak topics, and repeated-setback alerts

Review records and mastery are tracked separately. Reviewed does not mean mastered, and an incorrect answer remains due for review. Review evidence is accumulated only for answers actually covered and reliably evaluated; unreadable content is excluded, and replaying the same task does not count twice.

### Tutoring Tips for This Homework

When a task returns “Tutoring tips for this homework,” the content appears directly in the conversation. It combines the homework's problems, mistakes, and insights to explain how to teach them. Parents do not need to confirm recognized problems or open a separate panel.

Each section carries a source label, such as:

- `📖 From textbook`
- `🗂 Local records`
- `✅ Program-verified`
- `🤖 AI summary (for reference)`

The inline tips support copying the text so you can paste it into phone IM.

### Backup, Export, and Automation

- The Mistake Book can generate a review paper from the due review queue or customize the source scope, item count, variants per source, and difficulty. Print or export using the formats offered by the output preview
- Family learning archives can be exported and restored as `.hexbak` files with version header and checksum
- After profile creation, HexClaw attempts to register default automation jobs. If cron is not enabled in the current runtime, it degrades silently and does not block creation
- Bind a parent's one-to-one direct conversation with the bot to a child instance; that conversation then routes by the binding. K12 does not accept group-chat bindings

---

## Knowledge Center

Open Knowledge in the sidebar, then switch between Documents and Long-term Memory.

### Knowledge Base (Documents Tab)

RAG (Retrieval-Augmented Generation) based knowledge management:

#### Upload Documents

1. Open **Knowledge**, select **Documents**, then add a document or upload a file.
2. The current upload entry accepts PDF, Markdown, TXT, DOC/DOCX, PPTX, CSV, JSON/JSONL, HexBank, and PNG/JPEG/WebP/GIF images. Processing depends on the service's parser and model dependencies.
3. Inspect persistent processing, source-content, and index states after upload. Images need a vision model for transcription; vector indexing needs an available Embedding service.
4. Check readable source content, keyword retrieval, and vector retrieval separately. Upload acceptance does not mean all processing is complete. Use the document retry/recovery entry for failures while preserving completed work.

#### Using the Knowledge Base

The active HexClaw engine retrieves knowledge according to service configuration and task policy, then adds matching evidence to the model context. Retrieval eligibility, result count, and relevance thresholds depend on configuration and the task. The desktop does not independently retrieve and append hidden text before sending. When the task returns source evidence, inspect it alongside the answer.

You can also search documents and rebuild indexes.

#### Document Detail View

Open a document to read its complete content from the active service document-detail endpoint, with processing details loaded separately. A source read failure exposes an error and retry action. Search chunks are not assembled into a substitute for the complete source, and a processing-detail failure does not replace the source read result.

### Memory System (Memory Tab)

HexClaw supports cross-session long-term memory:

- **Session context** — current conversation history; when enabled, compaction summarizes older messages at the configured message threshold and retains recent content, rather than imposing a fixed 50-turn limit
- **Long-term memory** — cross-session persistent knowledge and preferences
- **Semantic search** — retrieve relevant memories based on vector similarity

Use **Knowledge → Long-term Memory** to inspect, search, and manage persistent entries and adjust memory behavior or the user profile. Clearing memory acts on the active service; confirm the intended data scope first.

---

## Automation

The Automation page manages scheduled tasks, Webhooks, and workflows through in-page tabs.

### Scheduled Tasks (Tasks Tab)

Use Cron expressions to periodically execute Agent tasks:

1. Go to **Automation**, then select **Scheduled Tasks**
2. Click "New Task"
3. Configure:
   - **Name** — task description
   - **Cron expression** — e.g. `0 9 * * *` (daily at 9:00)
   - **Prompt** — the Agent instruction to execute
4. Tasks support pause/resume/manual trigger, with execution history
5. View task notices in the in-app notification center and inspect the actual output in execution history

### Workflows (Workflows Tab)

Edit Agent workflows as ordered steps:

1. Go to **Automation** and select **Workflows**
2. Create a workflow or open an existing one
3. Add and configure input, model processing, tool, parallel fan-out, or output steps
4. Move steps up or down to set execution order, then save
5. Click Run and inspect step status and the final output

The current desktop editor builds linear connections in step order. A parallel fan-out step can call multiple configured roles and combine their results. It does not provide a drag-and-connect canvas for editing arbitrary DAGs.

---

## Integration

The Capabilities page manages tool integrations through Skills, MCP, and Prompt Library tabs.

### Skill System (Skills Tab)

Skills are external tool capabilities that Agents can invoke.

**Installed Skills**: View and manage installed Skills, with enable/disable toggle.

**ClawHub Skill Marketplace**: Browse, search, and install community-contributed Skills. Filter by category (coding/research/writing/data/automation), with one-click install/uninstall.

### MCP Tool Integration (MCP Tab)

[Model Context Protocol (MCP)](https://modelcontextprotocol.io/) is a standardized AI tool integration protocol.

1. Go to **Capabilities**, then select **MCP**
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

Manage IM channels for the active service in Connections to start tasks remotely outside the desktop UI.

Chat with AI remotely via IM channels:

1. Go to **Connections** and manage IM channels
2. Click "Add Channel"
3. Supported IM platforms:
   - **Lark** (飞书)
   - **DingTalk** (钉钉)
   - **WeCom** (企业微信)
   - **Slack**
   - **Discord**
   - **Telegram**
   - **WeChat** (微信)
4. Enter the selected platform's credentials, reception mode, and required connection parameters. Fields differ by platform; see the [HexClaw channel configuration guide](https://github.com/hexagon-codes/hexclaw/blob/main/docs/install.en.md)
5. Test channel connectivity online

Image tasks received through connected channels use the same Agent execution flow and return annotated images or other actual task outputs without a separate recognition confirmation step. A connectivity test establishes connection status; receiving the task output establishes that the task completed. In cloud mode, the selected cloud service manages channels and tasks. When the server, models, and connections remain available, shutting down the computer does not stop DingTalk tutoring.

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

Settings has three areas: **LLM Configuration, Automation Permissions, and System Settings**. Manage Webhooks in **Automation → Webhooks** and persistent memory in **Knowledge → Long-term Memory**.

### LLM Configuration

| Option | Description |
|--------|-------------|
| Provider | LLM service provider |
| Default model | Select the active service's default chat model from enabled models |
| Model management | Fetch the model catalog, add custom models, and enable or disable the models you need |
| API Key | Provider API key |
| Base URL | Custom API endpoint (optional) |
| Connection test | Check the Provider interface connection; task completion still requires an actual answer or output |

### Automation Permissions

In **Settings → Automation Permissions**, choose Function First, Strict Approval, or Full Access, then inspect pending tasks, task-specific grants, audit records, and the effective policy matrix. Full Access requires an additional confirmation. Individual task approvals take place in the creation flow or task cards.

Permission approval does not establish that a model, connector, or external service is available, or that a task has succeeded. Inspect automation execution states and results in **Automation**.

### System Settings

- **Theme**: Light / Dark / Follow system, applied immediately
- **Language and startup**: Select the interface language and configure launch at login
- **Local and cloud services**: Inspect connection status and manage backend services
- **Runtime options**: Persistent memory and sandbox network toggles
- **System information**: Inspect the version, storage file, knowledge index, and API address

### Notifications

The in-app notification center collects approvals, task results, channel messages, and service state changes. Mark notifications as read and open their related pages. Business notifications can also appear as in-app toasts; the current Settings page has no separate notification or sound toggle.

### Runtime Engine

Inspect the selected local/cloud service and connection state in the Settings service card; view Desktop, backend, and component versions in About. Hexagon and ai-core are engine/capability libraries used by the backend, not separate services you must start.

A healthy service connection does not prove that the selected model, knowledge processing, or delivery task succeeded; inspect the actual task result.

The desktop manages the local Sidecar's lifecycle; the server manages the cloud service. Switching services does not migrate conversations, learning records, model settings, or channel connections.

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
| `⌘+5` | Switch to Connections |
| `⌘+6` | Switch to Capabilities |
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

**Cause**: The selected HexClaw service is not ready. In local mode, the Sidecar may not have started or may be unhealthy. In cloud mode, check the service address, access token, and server availability.

The process and port checks below apply only to the local service. Cloud mode does not require a local Sidecar, and the desktop does not restart cloud processes.

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
2. Confirm that the active service has an available model; online models need the corresponding Provider credentials, while local models need working Ollama and a downloaded model
3. Check connectivity from the executing service to the selected model
4. Check the Logs page for detailed error information

### App Crash

Check system logs:
- macOS: `Console.app` → search for "HexClaw"
- Or launch directly from terminal to see output:

```bash
# macOS
/Applications/HexClaw.app/Contents/MacOS/hexclaw-desktop

# Read local Sidecar logs
tail -n 100 ~/.hexclaw/hexclaw.log
```

### Reset App Data

For a complete local reset on macOS, quit Desktop, stop any HexClaw service using the same data directory, and back up the data you want to keep first.

> **Warning**: The commands below delete local conversations, Agents, model settings, memory, and desktop connection information. They cannot be directly undone and do not delete data on a cloud backend.

```bash
# Delete app data
rm -rf ~/.hexclaw

# Delete desktop app data
rm -rf ~/Library/Application\ Support/com.hexclaw.desktop
```


---

## Choosing an execution environment

HexClaw Desktop suits users who want to work with conversations, knowledge, tools, automation, and homework tutoring in one native workspace. Choose where tasks execute:

| Need | Setup |
| --- | --- |
| Run on this computer | Use the app-managed local Sidecar and configure models and tools available on this device |
| Continue server-side work while the computer is off | Deploy a cloud HexClaw service, configure its models/tools/IM bindings, then connect using the service address and token |
| Use an online model | Provide credentials and network access from the executing service; that Provider receives the task content sent to it |
| Use a local model | Make Ollama and the selected model available to the executing service; tool and document-rendering dependencies remain separate |

Local and cloud services store their own sessions, records, configuration, and connections. Switching services does not automatically synchronize or migrate those data. Shared cloud access does not by itself establish a team-management or cross-device synchronization feature.

For other products such as [OpenClaw](https://github.com/openclaw/openclaw), use that project's current official documentation to evaluate its features, installation, and boundaries. This guide describes HexClaw's implementation and usage paths.

---

## Changelog

Version changes are maintained in [CHANGELOG](../CHANGELOG.md). This guide describes current usage; historical interfaces and flows belong to their matching versions.

---

## More Help

- **Development and contributions**: [Contributing guide](../CONTRIBUTING.en.md)
- **GitHub Issues**: [Submit a bug or feature request](https://github.com/hexagon-codes/hexclaw-desktop/issues)
- **HexClaw AI**: ai@hexclaw.net
- **HexClaw Support**: support@hexclaw.net
- **About page**: System menu → HexClaw → About HexClaw
