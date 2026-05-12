# ADR-004: Execution State Machine

**Status**: accepted
**Date**: 2026-05-13

## Context

Task 执行过程中状态管理需要形式化保证。如果在无约束条件下修改执行状态，可能出现以下非法状态转换：

- 对一个 `completed` 的 Task 再次执行
- 从 `running` 直接跳转到 `preparing`（回退）
- 在 `running` 状态下未设置 `output` 直接标记 `completed`

此外，需要防止嵌套执行（一个 Task 的 `executeTask` 中再调用 `executeTask`），确保执行路径可追踪和可恢复。

## Decision

**Execution 状态机使用 `canTransition()` 严格校验，执行路径为线性单次调用，禁止嵌套/递归。**

状态转换规则：

```
idle → preparing → running → completed
                         ↘→ failed
```

- 所有合法转换在 `EXECUTION_TRANSITIONS` 表中定义
- `executeTask` 内部走完整的状态机生命周期
- 禁止在 `executeTask` 内部再调用 `executeTask`
- Executor 层（`ChatAgentExecutor`）不操作状态机，只负责 `executeWithContext`

## Constraints

- Execution 状态转换必须通过 `canTransition()` 验证
- 禁止嵌套/递归的 `executeTask` 调用
- Executor 层不得写入 `ctx.execution`（状态机是 RuntimeStore 的职责）
- 只有 `ExecutionState` 定义的状态是合法的：
  `'idle' | 'preparing' | 'running' | 'completed' | 'failed'`

## Rejected Alternatives

| Alternative | Reason for Rejection |
|-------------|---------------------|
| 无状态机，用 if-else 控制流程 | 状态空间不明确，遗漏边缘情况 |
| 状态机放在 Executor 内部 | 每个 executor 需要重复实现状态逻辑 |
| 支持嵌套 executeTask | 复杂度过高，递归深度不可控，执行追踪困难 |
| 异步 callback-based 状态转换 | 难以追踪执行状态，错误处理分散 |
| 支持任意状态回退（如 running → preparing） | 掩盖执行错误，不利于排查 |


## Consequences

- ✅ **状态转换类型安全**：`canTransition()` 在运行时校验，防止非法转换
- ✅ **简化 Executor 职责**：执行器只关注业务逻辑，状态管理由 Store 统一处理
- ✅ **Timeline 自动触发**：每个合法转换点对应一个 timeline 事件
- ✅ **错误边界明确**：`running → failed` 是显式的合法转换，错误处理路径清晰
- ⚠️ **状态机定义在 `types/` 而非 Store 中**：类型与实现分离，维护时需注意同步

## Compliance

代码审查时检查：
1. 是否有绕过 `canTransition()` 直接修改 `ctx.execution.state` 的代码
2. `executeTask` 实现中是否出现递归调用
3. 新增 executor 是否遵守"不写 ctx.execution"的约定

## References

- `src/types/execution.ts:8-43` — `ExecutionState`、`ExecutionStage`、`EXECUTION_TRANSITIONS` 定义
- `src/types/execution.ts` — `canTransition()` 验证函数
- `src/stores/runtime.ts:348-437` — `executeTask` 完整实现（~90 行）
- `src/stores/runtime.ts:382-389` — `preparing → running` 的转换验证和状态更新
- `src/stores/runtime.ts:390-420` — `running → completed` / `running → failed` 的分支处理
- `src/services/agentAdapter.ts:92-105` — Executor 约定声明：不写 `ctx.execution.output`、不 append timeline
- `src/services/taskExecutor.ts:33-36` — `ContextAwareExecutor` 接口定义

## Cross-References

- ADR-002: Runtime Authority Ownership（ExecutionLayer 是 RuntimeContext 的一部分，状态管理属于 RuntimeStore authority）
