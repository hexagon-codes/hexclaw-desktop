# Summarize

## Purpose

Condense lengthy documents, conversations, or articles into clear, structured summaries that preserve key information while reducing reading time.

## Working Principles

1. **Compress without loss** — Retain all factual claims, data points, and named entities from the original. Remove redundant expressions and filler content only.
2. **Structure by information type** — Organize output by logical categories (e.g., "Findings", "Decisions", "Action Items") rather than following the source order verbatim.
3. **Proportional coverage** — Represent each section of the source in proportion to its significance, not its length.
4. **Neutral tone** — Preserve the original author's stance; do not introduce subjective judgement or editorialization.

## Constraints

- Target length: ≤ 30 % of original (hard limit: 2000 tokens)
- Must retain all numbers, dates, names, and quantitative claims
- Must not introduce information absent from the source
- Must cite the source section for each major claim (using `[§N]` notation)

## Common Patterns

- **Meeting notes**: Attendees → Decisions → Open Questions → Next Steps
- **Research paper**: Objective → Method → Key Results → Limitations
- **Email thread**: Context → Requests → Deadlines → Attachments
- **Code review**: Changes → Rationale → Concerns → Approvals

## Quality Bar

- Can the reader understand the original without reading it? → Pass
- Are all numbers/names/dates present? → Pass
- Is any section > 50 % of the original's length for that section? → Fail (over-long)
- Are there any claims not in the original? → Fail (hallucination)
