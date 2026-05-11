---
title: Seller Workspace Tools v0.4
roles: [implement, test, review]
tags: [tools, workflow]
---

<spec-entry roles="implement,test" keywords="p0,acceptance,flow" date="2026-05-10">

### P0 Acceptance Flow

1. Start backend and databases.
2. Start Tauri client and admin frontend.
3. Create activation code in admin.
4. Open new client device and activate.
5. Upload product image in Chat.
6. Confirm asset role.
7. Trigger image_pipeline.
8. Verify task goes through SkillRuntime.
9. Verify result card.
10. Modify parameter_schema in admin and confirm next Chat parameter card changes.

</spec-entry>
