# TASK-ERR-002 — BridgeError type + error mapping + executeChatTask refactor

## Implementation Summary

### Files Modified
- `src/services/runtimeBridge.ts`: Added BridgeError types and error mapping, refactored executeChatTask error handling

### Content Added
- **BridgeErrorCode** (`src/services/runtimeBridge.ts:23`): Type with values `'EXECUTION_FAILED' | 'NO_OUTPUT'`, representing Runtime Bridge layer error codes.
- **BridgeError** (`src/services/runtimeBridge.ts:26-30`): Interface with `code: BridgeErrorCode`, `message: string`, `cause?: unknown` — structured Bridge layer error object.
- **bridgeErrorToApiError()** (`src/services/runtimeBridge.ts:33-39`): Mapping function that converts `BridgeError` to `ApiError`, mapping `EXECUTION_FAILED` and `NO_OUTPUT` both to `'SERVER_ERROR'`. Uses `createApiError` from `@/utils/errors`.

### Content Modified
- **executeChatTask() catch block** (`src/services/runtimeBridge.ts:100-107`): Changed from bare `throw e` to creating a `BridgeError` with code `'EXECUTION_FAILED'`, then converting via `bridgeErrorToApiError` before rethrowing as `ApiError`.
- **executeChatTask() NO_OUTPUT branch** (`src/services/runtimeBridge.ts:87-91`): Changed from `throw new Error(...)` to creating a `BridgeError` with code `'NO_OUTPUT'`, calling `taskStore.failTask`, then throwing via `bridgeErrorToApiError`.

## Convergence Criteria Verification

| # | Criteria | Status |
|---|----------|--------|
| 1 | `BridgeErrorCode` type with `EXECUTION_FAILED` and `NO_OUTPUT` | Done |
| 2 | `BridgeError` interface with code, message, cause | Done |
| 3 | `bridgeErrorToApiError` mapping to SERVER_ERROR | Done |
| 4 | executeChatTask catch uses BridgeError | Done |
| 5 | executeChatTask throws ApiError via bridgeErrorToApiError | Done |
| 6 | NO modifications to src/types/error.ts, src/utils/errors.ts, src/stores/chat-stream-error.ts | Verified |
| 7 | `npx tsc --noEmit` compiles without errors | Done |

## Key Changes

- **Bridge layer now has explicit error types** instead of using bare `Error` objects, enabling callers (`handleSendError`, `fromNativeError`) to properly recognize error codes.
- **Error propagation chain**: `BridgeError` (code: `EXECUTION_FAILED`/`NO_OUTPUT`) -> `bridgeErrorToApiError` -> `ApiError` (code: `SERVER_ERROR`) -> caller's error handler.
- Imports added: `createApiError` from `@/utils/errors`, `ApiError` type from `@/types/error`.

## Status: Complete
