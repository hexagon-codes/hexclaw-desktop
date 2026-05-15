# Runtime-Native 二次开发路线图

> 日期：2026-05-14

---

## P0 必修

### Module 001: Skill Directory Alignment

**目标**: 修复 Skill Registry 目录结构不匹配，使 @summarize/@bulletize 能真正执行

**影响文件**: `skills/` 目录结构（0 行代码改动）

**风险**: 低

**验收标准**:
1. `SkillRegistry.getAllSkills()` 返回 summarize + bulletize
2. `@summarize` 命中 skill 执行路径
3. `@bulletize` 命中 skill 执行路径
4. TaskBadge 显示 skill name + status

**回滚**: 移回 `skills/builtin/`

---

### Module 002: Chat-Task Bridge UAT

**目标**: 在 Tauri Desktop 环境中验证 TaskBadge 端到端工作

**影响文件**: 无代码改动（验证性）

**风险**: 无

**验收标准**:
1. @summarize → 消息 + TaskBadge
2. @bulletize → 消息 + TaskBadge
3. 普通 chat → 无 badge
4. 点击 TaskBadge → /workspace?taskId=xxx

**回滚**: N/A

---

## P1 产品化

### Module 003: Result Surface

**目标**: Skill 执行结果有独立渲染，不只是消息气泡

**影响文件**: `ChatView.vue`、新组件 `SkillResultCard.vue`

**风险**: 低

**验收标准**:
1. Skill 结果以卡片形式渲染
2. 显示 skill name、版本、SKILL.md 摘要
3. 普通 chat 不受影响

**回滚**: 移除 SkillResultCard，恢复消息气泡渲染

---

### Module 004: Workspace Task Detail

**目标**: Workspace 中查看完整 task context（skill markdown、execution details）

**影响文件**: `ContextDetailPanel.vue`

**风险**: 低

**验收标准**:
1. Skill section 显示 SKILL.md 内容
2. Execution section 显示完整步骤
3. Result section 显示资产列表

**回滚**: 恢复 ContextDetailPanel 原始版本

---

### Module 005: Runtime LLM Contract

**目标**: 提取 MODE:DIRECT 为独立模块，形成 LLM Contract v0.1

**影响文件**: 新增 `llmContract.ts`、修改 `agentAdapter.ts`

**风险**: 低

**验收标准**:
1. tsc 通过
2. normal chat 无 MODE:DIRECT
3. @summarize 有 MODE:DIRECT
4. buildPromptInput 行为等价

**回滚**: 恢复 agentAdapter.ts 原始版本，删除 llmContract.ts

---

### Module 006: execMode Convergence

**目标**: 移除 execMode toggle，锁定 Runtime 路径

**影响文件**: `chat-send-controller.ts`、`settings.ts`

**风险**: 中（影响所有 chat 发送路径）

**验收标准**:
1. 无 execMode toggle
2. 所有 chat 使用 Runtime 路径
3. WS 路径代码移除

**回滚**: 恢复 execMode toggle

---

## P2 清理

| 项 | 说明 | 影响 |
|----|------|------|
| createExecutor() 死代码 | 仅 createContextAwareExecutor 在使用 | taskExecutor.ts |
| SkillTaskExecutor 桩 | 死代码遗留 | taskExecutor.ts |
| Capability check dedup | skillBridge + runtimeServices 两处 | skillBridge.ts, runtimeServices.ts |
| WS Task lifecycle 复用 | runtimeBridge 路径对齐 | runtimeBridge.ts |
| MODE:DIRECT formalization | 从 agentAdapter.ts 提取为正式模块 | agentAdapter.ts, llmContract.ts |

---

## Deferred

| 项 | 说明 | 阻塞原因 |
|----|------|----------|
| TaskResult type hardening | 类型加固 | 当前够用 |
| WS/RT D2 reasoning bridge | reasoning 桥接 | 等 executor 产出 |
| Skill Flow Param Card UI | 参数卡片 | P1 |
| Skill Flow NL trigger | 自然语言触发 | P2 |
| Asset Gallery | 资产展示 | P3 |
| Dashboard Runtime 数据 | Dashboard 接入 | P3 |
| MemoryLayer 可视化 | 执行记忆展示 | P3 |
