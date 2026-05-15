# Context: Runtime Stabilization Roadmap

**Date**: 2026-05-13
**Session**: ANL-stabilization-roadmap-2026-05-13

## Decisions

### Decision 1: Stabilization Window Scope
- **Context**: 未来 2-4 周的工作范围
- **Chosen**: P0 foundation stabilization (Week 1-2) → P1 surface stabilization (Week 3-4)
- **Reason**: Error boundary + semantic drift + TaskResult 是最紧迫的架构债务

### Decision 2: Phase Ordering
- **Context**: 多项工作存在依赖关系
- **Chosen**: Analyze-before-execute 原则 — 每个 P0 项目先做 analyze 再做 execute
- **Reason**: 当前分析不足，直接 execute 可能导致错误方向

## Constraints

### Locked
1. **不做** Tool/Streaming/Workflow/Browser Runtime，不做 Multi-Agent/Scheduler/Event Bus
2. **P0 必须**先 analyze 再 execute（每个 P0 项的前置 analyze 不跳过）
3. **ADR Wave 2 只起草不发布** — 在 stabilization window 内只做 ADR-005/006/007 的 draft，不在 window 内 freeze

### Free
- P1 项目的执行顺序
- 是否将 retry/fallback 纳入 P0（取决于 error boundary analyze 结果）
- 具体的 error code 命名方案

### Deferred
- **WS 路径加 timeline events** — 属于 cross-path observability，但不影响 RT 路径的稳定性。post-window
- **Recovery layer activation** — 当前 assessment-only 足够。post-window 或 window 内 P2
- **Asset management UI** — 无前端消费者。post-window

## ADR Wave 2 Draft Plan

| ADR | Draft Timing | Freeze Timing | Dependencies |
|-----|-------------|---------------|--------------|
| 005 Bridge Responsibility | Week 1-2 (parallel) | End of window | ADR-001, ADR-002 |
| 006 Session Ownership | Week 1-2 (parallel) | End of window | ADR-001 |
| 007 TaskResult Semantics | Week 2-3 (after survey) | End of window | ADR-004 |
| 008 Explicit Persistence | Deferred | Post-window | ADR-002 |

## Execution Map

```
Week 1         Week 2         Week 3         Week 4
│              │              │              │
Analyze───────►Execute────────►              │
Error Boundary │  Error Boundary│             │
              │              │              │
Analyze───────►Execute────────►              │
TaskResult     │  TaskResult   │             │
              │              │              │
Analyze───────►Execute────────►              │
Observability  │  Observability│             │
              │              │              │
Semantic──────►Semantic──────►              │
Drift Analyze  │  Drift Execute │             │
              │              │              │
ADR-005/006/007 Draft (parallel throughout)  │
              │              │              │
              │   Audit──────►Formalize─────►│
              │   Workspace   │  Workspace   │
              │              │              │
              │              │  ESLint Rule │
              │              │              │
              │              │  Memory      │
              │              │  Surface     │
              │              │              │
              │              │         Freeze v0.9
```
