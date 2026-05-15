# Module 004: Workspace Task Detail

> 优先级: P1 | 状态: done

---

## 当前现状

- ContextDetailPanel 渲染 5 个 section：Task / Skill / Execution / Result / Health
- Skill section 仅显示 id + version
- Execution section 显示 state / stage / steps
- Result section 有 legacy outputs 回退

## 目标状态

- Skill section 显示 SKILL.md 内容
- Execution section 显示完整步骤详情
- Result section 正式渲染 assets

## 涉及文件

| 文件 | 操作 |
|------|------|
| `src/components/workspace/ContextDetailPanel.vue` | 修改 |

## 不允许改动的边界

- 不改 RuntimeStore
- 不改 useWorkspace composable
- 不改 workspaceProjector

## 验收标准

1. Skill section 可展开查看 SKILL.md
2. Execution section 显示完整 timeline 步骤
3. Result section 渲染 assets（文件名、大小、类型）

## 回滚方式

恢复 `ContextDetailPanel.vue` 原始版本

## 是否需要 Tauri Desktop UAT

**是。**
