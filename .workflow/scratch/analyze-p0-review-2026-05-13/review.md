# Chat-first Skill Invocation P0 Review

> 审查日期：2026-05-13
> 范围：src/services/skillBridge.ts + src/stores/chat-send-controller.ts

---

## 逐项审查

### C1: resolveSkillByName — 只做 exact match

```typescript
// src/services/skillBridge.ts:53-63
export async function resolveSkillByName(
  skillName: string,
  registry: SkillRegistry,
): Promise<SkillMeta | undefined> {
  const skills = await registry.getAllSkills()
  const lower = skillName.toLowerCase()
  return skills.find(
    (s) => s.skillId.toLowerCase() === lower
      || s.displayName.toLowerCase() === lower,
  )
}
```

**结果**: ✅ 通过 — 仅 `===` 精确匹配（case-insensitive），无 fuzzy / alias / contains / similarity。

---

### C2: tryExecuteSkill — 没有演化成 orchestrator

```typescript
// src/services/skillBridge.ts:73-109
export async function tryExecuteSkill(text, params) {
  // 1. parse @mention
  const invocation = parseSkillInvocation(text)
  if (!invocation) return undefined

  // 2. exact match lookup
  const registry = getRegistry()
  const skillMeta = await resolveSkillByName(invocation.skillName, registry)
  if (!skillMeta) return undefined

  // 3. single execute + build
  try {
    const taskId = params.createId()
    const result = await executeChatTask(taskId)
    const assistantMsg = buildAssistantMessage(result.content, { id: params.createId() })
    params.messages.value.push(assistantMsg)
    return assistantMsg
  } catch (e) {
    params.handleSendError(e, null, params.sending, params.draftSending)
    return null
  }
}
```

**结果**: ✅ 通过 — 纯线性流程：parse → lookup → execute → build。无 retry、fallback、suggest closest、branching、multi-dispatch。

---

### C3: 没有 import RuntimeStore / Pinia store

```typescript
// src/services/skillBridge.ts:11-15
import type { Ref } from 'vue'
import type { ChatMessage, SkillMeta } from '@/types'
import { SkillRegistry } from './skillRegistry'
import { executeChatTask } from './runtimeBridge'
import { buildAssistantMessage } from '@/utils/buildAssistantMessage'
```

**结果**: ✅ 通过 — 唯一的 Runtime 接触点是通过 `runtimeBridge.executeChatTask`。无 `useRuntimeStore`、`useTaskStore`、`useXxxStore` 调用。

---

### C4: 没有读取文件 / SKILL.md / references

`skillBridge.ts` 只操作字符串（regex parse + string compare）和内存（messages.value push）。无 `readDir`、`readTextFile`、`BaseDirectory` 调用。

`SkillRegistry` 确实是 fs-backed，但那是 `skillRegistry.ts` 的职责，`skillBridge` 只调 `getAllSkills()` 返回的内存缓存。

**结果**: ✅ 通过 — 不解析 Skill 内容。

---

### C5: 无 buildSkillPrompt 或等效逻辑

`skillBridge.ts` 不含 `buildSkillPrompt` 函数。对 Runtime 的输入就是 `executeChatTask(taskId)`，Runtime 自行决定如何执行。对用户的输出就是 `buildAssistantMessage(result.content, ...)` — 复用现有 Chat 流程的纯字符串拼接。

**结果**: ✅ 通过 — 无模板引擎、system prompt 注入、LLM 调用。

---

### C6: 非 skill 消息路径完全不变

```typescript
// chat-send-controller.ts:155-163 (新增)
// ── Skill Invocation 检测 ──────────────────────
const skillMsg = await tryExecuteSkill(text, { ... })
if (skillMsg !== undefined) return skillMsg

// ── Task 生命周期注册 ────────────────────────────── (完全不变)
const $taskId = createId()
// ... 后续全部与原代码一致
```

`tryExecuteSkill` 返回 `undefined` 时自然 fallthrough。原有 Task 生命周期（165 行）、Runtime 分支（207 行）、WS delivery（238 行）均未修改。

**结果**: ✅ 通过 — 非 skill 路径不受影响。

---

### C7: 三态返回语义清楚

| 返回值 | 含义 | 代码位置 | 调用方处理 |
|--------|------|----------|-----------|
| `undefined` | 非 skill invoke，继续 normal chat | `skillBridge.ts:90, 95` | `if (skillMsg !== undefined) return skillMsg` — fallthrough |
| `null` | skill invoke 失败，已处理错误 | `skillBridge.ts:108` | return null，上游已有 error 展示 |
| `ChatMessage` | 成功 | `skillBridge.ts:105` | push 到 messages.value，return |

**结果**: ✅ 通过 — 三态语义清晰，调用方处理正确。

---

### C8: 仍不新增禁用概念

grep 确认 `skillBridge.ts` 和 `chat-send-controller.ts` 均不含：

```
SkillTask      → 无引用
SkillExecutor  → 无引用
Capability runtime logic → 无引用
Workflow / DAG / planner → 无引用
```

**结果**: ✅ 通过 — P0 未突破红线。

---

## 审查结论

| # | 检查项 | 结果 |
|---|--------|:----:|
| C1 | resolveSkillByName 只做 exact match | ✅ |
| C2 | tryExecuteSkill 无 orchestrator 模式 | ✅ |
| C3 | 无 RuntimeStore / Pinia store import | ✅ |
| C4 | 无文件 / SKILL.md / references 读取 | ✅ |
| C5 | 无 buildSkillPrompt 或等效逻辑 | ✅ |
| C6 | 非 skill 消息路径完全不变 | ✅ |
| C7 | 三态返回语义清楚 | ✅ |
| C8 | 不新增禁用概念 | ✅ |

**综合结论**: ✅ **Go — 允许 commit**

全部 8 项审查通过。实现完全符合 Chat-first Skill Flow 边界约束，未产生任何红线突破。

**建议**: 可以打 tag `skill-invocation-p0`

## diff 摘要

```
src/services/skillBridge.ts       (111 行新增)
src/stores/chat-send-controller.ts (+6 行: import + tryExecuteSkill 调用)

总计: ~117 行，1 新文件 + 1 文件修改
无 Runtime Kernel 修改
无 runtimeBridge 修改
无 buildAssistantMessage 修改
```
