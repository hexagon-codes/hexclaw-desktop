# Analysis: Runtime Error Boundary Formalization

**Session**: ANL-error-boundary-2026-05-13
**Date**: 2026-05-13
**Prerequisite**: Stabilization Roadmap P0 — Error boundary formalization

## 0. Executive Summary

Runtime 路径的错误处理存在 **2 层丢失**：`executeTask` 静默吞噬异常（不 re-throw），以及 `TaskError` → `ApiError` 转换时丢失 error code。用户最终看到 `UNKNOWN` 通用错误，无法区分"执行失败"和"未知错误"。需要建立 `BridgeError` 类型 + 显式 error code mapping 来封闭这个边界。

---

## 1. 错误流程图

### WS Path（已稳定）

```
deliveryController.deliverMessage()
  ├─ success → finalizeAssistantMessage → ChatMessage
  └─ error  → handleSendError(error, ...)
                └─ fromNativeError(error)
                     ├─ fetch error  → ApiError { code: NETWORK_ERROR }
                     ├─ AbortError   → ApiError { code: TIMEOUT }
                     ├─ HTTP status  → ApiError { code: fromHttpStatus() }
                     └─ unknown      → ApiError { code: UNKNOWN }
```

```
sendMessage outer catch (line 248)
  └─ taskStore.failTask({ code: 'SEND_ERROR' })
  └─ failChatTask({ code: 'SEND_ERROR' })
  └─ throw e  → (handleSendError 已在 deliveryController 内调用)
```

### RT Path（问题路径）

```
sendMessage(execMode === 'runtime', line 204)
  └─ executeChatTask($taskId)
       ├─ runtime.executeTask(taskId)           ← runtime.ts:361
       │    ├─ executor.executeWithContext()
       │    └─ catch (e) [runtime.ts:406]        ← ❌ 第一层丢失
       │         ctx.execution.error = { code: 'EXECUTION_FAILED', message }
       │         ❌ 不 re-throw，函数静默返回
       │
       ├─ getExecutionResult(taskId)             ← runtime.ts:341
       │    └─ 因 executeTask 失败，output=undefined
       │    └─ return undefined
       │
       ├─ if (!result) throw Error('执行完成但无输出结果')  ← 桥接器生成合成错误
       │
       └─ catch (e) [runtimeBridge.ts:75]        ← 第二层能捕获，但 msg 来自桥接器
            taskStore.failTask({ code: 'EXECUTION_FAILED', message: msg })
            throw e

sendMessage catch (line 217)
  └─ handleSendError(e, ...)
       └─ fromNativeError(e)
            └─ e 是 Error('执行完成但无输出结果')
            └─ → ApiError { code: UNKNOWN, message: '执行完成但无输出结果' }  ← ❌ 第二层丢失
```

---

## 2. 类型分析

### 当前类型

```typescript
// src/types/task.ts — Runtime 侧
interface TaskError {
  code: string        // 自由字符串，无类型约束
  message: string
  stack?: string
}

// src/types/error.ts — Chat 侧
type ApiErrorCode = 'NETWORK_ERROR' | 'TIMEOUT' | 'UNAUTHORIZED' | 'FORBIDDEN'
                  | 'NOT_FOUND' | 'VALIDATION_ERROR' | 'RATE_LIMITED'
                  | 'SERVER_ERROR' | 'SSE_PARSE_ERROR' | 'UNKNOWN'

interface ApiError {
  code: ApiErrorCode
  message: string
  status?: number
  cause?: unknown
}
```

### 缺失的映射

| TaskError.code 来源 | 应映射到 ApiErrorCode | 当前结果 |
|:---|---|:---:|
| `EXECUTION_FAILED` | `SERVER_ERROR` 或新增 `EXECUTION_ERROR` | `UNKNOWN` ❌ |
| `SEND_ERROR` | `SERVER_ERROR` | `UNKNOWN` ❌ |
| `'执行完成但无输出结果'` | `EXECUTION_ERROR` 或类似 | `UNKNOWN` ❌ |
| Executor stub 空结果 | 新增 `EXECUTION_STUB` 或 `UNKNOWN` | `UNKNOWN` ❌ |

### Error Code 使用情况

| code | 出现位置 | 消费者 |
|------|---------|--------|
| `EXECUTION_FAILED` | runtimeBridge.ts:79, runtime.ts:414, runtime.ts:418 | TaskStore.failTask |
| `SEND_ERROR` | chat-send-controller.ts:249, chat-send-controller.ts:250 | TaskStore.failTask + failChatTask |
| (ApiErrorCode 全部) | errors.ts | handleSendError, UI error display |
| `UNKNOWN` | errors.ts:66 | 所有未被识别的错误的回退 |

---

## 3. 问题矩阵

| # | 问题 | 位置 | 严重程度 | 影响 |
|---|------|------|---------|------|
| 1 | `executeTask` 吞异常不 re-throw | runtime.ts:406-434 | 🔴 | 桥接器收不到错误详情，只能生成合成错误 |
| 2 | `BridgeError` 类型不存在 | 无 | 🔴 | 两个错误系统之间无类型安全的映射层 |
| 3 | `EXECUTION_FAILED` 不是 ApiErrorCode | runtimeBridge.ts | 🟡 | fromNativeError 降级为 UNKNOWN |
| 4 | `SEND_ERROR` 不是 ApiErrorCode | chat-send-controller.ts | 🟡 | 同上 |
| 5 | WS/RT error shape 不一致 | 双路径 | 🟡 | 上层需要兼容两种错误形状 |
| 6 | `fromNativeError` 对 Runtime Error 无感知 | errors.ts:47-70 | 🟡 | 所有 Runtime 错误被视为通用 Error |
| 7 | `ctx.execution.error` 类型隐式 | runtime.ts:414 | 🟢 | 类型兼容但无显式契约 |

---

## 4. 修复方向

### 4.1 定义 BridgeError 类型

作为 `TaskError` 和 `ApiError` 的中间层，位于 `runtimeBridge.ts`：

```typescript
// 在 runtimeBridge.ts 或 types/bridge.ts 中

/** Runtime → Chat 错误码映射的 Bridge 层 */
export type BridgeErrorCode =
  | 'EXECUTION_FAILED'       // 执行器内部错误
  | 'EXECUTION_TIMEOUT'      // 执行超时
  | 'EXECUTION_CANCELLED'    // 执行被取消
  | 'CONTEXT_NOT_FOUND'      // Context 不存在
  | 'NO_OUTPUT'              // 执行完成但无输出

export interface BridgeError {
  code: BridgeErrorCode
  message: string
  cause?: unknown
}

/** BridgeError → ApiError 映射 */
export function bridgeErrorToApiError(err: BridgeError): ApiError {
  const codeMap: Record<BridgeErrorCode, ApiErrorCode> = {
    EXECUTION_FAILED: 'SERVER_ERROR',
    EXECUTION_TIMEOUT: 'TIMEOUT',
    EXECUTION_CANCELLED: 'UNKNOWN',     // ApiError 暂无 CANCELLED，映射到 UNKNOWN
    CONTEXT_NOT_FOUND: 'UNKNOWN',
    NO_OUTPUT: 'SERVER_ERROR',
  }
  return {
    code: codeMap[err.code],
    message: err.message,
    cause: err.cause,
  }
}
```

### 4.2 runtime.ts:executeTask re-throw 错误

```typescript
// runtime.ts line 406
catch (e) {
  // 设置 execution state = failed
  ctx.execution!.state = 'failed'
  ctx.execution!.error = { code: 'EXECUTION_FAILED', message: (e as Error).message }
  // ... 现有逻辑不变
  revision.value++

  // 新增：re-throw，让桥接器感知
  throw e
}
```

但这里需要考量：`executeTask` 当前有 `revision.value++` 在 `catch` 之后（line 436）。如果 re-throw，调用者需要保证 `revision.value++` 已执行。

实际上看代码结构，`revision.value++` 在 try-catch 块**之后**（line 436），所以 re-throw 会跳过 `revision.value++`。需要把 `revision.value++` 移入 try-catch-finally。

### 4.3 executeChatTask 错误处理增强

```typescript
// runtimeBridge.ts
async function executeChatTask(taskId: string): Promise<TaskResult> {
  const runtime = useRuntimeStore()
  const taskStore = useTaskStore()

  try {
    await runtime.executeTask(taskId)
    const result = runtime.getExecutionResult(taskId)
    if (!result) {
      // 使用 BridgeError 代替裸 Error
      const err: BridgeError = { code: 'NO_OUTPUT', message: '执行完成但无输出结果' }
      taskStore.failTask(taskId, { code: err.code, message: err.message })
      throw err
    }
    taskStore.completeTask(taskId, { result, artifacts: [] })
    return result
  } catch (e) {
    // 区分 BridgeError vs 其他错误
    const bridgeErr: BridgeError = isBridgeError(e) ? e : {
      code: 'EXECUTION_FAILED',
      message: (e as Error).message,
    }
    taskStore.failTask(taskId, { code: bridgeErr.code, message: bridgeErr.message })
    // timeline 事件：runtime.failContextForTask 已在 executeTask catch 中写入
    // 但 task.failed 和 execution.failed 均已写入
    // Bridge 不需要再次 failChatTask（execution.failed timeline 已存在）
    throw bridgeErrorToApiError(bridgeErr)  // 抛出 ApiError 供 handleSendError 消费
  }
}
```

### 4.4 新增 Runtime Error Code 到 ApiErrorCode

考虑要不要在 `ApiErrorCode` 中新增 `EXECUTION_ERROR`。从架构角度：
- `ApiErrorCode` 是 Chat 侧的类型，不应为 Runtime 添加专有枚举值
- 更干净的做法是 `BridgeError` → `ApiError` 映射（见 4.1）
- 但如果确实需要在 UI 层区分"执行错误"和"服务器错误"，可以添加

推荐：暂时不扩展 `ApiErrorCode`，通过 `bridgeErrorToApiError` 映射到现有枚举。

---

## 5. 影响范围

| 变更 | 文件 | 类型 |
|------|------|------|
| 新增 BridgeError 类型 | `src/types/bridge.ts` 或 `runtimeBridge.ts` | 新增 |
| 修改 executeChatTask | `runtimeBridge.ts` | 修改 |
| 修改 executeTask 错误处理 | `runtime.ts:406-436` | 修改 |
| 可能调整 fromNativeError | `errors.ts:47-70` | 可选 |
| 无需修改 | `chat-stream-error.ts` | — |
| 无需修改 | `chat-send-controller.ts` | — |

---

## 6. 工作量估算

| 项目 | 预估 |
|------|------|
| BridgeError 类型定义 | ~15 分钟 |
| executeChatTask 改造 | ~30 分钟 |
| runtime.ts executeTask 异常传播改造 | ~30 分钟 |
| verify 验证 | ~15 分钟 |
| **总计** | **~1.5 小时** |

---

## 7. 风险

| 风险 | 说明 | 缓解 |
|------|------|------|
| executeTask re-throw 影响 TaskStore | TaskStore.failTask 可能在 catch 和 bridge 之间被调用两次 | Bridge 只在 catch 中 failTask 一次 |
| 现有消费者可能依赖 executeTask 不抛异常 | 当前 `runtime.ts:executeTask` 不抛异常是隐式契约 | 修改前 grep 确认所有调用点 |
| timeline 事件重复 | executeTask catch 已写入 execution.failed/task.failed，bridge catch 又写一次 | Bridge 不重复 failChatTask |
