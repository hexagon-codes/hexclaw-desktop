# Capability Gate — Context

## Locked Decisions

| ID | 决策 | 依据 |
|----|------|------|
| CG1 | skillBridge 侧 pre-check | 最小改动，不违反 ADR-001 |
| CG2 | P0 policy 使用 DEFAULT_ALLOWED_CAPABILITIES | 无 RuntimeContext 依赖 |
| CG3 | 验证失败阻塞执行（不 warn） | Chat-first 需要明确反馈 |
| CG4 | 通过 getRuntimeServices() 获取 registry/validator | 已有服务定位器，非 RuntimeStore |

## Free Decisions

| ID | 决策 | 依据 |
|----|------|------|
| CG5 | per-session policy → P1 通过 runtimeBridge 暴露 | 等真实 per-session 需求 |

## 变更范围

| 文件 | 操作 | 行数 |
|------|------|------|
| `src/services/skillBridge.ts` | 修改 | +15 行 |

## Next Step

`/maestro-plan --dir .workflow/scratch/analyze-capability-gate-2026-05-13`
