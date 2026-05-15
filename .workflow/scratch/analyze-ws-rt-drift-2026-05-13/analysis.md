# 分析: WS/RT Semantic Drift Closure

**Session**: ANL-ws-rt-drift-2026-05-13
**Date**: 2026-05-13
**Spec**: `docs/1.md`
**Type**: Drift analysis

---

## 0. 架构总览: WS Path vs RT Path

```
WS Path (WebSocket)                         RT Path (Runtime)
─────────────────────────                   ─────────────────────────
chat-send-controller.ts                     chat-send-controller.ts
  sendMessage()                               sendMessage()
    │                                           │
    ├── seedAutoTitle() ← 相同                   ├── seedAutoTitle()
    │                                           │
    └── deliveryController                      └── executeChatTask()
          .deliverMessage()                          │
            │                                        ├── runtime.executeTask()
            ├── chatSvc                               │   → ExecutionLayer
            │   .openWebSocketStream()                 │   → Timeline events
            │   .sendViaBackend()                      │   → ContextAwareExecutor
            │                                          │
            └── finalizeAssistantMessage()              └── taskStore.completeTask()
                │                                           │
                ├── buildAssistantMessage()                   ├── taskStore.completeTask()
                │   (reasoning ✓, toolCalls ✓,               │   (artifacts: [])
                │    thinkingDuration ✓, metadata ✓)          │
                ├── suggestSessionTitle()  ← 自动标题修正     └── return TaskResult
                ├── extractArtifacts()                            │
                ├── touchSession()                                └── buildAssistantMessage()
                └── resetSessionStream()                              (reasoning ✗, toolCalls ✗,
                                                                      thinkingDuration ✗,
                                                                      metadata ✗)
```

---

## 1. Drift Inventory

### 1.1 用户可感知的 drift（4 项）

| # | Drift | WS Path | RT Path | 可感知？ |
|---|-------|---------|---------|----------|
| D1 | **Auto-title 不修正** | 消息完成后 `suggestSessionTitle()` 后端生成标题 | **不调用**，永远显示 "前30字..." | ✅ 用户可感知 |
| D2 | **reasoning/tool_calls 不传递** | `finalizeAssistantMessage` 传入 `reasoning`, `toolCalls`, `agentName`, `metadata` | `buildAssistantMessage(result.content)` 仅传 content | ✅ 用户可感知 |
| D3 | **Error surface 不同** | 原始 WS 错误 → `handleSendError` → `fromNativeError` → `ApiError` | `BridgeError` → `bridgeErrorToApiError` → `ApiError(SERVER_ERROR)` | ✅ 用户可感知 |
| D4 | **thinking_duration 缺失** | 从 stream state `reasoningStartTime/EndTime` 计算 | 无数据源，不设置 | ✅ 用户可感知 |

### 1.2 内部 drift（用户不可感知，但影响正确性）

| # | Drift | WS Path | RT Path | 影响 |
|---|-------|---------|---------|------|
| D5 | **artifact 提取** | `extractArtifacts(content, messageId)` | **不调用** | workspace 产物可能遗漏 |
| D6 | **session touch** | `msgSvc.touchSession(sessionId)` | **不调用** | session `updated_at` 不刷新 |
| D7 | **TaskOutput.artifacts** | `artifacts: $result.tool_calls ? [$result.tool_calls] : undefined` | `artifacts: []` | workspace projection 差异 |

### 1.3 实现差异（非 drift，结构不同但行为等价）

| # | 差异 | WS Path | RT Path | 判定 |
|---|------|---------|---------|------|
| D8 | **Timeline 事件量** | 仅 `task.created` + `task.completed/failed` | 完整 `execution.*` 4 事件 + `task.*` + `memory.updated` | ✅ 可接受 — RT 信息更丰富 |
| D9 | **TaskStore 完成路径** | 手动 `$taskStore.completeTask()` + `completeChatTask()` | `executeChatTask` 内部统一处理 | ✅ 等价 — 终点相同 |
| D10 | **Task enqueue → dequeue** | `enqueue()` 后 `startTask()` 未调用（直接 `registerChatTask` 设 running） | 同 WS | ✅ 等价 |
| D11 | **SessionStreamState** | 创建 `rawContent/content/reasoning/...` | 无（不需要 streaming） | ✅ intentional |

---

## 2. Drift Severity Matrix

```
Critical ●━━━━━━━━○━━━━━━━━○━━━━━━━━○━━━━━━━━ Minor
          D1    D2    D3    D4    D5    D6    D7

Critical (must close):  D1, D2
High    (should close): D3, D4
Low     (nice to have): D5, D6, D7
```

| Severity | Drifts | 依据 |
|----------|--------|------|
| **Critical** | D1, D2 | 用户直接看到 — 标题不修正、推理/tool_calls 不显示 |
| **High** | D3, D4 | 用户可能感知 — 错误文案不同、思考耗时缺失 |
| **Low** | D5, D6, D7 | 用户不易感知 — 产物/时空数据差异 |

---

## 3. User-Visible vs Internal Drift

### 用户可感知的 drift（来自 §1.1）

```
RT 路径的用户会看到：
┌──────────────────────────────────────┐
│ 标题: "帮我写一个..." (未修正)      │ ← D1: auto-title
│                                      │
│ assistant: "好的，这是..."           │
│   (无 reasoning 显示)               │ ← D2: 无 reasoning
│   (无 thinking_duration)            │ ← D4: 无 thinking_time
│   (tool_calls 不可见)               │ ← D2: 无 tool_calls
│                                      │
│ 失败时: "服务器错误"                │ ← D3: 不同错误信息
└──────────────────────────────────────┘
```

### 内部 drift（用户不可感知，来自 §1.2-1.3）

```
RT 路径缺少的后处理：
  ✗ extractArtifacts()      → 产物可能不完整
  ✗ touchSession()          → 会话刷新滞后
  ✗ TaskOutput.artifacts    → workspace 投影差异

RT 路径额外的 Timeline 事件：
  ✓ execution.prepared      → 更丰富的状态记录
  ✓ execution.started
  ✓ execution.completed/failed
  ✓ memory.updated
```

---

## 4. Drift 分类（Spec 要求的区分）

### ✅ Semantic Drift（必须 closure）

| Drift | 类型 | 原因 |
|-------|------|------|
| D1: auto-title 不修正 | Semantic | 两种路径下 session title 行为不一致，用户预期统一 |
| D2: reasoning/tool_calls 不传递 | Semantic | Assistant Message 形状不一致，用户预期看到推理过程 |
| D3: error surface 不同 | Semantic | 用户感知到的错误信息语义不同 |

### 🔶 Implementation Drift（建议 closure，非必须）

| Drift | 类型 | 原因 |
|-------|------|------|
| D4: thinking_duration 缺失 | Implementation | 纯 UI 数据，不影响功能正确性 |
| D5: artifact 提取缺失 | Implementation | 产物提取是 UI 后处理，不影响消息内容 |
| D6: session touch 缺失 | Implementation | 后端 session 刷新，功能等价 |
| D7: TaskOutput.artifacts | Implementation | Workspace 投影差异，不影响核心流程 |

### ✅ Acceptable Divergence（允许长期存在）

| Divergence | 理由 |
|------------|------|
| 无 streaming | Spec 明确禁止要求 RT path 支持 streaming |
| 无 SessionStreamState | RT 不需要，streaming 是 WS 独有 |
| Timeline 事件量不同 | RT 有 execution layer 自然产生更多事件，这是 feature 非 bug |
| TaskStore 完成调用方式不同 | 终点相同 |

### ✅ Intentional Divergence（故意设计）

| Divergence | 理由 |
|------------|------|
| WS 直接构造 TaskOutput | chat-send-controller 需同时兼容两种 path |
| RT 通过 Bridge 完成 | ADR-001 anti-corruption layer |
| WS 产生 execution.* timeline? | WS 无 ExecutionLayer，不应产生 execution 事件 |

---

## 5. 必须 closure 的 drift

### D1: Auto-title 不修正 — RT 路径需补充 `suggestSessionTitle`

**现状**：RT 路径 `sendMessage()` 的 `execMode === 'runtime'` 分支（`chat-send-controller.ts:196-209`）在 `executeChatTask` 返回后，只调了 `buildAssistantMessage` 和 `persistMessage`，没有后续的 auto-title 流程。

**修复方向**：在 RT 分支的消息推送后，追加 WS path 的 suggestion 逻辑：

```typescript
// RT path (chat-send-controller.ts:196-209)
if (execMode.value === 'runtime') {
  try {
    const result = await executeChatTask($taskId)
    const assistantMsg = buildAssistantMessage(result.content, { id: createId() })
    messages.value.push(assistantMsg)
    void persistMessage(assistantMsg, sessionId).catch(() => {})

    // ++ 追加 auto-title suggestion（复用 WS 路径的逻辑）
    triggerAutoTitleSuggestion(sessionId)

    return assistantMsg
  } catch (e) {
    handleSendError(e, sessionId, sending, draftSending)
    return null
  }
}
```

**侵入度**：低。只追加一个调用，不修改现有结构。

### D2: reasoning/tool_calls 不传递 — RT 路径需提升 TaskResult

**现状**：`buildAssistantMessage(result.content)` 只传了 content。RT executor 基于 `agentAdapter.ts` 执行，其 `executeWithContext` 返回 `TaskOutput { result: { kind: 'text', content } }` — 没有 reasoning/tool_calls。

**修复方向**：这需要修改 executor 层，让 `TaskResult` 扩展或通过 metadata/context 传递。但这需要 TaskResult 扩展（而 TaskResult 已决定 Hold）。

**替代方案**：在 `runtimeBridge.ts` 中捕捉 executor 的原始输出，通过 runtime context 传递 reasoning/tool_calls metadata。这不需要修改 `TaskResult` 类型。

**侵入度**：中。需要新增 bridge 层的数据传递路径。

### D3: Error surface 不同 — RT 路径需统一错误文案

**现状**：RT path → `BridgeError { EXECUTION_FAILED }` → `bridgeErrorToApiError` → `ApiError { code: 'SERVER_ERROR', message: msg }`。WS path → 原始错误 → `fromNativeError` → `ApiError`（消息来自 Error.message）。

**修复方向**：两种 path 的 `handleSendError` 都会调用 `fromNativeError`，它已经能处理 `ApiError`。RT path 的 `bridgeErrorToApiError` 返回的也是 `ApiError`。所以最终 `handleSendError` 处理时两者都是 `ApiError`。

**问题在于消息内容**：RT 的 `message` 来自 `(e as Error).message`（executor 抛出的错误），WS 的来自 `wsError.message`（WS 连接错误）。它们本来就会不同。这不是 drift，是不同执行环境下的自然差异。

**侵入度**：**不需要修改**。现有错误处理已统一为 `ApiError` 格式。消息差异是合理的。

---

## 6. 明确允许长期存在的 drift（Spec 第 5 项）

| 允许的 drift | 理由 |
|-------------|------|
| RT 无 streaming | Streaming 是 WS 协议特性，RT 是 batch execute |
| RT 无 SessionStreamState | Streaming pipeline 数据结构，RT 不需要 |
| RT 产生更多 Timeline 事件 | ExecutionLayer 自然产生的 observability |
| RT 无 tool_calls 响应 | Runtime executor 不执行 tool_calls（当前为 stub） |
| RT 无 thinking_duration | 无 streaming state 记录推理时间 |
| TaskStore 调用路径不同 | 调用栈不同但终点相同 |
| WS 手动 completeTask | 因 WS 需等待 delivery 完成，无法统一 |

---

## 7. 最小 closure 方案

### 任务列表

```
TASK-D1: RT 路径追加 auto-title suggestion
  文件: src/stores/chat-send-controller.ts
  改动: RT 分支添加 triggerAutoTitleSuggestion(sessionId) 调用
  侵入度: 低 — 1 行调用

TASK-D2: RT 路径传递 reasoning metadata
  文件: src/services/runtimeBridge.ts
  改动: executeChatTask 返回时追加 reasoning 到 assistant message
  方式: 不扩展 TaskResult，通过 executeChatTask 返回值之外的通道（callback/context）
  侵入度: 中 — 需新数据通道
  备选: 如果无 real executor 产生 reasoning，此任务可降级

TASK-D3: 验证 error surface 是否已统一
  验证: 确认 WS path 和 RT path 最终都经过 fromNativeError → ApiError
  结论: 已统一 ✅ — 不做修改
```

### 最小方案 = TASK-D1 + TASK-D3(已验证)

TASK-D2 可暂缓，因为当前 Runtime executor 并不产生 reasoning/tool_calls（`agentAdapter.ts` 只传 content），所以 D2 在 RT path 当前不会实际出现——它是"未来可能发生"的 drift，不是当前活跃的 drift。

---

## 8. 是否值得 execute

### Go/No-Go: ✅ Conditional Go

**条件**：只 execute D1（auto-title 修正），不执行 D2（reasoning/tool_calls），跳过 D3（已验证已统一）。

**理由**：

| Drift | Execute? | 理由 |
|-------|----------|------|
| D1: auto-title | ✅ Go | 1 行改动的低成本修复，用户可感知 |
| D2: reasoning/tool_calls | ⏸️ Hold | 当前 executor 不产生这些，不会发生；等 real executor 引入后再处理 |
| D3: error surface | ❌ Skip | 已验证已统一为 ApiError 格式 |
| D4: thinking_duration | ❌ Skip | 无数据源，RT executor 不记录推理时间 |
| D5-D7 | ❌ Skip | 内部差异，用户不可感知 |

### 最小 execute 范围

```
文件: src/stores/chat-send-controller.ts
改动: RT 分支追加 auto-title 修正调用
验证: execMode === 'runtime' 时，session title 在消息完成后被修正
不修改: runtimeBridge.ts, workspaceProjector.ts, taskExecutor.ts, TaskResult
```

---

## 9. Stabilization P0 状态

```
✅ runtime-error-boundary-v0.1       → 完成
✅ TaskResult Consumer Survey         → Hold
✅ Execution Observability Boundary   → No-Go
⬜ WS/RT Semantic Drift               → Conditional Go（最小 execute: D1 only）
```

### Stabilization P0 可以结束的条件

1. D1（auto-title）修复完成 → ✅
2. D3（error surface）已验证统一 → ✅ 已满足
3. D2（reasoning/tool_calls）确认当前不活跃 → ✅ 已确认
4. D4-D7 标记为 allowed divergence → ✅ 已标记

**结论：D1 修复完成后，Stabilization P0 可正式结束。**
