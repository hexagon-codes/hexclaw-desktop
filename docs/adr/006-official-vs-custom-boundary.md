# ADR-006: Official vs Custom Boundary

**Status**: frozen baseline
**Date**: 2026-05-13

## Context

Skill 来源分为两类：随应用发布的 Official Skill 和用户安装的 Custom Skill。如果两类 Skill 混在同一目录，会引发以下问题：

1. **篡改风险**：用户或第三方应用可能修改或替换 Official Skill 的 skill.json/SKILL.md
2. **升级冲突**：应用更新时，Official Skill 的更改和用户的本地修改冲突
3. **安全分级**：Official Skill 应天然受信任，Custom Skill 需要额外校验
4. **清理边界**：卸载 Custom Skill 不应影响 Official Skill

需要明确的物理隔离和不可协商的冲突规则。

## Decision

**两棵物理独立的 skills/ 目录树 + Official 优先的冲突规则 + source 注入语义。**

### 目录隔离

| 来源 | BaseDirectory | 路径 | 可写性 | 物理保障 |
|------|--------------|------|--------|---------|
| **Official** | `BaseDirectory.Resource` (11) | `$RESOURCE/skills/` | **只读** | tauri `resources` 机制 |
| **Custom** | `BaseDirectory.AppData` (14) | `$APPDATA/skills/` | 可写 | 用户数据目录 |

底层保障（`tauri.conf.json`）：
- `resources: { "skills/*": "skills/" }` — 将 `skills/` 目录作为 tauri resource 打包
- `fs.scope.allow: ["$APPDATA/skills/**", "$RESOURCE/skills/**"]` — 两个目录均在 fs 白名单

### 冲突规则

```
discoverSkills():
  1. 扫描 Official 目录 → 全部写入 cache
  2. 扫描 Custom 目录 → 逐个检查是否与 cache 冲突
     冲突 → console.warn("[SkillRegistry] Custom skill \"{id}\" 与 Official 冲突，已忽略") + continue
     无冲突 → 写入 cache
```

**核心原则：Custom 不可覆盖 Official。**

### Source 语义

`SkillMeta.source` 字段用联合类型标记 Skill 来源：

```typescript
interface SkillMeta {
  // ... 其他字段
  /** 来源标记 — Registry 自动填充，非 skill.json 字段 */
  source: 'official' | 'custom'
}
```

- **填充者**：Registry 的 `discoverFromDir(baseDir, 'official'|'custom')` + Loader 的 `source: 'custom'`
- **禁止来源**：skill.json 文件不可包含 `source` 字段。Registry 忽略此字段
- **不可写**：source 由基础设施层自动注入，不属于 skill 作者可控制的元数据

## Constraints

- Custom 目录中同 id 的 Skill 不可覆盖 Official（硬规则，不可配置）
- `SkillMeta.source` 字段禁止从 `skill.json` 解析。如果 `skill.json` 包含 `source` 字段，Registry 忽略它
- 调用方（`skillBridge.ts`、`MentionPopup.vue`）无需感知 `source` 差异 — 透明合并
- `SkillLoader` 构造 SkillMeta 时 source 固定为 `'custom'`（Loader 只用于加载 Custom skill 的内容）

## Rejected Alternatives

| Alternative | Reason for Rejection |
|-------------|---------------------|
| Custom 覆盖 Official | 安全漏洞：用户可篡改内置 skill 的行为 |
| `official?: boolean` 字段 | 不可扩展（未来可能有 third-party/marketplace）；语义模糊 |
| 单目录 + 文件名前缀区分（如 `official_` vs `custom_`） | 命名冲突风险，管理和调试混乱 |
| Registry 从 `skill.json` 解析 `source` | 安全风险：skill 作者可谎报来源。应由基础设施层注入 |
| 应用层加密保护 Official | 过度工程：tauri resource 天然只读，应用层无需重复保护 |

## Consequences

- ✅ **物理隔离**：两棵独立目录树，互不干扰
- ✅ **冲突安全**：Official 天然受保护，Custom 无法意外覆盖
- ✅ **升级安全**：应用更新 Official Skill 不会影响 Custom Skill（Custom 在同 id 下被忽略）
- ✅ **调用方透明**：`resolveSkill` / `getAllSkills` 合并返回，消费方无需区分来源
- ✅ **跨平台**：tauri BaseDirectory 机制在 Windows/macOS/Linux 上行为一致
- ⚠️ **用户不知 Custom 被忽略**：冲突时只有 console.warn，用户无 UI 提示
- ⚠️ **tauri 平台依赖**：只读保护依赖 tauri resource 机制，非通用文件系统特性

## Compliance

代码审查时检查：

```bash
# 验证没有代码从 skill.json 解析 source 字段
grep -rn '"source"' src/services/skillRegistry.ts src/services/skillLoader.ts || echo "✅ source 不来自 skill.json"

# 验证 Registry 使用两个 BaseDirectory
grep -n 'BaseDirectory\.Resource\|BaseDirectory\.AppData' src/services/skillRegistry.ts | wc -l
# 预期输出: 2

# 验证冲突规则存在
grep -n 'console.warn.*冲突' src/services/skillRegistry.ts || echo "❌ 冲突 warning 缺失"
```

## References

- `src/services/skillRegistry.ts:27-33` — 双 BaseDirectory 构造器：`Resource` + `AppData`
- `src/services/skillRegistry.ts:120-135` — `discoverSkills` 先 Official 后 Custom + 冲突规则
- `src/services/skillRegistry.ts:69-113` — `discoverFromDir` 通用扫描逻辑
- `src/types/context.ts:32` — `SkillMeta.source: 'official' | 'custom'` 联合类型
- `src/services/skillLoader.ts:93` — Loader 构造 SkillMeta 时 `source: 'custom'`
- `src-tauri/tauri.conf.json` — `resources` + `fs.scope.allow` 底层保障

## Cross-References

- ADR-005: Skill Registry Authority（Registry 使用双 BaseDirectory 实现扫描和缓存）
