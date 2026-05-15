# Skill 目录规范契约

> 日期：2026-05-14

---

## 1. Registry 期望结构

`SkillRegistry.discoverFromDir()` 扫描逻辑：

```
readDir('skills', { baseDir })          // 找到 skills/ 下的子目录
  → for each entry (isDirectory):
      readTextFile('skills/{entry.name}/skill.json', { baseDir })  // 读取 skill.json
```

**期望**：`skills/{skillId}/skill.json`

**sanitizeSkillId**：`[^a-z0-9_-]` 替换为空 → **不允许 `/`**

---

## 2. Loader 支持结构

`SkillLoader.loadSkill(skillId)` 加载逻辑：

```
readTextFile(`skills/${safeId}/skill.json`, { baseDir })
readTextFile(`skills/${safeId}/SKILL.md`, { baseDir })
readDir(`skills/${safeId}/references`, { baseDir })
```

**支持**：`skills/{skillId}/skill.json`，其中 `skillId` 允许 `/`（嵌套路径）

**sanitizeSkillId**：`/^[a-z0-9_/-]+$/` → **允许 `/`**

---

## 3. 实际目录结构

```
skills/
  builtin/                    ← 多余层级
    summarize/
      skill.json
      SKILL.md                ← v10 SPE 版本（正确内容）
    bulletize/
      skill.json
      SKILL.md
```

**问题**：Registry 扫描 `skills/` 只找到 `builtin/` 目录，尝试读取 `skills/builtin/skill.json` → 不存在 → 跳过。

---

## 4. Resource/AppData/Custom/Official 目录边界

| 概念 | BaseDirectory | 说明 |
|------|---------------|------|
| **Official** | `BaseDirectory.Resource` | Tauri bundle 资源，只读 |
| **Custom** | `BaseDirectory.AppData` | 用户自定义，可读写 |

**Tauri bundle 映射**（tauri.conf.json）：
```json
"resources": {
  "skills/*": "skills/"
}
```
→ 项目根 `skills/` → bundle `skills/`

**冲突规则**：Official 优先。Custom 与 Official 同名时，Custom 被忽略。

---

## 5. 推荐统一方案

### 方案 A: 扁平化目录（推荐）

```bash
# 移动
skills/builtin/summarize/ → skills/summarize/
skills/builtin/bulletize/ → skills/bulletize/
# 删除
skills/builtin/
```

**优点**：
- 0 行代码改动
- Registry + Loader 均无需修改
- 符合 `skills/{skillId}/` convention

**风险**：低（纯文件移动）

---

### 方案 B: Registry 支持递归扫描

修改 `discoverFromDir()` 为递归扫描，支持 `skills/builtin/summarize/skill.json`。

**优点**：保持现有目录结构
**缺点**：改 Registry 逻辑，需验证 `sanitizeSkillId` 兼容性

---

### 方案 C: Tauri config 映射修正

修改 `tauri.conf.json`：
```json
"resources": {
  "skills/builtin/*": "skills/"
}
```

**优点**：bundle 直接包含技能
**缺点**：破坏 `skills/{skillId}/` convention，Custom 路径需要同步调整

---

## 6. summarize 找不到 Skill 的根因

```
1. 用户输入: "@summarize text"
2. parseSkillInvocation → { skillName: "summarize" }
3. resolveSkillByName("summarize", registry)
4. SkillRegistry.getAllSkills()
5.   → discoverFromDir(Resource)
6.     → readDir('skills') → [builtin/]
7.     → readTextFile('skills/builtin/skill.json') → ❌ ENOENT
8.     → skip
9.   → discoverFromDir(AppData)
10.    → readDir('skills') → [] 或 ENOENT
11.  → cache = {} (空)
12. resolveSkillByName → undefined
13. tryExecuteSkill → return undefined (不是 skill invocation)
14. 回退到普通 chat 路径
```

**结论**：`skills/builtin/` 多一层目录，Registry 无法发现技能。
