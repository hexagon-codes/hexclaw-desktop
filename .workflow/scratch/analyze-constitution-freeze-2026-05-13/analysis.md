# Analysis: Runtime Constitution Freeze Review

## 1. Constitution Stability Score

**Overall: 7.5/10 — 有条件冻结**

| ADR | Stability | Clarity | Compliance | Future-Proof | Score |
|-----|-----------|---------|------------|--------------|-------|
| 001 Bridge | 6 | 7 | 9 | 5 | **6.8** |
| 002 Authority | 9 | 8 | 6 | 8 | **7.8** |
| 003 Purity | 9 | 9 | 8 | 9 | **8.8** |
| 004 State Machine | 8 | 8 | 7 | 7 | **7.5** |

**评分标准**:
- Stability: 架构原则是否经过充分验证
- Clarity: 表述是否有歧义
- Compliance: 合规检查是否可直接执行
- Future-Proof: 文档是否会随代码演进而过时
- 综合: (Stability × 0.35 + Clarity × 0.20 + Compliance × 0.20 + Future-Proof × 0.25)

---

## 2. ADR Risk Matrix

| Risk | ADR | Probability | Impact | Severity | Mitigation |
|------|-----|-------------|--------|----------|------------|
| Bridge API 表过时 | 001 | 高（~3个月内） | 低（不影响原则） | 🟡 Medium | 移除 API 函数表，只保留原则 |
| revision bump 漏检 | 002 | 中 | 中（静默 UI 失效） | 🟡 Medium | 添加 Proxy 封装 ContextManager |
| Projector 被绕过 | 003 | 中 | 高（违反纯度约束） | 🔴 High | 添加 ESLint rule |
| executor 状态机绕过 | 004 | 中 | 高（状态不一致） | 🔴 High | 代码审查注意点 |
| Bridge 膨胀 | 001 | 高 | 低（可重构） | 🟢 Low | 定期审查 bridge 职责 |
| 新人直接 import 绕过 bridge | 001 | 中-高 | 高 | 🔴 High | 添加 CI lint（import 规则） |

**Critical Risks**:
1. 🔴 Projector 被绕过（003）— 最容易被"方便一下"的心态触发
2. 🔴 Executor 绕过状态机（004）— 最危险的违规，可能引发不可恢复状态
3. 🔴 新人绕过 bridge（001）— onboarding 时最容易犯的错误

---

## 3. Wording Ambiguity List

### ADR-001

| 位置 | 原文 | 问题 | 建议修正 |
|------|------|------|---------|
| Decision L29 | `useRuntimeStore` 或 `@/stores/runtime` | "或"造成两个约束的错觉，实际上是一个约束的两种表述 | `useRuntimeStore`（即 `@/stores/runtime`） |
| Decision L30 | Chat 类型（`ChatMessage`、`ChatSession` 等） | "等"范围模糊；Compliance 只查 `@/types/chat` import，不查具体类型 | 明确列出所有禁止的类型，或改为"所有 `@/types/chat` 导出的类型" |
| Decision L32 | 协调者（coordination），不是数据拥有者（ownership） | "数据拥有"语义模糊 —— bridge 是否需要持有 task↔session 映射？ | 补充说明："Bridge 不持有持久化数据，可持有运行时临时映射" |

### ADR-002

| 位置 | 原文 | 问题 | 建议修正 |
|------|------|------|---------|
| Context L12 | Revision 不同步 | 假设读者已知 revision 机制，新人无法理解 | 补充 revision 机制的一句话说明 |
| Constraints L33 | 纯持久化操作 | "纯"的范围不明确 —— restoreRuntime 也需要 bump？ | 明确：`saveContext/saveAll` 不 bump，`restoreRuntime` 需要 bump |
| Constraints L30 | 绕过 RuntimeStore | 通过参数传入 ContextManager 算不算绕过？ | 补充："任何直接持有 ContextManager 引用并调用其方法的代码" |

### ADR-003

| 位置 | 原文 | 问题 | 建议修正 |
|------|------|------|---------|
| Decision L21 | 不得 `import` 任何 `@/stores/*` | `import type` 是否包含？ | 补充：`import type` 不违反（无运行时 impact），但应尽量避免 |
| Compliance | 使用 `useWorkspaceStore` 做反例 | `@/stores/workspace` 尚不存在 | 用存在的 store 做反例，或注明"forward-looking" |
| Consequences L50 | 投射不充分的诱惑 | "不充分"的标准不明确 | 明确：如果投影不满足需求，应扩展投影函数而非绕过 |

### ADR-004

| 位置 | 原文 | 问题 | 建议修正 |
|------|------|------|---------|
| Decision L30 | Executor 层不操作状态机 | 与 Constraints 中"不得写入"不完全一致 —— 读状态是否允许？ | 统一为"不得写入 `ctx.execution`"（读允许） |
| Consequences L58 | 状态机定义在 types/ 而非 Store 中 | "维护时需注意同步"过于笼统 | 给出具体建议：修改状态时需同时更新 ADR-004 |

---

## 4. Long-term Maintenance Risks

### Risk 1: Line-number drift in References（🟡 Medium）
**影响**: ADR-001/002/004 引用具体行号（如 `runtime.ts:348-437`）。当 executeTask 重构时，行号会偏移，导致 References 失效。

**建议**: 
- 函数签名引用用行号（稳定，如 `runtime.ts:348` 指向 `executeTask(`)
- 函数体引用用范围 + 注释标记（如 `runtime.ts:348-437` 应加标记 `// [ADR-004] executeTask state machine`）

### Risk 2: API surface 表过时（🟡 Medium）
**影响**: ADR-001 列了 4 个 bridge 函数。当新增第 5 个时，ADR 文档与代码不一致。

**建议**: 将 API 表改为原则描述 + 示例，移除完整的函数枚举。

### Risk 3: ESLint rule 悬置（🟢 Low）
**影响**: ADR-003 提到"未来可加 ESLint 规则"，但当前无具体 issue 或 deadline。

**建议**: 创建跟踪 issue，或直接在 PR template 中添加相应的 check。

### Risk 4: Temporal caveat 过时（🟢 Low）
**影响**: ADR-004 提到"当前仅 chat type 有真实 executor"。当 agent/skill executor 实现后，这句话需要删除。

**建议**: 在实现 agent/skill executor 的 PR template 中包含"移除 ADR-004 中 temporal caveat"的 check。

---

## 5. 哪些 ADR 已 Truly Stable

### ✅ ADR-003: Projection Purity — **True Stable**
- 纯度约束是通用的、不随时间变化的架构原则
- 不引用任何可能变更的 API 函数列表
- Compliance 检查具体（import 语句审查 + ESLint 方向）
- 代码引用是文件级和函数签名级，不会随行号漂移
- **结论**: 可以直接 freeze 为 Constitution，仅需补充 `import type` 的说明

### ✅ ADR-002: Runtime Authority Ownership — **True Stable**
- "Store 是唯一 mutation 入口"是一个不变化的架构原则
- 不用维护 API 函数表
- 唯一的 temporal risk 是 composable 列表（`usePersistenceRuntime` 等）
- **结论**: 可以 freeze，但需将特定 composable 名称改为通用描述

### ✅ ADR-004: Execution State Machine — **Mostly Stable**
- 状态机转换规则（idle→preparing→running→completed/failed）是稳定的
- `canTransition()` 约束是稳定的
- 仅 temporal caveat（"仅 chat type"）需要移除
- **结论**: 可以 freeze，但需移除 temporal caveat

---

## 6. 哪些 ADR 仍属于 Evolving Semantics

### ⚠️ ADR-001: Chat-Runtime Bridge Boundary — **Evolving**
- **原则是稳定的**（bridge 是唯一边界、Chat 不导入 RuntimeStore）
- **具体内容是演进的**（API 函数表、bridge 职责范围）
- **问题**: 当前 ADR-001 文档把原则（stable）和 API 清单（unstable）混在一起
- **建议**: 分离：
  - Constitution 层: 保留原则（5 条规则）+ constraints + rejected alternatives
  - Implementation 层: 将 API 函数表移到 implementation note 或 README，不在 ADR 正文

---

## 7. 是否建议 Freeze 为 v0.8 Constitution Baseline

**建议: 有条件 Freeze（Conditional Go）**

### Freeze 范围

| ADR | Freeze | Condition |
|-----|--------|-----------|
| ADR-002 Authority | ✅ **Freeze** | 将 composable 名称改为泛化描述 |
| ADR-003 Purity | ✅ **Freeze** | 补充 `import type` 说明 |
| ADR-004 State Machine | ✅ **Freeze** | 移除"仅 chat type" temporal caveat |
| ADR-001 Bridge | ⏸️ **Deferred** | 分离原则（freeze）和 API 表（不 freeze）后加入 |

### Freeze 前置条件（3 项低成本修订）

1. **ADR-001 revision**: 移除 4-function API 表，保留原则层
2. **ADR-002 revision**: `usePersistenceRuntime` 等具体名称 → "示例：composable 返回 patch"
3. **ADR-004 revision**: 移除"当前仅 chat type" temporal caveat

### Freeze 后 Constitution 的含义

Freeze 意味着：
- 新代码必须遵守这些 ADR
- PR 审查可以引用 ADR 编号
- 如果有人提议变更，必须用新的 ADR supersede 旧的，不能就地修改
- ADR 文档本身原则上不修改（只做 errata-level 修正）

### 综合推荐

**Conditional Go — 在完成 3 项低成本修订后，正式 freeze 为 v0.8 Constitution baseline。**

估计修订工作量：
- ADR-001: 删除 1 个表格 + 调整 1 句 wording ≈ 5 分钟
- ADR-002: 替换 3 个 composable 名称为泛化表述 ≈ 3 分钟
- ADR-004: 移除 1 句 temporal caveat ≈ 1 分钟

总计: < 10 分钟修订 → freeze。
