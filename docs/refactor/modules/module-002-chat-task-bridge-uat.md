# Module 002: Chat-Task Bridge UAT

> 优先级: P0 | 状态: 已实现，待 Tauri 验证

---

## 当前现状

- Wave 1 (chat-task-bridge-v0.1) 已实现 TaskBadge
- metadata 注入在 skillBridge.ts 和 chat-send-controller.ts
- ChatView.vue 渲染 TaskBadge（v-if taskId）
- 但依赖 Module 001（Skill Directory Alignment）才能真正生效

## 目标状态

- @summarize → 消息 + TaskBadge（skill name + completed + elapsed）
- @bulletize → 消息 + TaskBadge
- 普通 chat → 无 badge
- 点击 TaskBadge → /workspace?taskId=xxx

## 涉及文件

已实现（无新改动）：
- `src/components/chat/TaskBadge.vue` — 新增
- `src/services/skillBridge.ts` — metadata 注入
- `src/stores/chat-send-controller.ts` — metadata 注入
- `src/views/ChatView.vue` — TaskBadge 渲染

## 不允许改动的边界

- 不改 RuntimeStore
- 不改 runtimeBridge
- 不改 Prompt / MODE:DIRECT

## 验收标准

1. tsc 通过
2. 普通 chat：无 TaskBadge
3. @summarize：TaskBadge 显示 "Summarize" + "completed" + 耗时
4. @bulletize：TaskBadge 显示 "Bulletize" + "completed" + 耗时
5. 点击 TaskBadge：跳转 /workspace?taskId=xxx

## 回滚方式

```bash
git revert chat-task-bridge-v0.1
```

## 是否需要 Tauri Desktop UAT

**是。** 必须在 Tauri 环境中端到端验证。
