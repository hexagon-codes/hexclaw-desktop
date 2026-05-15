# Context: Execution Observability Boundary

**Date**: 2026-05-13
**Session**: ANL-execution-observability-2026-05-13

## Decisions

### Decision 1: Execution Observability — No-Go
- **Context**: 当前 11 个 query APIs + ExecutionLayer 完整状态 + Timeline 4 事件类型 + Workspace 4 投影层已覆盖所有 observability 需求
- **Chosen**: ❌ No-Go — 不进 execute
- **Reason**: 零改动在 stabilization 期间是正确答案。当前边界已正确划定，任何改动都会模糊边界或向 telemetry 退化。

### Decision 2: execution.progress timeline event — 拒绝
- **Context**: Progress event 意味着高频写入，TimelineStore 会从 state history 退化为 progress stream
- **Chosen**: ❌ 拒绝 — 不加入 spec 禁止列表
- **Reason**: Timeline 是 state transition recorder，不是 progress stream

### Decision 3: executor progress callback — 拒绝
- **Context**: 修改 executor interface 污染 adapter shell
- **Chosen**: ❌ 拒绝 — 不修改 executor interface
- **Reason**: 当前 executor 是 stub/adapter shell，无真实进度可报告。未来即使有真实 executor，也应通过 ExecutionLayer.intermediateState 传递

## Constraints

### Locked
1. **不引入 execution.progress timeline event** — Timeline 不进化为 progress stream
2. **不引入高频 timeline event** — Timeline 只记录状态转换
3. **不引入 telemetry system** — Runtime 不是遥测系统
4. **不引入 event bus** — Runtime 不是消息系统
5. **不修改 executor interface** — executor 保持 adapter shell
6. **不做 fake progress** — 不制造虚假进度
7. **不做 streaming state** — 不引入流式状态

### Free
- Workspace projector 可自由新增投影方式（纯函数，不涉及 Runtime Kernel）
- 未来若有真实 executor 产出真实进度，通过现有 `intermediateState` 传递

### Deferred
- **getExecutionState(taskId) 辅助 API** — 待有真实消费者时加入。当前 Workspace 通过 useWorkspace 已获取全部数据
- **Executor progress 上报** — 待 executor stub 被真实实现替换时评估
