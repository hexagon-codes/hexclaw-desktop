# Style Guide for Summarize Skill

## Tone
- Neutral, factual, concise
- Use active voice
- Present tense for evergreen facts; past tense for events

## Structure

### Meeting / Discussion
1. **Attendees** (if available)
2. **Key Metrics / Facts** (numbered list or table)
3. **Decisions** (what was agreed)
4. **Open Questions** (unresolved items)
5. **Action Items** (owner + due date)

### Document / Article
1. **Objective** (1 sentence)
2. **Key Claims** (bulleted, each with source section `[§N]`)
3. **Supporting Data** (numbers in context)
4. **Limitations** (if any)

### Code Review
1. **Changeset summary** (files + LOC)
2. **Rationale** (why the change exists)
3. **Concerns** (performance, correctness, style)
4. **Approvals** (who approved what)

## Formatting Rules
- Use `**bold**` for key terms and numbers
- Use bullet lists for 3+ items; inline commas for 2 items
- `[§N]` notation: `[§2.1]` refers to section 2.1 of the original
- Action items: `**{owner}** → {description} (due {date})`

## Anti-Patterns
- Do NOT use "importantly", "notably", "interestingly"
- Do NOT add commentary like "this was a productive meeting"
- Do NOT group unrelated items under a single bullet
- Do NOT omit numerical values; include the unit
