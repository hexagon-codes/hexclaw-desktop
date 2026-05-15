# TaskResult Consumer Survey

**Session**: ANL-taskresult-survey-2026-05-13
**Date**: 2026-05-13
**Type**: Consumer survey (分析性调查，非 checkpoint review)
**Spec**: `docs/1.md`

---

## 1. Consumer Map

### TaskResult 定义（锚点）

```typescript
// src/types/task.ts:38
export type TaskResult =
  | { kind: 'text'; content: string }
```

当前为 single-variant discriminated union — 仅 `text` 一种 kind。

### 消费者总览

| # | Consumer | 文件 | 行 | 关系 |
|---|----------|------|----|------|
| C1 | 定义自身 | `src/types/task.ts` | 38 | 定义 TaskResult |
| C2 | Context 引用 | `src/types/context.ts` | 12 | `import type { TaskResult }` — RuntimeContext 间接持有 |
| C3 | types re-export | `src/types/index.ts` | — | re-export，非直接消费 |
| C4 | **Runtime Bridge** | `src/services/runtimeBridge.ts` | 18, 77 | `import TaskResult`, `executeChatTask(): Promise<TaskResult>` |
| C5 | **RuntimeStore** | `src/stores/runtime.ts` | 13, 341-344 | `import TaskResult`, `getExecutionResult(): TaskResult \| undefined` |
| C6 | **AgentAdapter** | `src/services/agentAdapter.ts` | 87, 126 | **构造** `{ kind: 'text', content: result.content }` |
| C7 | taskExecutor stubs | `src/services/taskExecutor.ts` | 55, 86, 117, 152 | **构造** `{ result: null, artifacts: [] }`（null result） |
| C8 | **chat-send-controller** | `src/stores/chat-send-controller.ts` | 224, 228 | **构造** `{ kind: 'text', content: $result.content ?? '' }` |
| C9 | **WorkspaceProjector** | `src/services/workspaceProjector.ts` | 499-510 | **消费** `primaryResult.content`，**构造** `kind: 'text'` |
| C10 | websocket delivery | `src/stores/chat-send-websocket-delivery.ts` | 123 | 消费 `result.content` |
| C11 | chat stream recovery | `src/stores/chat-stream-recovery.ts` | 96 | 消费 `result.content` |
| C12 | api/knowledge | `src/api/knowledge.ts` | 228 | 消费 `result.content`（带 type guard） |
| C13 | useWorkspace composable | `src/composables/useWorkspace.ts` | 103-109 | 消费 `projectTaskResult(task, ctx)` |
| C14 | ContextDetailPanel.vue | `src/components/workspace/ContextDetailPanel.vue` | 21, 246 | 消费 `TaskResultProjection`（投影后，非原始 TaskResult） |
| C15 | MemoryView.vue | `src/views/MemoryView.vue` | 521 | `{{ result.content }}` |
| C16 | KnowledgeView.vue | `src/views/KnowledgeView.vue` | 812 | `{{ result.content }}` |

---

## 2. Direct vs Indirect Consumer

### Direct consumers（直接 import TaskResult）

| 文件 | import 语句 |
|------|-------------|
| `types/task.ts` | **定义** |
| `types/context.ts` | `import type { TaskResult }` |
| `runtimeBridge.ts` | `import type { TaskResult }` |
| `runtime.ts` | `import type { TaskResult }` |

### Indirect consumers（通过 TaskOutput / RuntimeContext 间接持有）

| 文件 | 中介类型 | 消费方式 |
|------|----------|----------|
| `taskExecutor.ts` | `TaskOutput` | 返回 `{ result: null }` — 不消费 result 内容 |
| `agentAdapter.ts` | `TaskOutput` | **构造** TaskResult — 从 provider 输出映射 |
| `runtime.ts:395` | `RuntimeContext.execution.output` | 赋值 `output.result` → `ctx.execution.output` |
| `runtimeBridge.ts:94-97` | `TaskOutput` | 传递 result 给 completeChatTask |
| `workspaceProjector.ts` | `RuntimeContext.execution.output` | 读取 `primaryResult.content` |
| `chat-send-controller.ts` | `TaskOutput` | **构造** TaskResult + 传递 |
| `chat-send-websocket-delivery.ts` | `AssistantMessage` | 消费 `result.content`（不感知 TaskResult）|
| `chat-stream-recovery.ts` | `AssistantMessage` | 消费 `result.content`（不感知 TaskResult）|
| `useWorkspace.ts` | `TaskResultProjection` | 消费投影后结果 |
| `ContextDetailPanel.vue` | `TaskResultProjection` | 渲染 UI |
| `MemoryView.vue` / `KnowledgeView.vue` | `ChatMessage` | 模板渲染 |

**关键分界线**：
- **Runtime 层**（runtime.ts, runtimeBridge.ts, taskExecutor.ts, agentAdapter.ts）— 直接操作 TaskResult / TaskOutput
- **Chat 层**（chat-send-controller.ts, websocket-delivery.ts, recovery.ts）— 操作 AssistantMessage，不直接 import TaskResult
- **Workspace 层**（workspaceProjector.ts, useWorkspace.ts, ContextDetailPanel.vue）— 消费投影后的 `TaskResultProjection`，不直接接触 TaskResult
- **View 层**（MemoryView.vue, KnowledgeView.vue）— 消费 ChatMessage，完全不感知 TaskResult

### 结论：分层隔离基本成立

```
Runtime    → TaskResult / TaskOutput    ← 直接消费
Bridge     → TaskResult / TaskOutput    ← 直接消费（anti-corruption）
Chat       → AssistantMessage           ← 不直接 import TaskResult ✅
Workspace  → TaskResultProjection       ← 不直接 import TaskResult ✅
View       → ChatMessage                ← 不感知 TaskResult ✅
```

**ADR-001 合规已验证**：Chat 层无 RuntimeStore import。但 chat-send-controller 直接构造 `TaskOutput`，说明 Chat 层仍接触 `TaskOutput`——这是通过 `@/types` 的 type-only import，非 RuntimeStore。

---

## 3. Assumption Risks

### Risk 1: `result.content` 总是存在（5 处硬依赖）

| 位置 | 代码 | 风险 |
|------|------|------|
| agentAdapter.ts:87,126 | `result: { kind: 'text', content: result.content }` | `result.content` 可能为 undefined |
| workspaceProjector.ts:506 | `primaryResult.content` 直接访问 | 若 kind 非 text 则内容语义不可预测 |
| knowledge.ts:228 | `typeof === 'string' ? ... : ''` | **已有守卫** ✅ |
| chat-send-websocket-delivery.ts:123 | `result.content \|\| ''` | **已有 fallback** ✅ |
| chat-stream-recovery.ts:96 | `result.content \|\| ''` | **已有 fallback** ✅ |

**严重性**: 中。当前只有 `text` kind，content 始终是 string。扩展 kind 后，非 text kind 可能无 content。

### Risk 2: `{ kind: 'text' }` 硬编码（6 处构造点）

所有 6 处 TaskResult 构造都硬编码 `kind: 'text'`：

- agentAdapter.ts:87, 126 — provider 结果 → TaskResult
- workspaceProjector.ts:504 — primary result 投影
- chat-send-controller.ts:224, 228 — delivery 回调 → TaskResult
- taskExecutor.ts stubs — `{ result: null }`（未硬编码 kind）

若新增 kind，这 6 处需要逐个评估是否需要生成新 kind。

### Risk 3: 投影层 ahead of 类型层

```typescript
// workspace.ts:177 — 已定义 7 种
type ResultKind = 'text' | 'code' | 'image' | 'audio' | 'video' | 'file' | 'tool_call'

// task.ts:38 — 仅 1 种
type TaskResult = | { kind: 'text'; content: string }
```

`ResultKind` 定义了 7 种 kind，但 `TaskResult` 只支持 `text`。projectTaskResult 在 `kind === 'text'` 分支后，没有 else 分支处理未知 kind。当前不会命中（只有 text），但若 TaskResult 新增 kind 而投影层未更新，会导致静默丢失。

### Risk 4: stub executors 返回 `{ result: null }`

```typescript
// taskExecutor.ts:55, 86, 117, 152
return { result: null, artifacts: [] }
```

TaskOutput.result 类型为 `TaskResult`（非 optional），但 stub 返回 `null`。类型系统允许这是因为 `null` 可赋值给联合类型。这不合语义，但当前无实际影响（stub 未被真实调用）。

---

## 4. Proposed TaskResult Evolution Path

### 阶段式扩展策略（非破坏性，逐步安全）

```
Phase A（当前）: { kind: 'text'; content: string }           ← 稳定
Phase B:         { kind: 'text'; content: string }
               | { kind: 'error'; code: string; message: string }  ← 最小安全扩展
Phase C:         + { kind: 'tool_call'; calls: ToolCall[] }        ← Chat 场景
Phase D:         + { kind: 'code'; language: string; content: string }  ← 代码场景
```

### 推荐：先做 Phase B（error kind）

**理由**：
- error kind 不依赖 content，不会破坏现有 `result.content` 假设
- 与 `TaskError` 互补（TaskError 描述 task 级错误，TaskResult.error 描述执行结果中的异常）
- 替换当前 `BridgeError` → `ApiError` 映射的部分场景，使 Bridge 能直接传递结构化错误
- 最小侵入：只需修改 `task.ts` + `workspaceProjector.ts` 分支

---

## 5. 哪些 kind 现在禁止加入

| Kind | 禁止原因 | 当前状态 |
|------|----------|----------|
| `image` | 需 thumbnail pipeline、mimeType 协商、存储策略 | ❌ 禁止 |
| `audio` | 需播放器组件、流式加载 | ❌ 禁止 |
| `video` | 需播放器组件、流式加载 | ❌ 禁止 |
| `file` | 需文件系统抽象、下载策略 | ❌ 禁止 |
| `tool_call` | 需 ToolCall 类型定义、UI 渲染、嵌套展开逻辑 | ❌ 现阶段禁止 |

**原则**：所有需要**新 UI 组件**、**新存储策略**、**新渲染管线**的 kind，在 stabilization 期间一律禁止。

### 允许且建议的 kind

| Kind | 理由 | 建议加入时机 |
|------|------|-------------|
| `error` | 不需新 UI（可复用 error 展示）、不需存储策略、content 独立 | ✅ Phase B |
| `code` | 与 text 结构相同（content: string + language?: string），投影层几乎无需修改 | ⏸️ Phase D |

---

## 6. 最小安全扩展建议

### 建议 1：锁定 TaskResult 当前定义（Phase A 冻结）

保持 `{ kind: 'text'; content: string }` 不变。所有消费者已适配此形状。**不因"未来可能需要"而提前扩展**。

### 建议 2：如必须扩展，选 `error` kind（Phase B）

```typescript
export type TaskResult =
  | { kind: 'text'; content: string }
  | { kind: 'error'; code: string; message: string }
```

**影响范围**：
- `task.ts` — 修改类型定义
- `workspaceProjector.ts:501` — 新增 `kind === 'error'` 分支 → 投影为 `kind: 'text'` + error 标识
- `agentAdapter.ts` — 不改（provider 不产生 error kind）
- `chat-send-controller.ts` — 不改（Chat 不构造 error kind）
- `runtime.ts`、`runtimeBridge.ts` — 不改（传递透明）
- 所有 `result.content` 消费者 — **不受影响**（error kind 无 content，但现有代码都有 fallback）

### 建议 3：前置加固 — 给 projectTaskResult 加 else 分支

```typescript
// workspaceProjector.ts
if (primaryResult.kind === 'text') {
  // ... 现有逻辑
} else {
  // 未知 kind → 投影为 text（无 content），标记 invalid
  // 防止静默丢失
}
```

### 建议 4：前置加固 — executor stub 修复类型

```typescript
// taskExecutor.ts: stubExecuteWithContext / ChatTaskExecutor.execute
// 现行: return { result: null, artifacts: [] }
// 建议: 要么 TaskOutput.result 改为 optional，要么 stub 返回合法值
```

---

## 7. 是否值得进入 execute

### Go / No-Go: ⏸️ 暂缓（Hold）

**理由**：

1. **无实际需求信号** — 当前系统没有需要非 text kind 的场景。所有 executor 只产生 text。Workspace projection 的 7 种 ResultKind 是 UI 前瞻设计，未被 TaskResult 实际使用。
2. **代价 > 收益** — 扩展 TaskResult 需要修改 6 个构造点、评估 10+ 消费者、更新投影分支。当前扩展只会增加复杂度而不解锁任何新功能。
3. **Stabilization 优先级** — P0 列表还有 WS/RT 语义漂移和 Execution observability 未处理。TaskResult 加固是 P1，不应在 P0 未完成时进入。

### 条件性 Go（当以下任一条件满足时）

| 条件 | 说明 |
|------|------|
| 有生产者实际产出非 text kind | 例如 executor 返回 tool_call |
| Workspace 投影层发现静默丢失 | 用户报告 result 不显示 |
| error kind 被 Bridge 层需要 | BridgeError 映射过于复杂 |

### 建议

```
当前状态: ⏸️ Hold — 不进 execute
前置条件: 不主动扩展 TaskResult
下次评估: WS/RT 语义漂移 + Execution observability 完成后重新评估
```

---

## 附录：Workspace ResultKind vs TaskResult kind 对比

| 维度 | TaskResult kind | Workspace ResultKind |
|------|----------------|---------------------|
| 定义位置 | `types/task.ts` | `types/workspace.ts` |
| 种类数 | 1（text） | 7（text, code, image, audio, video, file, tool_call） |
| 用途 | Runtime 数据契约 | UI 投影分类 |
| 扩展驱动 | Executor 产出 | 设计前瞻 |
| 差距 | — | UI 已准备好展示 6 种尚未被 Runtime 支持的 kind |

**关键观察**：`workspaceProjector.ts:504` 硬编码 `kind: 'text'`，但 `ResultItemProjection.kind` 的类型是 `ResultKind`（7 种）。也就是说，即使 TaskResult 只有 text，投影层也可以自由映射到任何 ResultKind。TaskResult 扩展不是 Workspace 展示新 kind 的前提条件——投影函数是两者之间的适配器。
