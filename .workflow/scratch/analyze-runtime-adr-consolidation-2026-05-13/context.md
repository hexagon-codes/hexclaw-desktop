# Context: Runtime ADR Consolidation

**Date**: 2026-05-13
**Areas discussed**: ADR inventory, priority, dependency graph, directory structure

## Decisions

### Decision 1: ADR 分层组织
- **Context**: 10 个 ADR 需要结构化管理，避免平面列表
- **Options**:
  1. 三层: Foundation → Execution → Strategy
  2. 平面顺序编号
  3. 按模块分组
- **Chosen**: 三层结构
- **Reason**: 依赖关系是单向的，分层可以清晰表达"基础→衍生→策略"的递进关系

### Decision 2: ADR 编号方案
- **Context**: ADR 需要唯一标识
- **Options**: 1. 顺序数字 001-010; 2. 按层编号 (F01, E01, S01); 3. 按模块缩写 (BRIDGE, AUTH...)
- **Chosen**: 顺序数字 001-010
- **Reason**: 最简单，不暴露分类，允许未来在任意位置插入新 ADR（使用 supersede 机制）

### Decision 3: ADR 写入批次
- **Context**: 10 个 ADR 是否应该一次性写入
- **Options**:
  1. 全部一次写入
  2. 分批写入: 第一批 P0 (4个), 第二批 P1 (2个), 第三批 P2 (2个), P3 按需
- **Chosen**: 分批写入
- **Reason**: P0 ADR 是架构基础，必须优先固化。P1-P2 可以并行。P3 按需。

### Decision 4: ADR 验证机制
- **Context**: ADR 写入后如何确保与代码一致
- **Options**: 1. 代码审查时人工检查; 2. 自动化测试 (ADR-003 对应一个 lint rule); 3. 不验证
- **Chosen**: 代码审查时人工检查 + 关键 ADR 可加 lint rule
- **Reason**: 当前无必要做全自动验证。关键 ADR（如 ADR-003 纯函数约束）未来可加 lint rule

### Decision 5: docs 目录结构
- **Context**: ADR 如何组织在 docs/ 中
- **Options**: 
  1. `docs/adr/` 独立目录
  2. `docs/architecture/` 与架构文档混合
  3. 项目根目录 `adr/`
- **Chosen**: `docs/adr/` 独立目录
- **Reason**: 与 `docs/1.md` 等文档隔离，职责清晰。ADR 有固定 lifecycle，不宜与常规文档混放。

## Constraints

### Locked

1. **ADR 只记录已实现的决策** — 不允许写入"计划中"的架构决策。ADR 是 retrospective 的记录，不是 forward-looking 的 spec。
2. **ADR 必须包含代码引用** — 每个 ADR 至少引用 3 个文件/行号作为证据。
3. **ADR 必须包含 Rationale 和 Rejected Alternatives** — 记录 not only WHAT but WHY and WHY NOT。
4. **命名规范** — `NNN-title-slug.md`，NNN 是三位数顺序号。
5. **ADR 可被 supersede** — 当架构演进后，新 ADR 可以 supersede 旧 ADR，旧 ADR 标记为 superseded 并指向新 ADR。

### Free

1. **ADR template 格式** — 使用标准 MADR 模板还是自定义模板。实施者决定。
2. **ADR 详细程度** — 有的 ADR 可以很简短（ADR-010: "v0.x 不做 workflow"），有的需要详细设计上下文（ADR-001, ADR-004）。
3. **分批写入的顺序** — P0 内部 4 个 ADR 的写入顺序，实施者根据依赖关系安排。

### Deferred

1. **ADR 自动化验证** — 可以考虑未来引入 ADR lint rule（如：检测 workspaceProjector 是否有 store import），但当前不需要。
2. **ADR 与 CLAUDE.md 的同步机制** — 未来可以考虑在 CLAUDE.md 中自动引用活跃 ADR。
3. **ADR 可视化** — 生成 ADR 依赖关系图（Mermaid 等），当前手动维护即可。

## ADR Reference

### Layer 1: Foundation (P0)

| ADR | Title | File | Key Evidence |
|-----|-------|------|-------------|
| 001 | Chat-Runtime Bridge | `docs/adr/001-chat-runtime-bridge.md` | runtimeBridge.ts:1-3, chat.ts imports (no RuntimeStore) |
| 002 | Runtime Authority Ownership | `docs/adr/002-runtime-authority-ownership.md` | runtime.ts:793-829 (no external mutation paths) |
| 003 | Projection Purity | `docs/adr/003-projection-purity.md` | workspaceProjector.ts:1-18 (pure function constraint) |
| 004 | Execution State Machine | `docs/adr/004-execution-state-machine.md` | execution.ts:8-43, runtime.ts:executeTask (state validation) |

### Layer 2: Execution (P1-P2)

| ADR | Title | File | Key Evidence |
|-----|-------|------|-------------|
| 005 | RuntimeBridge Responsibility | `docs/adr/005-runtime-bridge-responsibility.md` | runtimeBridge.ts (coordination, no data ownership) |
| 006 | Session Ownership | `docs/adr/006-session-ownership.md` | chat.ts (no Runtime import), chat-send-controller.ts (bridge-only) |
| 007 | TaskResult Semantics | `docs/adr/007-taskresult-semantics.md` | task.ts:38-39 (minimal discriminated union) |
| 008 | Explicit Persistence | `docs/adr/008-explicit-persistence.md` | runtime.ts (saveContext/saveAll explicit calls) |

### Layer 3: Strategy (P3)

| ADR | Title | File | Key Evidence |
|-----|-------|------|-------------|
| 009 | No Streaming Inside executeTask | `docs/adr/009-no-streaming-inside-executetask.md` | runtime.ts:executeTask (Promise-based model) |
| 010 | No Workflow Runtime (v0.x) | `docs/adr/010-no-workflow-runtime.md` | runtime.ts:executeTask (linear single-task only) |

## Dependency Graph

```
Foundation Layer:
  002 (Authority) ← 003 (Purity)     [no cross-dependency]

Execution Layer:
  004 (State Machine) ← 002
  007 (TaskResult) ← 004

Bridge Layer:
  001 (Bridge) ← 002
  005 (Bridge Resp) ← 001, 004
  006 (Session) ← 001

Strategy Layer:
  008 (Persistence) ← 002
  009 (No Streaming) ← 004
  010 (No Workflow) ← 002
```

**Write order**: `002 → 003 → 004 → 001 → 005/006 → 007/008 → 009/010`

## Recommended Directory Structure

```
docs/
├── adr/
│   ├── README.md                       # ADR index + status legend
│   ├── template.md                     # ADR template
│   ├── 001-chat-runtime-bridge.md
│   ├── 002-runtime-authority-ownership.md
│   ├── 003-projection-purity.md
│   ├── 004-execution-state-machine.md
│   ├── 005-runtime-bridge-responsibility.md
│   ├── 006-session-ownership.md
│   ├── 007-taskresult-semantics.md
│   ├── 008-explicit-persistence.md
│   ├── 009-no-streaming-inside-executetask.md
│   └── 010-no-workflow-runtime.md
└── 1.md                                # 现有文档
```
