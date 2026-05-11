# TASK-CR2 Summary

## 变更
- `src/services/contextManager.ts` — 新建

## ContextManager 核心接口

| 方法 | 说明 |
|------|------|
| `createContext(taskId, taskType)` | 创建 Context + 初始化 System Layer |
| `destroyContext(taskId)` | 销毁并从 Map 移除 |
| `getContext(taskId)` | 查询 Context |
| `loadLayer(taskId, layerName)` | 标记层为 loaded |
| `unloadLayer(taskId, layerName)` | 清数据 + 标记 unloaded |
| `updateLayer(taskId, layerName, data)` | 合并更新层数据 |
| `getLayer(taskId, layerName)` | 获取层引用 |
| `isLayerLoaded(taskId, layerName)` | 检查层状态 |
| `getActiveContextCount()` | 活跃 Context 数 |
| `getAllContextIds()` | 所有活跃 taskId 列表 |

## 验收
- 10 个方法全部实现 ✅
- 同 taskId 重复 createContext 不覆盖（隔离规则）✅
- totalEstimatedSize 随层操作自动更新 ✅
- `vue-tsc --noEmit` 编译通过 ✅
