# TASK-ADR-006 Summary

**Title**: 写入 ADR-006: Official vs Custom Boundary
**Status**: completed

## Changes
- 创建 `docs/adr/006-official-vs-custom-boundary.md`
- Status: frozen baseline
- Content: Context (双目录隔离需求)、Decision (Official=Resource readonly + Custom=AppData writable + 冲突规则 + source 语义)、Constraints (Custom 不可覆盖 Official; source 不从 skill.json 解析)、Rejected Alternatives (5项)、Consequences (✅5 ⚠️2)、Compliance (grep 命令)、References (skillRegistry.ts, context.ts, skillLoader.ts, tauri.conf.json)、Cross-References (ADR-005)

## Verification
| Criterion | Result |
|-----------|--------|
| file exists | ✅ |
| Status: frozen baseline | ✅ |
| contains 'BaseDirectory.Resource' | ✅ |
| source 语义覆盖 | ✅ (21 matches) |
