# 01 Current Progress Aligned PRD v0.4

> 文档定位：贴合当前真实进度的总需求补充文档。  
> 适用对象：老板、产品、设计、前端、后端、Claude/Codex。  
> 当前真实基座：Tauri 2.0 + Vue 3 用户端，React + Ant Design 公司后台，Go + Gin + PostgreSQL 后端。

---

# 1. 当前项目真实定位

Seller Workspace 当前不是单纯 AI 生图工具，也不是低代码工作流平台，而是：

> 基于 Skill Runtime 的通用 AI 桌面工作台。

当前第一条验证主线是：

```txt
电商生图 image_pipeline Skill
```

项目当前必须继续保留：

- 现有 Go 后端工作流
- 桌面工作台定位
- Chat-first 用户入口
- 公司后台参数治理
- Skill Runtime 通用化方向

---

# 2. 当前真实进度对齐

## 2.1 已完成 / 基本完成

当前项目文档显示，以下能力已经完成或基本完成：

- M1 基础骨架
- M2 任务与技能
- M3 商业化基础能力
- M4 Agent 智能交互
- M5 计费模块
- M1-V2 授权体系修复
- M2-V2 Chat 重构与 Pipeline 跑通
- M3-V2 电商资产管理
- M4-V2 Skill 插件化与参数治理 + 桌面资源接入
- M5-V2 公司后台管理系统

## 2.2 当前核心里程碑

当前方向已升级为：

```txt
基于 Skill Runtime 的通用 AI 工作台
```

电商生图已经作为第一个 Skill 完成完整闭环，后续围绕：

- Skill Runtime
- Skill 插件注册机制
- 后台参数配置化
- 通用执行器抽象
- Browser/RPA 能力预留
- Skill Marketplace 内核

逐步建设。

---

# 3. P0 当前冻结范围

P0 当前不是重新设计一个完整 Agent OS，而是：

```txt
让 image_pipeline 在统一 SkillRuntime 下跑通完整闭环
+
后台能配置 Skill 参数
+
用户端表单/Chat 参数卡由后端 schema 驱动
```

## 3.1 P0 验收目标

```txt
用户端提交任务
→ POST /api/v1/tasks/execute
→ WorkflowService
→ SkillRuntime.ExecuteSkill()
→ ImagePipelineExecutor
→ 7 个 WorkflowNode
→ 图片结果返回
→ 前端展示
```

同时：

- 后台修改 `parameter_schema` 后，用户端表单自动变化
- 后台修改 `operational_params` 后，生成数量 min/max/default 自动变化
- SkillDefinition 必须包含 `runtime_type` 与 `required_capabilities`
- 本阶段只运行 `generation` 类型，但禁止写死只支持 generation

---

# 4. 三端现阶段职责

## 4.1 用户端：Tauri + Vue 3 + Naive UI

当前用户端职责：

- 激活授权
- Chat-first 对话式任务入口
- Skill 浏览备用入口
- 动态参数卡
- 任务执行
- 任务进度展示
- 结果图片展示
- 文件上传 / 桌面资源接入
- 本地资产目录承接
- API / 模型配置
- 设置页

注意：

```txt
用户端不是主要 Skill 配置后台。
用户端不应硬编码 Skill 表单。
```

---

## 4.2 公司后台：React + Ant Design

当前公司后台职责：

- Skill CRUD
- ParameterSchema 编辑
- OperationalParams 编辑
- Skill 基本信息编辑
- 套餐分配
- 用户/设备
- 激活码
- 数据统计
- 日志
- 分销商管理基础能力

当前优先级最高的是：

```txt
SkillEditModal 接入真实后端 API
```

---

## 4.3 后端：Go + Gin + PostgreSQL

当前后端职责：

- SkillRuntime 执行引擎
- ExecutorRegistry
- ImagePipelineExecutor
- SkillDefinition
- ParameterSchema
- WorkflowService
- TaskService
- 数据持久化
- Provider 适配
- 导出包 / 上传确认独立 REST

---

# 5. 分销商面板阶段标注

分销商面板不属于当前 P0 执行范围。

```txt
分销商面板 = P1
```

P0 只需在公司后台和数据模型中预留：

- 分销商字段
- 发码归属
- 可售套餐
- 可售 Skill 范围
- 统计归属

不要现在做完整分销商 Web 面板。

---

# 6. Marketplace 阶段标注

当前不做真正 Marketplace。

```txt
P0：Skill Registry + 后台参数治理
P1：Entitlement 权限、分销商、更多 Skill 类型
P2：Skill Marketplace / 上架分发 / 外部 Skill 定义
```

---

# 7. 自动发布阶段标注

自动发布属于 V2。

当前 `export_pack` 和 `upload_confirm` 保持独立 REST 服务，不封装为 SkillExecutor，不注册到 ExecutorRegistry。

```txt
P0：导出包、上传确认、发布辅助
V2：Browser Runtime / 自动发布
```

---

# 8. v0.3 需要修正的核心

| v0.3 内容 | v0.4 修正 |
|---|---|
| 写成 Electron | 改回 Tauri 2 + Vue 3 |
| 写成完全 Local-first Runtime | 改成当前 Go 后端 SkillRuntime 为主，Local-first 作为方向 |
| 分销商面板像 P0 已有 | 标注为 P1 |
| Marketplace 描述偏近 | 标注为 P2 |
| Skill 加密过重 | P0 只做元数据/权限/不在前端放 Prompt，P1/P2 做加密包与短令牌 |
| 用户端 Strategy/Timeline 细节 | 用户端只显示任务状态和百分比，不显示内部 Prompt/策略 |
