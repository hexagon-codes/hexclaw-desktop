# Module 005: Runtime LLM Contract

> 优先级: P1 | 状态: 待执行

---

## 当前现状

- `agentAdapter.ts` 中硬编码 MODE:DIRECT system prefix / user suffix
- skill markdown sanitization 内联在 `buildPromptInput`
- skill / non-skill prompt assembly 逻辑混在同一函数

## 目标状态

- 新增 `src/services/llmContract.ts`
- 提取 MODE:DIRECT、sanitization、prompt assembly 为独立模块
- `agentAdapter.ts` 只调用 contract helper

## 涉及文件

| 文件 | 操作 |
|------|------|
| `src/services/llmContract.ts` | 新增 |
| `src/services/agentAdapter.ts` | 修改 |

## 不允许改动的边界

- 不改 RuntimeStore
- 不改 runtimeBridge
- 不改 taskExecutor 路由
- 不改 providerAdapter
- 不改 SKILL.md 内容

## 验收标准

1. tsc 通过
2. normal chat: systemPrompt 仍 undefined
3. @summarize: 仍有 MODE:DIRECT + user suffix
4. @bulletize: 同上
5. buildPromptInput 行为等价

## 回滚方式

删除 `llmContract.ts`，恢复 `agentAdapter.ts`

## 是否需要 Tauri Desktop UAT

**是。**
