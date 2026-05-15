# Module 006: execMode Convergence

> 优先级: P1 | 状态: 待设计

---

## 当前现状

- `chat-send-controller.ts` 通过 `execMode` toggle 控制 WS / Runtime 路径
- `execMode === 'runtime'` → RuntimeLLMExecutor
- `execMode !== 'runtime'` → WebSocket (Go backend)
- 两条路径并存，维护成本高

## 目标状态

- 移除 execMode toggle
- 所有 chat 统一使用 Runtime 路径
- WS 路径代码移除（或标记 deprecated）

## 涉及文件

| 文件 | 操作 |
|------|------|
| `src/stores/chat-send-controller.ts` | 修改（移除 execMode 分支） |
| `src/stores/settings.ts` | 修改（移除 execMode setting） |
| `src/services/chatService.ts` | 可能移除 |

## 不允许改动的边界

- 不改 RuntimeStore
- 不改 runtimeBridge
- 不改 TaskBadge
- 不改 skillBridge

## 验收标准

1. tsc 通过
2. 无 execMode toggle UI
3. 所有 chat 使用 Runtime 路径
4. @summarize / @bulletize 正常
5. 普通 chat 正常

## 回滚方式

恢复 execMode toggle 和 WS 分支代码

## 是否需要 Tauri Desktop UAT

**是。** 影响所有 chat 发送路径。
