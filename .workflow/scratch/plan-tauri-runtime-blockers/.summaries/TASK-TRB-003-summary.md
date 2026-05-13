# TASK-TRB-003 Summary: agentAdapter skill 路径使用真实 systemPrompt

## Status: ✅ 已完成

## 改动内容

**文件**: `src/services/agentAdapter.ts`

### executeWithContext 方法（line 135-144）

**改动前**:
```typescript
// skill 执行：不发送 systemPrompt（Go backend 前置拼接会破坏指令顺序）
const isSkill = !!context.skill?.markdown
const result = await this.provider.execute({
  messages, model, provider,
})
```

**改动后**:
```typescript
// skill 执行：使用真实 systemPrompt 独立字段，不嵌入 message 字符串。
// providerAdapter.ts 在 systemPrompt truthy 时会自动过滤 system role，
// 避免 Go backend 前置拼接导致重复。
const isSkill = !!context.skill?.markdown
const result = await this.provider.execute({
  messages, model, provider,
  systemPrompt: isSkill ? prompt.system : undefined,
})
```

### 数据流

```
agentAdapter.executeWithContext(skill mode)
  → provider.execute({ systemPrompt: "[MODE:DIRECT]\nSKILL.md", messages: [system, user] })
  → providerAdapter.ts: systemPrompt truthy → 过滤 system role from message string
  → message = "user: 输入\n\n[MODE: DIRECT]..."
  → backendLLMClient.send({ system_prompt, message, request_id })
  → commands.rs: system_prompt + message + request_id → POST body
  → Go backend: system_prompt prepend (已兼容) + message
  → LLM: 收到 system role 指令 + user input ✅
```

## 验证

- `npx tsc --noEmit` 通过 ✅
- 向后兼容: 非 skill 模式 `systemPrompt: undefined` → 行为不变
- providerAdapter 无需修改（现有 `systemPrompt truthy → filter system role` 逻辑已覆盖）

## 设计决策

- 复用 providerAdapter.ts 现有去重逻辑（systemPrompt truthy 时过滤 system role）
- 不新增架构元素，纯参数传递改动
