# 18 Agent Runtime Architecture v0.4

> 文档定位：
定义 Seller Workspace 的 Agent Runtime 分层架构。
防止项目后续演化为低代码工作流平台或 Prompt 拼装器。

---

# 1. 当前项目本质

Seller Workspace 不是：

- AI Demo
- Prompt 工具
- 低代码 Workflow 平台
- BPMN 编排系统
- AutoGPT 类自治 Agent
- Dify/Coze 节点平台

Seller Workspace 的本质是：

> 企业级可治理 Skill Runtime Workspace。

核心方向：

Chat-first
+
Skill Runtime
+
Schema 驱动
+
后台治理
+
可商业化
+
桌面资源接入

---

# 2. Runtime 总架构

User Interface Layer
→ Agent Layer
→ Skill Runtime Layer
→ Executor Layer
→ Provider Layer
→ Asset Layer

---

# 3. User Interface Layer

当前：

- Tauri 2
- Vue 3
- Naive UI

职责：

- Chat-first 交互
- 动态参数卡
- 上传素材
- 展示进度
- 展示结果
- 本地资源接入

禁止：

- 前端写 Prompt
- 前端写 Skill Core
- 前端写 Workflow 逻辑
- 前端硬编码参数 Schema

---

# 4. Agent Layer

职责：

- Intent Recognition
- Skill Match
- Missing Parameter Detection
- Task Planning
- Tool Routing
- Execution Orchestration

P0 原则：

- 不允许绕过 Skill 权限
- 不允许无限 Tool Loop
- 不允许直接读取任意本地路径

---

# 5. Skill Runtime Layer

系统核心：

- SkillDefinition
- WorkflowService
- TaskRuntime
- ExecutorRegistry
- PermissionCheck
- EntitlementCheck
- ParameterValidation
- ProgressTracking

Skill Runtime ≠ LLM。

---

# 6. Executor Layer

Executor 是能力执行单元：

- ImagePipelineExecutor
- BrowserExecutor
- UploadExecutor
- ExportExecutor

权限统一由 Runtime 校验。

---

# 7. Provider Layer

包含：

- Claude SDK
- OpenAI SDK
- Gemini SDK

Provider 只负责：

- inference
- streaming
- tool calling
- structured output

禁止 Provider 承载业务规则。

---

# 8. Asset Layer

统一抽象：

- asset_id
- role
- source_path
- upload_session

禁止使用“第一张图”这种弱引用。

---

# 9. Skill 原则

Skill 是：

> Runtime Capability Unit

不是：

- 插件市场
- 低代码节点

Skill 至少包含：

- parameter_schema
- operational_params
- runtime_type
- executor_type
- entitlement

---

# 10. RuntimeType

当前：

- generation

未来：

- browser
- automation
- analysis
- publish
- multimodal

禁止写死 generation。

---

# 11. GenericAgent 定位

P0：

- 不作为主 Runtime

P2/P3：

- Browser Runtime
- Research Agent
- RPA

原因：

- 不可控
- 难治理
- 难商业化

---

# 12. pi/OpenClaw 吸收原则

吸收：

- Skill Runtime
- Session Persistence
- Extension Architecture
- Agent Loop
- Memory

不直接开放：

- 任意第三方执行权限
- 无限制自治 Runtime

---

# 13. Runtime 生命周期

Intent
→ Skill Match
→ Permission Check
→ Missing Params
→ Schema Render
→ User Confirm
→ Execute
→ Progress
→ Result
→ Export

---

# 14. 当前 P0 核心

当前只做：

- Go 后端 SkillRuntime MVP
- image_pipeline
- 后台参数治理
- Chat-first 参数卡
- Tauri 本地资源接入

不要：

- Browser Runtime
- Agent OS
- Workflow Builder

---

# 15. 最终结论

最终方向：

自研 SkillRuntime
+
Claude SDK
+
Schema Driven UI
+
pi/OpenClaw Runtime 思想
+
后续 Browser Runtime
