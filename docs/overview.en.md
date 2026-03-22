**English** | [中文](overview.md)

# HexClaw Desktop Overview

If this is your first time seeing HexClaw, start with the overview image below before going into the full guide.

![HexClaw Overview](./assets/hexclaw-desktop-user-overview.png)

## What It Is

HexClaw is not just a chat window. It is a local AI Agent workspace where:

- `Chat` and `IM Channels` are task entry points
- `Knowledge`, `Agents`, and `Integration` are capability layers
- `Logs` are the final diagnostics and troubleshooting loop

The shortest way to understand the product is this:

**Configure the model first, start tasks from Chat or IM, connect Knowledge / Agents / Integration / Automation as needed, and use Logs as the final debugging loop.**

## Recommended First-Run Path

Start in this order:

1. Open `Settings`
2. Configure your LLM provider, API key, base URL, and default model
3. Use `Connection Test / Engine Status` to confirm both model access and local sidecar health
4. Go back to `Chat` and run your first real conversation

Everything else in the product depends on this base path being healthy.

## What Each Main Module Does

### Dashboard

Use `Dashboard` to check system status, model count, knowledge status, channels, and task overview.

### Chat

`Chat` is the main desktop task entry point. It handles multi-turn conversations, file input, document parsing, Artifacts, and research-style tasks.

### IM Channels

`IM Channels` connect Feishu, DingTalk, Discord, Telegram, and other external messaging systems to HexClaw. They are not just notification channels. They are remote task entry points.

### Knowledge

`Knowledge` manages documents and memory, and provides retrieval context for chat and agent execution.

### Agents

`Agents` manage role templates, registered agents, default agents, and routing rules.

### Integration

`Integration` manages tools, MCP services, and diagnostics.

`MCP` means `Model Context Protocol`. In HexClaw it is used to expose external capabilities to AI, such as databases, browser automation, file systems, internal services, and command-line tools.

### Automation

`Automation` manages scheduled jobs and workflow canvas execution.

### Logs

`Logs` are the final place to inspect runtime events, errors, and diagnostics when something does not behave as expected.

## How the Modules Work Together

The easiest way to understand the system is as one main path:

`Chat / IM Channels / Automation -> Execution Path -> Knowledge / Agents / Integration -> Logs`

From a user perspective:

- `Chat` is the main desktop task entry point
- `IM Channels` are external task entry points
- `Automation` triggers tasks proactively
- all of them enter the same execution path
- the execution path calls Knowledge, Agents, and Integration
- the results and failures finally land in Logs

## Can Chat or IM “Control” Other Modules?

Yes, but only as execution entry points.

The better mental model is:

- `Chat / IM` start tasks
- `Knowledge / Agents / Integration` provide capabilities
- configuration pages are still where setup and management happen

So HexClaw is not “chat directly manages everything”. It is “chat can trigger execution that uses other configured capabilities”.

## What To Read Next

- For full usage details, continue with the [User Guide](./guide.en.md)
