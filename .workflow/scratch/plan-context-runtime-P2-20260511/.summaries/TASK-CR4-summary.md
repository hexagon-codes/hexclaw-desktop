# TASK-CR4 Summary

## 变更
- `src/stores/runtime.ts` — 新建 (Pinia store)
- `src/composables/useContextRuntime.ts` — 新建 (Vue composable)
- `src/stores/index.ts` — 追加 useRuntimeStore 导出

## RuntimeStore 公共接口

| 方法 | 参数 | 行为 |
|------|------|------|
| `registerContextForTask(task)` | Task | 创建 Context + 加载 System + Task Layer |
| `updateContextFromTask(task)` | Task | 刷新 Task Layer 投影 |
| `completeContextForTask(taskId, output)` | string, TaskOutput | 更新 output/status + 卸载 execution |
| `failContextForTask(taskId, error)` | string, TaskError | 更新 error/status |
| `destroyContext(taskId)` | string | 从响应式 Map 移除 |
| `loadContextLayer(taskId, layerName)` | string, string | 标记层 loaded |
| `unloadContextLayer(taskId, layerName)` | string, string | 清数据 + 标记 unloaded |
| `getActiveContext(taskId)` | string | 返回 RuntimeContext |
| `getContextSummary(taskId)` | string | 返回 ContextSummary |
| `activeContexts` | computed | 所有活跃 Context 列表 |
| `activeContextCount` | computed | 数量 |
| `contextSummaries` | computed | 摘要列表 |

## useContextRuntime 导出

| 函数 | 返回 | 说明 |
|------|------|------|
| `useActiveContext(taskId)` | `ComputedRef<RuntimeContext>` | 响应式追踪指定 Context |
| `useContextSummaries()` | `ComputedRef<ContextSummary[]>` | 响应式追踪所有摘要 |
| `useContextSummary(taskId)` | `ComputedRef<ContextSummary>` | 响应式追踪指定摘要 |

## 验收
- 9 个显式方法全部实现 ✅
- 无 watch 自动绑定 ✅
- `reactive(Map)` 确保 computed 正确追踪 ✅
- `registerContextForTask` 只加载 System + Task ✅
- `completeContextForTask` 只更新 output/status + 卸载 execution ✅
- `failContextForTask` 只更新 error/status ✅
- `destroyContext` 才真正销毁 ✅
- `vue-tsc --noEmit` 编译通过 ✅
