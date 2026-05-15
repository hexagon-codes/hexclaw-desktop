# Analysis: Error Boundary Checkpoint Review

**Session**: ANL-error-boundary-checkpoint-2026-05-13
**Date**: 2026-05-13
**Commit**: 9dd4729 — `fix: runtime error boundary — BridgeError + executeTask re-throw`
**Type**: Checkpoint review (quick mode)

## Verification Results

### 1. executeTask re-throw — 是否破坏现有调用方

**结论**: ✅ 安全

- `executeTask` 的唯一调用方是 `runtimeBridge.ts:executeChatTask`（line 83）
- 该调用方已有 `try-catch` 块，re-throw 后能正常捕获
- 无其他直接调用方（grep 确认仅 runtimeBridge.ts 调用）

### 2. revision.value++ in finally — 成功/失败路径都刷新

**结论**: ✅ 正确

```typescript
} finally {
  revision.value++
}
```

- `finally` 块在 try 成功和 catch 执行后均会执行
- 成功路径：try 完成 → finally revision++
- 失败路径：catch 执行 → re-throw → finally revision++（revision 在 re-throw 前递增）

### 3. BridgeError 边界 — 不污染两端

**结论**: ✅ 符合 ADR-001

- `BridgeError` / `BridgeErrorCode` / `bridgeErrorToApiError` 全部定义在 `runtimeBridge.ts`
- Runtime 端：`TaskError { code: string }` 不变
- Chat 端：`ApiError { code: ApiErrorCode }` 不变
- Bridge 是 anti-corruption layer，错误映射是 Bridge 的自然职责

### 4. bridgeErrorToApiError 不扩展 ApiErrorCode

**结论**: ✅ 未污染

```typescript
// runtimeBridge.ts:34 — 映射到现有 ApiErrorCode
const codeMap: Record<BridgeErrorCode, import('@/types/error').ApiErrorCode> = {
  EXECUTION_FAILED: 'SERVER_ERROR',
  NO_OUTPUT: 'SERVER_ERROR',
}
```

- `src/types/error.ts` 无新增枚举值
- 映射路径：`EXECUTION_FAILED` → `SERVER_ERROR`，`NO_OUTPUT` → `SERVER_ERROR`

### 5. handleSendError / fromNativeError 保持不变

**结论**: ✅ 零修改

```bash
git diff src/stores/chat-stream-error.ts src/utils/errors.ts
# (no output)
```

- `chat-stream-error.ts` 不变
- `errors.ts` 不变
- `fromNativeError` 已有 `ApiError` 短路检测（line 49-52），收到 `bridgeErrorToApiError` 返回的 `ApiError` 后直接通过

### 6. 重复 fail timeline / failTask

**结论**: ✅ 无重复

| 层 | 写入内容 | 说明 |
|----|---------|------|
| `runtime.ts:executeTask catch` | `execution.failed` + `task.failed` timeline | ✅ 保留 |
| `runtimeBridge.ts:executeChatTask catch` | `taskStore.failTask` | ✅ 仅写入 TaskStore |
| `runtimeBridge.ts:executeChatTask catch` | `failChatTask` NOT called | ✅ 避免了 timeline 重复 |

Bridge catch 中有注释显式说明：
```
// Runtime 路径下，Runtime 已写入 execution.failed timeline
// Bridge 代理 TaskStore fail（不重复 failChatTask，timeline 已写入）
```

### 7. ADR-005 是否需要补充

**结论**: ⏸️ 暂缓到 Wave 2

- BridgeError 类型和 error mapping 属于 Bridge 的新增职责
- 当前 ADR-001 冻结 baseline 只记录了 4 个函数的职责，不含 error mapping
- Stabilization roadmap 规定 ADR Wave 2 只起草不发布，ADR-005（Bridge Responsibility）在 Wave 2 scope 内
- **建议**: 在 ADR-005 中记录 BridgeError 映射职责，但不提前 freeze

## 额外验证

| 检查项 | 结果 |
|--------|:----:|
| ADR-001 compliance: Chat 层无 RuntimeStore 直接导入 | ✅ `grep` 无匹配 |
| `tsc --noEmit` 编译 | ✅ 通过 |
| 单元测试 9/9 通过 | ✅ 通过 |
| 修改文件范围（3 files, 64+7-） | ✅ 无越界 |

## 审查结论

### Go/No-Go: ✅ Go — 允许打 checkpoint tag

| 维度 | 评分 | 说明 |
|------|:---:|------|
| 正确性 | 5/5 | 2 层错误丢失已修复，所有路径验证通过 |
| 安全性 | 5/5 | re-throw 不破坏唯一调用方，finally 保证 revision 一致 |
| 边界性 | 5/5 | BridgeError 严格在 bridge 层，不污染两端 |
| 完整性 | 4/5 | ADR-005 待 Wave 2 补充，当前修复本身完整 |
| 测试覆盖 | 4/5 | 新增 3 个测试覆盖错误路径和映射，error boundary 后续可追加集成测试 |

### 建议 tag 名称

```
runtime-error-boundary-v0.1
```

含义：Runtime Error Boundary 首次正式化。v0.1 表示这是 stabilization window 内的第一个 checkpoint，后续 TaskResult 加固、Observability 等其他 P0 项目完成后再升级版本。

### P0/P1/P2

| 优先级 | 项目 | 状态 |
|:------:|------|:----:|
| P0 | Error Boundary formalization | ✅ 完成 |
| P1 | TaskResult 类型加固 | ➡️ 待 analyze |
| P1 | Execution observability | ➡️ 待 analyze |
| P1 | WS/RT 语义漂移封闭 | ➡️ 待 analyze |
| P2 | ADR Wave 2 草案 | ⏸️ Wave 2 |
