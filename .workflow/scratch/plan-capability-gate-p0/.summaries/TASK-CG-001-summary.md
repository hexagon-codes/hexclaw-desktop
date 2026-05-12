# TASK-CG-001 Summary

**Title**: skillBridge.ts 添加 Capability Gate pre-check
**Status**: completed

## Changes

**File**: `src/services/skillBridge.ts` (+17 行)

1. **Import** `getRuntimeServices` from `./runtime/runtimeServices` (line 16)
2. **Import** `DEFAULT_ALLOWED_CAPABILITIES` from `@/types/capability` (line 17)
3. **Internal helper** `checkSkillCapabilities(capabilities)` (lines 38-46)
   - Uses `getRuntimeServices()` → `capabilityValidator.validate()`
   - Policy: `DEFAULT_ALLOWED_CAPABILITIES`
   - Not exported
4. **Capability pre-check** in `tryExecuteSkill` (lines 115-118)
   - Inserted after `resolveSkillByName` success, before `executeChatTask`
   - Fails with `throw Error` → caught by existing catch → `handleSendError` → `return null`
   - Three-return semantics unchanged

## Verification

| Criterion | Result |
|-----------|--------|
| `checkSkillCapabilities` exists without export | ✅ |
| Still exactly 3 exported functions | ✅ (parseSkillInvocation, resolveSkillByName, tryExecuteSkill) |
| `npx tsc --noEmit` passes | ✅ |
