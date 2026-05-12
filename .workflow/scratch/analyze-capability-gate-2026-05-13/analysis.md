# Capability Gate 接入分析

> 分析日期：2026-05-13
> 上下文：@mention Skill Invocation P0 已完成，需为 skill execute 添加 capability 权限控制

---

## 1. 现有基础设施

### 已就位

| 组件 | 位置 | 状态 |
|------|------|------|
| `CapabilityRegistry` | `src/services/capabilityRegistry.ts` | ✅ lazy init singleton |
| `CapabilityValidator` | `src/services/capabilityValidator.ts` | ✅ 3-stage rule chain |
| `getRuntimeServices()` | `src/services/runtime/runtimeServices.ts` | ✅ 服务定位器 |
| `DEFAULT_ALLOWED_CAPABILITIES` | `src/types/capability.ts:47` | `['llm', 'image_generation', 'filesystem.read']` |
| `SystemLayer.policy` | `src/types/context.ts:51` | `allowedCapabilities[]` + `deniedCapabilities[]` |
| `BUILTIN_CAPABILITIES` | `src/types/capability.ts:21` | 18 个内置 cap 包括 `skill.execute`/`skill.discover`/`skill.load` |

### Runtime 侧已有验证

`runtime.ts:216-238` 在 Skill Layer 加载时执行 capability validation：

```typescript
const { capabilityRegistry, capabilityValidator } = getRuntimeServices()
const validation = capabilityValidator.validate(
  skillPkg.meta.capabilities,
  { allowedCapabilities: ctx.system?.policy.allowedCapabilities ?? [],
    deniedCapabilities: ctx.system?.policy.deniedCapabilities ?? [] },
  capabilityRegistry,
)
if (!validation.valid) {
  // 只 warn，不 block（Phase 4 策略）
}
```

### skillBridge 侧缺口

当前 `tryExecuteSkill` 的 P0 实现直接调 `executeChatTask`，无 capability pre-check：

```typescript
// src/services/skillBridge.ts — P0 (no cap check)
export async function tryExecuteSkill(text, params) {
  // ... parse, lookup ...
  const result = await executeChatTask(taskId)  // ← 直接执行，无 cap check
  // ...
}
```

---

## 2. 设计方案

### 方案 A（推荐）：skillBridge 侧 pre-check

在 `executeChatTask` 之前插入 capability validation。

```
tryExecuteSkill
  → parse @mention
  → resolve skill (get SkillMeta.capabilities[])
  → CAPABILITY CHECK ← 新增
  → executeChatTask
```

```typescript
// skillBridge.ts 新增
import { getRuntimeServices } from './runtime/runtimeServices'
import { DEFAULT_ALLOWED_CAPABILITIES } from '@/types/capability'

function checkSkillCapabilities(skillMeta: SkillMeta): CapabilityValidationResult {
  const { capabilityRegistry, capabilityValidator } = getRuntimeServices()
  return capabilityValidator.validate(
    skillMeta.capabilities ?? [],
    {
      allowedCapabilities: DEFAULT_ALLOWED_CAPABILITIES,
      deniedCapabilities: [],
    },
    capabilityRegistry,
  )
}
```

**优点**：
- 最小改动：skillBridge.ts 加 10-15 行
- 无 Runtime Kernel 修改
- 不 import RuntimeStore
- 阻塞执行（Phase 4 → Phase 1 策略转变）

**缺点**：
- policy 来自硬编码 default，非 RuntimeContext SystemLayer
- 和 Runtime 侧的 validation 冗余

### 方案 B（未来）：task type = 'skill' 触发 Runtime 侧验证

修改 `tryExecuteSkill` 创建 Task 时 type 为 `'skill'`，让 Runtime 的 `loadSkillLayer` 自动触发 cap check。

**不推荐的 P0 理由**：
- 需要 Runtime 新增 `skill` task type 支持 — 违反"不新增 Runtime 概念"
- 当前 `executeChatTask` 写死 `type: 'chat'`
- Chat 层不应控制 Runtime 的 task type

---

## 3. 决策

### 方案 A 的细化

**Policy 来源策略**（分层 fallback）：

```
1. 优先：getRuntimeStore() 的 active context system policy
   → 但 skillBridge 不能 import RuntimeStore（ADR-001）
2. Fallback：DEFAULT_ALLOWED_CAPABILITIES（hardcoded）
   → P0 方案
3. 未来：通过 runtimeBridge 暴露 getSystemPolicy()
   → 需新增 bridge API
```

**P0 决策**：使用 `DEFAULT_ALLOWED_CAPABILITIES` + `getRuntimeServices()`。

这意味着 P0 cap gate 不区分 per-session policy，所有 skill 共享同一个默认 policy。当需要 per-session policy 时，再走方案 3。

**验证失败处理**：直接阻塞执行，返回错误消息给用户。

```typescript
const capResult = checkSkillCapabilities(skillMeta)
if (!capResult.valid) {
  // 阻塞执行，返回错误（不调用 executeChatTask）
  throw new Error(`Skill not authorized: ${capResult.warnings.join('; ')}`)
}
```

**为什么 P0 可以阻塞**：
- Chat-first flow 是用户主动 `@mention` 调用的，阻塞是预期的行为
- Runtime 的 Phase 4（只 warn 不 block）是为 background 场景设计的
- Chat 层需要明确的"可以/不可以"反馈

---

## 4. 变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/services/skillBridge.ts` | 修改 | 新增 `checkSkillCapabilities()` + `tryExecuteSkill` 插入调用 |
| `src/services/runtime/runtimeServices.ts` | 不修改 | `getRuntimeServices()` 已够用 |
| `src/types/capability.ts` | 不修改 | `DEFAULT_ALLOWED_CAPABILITIES` 已定义 |
| `src/services/capabilityRegistry.ts` | 不修改 | |
| `src/services/capabilityValidator.ts` | 不修改 | |
| `src/stores/runtime.ts` | 不修改 | |
| `src/services/runtimeBridge.ts` | 不修改 | |

### 代码变更量估算

**skillBridge.ts 新增约 15 行**：
```typescript
// + import
import { getRuntimeServices } from './runtime/runtimeServices'
import { DEFAULT_ALLOWED_CAPABILITIES } from '@/types/capability'

// + 1 个纯函数
function checkSkillCapabilities(capabilities: string[]): CapabilityValidationResult {
  const { capabilityRegistry, capabilityValidator } = getRuntimeServices()
  return capabilityValidator.validate(capabilities, {
    allowedCapabilities: DEFAULT_ALLOWED_CAPABILITIES,
    deniedCapabilities: [],
  }, capabilityRegistry)
}

// + tryExecuteSkill 中约 3 行插入
const capResult = checkSkillCapabilities(skillMeta.capabilities ?? [])
if (!capResult.valid) {
  throw new Error(`Capability check failed: ${capResult.warnings.join('; ')}`)
}
```

---

## 5. 风险与边界

| 风险 | 等级 | 缓解 |
|------|------|------|
| `DEFAULT_ALLOWED_CAPABILITIES` 中不含 `skill.execute` | 🟡 Medium | 当前 default 有 `skill.execute`（line 37, capability.ts），确认包含 |
| `getRuntimeServices()` 引入 Runtime 耦合 | 🟢 Low | 仅 import 服务定位器，非 RuntimeStore，不违反 ADR-001 |
| 验证失败后 skill 无法执行 | 🟢 Low | 预期行为 — 展示明确错误消息 |
| 运行时 policy 与 default 不一致 | 🟡 Medium | P1 通过 `runtimeBridge` 暴露 `getSystemPolicy()` 解决 |

---

## 6. 实施建议

**P0 就绪** — 可以立即进入 `/maestro-plan`：

- 修改 `skillBridge.ts`，新增 `checkSkillCapabilities` 函数
- 在 `tryExecuteSkill` 中 `resolveSkillByName` 成功后、`executeChatTask` 前插入调用
- 验证失败时 throw Error（`handleSendError` 捕获）

**范围**：约 15 行代码，单文件修改，无新文件，无 Runtime 变更。

---

## 7. 决策记录

| ID | 决策 | 类型 | 依据 |
|----|------|------|------|
| CG1 | skillBridge 侧 pre-check | Locked | 最小改动，不违反 ADR-001 |
| CG2 | P0 policy 使用 DEFAULT_ALLOWED_CAPABILITIES | Locked | 无 RuntimeContext 依赖，不引入 per-session policy |
| CG3 | 验证失败阻塞执行（不 warn） | Locked | Chat-first 需要明确"可以/不可以"反馈 |
| CG4 | 通过 getRuntimeServices() 获取 registry/validator | Locked | 已有服务定位器，非 RuntimeStore |
| CG5 | per-session policy 通过 runtimeBridge 暴露 | P1 | 等真实 per-session 需求 |
