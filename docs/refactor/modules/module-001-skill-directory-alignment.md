# Module 001: Skill Directory Alignment

> 优先级: P0 | 状态: 待执行

---

## 当前现状

- `SkillRegistry.discoverFromDir()` 扫描 `skills/{skillId}/skill.json`
- 实际技能在 `skills/builtin/summarize/` 和 `skills/builtin/bulletize/`
- Registry 从未发现任何技能
- `@summarize` / `@bulletize` 回退为普通 chat

## 目标状态

- 技能位于 `skills/summarize/` 和 `skills/bulletize/`
- Registry 成功发现 summarize + bulletize
- `@summarize` 命中 skill 执行路径

## 涉及文件

| 文件 | 操作 |
|------|------|
| `skills/builtin/summarize/` | 移动到 `skills/summarize/` |
| `skills/builtin/bulletize/` | 移动到 `skills/bulletize/` |
| `skills/builtin/` | 删除空目录 |

**0 行代码改动。**

## 不允许改动的边界

- 不改 `SkillRegistry.ts`
- 不改 `SkillLoader.ts`
- 不改 `skillBridge.ts`
- 不改 `tauri.conf.json`
- 不改任何 Vue 组件

## 验收标准

1. `ls skills/` 显示 `summarize/` 和 `bulletize/`（无 `builtin/`）
2. `skills/summarize/skill.json` 存在
3. `skills/summarize/SKILL.md` 存在（v10 SPE 内容）
4. `skills/bulletize/skill.json` 存在
5. `skills/bulletize/SKILL.md` 存在

## 回滚方式

```bash
mkdir -p skills/builtin
mv skills/summarize skills/builtin/
mv skills/bulletize skills/builtin/
```

## 是否需要 Tauri Desktop UAT

**是。** 需要在 Tauri 环境中验证 @summarize 真正执行。
