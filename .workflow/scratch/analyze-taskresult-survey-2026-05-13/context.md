# Context: TaskResult Consumer Survey

**Date**: 2026-05-13
**Session**: ANL-taskresult-survey-2026-05-13

## Decisions

### Decision 1: TaskResult 不进 execute
- **Context**: Consumer survey 显示无实际非-text 需求，所有 executor 只产出 text
- **Chosen**: ⏸️ Hold — 不进 execute 阶段
- **Reason**: 代价 > 收益。扩展 TaskResult 需改 6 个构造点、评估 10+ 消费者。当前无实际需求信号。P1 优先级排在 P0（WS/RT 语义漂移、Execution observability）之后。

### Decision 2: 前置加固 — projectTaskResult else 分支
- **Context**: workspaceProjector.ts 当前仅处理 `kind === 'text'`，无 else 分支。若未来新增 kind 会静默丢失。
- **Chosen**: ✅ 建议在下次修改 workspaceProjector.ts 时追加 else 分支
- **Reason**: 防御性编程，防止未来扩展时的静默丢失

### Decision 3: 前置加固 — executor stub 返回 null result
- **Context**: taskExecutor.ts 中 4 处 stub 返回 `{ result: null, artifacts: [] }`，与 TaskOutput.result: TaskResult 类型语义不一致
- **Chosen**: ⏸️ 低优先级修复。stub 未被真实调用，无实际影响。
- **Reason**: Stabilization 期间不值当为一个无实际影响的类型不一致花时间

## Constraints

### Locked
1. **TaskResult 保持 `{ kind: 'text'; content: string }`** — 不扩展，不新增 kind
2. **不做 UI 层新 kind 支持** — image/audio/video/file/tool_call 全部禁止
3. **result.content 消费者不改** — 现有 5 处硬依赖保持不动

### Free
- 可在 `workspaceProjector.ts` 追加 else 分支（不改现有逻辑）
- 可在 `taskExecutor.ts` 修复 stub 返回类型（不影响业务）

### Deferred
- **TaskResult error kind 扩展** — 待有实际需求信号后评估（如 Bridge 需要直接传递结构化错误）
- **TaskResult code kind 扩展** — 待有 code-producing executor 出现
- **tool_call kind** — 待 executor 真正产出 tool_call
- **ResultItemProjection 前置设计与 TaskResult 的适配** — ResultKind 7 种是 UI 前瞻，不需要 TaskResult 扩展来驱动
