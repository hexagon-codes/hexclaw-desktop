# 14 Maestro-Flow Integration Guide v0.4

## 1. 为什么适合本项目

Maestro-Flow 适合把本项目从“需求文档”推进为“开发闭环”。它的价值不是替代需求文档，而是让 AI 按阶段执行：分析、计划、执行、验证、评审、测试、里程碑审计。

本项目应使用文档作为输入，把 Maestro-Flow 作为执行协调器。

## 2. 建议目录放置

把本包复制到项目根目录：

```txt
project-root/
  docs/v0.4-dev-ready/
    README_START_HERE.md
    01_delivery_gate/
    02_product/
    03_frontend/
    04_backend/
    05_assets/
    06_activation/
    07_security/
    08_quality/
    09_maestro_flow/
    10_schemas/
    11_workflow_specs/
  .workflow/specs/
  .workflow/knowhow/
```

## 3. Maestro-Flow 推荐使用方式

### 3.1 第一次不要直接全自动

不要一开始就：

```txt
/maestro-ralph -y "开发 Seller Workspace v0.4"
```

建议先让它分析：

```txt
/maestro-ralph "只分析当前代码库与 docs/v0.4-dev-ready 的差异，生成 gap_map 和 file_change_plan，不要写功能代码"
```

### 3.2 M0 完成后执行 M1

```txt
/maestro-ralph "按照 docs/v0.4-dev-ready/08_quality/13_Implementation_Task_Breakdown_Waterfall_v0.4.md 执行 M1 激活码与设备授权闭环。必须先 plan，再 execute，再 verify。不要实现 P1/P2/V2 功能。"
```

### 3.3 每个阶段结束

```txt
/maestro-ralph status
/maestro-ralph continue
```

如果验证失败，允许它进入 debug → fix → retry，但不要跳过验收用例。

## 4. 质量模式建议

| 场景 | 模式 |
|---|---|
| 小 bug | quick |
| 普通功能 | standard |
| 激活授权、权限、安全、付费 | full |

P0 关键功能建议使用 standard 起步，M5 用 full。

## 5. Dashboard / TUI 使用

建议：

```txt
maestro serve
```

然后打开本地 Dashboard 查看 Kanban、Gantt、Command Center。

如果不想使用浏览器 Dashboard：

```txt
maestro view
```

## 6. `.workflow/specs` 的用途

本包提供了 `11_workflow_specs/.workflow/specs/` 示例，可以复制到项目根目录的 `.workflow/specs/`。用途：

- 让实现角色加载编码约束
- 让计划角色加载架构约束
- 让测试角色加载验收标准
- 让评审角色加载质量门禁

## 7. 推荐执行顺序

```txt
M0 analyze only
→ M1 activation/device/license
→ M2 SkillRuntime/image_pipeline
→ M3 user client chat/upload/schema card
→ M4 admin skill governance
→ M5 security/error/regression
```

## 8. 中断和人工介入规则

出现以下情况必须暂停，不让 AI 继续乱改：

- 发现实际技术栈不是文档所写
- 发现已有接口命名冲突
- 需要数据库破坏性迁移
- 测试无法运行且原因不明
- 需要接入真实 Provider Key
- AI 试图实现 Marketplace / Browser Runtime / 分销商完整面板

## 9. 与 Codex/Claude 的关系

Maestro-Flow 可以协调 Claude Code、Codex、Gemini 等。你的使用方式应该是：

```txt
文档 = 约束和验收
Maestro-Flow = 编排和闭环
Codex/Claude = 具体编码执行者
```

不要让编码 AI 自己重新定义产品。
