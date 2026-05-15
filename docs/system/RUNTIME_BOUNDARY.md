# RUNTIME_BOUNDARY

> Runtime 边界文档  
> Version: v0.2  
> Date: 2026-05-14  
> Purpose: 约束 Runtime / UI / Skill / Transport 各层职责，防止二次开发时跨层污染。

---

## 1. Runtime Layer

### 负责

- 创建与维护 RuntimeContext
- 维护 Task lifecycle
- 准备 ExecutionLayer
- 调用 ContextAwareExecutor
- 写入 TaskOutput
- 写入 Timeline 事件
- 写入 MemoryLayer
- 通过 RuntimeBridge 暴露 Chat 可用能力

### 禁止

- 让 UI 直接修改 RuntimeContext
- 让 SkillRegistry / SkillLoader 修改 RuntimeStore
- 在 Runtime 内部处理 UI 渲染逻辑
- 在 Runtime 内部实现 Workflow / Planner / Multi-agent
- 因某个 Skill 的行为问题修改 Runtime 架构

---

## 2. UI Layer

### 负责

- 渲染 ChatMessage
- 渲染 TaskBadge
- 渲染 Workspace projection
- 触发用户交互
- 跳转到 Workspace task
- 展示 Runtime Result Surface

### 禁止

- 直接写 RuntimeContext
- 直接写 Timeline
- 直接修改 Task status
- 在 ChatView 中构造完整 Runtime 面板
- 绕过 useWorkspace 读取 RuntimeStore 内部结构

### 推荐

- ChatView 只做轻量 Runtime awareness
- 复杂细节进入 Workspace
- UI 通过 metadata / projection 消费 Runtime 状态

---

## 3. Skill Layer

### 负责

- 解析 @mention
- 通过 SkillRegistry 匹配 skill
- 通过 SkillLoader 加载 SKILL.md
- 做 capability pre-check
- 创建 type='skill' Task
- 注入 SkillLayer
- 返回 ChatMessage metadata

### 禁止

- 修改 RuntimeStore 内部结构
- 修改 RuntimeContext execution
- 修改 SkillRegistry 发现规则（除非明确做目录契约模块）
- 为单个 Skill 添加全局特殊逻辑
- 把 Skill 做成 Workflow / DAG

---

## 4. Workspace Layer

### 负责

- 通过 useWorkspace 消费 projection
- 展示 Task / Context / Timeline / Result
- 接收 Chat 中 TaskBadge 跳转
- 作为 Runtime 详情页

### 禁止

- 直接替代 Chat 入口
- 绕过 projection layer
- 直接驱动 Runtime 执行
- 把 Workspace 做成低代码编排面板

---

## 5. Transport Layer

### 负责

- providerAdapter 组装 provider payload
- backendLLMClient 调用 Tauri IPC
- commands.rs 转发到 Go backend
- 保持 systemPrompt 独立字段

### 禁止

- 把 systemPrompt 拼入普通 message
- 随意改变 Tauri IPC contract
- 让 UI 直接调用 Go backend 绕过 providerAdapter
- 因 Skill 行为问题修改 transport contract

---

## 6. 当前已知边界问题

| 问题 | 状态 | 处理模块 |
|---|---|---|
| SkillRegistry 目录结构与实际 skills/builtin 不匹配 | P0 | Module 001 |
| ChatView 过去无 Runtime awareness | 已改善 | chat-task-bridge-v0.1 |
| Skill 输出仍像 message bubble | P1 | Module 003 |
| Workspace Detail 不完整 | P1 | Module 004 |
| MODE:DIRECT 内联在 agentAdapter | P1 | Module 005 |
| execMode 双路径 | P1 | Module 006 |

---

## 7. 修改规则

任何修改都必须先判断属于哪一层：

- Runtime bug → Runtime module
- UI 可视化 → Workspace/Chat module
- Skill 行为 → Skill module
- Provider 传输 → Transport module
- 目录规范 → Skill Directory Contract module

禁止用一个模块顺手修另一个模块。
