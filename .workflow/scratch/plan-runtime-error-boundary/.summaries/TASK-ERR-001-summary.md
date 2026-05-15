# TASK-ERR-001 — executeTask re-throw + revision.value++ finally

## 实现摘要

### 修改文件
- `src/stores/runtime.ts` (lines 406-438)

### 变更内容

**修改 1**: catch 块末尾添加 `throw e`
- 修复第一层错误丢失问题
- `executeTask` 现在会 re-throw 原始异常，让调用方（`executeChatTask` in `runtimeBridge.ts`）能够接收到实际的执行错误，而不是收到 `undefined` 后生成合成错误"执行完成但无输出结果"
- 所有现有 catch 逻辑完整保留：state='failed'、error/status 写入、loader.writeExecutionMemory、manager.recalcSize、timeline 事件

**修改 2**: `revision.value++` 移入 `finally` 块
- 原位置：try-catch 块之后单独一行（line 436）
- 新位置：`finally { revision.value++ }`
- 保证无论成功还是失败，revision 都会递增

### 修改后结构

```typescript
try {
  // 成功路径（不变）
} catch (e) {
  // 1. running → failed 状态转换
  // 2. execution error 写入
  // 3. task error 写入
  // 4. loader.writeExecutionMemory
  // 5. manager.recalcSize
  // 6. timeline 事件
  throw e    // 新增：re-throw
} finally {
  revision.value++   // 从 catch 之后移入
}
```

### 验证
- `npx tsc --noEmit` — 编译通过，无错误

## 收敛准则达成情况

- [x] catch 块末尾有 `throw e`（re-throw 原始错误）
- [x] `finally` 块包含 `revision.value++`
- [x] 原始 catch 逻辑完整保留（execution state='failed'、error/status 写入、timeline 事件）
- [x] `npx tsc --noEmit` 编译通过
- [x] 未修改其他文件
- [x] 未修改 TaskResult 类型
- [x] 所有现有注释保持原样

## 后续任务依赖

### 可供下游使用的变更
```typescript
// executeTask 现在会 re-throw 错误
// 调用方可以捕获到原始 ExecutionError，而非合成错误
await runtime.executeTask(taskId)  // throws on failure
```

### 集成说明
- `executeChatTask`（`runtimeBridge.ts`）现在可以通过 `try/catch` 捕获到 `executeTask` 抛出的原始错误
- `e.message` 将从实际执行错误的 message 而非合成文案"执行完成但无输出结果"
- 后续 TASK-ERR-002 将处理 `BridgeError` 类型映射（`EXECUTION_FAILED` → `ApiErrorCode`）

## 状态：已完成
