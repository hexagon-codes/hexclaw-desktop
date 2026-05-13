# ADR-007: Capability Gate

**Status**: accepted
**Date**: 2026-05-13

> **Non-frozen**: 此 ADR 标记为 accepted 而非 frozen baseline。未来 Entitlement 系统可 supersede 此 ADR。

## Context

Skill 执行前需要 capability 校验，防止越权操作。当用户在 Chat 中 `@mention` 一个 Skill 时，该 Skill 声明的 capabilities 需要与系统允许的策略匹配。

关键的架构问题是：**capability pre-check 应该放在哪一层？**

| 候选位置 | 优点 | 缺点 |
|---------|------|------|
| **SkillRegistry** | 靠近数据源 | Registry 职责越界（不做 policy） |
| **SkillLoader** | 加载时即可检查 | 加载阶段尚无执行上下文 |
| **Runtime（executeTask）** | 执行前最后关卡 | 阻断太晚，浪费上下文准备 |
| **skillBridge（invocation 入口）** | 及时阻断 + 职责匹配 | 需要访问 CapabilityValidator |

## Decision

**Capability Gate 位于 skillBridge.ts 的 invocation 入口（tryExecuteSkill），使用 DEFAULT_ALLOWED_CAPABILITIES 作为系统级默认 policy。**

### Gate 位置

```
tryExecuteSkill(text, params):
  1. parseSkillInvocation(text) → null? return undefined
  2. resolveSkillByName(skillName) → undefined? return undefined
  3. checkSkillCapabilities(skillMeta.capabilities) → false? throw Error
  4. executeChatTask(taskId) → 执行
```

Gate 是第 3 步：在 resolve 之后、execute 之前。

### 验证逻辑

```typescript
function checkSkillCapabilities(capabilities: string[]): boolean {
  const { capabilityRegistry, capabilityValidator } = getRuntimeServices()
  const result = capabilityValidator.validate(
    capabilities,
    { allowedCapabilities: DEFAULT_ALLOWED_CAPABILITIES, deniedCapabilities: [] },
    capabilityRegistry,
  )
  return result.valid
}
```

### Policy 来源

`DEFAULT_ALLOWED_CAPABILITIES` 定义在 `capability.ts`：

```typescript
export const DEFAULT_ALLOWED_CAPABILITIES: CapabilityName[] = [
  'llm',
  'image_generation',
  'filesystem.read',
]
```

### 阻断方式

验证失败 → `throw Error` → `tryExecuteSkill` 的 catch 捕获 → `handleSendError` → 返回 `null`

## Constraints

- Capability Gate **不设在 Registry**（职责越界：Registry 只做 discover/cache/resolve）
- Capability Gate **不设在 Loader**（加载阶段尚无执行上下文）
- Capability Gate **不设在 Runtime**（阻断太晚，浪费上下文准备）
- `DEFAULT_ALLOWED_CAPABILITIES` 只做 **allow**，不做 **deny**（deny 策略属于 entitlement）
- `checkSkillCapabilities` 是同步函数，无 IO 操作

## Rejected Alternatives

| Alternative | Reason for Rejection |
|-------------|---------------------|
| Gate 在 Registry（`resolveSkill` 时校验） | Registry 职责越界，违反 ADR-005 |
| Gate 在 Loader（`loadSkill` 时校验） | Loader 只负责加载文件，不涉及 policy |
| Gate 在 Runtime（`executeTask` 前校验） | 阻断太晚：已经完成了上下文准备、Timeline 创建等 |
| 全量 capability whitelist | 过度限制，不利于 Skill 生态发展 |
| deny list 代替 allow list | 安全模型错误：默认应拒绝未显式允许的 capability |

## Consequences

- ✅ **及时阻断**：在 invocation 入口即拒绝，不浪费执行上下文
- ✅ **调用方透明**：`tryExecuteSkill` 内部处理，调用方（`chat-send-controller.ts`）无需感知 capability 逻辑
- ✅ **可 supersede**：non-frozen 状态允许未来 entitlement 系统替代此机制
- ✅ **职责清晰**：Gate 在 skillBridge（协调层），不污染数据层（Registry）或加载层（Loader）
- ⚠️ **DEFAULT_ALLOWED_CAPABILITIES 默认值可能过严或过松**：需要产品反馈调整
- ⚠️ **抛出 Error 而非返回 Result 类型**：调用方需要 catch 处理，类型安全性低于 Result 模式

## Compliance

代码审查时检查：

```bash
# 验证 checkSkillCapabilities 定义在 skillBridge.ts
grep -n "checkSkillCapabilities" src/services/skillBridge.ts || echo "❌ Gate 缺失"

# 验证 Registry/Loader 不包含 capability check
grep -n "capability" src/services/skillRegistry.ts src/services/skillLoader.ts || echo "✅ Registry/Loader 无 capability 逻辑"

# 验证 DEFAULT_ALLOWED_CAPABILITIES 位置
grep -n "DEFAULT_ALLOWED_CAPABILITIES" src/types/capability.ts || echo "❌ Policy 定义缺失"
```

## References

- `src/services/skillBridge.ts:38-46` — `checkSkillCapabilities` 函数定义
- `src/services/skillBridge.ts:115-118` — `tryExecuteSkill` 中 capability pre-check 调用
- `src/types/capability.ts:47-51` — `DEFAULT_ALLOWED_CAPABILITIES` 定义（`['llm', 'image_generation', 'filesystem.read']`）
- `src/services/runtime/runtimeServices.ts:20-28` — `getRuntimeServices()` 提供 `CapabilityValidator` 实例

## Cross-References

- ADR-005: Skill Registry Authority（Registry 提供 capabilities 数据，Gate 消费）
- ADR-008: Chat-first Skill Invocation（Capability Gate 在 tryExecuteSkill 中是 invocation 的准入步骤）
