## TASK-SUM-001: summarize Official Skill 端到端链路验证

**Status**: ✅ 全部通过
**Date**: 2026-05-13
**Type**: validation

### 验证结果

| # | 标准 | 结果 | 证据 |
|---|------|------|------|
| C1 | skill.json 包含 "llm" capability | ✅ | `grep -c '"llm"' = 1` |
| C2 | SKILL.md 包含长度约束 | ✅ | `Target length: ≤ 30%` 存在 |
| C3 | SKILL.md 包含 [§N] 引用格式 | ✅ | `[§N]` notation 存在 |
| C4 | TypeScript 编译零错误 | ✅ | `npx tsc --noEmit` 退出码 0 |
| C5 | tryExecuteSkill 三态返回语义 | ✅ | `Promise<ChatMessage \| null \| undefined>` 在 skillBridge.ts:109 |
| C6 | buildPromptInput 读取 skill.markdown | ✅ | `skillLayer?.markdown` 在 agentAdapter.ts:44 |
| C7 | 非 @mention 返回 undefined | ✅ | `return undefined` 在 skillBridge.ts:112,117 |

### 注入链路追踪

```
@summarize <text>
  → skillBridge.ts:111  parseSkillInvocation(text) → { skillName, skillInput }
  → skillBridge.ts:116  resolveSkillByName → SkillMeta { source: 'official', capabilities: ['llm'] }
  → skillBridge.ts:120  checkSkillCapabilities(['llm']) → ✅ (DEFAULT_ALLOWED_CAPABILITIES)
  → skillBridge.ts:133  create Task { input: { text } }
  → skillBridge.ts:137  registerChatTask(task) → runtimeStore.registerContextForTask(task)
  → skillBridge.ts:144  SkillLoader(Resource).loadSkill('summarize', { loadMarkdown: true })
                        → skills/builtin/summarize/SKILL.md 读取成功
  → skillBridge.ts:149  runtime.loadSkillLayerForTask(taskId, skillPkg)
                        → runtime.ts:319  loader.loadSkillLayer(ctx, skillPkg)
                        → ctx.skill.markdown = SKILL.md 内容
  → skillBridge.ts:152  executeChatTask(taskId)
                        → runtime.ts:361  executeTask → ChatAgentExecutor
                        → agentAdapter.ts:113  buildPromptInput(context)
                          → system = SKILL.md + constraints
                          → user = "<text>"
                        → provider.execute({ system, user })
                        → LLM 输出遵循 SKILL.md 约束
```

### 管线状态确认

| 组件 | 文件 | 状态 |
|------|------|------|
| summarize skill.json | `skills/builtin/summarize/skill.json` | ✅ capabilities: ["llm"] |
| summarize SKILL.md | `skills/builtin/summarize/SKILL.md` | ✅ 4 条 WP + 4 条约束 + Quality Bar |
| SkillRegistry 发现 | `src/services/skillRegistry.ts` | ✅ 双 BaseDirectory，source='official' |
| SkillLoader 加载 markdown | `src/services/skillLoader.ts` | ✅ loadMarkdown=true 读取 SKILL.md |
| Capability Gate | `src/services/skillBridge.ts:38-46` | ✅ 使用 DEFAULT_ALLOWED_CAPABILITIES |
| Context 注册 | `src/stores/runtime.ts:77-96` | ✅ registerContextForTask |
| SkillLayer 注入 | `src/stores/runtime.ts:314-324` | ✅ loadSkillLayerForTask |
| Prompt assembly | `src/services/agentAdapter.ts:37-63` | ✅ buildPromptInput 合入 markdown |
| LLM 执行 | `src/services/agentAdapter.ts:112-135` | ✅ ChatAgentExecutor.executeWithContext |
| Task type | `src/services/skillBridge.ts:131` | ✅ type='chat'（不走 SkillTaskExecutor） |

### 红线检查

| 红线 | 检查结果 |
|------|---------|
| DAG | ✅ 无 — 单步 LLM |
| Workflow Engine | ✅ 无 |
| Node Graph | ✅ 无 |
| BPMN | ✅ 无 |
| Visual Builder | ✅ 无 |
| Auto Agent Planner | ✅ 无 |
| Multi-Agent | ✅ 无 |

### 约束检查

| 约束 | 检查结果 |
|------|---------|
| 不新增 skill | ✅ 使用现有 summarize |
| 不改 Runtime | ✅ 无 runtime.ts 修改 |
| 不改 skillBridge | ✅ 无 skillBridge.ts 修改 |
| 不改 SkillLoader | ✅ 无修改 |
| 不扩 TaskResult | ✅ task type 保持 chat |
| 不做 Result Surface | ✅ 无修改 |
| 不做 Workflow/Planner | ✅ 无 |
