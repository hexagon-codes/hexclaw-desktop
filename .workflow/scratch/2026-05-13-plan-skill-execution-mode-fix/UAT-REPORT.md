# Tauri Runtime Manual UAT 报告

**日期**: 2026-05-13
**计划**: `2026-05-13-plan-skill-execution-mode-fix` (Scheme B)
**状态**: ❌ 未达到 skill-runtime-p0-usable

---

## 执行摘要

3 项核心验证全部失败。阻止 skill-runtime-p0-usable 的关键障碍是 **Tauri 应用启动失败**（`plugins.fs.scope` schema 不兼容），导致所有 Runtime 路径无法端到端验证。已完成的修复代码通过类型检查和单元测试，但在实际 Tauri webview 中不可执行。

---

## 10 项验证点结果

### 1. SkillRegistry 扫描 — ❌ 阻止

| 项目 | 结果 |
|------|------|
| Tauri webview 中 SkillRegistry 能否扫描 skills 目录 | **无法验证** |
| 原因 | Tauri app 启动失败：`plugins.fs.scope` schema 不兼容 |
| 根因 | `tauri-plugin-fs` v2.5.1 要求 `requireLiteralLeadingDot` 字段，但 `tauri.conf.json` 使用旧版 `scope` 格式 |
| 影响 | 所有依赖 `@tauri-apps/plugin-fs` 的功能全部阻塞 |

**证据**:
```
failed to initialize plugin 'fs': Error deserializing 'plugins.fs'... unknown field 'scope'
```

---

### 2. SkillLoader 加载 — ❌ 阻止

| 项目 | 结果 |
|------|------|
| SkillLoader 能否从文件系统加载 SKILL.md | **无法验证** |
| 原因 | 同 #1：`invoke('plugin:fs|read_text_file', ...)` 要求 Tauri IPC 可用 |

**浏览器模式验证** (作为间接证据):
- 浏览器中 `tryExecuteSkill` 返回 `undefined`（`invoke` 抛异常 → catch → fallthrough）
- 确认：SkillRegistry 在无 Tauri IPC 时返回空 registry

---

### 3. commands.rs system_prompt transport — ✅ 代码层面确认

| 项目 | 结果 |
|------|------|
| `BackendChatParams.system_prompt` 字段 | **已添加 ✅** |
| POST body 转发逻辑 | **已实现 ✅** |
| Rust 编译 | `cargo build` 通过（4 warnings, 无关） |

**代码锚点**:
- `src-tauri/src/commands.rs:307` — `pub system_prompt: Option<String>`
- `src-tauri/src/commands.rs:336-341` — 条件转发 block

**结论**: 代码修复正确，但端到端验证被 Tauri 启动阻塞。

---

### 4. Go backend 接收 system_prompt — ⚠️ 单元验证

| 项目 | 结果 |
|------|------|
| Go backend POST body 包含 system_prompt | **逻辑上成立**（代码链完整） |
| POST /api/v1/chat 处理 system_prompt | **已知 bug：前置拼接** |
| system_prompt 与 message 内容去重 | ✅ providerAdapter.ts 已过滤重复 |

**关键发现**: Go backend 的 system_prompt 处理方式导致 skill 路径无法使用 systemPrompt 独立字段：
- Go backend 将 system_prompt **前置拼接**到 system messages
- 修复代码（providerAdapter.ts）因此在 skill 模式下选择**不传 systemPrompt**，改为全部嵌入 message 字符串
- 但 TEST 3 证明：嵌入 message 字符串的模式对此模型无效

---

### 5. Model 行为 — ❌ 不符合预期

| 测试 | payload 类型 | system_prompt | 结果 |
|------|-------------|--------------|------|
| TEST 1 | 旧路径（纯消息） | 无 | 返回 SKILL.md + 计划模板 ❌ |
| TEST 2 | 显式 system_prompt | ✅ `[MODE: DIRECT]` | 无 SKILL.md ✅, 无 planning ✅, 无 [§N] ⚠️ |
| TEST 3 | 实际 skill 路径 payload（无 system_prompt） | ❌ 嵌入 message | 输出 SKILL.md 内容 ❌, planning ❌, 长度 786.7% ❌ |

**TEST 3 详细输出**:
```
[§N] count: 0
Contains planning: YES ❌ (输出包含"步骤建议" + 编号列表)
Contains tool-call: YES ❌ (包含"工具链"引用)
Contains self-narration: NO ✅
Length ratio: 786.7% ❌
```

**根因**: `mimo-v2.5` / Anthropic 模型将 message 字符串中的 `system:` 前缀视为普通文本内容，而非权威指令。SKILL.md 内容在 message 中被模型理解为"要输出的内容"而非"行为约束"。

---

### 6. [MODE: DIRECT] 有效性 — ❌ 条件性失败

| 条件 | 有效？ | 说明 |
|------|--------|------|
| 作为独立 `system_prompt` 字段发送 (TEST 2) | ✅ | 无 planning, 无工具调用 |
| 作为 message 字符串 `system:` 前缀嵌入 (TEST 3) | ❌ | 模型完全忽略 |

**结论**: `[MODE: DIRECT]` 在作为真实 `system_prompt` 参数时有效，但当前 skill 路径架构将其嵌入 message 字符串，导致实效。

---

### 7. [§N] 格式命中率 — ❌ 0%

| 测试 | [§N] count | 说明 |
|------|-----------|------|
| TEST 2 | 0 | 模型输出通用摘要，非结构化 [§N] 格式 |
| TEST 3 | 0 | 模型输出 SKILL.md 原文，完全未做摘要 |

**根因分析**:
1. `mimo-v2.5` 可能不具备输出 `§` 字符的能力（需要模型层测试确认）
2. 即使具备，prompt 中的指令也被 message 嵌入模式削弱
3. SKILL.md 的"摘要"模式被模型理解为"输出 SKILL.md 内容"而非"用 [§N] 格式摘要用户输入"

---

### 8. 长度比例 ≤ 30% — ❌ 786.7% (TEST 3)

| 测试 | 输入长度 | 输出长度 | 比例 | 结果 |
|------|---------|---------|------|------|
| TEST 2 | 45字 | 407字 | 904% | ❌ |
| TEST 3 | 45字 | 354字 | 786.7% | ❌ |

输出远大于输入，因为模型输出了 SKILL.md 原文而非输入摘要。

---

### 9. 非 Skill Chat 不受影响 — ✅ 确认

| 项目 | 结果 |
|------|------|
| 普通 chat 路径代码是否被修改 | ❌ 未修改 |
| `buildPromptInput` 非 skill 分支 | ✅ 保持原逻辑 |
| `executeWithContext` 非 skill 分支 | ✅ 保持原逻辑 |
| `providerAdapter.ts` systemPrompt 去重 | ✅ 仅当 `payload.systemPrompt` 为 truthy 时触发 |

**结论**: 所有改动仅在 `skillLayer.markdown` 存在时触发，非 skill chat 路径完全不受影响。

---

### 10. 综合判断：skill-runtime-p0-usable — ❌ 未达到

| 维度 | 状态 | 说明 |
|------|------|------|
| 代码修复 | ✅ | TASK-001 + TASK-002 代码正确，类型检查通过 |
| 架构设计 | ⚠️ | Skill 路径无系统级 systemPrompt 传递 → 依赖 message 嵌入 → 模型不遵守 |
| Tauri 可启动 | ❌ | `plugins.fs.scope` schema 不兼容，阻塞所有 Runtime 测试 |
| [MODE:DIRECT] | ❌ | 无真实 system_prompt 时无效 |
| [§N] 格式 | ❌ | 0% 命中率 |
| 长度比例 | ❌ | 786.7% |
| 非 skill 路径 | ✅ | 无影响 |

---

## 阻止项总结

### P0 阻止 (必须修复)

1. **Tauri 启动修复**: `tauri.conf.json` 的 `plugins.fs.scope` → `requireLiteralLeadingDot` 格式迁移
   - 影响: 阻塞所有 Tauri webview 测试
   - 文件: `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`
   - 优先级: **最高**

2. **Go backend system_prompt 处理**: 当前前置拼接导致 skill 路径无法使用独立 systemPrompt
   - 影响: 修复代码被迫选择 message 嵌入方案（模型不遵守）
   - 方案: Go backend 改为不自动拼接 system_prompt，由前端控制完整 message list
   - 优先级: **高**

### P1 优化 (重要但非阻塞)

3. **SKILL.md prompt 设计**: 当前 SKILL.md 使用"建议/步骤"等指令语言，与 [MODE: DIRECT] 矛盾。需重写为"直接输出，不列步骤"
   - 影响: 即使 MODE:DIRECT 生效，SKILL.md 内容也会引导模型输出步骤
   - 文件: `skills/builtin/summarize/SKILL.md`

4. **mimo-v2.5 § 字符支持**: 需确认模型是否支持输出 `§` 字符，如不支持需改用 `[N]` 或 `[要点N]` 等替代格式

### P2 低优先级

5. **summarize 内置 tool 冲突**: Go backend 中的内置 summarize tool 与 SKILL.md 关键词冲突，prompt 净化（summarize→摘要）可缓解但非根治

---

## 数据流图 (当前实际路径 vs 预期路径)

```
预期 Runtime 路径 (blocked):
  @summarize → SkillRegistry(FS) → executeWithContext → [MODE:DIRECT] + SKILL.md
    → backendLLMClient.send({ system_prompt, request_id })
    → commands.rs system_prompt → Go backend → LLM → [§N] ✅

实际测试路径:
  TEST 2: Go backend POST { message, system_prompt: "[MODE:DIRECT]" } → LLM
          → 无 SKILL.md ✅, 无 planning ✅, 无 [§N] ⚠️

  TEST 3: Go backend POST { message: "system: [MODE:DIRECT]\nSKILL.md\n\nuser: 输入" }
          → LLM → 输出 SKILL.md 原文 ❌

浏览器 fallthrough 路径 (UAT-tiny):
  @summarize → SkillRegistry(FS: 不可用) → undefined → WebSocket → Go backend
          → LLM → 输出 SKILL.md + 计划模板 ❌
```

---

## 关于 skill-runtime-p0-usable 的结论

**当前状态: ❌ 不可用**

必要条件达成情况:
| 条件 | 状态 | 备注 |
|------|------|------|
| Tauri 应用可启动 | ❌ | plugins.fs scope schema |
| @summarize 命中 Runtime 路径 | ❌ | 浏览器 fallthrough, Tauri 不可启动 |
| system_prompt 传递 | ✅ | 代码正确, 端到端被 Tauri 启动阻塞 |
| [MODE:DIRECT] 被遵守 | ❌ | 仅在真实 system_prompt 时有效 |
| [§N] 结构化摘要 | ❌ | 0% 命中率 |
| 非 skill 不受影响 | ✅ | |

**最短修复路径**（2 个必须修复 + 1 个设计调整）:
1. 修复 `plugins.fs` schema → Tauri 可启动 → UAT 可执行
2. 修复 Go backend system_prompt 处理 → skill 路径可使用真实 systemPrompt
3. 调整 agentAdapter.ts: skill 模式使用 `systemPrompt` 独立字段 + message 中移除 SKILL.md 内容 → model 同时接收权威 system_prompt + MODE:DIRECT

预计修复后再次验证需: ~1 小时（含 cargo build + Go rebuild + UAT）
