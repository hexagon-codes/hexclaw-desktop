# HexClaw 项目功能流程文档

> 日期：2026-05-14 | 状态：当前真实现状

---

## 1. Chat 普通消息路径

```
用户输入 → ChatInput.vue
  → chat-send-controller.ts sendMessage()
    → parseSkillInvocation() → 无 @mention
    → 创建 Task (type='chat', id=$taskId)
    → taskStore.enqueue(task)
    → registerChatTask(task) → runtime.registerContextForTask(task)
      → 创建 RuntimeContext → 加载 SystemLayer + TaskLayer
    → if execMode === 'runtime':
        → executeChatTask($taskId) → runtime.executeTask($taskId)
          → createContextAwareExecutor('chat') → RuntimeLLMExecutor
          → buildPromptInput(context) → { system, user }
          → provider.execute(payload) → TaskOutput
        → buildAssistantMessage(result.content)
        → messages.value.push(assistantMsg)
      → else (legacy):
        → chatService.sendMessage() → WebSocket
        → stream response → finalizeAssistantMessage()
    → taskStore.completeTask($taskId)
    → completeChatTask($taskId)
```

**关键特征**：
- 每条消息都注册为 Task（即使 execMode !== 'runtime'）
- Runtime 路径通过 `execMode` toggle 控制
- 结果以 ChatMessage 渲染，无 task context 可视化

---

## 2. WebSocket 路径

```
chatService.sendMessage()
  → WebSocket 连接到 Go backend
  → 发送 message payload
  → 接收 streaming response
  → parseStreamChunk() → 增量更新 content
  → finalizeAssistantMessage() → 完成消息
```

**关键特征**：
- 独立于 Runtime 路径
- Go backend 处理 LLM 调用
- 支持 streaming
- 无 Task/Timeline/Context 集成

---

## 3. Runtime 路径

```
runtimeBridge.registerChatTask(task)
  → runtimeStore.registerContextForTask(task)
    → 创建 RuntimeContext (5 层)
    → 加载 SystemLayer (策略、constraints)
    → 加载 TaskLayer (goal、input、status)
    → 写入 timeline event: task.created

runtimeBridge.executeChatTask(taskId)
  → runtimeStore.executeTask(taskId)
    → prepareExecutionLayer() → state: pending → running
    → createContextAwareExecutor(type) → RuntimeLLMExecutor
    → executor.executeWithContext(task, context)
      → buildPromptInput(context) → { system, user }
      → provider.execute(payload)
    → 写入 timeline event: execution.completed
    → completeContextForTask() → state: completed
    → writeExecutionMemory()
  → runtimeStore.getExecutionResult() → TaskOutput
  → taskStore.completeTask() / failTask()
```

**关键特征**：
- 完整的 Task lifecycle（pending → running → completed/failed）
- 5 层 RuntimeContext
- Timeline 事件追踪
- Memory 写入（执行后）

---

## 4. Skill @mention 路径

```
用户输入: "@summarize some text"
  → chat-send-controller.ts sendMessage()
    → parseSkillInvocation(text) → { skillName: "summarize", skillInput: "some text" }
    → tryExecuteSkill(text, params)
      → resolveSkillByName("summarize", registry)
        → SkillRegistry.getAllSkills()
          → discoverFromDir(Resource) → 扫描 skills/ → ❌ 目录结构不匹配
          → discoverFromDir(AppData) → 扫描 skills/ → 空
        → cache = {} → resolveSkillByName → undefined
      → return undefined (不是 skill invocation)
    → 回退到普通 chat 路径
```

**实际问题**：
- `SkillRegistry` 从未发现 `builtin/summarize`（目录结构不匹配）
- `@summarize` 回退为普通 chat
- 之前的 UAT 是代码级验证，非真实 Tauri 环境测试

---

## 5. Workspace 路径

```
WorkspaceView.vue
  → useWorkspace() composable
    → 读取 runtimeStore (contexts, timelines)
    → 读取 taskStore (tasks)
    → workspaceProjector 投影为 DTO
    → 返回 taskProjections, contextProjection, timelineProjection
  → 三面板渲染:
    → TaskListPanel (props: taskProjections)
    → ContextDetailPanel (props: contextProjection, resultProjection)
    → TimelinePanel (props: timelineProjection, narrativeProjection)
```

**关键特征**：
- 完全通过 projection layer 解耦 Runtime 类型
- Props-driven，不直接读 store
- 数据来自 useWorkspace composable

---

## 6. Tauri Resource/AppData 路径

```
BaseDirectory.Resource → Tauri bundle resources 目录
  → 包含: skills/*, binaries/ollama-bundle/*
  → skills 映射: 项目根 skills/ → bundle skills/

BaseDirectory.AppData → 用户 AppData 目录
  → 包含: 自定义 skill、用户配置
  → skills 映射: 项目根 skills/ → AppData skills/

SkillRegistry 双目录扫描:
  → Official (Resource): skills/ → builtin/ → ❌ skill.json 不存在
  → Custom (AppData): skills/ → 空或不存在
```

---

## 7. systemPrompt 路径

```
buildPromptInput(context):
  → systemLayer.constraints → 系统约束
  → skillLayer.markdown → SKILL.md 内容
  → if skill 执行:
      → [MODE: DIRECT] + skill markdown (sanitized)
      → user message + [MODE: DIRECT] suffix
  → else:
      → 无 skillLayer → system = undefined
      → user = 原文

providerAdapter.execute(payload):
  → if systemPrompt truthy:
      → 过滤 system role messages
      → systemPrompt 作为独立字段发送
  → else:
      → messages 直接拼接
```

---

## 8. Task/Timeline/Context/Asset 当前流转

### Task
```
taskStore.enqueue(task) → task.status = 'running'
taskStore.completeTask(id, output) → task.status = 'completed', task.output = output
taskStore.failTask(id, error) → task.status = 'failed'
```

### Timeline
```
runtimeStore.executeTask() 写入事件:
  → task.created → execution.prepared → execution.started
  → execution.completed → task.completed → memory.updated
  → (失败时: execution.failed → task.failed)

TimelineStore 持久化事件列表
useWorkspace → projectTimeline() → TimelineItemProjection[]
```

### Context
```
RuntimeContext (5 层):
  → system: 策略、constraints、runtimeVersion
  → skill: skillId、name、markdown、capabilities
  → task: goal、status、progress、input、output
  → execution: state、stage、steps、timestamps
  → memory: userConfirmations、historicalResults、generatedAssets

Layer 生命周期:
  → registerContextForTask() → 加载 system + task
  → executeTask() → 写入 execution
  → completeContextForTask() → 标记完成
  → unloadStaleLayers() → 卸载过期层
```

### Asset
```
RuntimeContext.resources.asset (AssetCollection)
  → registerAsset() → 注册资产引用
  → invalidateAsset() → 标记失效
  → reconcileAssets() → 调和资产状态

当前 UI 状态:
  → ContextDetailPanel 仅 legacy outputs 回退
  → 无正式 Asset 渲染组件
```
