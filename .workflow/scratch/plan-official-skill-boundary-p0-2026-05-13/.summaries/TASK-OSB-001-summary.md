# TASK-OSB-001 Summary

**Title**: SkillRegistry 双 BaseDirectory + SkillMeta.source 标记
**Status**: completed

## Changes

### `src/types/context.ts` (+1 line)
- SkillMeta 新增 `source: 'official' | 'custom'` 字段

### `src/services/skillRegistry.ts` (重写 discover 逻辑)
- 构造器改为接受两个 BaseDirectory：`officialBaseDir = BaseDirectory.Resource` + `customBaseDir = BaseDirectory.AppData`
- 新增 `discoverFromDir(baseDir, source)` 内部方法，提取公共扫描逻辑
- `discoverSkills()` 先扫 Official 再扫 Custom，冲突保留 Official 跳过 Custom + `console.warn`
- 每个 SkillMeta 自动填充 `source` 字段

### `src/services/skillLoader.ts` (+1 line)
- SkillMeta 构造时添加 `source: 'custom'`

## Zero Modifications
- `src/services/skillBridge.ts` — 未修改
- `src-tauri/tauri.conf.json` — 未修改（resources + fs scope 已就绪）
- `src/components/chat/MentionPopup.vue` — 未修改

## Verification

| Criterion | Result |
|-----------|--------|
| `src/types/context.ts` 包含 `source: 'official' \| 'custom'` | ✅ |
| `skillRegistry.ts` 包含 `BaseDirectory.Resource` | ✅ |
| `skillRegistry.ts` 包含 `BaseDirectory.AppData` | ✅ |
| constructor 接受两个 BaseDirectory 参数 | ✅ |
| discoverSkills() 先扫 Official 再扫 Custom | ✅ |
| 冲突时 `console.warn` | ✅ |
| `source:` 赋值存在 | ✅ |
| `class SkillRegistry` 导出 | ✅ |
| `skillBridge.ts` 零修改 | ✅ git diff 无输出 |
| `npx tsc --noEmit` 通过 | ✅ |
