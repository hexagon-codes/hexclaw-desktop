# ADR-002: Runtime Authority Ownership

**Status**: accepted
**Date**: 2026-05-13

## Context

Runtime 系统中，ContextManager 持有所有执行上下文（`Map<string, RuntimeContext>`）。如果允许多个 mutation 源直接操作 ContextManager，会引发以下问题：

1. **状态不一致**：两个调用方同时对同一个 Context 写入不同字段
2. **Revision 不同步**：Vue 响应式依赖 `revision` 计数器，漏掉的 bump 导致 UI 静默失效
3. **Timeline 事件丢失**：关键生命周期事件应被自动记录到 TimelineStore
4. **可测试性下降**：如果每个 composable 都直接操作 ContextManager，测试需要完整的 Pinia 环境

需要一个明确的单一突变点来集中管控所有 Context 变更。

## Decision

**RuntimeStore 是 ContextManager 的唯一拥有者和唯一突变入口。**

具体规则：
- ContextManager 实例由 RuntimeStore 在 setup 阶段创建，不暴露给外部
- 所有 context CRUD 操作以 RuntimeStore 方法的形式暴露
- Composable 层只计算 patch 并返回给 Store，由 Store 执行实际 mutation
- Revision 计数器在每次 mutation 后由 Store 统一递增
- Timeline 事件由 Store 在每个生命周期点统一触发

## Constraints

- 任何绕过 RuntimeStore 直接修改 ContextManager 的行为都是禁止的
- Composables 不得导入 ContextManager、Pinia 或 TimelineStore
- 所有 context mutation 必须通过 RuntimeStore 的方法进行
- 每次 mutation 必须 bump revision（除非是纯持久化操作，由 `saveContext`/`saveAll` 显式调用）

## Rejected Alternatives

| Alternative | Reason for Rejection |
|-------------|---------------------|
| 每个 composable 直接修改 ContextManager 的 Map | Context 所有权分散，revision 管理不可靠 |
| ContextManager 自带发布-订阅模式 | 与 Vue 响应式系统重复，增加不必要的复杂性 |
| 多层 mutation authority（Store + Service + UI 直写） | 边界模糊，代码审查无法有效把关 |
| ContextManager 直接暴露为 Pinia store 的 state | 破坏封装，任何 import useRuntimeStore 的组件都可直接修改上下文 |

## Consequences

- ✅ **单一突变点**：所有 Context 变更可审计、可追溯
- ✅ **Revision 管理集中化**：在单点控制计数器递增，减少遗漏风险
- ✅ **Timeline 触发自动化**：生命周期事件在 Store 方法中统一触发
- ✅ **Composable 可测试性**：patch 计算是纯函数，无需 Pinia 环境即可测试
- ⚠️ **路径变长**：所有 mutation 必须通过 RuntimeStore，对简单操作增加了间接层
- ⚠️ **运行期检查缺失**：如果忘记 bump revision，没有编译期机制检测

## Compliance

代码审查时检查：
1. 是否有外部代码直接调用 `manager.getContext()` 或 `manager.updateLayer()`
2. 新增的 composable 是否导入了 Pinia 或 TimelineStore
3. 所有 mutation 路径是否都 bump 了 `revision.value`

未来可考虑为 `revision` bump 添加自动化检测（如 Proxy 封装 ContextManager）。

## References

- `src/stores/runtime.ts:33-48` — RuntimeStore 实例化 ContextManager、TimelineStore 和 composables
- `src/stores/runtime.ts:793-829` — RuntimeStore 导出的 29 个公共方法，所有 context 操作经 Store
- `src/services/contextManager.ts:1-272` — ContextManager 是纯 class，无 Pinia 依赖，被 Store 封装
- `src/stores/runtime.ts:520` — `useAssetRuntime` 返回 asset patch → Store 应用并 bump revision
- `src/stores/runtime.ts:612` — `useRecoveryRuntime` 返回 recovery patch → Store 应用并 bump revision
- `src/stores/runtime.ts revision` 机制 — revision bump 确保 computed 在 UI 层重算
- `src/services/runtime/timelineStore.ts:1-133` — TimelineStore append-only 设计

## Cross-References

- ADR-001: Chat-Runtime Bridge Boundary（依赖 ADR-002 的 Authority 概念）
- ADR-004: Execution State Machine（依赖 ADR-002 的 Context 所有权）
