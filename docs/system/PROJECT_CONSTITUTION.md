# PROJECT_CONSTITUTION

> HexClaw × AI-native Runtime Fusion 项目总宪法  
> Version: v0.1  
> Date: 2026-05-14  
> Purpose: 作为 Claude 终端、Web GPT、后续 Skill/Agent 开发的最高约束入口。

---

## 1. 项目是什么

本项目不是普通聊天机器人，也不是低代码工作流平台。

本项目目标是：

**Local-first AI-native Runtime Workspace**

也就是：

- Chat 是入口
- Task 是执行单位
- RuntimeContext 是上下文边界
- Skill 是行为经验包
- Timeline 是过程记录
- Workspace 是任务与上下文的可视化工作台
- Local Desktop 是主要运行面
- Cloud/Backend 只承担必要的模型、配置或服务能力

一句话：

> 用户在 Chat 中自然表达任务，系统在本地 Runtime 中生成 Task、加载 Skill、注入 Context、执行并沉淀 Timeline/Result/Asset，最后在 Workspace 中可追踪、可回看、可复用。

---

## 2. 为什么需要现在这个 Agent

传统 Chat App 的问题：

- 只产生 message
- 不沉淀 task lifecycle
- 没有 context boundary
- 没有 skill package
- 没有 timeline
- 没有 workspace surface
- 很难从一次对话演化为持续工作流

传统 Workflow/低代码平台的问题：

- 用户需要理解节点、DAG、参数、连线
- 任务入口复杂
- Skill 被做成“插件编排”
- 后期每多一种能力都容易变成平台复杂度
- 与 Chat-first、自然语言任务入口冲突

本项目要解决的是：

> 让 AI 能像 Runtime 一样执行任务，而不是像 Chatbot 一样只回复消息，也不是像 Workflow Builder 一样要求用户编排节点。

---

## 3. 核心产品哲学

### 3.1 Chat-first，但不是 Chat-only

Chat 是用户入口，不是系统边界。

用户可以在 Chat 中：

- 普通聊天
- @skill 调用
- 触发 task
- 查看 TaskBadge
- 跳转 Workspace

但系统内部必须保留：

- Task
- Context
- Timeline
- Skill
- Result
- Asset

### 3.2 Task-first Runtime，但不是 Workflow-first

Task 是 Runtime 的执行单位。

Workflow/DAG 不是当前阶段目标。

当前阶段只允许：

- single task
- single-pass skill
- clear context boundary
- explicit capability check

禁止：

- DAG
- Planner
- Multi-agent swarm
- Auto repair loop
- Validator engine
- BPMN / Node graph

### 3.3 Skill 是 Experience Package，不是 Plugin Market

Skill 的本质是：

> 一个包含 SKILL.md、skill.json、references/scripts/templates 的经验包。

Skill 不是：

- prompt market
- 低代码插件
- 节点组件
- workflow block
- 平台商店

Skill 应该描述：

- 什么时候调用
- 怎么执行
- 约束是什么
- 输出格式是什么
- 能力边界是什么

### 3.4 Runtime 不理解业务，Skill 承载行为

Runtime 负责：

- Task lifecycle
- Context lifecycle
- Capability boundary
- Timeline
- Execution
- Projection

Skill 负责：

- 行为模式
- 输出约束
- 领域经验
- 格式要求

UI 负责：

- 展示结果
- 展示状态
- 引导用户
- 暴露 Workspace surface

---

## 4. 明确不做什么

### 不做 Workflow Builder

原因：

- 会把自然语言任务变成手工编排
- 会让用户理解 DAG
- 会破坏 Chat-first
- 会让系统向 Dify/Coze 类平台漂移

### 不做 Multi-agent Swarm

当前阶段禁止 Multi-agent，因为：

- Runtime boundary 还在产品化
- Context surface 尚未成熟
- Workspace UX 尚未完整
- 过早 multi-agent 会制造不可控复杂度

### 不做 Prompt Marketplace

Skill 不是 prompt 模板集合。

如果只做 prompt market，会丢失：

- capability
- task lifecycle
- context
- timeline
- runtime execution
- workspace traceability

### 不做 Browser/Automation 优先

Browser Runtime、Automation Runtime 属于后续 capability 扩展。

当前优先级：

1. Chat → Skill → Task → Workspace 路径真实可用
2. Result Surface 产品化
3. Workspace Task Detail
4. Runtime LLM Contract
5. Capability Runtime 扩展

---

## 5. 当前已确立的架构层

### Runtime Layer

- RuntimeStore
- RuntimeContext 5 层
- Task lifecycle
- TimelineStore
- MemoryLayer
- AssetCollection
- RuntimeLLMExecutor

### Skill Layer

- SkillRegistry
- SkillLoader
- SkillBridge
- Official/Custom boundary
- Capability Gate
- SPE Archetype v0.1

### Workspace Layer

- WorkspaceView
- useWorkspace
- workspaceProjector
- TaskListPanel
- ContextDetailPanel
- TimelinePanel

### Chat Surface Layer

- ChatView
- ChatMessage
- TaskBadge
- @mention invocation
- Chat → Workspace bridge

### Transport Layer

- providerAdapter
- backendLLMClient
- Tauri IPC
- Go backend
- Ollama/local provider path

---

## 6. 当前路线

### P0: 真实 Skill Runtime 激活

- Skill Directory Alignment
- @summarize / @bulletize 真正命中 Registry
- TaskBadge 真实显示
- Workspace 跳转真实可用

### P1: Runtime Product Surface

- Result Surface
- Workspace Task Detail
- Runtime LLM Contract
- execMode convergence

### P2: Runtime 清理

- 删除 dead executor
- Capability check 去重
- Task lifecycle 统一
- Context/Timeline 细节增强

### Deferred

- Browser Runtime
- Asset Gallery
- Dashboard Runtime data
- MemoryLayer visualization
- Multi-agent
- Workflow runtime

---

## 7. 后续开发铁律

1. 每次只做一个 Module。
2. 每个 Module 必须有文档：现状、目标、涉及文件、边界、验收、回滚。
3. 不允许边分析边无限改。
4. 不允许无文档直接重构。
5. 不允许因为 prompt 不稳定引入 workflow/repair/validator。
6. 不允许 ChatView 直接操作 RuntimeContext。
7. 不允许 UI 绕过 projection 读取 Runtime 内部结构。
8. 不允许 Skill 修改 Runtime 架构。
9. 不允许为了一个 skill 特例污染全局 Runtime。
10. 真实 Tauri Desktop UAT 是 Runtime 功能最终验收标准。

---

## 8. 恢复入口

新会话或新终端恢复时，优先读取：

1. `docs/system/PROJECT_CONSTITUTION.md`
2. `docs/system/SYSTEM_MAP.md`
3. `docs/system/MODULE_STATUS.md`
4. `docs/system/RUNTIME_BOUNDARY.md`
5. `docs/refactor/runtime-native-roadmap.md`

不要先全量扫描项目。
不要重新定义架构。
不要绕过已有 ADR 与 system docs。
