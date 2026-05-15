# Discussion: Runtime Constitution Freeze Review

**Session**: ANL-constitution-freeze-2026-05-13
**Topic**: ADR Wave 1 是否足够稳定作为长期 Runtime Constitution baseline
**Date**: 2026-05-13
**Mode**: adhoc, auto-mode

## Table of Contents

- [User Intent](#user-intent)
- [Current Understanding](#current-understanding)
- [Discussion Timeline](#discussion-timeline)

## User Intent

审查 4 个 ADR（001-004）是否可以作为长期 Constitution baseline：

1. Constitution stability score
2. ADR risk matrix
3. Wording ambiguity list
4. Long-term maintenance risks
5. 哪些 ADR 已 truly stable
6. 哪些 ADR 仍属于 evolving semantics
7. 是否建议 freeze 为 v0.8 constitution baseline

## Current Understanding

已读取全部 4 个 ADR 文档 + README + template，完成 10 个维度（wording/compliance/alternatives/cross-ref/code-refs/missing-constraints/implementation-detail/future-misunderstanding/false-stability/newcomer-risk）的逐一审查。

初期评估：

| ADR | 稳定性 | wording 风险 | compliance 可执行性 | 主要问题 |
|-----|--------|-------------|---------------------|----------|
| 001 Bridge | 中 | 中 | 高 | API 函数列表是 impl detail，会随变化过时 |
| 002 Authority | 高 | 低 | 中 | revision bump 无法自动化验证 |
| 003 Purity | 高 | 低 | 高 | 缺少 ESLint rule 作为硬约束 |
| 004 State Machine | 高 | 低 | 中 | "仅 chat type 有真实 executor" 是 temporal caveat |

## Discussion Timeline

### Round 1: Constitution Freeze Analysis

审查基于 4 个 ADR 的全文阅读 + 10 个重点维度的系统性检查。详细结果见 analysis.md 和 context.md。

> **Decision**: 建议 Conditional Freeze — ADR-002/003/004 freeze 为 Constitution baseline，ADR-001 标记为 "evolving — 原则稳定，细节需持续更新"
> - **Context**: 4 个 ADR 的架构原则都通过了代码验证
> - **Options considered**: Full freeze (all 4), Conditional freeze (3+1), No freeze (continue Wave 2 first)
> - **Chosen**: Conditional — **Reason**: ADR-001 文档中含有过多 implementation detail，不应在 constitution 层冻结
> - **Rejected**: Full freeze — ADR-001 的 API 函数表会随 bridge 扩展而过时
> - **Impact**: ADR-001 需要一次修订去除 impl detail 后才能加入 constitution

> **Solution**: 在 Freeze 前对 4 个 ADR 各做一次 targeted revision
> - **Status**: Proposed
> - **Problem**: ADR 中包含 implementation detail 和 era-specific caveat，冻结后会过时
> - **Rationale**: Minimal edits approach — 不改 Context/Decision/Constraints，只调整具体引用和 caveat
> - **Evidence**: ADR-001 4-function table, ADR-002 composable names, ADR-003 ESLint aspirational, ADR-004 "仅 chat type" caveat
> - **Next Action**: 在 context.md 的 Free 区域中列出推荐的 revision 项
