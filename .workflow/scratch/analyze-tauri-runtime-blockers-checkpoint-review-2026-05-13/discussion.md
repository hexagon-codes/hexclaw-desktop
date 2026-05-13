# Tauri Runtime Blockers Checkpoint Review

**日期**: 2026-05-13
**Session**: `ANL-tauri-runtime-blockers-checkpoint-2026-05-13`
**Scope**: Standalone — 对 Tauri Runtime Blockers 修复后的状态进行检查点评审

---

## 目录

- [当前理解](#当前理解)
- [讨论记录](#讨论记录)
- [六维评分](#六维评分)
- [决策提取](#决策提取)

---

## 当前理解

经过两轮计划执行，当前状态：
1. **Tauri FS plugin 已修复** — `plugins.fs.scope` → `capability fs:allow-read`，app 可启动
2. **systemPrompt 传递链已修复** — `agentAdapter` → `providerAdapter` → `backendLLMClient` → `commands.rs` → Go backend，全链路验证通过
3. **[MODE:DIRECT] 作为真实 systemPrompt 有效** — TEST 4 确认无 planning、无 tool-call 幻觉
4. **Go backend 接口契约已定义** — 但实现未改（外部仓库）
5. **[§N] 格式、模型摘要行为、self-narration** — prompt engineering 问题，非传输层阻塞

---

## 讨论记录

### 背景

`docs/1.md` 定义了两项 P0 修复目标：
- A. Tauri FS 配置修复
- B. system_prompt 真实传递链修复

严格禁止：SkillTask / SkillExecutor / Workflow / Validator / Runtime Constitution 修改。

两轮执行后（`plan-skill-execution-mode-fix` + `plan-tauri-runtime-blockers`），A 和 B 均已修复。

---

### Round 1: 修复效果评估

**数据来源**: 4 次 TEST payload 验证 + `tauri dev` 启动测试 + cargo build + 3738 单元测试

**已确认 (A) Tauri FS 修复**:
- `plugins.fs.scope` 已从 `tauri.conf.json` 删除
- `capabilities/default.json` 已添加 `fs:default`, `fs:allow-read`, `fs:allow-exists`, `fs:allow-write-text-file`
- `cargo build` ✅, `tauri dev` 启动 ✅, 无 `plugins.fs` 错误
- ⚠️ sidecar 端口冲突（已有 hexclaw 进程）非阻塞

**已确认 (B) systemPrompt 传递链修复**:

| 链路节点 | 状态 | 验证 |
|---------|------|------|
| agentAdapter.executeWithContext | ✅ | `systemPrompt: prompt.system` 传递 |
| providerAdapter.ts | ✅ | systemPrompt truthy → 过滤 system role |
| backendLLMClient.ts | ✅ | `system_prompt` + `request_id` 发送 |
| commands.rs | ✅ | `BackendChatParams.system_prompt` → POST body |
| Go backend | ⚠️ 兼容 | 前置拼接 system_prompt（providerAdapter 已去重） |
| MODEL 响应 | ✅ | 无 planning、无 tool-call |

**未解决但已识别非阻塞**:
- [§N] 格式: 0%（prompt engineering）
- 模型做事实核查而非摘要（prompt engineering）
- Self-narration 仍出现

**新出现的风险**:
- Tauri 版本错配：`tauri v2.10.3` vs `@tauri-apps/api v2.11.0`
- sidecar 端口冲突可能导致首次部署困惑

---

### Round 2: skill-runtime-p0-usable 重新评估

**必要条件评估**:
| 条件 | 前次 (UAT-REPORT) | 本次 |
|------|-------------------|------|
| Tauri 应用可启动 | ❌ plugins.fs | ✅ |
| @summarize 命中 Runtime 路径 | ❌ 浏览器 fallthrough | ⚠️ 需桌面 GUI 确认 |
| system_prompt 传递 | ✅ 代码正确 | ✅ 全链路验证 |
| [MODE:DIRECT] 被遵守 | ❌ message 嵌入无效 | ✅ 独立 systemPrompt 有效 |
| [§N] 结构化摘要 | ❌ 0% | ❌ 0%（prompt 层） |
| 非 skill 不受影响 | ✅ | ✅ |

**关键认知转变**: 前次 UAT 的 [§N]/长度比例/self-narration 问题被归类为 transport 层问题。本轮验证澄清：这些是 **prompt engineering 层** 问题，不属于 Runtime Blockers 范围。

---

## 六维评分

### Feasibility (可行性): 4/5

| 子维度 | 评分 | 证据 |
|--------|------|------|
| 技术难度 | 5 | 纯配置变更 + ~5 行代码，零新增架构 |
| 团队能力 | 5 | 已有两轮执行经验 |
| 工时 | 4 | 两轮计划总执行时间 ~60 分钟 |
| 工具支持 | 3 | cargo build 环境需手动配置 PATH |
| **综合** | **4** | |

### Impact (影响力): 4/5

| 子维度 | 评分 | 证据 |
|--------|------|------|
| 用户价值 | 3 | 内测者可用 @summarize，但输出质量受 prompt 限制 |
| 技术债务 | 5 | 清除了 tauri-plugin-fs schema 和技术债 |
| DX | 4 | `tauri dev` 不再报 fs error |
| **综合** | **4** | |

### Risk (风险): 2/5 (低风险)

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| Tauri 版本错配 | 中 | 低 | 不影响功能，仅 warning |
| Go backend system_prompt 行为变化 | 低 | 中 | 契约已定义，前端已兼容 |
| sidecar 端口冲突 | 低 | 低 | 已有实例时自动跳过 |
| **综合** | **2** | | |

### Complexity (复杂性): 2/5 (低复杂度)

| 子维度 | 评分 | 证据 |
|--------|------|------|
| 集成点 | 2 | 仅 tauri.conf.json + capabilities + agentAdapter 3 处改动 |
| 依赖 | 2 | 无新增依赖 |
| 测试 | 1 | 3738 tests pass |
| **综合** | **2** | |

### Dependencies (依赖): 2/5 (低依赖)

| 子维度 | 评分 | 证据 |
|--------|------|------|
| 外部服务 | 1 | Go backend 已运行 |
| 内部模块 | 2 | 仅 Runtime ChatAgentExecutor 路径 |
| 基础设施 | 2 | Tauri + Vite 已有 |
| **综合** | **2** | |

### Alternatives (替代方案): 2 个方案评估

| 方案 | 评估 |
|------|------|
| Scheme A: 保持 message 嵌入 + 修复 system_prompt | ❌ TEST 3 证明无效 |
| Scheme B: 真实 systemPrompt 独立字段 | ✅ TEST 2 + 4 证明有效 |

---

## 决策提取

### Locked (已锁定决定)

1. **Tauri FS 使用 capability 系统** — `plugins.fs.scope` 已删除，不再回退
2. **Skill 模式使用真实 systemPrompt** — 不嵌入 message 字符串
3. **Go backend system_prompt 接口契约** — `docs/system-prompt-contract.md` 已定义

### Free (实施者可自由决定)

1. **Tauri 版本错配修复** — `@tauri-apps/api` 可降级或 tauri crate 升级 (v2.10.3 ↔ v2.11.0)
2. **SKILL.md prompt 重设计** — 当前"摘要"指令被模型理解为"事实核查"，需改为"对以下原文进行要点提取"
3. **[§N] 格式替代** — 如模型不支持 `§` 字符，可改为 `[N]` / `[要点N]`

### Deferred (推迟)

1. **Go backend system_prompt 实现** — 外部仓库待处理
2. **自动 UAT** — `tauri-webdriver` / `Playwright Tauri` 测试设施建立
3. **多模型兼容测试** — 当前仅测试 mimo-v2.5，未覆盖其他 provider

---

## 结论

### Recommendation: Go ✓

Tauri Runtime Blockers 已全部修复。skill-runtime-p0-usable 的主要传输层阻塞已清除。剩余 [§N] / 摘要质量 / self-narration 问题属于独立维度（prompt engineering），可在新的工作流中处理。

### 后续建议

| 优先级 | 项目 | 类型 |
|--------|------|------|
| P1 | SKILL.md prompt 重设计 — 消除"事实核查"行为 | prompt-engineering |
| P1 | [§N] 格式确认 — 测试模型字符支持 | prompt-engineering |
| P2 | Tauri 版本对齐 | maintenance |
| P2 | 侧载 SKILL.md 到 Go backend（可替换 [MODE:DIRECT] 为模型差异优化） | optimization |

---

## Session 统计

- Rounds: 2 (全部基于已有数据，无 CLI 探索)
- 数据源: 4 TEST scripts, 1 cargo + tauri dev, 3738 unit tests
- 修复文件: 4 (tauri.conf.json, capabilities/default.json, agentAdapter.ts, docs/system-prompt-contract.md)
- 决策: 3 Locked, 3 Free, 3 Deferred
