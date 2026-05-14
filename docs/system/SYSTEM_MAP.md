# HexClaw System Map

> 日期：2026-05-14 | 自动生成

---

## 系统拓扑

```
┌─────────────────────────────────────────────────────────┐
│                    Tauri Desktop App                      │
├──────────────┬──────────────┬───────────────────────────┤
│   Frontend   │   Backend    │        Resources          │
│   (Vue 3)    │   (Rust)     │                           │
├──────────────┼──────────────┼───────────────────────────┤
│ ChatView     │ IPC Bridge   │ skills/summarize/SKILL.md │
│ WorkspaceView│ Window Mgmt │ skills/bulletize/SKILL.md │
│ RuntimeView  │ File System  │ binaries/ollama-bundle/   │
│ DashboardView│              │                           │
├──────────────┴──────────────┴───────────────────────────┤
│                    Runtime Layer                          │
├─────────────────────────────────────────────────────────┤
│ RuntimeStore → RuntimeContext (5层) → TimelineStore      │
│ TaskStore → Task Lifecycle → MemoryLayer                 │
│ SkillRegistry → SkillLoader → SkillBridge                │
├─────────────────────────────────────────────────────────┤
│                    Provider Layer                         │
├─────────────────────────────────────────────────────────┤
│ providerAdapter → ChatCompletionProvider                  │
│ agentAdapter → RuntimeLLMExecutor                         │
│ taskExecutor → createContextAwareExecutor                 │
├─────────────────────────────────────────────────────────┤
│                    Transport Layer                        │
├─────────────────────────────────────────────────────────┤
│ Go Backend (WebSocket) │ Tauri IPC │ Ollama (Local)      │
└─────────────────────────────────────────────────────────┘
```

## 核心数据流

```
用户输入
  ↓
ChatInput → chat-send-controller
  ↓
┌─ @mention? → skillBridge → SkillRegistry → SkillLoader
│                        → RuntimeLLMExecutor → TaskOutput
│                        → ChatMessage (metadata: taskId, skillName)
│                        → TaskBadge
│
└─ 普通 chat → RuntimeLLMExecutor → TaskOutput
                          → ChatMessage → 消息气泡
```

## 模块依赖图

```
skillBridge → SkillRegistry → SkillLoader
skillBridge → runtimeBridge → RuntimeStore
skillBridge → TaskStore

chat-send-controller → skillBridge
chat-send-controller → runtimeBridge
chat-send-controller → TaskStore

agentAdapter → providerAdapter → Go Backend / Ollama
taskExecutor → agentAdapter

ChatView → ChatStore
WorkspaceView → useWorkspace → RuntimeStore + TaskStore
```
