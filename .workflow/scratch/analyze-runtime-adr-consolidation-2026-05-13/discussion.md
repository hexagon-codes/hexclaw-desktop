# Discussion: Runtime ADR Consolidation

**Session**: ANL-runtime-adr-consolidation-2026-05-13
**Topic**: Runtime Kernel v0.7 架构边界固化为 ADR
**Date**: 2026-05-13
**Mode**: adhoc, auto-mode

## Table of Contents

- [User Intent](#user-intent)
- [Current Understanding](#current-understanding)
- [Discussion Timeline](#discussion-timeline)

## User Intent

将 runtime-kernel-v0.7 已稳定的架构边界正式固化为 Architecture Decision Records。具体需求：

1. ADR list —— 需要记录哪些架构决策
2. ADR priority —— 各 ADR 的优先级排序
3. ADR dependency graph —— ADR 间的依赖关系
4. 哪些 ADR 必须先写 —— 前置依赖分析
5. 哪些 ADR 可以 deferred —— 可推迟项
6. 建议的 docs 目录结构 —— ADR 存储位置

## Current Understanding

Based on complete Runtime Consolidation Review (completed prior to this session), the architecture has 10 distinct boundary decisions that warrant ADR documentation:

| # | Boundary | Status | Urgency |
|---|----------|--------|---------|
| 1 | Chat↔Runtime Bridge | ✅ 已稳定 | 高 |
| 2 | Runtime Authority Ownership | ✅ 已稳定 | 高 |
| 3 | Projection Purity | ✅ 已稳定 | 高 |
| 4 | Execution Semantics | ✅ 已稳定 | 高 |
| 5 | RuntimeBridge Responsibility | ✅ 已稳定 | 高 |
| 6 | Session Ownership | ✅ 已稳定 | 中 |
| 7 | TaskResult Semantics | ⚠️ 部分定义 | 中 |
| 8 | Explicit Persistence | ✅ 已稳定 | 中 |
| 9 | No Streaming Inside executeTask | ✅ 架构约束 | 低 |
| 10 | No Workflow/Agent/Browser Runtime | ✅ 架构约束 | 低 |

## Discussion Timeline

### Round 1: Initial ADR Analysis

**Sources**: Complete Runtime Consolidation Review (architecture analysis of all boundary files including runtime.ts, runtimeBridge.ts, workspaceProjector.ts, chat.ts, chat-send-controller.ts, taskExecutor.ts, agentAdapter.ts, context types)

**Key Findings**:
- 当前 Runtime 核心架构有约 10 个独立架构决策
- 其中 8 个已稳定并可通过阅读代码验证
- 2 个是 "否定式" 决策（明确不做 streaming runtime 和 workflow runtime）
- 所有 ADR 可被组织为 3 层：Foundation → Execution → Strategy

**Technical Solutions**:

> **Solution**: ADR 分层组织
> - **Status**: Validated
> - **Problem**: 10 个 ADR 需要结构化管理，避免平面列表显得无序
> - **Rationale**: 基于依赖关系分层，Foundation 层不依赖其他层，Execution 层依赖 Foundation
> - **Alternatives**: 单层平面列表（顺序依赖不明显），按模块分组（跨模块关联丢失）
> - **Next Action**: 在 Round 2 细化每层的 ADR 内容

### Round 2: ADR Decision Extraction

**起点**: 基于 Round 1 的 10 个 ADR 清单和三层组织方案，进入决策提取。

**关键进展**:
- 完成 5 项架构决策的正式记录（Locked/Free/Deferred 分类）
- 完成 ADR 优先级的 P0/P1/P2/P3 分级
- 完成 ADR 依赖关系分析（Foundation → Execution → Strategy）
- 确定写入顺序: 002 → 003 → 004 → 001 → 005/006 → 007/008 → 009/010

**决策影响**: 所有 6 个用户需求均得到满足。

**当前理解**:
- ADR 清单：10 个，覆盖所有已稳定架构边界
- 优先级：P0(4) 必须最先写，P1(2) 可并行，P2(2) 在扩展前写，P3(2) 按需
- 目录结构：`docs/adr/` 独立目录
- 写入策略：分批写入，不是一次全部

**遗留问题**: 无。分析结论完整，进入报告阶段。

### Intent Coverage Matrix

| # | Intent | Status | Where Addressed |
|---|--------|--------|-----------------|
| 1 | ADR list | ✅ | Round 1 + context.md ADR Reference |
| 2 | ADR priority | ✅ | context.md Locked/Deferred + conclusions.json |
| 3 | ADR dependency graph | ✅ | context.md Dependency Graph |
| 4 | 必须先写的 ADR | ✅ | conclusions.json write_order |
| 5 | 可 deferred 的 ADR | ✅ | context.md Deferred section |
| 6 | 建议的 docs 目录结构 | ✅ | context.md 末尾 |

