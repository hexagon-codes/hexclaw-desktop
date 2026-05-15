# Skill Instruction Adherence Analysis

**Date**: 2026-05-13
**Topic**: Why `@summarize` output did not strictly follow SKILL.md constraints (≤30%, [§N] citation)
**Model**: mimo-v2.5 (Anthropic-compatible proxy)
**Verification context**: Manual UAT — output ratio 41.9%, no [§N] citations

---

## 1. Prompt Structure (Actual)

The assembled system prompt sent to the LLM:

```
# Summarize

## Purpose
Condense lengthy documents...

## Working Principles
1. **Compress without loss** — ...
2. **Structure by information type** — ...
3. **Proportional coverage** — ...
4. **Neutral tone** — ...

## Constraints
- Target length: ≤ 30 % of original (hard limit: 2000 tokens)
- Must retain all numbers, dates, names, and quantitative claims
- Must not introduce information absent from the source
- Must cite the source section for each major claim (using `[§N]` notation)

## Common Patterns
...

## Quality Bar
...
```

**Key observation**: The entire SKILL.md is sent as a single `system` role message. No additional system-layer constraints (DEFAULT_SYSTEM_LAYER.constraints is `[]`). The user message contains only the stripped text (no `@summarize` prefix).

---

## 2. Root Cause Analysis

### 2.1 Instruction Ordering

The `Constraints` section is the **4th section** (after Purpose, Working Principles, and their detailed descriptions). For LLM instruction-following, position matters:

- Earlier content establishes the *frame* ("what is this document about?") → summarization behaviors
- Later content is treated as *nuance* or *additional notes* → constraint rules
- The hard constraints (`≤30%`, `[§N]`) are physically positioned near the bottom, competing with "Common Patterns" (examples) and "Quality Bar" (meta evaluation)

**Impact**: HIGH. The frame is set as "how to summarize well" before "what to strictly enforce."

### 2.2 System Prompt Layering

The prompt has only two layers:
1. `system: SKILL.md` — full document
2. `user: <text>`

There is **no separation** between:
- Role definition / identity
- Behavioral rules (must follow)
- Output format specification
- Task-specific instruction

In the `buildPromptInput` function (agentAdapter.ts:37-63):
```typescript
const parts: string[] = []
if (skillLayer?.markdown) parts.push(skillLayer.markdown)        // entire SKILL.md
if (systemLayer?.constraints?.length) parts.push(constraints)    // EMPTY — never populated
```

The `systemLayer.constraints` array is **always empty** (DEFAULT_SYSTEM_LAYER.constraints = `[]` in contextManager.ts:41). There's no mechanism to inject system-level enforcement rules on top of the skill markdown.

**Impact**: HIGH. No structural separation between "guidance" and "hard rules."

### 2.3 Constraint Salience

The constraints are formatted as markdown bullet points:

```markdown
- Target length: ≤ 30 % of original (hard limit: 2000 tokens)
- Must retain all numbers, dates, names, and quantitative claims
- Must not introduce information absent from the source
- Must cite the source section for each major claim (using `[§N]` notation)
```

Problems:
- No ALL CAPS / bold / emphasis on key rules
- "hard limit" is mentioned but not enforced structurally
- `[§N]` format is a parenthetical note — easy to overlook
- 4 rules presented as a list with equal visual weight

For LLMs, visual salience correlates with compliance:
- Bold text → higher attention
- Repetition → higher compliance
- Position (beginning/end) → primacy/recency effects
- Explicit formatting → higher recall

**Impact**: MEDIUM. Constraints are visible but not emphasized.

### 2.4 Markdown Structure Impact

SKILL.md is structured as a **documentation page** (hierarchical headings, paragraphs, lists). This frame signals:
> "This is a specification document describing the skill."

Not:
> "These are instructions you must execute."

The markdown structure:
```
# Summarize           ← Title (feels like a doc page)
## Purpose            ← Background context
## Working Principles ← Guidelines (numbered = suggestions)
## Constraints        ← Rules (bullet list = items to check)
## Common Patterns    ← Examples (for reference)
## Quality Bar        ← Meta criteria (for evaluation)
```

**The document reads like a skill reference, not a command prompt.** For comparison, effective system prompts use:
- Direct imperatives: "YOU MUST output in format X"
- XML/template structures: `<output><summary>...</summary></output>`
- Repeated emphasis across sections

**Impact**: HIGH. Document tone signals "reference material" not "executable instructions."

### 2.5 Example-Driven Prompting

The SKILL.md has "Common Patterns" with structural examples (meeting notes, research paper, email thread) but **no example output** showing [§N] citations or length-constrained summaries.

For LLMs, examples are more powerful than declarative rules. A single example like:

```markdown
## Example Output
[§1] Key finding with citation
[§2] Another finding with citation
Length: 28% of original ✓
```

Would be more effective than the declarative "Must cite the source section for each major claim (using [§N] notation)."

**Impact**: HIGH. No positive example = model must infer format from a 3-word parenthetical note.

### 2.6 Hard Constraint vs Soft Instruction

The constraints use "Must" language but aren't structurally enforced:
- "Must" is a strong English modal, but LLMs treat it as preference when surrounded by softer language
- No output schema — model can format freely
- No length enforcement mechanism (no token budget, no trimming)
- [§N] format is novel to most models (it's a custom convention, not a standard citation style like `[1]` or `(Author, 2023)`)

The 30% length constraint is particularly hard for LLMs:
- Models don't natively "count" output length before generation
- Semantic compression varies by content density
- 30% is aggressive for some content types

**Impact**: HIGH. Constraints are declarative with no structural enforcement.

### 2.7 Model-Specific Obedience

The model used is `mimo-v2.5` (Anthropic-compatible proxy via xiaomimimo.com). Observations:
- Output format is naturally structured (good)
- But uses conventional bullet format, not [§N]
- Standard formatting is the model's "default summarization behavior"
- Custom conventions like [§N] require **overriding** the model's trained behavior

Known obedience factors:
- Anthropic models (Claude) have high instruction-following
- Proxy models may have different training data
- Custom citation formats are low-frequency patterns in training data
- The model naturally outputs "section: key point" format (its default summary style)

**Impact**: MEDIUM. Model choice affects obedience, but the fundamental issue is prompt design.

### 2.8 Structured Response Contract

No structured output contract exists. The LLM receives:
```
system: [markdown document]
user: [text]
```

And returns free-form text. Compare with structured contracts that significantly improve format compliance:

```typescript
// Hypothetical structured contract
{
  "format": "markdown",
  "sections": ["summary", "citations"],
  "citation_style": "[§N]",
  "max_length_ratio": 0.3
}
```

Without a contract:
- Any output format is valid
- No parsing/validation of citations
- No length enforcement

**Impact**: HIGH. Free-form text output is the most significant single factor.

### 2.9 Post-Check

No post-generation validation exists. The pipeline:
```
SKILL.md → buildPromptInput → provider.execute → ChatMessage → UI
```

There's no:
- Length ratio check after generation
- [§N] citation presence check
- Entity retention verification
- Format compliance validation

This is by design (Runtime philosophy prohibits validator engines, multi-pass repair, Workflow).

**Impact**: HIGH. No feedback loop — the LLM never learns that it violated constraints.

### 2.10 Runtime Philosophy Violation Risk

Potential fixes and their compatibility with Runtime philosophy:

| Fix | Violates Runtime? | Reason |
|-----|------------------|--------|
| Restructure SKILL.md (order/emphasis) | No | Pure content change, no code |
| Add output example to SKILL.md | No | Pure content change, no code |
| Populate systemLayer.constraints | No | Uses existing mechanism, no new abstraction |
| Add structured response contract | ⚠️ Low | Would need new type/adapter but no Workflow/BPMN |
| Add post-check validation | ⚠️ Possible | Could be adapter-level, not engine-level |
| Add LLM re-prompt/repair | ❌ Yes | Workflow pattern, violates ADR-001/ADR-008 |
| Add validator engine | ❌ Yes | New abstraction, violates Runtime philosophy |
| Add multi-pass execution | ❌ Yes | Directly banned (no DAG/Workflow/Agent loop) |

**Impact**: MEDIUM. Most effective fixes violate Runtime; acceptable fixes are content-only.

---

## 3. Synthesized Root Cause

The constraint non-adherence is caused by a **compounding cascade** of 4 factors:

```
Primary:  No structured output contract
  → Model can format freely
  → LLM uses its default summary style (bullets, no [§N])

Secondary: SKILL.md reads like documentation, not instructions
  → Constraints buried in middle-bottom of document
  → No emphasis/hierarchy on mandatory rules
  → No positive example of expected output

Tertiary: No system-level constraint reinforcement
  → systemLayer.constraints is always empty
  → No separation between "guidance" and "hard rules"

Quaternary: No post-check feedback
  → Model never "sees" its own compliance
  → No mechanism to correct or adjust
```

**The pipeline correctly injects SKILL.md into the system prompt.** The issue is not in the pipeline (skillBridge → agentAdapter) but in the **content structure** of SKILL.md and the **lack of structural enforcement** at the prompt assembly level.

---

## 4. Fix Recommendations (Runtime-Compatible)

### P0: Restructure SKILL.md (No Code Change)

Reorder sections to put **Constraints FIRST**, make them visually salient:

```markdown
# Summarize

## YOU MUST FOLLOW THESE RULES

### Rule 1: Length ≤ 30%
Output must be ≤30% of the original text length (hard limit: 2000 tokens).

### Rule 2: Cite Sources with [§N]
Every major claim MUST cite its source section using [§N] notation.
Example: "鸿蒙装机量突破 12 亿台 [§1]"

### Rule 3: ...
```

Rationale: Zero code change, proven LLM psychology (primacy effect + emphasis).

### P0: Add Output Example

Add a concrete example showing the expected format WITH [§N]:

```markdown
## Example Output
Claude analyzed a 500-word article and produced:

[§1] Anthropic released Claude 3.5 Sonnet with 2× speed improvement
[§2] New safety features include constitutional AI v2
[§3] Pricing remains unchanged at $3/1M input tokens

Length: 28% of original ✓
```

Rationale: Examples > declarative rules for LLMs.

### P1: Populate systemLayer.constraints

Use the existing `systemLayer.constraints` mechanism (currently always `[]`). In skillBridge.ts, after loading the skill, inject enforcement rules:

```typescript
// After loadSkillLayerForTask, before executeChatTask:
runtime.addConstraint(taskId, "Output MUST use [§N] citation format")
runtime.addConstraint(taskId, "Output MUST be ≤30% of original length")
```

This would make the actual prompt:
```
[SKILL.md content]

Output MUST use [§N] citation format
Output MUST be ≤30% of original length
```

The constraints appear AFTER skill markdown as a separate, emphasized block.

### P1: Model-Level Default Prompt

If the provider allows a default system prompt (for models that override it), add enforcement rules there. However, this would be provider-specific and less portable.

### P2: Output Template in SKILL.md

Embed a template in SKILL.md:
```markdown
## Output Template
[§{N}] {Claim} — {Evidence}
[§{N}] {Claim} — {Evidence}
...
Summary length: {X}% of original
```

### ⛔ NOT Recommended (Runtime Philosophy Violations)

- Workflow/Planner/Agent loop for repair
- Validator engine for post-check
- Multi-pass correction
- BPMN/DAG orchestration

---

## 5. Conclusion

The constraint non-adherence is a **prompt content and structure problem**, not a pipeline defect. The pipeline (skillBridge → agentAdapter → provider) works correctly — SKILL.md is loaded and injected into the system prompt. But the SKILL.md content is formatted as documentation rather than executable instructions, with no structural enforcement mechanisms.

**Recommended fix**: Restructure SKILL.md (Constraints First + Examples + Emphasis). Code change scope: zero.
