# Analysis: Original Project Runtime-native Refactor

**Session**: ANL-runtime-native-refactor-2026-05-14
**Date**: 2026-05-14
**Dimensions**: architecture, implementation, decision, concept

---

## Executive Summary

通过对 20+ 个核心文件的代码阅读和分析，识别出 HexClaw Desktop 在当前状态下与 Runtime Constitution / Skill Runtime 之间的 **10 个结构不匹配点**。其中 **P0 阻塞项仅 1 个**（M1: skill 语义路由），可在一个最小 wave 中完成修复，不影响 SPE skill 已验证路径，不引入大爆炸重构。

---

## M1-M10 优先级划分

### P0 Blocker（必须修复）

| ID | Mismatch | 文件 | 当前状态 | 修复方式 |
|----|----------|------|---------|---------|
| **M1** | skill 任务使用 `type='chat'` | `skillBridge.ts:133` | type 语义与实际路由不匹配 | 修复 `createContextAwareExecutor` 路由而非新增 SkillTaskExecutor |
| **M2** | ChatAgentExecutor 命名误导 | `agentAdapter.ts:87` | 名为 ChatAgent，实为 Runtime Executor | 随 M1 同步改名，不单独修复 |

### P1 Refactor（应当修复）

| ID | Mismatch | 文件 | 理由 |
|----|----------|------|------|
| **M4** | MODE:DIRECT/sanitization 硬编码 | `agentAdapter.ts:44-70` | 新增 skill 类型须改此文件 |
| **M6** | execMode toggle | `chat-send-controller.ts:207` | 长期应收敛为单一路径 |

### P2 Cleanup（代码整理）

| ID | Mismatch | 文件 | 理由 |
|----|----------|------|------|
| **M3** | 两套 Executor 注册表 | `taskExecutor.ts:156` | 死代码 `createExecutor()` |
| **M5** | Capability 检查重复 | `skillBridge.ts:42` + `runtime.ts:217` | 安全冗余可接受，但应统一阈值 |
| **M8** | SkillTaskExecutor 桩 | `taskExecutor.ts:103` | M1 修复后成为死代码 |
| **M10** | WS 路径重复 Task 生命周期 | `chat-send-controller.ts:165-175` | 与 runtimeBridge 逻辑重复 |

### Deferred（不做）

| ID | Mismatch | 理由 |
|----|----------|------|
| **M7** | RT/WS 共享后端端点 | 设计如此，两条路径 payload 本质不同 |
| **M9** | 浏览器 dev 不可用 | Tauri 应用不存在此场景 |

---

## Dependency Graph

```
M1 (skill type 路由)
 │
 ├──→ M2 (ChatAgentExecutor 改名)     ← 同文件同时改
 │
 ├──→ M8 (SkillTaskExecutor 死代码)   ← M1 修复后自然变成死代码，P2 删
 │
 └──→ [Routing 层]  ──→ M4 (MODE:DIRECT 提取)  ← P1, 可独立
                                │
                                └──→ M6 (execMode 收敛)  ← P1, 依赖不大
                                        
M3 (createExecutor 死代码)     ← P2, 独立
M5 (Capability 重复)           ← P2, 独立
M10 (WS Task 生命周期)         ← P2, 独立
```

**关键依赖**：M1/M2 在同一文件范围内，可同时修复。M4/M6 可独立进行。M3/M5/M8/M10 均为独立清理。

---

## P0 Refactor Wave（最小可行）

### Wave 1: 语义修正（P0）

**目标**：修复 skill 路由语义，不改 Executor 实现，不改 skillBridge 执行流。

**涉及文件**：
1. `src/services/taskExecutor.ts:171-181` — `createContextAwareExecutor` 的 switch 逻辑
2. `src/services/agentAdapter.ts:87` — `ChatAgentExecutor` class 改名（如 `RuntimeProviderAdapter`）
3. `src/services/skillBridge.ts:133` — `type: 'chat'` → `type: 'skill'`

**具体改动**：

```
// taskExecutor.ts — createContextAwareExecutor
// 当前: 'chat' → ChatAgentExecutor, 'skill' → SkillTaskExecutor (stub)
// 改为: 'chat' → RuntimeLLMExecutor, 'skill' → RuntimeLLMExecutor
// ChatAgentExecutor 更名为 RuntimeLLMExecutor，成为所有 LLM 调用的默认执行器
```

```
// skillBridge.ts:133
// 当前: type: 'chat'
// 改为: type: 'skill'
// 因为 createContextAwareExecutor('skill') 现在也返回 RuntimeLLMExecutor
```

**不修改**：
- `skillBridge.ts` 的执行流（仍然 `loadSkillLayerForTask → executeChatTask`）
- `runtimeBridge.ts`（shim 层不动）
- `agentAdapter.ts` 的 `buildPromptInput` 逻辑（M4 是 P1）
- 现有的 summarize/bulletize SKILL.md 和 skill.json

**验证方法**：
- summarize skill UAT 仍产生 3 行 `[要点N]` 输出
- bulletize skill UAT 仍产生 5 行 `•` 输出
- 正常 chat（非 @mention）不受影响

**侵入评估**：
- 3 个文件的改动，每处 ≤3 行
- 现有 skill 执行路径的输入输出不变（只是内部路由改名）
- 不影响 WS path

---

### P1 Wave 2（可选，独立）

**M4: MODE:DIRECT 提取** — 将 `agentAdapter.ts:44-70` 的 prompt 构建逻辑提取到 `runtime/llmContract.ts`（或类似模块）。不影响 skill 执行，纯重构。

**M6: execMode 收敛** — 当 RT 路径稳定性达到要求后，删除 execMode toggle。

---

### P2 Cleanup（可随时独立进行）
- M3: 删除 `createExecutor()` 函数
- M5: 统一 Capability 检查的阈值配置
- M8: 删除或重写 SkillTaskExecutor
- M10: 抽取 WS path 的 Task 生命周期复用 runtimeBridge

---

## 不做事项

| 不做 | 理由 |
|------|------|
| 不新增 SkillTaskExecutor 实现 | M1 的修复是通过路由而非新增实现 |
| 不改 WS streaming 架构 | WS path 保持独立，收敛不是取消 |
| 不新增 Workflow/Planner/Multi-agent | 见 docs/1.md 禁止项 |
| 不破坏 SPE skill 已验证路径 | 所有改动的验证标准是 UAT 不变 |
| 不扩展 TaskResult 类型 | 已 Hold 的决定不翻案 |
| 不加新 class / 新文件（W1） | Wave 1 只改现有文件不改文件名（改名在 class 级别，不在文件级） |

---

## 是否进入 maestro-plan

**建议：✅ 进入规划**（确认 Wave 1 范围后）

Wave 1 的 3 个文件改动明确、侵入低、验证方式清晰。执行时间估计 ≤15min（含 UAT 验证）。

需要确认：
- ChatAgentExecutor 的新名称（建议: `RuntimeLLMExecutor` 或 `RuntimeProviderExecutor`）
- `createContextAwareExecutor` 中是否直接让 'skill' → RuntimeLLMExecutor，或者改变 switch 的 fallthrough 结构

---

## Risk Matrix

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| rename 遗漏引用 | 低 | 中 | rename 后用 grep 验证所有引用点 |
| skill 执行路径被破坏 | 极低 | 高 | UAT 验证 summarize + bulletize |
| 回归到 WS chat 路径 | 极低 | 中 | 正常 chat UAT |
| MODE:DIRECT 行为改变 | 低 | 中 | Wave 1 不改 MODE:DIRECT 逻辑（P1 才改） |
| 大爆炸重构风险 | 无 | — | Wave 1 只改 3 处，侵入极低 |

---

## Confidence

| Factor | Score |
|--------|-------|
| Findings depth | 85% — 覆盖了 10 个重点中的 10 个 |
| Evidence strength | 90% — 每个 mismatch 有文件+行引用 |
| Coverage breadth | 80% — 可再深挖 integration points |
| Consistency | 90% — 发现与 ADR 文件一致 |
| **Overall** | **86%** |

**Pressure pass**: M1 是核心发现。pressure test：如果 M1 不修，新增第三个 SPE skill 会继续复用 type='chat' 路径，当前体验无问题——但语义错误会在 type='skill' 上线的真实 executor 需求时变为硬阻塞。因此 M1 是"技术债利息未到期"的 P0，不是"系统已崩溃"的 P0。
