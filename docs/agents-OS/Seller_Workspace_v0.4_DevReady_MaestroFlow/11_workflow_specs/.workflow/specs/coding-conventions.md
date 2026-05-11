---
title: Seller Workspace Coding Conventions v0.4
roles: [implement, review]
tags: [coding, conventions]
---

<spec-entry roles="implement,review" keywords="schema,dynamic-form,frontend" date="2026-05-10">

### Do not hardcode Skill forms in Chat

The Chat parameter card must be rendered from backend `parameter_schema` and safe defaults. Do not hardcode productName/category/style/count/referenceImage fields inside the Chat component.

</spec-entry>

<spec-entry roles="implement,review" keywords="prompt,security,frontend" date="2026-05-10">

### Prompt must stay server-side

Frontend must not contain Prompt templates, Prompt assembly logic, strategy fragments, context construction rules, or sensitive operational params.

</spec-entry>
