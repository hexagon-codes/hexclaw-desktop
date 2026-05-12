# Summary: TASK-ADR-003

**Status**: completed
**Wave**: 1B
**Date**: 2026-05-13

## Created

- `docs/adr/003-projection-purity.md` — Projection Purity ADR

## Key Content

- **Decision**: workspaceProjector.ts 是纯函数层（零 store、零副作用、零 async）
- **Constraints**: 禁止 import @/stores、必须返回新对象、必须同步
- **Rejected Alternatives**: 直接 import store、class 封装、async/IO、纯 type cast
- **Compliance Guidance**: 代码审查检查 import 语句 + ESLint 规则方向
- **Code References**: workspaceProjector.ts 全部 5 个投影函数 + 类型定义

## Verification

- [x] 包含 purity 的精确约束定义（3 条）
- [x] 包含 5 个投影函数的代码引用（函数签名 + 行号）
- [x] 包含 Compliance 指导（ESLint 规则方向）
- [x] 包含 Rejected Alternatives（5 个方案 + 原因）
- [x] 包含 Consequences（✅ 4 条 + ⚠️ 2 条）
