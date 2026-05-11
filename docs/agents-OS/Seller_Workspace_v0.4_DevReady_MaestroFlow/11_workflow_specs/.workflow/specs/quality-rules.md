---
title: Seller Workspace Quality Rules v0.4
roles: [review, test, implement]
tags: [quality, acceptance]
---

<spec-entry roles="review,test" keywords="definition-of-done,p0" date="2026-05-10">

### P0 Definition of Done

P0 is done only when activation, Chat upload, asset confirmation, schema-driven parameter card, task execution through SkillRuntime, result display, admin Skill schema editing, and backend entitlement check all pass acceptance tests.

</spec-entry>

<spec-entry roles="review,test" keywords="permission,entitlement,backend" date="2026-05-10">

### Backend permission check is mandatory

Frontend visibility is not a security boundary. Every Skill execution must perform backend device, activation code, plan, Skill visibility, Skill executable, capability, and quota checks.

</spec-entry>
