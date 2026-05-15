# First Official Skill P0 — 6-Dimension Scoring

**Session**: ANL-first-official-skill-p0-2026-05-13
**Date**: 2026-05-13

## 推荐方案

**先修复 Skill Context 注入管道，然后用 `summarize` 验证完整链路。**

---

## Dimension 1: 可行性 (Feasibility)

**Score: 4.5/5**

### 证据

**Skill Context 管道已有基础：**
- ✅ `ContextLoader.loadSkillLayer(context, skillPkg)` — 已存在（`contextLoader.ts:144-158`），能从 SkillPackage 注入 markdown
- ✅ `SkillLayer` interface 已定义（`context.ts:67-78`），包含 markdown、references、capabilities
- ✅ `SkillLoader.loadSkill(skillId, { loadMarkdown: true })` — 已存在，能读取 SKILL.md
- ✅ `buildPromptInput(context)` — 已存在（`agentAdapter.ts:37-57`），只需扩展读取 `skill.markdown`
- ✅ `SkillPackage` 类型已定义（`context.ts:42-47`）

**缺少的连接：**
- `skillBridge.ts` — `tryExecuteSkill` 不加载 SKILL.md，不注册 Context
- `agentAdapter.ts` — `buildPromptInput` 不读取 `skill.markdown`
- `RuntimeStore` — 缺少一个在 `registerContextForTask` 后注入 SkillLayer 的方法

### 修改量估计

| 文件 | 修改 | 行数估计 |
|------|------|---------|
| `skillBridge.ts` | tryExecuteSkill 加载 SKILL.md + 创建 Task + 注册 Context + 注入 SkillLayer | ~25 行 |
| `agentAdapter.ts` | buildPromptInput 读取 skill.markdown → 作为 system message | ~5 行 |
| `stores/runtime.ts` | 新增 loadSkillLayerForTask 方法 | ~8 行 |
| `skills/builtin/summarize/` | SKILL.md 调整（可选） | 0-5 行 |
| **Total** | | **~38 行** |

**总结**: 低风险，增量修改。所有基础设施已就绪，只需连接。

---

## Dimension 2: 影响 (Impact)

**Score: 4.0/5**

### 预期效果

- ✅ **任何 Official Skill 的 SKILL.md 都能注入 prompt** — 管道通用，不限于 summarize
- ✅ **验证完整架构边界**: Registry → Loader → Context → Executor 全链路
- ✅ **用户可见价值**: `@summarize <text>` 产出结构化摘要
- ✅ **为后续所有 Official Skill 铺路**: translate、explain_code 等只需创建 skill.json + SKILL.md

### 局限性

- ⚠️ 当前只支持 text 输出，不支持结构化展示
- ⚠️ 只验证单步 LLM 调用，不验证多步编排

---

## Dimension 3: 风险 (Risk)

**Score: 4.5/5**（低分 = 高风险，所以高分 = 低风险）

### 风险分析

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| SkillTaskExecutor stub 干扰 | 低 | 阻断 | 保持 task type = chat，不走 SkillTaskExecutor |
| SKILL.md 过长超出 context window | 低 | 中 | summarize 的 SKILL.md 仅 ~600 chars，无风险 |
| Context 注入后未 bump revision | 中 | 低 | 可接受，UI 暂不消费 SkillLayer |
| summarize 的 references/ 文件 | 低 | 低 | P0 不加载 references，只加载 SKILL.md |

### 7 条红线检查

summarize **不可能**滑向任何红线：
- ✅ 非 DAG — 单步 LLM 调用
- ✅ 非 Workflow Engine — 无多步编排
- ✅ 非 Node Graph — 无可视化节点
- ✅ 非 BPMN — 无流程建模
- ✅ 非 Visual Builder — 无 UI 构建
- ✅ 非 Auto Agent Planner — 无自动规划
- ✅ 非 Multi-Agent — 单 Agent 单 LLM 调用

---

## Dimension 4: 复杂度 (Complexity)

**Score: 4.0/5**（高分 = 低复杂度）

### 修改范围

```
skillBridge.ts      — 加载 SKILL.md + 创建 Task + 注册 Context (~25 行)
agentAdapter.ts     — buildPromptInput 读取 skill.markdown (~5 行)
runtime.ts          — 新增 loadSkillLayerForTask (~8 行)
```

**3 个文件，~38 行。无新增类型、无新增接口、无新增依赖。**

### 集成点

| 集成点 | 状态 |
|--------|------|
| SkillLoader → ContextLoader | 已有，只需串联 |
| ContextLoader → buildPromptInput | 需要新连接 |
| RuntimeStore → SkillLayer 注入 | 需要新方法 |

---

## Dimension 5: 依赖 (Dependencies)

**Score: 4.5/5**（高分 = 低依赖）

### 外部依赖
- ❌ 无新 npm 包
- ❌ 无新 tauri plugin
- ❌ 无外部 API 或服务

### 内部依赖
| 前置条件 | 状态 |
|---------|------|
| SkillRegistry 双 BaseDirectory | ✅ 已完成 (official-skill-boundary-p0) |
| Capability Gate | ✅ 已完成 (capability-gate-p0) |
| ContextLoader.loadSkillLayer | ✅ 已有 |
| SkillLoader.loadSkill | ✅ 已有 |
| ChatAgentExecutor | ✅ 已有 |

### 阻塞依赖
- ❌ 无。所有前置条件已就绪。

---

## Dimension 6: 替代方案 (Alternatives)

### A. 先修管道再用 summarize（推荐 ✅）

| 方面 | 评估 |
|------|------|
| 工作量 | ~38 行，3 文件 |
| 验证价值 | 全链路：Registry → Loader → Context → Executor |
| 用户价值 | 高：@summarize 产出结构化摘要 |
| 可扩展性 | 管道通用，后续 skill 零修改 |

### B. 只修管道不选 skill（❌ 不推荐）

| 方面 | 评估 |
|------|------|
| 工作量 | 相仿 |
| 验证价值 | 缺最终集成验证 |
| 用户价值 | 无 |
| **问题** | 无法验证端到端：管道修完但没有 skill 可测试 |

### C. 选 translate 更轻量（⚠️ 可选）

| 方面 | 评估 |
|------|------|
| 理由 | "翻译"是 LLM 天然能力，即使无 SKILL.md 注入也能工作 |
| 问题 | 无法验证 SKILL.md 是否被正确注入（因为 translate 不需要特定指令也能工作） |
| **问题** | 失去了验证 Skill Context 注入是否正确的机会 |

### D. 玩具 skill 先通链路（❌ 不推荐）

| 方面 | 评估 |
|------|------|
| 工作量 | 最少（无需 Context 注入） |
| 验证价值 | 极低：只验证 @mention 解析，不涉及 Runtime Boundary |
| **问题** | 通了但什么都没验证 |

---

## 推荐执行路径

### Phase 1: 修复管道（Wave 1）

**目标**: 打通 Skill Context 注入管道

| 步骤 | 文件 | 修改 |
|------|------|------|
| 1 | `stores/runtime.ts` | 新增 `loadSkillLayerForTask(taskId, skillPkg)` 方法 |
| 2 | `skillBridge.ts` | `tryExecuteSkill` 中加载 SKILL.md → 创建 Task → 注册 Context → 注入 SkillLayer |
| 3 | `agentAdapter.ts` | `buildPromptInput` 读取 `skill.markdown` → 作为 system message |

### Phase 2: 验证 summarize（Wave 2）

**目标**: 用 summarize 验证端到端链路

| 步骤 | 文件 | 修改 |
|------|------|------|
| 4 | `skills/builtin/summarize/` | 确认 skill.json + SKILL.md 正确 |
| 5 | — | 用户测试 `@summarize <text>` 执行 |

### 不做的（Deferred）

- ❌ 不加载 `references/` 目录（P0 只加载 SKILL.md）
- ❌ 不修改 `SkillTaskExecutor`（保持 task type = chat）
- ❌ 不扩展 Result Surface
- ❌ 不新增 capability
- ❌ 不修改 MentionPopup
- ❌ 不处理 Skill 组合/编排
