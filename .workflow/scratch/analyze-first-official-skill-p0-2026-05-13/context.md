# First Official Skill P0 — Decision Context

**Session**: ANL-first-official-skill-p0-2026-05-13
**Date**: 2026-05-13

## Decisions

### Decision 1: Skill = summarize
- **Context**: 唯一已存在的 builtin skill，纯 LLM capability，不可能滑向 Workflow
- **Options**:
  1. **summarize** ✅ — 已有完整 skill.json + SKILL.md + references；纯单步 LLM；零红线风险
  2. translate — 无现有 skill 文件；LLM 天然理解无需注入，无法验证管道正确性
  3. echo/hello-world — 无架构验证价值
  4. search — 需要 network.http capability + 多步编排，P1 起步
- **Chosen**: summarize
- **Reason**: 最轻量验证全链路（Registry → Loader → Context → Executor），且已有完整 builtin 文件

### Decision 2: 先修管道（~38 行），再跑 skill
- **Context**: 当前 `tryExecuteSkill` 不加载 SKILL.md，不注册 Context，不注入 SkillLayer。三个断裂点需修复
- **Options**:
  1. **先修管道** ✅ — 3 文件修改 ~38 行，然后 summarize 端到端验证
  2. 只修管道不跑 skill — 缺最终集成验证
  3. 选 translate 绕过管道修复 — 无法验证 Context 注入
- **Chosen**: 先修管道再跑 summarize
- **Reason**: 管道通用，修一次所有 Official Skill 受益；summarize 端到端验证

### Decision 3: 保持 task type = chat，不走 SkillTaskExecutor
- **Context**: `SkillTaskExecutor` 是 stub（返回 null）。`ChatAgentExecutor` 是真实 LLM executor
- **Options**:
  1. **type = chat + skill context** ✅ — 最小修改，复用 ChatAgentExecutor，buildPromptInput 补读 skill.markdown
  2. type = skill + 实现 SkillTaskExecutor — 更多修改，当前无必要
- **Chosen**: chat type + skill context
- **Reason**: 当前 ChatAgentExecutor 满足所有需求，SkillTaskExecutor 真实实现可 defer

### Decision 4: 不加载 references/，不扩展 Result Surface，不新增 capability
- **Context**: summarize 的 references/ 包含 example-input.md、example-output.md、style-guide.md
- **Chosen**: P0 只加载 SKILL.md，不加载 reference 文件
- **Reason**: references 是加分项不是必须项；SKILL.md 本身已包含足够的行为定义

## Constraints

### Locked
- **L1**: summarize 是第一个 Official Skill
- **L2**: Skill Context 注入管道必须先修（3 文件 ~38 行）
- **L3**: task type 保持 chat，不走 SkillTaskExecutor
- **L4**: P0 只加载 SKILL.md，不加载 references/
- **L5**: 不新增 capability（summarize 只需要 llm）
- **L6**: 不扩展 Result Surface
- **L7**: 7 条红线适用：禁止 DAG/Workflow Engine/Node Graph/BPMN/Visual Builder/Auto Agent Planner/Multi-Agent

### Free
- **F1**: 具体 prompt 注入位置 — 可选择 skill.markdown 作为 system message 或 user message 前缀
- **F2**: runtime.ts 新方法命名 — `loadSkillLayerForTask` 或 `injectSkillLayer`
- **F3**: SKILL.md 内容可微调 — 确认长度、格式约束

### Deferred
- **D1**: references/ 目录加载 — 后续 P 版本
- **D2**: SkillTaskExecutor 真实实现 — 后续 P 版本
- **D3**: Result Surface 扩展 — 有非 text Skill 时
- **D4**: 新增 capability — 有需要联网/文件的 Skill 时
- **D5**: MentionPopup source 展示 — UI 需要时
- **D6**: Skill 组合/编排 — 永不

## Code Context

### 现有基础设施（全部就绪）

| 组件 | 文件 | 状态 |
|------|------|------|
| SkillRegistry | `skillRegistry.ts:21-146` | ✅ 双 BaseDirectory |
| SkillLoader | `skillLoader.ts:62-134` | ✅ 可加载 SKILL.md |
| ContextLoader.loadSkillLayer | `contextLoader.ts:144-158` | ✅ 完整实现 |
| ChatAgentExecutor | `agentAdapter.ts:71-138` | ✅ 真实 LLM executor |
| summarize skill | `skills/builtin/summarize/` | ✅ skill.json + SKILL.md |
| Capability Gate | `skillBridge.ts:38-46` | ✅ llm 在默认白名单 |

### 需要连接的断裂点

```
tryExecuteSkill (skillBridge.ts): 加载 SKILL.md → 创建 Task → 注册 Context
    ↓
RuntimeStore.loadSkillLayerForTask (runtime.ts): 注入 SkillLayer
    ↓
buildPromptInput (agentAdapter.ts): 读取 skill.markdown → 作为 system message
    ↓
ChatAgentExecutor.executeWithContext: LLM 调用携带 skill context
```
