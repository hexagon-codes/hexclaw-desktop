# TASK-ERR-003 — Update runtime-execute-path-pilot.test.ts for Error Boundary changes

## Implementation Summary

### Files Modified
- `src/__tests__/runtime-execute-path-pilot.test.ts`: 添加新测试，验证 ApiError 传播和 BridgeError 映射

### Content Added
- **ApiError 传播测试** (`src/__tests__/runtime-execute-path-pilot.test.ts:133`): 验证 `executeTask` 失败时 `executeChatTask` 抛出 `ApiError`（code=SERVER_ERROR）
- **bridgeErrorToApiError 测试套件** (`src/__tests__/runtime-execute-path-pilot.test.ts:156`): 验证 `EXECUTION_FAILED` 和 `NO_OUTPUT` 到 `SERVER_ERROR` 的映射
- **Import 扩展** (`src/__tests__/runtime-execute-path-pilot.test.ts:51`): 新增 `bridgeErrorToApiError` 导入

## 测试结果

- 现有测试 6 个：全部通过（无需修改）
- 新增测试 3 个：全部通过
  - `executeTask 失败时抛出 ApiError（code=SERVER_ERROR）` — 验证 `rejects.toMatchObject({ code: 'SERVER_ERROR', message: 'LLM 服务不可用' })`
  - `maps EXECUTION_FAILED to SERVER_ERROR` — 验证纯函数映射
  - `maps NO_OUTPUT to SERVER_ERROR` — 验证纯函数映射
- TypeScript 编译：`npx tsc --noEmit` 无错误

## 不变项

- `TaskResult` 类型未修改（仍为 `{ kind: 'text'; content: string }`）
- 无 `src/types/task.ts` 变更
- 无 `src/types/error.ts` 变更（ApiErrorCode 未扩展）
- 所有原有测试行为保持一致

## 验证标准

- [x] `mockGetExecutionResult` 返回类型使用现有 `TaskResult { kind:'text'; content:string }`（未扩展）
- [x] 测试验证 executeTask 失败 → ApiError（code=SERVER_ERROR）
- [x] 测试验证 bridgeErrorToApiError 映射（EXECUTION_FAILED → SERVER_ERROR）
- [x] `npm run test:unit -- --run src/__tests__/runtime-execute-path-pilot.test.ts` 全部通过
- [x] `npx tsc --noEmit` 编译无错误

## Status: Complete
