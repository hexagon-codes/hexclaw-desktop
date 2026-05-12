# ADR-003: Projection Purity

**Status**: accepted
**Date**: 2026-05-13

## Context

Workspace UI 需要消费 Runtime 数据（Task 状态、Context 详情、Timeline 事件、Narrative 分组、Task 执行结果）。但投影层（Runtime 类型 → UX 类型）如果直接访问 Pinia store，会导致：

1. **测试困难**：每个投影调用需要 mount Pinia store 或提供 mock
2. **UI-Runtime 耦合**：UI 组件直接接触 Runtime 内部类型
3. **复用性差**：投影逻辑无法被非 UI 消费者使用（日志导出、WebSocket handler 等）
4. **隐含的副作用风险**：投影函数中可能出现意外的 store mutation

需要一个明确的、可测试的、无副作用的投影层隔离 Runtime 和 UI。

## Decision

**`workspaceProjector.ts` 是纯函数层，执行以下严格约束：**

- **零 store 导入**：不得 `import` 任何 `@/stores/*`
- **零副作用**：不修改输入参数，不写入全局状态，不触发事件
- **零 async**：所有投影函数是同步的，不执行 IO 操作
- **纯数据转换**：只做 Runtime 类型 → UX 类型的映射、格式化和截断

## Constraints

- `workspaceProjector.ts` 中禁止 `import` 任何 `@/stores/*`
- 投影函数必须返回新对象，不得修改输入参数
- 投影函数必须是同步的（不返回 `Promise`）
- 需要 store 查询的复杂聚合逻辑必须在调用方组合，不在 projector 中执行

## Rejected Alternatives

| Alternative | Reason for Rejection |
|-------------|---------------------|
| 投影函数直接 `import useRuntimeStore` | 测试需要 mount Pinia，投影和 UI 紧耦合 |
| UI 组件直接消费 RuntimeContext | 每个组件需要理解 Runtime 内部结构，类型升级影响 UI |
| 投影层用 class（new Projector()） | 实例化需要容器管理，过度设计 |
| 投影层支持 async/IO | 破坏了纯转换的语义边界，测试复杂度增加 |
| TypeScript `type` 转换（直接 as） | 只做了类型断言，没有实际数据格式化和业务转换 |

## Consequences

- ✅ **独立可测试**：所有投影函数可以纯调用测试，无需 mocking stores
- ✅ **UI 类型安全**：UI 只消费 `WorkspaceTaskProjection` 等 UX 类型，不接触 RuntimeContext
- ✅ **消费者无关**：投影逻辑可被任意消费者复用（UI、日志、WebSocket 等）
- ✅ **RuntimeContext 升级友好**：Internal 结构变化只需修改投影函数，不影响 UI
- ⚠️ **聚合能力受限**：需要跨 context 查询的聚合逻辑必须在调用方组合（调用方可能变复杂）
- ⚠️ **投射不充分的诱惑**：如果投影输出不满足 UI 需求，开发者可能绕过投影直接读 RuntimeContext

## Compliance

代码审查时检查 `workspaceProjector.ts` 的 `import` 语句：

```ts
// ✅ 允许：pure types, pure utils（import type 在编译期被擦除，不违反运行时纯度）
import type { RuntimeContext, RuntimeEvent } from '@/types'
import { formatTime } from '@/utils/format'

// ❌ 禁止：any store import
import { useRuntimeStore } from '@/stores/runtime'   // VIOLATION
import { useWorkspaceStore } from '@/stores/workspace' // VIOLATION
```

**未来可加 ESLint 规则**：禁止 `workspaceProjector.ts` 从 `@/stores` 的导入。

## References

- `src/services/workspaceProjector.ts:1-18` — 纯函数约束声明（文件头注释）
- `src/services/workspaceProjector.ts:71` — `projectTask(task, summary?)` → `WorkspaceTaskProjection`
- `src/services/workspaceProjector.ts:114` — `projectContext(ctx)` → `WorkspaceContextProjection`
- `src/services/workspaceProjector.ts:281` — `projectTimeline(events)` → `TimelineItemProjection[]`
- `src/services/workspaceProjector.ts:378` — `projectTimelineNarrative(events)` → `TimelineNarrativeGroup[]`
- `src/services/workspaceProjector.ts:492` — `projectTaskResult(task, ctx?)` → `TaskResultProjection | null`
- `src/types/workspace.ts:1-218` — 5 个投影输出类型定义

## Cross-References

（当前 Wave 1 无直接关联 ADR。未来 ADR 涉及 UI 消费投影结果时，应引用此 ADR 的纯度约束。）
