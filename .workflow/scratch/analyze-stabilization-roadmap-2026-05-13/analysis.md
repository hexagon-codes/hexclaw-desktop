# Analysis: Runtime Stabilization Roadmap

**Session**: ANL-stabilization-roadmap-2026-05-13
**Date**: 2026-05-13
**Mode**: auto

## 0. Current State Assessment

### Truly Stable
- Chat↔Runtime bridge boundary (ADR-001 ✅ frozen)
- Runtime authority ownership (ADR-002 ✅ frozen)
- Projection purity constraint (ADR-003 ✅ frozen)
- Execution state machine (ADR-004 ✅ frozen)
- Session ownership (Chat-owned, Runtime zero session awareness)
- 5-layer context architecture (System/Skill/Task/Execution/Memory)
- Timeline append-only store
- `buildAssistantMessage` pure function (shared by WS + RT paths)

### Known Gaps (from Runtime Consolidation Review)
| Gap | Severity | Type |
|-----|----------|------|
| TaskResult only `{kind:'text'}` | 🔴 High | Architecture debt |
| No streaming in RT path | 🔴 High | Product debt |
| No tool_calls in RT path | 🔴 High | Product debt |
| Executor stubs for agent/skill | 🟡 Medium | Architecture debt |
| Error boundary not formalized | 🟡 Medium | Architecture debt |
| No Runtime API layer | 🟡 Medium | Architecture debt |
| Revision mechanism fragile | 🟢 Low | Architecture debt |
| WorkspaceStore doesn't exist | 🟡 Medium | Architecture debt |

---

## 1. Stabilization Roadmap

```
Week 1-2: Foundation Stabilization
├── P0: Error boundary formalization          (fastest ROI, ~2-3 days)
├── P0: WS/RT semantic drift closure          (low cost, ~1-2 days)
├── P0: TaskResult type hardening             (low cost, ~1 day)
└── P0: Observability: execution state visibility (~2-3 days)

Week 3-4: Surface Stabilization
├── P1: Workspace surface formalization       (moderate, ~2-3 days)
├── P1: Projection purity enforcement (ESLint) (~1 day)
└── P1: Cross-execution memory surface        (moderate, ~3-4 days)

Ongoing (throughout window):
├── ADR Wave 2 drafting                       (parallel, low intensity)
└── Test coverage for existing paths          (parallel, incremental)
```

---

## 2. P0/P1/P2 Priority

### P0 — Must do in stabilization window

| Item | Why | Effort | Risk if not done |
|------|-----|--------|------------------|
| Error boundary formalization | RT errors → Chat errors 无标准化映射，`handleSendError` 接收 `unknown` | 2-3天 | 用户看到不可预测的错误信息 |
| WS/RT semantic drift closure | Auto-title 执行路径不同、error shape 不同 | 1-2天 | 同用户输入在不同 execMode 下行为不一致 |
| TaskResult type hardening | 当前仅 `{kind:'text'}`，无法表达 tool_calls、结构化输出 | 1天 | 阻塞所有依赖 TaskResult 的下游 |
| Execution state observability | 当前无 execution trace、无进度反馈 | 2-3天 | Debug 依赖 console.log |

### P1 — Should do

| Item | Why | Effort |
|------|-----|--------|
| Workspace surface formalization | 明确哪些 projection 是 stable/experimental | 2-3天 |
| Projection purity ESLint rule | 把 ADR-003 compliance 自动化 | 1天 |
| Cross-execution memory surface | MemoryLayer 已定义但无有效的跨 execution 访问路径 | 3-4天 |

### P2 — Nice to have

| Item | Why | Effort |
|------|-----|--------|
| Executor stub hardening | agent/skill executor 当前返回空结果 | 2-3天 |
| Recovery layer activation | 当前 assessment-only，无 recovery action | 3-4天 |
| Asset management surface | Asset 已定义但无 UI 消费 | 2-3天 |

---

## 3. Architecture Debt

| Debt | Location | Description | Fix |
|------|----------|-------------|-----|
| Error boundary missing | `runtimeBridge.ts` + `chat-send-controller.ts` | Runtime error → Chat error 无类型映射 | 定义 `BridgeError` 类型 + error code mapping |
| TaskResult too minimal | `src/types/task.ts:38-39` | 仅 `{kind:'text'}` | 扩展 discriminated union |
| No retry/fallback | `runtime.ts:executeTask` | LLM 调用失败直接 reject | 在 RuntimeStore 或 executor 层加 retry |
| Revision fragility | `runtime.ts` | 漏 bump 无检测 | Proxy 封装 ContextManager 或单元测试 coverage |
| No Runtime API layer | 无 `src/api/runtime.ts` | Store 方法被直接调用 | 提取 API 层（跨进程预留） |
| Executor stubs | `taskExecutor.ts` | agent/skill executor 无真实实现 | 实现 `executeWithContext` |

---

## 4. Product Debt

| Debt | Description | User Impact |
|------|-------------|-------------|
| RT 路径无 streaming | Runtime executeTask 是单次 Promise 返回 | 长响应时用户无进度反馈，UX 不一致 |
| RT 路径无 tool_calls | buildAssistantMessage 不传入 toolCalls | approval/artifact 流程在 RT 路径不可用 |
| WS 路径无 Runtime context | WS 路径不产生 timeline 事件 | Runtime observability 在 WS 路径为空 |
| Workspace surface 无 UI | Projection 存在但无 WorkspaceStore | Scope/Narrative/Result UI 不可用 |

---

## 5. Semantic Debt

| Debt | Description | Risk |
|------|-------------|------|
| Auto-title divergence | WS 路径在 `finalizeAssistantMessage` 内部触发，RT 路径在 `sendMessage` 显式调用 | 不同 execMode 下 session 标题可能不同 |
| Error shape divergence | WS 路径 error 来自 WebSocket，RT 路径来自 executeChatTask catch | UI 层的 error display 需同时处理两种 shape |
| Workspace projection experimental | `TaskResultProjection` 定义 7 种 kind 但实际只产出 `{kind:'text'}` | 投影层无法被充分测试 |
| Session side-effect timing | WS 路径 bumps session 在 finalizeAssistantMessage，RT 路径在 sendMessage 的 try block | 异常时的 session 状态可能不同 |

---

## 6. ADR Wave 2 候选

### 建议立即开始起草的 ADR（Week 1-2 并行执行）

| # | Title | Status | Rationale |
|---|-------|--------|-----------|
| 005 | RuntimeBridge Responsibility | 🟡 Prepare | Bridge 当前 4 个函数职责已稳定，但 error mapping 和扩展规则需要记录 |
| 006 | Session Ownership | 🟡 Prepare | 已稳定（Chat-owned），但需要正式记录 "Runtime 不感知 Session" 的边界 |
| 007 | TaskResult Semantics | 🟡 Prepare | 当前类型太窄，扩展前需要 ADR 记录设计意图 |
| 008 | Explicit Persistence | 🟢 Deferred | 当前设计（save/saveAll 显式调用）是稳定的，低优先级 |

### 不建议 Wave 2 处理

| # | Title | Reason |
|---|-------|--------|
| 009 | No Streaming Inside executeTask | 当前无 streaming 实现，记录此 ADR 无实际约束力 |
| 010 | No Workflow Runtime | 当前无人提议 workflow，ADR 无实际约束对象 |

---

## 7. Additional Freeze 候选

| Area | Current State | Freeze Recommendation |
|------|--------------|----------------------|
| Chat session ownership | 已稳定，代码已验证 | ✅ Freeze now（ADR-006） |
| Session side-effect contract | Phase B 已对齐 | ✅ Freeze after ADR-006 |
| RuntimeBridge API surface | 4 函数，已稳定 | ✅ Freeze after ADR-005 |
| Error boundary contract | 尚未 formalize | ⏸️ 等 error boundary 实现后 freeze |

---

## 8. 建议优先做的 Analyze

| Analyze | Focus | When | Why |
|---------|-------|------|-----|
| Error boundary analysis | Runtime error types → Chat error types 映射 | Week 1 | P0 前置分析 |
| TaskResult type survey | 所有 TaskResult 消费方及所需类型 | Week 1 | P0 前置分析 |
| Workspace surface audit | 哪些 projection 可稳定、哪些实验 | Week 2 | P1 前置分析 |
| Execution observability design | 如何暴露 execution 进度、trace | Week 1 | P0 前置分析 |

---

## 9. 建议延后的 Execute

| Item | Defer Reason | Target |
|------|-------------|--------|
| Streaming in RT path | 需要重写 executeTask 的 push-based 模型，不适合 stabilization window | Post-stabilization |
| Tool calls in RT path | 需要实现 tool discovery + execution sandbox | Post-stabilization |
| Workflow runtime | 需要 DAG 编排，当前架构不支持 | v0.9+ |
| Multi-agent | 需要 agent discovery + routing | v0.9+ |
| Browser runtime | 完全不同的 domain | v1.0+ |
| Scheduler / Event Bus | 当前无调度需求 | v0.9+ |

---

## Summary Decision

```
Week 1-2: 3 P0 analyzes + 3 P0 executes (parallel)
  ├── Analyze: Error boundary mapping
  ├── Analyze: TaskResult consumer survey
  ├── Analyze: Execution observability design
  ├── Execute: Error boundary formalization
  ├── Execute: WS/RT semantic drift closure
  ├── Execute: TaskResult type hardening
  └── Draft: ADR-005, ADR-006, ADR-007

Week 3-4: P1 (sequential)
  ├── Analyze: Workspace surface audit
  ├── Execute: Workspace surface formalization
  ├── Execute: Projection purity ESLint rule
  ├── Execute: Cross-execution memory surface
  └── Freeze: ADR-005, ADR-006, ADR-007

Freeze target: runtime-architecture-v0.9 (end of stabilization window)
```
