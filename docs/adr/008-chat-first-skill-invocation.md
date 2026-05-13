# ADR-008: Chat-first Skill Invocation

**Status**: accepted
**Date**: 2026-05-13

> **Non-frozen**: 此 ADR 记录当前架构事实而非不可变的架构约束。未来如果 Skill 获得非 Chat 入口（如 context-triggered invocation、Runtime-native invoke），此 ADR 可被 supersede。

## Context

Skill 的执行需要一个明确的入口。当前实现中，Skill 只通过 Chat 界面的 `@mention` 语法触发。这个入口路径涉及多个模块的协作，需要形式化记录以保证路径的一致性和可维护性。

核心问题：
1. `@mention` 是唯一的 Skill 触发方式吗？— 当前是
2. invocation 路径是怎样的？— `sendMessage → tryExecuteSkill → executeChatTask`
3. 失败/成功/非 skill 三种情况如何区分？— three-return 语义
4. Skill 执行走 Runtime 还是 WebSocket 路径？— Runtime 路径

## Decision

**Skill 当前唯一执行入口是 Chat @mention，走 tryExecuteSkill → executeChatTask 路径，使用 three-return 语义。**

### Invocation 路径

```
chat-send-controller.ts (sendMessage)
  → skillBridge.ts (tryExecuteSkill)
    → parseSkillInvocation(text)     — @mention 语法解析
    → resolveSkillByName(skillName)   — Registry 查询
    → checkSkillCapabilities()        — Capability Gate (ADR-007)
    → runtimeBridge.ts (executeChatTask)  — Runtime 执行
```

### Three-Return 语义

`tryExecuteSkill` 的返回值类型 `Promise<ChatMessage | null | undefined>`：

| 返回值 | 含义 | 调用方处理 |
|--------|------|-----------|
| `undefined` | 非 skill invocation（无 `@mention`） | 继续正常 chat 流程 |
| `null` | skill invocation 执行失败 | 已调用 `handleSendError`，不继续 chat |
| `ChatMessage` | skill invocation 执行成功 | 追加到 messages，不继续 chat |

调用方代码（`chat-send-controller.ts:156-163`）：

```typescript
const skillMsg = await tryExecuteSkill(text, { createId, messages, sending, draftSending, handleSendError })
if (skillMsg !== undefined) return skillMsg
// 继续正常 chat 流程...
```

### Runtime 路径

Skill 执行走 Runtime 路径而非 WebSocket 路径：

```
tryExecuteSkill → executeChatTask(taskId)
  → runtimeStore.executeTask(taskId)   — 状态机生命周期
  → runtimeStore.getExecutionResult()  — 获取执行结果
  → taskStore.completeTask()           — Task 完成通知
```

## Constraints

- `tryExecuteSkill` 的 three-return 语义不可改变：`chat-send-controller.ts:163` 的 `if (skillMsg !== undefined)` 依赖此语义
- Skill 执行必须通过 `runtimeBridge.executeChatTask` 进入 Runtime，不得直连 `RuntimeStore`
- Skill 执行不走 WebSocket 路径（`deliveryController.deliverMessage`）
- 非 skill 的 chat 消息走 WebSocket 路径，不受此 ADR 影响

## Rejected Alternatives

| Alternative | Reason for Rejection |
|-------------|---------------------|
| Skill 独立 UI 入口（如专用面板） | 过度工程，当前 `@mention` 已满足需求 |
| Context-triggered invocation | 无实际场景，未来需要时可 supersede |
| Runtime-native invoke（绕开 Chat） | 破坏 Chat-Runtime Bridge 边界（ADR-001） |
| WebSocket 路径执行 Skill | 与 Runtime 路径重复，Runtime 路径已提供完整状态机生命周期 |
| tryExecuteSkill 返回 boolean | 无法区分"非 skill"/"失败"/"成功"三种状态 |

## Consequences

- ✅ **零 breaking change**：`@mention` 在 sendMessage 流程中前置检测，非 skill 消息不受影响
- ✅ **复用 Runtime 能力**：Skill 执行复用 `executeChatTask` 的状态机、Timeline、Context 生命周期
- ✅ **路径清晰**：Chat → skillBridge → runtimeBridge，每层职责明确
- ✅ **可替换**：non-frozen 状态允许未来入口演进
- ⚠️ **Chat 耦合**：当前 Skill 只能通过 Chat 触发，非 Chat 场景（如自动化、定时任务）无法直接调用
- ⚠️ **隐式入口**：`@mention` 语法在消息文本中解析，不如显式 API 直观

## Compliance

代码审查时检查：

```bash
# 验证 tryExecuteSkill 的唯一调用点
grep -rn "tryExecuteSkill" src/ --include="*.ts" --include="*.vue"
# 预期输出: src/stores/chat-send-controller.ts:156 — 唯一的调用点
# 不应有其他文件直接 import tryExecuteSkill

# 验证 Chat 不绕过 runtimeBridge 直接调用 Runtime
grep -rn "executeTask" src/stores/chat-send-controller.ts
# 预期输出: 无（executeTask 在 runtimeBridge 中调用）
```

## References

- `src/stores/chat-send-controller.ts:156-163` — `sendMessage` 中 skill invocation 检测 + three-return 处理
- `src/services/skillBridge.ts:91-133` — `tryExecuteSkill` 完整实现（parse → resolve → check → execute）
- `src/services/skillBridge.ts:56-61` — `parseSkillInvocation` @mention 解析
- `src/services/runtimeBridge.ts:77-108` — `executeChatTask` 执行入口

## Cross-References

- ADR-001: Chat-Runtime Bridge Boundary（Skill 执行通过 runtimeBridge 进入 Runtime，遵守 Bridge 边界）
- ADR-007: Capability Gate（Capability pre-check 是 invocation 中的准入步骤，在 tryExecuteSkill 中执行）
