# ADR-001: Chat-Runtime Bridge Boundary

**Status**: accepted
**Date**: 2026-05-13

## Context

Chat（UI/UX 领域）和 Runtime（执行引擎领域）是两个独立的子系统，各自有不同的核心概念：

| 维度 | Chat | Runtime |
|------|------|---------|
| 核心概念 | Session、Message、Stream | Task、Context、Layer、Timeline |
| 状态模式 | Vue Ref（响应式） | ContextManager Map（非响应式） |
| 通讯方式 | WebSocket（流式） | Promise-based（同步调用） |

如果 Chat 直接访问 RuntimeStore，会导致：
1. **领域耦合**：Chat 感知 Runtime 的 Context/Layer/Timeline 概念
2. **Session 泄漏**：Runtime 被 Chat 的 Session 概念污染
3. **测试成本**：Chat 测试需要 RuntimeStore 环境
4. **演进阻力**：Runtime 内部重构会影响 Chat

需要一层明确的 anti-corruption layer 隔离两个领域。

## Decision

**`runtimeBridge.ts` 是 Chat 和 Runtime 之间的唯一边界。**

具体规则：
- **Chat 层不得直接导入 `useRuntimeStore` 或 `@/stores/runtime`**
- **Runtime 层不得导入 Chat 类型（`ChatMessage`、`ChatSession` 等）**
- **所有跨域通信必须通过 `runtimeBridge.ts`**
- Bridge 函数是协调者（coordination），不是数据拥有者（ownership）
- Bridge 封装了 RuntimeStore 和 TaskStore 之间的生命周期同步

## Constraints

- `chat.ts` 和 Chat 域代码禁止导入 `useRuntimeStore` 或 `@/stores/runtime`
- Runtime 域代码禁止导入 Chat 类型（`@/types/chat` 中的 Session/Message 类型）
- 所有跨域通信必须通过 `runtimeBridge.ts`
- Bridge 函数不得积累状态（它们是协调逻辑，不是数据持有者）
- 新增跨域操作：添加到 `runtimeBridge.ts`，不得直接访问对方 store

## Rejected Alternatives

| Alternative | Reason for Rejection |
|-------------|---------------------|
| Chat 直接 `import useRuntimeStore` | Chat.ts 已验证无此导入。会导致领域耦合 |
| Runtime 直接感知 Session | Session 是 Chat UX 概念，Runtime 不应知道 |
| 通过事件总线耦合 | 隐式耦合，调试困难，类型不安全 |
| Adapter 模式（ChatRuntimeAdapter class） | 当前 bridge 的低级函数接口已足够，class 封装过度设计 |
| 共享类型层（common types） | 两个领域的概念本质不同，强行共享类型会产生误导 |


## Consequences

- ✅ **Chat.ts 零 Runtime 导入**：已验证所有 import 语句无 `@/stores/runtime`
- ✅ **Runtime 零 Session 意识**：`taskId` 在 bridge 层映射，不穿透到 Runtime
- ✅ **双路径共享接口**：`sendMessage` 中 Runtime 和 WebSocket 两条路径共用相同 `sendMessage` 签名
- ✅ **Anti-corruption layer**：Bridge 封装了两个领域的类型差异
- ⚠️ **Bridge 膨胀风险**：随着新功能添加，bridge 可能演变为"万能管道"，应定期审查其职责边界
- ⚠️ **协调复杂度**：`executeChatTask` 协调了 RuntimeStore + TaskStore 两个 store，如果协调逻辑复杂化，应考虑提取为 service

## Compliance

代码审查时运行以下验证：

```bash
# 验证 Chat 不导入 RuntimeStore
grep -r "from '@/stores/runtime'" src/stores/chat*.ts || echo "✅ Chat 无 Runtime 导入"

# 验证 Runtime 不导入 Chat 类型
grep -r "from '@/types/chat'" src/services/runtime* src/stores/runtime.ts || echo "✅ Runtime 无 Chat 类型导入"
```

## References

- `src/services/runtimeBridge.ts:1-3` — Bridge 设计原则声明（文件头注释）
- `src/services/runtimeBridge.ts:28-31` — `registerChatTask(task)`
- `src/services/runtimeBridge.ts:34-37` — `completeChatTask(taskId, output)`
- `src/services/runtimeBridge.ts:40-43` — `failChatTask(taskId, error)`
- `src/services/runtimeBridge.ts:56-82` — `executeChatTask(taskId)` 完整执行协调
- `src/stores/chat.ts` — 所有 import 语句（验证无 `@/stores/runtime`）
- `src/stores/chat-send-controller.ts:6` — Bridge 是唯一边界：`import { registerChatTask, ... } from '@/services/runtimeBridge'`
- `src/stores/chat-send-controller.ts:163-222` — Task 生命周期注册 + Runtime/WS 两条执行分支

## Cross-References

- ADR-002: Runtime Authority Ownership（Bridge 调用 RuntimeStore 的方法，Store 的 authority 模型决定了 Bridge 的 API 设计）
- ADR-003: Projection Purity（Projection 层提供 Runtime → UX 的纯转换，Bridge 相反：是 UX → Runtime 的命令通道）
