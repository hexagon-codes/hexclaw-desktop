# TASK-ADR-008 Summary

**Title**: 写入 ADR-008: Chat-first Skill Invocation
**Status**: completed

## Changes
- 创建 `docs/adr/008-chat-first-skill-invocation.md`
- Status: accepted (non-frozen)
- Content: Context (@mention 唯一入口)、Decision (sendMessage→tryExecuteSkill→executeChatTask 路径 + three-return 语义 + Runtime 路径)、Constraints (three-return 不可改; 必须走 runtimeBridge)、Rejected Alternatives (5项)、Consequences (✅4 ⚠️2)、Compliance (grep 命令)、References (chat-send-controller.ts:156-163, skillBridge.ts:91-133, runtimeBridge.ts:77-108)、Cross-References (ADR-001, ADR-007)

## Verification
| Criterion | Result |
|-----------|--------|
| file exists | ✅ |
| Status: accepted | ✅ |
| contains 'tryExecuteSkill' | ✅ (13 matches) |
| contains 'ADR-001' | ✅ (2 matches) |
| contains 'ADR-007' | ✅ (2 matches) |
