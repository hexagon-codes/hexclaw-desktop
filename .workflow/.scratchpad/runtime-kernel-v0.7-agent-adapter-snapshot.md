# Runtime Kernel v0.7 — Agent Adapter Integration Snapshot

> 记录时间: 2026-05-13
> Tag: `runtime-kernel-v0.7`
> 父版本: `workspace-surface-v0.4` + `runtime-kernel-v0.6`

---

## 1. 版本目标

将现有 HexClaw Agent/Provider/Sidecar 接入 Runtime 主链，
替换 `taskExecutor.ts` 中的 stub executor。

**不做的：**
- Chat 主架构修改
- Chat orchestration Runtime
- Provider 操作 Timeline/Context
- Runtime 侵入 UI
- Multi-agent / Browser / Workflow runtime

---

## 2. 架构总览

```
RuntimeStore.executeTask(taskId)
  │
  ├─ resolveExecutor('chat') → ChatAgentExecutor(provider)
  ├─ prepareExecutionLayer → state=preparing → running
  │
  ├─ await executor.executeWithContext(task, ctx)
  │     │                                        [AgentAdapter]
  │     ├─ buildPromptInput(ctx) → { system?, user }
  │     ├─ provider.execute(payload)              [ProviderAdapter]
  │     │     ├─ client.send(req)                 [BackendLLMClient — transport]
  │     │     └─ JSON.parse → ChatCompletionResult
  │     └─ return TaskOutput
  │
  ├─ ctx.execution.output = output.result         [Execution Layer 持有]
  ├─ execution.state = completed
  ├─ task.status = completed
  └─ timeline: execution.completed + task.completed
```

---

## 3. 三层边界

### BackendLLMClient — 传输层

- **文件**: `src/services/backendLLMClient.ts`
- **职责**: transport only
- **约束**: 不 `JSON.parse`，不处理业务错误，只做 `invoke('backend_chat')`
- **返回**: `raw string`

### ProviderAdapter — 协议层

- **文件**: `src/services/providerAdapter.ts`
- **职责**: protocol parse（`JSON.parse` raw response）
- **接口**: `ChatCompletionProvider { execute(payload): Promise<ChatCompletionResult> }`
- **Payload**: `{ messages, model, provider, temperature?, maxTokens?, systemPrompt? }`
- **Result**: `{ content, usage?, finishReason? }` — 不含 toolCalls/stream state
- **实现**: `BackendChatProvider`（唯一实现，无 provider taxonomy）

### AgentAdapter — 执行器层

- **文件**: `src/services/agentAdapter.ts`
- **职责**: read RuntimeContext → buildPromptInput → call Provider → TaskOutput
- **禁止**: 写 `ctx.execution` / timeline / store / streaming / toolCalls / agent loop
- **方法**: `executeWithContext(task, ctx)` — Runtime 主链路
- **方法**: `execute(task)` — 无 Context 降级路径

---

## 4. 类型变更

### TaskResult — 最小 discriminated union

```typescript
// src/types/task.ts
type TaskResult = | { kind: 'text'; content: string }

interface TaskOutput {
  result: TaskResult       // 原为 unknown
  artifacts?: unknown[]
  usage?: Record<string, unknown>
}
```

### Execution Layer — 新增 output

```typescript
// ExecutionLayer (src/types/context.ts)
interface ExecutionLayer {
  state: ExecutionState
  output?: TaskResult      // 新增 — execution result 的唯一 owner
  // ... 其他字段不变
}
```

### Task Layer — 移除 output

```typescript
// TaskLayer (src/types/context.ts) — output 字段已移除
interface TaskLayer {
  taskId, taskType, status, goal, input  // intent/identity/routing only
  // output 移至 ExecutionLayer
}
```

### Runtime result 所有权

```
执行前: TaskLayer.input   → intent
执行后: ExecutionLayer.output → result  ← 唯一 owner
      TaskLayer.status   → 'completed' (identity)
```

---

## 5. Prompt Input 契约

`buildPromptInput(context)` 返回 `{ system?: string, user: string }`

- 不是 Runtime canonical prompt format
- system 来自 `SystemLayer.constraints`
- user 来自 `TaskLayer.input.payload`，按 `text → message → goal → JSON` 回退解析
- 不与 Chat payload structure 耦合

---

## 6. 执行约束

| 约束 | 状态 |
|------|------|
| single request | ✅ 一次 `provider.execute()` |
| single response | ✅ 一个 `ChatCompletionResult` |
| single completion | ✅ `completed` XOR `failed` |
| 无 streaming | ✅ Phase 1 不做 |
| 无 toolCalls | ✅ ProviderResult 不含 |
| 无 agent loop | ✅ 不循环/重试 |
| 无多步 planning | ✅ |
| 无 Chat callback | ✅ Runtime 不 push UI |

---

## 7. 文件清单

### 新增 (3)

| 文件 | 行数 | 角色 |
|------|------|------|
| `src/services/backendLLMClient.ts` | 53 | Transport only |
| `src/services/providerAdapter.ts` | 118 | Protocol parse |
| `src/services/agentAdapter.ts` | 138 | ContextAwareExecutor impl |

### 修改 (7)

| 文件 | 变更 |
|------|------|
| `src/types/task.ts` | +TaskResult, TaskOutput.result 类型变更 |
| `src/types/context.ts` | TaskLayer -output, ExecutionLayer +output |
| `src/types/index.ts` | 导出 TaskResult |
| `src/services/taskExecutor.ts` | 工厂返回 ChatAgentExecutor |
| `src/services/contextLoader.ts` | loadTaskLayer 移除 output 映射 |
| `src/stores/runtime.ts` | executeTask/completeContextForTask 写 execution.output |
| `src/services/workspaceProjector.ts` | 从 execution.output 读取 |
| `src/stores/chat-send-controller.ts` | TaskOutput 构造适配 TaskResult |

### 未变

| 文件 | 原因 |
|------|------|
| `api/chat.ts` | Chat 路径保持独立 |
| `runtimeBridge.ts` | 接口不变 |
| `stores/chat.ts` | 主 store 不变 |
| `chatService.ts` | 流式路径不变 |
| `stores/tasks.ts` | TaskStore 不变 |

---

## 8. 测试状态

- 编译: 零错误
- 测试: 3729 passed, 5 failed (pre-existing, 均为 console.warn 检查)
- 回归: 零

---

## 9. 下一阶段候选

### Runtime Execute Path Pilot

将 `RuntimeStore.executeTask()` 从"只在 Workspace 面板可见触发"改为可在 Chat 发送路径选择调用，验证：

- Chat → Runtime.executeTask() → AgentAdapter → ProviderAdapter 全链路
- Chat 端 await TaskOutput 后渲染结果
- 错误传播：ProviderError → Runtime execution.failed → Chat 感知
- 与现有 WebSocket 路径并存，用户可切换

**前提条件**（当前已满足）：
- AgentAdapter 已完成
- ProviderAdapter 已完成
- BackendLLMClient 已完成
- TaskResult/execution.output 类型已就位
