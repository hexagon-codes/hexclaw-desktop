# Context: Error Boundary Formalization

**Date**: 2026-05-13
**Session**: ANL-error-boundary-2026-05-13
**Source**: Stabilization Roadmap P0 — Error boundary formalization analyze

## Decisions

### Decision 1: BridgeError 类型定义
- **Context**: Runtime (TaskError) 和 Chat (ApiError) 之间缺少类型安全的错误映射层
- **Chosen**: 在 `runtimeBridge.ts` 中定义 `BridgeError` + `BridgeErrorCode` 联合类型 + `bridgeErrorToApiError` 映射函数
- **Reason**: 不污染 Chat 侧的 `ApiErrorCode` 枚举，同时保持两个域的解耦。Bridge 是 anti-corruption layer，错误映射属于它的职责

### Decision 2: executeTask 异常传播
- **Context**: `runtime.ts:executeTask` 当前在 catch 中不 re-throw，导致错误详情丢失
- **Chosen**: executeTask re-throw 错误（需要将 `revision.value++` 移入 finally 块）
- **Reason**: 打破第一层丢失。调用者（桥接器）需要感知执行失败以提供有意义的错误信息

### Decision 3: Bridge 只写一次 TaskStore.failTask
- **Context**: executeTask catch 和 executeChatTask catch 都可能调用 failTask，导致重复
- **Chosen**: executeTask 负责 execution.failed/task.failed timeline 事件，桥接器只在 catch 中调用一次 TaskStore.failTask（不再调用 failChatTask，因为 timeline 已写入）
- **Reason**: 避免重复的 timeline 事件和 TaskStore 状态覆盖

### Decision 4: 不扩展 ApiErrorCode
- **Context**: 'EXECUTION_FAILED' 不是 ApiErrorCode 的有效值
- **Chosen**: 通过 `bridgeErrorToApiError` 映射到现有 `ApiErrorCode`（`EXECUTION_FAILED` → `SERVER_ERROR`）
- **Reason**: ApiErrorCode 是 Chat 侧的错误分类，不应被 Runtime 细节污染。UI 层显示 `SERVER_ERROR` 是 reasonable 的降级

## Constraints

### Locked
1. **handleSendError 不修改** — `chat-stream-error.ts` 的 `handleSendError` 是 WS + RT 路径共享的错误展示层。所有修改在桥接层完成，handleSendError 保持接收 `unknown` → `fromNativeError` → `ApiError` 的契约
2. **executeTask 的 timeline 事件写入不变** — execution.failed/task.failed 已在 executeTask catch 中写入，桥接层不重复写入
3. **fromNativeError 逻辑不变** — 对已有 ApiError 结构的短路检测（line 49-52）保持

### Free
- BridgeErrorCode 的具体枚举值（当前提议 5 个，可根据实际需要增减）
- `ctx.execution.error` 的类型是否改为 `BridgeError`（当前 `{ code: string; message: string }` 结构兼容）
- `revision.value++` 的具体位置调整（try-catch-finally 重构的细节）

### Deferred
- **Executor stub 错误分类** — 当前 agent/skill executor 返回空结果 `{ result: null, artifacts: [] }`，不触发错误路径。post-window 处理
- **Recovery layer 错误关联** — `applyFailureRecord` 接受 `{ code: string; message: string }`，可能与 BridgeError 关联。post-window
- **Error boundary testing** — 当前无 error boundary 专用测试。可列入 stabilization 后期或独立测试任务

## Execution Plan (Suggested)

```
Step 1: 定义 BridgeError 类型 (runtimeBridge.ts 头部)
Step 2: 重构 executeTask 错误传播 (runtime.ts)
Step 3: 改造 executeChatTask 使用 BridgeError (runtimeBridge.ts)
Step 4: verify — 模拟 executeTask 失败路径
```

## Downstream References

- `src/services/runtimeBridge.ts:56-82` — executeChatTask 实现
- `src/stores/runtime.ts:361-437` — executeTask 实现（含 catch 不 re-throw）
- `src/stores/runtime.ts:133-157` — failContextForTask（写入 execution.failed timeline）
- `src/utils/errors.ts:47-70` — fromNativeError（不识别 Runtime 错误）
- `src/stores/chat-stream-error.ts:32-53` — handleSendError（两条路径的共享 UI 错误展示）
- `src/stores/chat-send-controller.ts:204-222` — RT 路径 error catch
