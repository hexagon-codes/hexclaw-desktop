# First Official Skill P0 Analysis

**Session**: ANL-first-official-skill-p0-2026-05-13
**Date**: 2026-05-13
**Type**: Architecture Analysis

## User Intent

选择合适的第一个 Official Skill，验证 Chat-first Skill Runtime 架构边界。核心原则：不是功能多强，而是是否符合哲学。

### 分析维度

1. 哪种 Skill 最适合做第一个 Official Skill
2. 哪种最能验证 Runtime Boundary
3. 哪种最不容易滑向 Workflow
4. 哪种最能复用现有 execution chain
5. 是否需要新增 capability
6. 是否需要 Skill-specific context
7. 是否需要 Result Surface 扩展
8. 哪些必须 deferred

---

## Current Understanding

### 现有系统状态

- **Builtin Skill**: 仅 `skills/builtin/summarize/` — skill.json + SKILL.md + references
- **Capabilities**: `['llm']` — 唯一需要
- **Execution Chain**（当前）:

```
@mention → tryExecuteSkill → parseSkillInvocation
                            → resolveSkillByName (Registry 查询)
                            → checkSkillCapabilities (Capability Gate)
                            → executeChatTask(taskId)
                              → runtime.executeTask(taskId)
                                → ContextAwareExecutor.executeWithContext()
                                  → ChatAgentExecutor: buildPromptInput → LLM
```

- **关键发现**: Skill 的 SKILL.md 未被注入执行链。`tryExecuteSkill` 只传 `taskId`，不传任何 skill 上下文。Executor (`ChatAgentExecutor`) 只能拿到 `task.input.payload.text`。

### 7 条红线

禁止：DAG / Workflow Engine / Node Graph / BPMN / Visual Builder / Auto Agent Planner / Multi-Agent

---

## Round 1: Codebase Exploration Findings

### 1. Execution Chain Gap

当前 `tryExecuteSkill` 实现：

```typescript
// skillBridge.ts:121-123
const taskId = params.createId()
const result = await executeChatTask(taskId)
```

`executeChatTask` 调用 `runtime.executeTask(taskId)`，但 **没有先注册 Context**。正常 Chat 流中：

```typescript
// chat-send-controller.ts:166-175
registerChatTask($chatTask)   // ← 注册 Context
const result = await executeChatTask($taskId)  // ← 再执行
```

Skill 流缺少 `registerChatTask`。这是一个 P0 阻断 — 当前 `@summarize` 无法真正执行。

**影响**: 第一个 Official Skill P0 必须先修复执行链：注册 Skill Context → 注入 SKILL.md → 执行。

### 2. SkillTaskExecutor 是 Stub

`taskExecutor.ts:106-132` — `SkillTaskExecutor.executeWithContext` 返回 `{ result: null, artifacts: [] }`。当前所有 skill 类型的 task 都走这个 stub。

当前实际执行走的是 `ChatAgentExecutor`（因为 `tryExecuteSkill` 没有设置 task type 为 'skill'），所以 skill 执行实际上是 chat 执行——意味着 skill 的 SKILL.md 上下文完全没有被使用。

### 3. ContextLoader 已有 Skill Layer 骨架

`context.ts:67-78` — `SkillLayer` 接口已定义（skillId, markdown, references, capabilities）。`ContextLoader` 类有 `loadSkillLayer` 方法吗？

需要检查 `contextLoader.ts` 是否有 loadSkillLayer 实现。如果没有，这是 Skill Context 注入的前置条件。

### 4. SKILL.md 注入路径不存在

从 `agentAdapter.ts:37-57` — `buildPromptInput` 只读取 `systemLayer.constraints` 和 `taskLayer.input.payload`。没有读取 `skillLayer.markdown`。这意味着即使 SkillLayer 被加载，其内容也不会出现在 prompt 中。

---

## Candidate Skill Analysis

### Candidate A: summarize（已有）

| 维度 | 评估 |
|------|------|
| 是否已存在 | ✅ 已有完整 builtin skill |
| 是否纯 LLM | ✅ 纯 `llm` capability |
| 是否单步 | ✅ 单次 LLM 调用 |
| 是否易滑向 Workflow | ✅ 不可能 |
| 是否复用现有 execution chain | ⚠️ 需要 SkillLayer→prompt 注入修复 |
| 是否需新增 capability | ❌ 不需要 |
| 是否需 SkillContext | ✅ SKILL.md 包含长度约束、格式要求 — 需要注入才能正确运行 |
| 是否需 Result Surface 扩展 | ❌ 不需要（纯 text 输出） |
| **P0 Ready?** | **❌ 依赖 Skill Context 注入管道** |

### Candidate B: translate（翻译）

| 维度 | 评估 |
|------|------|
| 是否纯 LLM | ✅ 纯 `llm` capability |
| 是否单步 | ✅ 单次 LLM 调用 |
| 是否易滑向 Workflow | ✅ 不可能 |
| 是否复用现有 execution chain | ⚠️ 同样需要 SkillContext 注入 |
| 是否需新增 capability | ❌ 不需要 |
| 是否需 SkillContext | ⚠️ 翻译是 LLM 天然能力，SKILL.md 更多是格式指导，非强依赖 |
| 是否需 Result Surface 扩展 | ❌ 不需要 |
| **P0 Ready?** | **⚠️ 依赖 Skill Context 注入，但对上下文质量不敏感** |

### Candidate C: echo/hello-world（玩具级）

| 维度 | 评估 |
|------|------|
| 是否纯 LLM | ✅ 甚至不需要 LLM |
| 是否单步 | ✅ |
| 是否易滑向 Workflow | ✅ 不可能 |
| 是否复用现有 execution chain | ✅ 最简单，但无实质验证价值 |
| 是否需新增 capability | ❌ 不需要 |
| 是否需 SkillContext | ❌ 不需要 |
| 是否需 Result Surface 扩展 | ❌ 不需要 |
| **P0 Ready?** | **✅ 技术上可行，但无架构验证价值** — 不推荐 |

### Candidate D: search（网络搜索）

| 维度 | 评估 |
|------|------|
| 是否纯 LLM | ❌ 需要网络请求 |
| 是否单步 | ⚠️ 搜索 + LLM 总结 = 两步 |
| 是否易滑向 Workflow | ⚠️ "搜索→总结" 是最简单的两步骤，但需要多步编排 |
| 是否复用现有 execution chain | ❌ 需要 Executor 支持 tool call |
| 是否需新增 capability | ✅ `network.http` — 当前不在 DEFAULT_ALLOWED_CAPABILITIES |
| 是否需 SkillContext | ⚠️ 需要搜索行为定义 |
| 是否需 Result Surface 扩展 | ⚠️ 搜索结果可能有结构化展示需求 |
| **P0 Ready?** | **❌ 依赖太多新基础设施** |

### Candidate E: explain_code（代码解释）

| 维度 | 评估 |
|------|------|
| 是否纯 LLM | ✅ 纯 `llm` capability |
| 是否单步 | ✅ 单次 LLM 调用 |
| 是否易滑向 Workflow | ✅ 不可能 |
| 是否复用现有 execution chain | ⚠️ 需要 SkillContext 注入（定义解释风格/格式） |
| 是否需新增 capability | ❌ 不需要 |
| 是否需 SkillContext | ⚠️ 中：规则可内嵌 user prompt，非强依赖 |
| 是否需 Result Surface 扩展 | ❌ 纯 text |
| **P0 Ready?** | **⚠️ 同 translate — 依赖 Skill Context 注入** |

---

## Key Architecture Findings

### Finding 1: Skill Context 注入是 P0 前置依赖

当前 `buildPromptInput` 不读取 `skill.markdown`。任何需要遵循特定指令（格式/约束/风格）的 Skill 都无法可靠执行。这是 **所有 Official Skill P0 的共同前置依赖**。

### Finding 2: Skill Context 注入的最小修改路径

```
tryExecuteSkill:
  1. parse @mention
  2. resolve SkillMeta
  3. capability check
  4. LOAD SKILL.md ← NEW
  5. CREATE Context with SkillLayer ← NEW
  6. inject SKILL.md into system prompt ← NEW
  7. executeChatTask
```

最小修改涉及：
- `skillBridge.ts`: 加载 SKILL.md，创建 Context
- `agentAdapter.ts`: `buildPromptInput` 读取 `skill.markdown` → 作为 system message
- `contextLoader.ts`: 可能需要 `loadSkillLayer` 方法

### Finding 3: Skill 执行不走 SkillTaskExecutor

当前 `tryExecuteSkill` 通过 `executeChatTask` 创建一个 `chat` 类型的执行（没有设置 task type = 'skill'）。这导致 `createContextAwareExecutor('skill')` 返回 `SkillTaskExecutor` 而 `createContextAwareExecutor('chat')` 返回 `ChatAgentExecutor`（真正的 LLM 执行器）。

实际上，skill 执行巧妙地绕过了 SkillTaskExecutor stub 而重用了 ChatAgentExecutor。但这个 bypass 不传递 skill context。

### Finding 4: Result Surface 和 Capability 短期内不需扩展

- 所有纯 LLM Skill 的 Result Surface 都是 text — 不需要扩展
- DEFAULT_ALLOWED_CAPABILITIES 已包含 ['llm', 'image_generation', 'filesystem.read'] — 纯 LLM 不需要新增

---

## Open Questions

1. **Skill Context 注入的最小修改路径是什么？** — 是修改 `buildPromptInput` 还是创建新的 skill-specific executor？
2. **summarize vs translate vs explain_code** — 哪一个能更好地验证架构而不引入不必要的复杂度？
3. **Skill Context 注入是放在 skillBridge 还是 RuntimeStore？** — 职责边界在哪里？
4. **第一个 Official Skill 的"成功标准"是什么？** — @mention 执行成功？SKILL.md 被遵循？用户获得价值？
