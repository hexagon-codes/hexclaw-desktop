# Context: Skill Execution Mode Boundary

**Date**: 2026-05-13
**Areas discussed**: system_prompt 传递链修复, execution mode 约束

## Decisions

### Decision 1: 修复 system_prompt 传递链
- **Context**: `BackendChatParams` 无 `system_prompt` 字段，SKILL.md 嵌入 `message: "system: content\nuser: input"` 发送，Go backend 无法区分独立系统指令
- **Options**:
  1. 仅修复 Rust 侧（新增字段 + 转发）
  2. 修复 Rust 侧 + TS 侧传递 systemPrompt
- **Chosen**: 选项 2 — 两端修复
- **Reason**: TS 侧 `ChatAgentExecutor.executeWithContext` 也未传递 `systemPrompt`，仅修 Rust 侧无法通信

### Decision 2: Execution mode 注入方式
- **Context**: LLM 默认 agentic behavior 导致长输入 plan-then-execute，需要约束
- **Options**:
  1. SKILL.md 内增加规则（已存在但无效，因 system_prompt 丢失）
  2. `buildPromptInput` 注入 `[MODE: DIRECT]` 前缀
  3. 新增 `SkillTaskExecutor`（用户禁止）
  4. 新增 `mode` 字段到 Runtime types（过度设计）
- **Chosen**: 选项 2
- **Reason**: 5 行代码，零架构风险，system_prompt 修复后权威性有保障

### Decision 3: 不新增 SkillTaskExecutor
- **Context**: `SkillTaskExecutor` 已定义但未使用。是否启用？
- **Options**:
  1. 启用 SkillTaskExecutor（需修改 skillBridge.ts task type）
  2. 保持 ChatAgentExecutor + prompt 差异
- **Chosen**: 选项 2
- **Reason**: 用户明确禁止。prompt 层差异已足够实现 Skill ≠ Agent Loop

## Constraints

### Locked
1. **不新增 SkillTaskExecutor** — 技能执行继续使用 `ChatAgentExecutor`
2. **不修改 Runtime Constitution** — 不改 `executeTask` 生命周期
3. **不新增 tool loop / planner / multi-pass** — skill 执行保持线性

### Free
1. **Execution mode prefix 措辞** — 实现者可调整 `[MODE: DIRECT]` 文案
2. **Rust 字段命名** — `system_prompt` 或 `systemPrompt`，与 TS 侧一致即可
3. **UAT 指标阈值** — [§N] > 0, ratio ≤ 30%, retention ≥ 90%

### Deferred
1. **Inference params (temperature, top_p) 一体化** — 当前 scheme B 不涉及，后续可扩展
2. **SkillExecutionProfile** — 若后续需更多 skill 级配置，可引入 profile 概念
3. **Go backend system_prompt cache key** — 当前 system_prompt 未参与缓存键计算，属于 Go 后端内部优化，不阻塞

## Code Context

```
Modified files:
  src-tauri/src/commands.rs          + system_prompt field + POST forward
  src/services/agentAdapter.ts       + mode prefix in buildPromptInput + systemPrompt in executeWithContext

Verified:
  Go backend POST /api/v1/chat accepts system_prompt field ✅
  providerAdapter.ts already forwards systemPrompt ✅
  backendLLMClient.ts already passes system_prompt to invoke ✅
```
