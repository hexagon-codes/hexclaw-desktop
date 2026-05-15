# Context: First Official Skill Validation

**Date**: 2026-05-13

## Decisions

### Decision 1: 第一个 Official Skill = summarize
- **Context**: 5 候选评估。summarize 是唯一已存在的 builtin skill，最强 SKILL.md 依赖度和结果可观测性
- **Options**:
  1. **summarize** ✅ — 已有完整文件，零创建成本
  2. rewrite — SKILL.md 验证力弱，结果主观
  3. extract — 需 structured output（当前不可用）
  4. translate — SKILL.md 验证力最弱
  5. classify — 过于简单
- **Chosen**: summarize
- **Reason**: 零代码变更，最强注入链验证，最大 Demo 价值

## Constraints

### Locked
- L1: summarize 是第一个 Official Skill
- L2: 使用现有 `skills/builtin/summarize/` 文件，不修改 skill.json / SKILL.md
- L3: 不新增 capability（summarize 只需要 llm）
- L4: 不扩展 Result Surface
- L5: 不做 multi-step orchestration
- L6: 7 条红线适用

### Free
- F1: LLM provider 选择 — 当前 ChatAgentExecutor 已支持
- F2: 输出语言 — 可随 SKILL.md 调整

### Deferred
- D1: extract skill — 等 TaskResult 结构化 kind
- D2: rewrite / translate / classify — 低优先级
- D3: structured output — 无需求时不实现

## Code Context

### 相关文件

| 文件 | 状态 | 说明 |
|------|------|------|
| `skills/builtin/summarize/skill.json` | ✅ 就绪 | `capabilities: ["llm"]` |
| `skills/builtin/summarize/SKILL.md` | ✅ 就绪 | 4 条 WP + 4 条约束 + Quality Bar |
| `src/services/skillBridge.ts` | ✅ 已验证 | tryExecuteSkill 全流程 |
| `src/services/agentAdapter.ts` | ✅ 已验证 | buildPromptInput 合入 skill.markdown |
| `src/stores/runtime.ts` | ✅ 已验证 | loadSkillLayerForTask |

### 验证命令

```bash
# TypeScript 编译
npx tsc --noEmit

# 确认 skill 文件存在
ls skills/builtin/summarize/
# → skill.json  SKILL.md

# 确认文件内容
cat skills/builtin/summarize/skill.json
cat skills/builtin/summarize/SKILL.md
```
