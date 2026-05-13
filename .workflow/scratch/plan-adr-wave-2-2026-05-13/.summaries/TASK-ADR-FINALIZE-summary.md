# TASK-ADR-FINALIZE Summary

**Title**: 更新 ADR README.md 索引与依赖图 + 最终验证
**Status**: completed

## Changes
- `docs/adr/README.md`:
  - Constitution Baseline: v0.8 → v0.9
  - Frozen ADRs: ADR-001~004 → ADR-001~006
  - Index table: +4 rows (ADR-005~008)
  - Dependency graph: +Skill Layer subgraph with 4 nodes + 5 edges
  - ADR-005/006: frozen baseline
  - ADR-007/008: accepted

## Verification
| Criterion | Result |
|-----------|--------|
| README contains '005' (index + deps) | ✅ (8 matches) |
| README contains '008' (index + deps) | ✅ (4 matches) |
| ADR-005/006 frozen baseline | ✅ (8 total) |
| ADR-007/008 accepted | ✅ (4 total) |
| npx tsc --noEmit | ✅ 零错误 |
