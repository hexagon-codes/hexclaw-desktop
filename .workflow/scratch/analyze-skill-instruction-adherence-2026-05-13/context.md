# Context: Skill Instruction Adherence Analysis

**Date**: 2026-05-13
**Topic**: Why summarize skill did not follow ≤30% and [§N] constraints

## Decisions

### Decision 1: Root Cause — Content Structure, Not Pipeline
- **Context**: The `@summarize` pipeline correctly injects SKILL.md into system prompt
- **Evidence**: skillBridge.ts:139-152 loads SKILL.md → loads SkillLayer → executor reads `.skill.markdown` → buildPromptInput assembles into system prompt
- **Chosen**: Content restructure (no code change)
- **Reason**: Zero runtime change, highest impact per effort

### Decision 2: [§N] Non-Compliance Fix
- **Context**: [§N] is a custom format; no training data; no example in SKILL.md
- **Options**:
  1. Add example output with [§N] (no code)
  2. Add structured output contract (needs new type)
  3. Post-check + re-prompt (violates Runtime)
- **Chosen**: Example output in SKILL.md (P0)
- **Reason**: Examples > declarative rules for LLMs

## Constraints

### Locked
- No Workflow / Planner / Validator Engine / Multi-pass repair
- No new Runtime abstractions (BPMN, DAG, Agent loop)
- Pipeline correctness is NOT the issue — content is

### Free
- SKILL.md can be restructured arbitrarily (content-only change)
- Emphasis, repetitions, ALL CAPS are allowed in SKILL.md
- systemLayer.constraints can be populated (existing mechanism)

### Deferred
- Structured response contract (JSON schema / output template)
- Post-check validation service
- Model-specific system prompt overrides

## Code Context
- `skills/builtin/summarize/SKILL.md` — primary fix target
- `src/services/agentAdapter.ts:37-63` — buildPromptInput, reads `.skill.markdown`
- `src/services/contextManager.ts:33-41` — DEFAULT_SYSTEM_LAYER, constraints = []
- `src/services/skillBridge.ts:139-152` — SKILL.md loading + SkillLayer injection
