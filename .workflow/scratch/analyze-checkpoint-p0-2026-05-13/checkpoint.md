# Checkpoint: @mention Skill Invocation P0

> 审查日期：2026-05-13
> Commit: `11c6049`
> Tag: `chat-first-skill-flow-p0`
> 审查范围: src/services/skillBridge.ts + src/stores/chat-send-controller.ts

---

## 逐项审查

### C1: @mention 路径是否符合 ADR-001

ADR-001: Chat 层不得直接 import RuntimeStore。

```typescript
// skillBridge.ts imports
import type { Ref } from 'vue'
import type { ChatMessage, SkillMeta } from '@/types'
import { SkillRegistry } from './skillRegistry'
import { executeChatTask } from './runtimeBridge'
import { buildAssistantMessage } from '@/utils/buildAssistantMessage'
```

Chat 层（`chat-send-controller.ts`）只 import `skillBridge`，通过 `runtimeBridge.executeChatTask` 接触 Runtime。无 `useRuntimeStore` 调用。

**结果**: ✅ 符合 ADR-001

---

### C2: skillBridge 是 anti-corruption layer，不是 orchestrator

Anti-corruption layer = 薄映射层，职责是 "translate" 而非 "orchestrate"。

当前 `tryExecuteSkill` 的完整逻辑链：
```
parse(入参) → lookup(注册表) → execute(委托Runtime) → build(纯函数) → push(内存)
```

没有的分支逻辑：
- ❌ 无 retry loop
- ❌ 无 fallback chain
- ❌ 无 conditional routing
- ❌ 无 multi-dispatch
- ❌ 无 state machine
- ❌ 无 event emission
- ❌ 无 sub-task spawning

**结果**: ✅ 是 anti-corruption layer，不是 orchestrator

---

### C3: 非 skill 普通聊天路径零影响

`chat-send-controller.ts` 中 skill invocation 检测的三态路由：

```typescript
const skillMsg = await tryExecuteSkill(text, { ... })
if (skillMsg !== undefined) return skillMsg  // skill 命中 → 提前返回
// undefined → fallthrough，原封不动走后续完整逻辑
```

原流程:
- Task 生命周期注册 (line 165)
- userMessage push → persistMessage (line 176-193)
- execMode === 'runtime' 分支 (line 207)
- deliveryController.deliverMessage (line 238)

全部未修改。git diff 确认只新增了 skill invocation 检测 block，原有代码无任何变更。

**结果**: ✅ 零影响

---

### C4: Skill lookup 仍是 exact match

```typescript
return skills.find(
  (s) => s.skillId.toLowerCase() === lower
    || s.displayName.toLowerCase() === lower,
)
```

`===` 比较，无 fuzzy / alias / contains / similarity / Levenshtein。

隐式的"别名"行为：`s.skillId` 也参与匹配，这是技能同时有 `name` 和 `id` 时的预期正常行为（同一技能的两种标识方式），不是 fuzzy match。

**结果**: ✅ 严格 exact match

---

### C5: 未引入 Workflow / DAG / Planner

全仓库 grep 确认 skillBridge.ts + chat-send-controller.ts：

```
SkillBridge     → 纯函数模块
DAG             → 无引用
Workflow        → 无引用
Planner         → 无引用
Pipeline        → 无引用
Chain           → 无引用
```

**结果**: ✅ 未引入

---

### C6: 未新增 Runtime 概念

```
SkillTask        → 无引用（仍使用 Task type: 'chat'）
SkillExecutor    → 无引用（仍使用 ContextAwareExecutor）
Capability       → 无 runtime logic（P0 skillBridge 不调 CapabilityValidator）
```

**结果**: ✅ 未新增

---

### C7: 必须立即修复的问题

| # | 问题 | 等级 | 说明 |
|---|------|------|------|
| 无 | — | — | 全部 8 项检查通过 |

triage 建议：无 P0 issue，无 blocking item。

**结果**: ✅ 无必须立即修复的问题

---

## 下一阶段建议

8 个 focus 方向，逐一评估是否 ready：

| 方向 | Readiness | 理由 |
|------|-----------|------|
| Capability Gate Analyze | P1 | `skillBridge.ts` 有 `// TODO: capability check` 注释，需要 CapabilityRegistry 和 Policy 基础设施。当前无真实 skill 需要权限控制。 |
| Param Card Analyze | P1 | 当前缺参直接报错，产品体验不足。需要 Param Card UI 组件 + skill.json params schema 规范。 |
| Official Skill Registry Analyze | P2 | SkillRegistry 已有但无 official/custom 区分逻辑。等 ClawHub 集成或自定义 skill 创建流程再处理。 |
| Skill Invocation UX Polish | P1 | @mention + skill 执行后无任何反馈感（没有 loading 态、没有确认提示）。用户输入 `@skill xxx` → 直接出结果，无中间状态。 |
| **建议** | | **下一次 Analyze 应聚焦 Capability Gate（P1 最高优先级）** |

### 优先级排序

```
P0 ✅ ==== 当前 checkpoint ====
  └─ Skill Invocation @mention (done, tagged)

P1 ── 下一个迭代
  ├─ Capability Gate Analyze (最高)
  ├─ Param Card Analyze
  └─ Skill Invocation UX Polish

P2 ── 等待信号
  ├─ Official Skill Registry Analyze
  ├─ NL Trigger
  └─ Semantic Skill Match
```

---

## Checkpoint Verdict

| 维度 | 结论 |
|------|------|
| Overall | ✅ Go |
| Commit 保留 | ✅ 保留 `11c6049` |
| Tag 保留 | ✅ 保留 `chat-first-skill-flow-p0` |
| Product Runtime Integration 第一个 checkpoint | ✅ 确认 |
| 下一步 | **Capability Gate Analyze** |

## 文件

- `src/services/skillBridge.ts` (111 行)
- `src/stores/chat-send-controller.ts` (+6 行)
