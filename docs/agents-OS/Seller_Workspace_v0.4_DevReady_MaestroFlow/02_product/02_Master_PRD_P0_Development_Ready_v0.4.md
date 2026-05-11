# 02 Master PRD P0 Development Ready v0.4

## 1. 产品定位

Seller Workspace v0.4 是一个基于 Skill Runtime 的 AI 桌面工作台。第一条 P0 验证主线是电商生图 `image_pipeline` Skill。

它不是：

- 单纯 AI 生图工具
- 传统 Admin 后台
- 低代码工作流平台
- BPMN 节点编排器
- P0 版 Skill Marketplace

它是：

```txt
用户通过 Chat-first 入口描述任务
→ 系统识别意图与素材
→ 匹配 Skill
→ 动态补齐参数
→ 后端 SkillRuntime 执行
→ 返回可用结果
→ 后台治理 Skill 参数、权限、设备与激活码
```

## 2. P0 核心用户故事

### US-001 首次激活

作为普通用户，我首次打开客户端时，不需要注册登录，只需看到设备码，把设备码发给管理员，拿到激活码后输入，即可进入聊天页。

验收：

- 未激活设备进入激活页
- 激活页显示设备码和复制按钮
- 激活成功进入 Chat 首页
- 重启后保持已激活状态
- 激活失败有明确原因

### US-002 Chat-first 执行商品图任务

作为普通用户，我希望不用学习复杂后台，直接在聊天框输入“帮我把这批商品图生成详情图”，并拖入图片或选择目录，系统自动识别素材和参数，确认后执行任务。

验收：

- 一个上传入口支持文件、图片、目录
- 上传后出现资产确认卡
- 每个素材有 `asset_id`、文件名、系统识别角色、用户确认角色
- 缺少必要参数时显示动态参数卡
- 参数卡由后端 schema 渲染，不在前端写死字段

### US-003 后台治理 Skill 参数

作为公司后台管理员，我希望可以编辑 image_pipeline 的基础信息、参数 schema、运行参数，使用户端表单和生成数量等规则跟随后台配置变化。

验收：

- 后台可编辑 Skill 名称、分类、runtime_type、executor_type、required_capabilities、状态
- 后台可编辑并校验 parameter_schema
- 后台可编辑 operational_params
- 用户端下一次打开任务卡时使用最新配置

### US-004 权限与套餐限制

作为管理员，我希望不同激活码和设备只执行被授权的 Skill，避免用户通过 Chat 绕过套餐。

验收：

- 后端存在统一权限检查点
- 无权限时不执行 Skill
- 前端隐藏入口不作为唯一权限措施
- Chat 意图命中无权限 Skill 时提示联系管理员开通

## 3. P0 范围

| 模块 | P0 是否做 | 说明 |
|---|---:|---|
| 用户端激活 | 是 | 设备码 + 激活码，无注册登录 |
| Chat 首页 | 是 | 默认主入口 |
| 统一上传 | 是 | 文件、图片、目录统一入口 |
| 资产确认卡 | 是 | asset_id + role 确认 |
| 动态参数卡 | 是 | 由后端 parameter_schema 驱动 |
| 任务执行 | 是 | POST /api/v1/tasks/execute |
| 任务进度 | 是 | 阶段 + 百分比 + 可取消 |
| 结果展示 | 是 | 图片结果、下载、导出包入口 |
| Skill 中心 | 是，备用入口 | 不作为主入口 |
| 公司后台 Skill 管理 | 是 | CRUD + Schema + Operational Params |
| 激活码管理 | 是 | 批次生成、状态、绑定设备 |
| 分销商面板 | 否，P1 | P0 只预留字段 |
| Marketplace | 否，P2 | P0 只做 Registry + 参数治理 |
| Browser/RPA 自动发布 | 否，V2 | 当前导出/上传确认独立 REST |
| 用户自定义 Skill | 否，P1/P2 | P0 只保留入口或提示 |

## 4. P0 主流程

```txt
用户打开客户端
→ 检查设备激活状态
→ 未激活：显示激活页
→ 已激活：进入 Chat 首页
→ 用户输入任务 + 上传素材/目录
→ 本地/Tauri 资源网关生成资产元数据
→ 后端保存 asset 记录
→ Intent 识别候选 Skill
→ 权限检查
→ 缺参识别
→ 拉取 parameter_schema
→ 渲染动态参数卡
→ 用户确认
→ POST /api/v1/tasks/execute
→ WorkflowService
→ SkillRuntime.ExecuteSkill()
→ ExecutorRegistry 找到 ImagePipelineExecutor
→ 执行 image_pipeline 节点
→ Task 状态/进度更新
→ 前端展示结果
```

## 5. P0 不允许偏移的原则

- 用户端不做主要 Skill 配置后台
- 用户端不硬编码 Skill 表单
- 用户端不展示 Prompt、Strategy、Context 构造细节
- 后台配置必须落库
- 权限必须后端校验
- Go 后端 SkillRuntime 是当前主线
- Tauri 客户端只做桌面资源接入、Chat UI、本地资产承接
