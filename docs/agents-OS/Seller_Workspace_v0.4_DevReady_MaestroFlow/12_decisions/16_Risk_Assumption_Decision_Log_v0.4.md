# 16 Risk / Assumption / Decision Log v0.4

## 1. Locked Decisions

| ID | Decision | Reason |
|---|---|---|
| D-001 | 用户端使用 Tauri 2.0 + Vue 3 | 贴合当前项目真实技术栈 |
| D-002 | 后端 Runtime 以 Go SkillRuntime 为主 | 不推翻当前工程基座 |
| D-003 | Chat-first 是用户主入口 | 降低普通用户操作复杂度 |
| D-004 | Skill 中心是备用入口 | 避免用户学习复杂配置 |
| D-005 | 参数卡由 parameter_schema 驱动 | 避免前端硬编码 Skill 表单 |
| D-006 | P0 不做 Marketplace | 防止范围膨胀 |
| D-007 | P0 不做完整分销商面板 | 只预留字段，降低交付风险 |
| D-008 | export/upload-confirm 不注册为 SkillExecutor | 保持业务边界清晰 |
| D-009 | Prompt 不放前端 | 保护官方 Skill 核心 |
| D-010 | 权限必须后端校验 | 防止 Chat 绕过套餐 |

## 2. Assumptions

| ID | Assumption | 验证方式 |
|---|---|---|
| A-001 | 现有后端已有 SkillRuntime 或相近结构 | M0 扫描代码 |
| A-002 | 现有用户端可使用 Tauri command 接入本地资源 | M0 扫描代码 |
| A-003 | 现有后台已有 Skill 管理基础页面 | M0 扫描代码 |
| A-004 | 数据库可新增或迁移表 | M0 检查迁移体系 |
| A-005 | Provider 调用已有或可复用 | M0 检查 image_pipeline |

## 3. Risks

| Risk | 影响 | 缓解 |
|---|---|---|
| 现有代码与文档路径不一致 | AI 改错文件 | M0 先输出 file_change_plan |
| 测试体系不完整 | 验收不可信 | M5 补最小回归测试 |
| schema 动态渲染过度复杂 | 用户端延迟 | P0 只支持基础控件 |
| 权限体系未完成 | 套餐绕过 | P0 建统一检查点 |
| 需求范围膨胀 | 延期 | 严格 P0/P1/P2/V2 |
