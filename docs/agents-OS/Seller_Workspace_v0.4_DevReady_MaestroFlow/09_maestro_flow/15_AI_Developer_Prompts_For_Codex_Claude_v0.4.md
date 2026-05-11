# 15 AI Developer Prompts for Codex / Claude v0.4

## 1. 总控提示词

```txt
你正在开发 Seller Workspace v0.4。请严格读取 docs/v0.4-dev-ready/README_START_HERE.md，并遵守其中的 P0 范围。

当前项目不是 Electron，不是低代码工作流平台，不是 P0 Marketplace。技术栈口径：用户端 Tauri 2.0 + Vue 3 + Naive UI + Pinia + Tailwind + TS；公司后台 React + Ant Design + TS；后端 Go + Gin + PostgreSQL + Redis + S3/本地对象存储。

P0 只实现：激活码/设备授权闭环、Chat-first 动态参数卡、统一上传资产协议、Go 后端 SkillRuntime、image_pipeline Executor、后台 Skill 参数治理、基础权限校验、错误状态和验收测试。

先 analyze，输出 gap_map 和 file_change_plan，不要直接写代码。计划确认后再 execute。每次修改后必须说明改动文件、测试结果、剩余差距。
```

## 2. M0 分析提示词

```txt
请只做 M0 代码库扫描，不写功能代码。

阅读：
- docs/v0.4-dev-ready/02_product/02_Master_PRD_P0_Development_Ready_v0.4.md
- docs/v0.4-dev-ready/04_backend/06_Backend_SkillRuntime_API_DataModel_v0.4.md
- docs/v0.4-dev-ready/08_quality/13_Implementation_Task_Breakdown_Waterfall_v0.4.md

输出：
1. 当前代码实际技术栈
2. 已有相关模块和文件路径
3. 与文档不一致处
4. P0 实现缺口
5. 推荐修改文件列表
6. 风险点

禁止：不要实现 P1/P2/V2，不要重写架构，不要把 Tauri 改成 Electron。
```

## 3. M1 激活授权提示词

```txt
执行 M1：激活码与设备授权闭环。

必须满足 docs/v0.4-dev-ready/06_activation/09_Activation_Device_License_Spec_v0.4.md 和 UAT ACT-001 ~ ACT-006。

实现范围：
- 设备码生成/读取
- 设备状态 API
- 激活 API
- activation_codes/devices 数据表或等价模型
- 用户端激活页
- 后台激活码生成和设备解绑/停用

禁止：不要实现手机号注册登录，不要做完整分销商面板。
```

## 4. M2 SkillRuntime 提示词

```txt
执行 M2：SkillRuntime 与 image_pipeline Contract。

必须满足：
- docs/v0.4-dev-ready/04_backend/07_SkillRuntime_ImagePipeline_Contract_v0.4.md
- UAT RUN-001 ~ RUN-006

要求：
- POST /api/v1/tasks/execute 必须进入 SkillRuntime.ExecuteSkill
- ExecutorRegistry 根据 executor_type 找到 ImagePipelineExecutor
- 执行前必须后端权限校验
- 进度阶段和错误码统一
- Prompt 不返回前端

禁止：不要把 export_pack/upload_confirm 注册为 SkillExecutor，不要使用 Go plugin 动态加载。
```

## 5. M3 用户端提示词

```txt
执行 M3：用户端 Chat-first + 上传 + 动态参数卡。

必须满足：
- docs/v0.4-dev-ready/03_frontend/04_User_Client_Tauri_Vue_Spec_v0.4.md
- docs/v0.4-dev-ready/05_assets/08_Asset_Upload_Protocol_and_Naming_v0.4.md
- UAT CHAT/PARAM 用例

要求：
- Chat 是默认首页
- 一个上传按钮承接图片/文件/目录/路径
- 上传后生成资产确认卡
- Runtime 使用 asset_id + user_role
- 参数卡由后端 parameter_schema 渲染，不写死字段

禁止：不要暴露 Prompt、Strategy、Workflow 内部节点。
```

## 6. M4 后台提示词

```txt
执行 M4：公司后台 Skill 参数治理。

必须满足：
- docs/v0.4-dev-ready/03_frontend/05_Admin_React_AntD_Spec_v0.4.md
- UAT ADM-001 ~ ADM-006

要求：
- Skill 列表接真实 API
- SkillEditModal 接真实 API
- ParameterSchema 可编辑、校验、保存
- OperationalParams 可编辑、保存
- 后台修改 schema 后用户端动态参数卡同步变化

禁止：不要做完整 Marketplace，不要做完整分销商面板。
```

## 7. M5 质量收口提示词

```txt
执行 M5：安全、错误状态、回归测试。

必须满足：
- docs/v0.4-dev-ready/07_security/10_Security_Visibility_Prompt_Protection_v0.4.md
- docs/v0.4-dev-ready/08_quality/11_Error_States_Empty_States_Copywriting_v0.4.md
- docs/v0.4-dev-ready/08_quality/12_Acceptance_Test_UAT_Cases_v0.4.md

输出完整测试结果，列出未通过项和修复建议。不得用“未测试但应该可以”代替验收。
```
