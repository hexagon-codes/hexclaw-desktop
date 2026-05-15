# 分析: Execution Observability Boundary

**Session**: ANL-execution-observability-2026-05-13
**Date**: 2026-05-13
**Spec**: `docs/1.md`
**Type**: Boundary analysis

---

## 1. Observability Boundary Map

```
┌─────────────────────────────────────────────────────────────────┐
│                     Runtime Kernel                               │
│                                                                  │
│  TimelineStore (append-only)    ContextManager                   │
│  ┌─────────────────────────┐   ┌─────────────────────────────┐  │
│  │ execution.prepared     │   │ ExecutionLayer {            │  │
│  │ execution.started      │   │   state, stage, stepCount,  │  │
│  │ execution.completed    │   │   startedAt, completedAt,   │  │
│  │ execution.failed       │   │   output, error             │  │
│  │ task.*, skill.*, ...   │   │ }                           │  │
│  └─────────────────────────┘   └─────────────────────────────┘  │
│         ▲                              ▲                         │
│         │        RuntimeStore Query API                          │
│         │                                                        │
│  getTaskTimeline()   getActiveContext()   getContextSummary()    │
│  getRecentEvents()   getEventsByType()    getExecutionResult()   │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
              Workspace Projector (纯函数)
              ┌────────────────────────────┐
              │ projectContext()           │
              │   → execution section      │
              │ projectTimeline()          │
              │   → 5 categories           │
              │ projectTimelineNarrative() │
              │   → grouped narrative      │
              │ projectTaskResult()        │
              │   → result items           │
              └────────────────────────────┘
                           │
                           ▼
              useWorkspace composable
              ┌────────────────────────────┐
              │ selectedContextProjection  │
              │ selectedTimelineProjection │
              │ selectedNarrativeProjection│
              │ selectedResultProjection   │
              └────────────────────────────┘
                           │
                           ▼
              UI 组件 (ContextDetailPanel, TimelinePanel, etc.)
```

### 边界线

| 侧 | 内容 | 归属 |
|----|------|------|
| **Runtime semantic state** | ExecutionLayer state machine, Timeline 事件 | Runtime Kernel |
| **Projection layer** | 格式转换、分类、叙事分组 | `workspaceProjector.ts` |
| **Composable** | 数据装配、selectedTaskId 状态 | `useWorkspace.ts` |
| **UI view** | 渲染、动画、i18n | `.vue` 组件 |

**当前边界清晰，职责分离正确。** Runtime 不直接暴露给 UI，所有跨层数据经过 projector 翻译。

---

## 2. Existing Observable State Inventory

### 2.1 RuntimeStore Query APIs（已存在）

| API | 返回 | 行 | 用途 |
|-----|------|----|------|
| `getActiveContext(taskId)` | `RuntimeContext \| undefined` | 330 | 完整 Context（含 ExecutionLayer） |
| `getContextSummary(taskId)` | `ContextSummary \| undefined` | 335 | 轻量摘要 |
| `getExecutionResult(taskId)` | `TaskResult \| undefined` | 341 | 仅输出 |
| `getTaskTimeline(taskId)` | `RuntimeEvent[]` | 449 | 单 Task 事件列表 |
| `getRecentEvents(count)` | `RuntimeEvent[]` | 455 | 最近 N 事件 |
| `getEventsByType(type)` | `RuntimeEvent[]` | 461 | 按类型过滤 |
| `getAssetSummary(taskId)` | asset summary | 584 | 资产摘要 |
| `assessRecovery(taskId)` | `RecoveryAssessment \| null` | 633 | 恢复评估 |
| `detectCorruption(taskId)` | `CorruptionReport \| null` | 645 | 损坏检测 |
| `getRecoverySummary(taskId)` | `RecoverySummary \| null` | 673 | 恢复摘要 |
| `getResolutionState(taskId)` | `'pending'\|'resolved'\|'failed'` | 683 | 解决状态 |
| `contextSummaries` (computed) | `ContextSummary[]` | 65 | 全部活跃 Context 摘要 |

### 2.2 ExecutionLayer 状态（RuntimeContext.execution）

```typescript
interface ExecutionLayer {
  state: ExecutionState           // 'idle' | 'preparing' | 'running' | 'completed' | 'failed'
  currentStage: ExecutionStage    // 'preparing' | 'executing' | 'finalizing'
  stepCount: number               // bounded integer
  startedAt?: string              // ISO
  completedAt?: string            // ISO
  intermediateState: {            // 轻量中间状态
    progress?: number
    lastUpdate?: string
  }
  output?: TaskResult
  error?: { code: string; message: string }
}
```

### 2.3 Timeline 事件（execution 相关）

| 事件类型 | 触发时机 | 频率 |
|----------|----------|------|
| `execution.prepared` | prepareExecutionLayer | 每次 executeTask × 1 |
| `execution.started` | state → running | 每次 executeTask × 1 |
| `execution.completed` | state → completed | 每次成功 × 1 |
| `execution.failed` | state → failed | 每次失败 × 1 |

### 2.4 Workspace Projections

| Projection | 消费 | 暴露的 execution 信息 |
|------------|------|----------------------|
| `projectContext(ctx).execution` | ContextDetailPanel | state, stage, stepCount, elapsed |
| `projectTimeline(events)` | TimelinePanel | 5 categories, 20 event types |
| `projectTimelineNarrative(events)` | NarrativeTimeline | 7 phases, 3 significance levels |
| `projectTaskResult(task, ctx)` | Outputs section | result items |

---

## 3. Runtime Semantic vs UI/Debug Distinction

### ✅ Runtime Semantic State（属于 Runtime Kernel）

| 状态 | 理由 |
|------|------|
| `execution.state` | State machine 核心状态，驱动生命周期 |
| `execution.currentStage` | 当前执行阶段（有限枚举） |
| `execution.stepCount` | 轻量执行步数（bounded integer） |
| `execution.startedAt` / `completedAt` | 时间戳，不可变记录 |
| `execution.output` / `error` | 执行结果/错误 |
| `execution.intermediateState.progress` | 轻量进度（有真实 source 时） |
| Timeline events | 状态转换记录 |

### ❌ UI / Debug View（不应进入 Runtime）

| 事项 | 理由 |
|------|------|
| Elapsed time formatting | `formatElapsed()` 已在 projector 中，纯 UI |
| Progress bar animation | Vue 响应式驱动，Runtime 不关心 |
| Narrative grouping | `projectTimelineNarrative()` 是投影逻辑 |
| i18n labels | `TYPE_LABELS` 映射在 projector 中 |
| Timeline categories | `CATEGORY_MAP` 20→5 是投影逻辑 |
| Narrative phases | `PHASE_MAP` 是投影逻辑 |
| Collapsed/expanded state | UI 组件内部状态 |

**结论：当前分离基本正确。** `workspaceProjector.ts` 作为 formal boundary，所有 UI 投影逻辑已经在 projector 中，Runtime kernel 不泄露 UI 细节。

---

## 4. 逐条回答 Spec 10 个重点问题

### Q1: 当前 Runtime 已有哪些 execution state 可查询
见 §2 Inventory。11 个 query APIs + ExecutionLayer 完整状态 + Timeline 事件。**已相当完备。**

### Q2: 哪些 observability 属于 Runtime semantic state
见 §3 列表。核心是 ExecutionLayer 字段 + Timeline 状态转换事件。

### Q3: 哪些只是 UI/debug view，不应进入 Runtime
见 §3 ❌ 列表。已全部隔离在 projector/composable/UI 层。

### Q4: 是否真的需要 execution.progress timeline event
**不需要。** 理由：
- 当前 4 个 execution 事件（prepared/started/completed/failed）已覆盖完整生命周期
- progress event 意味着高频写入，TimelineStore 会退化进度流
- Timeline 是 state transition recorder，不是 progress stream
- spec 明确禁止

### Q5: 是否需要 executor progress callback
**不需要。** 理由：
- 当前 executor 都是 stub/adapter shell，无真实进度可报告
- 修改 executor interface 违反 spec 约束
- 未来即使有真实 executor，也应通过 ExecutionLayer.intermediateState 传递，而非 callback

### Q6: 是否可以只做 query API，而不做 progress event
**可以，且当前已是这样。** RuntimeStore 已有 11 个 query API，全部为同步查询：
- `getActiveContext()` → 轮询 execution.state / intermediateState
- `getTaskTimeline()` → 查询历史事件
- `getContextSummary()` → 轻量摘要

这些 API 已经是 polling 模式，不需要 event-driven progress。

### Q7: getExecutionState(taskId) 是否足够
**当前 query APIs 已足够。** 
- `getActiveContext(taskId)` 返回完整 ExecutionLayer
- `getContextSummary(taskId)` 返回轻量摘要
- 专用 `getExecutionState()` 是冗余封装

但如果要最小化外部对 RuntimeContext 的依赖，新增 `getExecutionState(taskId)` 返回 `{ state, stage, stepCount, progress, startedAt, completedAt }` 可进一步缩小 API surface。

### Q8: Workspace/Narrative 是否已有足够投影
**是，投影覆盖已全面：**
- Context 投影有 execution section（state/stage/stepCount/elapsed）
- Timeline 投影有 20 事件 → 5 类别
- Narrative 投影有 7 phase 分组
- Result 投影有结果条目

没有 missing projection。`projectContext()` 的 execution section (`workspaceProjector.ts:161-170`) 已包含所有必要字段。

### Q9: 哪些 observability 会导致 Runtime 变成 telemetry system

| 事项 | 为什么危险 |
|------|-----------|
| execution.progress timeline event | 高频写入，Timeline 从 state history 退化为 progress stream |
| executor progress callback | executor interface 污染，每个 executor 需实现进度上报 |
| streaming state | 需要缓冲区、背压、消费者管理 |
| event bus | 引入 pub/sub，Runtime 变成消息系统 |
| telemetry pipeline | 需要采样、聚合、导出、存储 |
| tool call traces | 执行细节不属于 Runtime state machine |
| token-level logging | 过于细粒度，纯 debug 用途 |

**边界原则：** 如果某个 observability 需要"持续写入"而非"记录一次状态转换"，就属于 telemetry。

### Q10: 最小可执行方案是什么

**零改动。** 当前 observability 已满足 stabilization P0 需求：

```
RuntimeStore query APIs     ✅ 11 APIs
ExecutionLayer state        ✅ 7 fields
Timeline events             ✅ 4 execution types
Workspace projections       ✅ 4 projections
Composable data assembly    ✅ useWorkspace
```

无需新增任何代码。Workspace 已经可以通过 `useWorkspace().selectedContextProjection.execution` 获取完整执行状态。

---

## 5. Query API 提案（仅供参考，建议不执行）

```
// 如果要最小化 RuntimeContext 的外部依赖，可新增：
function getExecutionState(taskId: string): {
  state: ExecutionState
  stage: ExecutionStage
  stepCount: number
  progress?: number
  startedAt?: string
  completedAt?: string
} | undefined {
  const ctx = manager.getContext(taskId)
  if (!ctx?.execution) return undefined
  return {
    state: ctx.execution.state,
    stage: ctx.execution.currentStage,
    stepCount: ctx.execution.stepCount,
    progress: ctx.execution.intermediateState?.progress,
    startedAt: ctx.execution.startedAt,
    completedAt: ctx.execution.completedAt,
  }
}
```

**但当前不推荐加入。** 原因：
- 没有消费者需要这个 API（Workspace 已通过 useWorkspace 获取全部数据）
- 新增 API 增加维护负担，无实际收益
- spec 要求 analyze only

---

## 6. 是否需要 execute

### Go/No-Go: ❌ No-Go — 不进 execute

**理由：**

1. **已有足够 observability** — 11 个 query APIs + ExecutionLayer 完整状态 + Timeline 事件 + 4 层 Workspace projections。没有 observability gap。
2. **禁止事项全面覆盖需求** — spec 列出的 7 项禁止（progress event、高频 event、telemetry system、event bus、executor interface、fake progress、streaming state）全部是正确判断。没有任何一项是当前需要的。
3. **零改动是正确答案** — 执行 observability boundary 已经正确划定。任何改动都会模糊边界或向 telemetry 方向退化。

### 明确拒绝的方案（spec 要求的第 7 项输出）

| 方案 | 拒绝理由 |
|------|----------|
| execution.progress timeline event | Timeline 退化进度流，违反 Timeline 契约 |
| executor progress callback | 污染 executor interface，当前无真实 executor |
| telemetry system | Runtime 职责外，spec 禁止 |
| event bus | 引入 pub/sub 复杂度，无消费者 |
| streaming state | 需要缓冲区/背压/消费者管理 |
| fake progress | 制造虚假进度，降低系统可信度 |
| getExecutionState API | 零消费者，纯冗余封装 |

---

## 7. Stabilization P0 剩余状态

```
✅ Error Boundary formalization         → runtime-error-boundary-v0.1
✅ TaskResult Consumer Survey            → Hold（不进 execute）
❌ Execution Observability Boundary      → No-Go（不进 execute，当前已足够）
⬜ WS/RT semantic drift closure          → 待 analyze
```

---

## 结论

**Execution Observability 边界已正确划定，不进 execute。** 当前系统已具备足够的 observable state：RuntimeStore 有 11 个 query API，ExecutionLayer 有 7 个字段，Timeline 有 4 个 execution 事件类型，Workspace 有 4 个投影层覆盖所有消费场景。

剩余 P0 项目：**WS/RT semantic drift closure** — 建议进入 analyze。
