# 19 Runtime Lifecycle and TaskFlow v0.4

# 1. 文档目标

定义任务生命周期与 Runtime 执行顺序。

防止：

- Agent 无限自治
- Workflow 混乱
- 前后端职责污染

---

# 2. 生命周期主链路

Intent
→ Skill Match
→ Visibility Check
→ Entitlement Check
→ Missing Parameter Detection
→ Schema Render
→ User Confirm
→ Task Create
→ Runtime Execute
→ Progress Update
→ Result Store
→ Export

---

# 3. Intent 阶段

职责：

- 理解用户意图
- 推断候选 Skill
- 提取参数
- 判断缺参

禁止：

- 直接执行 Skill
- 跳过权限

---

# 4. Skill Match

根据：

- runtime_type
- category
- entitlement
- capability

进行候选匹配。

---

# 5. Missing Parameter Detection

必须识别：

- 必填参数
- 文件缺失
- role 缺失
- 参数类型错误

---

# 6. Schema Render

前端参数卡完全由：

parameter_schema

驱动。

禁止硬编码表单。

---

# 7. User Confirm

用户必须：

- 确认任务
- 确认素材角色
- 确认参数

禁止一句话自动无限执行。

---

# 8. Runtime Execute

SkillRuntime：

- 校验权限
- 调度 Executor
- 跟踪进度
- 管理重试
- 管理取消

---

# 9. Progress Update

用户端：

- 百分比
- 当前阶段
- 简短错误

后台：

- Provider 错误
- Runtime 日志
- 调用统计

---

# 10. Result Store

统一保存：

- result_id
- task_id
- asset_refs
- preview_urls
- export_package

---

# 11. Export

export_pack：

- 独立 REST
- 不进入 SkillExecutor

---

# 12. 当前阶段限制

P0：

- generation runtime

P2/P3：

- browser runtime
- autonomous runtime
- multi-agent
