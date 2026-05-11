# TASK-CR3 Summary

## 变更
- `src/services/contextLoader.ts` — 新建

## ContextLoader 核心接口

| 方法 | 说明 | 特性 |
|------|------|------|
| `loadTaskLayer(context, task)` | Task → TaskLayer 深拷贝投影 | `JSON.parse(JSON.stringify)` 不引用原对象 |
| `loadSystemLayer(context)` | 初始化默认 policy | 仅 `['llm','image_generation','filesystem.read']` |
| `prepareExecutionLayer(context)` | 创建空 Execution Layer | 惰性创建 |
| `prepareMemoryLayer(context)` | 创建空 Memory Layer | 惰性创建 |
| `prepareSkillLayer(context, skillId?)` | 创建空 Skill Layer | Phase 3 预留，不读文件 |
| `unloadStaleLayers(context)` | 仅卸载 Execution Layer | 返回卸载列表 |
| `estimateLayerSize(layer)` | 近似大小 | `JSON.stringify().length` |

## 验收
- 全部方法同步、无 IO ✅
- `loadTaskLayer` 深拷贝投影（不引用原 Task 对象）✅
- `loadSystemLayer` 仅默认 policy ✅
- `prepareSkillLayer` 空架子，无文件读取 ✅
- `unloadStaleLayers` 仅卸载 execution，不销毁 Context ✅
- `estimateLayerSize` 使用 `JSON.stringify().length` ✅
- `vue-tsc --noEmit` 编译通过 ✅
