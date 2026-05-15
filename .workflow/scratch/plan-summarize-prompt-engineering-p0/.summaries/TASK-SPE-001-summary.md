# TASK-SPE-001 Summary: SKILL.md Prompt Rewrite

## Status: ✅ Completed

### Changes
- Rewrote `skills/builtin/summarize/SKILL.md` from English to Chinese
- Iterated 10 versions (v1 → v10) through UAT testing
- Final version uses Chinese instructions for better model compliance

### Key Design Decisions
1. **[要点N] format over [§N]**: Model mimo-v2.5 consistently refused [§N] output despite § being in its vocabulary. [要点N] works reliably (7/7 test passes).
2. **Chinese instructions**: Model responds better to Chinese language instructions for Chinese text extraction.
3. **User message reinforcement**: Due to recency bias, format constraints are reinforced in the `[MODE: DIRECT]` suffix of the user message.
4. **Line-level constraints**: Per-line char limits (≤45 chars) more effective than total percentage constraints.

### Final SKILL.md Structure
- **角色**: 单遍提取引擎，不对话
- **格式**: [要点N], 禁止【要点】
- **规则**: 3行上限, 每行≤45字, 保留实体, 删冗余词
- **禁止**: 免责声明/推理链/聊天/表情/Markdown/问候/【要点】

### Convergence
- ✅ [要点N] format enforced
- ✅ No fact-checking mode
- ✅ No disclaimers/reasoning chains
- ✅ Entity retention directives
- ✅ Length constraints (per-line + total)
- ✅ No step-by-step language
- ✅ No disclaimers in output

### Files Modified
- `skills/builtin/summarize/SKILL.md` — full rewrite
