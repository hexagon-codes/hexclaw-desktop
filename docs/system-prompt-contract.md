# System Prompt 接口契约

> **状态**: 已定义（前端/tauri 侧已修复，Go backend 待外部仓库实现）
> **更新**: 2026-05-13

---

## 1. 背景

`system_prompt` 是 POST `/api/v1/chat` 的可选字段，用于向 LLM 传递系统级行为指令（如执行模式、角色设定）。

## 2. 接口定义

### POST `/api/v1/chat`

**请求体**:

```json
{
  "message": "user: 用户输入内容",
  "system_prompt": "[MODE: DIRECT]\nOutput directly. No planning. No tool calls.\n\n...技能指令...",
  "session_id": "...",
  "user_id": "...",
  "model": "mimo-v2.5",
  "provider": "anthropic",
  "request_id": "llm-1715000000000-a1b2c3"
}
```

### 字段语义

| 字段 | 类型 | 必填 | 语义 |
|------|------|------|------|
| `message` | string | 是 | 用户消息（不含 system role），格式 `role: content`（仅 user/assistant） |
| `system_prompt` | string | 否 | 系统级指令，作为 LLM API 的 system message（role=system） |
| `request_id` | string | 否 | 唯一请求 ID，用于缓存键区分 |

## 3. 契约规则

### 规则 1：不嵌入 messages 数组

`system_prompt` **不**应被拼接到 `messages[]` 数组中。它应作为 LLM API 调用的独立 system parameter：

```
# ✅ 正确做法
llm.chat({
  system: system_prompt,  // 独立参数
  messages: [
    { role: "user", content: "..." }
  ]
})

# ❌ 错误做法（当前行为）
messages = [
  { role: "system", content: system_prompt },  // 嵌入 message list
  { role: "user", content: "..." }
]
llm.chat({ messages })
```

### 规则 2：不作为缓存键

`system_prompt` 值**不参与**消息缓存 key 的计算。同一 `message` 不同 `system_prompt` 应视为不同请求（由 `request_id` 区分）。

### 规则 3：保持原文

`system_prompt` 值不应被转义、截断、或做任何内容变换。前端已负责净化（如 `summarize` → `摘要` 替换）。

### 规则 4：可选向后兼容

如果保持当前前置拼接行为，`message` 中 **不包含** `system: ` 前缀的内容（前端已处理：`systemPrompt` 存在时过滤 `system` role）。

## 4. Go backend Handler 改动指南

### 当前行为

```go
// 当前: 前置拼接 system_prompt 到 messages
if req.SystemPrompt != "" {
    messages = append([]Message{{Role: "system", Content: req.SystemPrompt}}, messages...)
}
```

### 期望行为

```go
// 期望: system_prompt 作为 LLM API 独立参数
var system string
if req.SystemPrompt != "" {
    system = req.SystemPrompt
}
response, err := llm.Chat(system, messages, opts...)
```

## 5. 验证方法

| 场景 | 输入 | 预期 |
|------|------|------|
| system_prompt + message | system_prompt="[MODE: DIRECT]", message="user: 摘要..." | LLM 收到 system 角色指令 + user 消息，system_prompt 不拼入 messages |
| request_id 缓存区分 | 相同 message + 不同 request_id | 不命中缓存，重新请求 LLM |
| 无 system_prompt | message="user: 你好" | 正常 chat，不受影响 |

## 6. 状态追踪

| 组件 | 状态 | 说明 |
|------|------|------|
| 前端 providerAdapter.ts | ✅ 已兼容 | systemPrompt truthy 时 message 过滤 system role |
| 前端 backendLLMClient.ts | ✅ 已支持 | 发送 system_prompt 字段 + request_id |
| Tauri commands.rs | ✅ 已支持 | BackendChatParams.system_prompt + POST body 转发 |
| Go backend (hexclaw) | ❌ 待修复 | 外部仓库，待实现规则 1-4 |
