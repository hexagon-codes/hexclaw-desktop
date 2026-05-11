# Seller Workspace v0.4 开发级文档合集

生成日期：2026-05-10

本文档包目标：把现有 v0.4 文档升级为“可交给 AI 编程工作流开发”的执行规格，并与 Maestro-Flow 的闭环开发方式衔接。

## 使用顺序

1. 先读：`01_delivery_gate/01_Definition_of_Ready_and_Done_v0.4.md`
2. 再读：`02_product/02_Master_PRD_P0_Development_Ready_v0.4.md`
3. 后端优先读：`04_backend/06_Backend_SkillRuntime_API_DataModel_v0.4.md`、`04_backend/07_SkillRuntime_ImagePipeline_Contract_v0.4.md`
4. 用户端优先读：`03_frontend/04_User_Client_Tauri_Vue_Spec_v0.4.md`、`05_assets/08_Asset_Upload_Protocol_and_Naming_v0.4.md`
5. 后台优先读：`03_frontend/05_Admin_React_AntD_Spec_v0.4.md`
6. 用 Maestro-Flow 执行：`09_maestro_flow/14_Maestro_Flow_Integration_Guide_v0.4.md`
7. 给 Codex/Claude 的直接提示词：`09_maestro_flow/15_AI_Developer_Prompts_For_Codex_Claude_v0.4.md`

## 本包冻结的 P0 口径

P0 不追求完整 Agent OS，不做 Marketplace，不做完整分销商面板，不做 Browser/RPA 自动发布，不做外部 Skill 下载。

P0 只做：

```txt
Go 后端 SkillRuntime MVP
+ image_pipeline 跑通
+ 后台 Skill 参数治理
+ 用户端 Chat-first 动态参数卡
+ Tauri 桌面资源接入
+ 激活码/设备授权闭环
+ 基础权限校验点
```

## 给 AI 开发前的结论

本包按“尽量 100% 清楚”处理：对所有容易反复讨论的地方，文档内均给出默认决策。只有一种情况不能保证 100%：如果实际代码库的文件路径、已有接口、数据库迁移命名与文档假设不一致，需要 AI 在 `analyze` 阶段先扫描代码并生成差异报告。
