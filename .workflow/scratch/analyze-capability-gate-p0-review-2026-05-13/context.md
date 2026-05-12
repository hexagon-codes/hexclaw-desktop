# Context: Capability Gate P0 Review

**Date**: 2026-05-13
**Areas discussed**: Capability Gate P0 实现审查

## Decisions

### Decision 1: Capability Gate P0 实现通过
- **Context**: skillBridge.ts +17 lines，新增 checkSkillCapabilities 内部 helper
- **Options considered**:
  1. skillBridge 侧 pre-check（方案 A — 已选）
  2. Runtime 侧 check（方案 B — 拒绝了，违反最小改动原则）
- **Chosen**: 方案 A — skillBridge 侧 pre-check
- **Reason**: 零 Runtime 侵入，catch 链复用，三态语义不变

## Constraints

### Locked
- `checkSkillCapabilities` 必须为内部 helper，不导出
- `tryExecuteSkill` 三态语义不可改变
- 只修改 `skillBridge.ts`，不碰 Runtime / runtimeBridge / chat-send-controller
- P0 不要求 `skill.execute` capability
- Policy 使用 `DEFAULT_ALLOWED_CAPABILITIES`

### Free
- 后续可扩展 per-session policy（通过 runtimeBridge 暴露）

### Deferred
- Per-session capability policy（P1）
- Capability policy UI（P3）

## Code Context
- `src/services/skillBridge.ts:38` — `checkSkillCapabilities` 内部 helper
- `src/services/skillBridge.ts:115-118` — capability 预检插入点
- `src/types/capability.ts:47-51` — `DEFAULT_ALLOWED_CAPABILITIES`
- `src/services/runtime/runtimeServices.ts:20` — `getRuntimeServices()` 服务定位器
