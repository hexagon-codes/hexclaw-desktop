# Skill Execution Mode Boundary — Analysis

**Session**: ANL-skill-execution-mode-2026-05-13
**Date**: 2026-05-13

---

## Root Cause Confirmation

### Root Cause 1: system_prompt 在 Tauri 桥接层丢失

```
agentAdapter.ts           providerAdapter.ts          backendLLMClient.ts         commands.rs
ChatAgentExecutor ──→  BackendChatProvider ──→  BackendLLMClient.send ──→  backend_chat(command)
  executeWithContext      execute(payload)            invoke('backend_chat',      BackendChatParams
  no systemPrompt ──→    systemPrompt: undefined ──→  system_prompt: null ──→   NO system_prompt field
  field passed            passed to send()             sent to Rust                → DROPPED
```

**证据链**:
- `providerAdapter.ts:28` — `ChatCompletionPayload` 有 `systemPrompt?: string` 字段
- `providerAdapter.ts:78-84` — `BackendChatProvider.execute()` 已实现 `systemPrompt: payload.systemPrompt`
- `agentAdapter.ts:125` — `ChatAgentExecutor.executeWithContext()` **从未传递 `systemPrompt`**
- `backendLLMClient.ts:43` — 已实现 `system_prompt: req.systemPrompt ?? null`
- `commands.rs:299-312` — `BackendChatParams` **无 `system_prompt` 字段**

**验证**: curl 直接调用 Go backend `/api/v1/chat` 传入 `system_prompt` 成功影响 LLM 输出，证明 Go 后端支持。

### Root Cause 2: 无执行模式约束

`ChatAgentExecutor.executeWithContext()` 将 SKILL.md 与 user message 简单拼接后发送给通用 chat LLM。LLM 的默认 agentic behavior（plan-then-execute）覆盖了 skill 指令。

**UAT 验证结果**:
- 短输入 (<100字): LLM 输出直接摘要（但无 [§N] 格式）
- 长输入 (>270字): LLM 输出计划模板后卡死
- 无任何运行产出符合 SKILL.md 要求的 [§N] 格式

### Root Cause 3: Skill task 走了 chat executor

`skillBridge.ts:131` 创建 `type: 'chat'` task，Runtime resolve 为 `ChatAgentExecutor`。 `SkillTaskExecutor` 虽已定义但从未使用。

---

## 最小修复方案

### Scheme A: 修复 system_prompt 传递链 (核心)

**涉及文件 (4个)**:

| 文件 | 改动 | 行数 |
|------|------|------|
| `src/services/agentAdapter.ts` | `executeWithContext` 传递 `systemPrompt` | +1 |
| `src-tauri/src/commands.rs` | `BackendChatParams` 新增 `system_prompt` 字段 + 转发到 POST body | +5 |
| `src/services/backendLLMClient.ts` | 无需改动（已实现 `system_prompt: req.systemPrompt ?? null`） | 0 |
| `src/services/providerAdapter.ts` | 无需改动（已实现 `systemPrompt: payload.systemPrompt`） | 0 |

**agentAdapter.ts 改动**:
```typescript
// 第 125 行附近
const systemMsg = messages.find(m => m.role === 'system')
const result = await this.provider.execute({
    messages,
    systemPrompt: systemMsg?.content,  // ← 新增
    model,
    provider,
})
```

**commands.rs 改动**:
```rust
// BackendChatParams 新增字段
pub struct BackendChatParams {
    pub message: String,
    pub system_prompt: Option<String>,  // ← 新增
    // ...
}

// POST body 转发
if let Some(ref sp) = params.system_prompt {
    if !sp.is_empty() {
        body["system_prompt"] = serde_json::json!(sp);
    }
}
```

**效果**: SKILL.md 作为独立 `system_prompt` 发送到 Go backend → LLM 收到权威系统指令。

**风险**: 
- 低 — 纯新增字段，不改现有逻辑
- Go backend 对 `system_prompt` 的处理质量依赖其实现（已验证基本支持）

### Scheme B: Scheme A + Provider 层 execution mode 注入

在 Scheme A 基础上，在 `buildPromptInput` 中为 skill 上下文添加执行模式前缀。

**涉及文件 (1个追加)**:

| 文件 | 改动 | 行数 |
|------|------|------|
| `src/services/agentAdapter.ts` | `buildPromptInput` 检测 skill 上下文注入 mode 前缀 | +5 |
| 同上 Scheme A | systemPrompt 传递 | +1 |

**agentAdapter.ts:buildPromptInput 改动**:
```typescript
export function buildPromptInput(context: RuntimeContext): PromptInput {
    const parts: string[] = []
    if (skillLayer?.markdown) {
        parts.push(`[MODE: DIRECT]
You MUST output directly. Do NOT plan. Do NOT describe steps.
Do NOT use tools. Output the summary immediately.`)
        parts.push(skillLayer.markdown)
    }
    // ...
}
```

**效果**: LLM 既收到权威 system_prompt，又收到显式执行模式指令。

**风险**:
- 低 — 纯 prompt 层改动
- 依赖 LLM 遵循指令（但作为 system_prompt 发送，权威性大幅提升）

### Scheme C: Scheme B + 温控参数

在 Scheme B 基础上，为 skill 执行设置低 temperature 以抑制发散。

**涉及文件 (1个追加)**:

| 文件 | 改动 | 行数 |
|------|------|------|
| `src/services/agentAdapter.ts` | `executeWithContext` 传 `temperature: 0.3` | +1 |

**效果**: 更低随机性 → 更严格遵循格式约束。

**风险**:
- 极低 — 纯参数调整

---

## 方案对比

| 维度 | Scheme A | Scheme B | Scheme C |
|------|----------|----------|----------|
| 改动文件 | 2 | 2 | 2 |
| 新增代码行 | ~6 | ~11 | ~12 |
| system_prompt 修复 | ✅ | ✅ | ✅ |
| execution mode 约束 | ❌ | ✅ | ✅ |
| 温控抑制发散 | ❌ | ❌ | ✅ |
| Runtime 污染 | 无 | 无 | 无 |
| 新类型/新概念 | 无 | 无 | 无 |
| 向后兼容 | ✅ | ✅ | ✅ |
| LLM 遵循置信度 | 中 | 高 | 高 |

---

## 推荐方案: Scheme B

**理由**:
1. 修复 system_prompt 传递链是必要条件（否则 SKILL.md 永远不是权威指令）
2. execution mode 前缀是 5 行代码的 prompt 工程，零架构风险
3. 不需要新增 `SkillTaskExecutor`、`SkillTask`、`Workflow` 等任何新概念
4. 不修改 Runtime Constitution
5. 保持 chat executor 不变，skill 仅通过 prompt 差异获得不同行为

**后续步骤**: 进入 `maestro-plan` 执行修复 + UAT 验证

---

## 涉及文件清单 (最终)

| # | 文件 | 改动类型 | Scheme |
|---|------|---------|--------|
| 1 | `src/services/agentAdapter.ts` | `buildPromptInput` + mode prefix, `executeWithContext` + systemPrompt | B |
| 2 | `src-tauri/src/commands.rs` | `BackendChatParams.system_prompt` field + POST body forward | B |
| 3 | `src/services/providerAdapter.ts` | 无需改动 | — |
| 4 | `src/services/backendLLMClient.ts` | 无需改动 | — |

---

## 风险矩阵

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| Go backend 忽略 system_prompt | 低 | system_prompt 无效，回退当前状态 | 已验证 Go backend 支持 |
| LLM 仍不遵循 execution mode | 中 | [§N] 仍不可达 | 作为独立 system_prompt 权威性远高于当前 |
| system_prompt 导致普通 chat 行为变化 | 极低 | 非 skill 路径不设 systemPrompt | mode 前缀仅在 skill layer 存在时注入 |
| Rust 编译失败 | 极低 | 构建阻塞 | 标准 Option<String> serde 字段 |

---

## 是否进入 maestro-plan

**推荐**: 是 — Scheme B

**执行的 Plan task**:
1. `commands.rs` — 新增 `system_prompt: Option<String>` + POST body 转发
2. `agentAdapter.ts` — `buildPromptInput` execution mode prefix
3. `agentAdapter.ts` — `executeWithContext` systemPrompt 传递
4. UAT 验证 — @summarize 长输入产生带 [§N] 的摘要
