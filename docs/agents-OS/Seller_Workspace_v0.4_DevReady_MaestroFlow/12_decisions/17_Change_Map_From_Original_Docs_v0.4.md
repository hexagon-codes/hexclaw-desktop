# 17 Change Map From Original v0.4 Docs

## 1. 保留的核心

- 当前项目定位：基于 Skill Runtime 的通用 AI 桌面工作台
- 第一条验证主线：电商生图 image_pipeline Skill
- 技术基座：Tauri + Vue 用户端、React + Ant Design 后台、Go + Gin + PostgreSQL 后端
- P0 主线：SkillRuntime MVP + image_pipeline + 参数治理 + Chat-first 动态参数卡
- 分销商面板 P1、Marketplace P2、Browser/RPA V2
- 前端不放 Prompt、后端统一权限校验

## 2. 本包补充的内容

| 原文档已有 | 本包补强 |
|---|---|
| P0 主线 | 补 Definition of Ready/Done |
| 当前 PRD | 补用户故事、主流程、P0 验收 |
| 技术栈复审 | 补 API/Data Model/Runtime Contract |
| UI 卡片 | 补页面路由、状态、交互、错误文案 |
| Skill 安全规则 | 补权限矩阵、Entitlement 检查顺序 |
| 上传讨论 | 补 Asset 协议、命名规则、批量失败策略 |
| Maestro-Flow 使用 | 补工作流衔接、阶段命令、AI 提示词 |

## 3. 仍需代码库确认

这些不是需求不清，而是必须由实际代码扫描确认：

- 真实文件路径
- 已有 API 命名
- 已有数据表/迁移工具
- 已有测试命令
- Provider 调用现状
- Tauri command 权限配置现状
