# SKILL.md Section Reorder Proposal

## Current Order (documentation style)
```
# Summarize
## Purpose
## Working Principles
## Constraints          ← buried 4th
## Common Patterns
## Quality Bar
```

## Proposed Order (instruction style)
```
# Summarize
## YOU MUST FOLLOW THESE RULES      ← 1st: primacy effect
### Rule 1: OUTPUT LENGTH ≤ 30%
### Rule 2: CITATION FORMAT [§N]
### Rule 3: RETAIN ALL ENTITIES
### Rule 4: NO HALLUCINATION
## CITATION FORMAT: [§N]            ← 2nd: dedicated explanation
## Purpose                          ← 3rd: context
## Working Principles               ← 4th: methodology
## Example Output                   ← 5th: concrete demonstration
## Common Patterns                  ← 6th: reference
## Quality Bar                      ← 7th: meta evaluation
```

## Rationale

| Change | Why |
|--------|-----|
| Constraints moved from §4 → §1 | LLM primacy effect — first content gets highest attention and compliance |
| ALL CAPS for rule headers | Increases salience in system prompt processing; proven prompt engineering practice |
| [§N] as standalone section | Custom format needs dedicated explanation, not buried in bullet list |
| Example Output after Principles | Concrete demonstration after abstract rules — shows, not just tells |
| Quality Bar moved to last | Self-evaluation criteria are meta; placed after all other content |
