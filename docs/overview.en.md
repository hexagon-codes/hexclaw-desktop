**English** | [中文](overview.md)

# HexClaw Desktop Overview

If this is your first time seeing HexClaw, start with the overview image below before going into the full guide.

![HexClaw Desktop architecture swimlane: the workspace connects to a local or cloud service](../.github/assets/desktop-architecture.en.svg)

## What It Is

HexClaw is a native AI Agent workspace connected to an app-managed local service or a cloud service you deploy yourself:

- `Chat`, connected `IM Channels`, and `Automation` are task entry points
- `Knowledge`, `Agents`, `Capabilities`, and scenario packs are capability layers
- `Logs` are the final diagnostics and troubleshooting loop

The shortest way to understand the product is this:

**Choose a service and confirm an available model, start tasks from Chat, IM, or Automation, use knowledge, agents, tools, and scenarios as needed, and confirm completion through actual results and logs.**

## Recommended First-Run Path

Start in this order:

1. Choose the local service, or enter the address and access token for a cloud HexClaw service
2. Use an available default model, or configure a Provider and model if needed. Online models need the required credentials and address; local models need working Ollama and a downloaded model
3. Start a task in `Chat` and confirm completion by receiving a complete response or actual output. A connection check does not replace a task result

The desktop manages the local Sidecar; the server manages the cloud service. Cloud mode does not require a local Sidecar. The services store data separately, and switching does not migrate it. AI tasks need an available model, while configuration and basic information management remain accessible without one.

## What Each Main Module Does

### Chat

`Chat` is the default landing page when the app opens, and the main task entry point. It handles multi-turn conversations, file input, document parsing, Artifacts, research-style tasks, Markdown/math/chemistry rendering, and scenario-instance enhancements such as in-chat tabs, verification badges, and record chips.

### IM Channels

`IM Channels` connect Feishu, DingTalk, Discord, Telegram, and other external messaging systems to HexClaw. They can receive messages that start tasks and return answers, files, or automation results, according to the selected channel's transport capabilities.

### Knowledge

`Knowledge` manages documents and memory, and provides retrieval context for chat and agent execution.

The active HexClaw service's engine handles knowledge retrieval and context injection according to its configuration and retrieval results. The desktop does not independently retrieve and append hidden knowledge text.

### Agents

`Agents` manage role templates, registered agents, and the default agent. Manage channel-to-agent bindings and message routing in `Connections`.

### Scenario Packs

`Scenario packs` are not separate top-level pages. They are enhanced capabilities mounted onto Agent instances.

The current built-in scenario pack is `Homework Tutor`. Creating it from the Agent template library produces a dedicated Agent instance. Within that instance, Tutoring, Learning Records, and Insights show task outputs, learning records, and reports. Tutoring tips, mistake-record chips, and verification badges appear according to task results.

The workspace keeps shared conversation and navigation entry points, while scenario instances display their domain views inside the conversation. Available tasks and records depend on the installed scenario capabilities.

### Capabilities

`Capabilities` manages Skills, MCP services, and the Prompt Library.

`MCP` means `Model Context Protocol`. In HexClaw it is used to expose external capabilities to AI, such as databases, browser automation, file systems, internal services, and command-line tools.

### Automation

`Automation` manages scheduled tasks, Webhooks, and workflows. The current desktop workflow editor uses ordered steps that you configure, reorder, and run.

### Logs

`Logs` are the final place to inspect runtime events, errors, and diagnostics when something does not behave as expected.

## How the Modules Work Together

The easiest way to understand the system is as one main path:

![HexClaw Desktop task swimlane: entry points, execution, capabilities, and delivery](../.github/assets/desktop-task-workflow.en.svg)

From a user perspective:

- `Chat` is the main desktop task entry point
- `IM Channels` are external task entry points
- `Automation` triggers tasks proactively
- all of them enter the same execution path
- the execution path calls Knowledge, Agents, Capabilities, and scenario-pack capabilities
- the results and failures finally land in Logs

## Can Chat or IM “Control” Other Modules?

Yes, but only as execution entry points.

The better mental model is:

- `Chat / IM` start tasks
- `Knowledge / Agents / Capabilities / scenario packs` provide capabilities
- configuration pages are still where setup and management happen

So HexClaw is not “chat directly manages everything”. It is “chat can trigger execution that uses other configured capabilities”.

## What To Read Next

- For full usage details, continue with the [User Guide](./guide.en.md)
