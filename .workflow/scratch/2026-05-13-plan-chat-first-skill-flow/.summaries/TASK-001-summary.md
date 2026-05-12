# TASK-001 Summary: 实现 @mention Skill Invocation P0

**Status**: ✅ Completed
**Duration**: ~2m
**Executor**: code-developer agent

## Changes

**File**: `src/services/skillBridge.ts` (new, 111 行)

3 个 export 函数：
- `parseSkillInvocation(text)` — 正则 `/^@(\S+)\s*(.*)/` 解析 @mention
- `resolveSkillByName(skillName, registry)` — SkillRegistry 按名匹配
- `tryExecuteSkill(text, params)` — 主入口：解析→匹配→Runtime execute→ChatMessage

**File**: `src/stores/chat-send-controller.ts` (modify, +6 行)

- Line 11: `import { tryExecuteSkill } from '@/services/skillBridge'`
- Lines 155-163: Skill invocation 检测路由，在 `draftSending` 赋值之后、Task 生命周期注册之前

## Verification

| 检查项 | 结果 |
|--------|:----:|
| skillBridge.ts 存在 | ✅ |
| export parseSkillInvocation | ✅ |
| export resolveSkillByName | ✅ |
| export tryExecuteSkill | ✅ |
| sendMessage() 入口调用 tryExecuteSkill | ✅ (line 156) |
| Task 生命周期注册未修改 | ✅ (line 165) |
| deliveryController 未修改 | ✅ (line 238) |
| tsc --noEmit | 通过 ✅ |
| 现有测试 195/200 通过 | ✅ (5 pre-existing failures) |

## Approach

最小改动模式：新增独立 bridge 层，不修改 Runtime Kernel、runtimeBridge、buildAssistantMessage。tryExecuteSkill 返回三态（undefined=非skill/null=执行失败/ChatMessage=成功），与 sendMessage 类型兼容。SkillRegistry 使用模块级 lazy 单例。
