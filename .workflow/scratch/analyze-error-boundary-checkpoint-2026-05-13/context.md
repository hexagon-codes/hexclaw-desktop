# Context: Error Boundary Checkpoint Review

**Date**: 2026-05-13
**Session**: ANL-error-boundary-checkpoint-2026-05-13
**Commit**: 9dd4729

## Decisions

### Decision 1: Checkpoint Go
- **Context**: Error Boundary 修复已提交，需确认是否可作为 stabilization P0 checkpoint
- **Chosen**: ✅ Go — 打 tag `runtime-error-boundary-v0.1`
- **Reason**: 全部 7 项审查标准通过，零修改文件范围可控，tsc + tests 通过

### Decision 2: ADR-005 暂缓
- **Context**: BridgeError 映射是 Bridge 新增职责，ADR-001 当前不包含
- **Chosen**: ⏸️ 暂缓到 Wave 2，在 ADR-005 草案中记录
- **Reason**: Stabilization roadmap 规定 ADR Wave 2 只起草不发布，不影响当前修复

## Constraints

### Locked
1. **BridgeError 定义在 runtimeBridge.ts 中** — 不移入独立文件，保持 bridge 边界类型与 bridge 函数同位置
2. **不扩展 ApiErrorCode** — 所有 Runtime 错误通过 `bridgeErrorToApiError` 映射到现有枚举
3. **executeChatTask catch 不调用 failChatTask** — timeline 写入由 executeTask catch 负责，避免重复
4. **Chat 层不导入 RuntimeStore** — ADR-001 compliance 已验证通过

### Free
- BridgeErrorCode 未来可增加新枚举值（如 `EXECUTION_TIMEOUT`、`EXECUTION_CANCELLED`）
- `ctx.execution.error` 类型未来可改为显式 `BridgeError`（当前结构兼容）

### Deferred
- **ADR-005 Bridge Responsibility draft** — 待 Wave 2 起草，纳入 BridgeError 映射职责
- **Error boundary 集成测试** — 当前单测覆盖，可补充 executor stub 失败场景
