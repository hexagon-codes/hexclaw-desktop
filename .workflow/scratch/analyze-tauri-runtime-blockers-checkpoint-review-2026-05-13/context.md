# Context: Tauri Runtime Blockers Checkpoint Review

**Date**: 2026-05-13
**Areas discussed**: Tauri FS 修复验证, systemPrompt 传递链验证, MODE:DIRECT 有效性, 剩余问题分类

---

## Decisions

### Decision 1: Tauri FS 使用 capability 系统
- **Context**: tauri-plugin-fs v2.5.1 弃用 plugins.fs.scope 格式
- **Options**:
  1. 降级 tauri-plugin-fs 到 v2.4.x
  2. 迁移到 capability fs:allow-read 系统
  3. plugins.fs.scope + requireLiteralLeadingDot
- **Chosen**: 迁移到 capability 系统
- **Reason**: 官方规范迁移路径，向前兼容

### Decision 2: Skill 模式使用真实 systemPrompt
- **Context**: message 嵌入 MODE:DIRECT 模型不遵守
- **Options**:
  1. 保持 message 嵌入（TEST 3 失败）
  2. systemPrompt 独立字段（TEST 2 + 4 成功）
- **Chosen**: systemPrompt 独立字段
- **Reason**: MODEL 接收真实 system_prompt 后正确遵守 MODE:DIRECT

### Decision 3: [§N]/摘要/self-narration 分类为 prompt engineering
- **Context**: 前次 UAT 报告将这些列为 P0 阻止项
- **Options**:
  1. 继续视为 Runtime Blockers
  2. 归类为独立维度
- **Chosen**: 归类为 prompt engineering
- **Reason**: 传输层已修复，模型行为是 prompt 内容问题非传输路径问题

---

## Constraints

### Locked
- Tauri FS 使用 capability 系统 — 不再使用 plugins.fs.scope
- Skill 模式使用真实 systemPrompt 独立字段 — 不嵌入 message 字符串
- Go backend system_prompt 接口契约已定义 — docs/system-prompt-contract.md
- 不新增 SkillTask / SkillExecutor / Workflow / Validator
- 不改 Runtime Constitution

### Free
- **Tauri 版本对齐**: 实施者可选择降级 @tauri-apps/api 或升级 tauri crate
  - 当前: `@tauri-apps/api v2.11.0` vs `tauri crate v2.10.3`
  - 建议: 升级 tauri crate (cargo update)，warning 消失即可
- **SKILL.md prompt 重设计**: 当前"摘要"指令被模型理解为"事实核查"而非"原文要点提取"
  - 需将 prompt 从"帮助用户进行摘要"改为"对以下原文直接提取关键点"
  - 删除"步骤建议"等 planning 语言
- **[§N] 格式替代**: 如模型不支持 § 字符
  - 备选: `[N]` / `[要点N]` / `**要点**`
  - 建议: 先 test 模型是否输出 §，如否再选替代

### Deferred
- **Go backend system_prompt 实现**: docs/system-prompt-contract.md 已定义接口契约
  - 外部仓库待处理，当前兼容方案（providerAdapter 过滤 system role）可维持
- **自动 UAT 设施**: 当前 UAT 依赖手动 `tauri dev` + curl
  - 建议: tauri-webdriver 或 Tauri test harness
- **多模型兼容测试**: 当前仅覆盖 mimo-v2.5 (Anthropic)
  - 风险: 其他 provider 对 system_prompt 的语义理解可能不同

## Code Context

- `src-tauri/tauri.conf.json` — plugins.fs 已删除
- `src-tauri/capabilities/default.json` — fs:allow-read/exists/write-text-file
- `src/services/agentAdapter.ts:135-144` — executeWithContext skill 模式 systemPrompt 传递
- `src/services/providerAdapter.ts:75-77` — systemPrompt truthy 时过滤 system role
- `docs/system-prompt-contract.md` — Go backend 接口契约
