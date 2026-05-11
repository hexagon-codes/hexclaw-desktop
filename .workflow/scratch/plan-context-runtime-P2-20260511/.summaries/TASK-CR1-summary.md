# TASK-CR1 Summary

## 变更
- `src/types/context.ts` — 新建，5 层接口 + RuntimeContext + ContextSummary
- `src/types/index.ts` — 追加 Context 类型导出

## 验收
- `ContextLayerStatus = 'unloaded' | 'loading' | 'loaded' | 'error'` ✅
- `SystemLayer` 含 `policy.allowedCapabilities` ✅
- `SkillLayer` 含 `skillId/skillName` ✅
- `TaskLayer` 含 `taskId/taskType/status/input/output` ✅
- `ExecutionLayer` 含 `toolResults[]/intermediateState` ✅
- `MemoryLayer` 含 `userConfirmations[]/historicalResults[]/generatedAssets[]` ✅
- `RuntimeContext` 含 5 层（可选）+ `layerStates` ✅
- `ContextSummary` 含 `loadedLayers/status` ✅
- `src/types/index.ts` 导出所有 Context 类型 ✅
- `vue-tsc --noEmit` 编译通过 ✅
