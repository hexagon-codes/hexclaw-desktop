# Summary: TASK-ADR-002

**Status**: completed
**Wave**: 1B
**Date**: 2026-05-13

## Created

- `docs/adr/002-runtime-authority-ownership.md` — Runtime Authority Ownership ADR

## Key Content

- **Decision**: RuntimeStore 是 ContextManager 的唯一拥有者和唯一突变入口
- **Constraints**: 禁止绕过 RuntimeStore、Composable 不导入 Pinia/TimelineStore、每次 mutation 必须 bump revision
- **Rejected Alternatives**: 直接修改 Map、发布-订阅模式、多层 authority
- **Code References**: runtime.ts, contextManager.ts, composable patch 模式
- **Cross-References**: ADR-001, ADR-004

## Verification

- [x] 包含 RuntimeStore 唯一 mutation authority 的精确描述
- [x] 包含 revision 机制的 Rationale
- [x] 包含 3 个 composable 的代码引用
- [x] 包含 Rejected Alternatives（4 个方案 + 原因）
- [x] 包含 Consequences（✅ 5 条 + ⚠️ 2 条）
