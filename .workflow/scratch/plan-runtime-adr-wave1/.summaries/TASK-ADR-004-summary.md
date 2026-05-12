# Summary: TASK-ADR-004

**Status**: completed
**Wave**: 2
**Date**: 2026-05-13

## Created

- `docs/adr/004-execution-state-machine.md` — Execution State Machine ADR

## Key Content

- **Decision**: canTransition() 校验状态机，禁止嵌套/递归执行，Executor 不操作状态机
- **Constraints**: canTransition 验证、禁止嵌套 executeTask、Executor 不写 ctx.execution
- **Rejected Alternatives**: if-else 控制流、Executor 内部状态机、嵌套 executeTask、callback-based
- **Code References**: execution.ts（状态 + 转换表）、runtime.ts executeTask（~90 行）、agentAdapter executor 约定
- **Cross-References**: ADR-002

## Verification

- [x] 包含完整的 ExecutionState 和合法转换描述
- [x] 包含 executeTask 的状态机实现路径
- [x] 包含 nested execution 禁止声明
- [x] 包含 Executor 层的约束
- [x] Cross-References 包含 ADR-002
