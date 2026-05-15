# Analysis: Runtime ADR Consolidation

## Executive Summary

Runtime Kernel v0.7 的 10 个核心架构决策已通过代码验证，建议全部固化为 ADR。

**Overall Score**: 4.2/5 — 高度推荐执行
**Confidence**: 88% (高)

## Six-Dimension Scoring

### Feasibility — 5/5 (95% confidence)

- **证据**: 所有 10 项决策都已完整实现在代码中
- **代码锚点**:
  - `src/services/runtimeBridge.ts:1-3` — Bridge 职责边界已明确定义
  - `src/stores/runtime.ts:793-829` — RuntimeStore API 清晰
  - `src/services/workspaceProjector.ts:1-18` — 投影纯度约束
  - `src/types/execution.ts:8-43` — 状态机定义
- **结论**: ADR 是对已存在架构的文字记录，不是新设计。零实现风险。

### Impact — 5/5 (90% confidence)

- **价值**:
  - 新人 onboarding 无需逆向阅读全部代码即可理解架构
  - 防止后续开发者在无意中破坏已稳定边界
  - 为代码审查提供形式化依据（"这个 PR 违反了 ADR-003"）
  - 为 v0.8+ 的扩展方向提供明确基础
- **结论**: ADR 是非功能性需求的基础设施，写一次长期受益。

### Risk — 1/5 (85% confidence)

- **风险极低**:
  - ADR 是纯文档工作，不修改代码
  - 所有决策都是"已实现"的，不是"未来打算"的
  - 唯一风险：ADR 与代码不同步（实际已有偏差但 ADR 未更新）
- **缓解措施**: ADR 写入后与代码对照验证

### Complexity — 2/5 (85% confidence)

- 10 个 ADR，其中 6 个可以直接从代码映射
- 4 个"否定式"ADR（009, 010）需要额外说明 why-not
- 复杂度主要在于依赖关系管理和分层组织，而非 ADR 内容本身

### Dependencies — 2/5 (90% confidence)

- ADR-002 (Authority) 和 ADR-003 (Purity) 是基础，无外部依赖
- ADR-001 依赖 ADR-002
- ADR-004 依赖 ADR-002
- 依赖关系是单向的，无循环依赖

### Alternatives — Considered

| Approach | Pros | Cons | Verdict |
|----------|------|------|---------|
| 写入 CLAUDE.md | 开发时可见 | 不能替代正式文档 | ❌ |
| 写入技术规范文档 | 可以包含详细设计 | 但和代码解耦 | ❌ |
| ADR + 代码注释 | 双重记录 | 需要维护同步 | ✅ **推荐** |
| 只在代码注释中记录 | 靠近源码 | 缺乏全局视图 | ❌ |

## Recommendations

1. **高优先级**: 立即写入 ADR-001 到 ADR-004（Foundation + Bridge 层）
2. **中优先级**: 与 feature work 并行写入 ADR-005, ADR-008
3. **低优先级**: 在扩展相关区域前写 ADR-006, ADR-007
4. **按需**: ADR-009, ADR-010 在有人提出对应提案时写入

## Risk Matrix

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| ADR 与代码偏差 | 低 | 中 | 写入后 cross-check |
| ADR 阻止合理演进 | 低 | 高 | 注明 ADR 可 supersede |
| 开发者不读 ADR | 中 | 低 | 在 CLAUDE.md 中引用关键 ADR |
| ADR 过时未被更新 | 中 | 中 | 代码审查时检查 ADR 一致性 |

## Confidence Summary

| Dimension | Score | Confidence | Weakest Factor |
|-----------|-------|------------|----------------|
| Feasibility | 5/5 | 95% | — |
| Impact | 5/5 | 90% | — |
| Risk | 1/5 | 85% | — |
| Complexity | 2/5 | 85% | — |
| Dependencies | 2/5 | 90% | — |
| **Overall** | **4.2/5** | **88%** | Risk mitigation verification |

**Pressure Test**: 假设 ADR 全部写入后，最可能失效的场景是 ADR-003（Projection Purity）被绕过 —— 当 workspace UI 需要展示实时数据时，开发者可能倾向于在 projector 中直接访问 store。建议在 ADR-003 中明确"如果 projector 无法满足需求，扩展 projector 而不是让它访问 store"。

**Go/No-Go**: ✅ **Go** — 强烈建议立即启动。置信度高，风险低，长期收益明确。
