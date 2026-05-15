# TASK-D1 Summary: RT 路径追加 auto-title suggestion

**Status**: ✅ Completed
**Duration**: ~5m
**Executor**: agent

## Changes

**File**: `src/stores/chat-send-controller.ts`

在 `execMode === 'runtime'` 分支的 `persistMessage` 调用后，追加 auto-title suggestion 逻辑：

```typescript
// D1: Auto-title suggestion — 复用 WS path 的 suggestSessionTitle 机制
const shouldSuggestTitle = !!pendingSuggestedTitleExpectation.value[sessionId]
setPendingSuggestedTitleExpectation(sessionId, null)
void (async () => {
  if (shouldSuggestTitle) {
    const titleSync = pendingAutoTitleSync.get(sessionId)
    if (titleSync) await titleSync
    const result = await msgSvc.suggestSessionTitle?.(sessionId, '')
    if (result?.updated && result.title) {
      setLocalSessionTitle(sessionId, result.title)
    }
  }
})()
```

## Verification

| 检查项 | 结果 |
|--------|:----:|
| 修改文件数 | 1 ✅ |
| tsc --noEmit | 通过 ✅ |
| 现有测试 9/9 | 通过 ✅ |
| 不修改 WS path | ✅ |
| 不修改 Runtime Kernel | ✅ |
| 不修改 runtimeBridge | ✅ |
| 不修改 buildAssistantMessage | ✅ |
| 不修改 auto-title controller 结构 | ✅ |
| 不新增测试文件 | ✅ |
| 不抽公共函数 | ✅ |

## Approach

直接内联复用 WS path（`chat-stream-completion.ts:74-96`）的 auto-title suggestion 模式。pendingSuggestedTitleExpectation / pendingAutoTitleSync / setLocalSessionTitle / msgSvc 均为 controller 已有参数，无需新增依赖。
