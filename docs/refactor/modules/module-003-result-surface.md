# Module 003: Result Surface

> 优先级: P1 | 状态: 待设计

---

## 当前现状

- Skill 执行结果以普通 assistant message 渲染
- TaskBadge 显示 skill name + status（Wave 1）
- 但无 SKILL.md 内容展示、无 skill 版本信息

## 目标状态

- Skill 结果以卡片形式渲染（区别于普通消息）
- 显示 skill name、版本、SKILL.md 摘要
- 普通 chat 不受影响

## 涉及文件

| 文件 | 操作 |
|------|------|
| `src/components/chat/SkillResultCard.vue` | 新增 |
| `src/views/ChatView.vue` | 修改（条件渲染） |

## 不允许改动的边界

- 不改 RuntimeStore
- 不改 skillBridge
- 不改 SKILL.md 内容
- 不改 buildPromptInput

## 验收标准

1. tsc 通过
2. @summarize 结果以卡片渲染
3. 卡片显示 skill name + version + 摘要
4. 普通 chat 不显示卡片
5. 普通 chat 消息无任何 UI 变化

## 回滚方式

删除 `SkillResultCard.vue`，恢复 `ChatView.vue`

## 是否需要 Tauri Desktop UAT

**是。**
