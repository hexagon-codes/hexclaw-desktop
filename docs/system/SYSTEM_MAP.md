# SYSTEM_MAP

> HexClaw × AI-native Runtime Fusion 系统地图  
> Version: v0.2  
> Date: 2026-05-14  
> Purpose: 新终端、新会话、AI 开发代理恢复项目上下文时的第一入口之一。

---

## 1. Topology

```
Tauri Desktop App
├─ Frontend (Vue)
│  ├─ ChatView
│  │  ├─ ChatInput
│  │  ├─ ChatMessage
│  │  └─ TaskBadge
│  ├─ WorkspaceView
│  │  ├─ TaskListPanel
│  │  ├─ ContextDetailPanel
│  │  └─ TimelinePanel
│  ├─ RuntimeView
│  └─ DashboardView
│
├─ Runtime Layer
│  ├─ RuntimeStore
│  ├─ RuntimeContext (system / skill / task / execution / memory)
│  ├─ TimelineStore
│  ├─ TaskStore
│  ├─ RuntimeBridge
│  └─ RuntimeLLMExecutor
│
├─ Skill Layer
│  ├─ SkillRegistry
│  ├─ SkillLoader
│  ├─ SkillBridge
│  ├─ skills/summarize
│  └─ skills/bulletize
│
├─ Provider / Transport
│  ├─ providerAdapter
│  ├─ backendLLMClient
│  ├─ Tauri IPC commands.rs
│  ├─ Go Backend
│  └─ Ollama / Local Provider
│
└─ Workspace Projection
   ├─ useWorkspace
   └─ workspaceProjector
```

---

## 2. Chat → Skill → Runtime Flow

```
User input: @summarize text
  ↓
ChatInput
  ↓
chat-send-controller.sendMessage()
  ↓
tryExecuteSkill()
  ↓
parseSkillInvocation()
  ↓
SkillRegistry.resolveSkillByName()
  ↓
SkillLoader.loadSkillByTrigger()
  ↓
RuntimeBridge.registerChatTask()
  ↓
RuntimeStore.registerContextForTask()
  ↓
RuntimeStore.loadSkillLayerForTask()
  ↓
RuntimeStore.executeTask()
  ↓
createContextAwareExecutor('skill')
  ↓
RuntimeLLMExecutor.executeWithContext()
  ↓
buildPromptInput()
  ↓
providerAdapter.execute()
  ↓
backendLLMClient.send()
  ↓
Tauri IPC → Go Backend
  ↓
TaskOutput
  ↓
ChatMessage(metadata: taskId, skillName, runtimeStatus)
  ↓
TaskBadge
  ↓
WorkspaceView?taskId=...
```

---

## 3. Normal Chat Flow

```
User input: plain text
  ↓
ChatInput
  ↓
sendMessage()
  ↓
parseSkillInvocation() returns undefined
  ↓
create Task type='chat'
  ↓
if execMode === runtime:
    RuntimeLLMExecutor
else:
    WebSocket / legacy delivery
  ↓
ChatMessage
```

---

## 4. Workspace Flow

```
WorkspaceView
  ↓
useWorkspace()
  ↓
RuntimeStore + TaskStore
  ↓
workspaceProjector
  ↓
TaskProjection / ContextProjection / TimelineProjection
  ↓
TaskListPanel / ContextDetailPanel / TimelinePanel
```

---

## 5. Current Critical Path

当前最重要链路：

```
skills/summarize exists at correct directory
  ↓
SkillRegistry finds summarize
  ↓
@sumarize does not fall back to normal chat
  ↓
Runtime task is created with type='skill'
  ↓
TaskBadge appears in ChatView
  ↓
Workspace opens corresponding task
```

如果这条链不通，说明还没有真正进入 Runtime-native Skill UX。

---

## 6. Important Tags

| Tag | Meaning |
|---|---|
| runtime-constitution-v0.9 | ADR baseline |
| skill-context-injection-p0 | SKILL.md → RuntimeContext → prompt |
| desktop-runtime-skill-path-p0 | Desktop Runtime transport |
| spe-archetype-v0.1 | Single-Pass Extraction template |
| runtime-native-p0 | type='skill' semantic routing |
| chat-task-bridge-v0.1 | Chat → Workspace TaskBadge bridge |

---

## 7. Do Not Re-derive

新会话不要重新推导：

- 为什么不是 Workflow
- 为什么不是 Prompt Marketplace
- 为什么不是 Multi-agent
- 为什么 Skill 是 package
- 为什么 Chat-first 但不是 Chat-only
- 为什么 Workspace 是 Runtime surface

这些结论由 `PROJECT_CONSTITUTION.md` 约束。
