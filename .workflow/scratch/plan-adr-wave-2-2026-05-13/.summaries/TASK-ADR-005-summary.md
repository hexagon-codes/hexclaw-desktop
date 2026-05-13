# TASK-ADR-005 Summary

**Title**: 写入 ADR-005: Skill Registry Authority
**Status**: completed

## Changes
- 创建 `docs/adr/005-skill-registry-authority.md`
- Status: frozen baseline
- Content: Context (单一权威来源需求)、Decision (discover+cache+resolve 三职责 + 不做的边界)、Constraints (不得导入 store、read-only)、Rejected Alternatives (5项)、Consequences (✅4 ⚠️1)、Compliance (grep 命令)、References (skillRegistry.ts:21-146 等)、Cross-References (ADR-002, ADR-006)

## Verification
| Criterion | Result |
|-----------|--------|
| file exists | ✅ |
| Status: frozen baseline | ✅ |
| contains 'discover', 'cache', 'resolve' | ✅ (6 matches for discover) |
| contains 'ADR-002' | ✅ |
| contains '## Rejected Alternatives' | ✅ |
| contains '## Constraints' | ✅ |
