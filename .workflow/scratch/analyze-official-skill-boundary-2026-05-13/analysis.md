# Official Skill Boundary — 六维评分

## Executive Summary

Official Skill Boundary P0 分析完成。采用两棵独立目录实现物理隔离，SkillRegistry 双 BaseDirectory 合并提供统一查询。P0 范围锁定为「目录隔离 + Schema 扩展」，其他能力全部冻结。

## Dimension Scoring

| Dimension | Score (1-5) | Confidence | Key Evidence |
|-----------|-------------|------------|-------------|
| Feasibility | 5 | 95% | 现有 SkillRegistry 可扩展为双 BaseDirectory，变更量小 |
| Impact | 3 | 80% | P0 不引入用户可见变化，只是架构边界确立 |
| Risk | 4 | 85% | 两棵目录无破坏性，Custom shadow 机制可控 |
| Complexity | 4 | 90% | 单 Registry 合并，调用方透明，复杂度低 |
| Dependencies | 5 | 95% | 无外部依赖，tauri resource 是已有机制 |
| Alternatives | N/A | — | 同树分目录 vs 双独立目录，已充分比较 |

## Risk Matrix

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Custom shadow 导致 Official 被意外覆盖 | Low | Medium | resolveSkill 返回 shadow 时 log warning |
| tauri resource 路径在不同平台不一致 | Low | Low | 通过 BaseDirectory 抽象，平台无关 |
| Registry 多目录 scan 性能 | Low | Low | lazy init，全量缓存 |

## Recommendation

**Go** ✅ — P0 可行，边界清晰，变更量小。

建议下一步：`/maestro-plan --dir .workflow/scratch/analyze-official-skill-boundary-2026-05-13`
