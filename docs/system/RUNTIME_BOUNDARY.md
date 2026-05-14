# Runtime Boundary

> 日期：2026-05-14

---

## Runtime 层边界

### 可以做

- 读取 RuntimeContext（5 层）
- 执行 Task（RuntimeLLMExecutor）
- 写入 TaskOutput
- 写入 Timeline 事件
- 写入 Memory（执行后）

### 禁止做

- 直接写入 RuntimeContext.execution（由 RuntimeStore 负责）
- 直接写入 Timeline（由 TimelineStore 负责）
- 创建/销毁 RuntimeContext
- 修改 SkillRegistry / SkillLoader

---

## UI 层边界

### 可以做

- 读取 ChatStore（消息列表）
- 读取 TaskStore（任务状态）
- 通过 useWorkspace 读取 Projection DTO
- 渲染 TaskBadge（metadata 驱动）

### 禁止做

- 直接读取 RuntimeStore（必须通过 useWorkspace）
- 直接修改 RuntimeContext
- 直接修改 Task status
- 在 ChatView 中渲染完整 Task 面板

---

## Skill 层边界

### 可以做

- 解析 @mention 语法
- 按名称匹配 Skill
- 加载 SKILL.md
- 执行 Skill（RuntimeLLMExecutor）
- 写入 ChatMessage metadata

### 禁止做

- 修改 SKILL.md 内容
- 修改 SkillRegistry 发现逻辑
- 新增 Skill（需显式批准）
- 修改 MODE:DIRECT 逻辑

---

## Transport 层边界

### 可以做

- 调用 providerAdapter.execute()
- 调用 Go Backend API
- 调用 Ollama API

### 禁止做

- 直接建立 WebSocket 连绕过 Runtime
- 修改 Go Backend 代码
- 修改 Tauri IPC 协议
