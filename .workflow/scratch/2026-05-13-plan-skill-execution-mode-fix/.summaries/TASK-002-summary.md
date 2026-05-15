# TASK-002 Summary: agentAdapter.ts — MODE: DIRECT + systemPrompt 修复

## Status: ✅ 已完成

## 改动内容

**文件**: `src/services/agentAdapter.ts`, `src/services/providerAdapter.ts`, `src/services/backendLLMClient.ts`

### agentAdapter.ts — buildPromptInput
- System prompt: 检测 `skillLayer.markdown` 存在时注入 `[MODE: DIRECT]\nOutput directly. No planning. No tool calls.` 前缀 + 净化后 SKILL.md（`summarize` → `摘要`）
- User message: 末尾追加 `[MODE: DIRECT]\nOutput directly. No tool calls. No search. Output immediately.`（兼容 recency bias 模型）
- System Layer constraints 保持原样追加

### agentAdapter.ts — executeWithContext
- Skill 执行时不发送 `systemPrompt`（Go backend 前置拼接会破坏指令顺序，所有指令已通过 `buildPromptInput` 放入 user message 末尾）
- 普通 chat：保持原逻辑不变

### providerAdapter.ts — message 序列化去重
- 当 `systemPrompt` 作为单独字段发送时，message 字符串中排除 `system` role 消息，避免 Go backend 双重拼接

### backendLLMClient.ts — requestId 缓存规避
- `LLMBackendRequest` 接口新增 `requestId?: string` 可选字段
- `send()` 方法自动生成唯一 `requestId`（`llm-{timestamp}-{random}`），传入 `request_id` 参数以规避 Go backend 消息缓存

## 验证

- 所有单元测试通过（65 tests, 3 service test files）
- 6 个 `sendChatViaBackend` API 测试通过

## 发现的关键问题

1. **mimo-v2.5 recency bias**: 模型会忽略 system_prompt 中的指令，只跟随 message 末尾指令 → 需要在 user message 末尾追加 `[MODE: DIRECT]`
2. **Go backend 缓存**: POST /api/v1/chat 根据消息内容缓存响应，即使修复生效也可能返回旧缓存 → 需要唯一 `request_id`
3. **summarize 内置 tool**: Go backend 有内置 `summarize` tool，SKILL.md 中出现的 "summarize" 关键词会触发该 tool 导致模型输出 SKILL.md 内容 → 需要在 prompt 中替换 "summarize" → "摘要"
