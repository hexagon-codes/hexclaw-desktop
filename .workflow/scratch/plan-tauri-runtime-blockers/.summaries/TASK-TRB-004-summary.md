# Desktop UAT 报告 — Tauri Runtime Blockers 修复

**日期**: 2026-05-13
**计划**: `plan-tauri-runtime-blockers` (Wave 1: TRB-001/002/003 ✅, Wave 2: TRB-004)

---

## 验证点 1: Tauri app 是否能启动

| 项目 | 状态 |
|------|------|
| Tauri app 编译 | ✅ `cargo build` 通过 |
| Tauri app 启动 | ✅ `tauri dev` 启动成功 |
| `plugins.fs` 初始化错误 | ❌→✅ **已修复**（不再报 `unknown field 'scope'`） |
| Tauri 版本警告 | ⚠️ `tauri v2.10.3` vs `@tauri-apps/api v2.11.0`（非阻塞） |
| sidecar 启动 | ⚠️ 端口 16060 已被其他 hexclaw 进程占用（已有一个实例运行，非阻塞） |

**结论**: Tauri FS schema 修复成功。app 可启动。

---

## 验证点 2: SkillRegistry 是否能读 RESOURCE/skills

| 项目 | 状态 |
|------|------|
| FS capability 配置 | ✅ capabilities/default.json 已添加 `fs:allow-read` + `$RESOURCE/skills/**` |
| 端到端验证 | ❌ 未能在 tauri dev headless 环境触发 @summarize |

**说明**: Tauri app GUI 窗口在 bash headless 环境不可交互，无法手动输入 @summarize。需真实桌面环境测试。

**间接证据**:
- 前次 UAT 证明浏览器模式（无 Tauri IPC）→ `tryExecuteSkill` 返回 `undefined`
- FS capability 修复后，`invoke('plugin:fs|read_text_file', ...)` 应不再抛异常
- 认为: ⚠️ 大概率已修复，需桌面环境确认

---

## 验证点 3: @summarize 是否命中 Runtime path

| 测试 | payload 格式 | system_prompt | 结果 |
|------|-------------|--------------|------|
| TEST 1 (旧) | 纯 message | 无 | SKILL.md + planning ❌ |
| TEST 2 | message + systemPrompt | ✅ `[MODE:DIRECT]` | 无 SKILL.md ✅, 无 planning ✅, 无 [§N] ⚠️ |
| TEST 3 (修复前) | message 嵌入 | ❌ 无 | SKILL.md + planning ❌ |
| **TEST 4 (修复后)** | **message + systemPrompt** | **✅ `[MODE:DIRECT]` + SKILL.md** | **无 SKILL.md ✅, 无 planning ✅, 无 tool-call ✅** |

**TEST 4 详细结果**:
```
[§N] count: 0
Contains planning: NO ✅
Contains tool-call: NO ✅ 
Contains self-narration: YES ⚠️ ("我需要坦诚地说")
Contains SKILL.md content: NO ✅
Entity retention: 3/4 (华为✅, 12亿✅, 任正非✅, 鸿蒙❌)
Length ratio: 735.6%
```

---

## 验证点 4: systemPrompt 是否进入请求链

| 链路节点 | 状态 | 说明 |
|---------|------|------|
| agentAdapter.executeWithContext | ✅ | 传递 `systemPrompt: prompt.system` |
| providerAdapter.ts | ✅ | systemPrompt truthy → 过滤 system role |
| backendLLMClient.ts | ✅ | `system_prompt` 映射 + `request_id` |
| commands.rs | ✅ | `BackendChatParams.system_prompt` + POST body |
| Go backend POST body | ✅ | 收到 `system_prompt` 字段 |
| LLM 响应 | ✅ | 模型遵守 MODE:DIRECT（无 planning/tool-call） |

**结论**: systemPrompt 传递链完整修复 ✅

---

## 验证点 5: 模型是否停止 planning/tool-call 幻觉

| 测试 | planning | tool-call | SKILL.md 内容 | self-narration |
|------|---------|-----------|---------------|----------------|
| TEST 1 (旧路径) | ❌ | ❌ | ❌ | ❌ |
| TEST 2 (systemPrompt) | ✅ | ✅ | ✅ | ⚠️ |
| TEST 3 (message 嵌入) | ❌ | ❌ | ❌ | ❌ |
| **TEST 4 (修复后)** | **✅** | **✅** | **✅** | **⚠️** |

**结论**: MODE:DIRECT 作为真实 systemPrompt 有效抑制了 planning 和 tool-call 幻觉 ✅。但模型仍产生 self-narration（"我需要坦诚地说"）。

---

## 关键发现: Go backend system_prompt 处理

TEST 4 的请求中同时发送了 `system_prompt` 和 `message`（仅 user role）。
Go backend 将 `system_prompt` 前置拼接为 system message，最终 LLM 收到的消息结构为：

```
system: [MODE: DIRECT]\nOutput directly.\n# 摘要\n...
user: 2025年华为HDC...
```

**Go backend 行为验证**:
- **前置拼接逻辑仍然生效** — system_prompt 被拼入 messages 数组
- 但由于 providerAdapter 已过滤 system role，message 字符串不含重复
- 此行为是 **兼容的** — 最终 LLM 输入正确
- **Go backend 契约已定义**（`docs/system-prompt-contract.md`），但实现未改

---

## 阻止项: [§N] 格式与摘要行为

| 问题 | 表现 | 根因分析 |
|------|------|---------|
| [§N] 格式 | 0% 命中率 | 模型可能不支持 § 字符，或 prompt 未足够强调格式 |
| 非摘要行为 | 模型做事实核查而非摘要 | SKILL.md 的"摘要"指令被模型理解为"验证内容真实性"而非"提取原文要点" |
| 长度比例 | 735.6% | 模型输出大量 disclaimer + 分析 |
| Self-narration | "我需要坦诚地说" | 模型默认行为，MODE:DIRECT 不足以抑制 |

**这些不是 transport/链路问题，而是 prompt engineering 问题**，不属于本次修复范围。

---

## 综合状态

### ✅ 已修复 (Runtime Blockers)

| 组件 | 状态 | 改动 |
|------|------|------|
| Tauri FS plugin | ✅ | plugins.fs.scope → capability fs:allow-read |
| systemPrompt 传递链 | ✅ | agentAdapter → providerAdapter → backendLLMClient → commands.rs → Go backend |
| MODE:DIRECT 有效性 | ✅ | 作为真实 systemPrompt 时生效 |
| 非 skill chat | ✅ | 未受影响 |

### ⚠️ 未修复 (外部仓库 / 非本次范围)

| 组件 | 状态 | 说明 |
|------|------|------|
| Go backend system_prompt 处理 | 📄 契约已定义 | `docs/system-prompt-contract.md` — 待外部仓库实施 |
| [§N] 格式 | ❌ prompt 工程问题 | 需 SKILL.md prompt 重新设计 |
| 模型摘要行为 | ❌ prompt 工程问题 | 模型应理解"对以下文本做摘要"而非"验证以下声明真实性" |
| Self-narration | ⚠️ | 需更严格的 MODE 指令 |

### 最终判断: skill-runtime-p0-usable

| 条件 | 状态 | 说明 |
|------|------|------|
| Tauri app 可启动 | ✅ | plugins.fs 错误已修复 |
| system_prompt 传递链完整 | ✅ | 全链路验证通过 |
| skill 命中 Runtime 路径 | ⚠️ | 需真实桌面 GUI 确认 |
| MODE:DIRECT 被遵守 | ✅ | 无 planning, 无 tool-call |
| [§N] 结构摘要 | ❌ | prompt 工程问题，非传输层问题 |
| 长度比例达标 | ❌ | prompt 工程问题 |

**结论**: **Runtime transport layer 已修复**。产出质量受 prompt engineering 限制，为不同维度问题。
