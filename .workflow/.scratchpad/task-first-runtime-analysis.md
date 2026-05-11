# HexClaw Desktop — Task-first Runtime 重构分析报告

> 生成日期: 2026-05-11
> 目标: 从 Chat-first 重构为 Task-first Runtime 主路径

---

## 一、当前架构总览（Chat-first）

```
用户入口 → ChatView (3831行)
  ├── Chat Core (stores/chat.ts + ~20子控制器)
  │     ├── 发送链路: 文件→base64 → RAG检索 → 构建metadata → WebSocket/HTTP → 流式接收 → 完成处理
  │     ├── 会话管理: CRUD + 加载 + 生命周期
  │     ├── 流式控制: 状态/完成/取消/错误/恢复
  │     └── 附属能力: 工具审批、产物提取、自动标题、思考计时器
  │
  ├── Agent (stores/agents.ts)        ← Chat 的一个 mode ('chat'|'agent'|'research')
  ├── Skill (views/SkillsView.vue)    ← 独立管理，通过 backend 执行
  ├── MCP   (views/McpView.vue)       ← 独立管理，工具注册到 backend ReAct 循环
  ├── RAG   (composables/useChatSend) ← Chat 发送时"顺便"检索注入
  ├── Memory (api/memory.ts)          ← 独立 CRUD + 对话自动化触发保存
  └── File  (ChatInput + file-parser) ← Chat 附件上传时解析

       ↓ 所有请求最终路由到 ↓
  hexclaw sidecar (localhost:16060) ← Rust commands 代理
```

---

## 二、模块映射

### 2.1 核心模块详情

| 模块 | 文件数 | 代码量 | 关键类型 | 执行入口 | 状态管理 |
|------|--------|--------|---------|---------|---------|
| **Chat** | ~50 文件 | ~15,000 行 | `ChatMessage`, `ChatSession`, `ChatRequest` | `ChatInput → useChatSend → ChatSendController` | `stores/chat.ts` + 20 控制器 |
| **Agent** | ~8 文件 | ~1,600 行 | `AgentConfig`, `AgentRole`, `AgentRule` | `Chat mode='agent'` → 后端 ReAct | `stores/agents.ts` |
| **Skill** | ~6 文件 | ~900 行 | `Skill`, `ClawHubSkill` | `GET /api/v1/skills` → 后端执行 | 无前端 store |
| **MCP** | ~4 文件 | ~450 行 | `McpServer`, `McpTool` | `POST /api/v1/mcp/tools/call` → 后端转发 | 无前端 store |
| **RAG** | ~5 文件 | ~750 行 | `KnowledgeDoc`, `KnowledgeSearchResult` | `composables/useChatSend` → `searchKnowledge()` | 无前端 store |
| **Memory** | ~5 文件 | ~650 行 | `MemoryEntry`, `VectorSearchResult` | 对话自动化 / 独立 CRUD | 无前端 store |
| **File/Asset** | ~4 文件 | ~500 行 | `ChatAttachment`, `ParsedDocument` | `ChatInput` → `fileToBase64` / `parseDocument` | 无前端 store |
| **Task(现有)** | ~6 文件 | ~350 行 | `Task` (仅 automation) | `AutomationView` → cron 调度 | 无完整 store |

### 2.2 关键数据流（当前）

```
用户输入 → ChatView.handleSend()
  ├── useChatSend.handleSend()
  │     ├── 文件处理: image/video → base64, document → parseDocument()
  │     ├── Auto-RAG: searchKnowledge(text, topK=3) → score>=0.35 注入 backendText
  │     └── 构建 ChatAttachment[]
  │
  ├── chatStore.sendMessage()
  │     ├── ChatSendController.sendMessage()
  │     │     ├── 守卫检查 shouldBlockChatSend()
  │     │     ├── ensureSession() → 创建/获取会话
  │     │     ├── 持久化 userMessage
  │     │     └── 交付消息 (WebSocket优先→HTTP回退)
  │     │
  │     ├── ChatStreamController
  │     │     ├── syncStreamingMirrors()
  │     │     ├── finalizeAssistantMessage()
  │     │     │     ├── extractThinkTags → 构建 ChatMessage
  │     │     │     ├── suggestSessionTitle()
  │     │     │     └── extractArtifacts()
  │     │     └── recoverActiveStreams()  (断线恢复)
  │     │
  │     └── ChatApprovalController (工具审批弹窗)
  │
  └── attachConversationAutomationActions()
        ├── save_memory → createMemoryEntry()
        ├── add_text_to_knowledge
        └── create_task → POST /api/v1/tasks
```

---

## 三、重构目标架构（Task-first Runtime）

```
                  ┌─────────────────────────┐
                  │   Task Runtime Engine     │
                  │  (统一调度 + 执行上下文)   │
                  └──────────┬──────────────┘
                             │
         ┌───────────────────┼───────────────────┐
         ▼                   ▼                   ▼
   ┌──────────┐     ┌──────────────┐     ┌──────────────┐
   │ Chat Task │     │ Agent Task   │     │ Skill Task   │
   │ (对话交互) │     │ (代理执行)    │     │ (技能运行)    │
   └──────────┘     └──────────────┘     └──────────────┘
         ▼                   ▼                   ▼
   ┌─────────────────────────────────────────────────┐
   │           Resource Providers                    │
   │  MCP · RAG · Memory · File · LLM · Tool         │
   └─────────────────────────────────────────────────┘
         ▼                   ▼
   ┌──────────┐     ┌──────────────┐
   │ 本地引擎  │     │ hexclaw      │
   │ (Ollama)  │     │ sidecar      │
   └──────────┘     └──────────────┘
```

---

## 四、风险点

| 编号 | 风险描述 | 等级 | 影响范围 |
|------|---------|------|---------|
| R1 | ChatView 3831 行单体视图，拆分难度高 | HIGH | Chat UI 重构 |
| R2 | stores/chat.ts 分散在 20+ 子文件，约 2200 行控制器逻辑 | HIGH | 状态管理重构 |
| R3 | useChatSend.ts 承担 5 个职责：文件处理+RAG+Agent模式+消息构建+自动化 | MED | 发送链路 |
| R4 | 无统一 Task 类型定义，现有 task.ts 仅含 automation/cron 类型 | MED | 类型系统 |
| R5 | 发送链路双重路径：WebSocket 流式 + HTTP 后端回退，所有逻辑耦合在 chatService | MED | 网络层 |
| R6 | Skill/MCP/RAG/Memory 均无前端 store，状态管理缺失 | LOW | 状态一致性 |
| R7 | hexclaw sidecar 是单点，所有业务逻辑依赖它 (localhost:16060) | MED | 可靠性 |
| R8 | 流恢复逻辑 (recoverActiveStreams) 与 WebSocket 深度绑定 | LOW | 扩展性 |
| R9 | 全局导航守卫依赖 settingsStore.config 加载完成 | LOW | 启动流程 |

---

## 五、第一阶段实施计划

### P1.1 核心类型定义（1-2天）

**文件**: `src/types/task.ts`（新增）

```typescript
type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
type TaskType = 'chat' | 'agent' | 'skill' | 'tool' | 'workflow' | 'automation'

interface Task {
  id: string
  type: TaskType
  status: TaskStatus
  sessionId?: string
  input: TaskInput
  output?: TaskOutput
  progress?: number  // 0-100
  error?: TaskError
  metadata: TaskMetadata
  parentId?: string
  dependencies?: string[]
}
```

### P1.2 Task Store（2-3天）

**文件**: `src/stores/tasks.ts`（新增）

- `useTaskStore` — Pinia setup store
- 任务队列管理: `enqueue()` / `dequeue()`
- 生命周期: `startTask()` / `completeTask()` / `failTask()` / `cancelTask()`
- 任务历史 + 持久化

### P1.3 Task Executor Service（2-3天）

**文件**: `src/services/taskExecutor.ts`（新增）

```typescript
interface TaskExecutor {
  execute(task: Task): Promise<TaskOutput>
  cancel(taskId: string): Promise<void>
  getStatus(taskId: string): TaskStatus
}

class ChatTaskExecutor implements TaskExecutor { /* 包装现有 chatService */ }
class AgentTaskExecutor implements TaskExecutor { /* 包装现有 agent API */ }
class SkillTaskExecutor implements TaskExecutor { /* 包装现有 skill API */ }
```

### P1.4 封装 ChatTask（1-2天）

- `chat-send-controller.ts` 入口处注册 Task
- 任务状态与流式状态同步
- TaskOutput 收集完整回复、tool_calls、artifacts、usage

### P1.5 Task 监控视图（1-2天）

**文件**: `src/views/TasksView.vue`（增强）

- 运行中任务卡片列表
- 类型图标、状态、进度、耗时
- 详情展开 / 手动取消

### P1.6 导航调整（0.5天）

- `navigation.ts` 侧边栏活性任务数指示器
- `/automation` 同时展示 Tasks + Canvas

### Phase 1 不做事项

| 不做 | 原因 |
|------|------|
| 拆解 ChatView.vue (3831行) | 属于 UI 层独立重构，不阻塞 Task 抽象 |
| 重写 stores/chat.ts 控制器体系 | 仅包裹不改造，防止回归 |
| Task Graph / DAG 执行引擎 | 第二阶段目标 |
| 后端 sidecar 改造 | 第一阶段纯前端工作 |
| WebSocket 通用化改造 | 第二阶段目标 |
| 离线执行能力 | 第二阶段目标 |
| Skill/MCP/RAG/Memory 统一资源注册 | 第二阶段目标 |

---

## 附录：关键文件索引

| 文件路径 | 模块 | 职责 |
|---------|------|------|
| `src/types/chat.ts` | Chat | ChatMessage, ChatSession, ChatAttachment, ToolCall |
| `src/types/agent.ts` | Agent | AgentConfig, AgentRole, AgentRule |
| `src/types/skill.ts` | Skill | Skill, ClawHubSkill |
| `src/types/mcp.ts` | MCP | McpServer, McpTool |
| `src/types/knowledge.ts` | RAG | KnowledgeDoc, KnowledgeSearchResult |
| `src/types/memory.ts` | Memory | MemoryEntry, MemoryType |
| `src/types/task.ts` | Task | (需新增) Task, TaskInput, TaskOutput |
| `src/stores/chat.ts` | Chat | 主 Store + 20 子控制器 |
| `src/stores/agents.ts` | Agent | Agent Store |
| `src/stores/tasks.ts` | Task | (需新增) Task Store |
| `src/services/chatService.ts` | Chat | WebSocket/HTTP 发送编排 |
| `src/services/taskExecutor.ts` | Task | (需新增) 执行器 |
| `src/composables/useChatSend.ts` | Chat | 文件处理 + RAG + 发送 |
| `src/utils/file-parser.ts` | File | PDF/Word/Excel/Text 解析 |
| `src/views/ChatView.vue` | Chat | 3831行主视图 |
| `src/views/SkillsView.vue` | Skill | 技能管理 |
| `src/views/McpView.vue` | MCP | MCP 服务器/工具管理 |
| `src/views/KnowledgeView.vue` | RAG | 知识库文档管理 |
| `src/views/MemoryView.vue` | Memory | 记忆管理 |
| `src/config/navigation.ts` | 导航 | 导航注册表 |
| `src/router/index.ts` | 路由 | 路由定义 |
| `src-tauri/src/commands.rs` | Rust | Tauri IPC 命令 |
| `src-tauri/src/sidecar.rs` | Rust | hexclaw sidecar 生命周期 |
