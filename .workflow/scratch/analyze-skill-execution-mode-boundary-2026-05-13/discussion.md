# Skill Execution Mode Boundary — Analysis

**Session**: ANL-skill-execution-mode-2026-05-13
**Topic**: Skill Execution Mode Boundary
**Date**: 2026-05-13

## Table of Contents

- [User Intent](#user-intent)
- [Current Understanding](#current-understanding)
- [Round 1: End-to-End Trace](#round-1-end-to-end-trace)
- [Decisions](#decisions)

## User Intent

1. ✅ Identify where agentic behavior leaks into skill execution
2. ✅ Evaluate whether buildPromptInput is assistant-oriented
3. ✅ Determine if ChatAgentExecutor defaults to reasoning/plan mode
4. ✅ Assess system prompt construction quality
5. ✅ Evaluate need for explicit execution mode
6. ✅ Define skill mode requirements
7. ✅ Achieve Skill ≠ Agent Loop separation
8. ✅ Identify solutions that pollute Runtime
9. ✅ Evaluate SkillExecutionProfile need
10. ✅ Evaluate model-side inference params need

## Current Understanding (Final)

Skill 执行的 agentic behavior 泄漏源于两个根因：

1. **system_prompt 在 Tauri 桥接层丢失** — `BackendChatParams` 无 `system_prompt` 字段，SKILL.md 通过 `message: "system: content\nuser: input"` 嵌入，Go backend 无法区分为权威系统指令。这是 CRITICAL 级缺陷。

2. **无执行模式约束** — `ChatAgentExecutor.executeWithContext` 是通用 chat 执行器，无 mode 参数，LLM 默认 agentic planning 行为覆盖了 skill 指令。

最小修复方案为 Scheme B（2 文件 ~11 行）：
- `commands.rs`: 新增 `system_prompt: Option<String>` + POST body 转发
- `agentAdapter.ts`: `buildPromptInput` 对 skill 上下文注入 `[MODE: DIRECT]` 前缀；`executeWithContext` 传递 `systemPrompt`

明确不引入：SkillTaskExecutor、tool loop、planner、multi-pass、Runtime Constitution 改动。

## Round 1: End-to-End Trace

### 探索结果

完整数据流追踪确认了 4 个关键发现：

| # | 发现 | 严重度 | 文件:行 |
|---|------|--------|---------|
| 1 | system_prompt 在 Tauri 桥接层丢失 | CRITICAL | commands.rs:299 |
| 2 | 无 execution mode 概念 | HIGH | agentAdapter.ts:112 |
| 3 | buildPromptInput 纯文本拼接 | HIGH | agentAdapter.ts:37 |
| 4 | Skill task 走 chat executor | MEDIUM | skillBridge.ts:131 vs taskExecutor.ts:171 |

### CLI 验证

curl 直接调用 Go backend `/api/v1/chat` 传入 `system_prompt` 影响 LLM 输出，证明 Go 后端支持 system_prompt。

### Scheme 对比

| 维度 | A: 仅修复 system_prompt | B: A + mode prefix | C: B + 温控 |
|------|------------------------|--------------------|-------------|
| 改动文件 | 2 | 2 | 2 |
| 代码行 | ~6 | ~11 | ~12 |
| Runtime 污染 | 无 | 无 | 无 |
| LLM 遵循置信度 | 中 | 高 | 高 |

### 决策

推荐 **Scheme B** — 最小修复，零架构风险，不引入新概念。

## Decisions

### Decision 1: 修复 system_prompt 传递链
- **Options**: (1) 仅 Rust 侧 (2) Rust + TS 两侧
- **Chosen**: 选项 2
- **Reason**: TS 侧也未传递 systemPrompt，单侧修无法通信

### Decision 2: Execution mode 注入
- **Options**: (1) SKILL.md 加规则 (2) buildPromptInput 注入 (3) 新 executor（禁止）
- **Chosen**: 选项 2
- **Reason**: 5 行代码，零架构风险

### Locked
- 不新增 SkillTaskExecutor
- 不修改 Runtime Constitution
- 不新增 tool loop / planner / multi-pass

### Free
- mode prefix 文案可调整
- Rust 字段命名与 TS 侧一致即可

### Deferred
- Inference params 一体化
- SkillExecutionProfile
- Go backend cache key 优化

## Artifacts

- `analysis.md` — 6-dimension scoring, root cause, 3 schemes comparison
- `conclusions.json` — structured conclusions with implementation scope
- `context.md` — Locked/Free/Deferred decisions for downstream plan
