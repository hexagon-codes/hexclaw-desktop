# TASK-ADR-007 Summary

**Title**: 写入 ADR-007: Capability Gate
**Status**: completed

## Changes
- 创建 `docs/adr/007-capability-gate.md`
- Status: accepted (non-frozen)
- Content: Context (Gate 位置选择)、Decision (skillBridge 入口 + DEFAULT_ALLOWED_CAPABILITIES + throw Error)、Constraints (Gate 不在 Registry/Loader/Runtime)、Rejected Alternatives (5项)、Consequences (✅4 ⚠️2)、Compliance (grep 命令)、References (skillBridge.ts:38-46/115-118, capability.ts:47-51, runtimeServices.ts:20-28)、Cross-References (ADR-005, ADR-008)

## Verification
| Criterion | Result |
|-----------|--------|
| file exists | ✅ |
| Status: accepted | ✅ (2 matches) |
| contains 'DEFAULT_ALLOWED_CAPABILITIES' | ✅ (9 matches) |
| contains 'checkSkillCapabilities' | ✅ (6 matches) |
