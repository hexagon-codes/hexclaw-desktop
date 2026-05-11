# TASK-CR5 Summary

## 变更
- `src/services/taskExecutor.ts` — 新增 ContextAwareExecutor 接口 + 桩 + 工厂

## ContextAwareExecutor 接口

```typescript
export interface ContextAwareExecutor extends TaskExecutor {
  executeWithContext(task: Task, context: RuntimeContext): Promise<TaskOutput>
}
```

## 验收
- `ContextAwareExecutor` 接口定义 ✅
- `ChatTaskExecutor implements ContextAwareExecutor` + executeWithContext 桩 ✅
- `AgentTaskExecutor implements ContextAwareExecutor` + executeWithContext 桩 ✅
- `SkillTaskExecutor implements ContextAwareExecutor` + executeWithContext 桩 ✅
- `createContextAwareExecutor(type)` 工厂函数 ✅
- 现有 `createExecutor` 工厂保持向后兼容 ✅
- 无 UnifiedExecutor ✅
- 无真实执行链路 ✅
- `vue-tsc --noEmit` 编译通过 ✅
