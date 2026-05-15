# Context: WS/RT Semantic Drift Closure

**Date**: 2026-05-13
**Session**: ANL-ws-rt-drift-2026-05-13

## Decisions

### Decision 1: D1 Auto-title 修正 — Execute
- **Context**: RT 路径 `chat-send-controller.ts:196-209` 的 `execMode === 'runtime'` 分支在 `executeChatTask` 返回后未调用 `suggestSessionTitle`，导致 session title 永远显示"前30字..."临时标题
- **Options**:
  1. 在 RT 分支追加 `triggerAutoTitleSuggestion(sessionId)` 调用
  2. 在 `executeChatTask` 内部触发 auto-title
  3. 不修复
- **Chosen**: 方案 1 — 在 `chat-send-controller.ts` 的 RT 分支追加调用
- **Reason**: 1 行改动，不侵入 runtimeBridge，不引入新依赖

### Decision 2: D2 reasoning/tool_calls — Hold
- **Context**: RT 路径 `buildAssistantMessage(result.content)` 不传 reasoning/tool_calls。但当前 Runtime executor（agentAdapter）不产生这些数据，drift 尚未活跃
- **Chosen**: ⏸️ Hold — 等 real executor 产生 reasoning 后再处理
- **Reason**: 不扩展 TaskResult，不做超前设计。当前无实际需求信号

### Decision 3: D3 error surface — 已验证统一
- **Context**: RT 路径 `bridgeErrorToApiError` 返回 `ApiError`，WS 路径 `fromNativeError` 也返回 `ApiError`。最终都通过 `handleSendError` → `fromNativeError`（含 ApiError 短路检测）处理
- **Chosen**: ✅ 已验证 — 不修改

## Constraints

### Locked
1. **不扩展 TaskResult** — reasoning/tool_calls 不通过 TaskResult 传递
2. **不修改 executor interface** — executor 不暴露 reasoning callback
3. **不修改 WS path** — WS 路径架构保持不动

### Free
- `chat-send-controller.ts` RT 分支可追加 auto-title 调用
- 未来可新增 bridge 层 reasoning 数据通道（不破坏 ADR-001）

### Deferred
- **D2 reasoning/tool_calls bridge 通道** — 待 real executor 产出 reasoning 时设计
- **D4 thinking_duration** — 待 Runtime executor 记录推理时间
- **D5 artifact 提取** — 待 workspace 投影层统一处理
