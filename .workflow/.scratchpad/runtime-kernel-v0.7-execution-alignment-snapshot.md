# Runtime Kernel v0.7 — Execution Alignment Snapshot

> 记录时间: 2026-05-13
> Tag: `runtime-kernel-v0.7-execution-alignment`
> 父版本: `runtime-kernel-v0.7` + `execution-alignment-phase-a`

---

## 1. Runtime Universe vs WebSocket Universe

两条并存的 execution universe，通过 `execMode` 切换：

```
Chat.sendMessage()
  ├─ execMode === 'runtime'
  │    └─ runtimeBridge.executeChatTask(taskId)
  │         ├─ RuntimeStore.executeTask(taskId)       ← lifecycle operation
  │         ├─ AgentAdapter → ProviderAdapter → LLM
  │         ├─ ctx.execution.output = result
  │         └─ taskStore.completeTask()                ← bridge 代理
  │
  ├─ execMode !== 'runtime'
  │    └─ deliveryController.deliverMessage()
  │         ├─ WebSocket stream (primary)
  │         ├─ Backend HTTP (fallback)
  │         └─ Chat-owned completion (completeTask/failTask)
  │
  └─ 共享层:
       ├─ Task 注册: $taskStore.enqueue + registerChatTask
       ├─ UserMessage: 直接 push + persist
       ├─ Session: ensureSession
       └─ Error UI: handleSendError
```

**共存原则**：不统一 execution universe，不移除 WebSocket path，不引入 unified execution bus。

---

## 2. Execution Ownership

| 维度 | WebSocket | Runtime |
|------|-----------|---------|
| Execution 触发 | deliveryController | runtimeBridge.executeChatTask |
| TaskStore.completeTask | Chat（sendMessage 回调） | runtimeBridge（代理 Runtime） |
| TaskStore.failTask | Chat（外层 catch） | runtimeBridge（代理 Runtime） |
| Runtime timeline | runtimeBridge (completeChatTask/failChatTask) | Runtime 原生（executeTask 内部） |
| ChatMessage 构建 | finalizeAssistantMessage | buildAssistantMessage |

---

## 3. runtimeBridge Authority

`runtimeBridge.ts` 是 Chat ↔ Runtime 之间的唯一接触点。

```
Chat ──→ runtimeBridge ──→ RuntimeStore
  │                            │
  │  registerChatTask          ├─ registerContextForTask
  │  completeChatTask          ├─ completeContextForTask
  │  failChatTask              ├─ failContextForTask
  │  executeChatTask           ├─ executeTask
  │                            └─ getExecutionResult
  │
  └── useTaskStore ──→ TaskStore (bridge 内部)
       completeTask / failTask
```

**红线约束**：
- Chat **不**直接 import RuntimeStore
- Runtime **不** push Chat / messages
- bridge 是唯一的交叉点

---

## 4. AssistantMessage Semantic Alignment (Phase A)

### 提取的纯函数

`src/utils/buildAssistantMessage.ts`：

```
buildAssistantMessage(content, options?)
  ├─ extractThinkTags(content) → finalContent + parsed.reasoning
  ├─ normalizeAssistantReasoning(rawReasoning) → finalReasoning
  ├─ thinking_duration → metadata (from options, not stream state)
  ├─ getAssistantDisplayContent(finalContent, finalReasoning) → content
  └─ return ChatMessage { id, role, content, timestamp, reasoning, metadata, tool_calls, agent_name }
```

### WS 路径

`finalizeAssistantMessage` 内部调用 `buildAssistantMessage`，保留 stream state 读写 + 侧效应：

```
finalizeAssistantMessage(args)
  ├─ (impure) streamState → thinkingDuration
  ├─ buildAssistantMessage(content, { id, reasoning, metadata, thinkingDuration, ... })
  ├─ appendMessageToSession / bumpLocalSession
  ├─ auto-title / touchSession / extractArtifacts
  └─ resetSessionStream
```

### Runtime 路径

Runtime branch 直接调用 `buildAssistantMessage`：

```
const assistantMsg = buildAssistantMessage(result.content, { id: createId() })
messages.value.push(assistantMsg)
persistMessage(assistantMsg, sessionId)
```

**差异**：Runtime 路径暂不触发 auto-title / bumpSession / touchSession / extractArtifacts（Phase A 暂缓）。

---

## 5. TaskResult / execution.output

```
TaskResult = { kind: 'text', content: string }

Execution Layer:
  ctx.execution.output: TaskResult    ← 唯一 owner

Task Layer:
  ctx.task: intent/identity/routing   ← 不含 output

读取链:
  runtime.getExecutionResult(taskId)
    → manager.getContext(taskId)?.execution?.output
    → TaskResult | undefined
```

---

## 6. 当前明确不做

- ❌ Streaming Runtime — Runtime 不持有 stream state
- ❌ Tool Runtime — Runtime 不执行 tool calls
- ❌ Workflow Runtime — 无 workflow engine / agent loop
- ❌ Multi-agent — 单 AgentAdapter 实现
- ❌ Unified execution bus — Core/Execution 不统一
- ❌ Provider taxonomy — 仅 BackendChatProvider
- ❌ Chat orchestration Runtime — Chat 不调 RuntimeStore 内部

---

## 7. 下一阶段

### Phase B — Session Semantics Alignment

补齐 Runtime 路径的 session 侧效应，使两条路径在 session 生命周期层语义等价：

- `bumpLocalSession` — session 排序一致
- `msgSvc.touchSession` — session 时间戳一致
- Auto-title 触发 — 新 session 标题生成一致

**前置条件**：Phase A 已交付（`buildAssistantMessage` 纯函数已提取，Runtime 分支已复用）。

### Phase C — Artifact + Metadata Alignment（待定）

- `extractArtifacts` — 代码块提取
- 完整 metadata 对齐
- toolCalls（取决于 tool runtime 进度）

---

## 8. 文件清单

### 新增

| 文件 | 行数 | 角色 |
|------|------|------|
| `src/utils/buildAssistantMessage.ts` | 85 | 纯函数，构建 Assistant ChatMessage |
| `src/__tests__/runtime-execute-path-pilot.test.ts` | 128 | executeChatTask 验证测试 |

### 修改

| 文件 | 变更 |
|------|------|
| `src/types/chat.ts` | ExecMode 增加 'runtime' 选项 |
| `src/stores/runtime.ts` | +getExecutionResult, +TaskResult import |
| `src/services/runtimeBridge.ts` | +executeChatTask, +useTaskStore import |
| `src/stores/chat.ts` | execMode 传入 createChatSendController |
| `src/stores/chat-send-controller.ts` | +Runtime 分支，+buildAssistantMessage |
| `src/stores/chat-stream-completion.ts` | finalizeAssistantMessage 调用 buildAssistantMessage |

### 未变

| 文件 | 原因 |
|------|------|
| `src/stores/runtime.ts` (executeTask) | Phase A 不修改 Kernel |
| `src/services/agentAdapter.ts` | 不变 |
| `src/services/providerAdapter.ts` | 不变 |
| `src/stores/chat.ts` (主流程) | 不变 |
| `api/chat.ts` | Chat 路径保持独立 |

---

## 9. 测试状态

- vue-tsc --noEmit: 零错误
- 全量测试: 3735 passed, 5 failed (pre-existing, 均为 console.warn 检查)
- 新增测试: 6 passed（executeChatTask 覆盖成功/失败/契约约束）
- 回归: 零
