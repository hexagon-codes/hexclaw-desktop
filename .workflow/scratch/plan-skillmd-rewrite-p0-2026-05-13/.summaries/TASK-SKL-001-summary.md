# TASK-SKL-001 Summary: SKILL.md Prompt Rewrite

## Status: ✅ Completed

## Changes

- **File**: `skills/builtin/summarize/SKILL.md`
- **Size**: 2985 bytes (from 1665 → under 3000 limit)
- **Type**: Content-only restructure

## What Changed

1. **Section reorder**: Constraints moved from §4 → §1 (primacy effect)
2. **ALL CAPS emphasis**: 4 MUST/MUST NOT rules with ALL CAPS headers
3. **Dedicated [§N] section**: `## CITATION FORMAT: [§N]` with format spec + examples
4. **Example Output**: Worked example with 5 [§N] citations + length ratio (~32%)
5. **Preserved sections**: Purpose, Working Principles, Common Patterns, Quality Bar

## Convergence Criteria

| # | Criterion | Status |
|---|-----------|--------|
| C1 | `## YOU MUST FOLLOW THESE RULES` as first section | ✅ |
| C2 | `OUTPUT LENGTH MUST BE ≤ 30% OF ORIGINAL` in ALL CAPS | ✅ |
| C3 | `CITATION FORMAT: [§N]` as standalone subsection | ✅ |
| C4 | `## Example Output` section | ✅ |
| C5 | `[§1]` pattern in example | ✅ |
| C6 | Length ratio statement (e.g. `~32%`) | ✅ |
| C7 | Entity retention rule preserved | ✅ |
| C8 | `## Purpose` preserved | ✅ |
| C9 | `## Working Principles` preserved | ✅ |
| C10 | `npx tsc --noEmit` exits 0 | ✅ |
| C11 | File size < 3000 bytes | ✅ (2985) |

## Risk Mitigation

- Zero code changes → no runtime impact
- File size trimmed to under 3000 via targeted compression
- All original content preserved (reordered, not deleted)
