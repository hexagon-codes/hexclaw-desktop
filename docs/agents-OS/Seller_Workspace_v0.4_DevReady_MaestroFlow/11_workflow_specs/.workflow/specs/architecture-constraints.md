---
title: Seller Workspace Architecture Constraints v0.4
roles: [plan, implement, review]
tags: [seller-workspace, architecture, skillruntime]
---

<spec-entry roles="plan,implement,review" keywords="tauri,vue,go,react,skillruntime" date="2026-05-10">

### P0 technology stack is frozen

User client is Tauri 2.0 + Vue 3 + Naive UI + Pinia + Tailwind + TypeScript. Admin is React + Ant Design + TypeScript. Backend is Go + Gin + PostgreSQL + Redis + S3/local object storage. Do not migrate to Electron. Do not rewrite runtime as fully local.

</spec-entry>

<spec-entry roles="plan,implement,review" keywords="p0,marketplace,reseller,browser" date="2026-05-10">

### P0 scope guardrail

P0 only implements SkillRuntime MVP, image_pipeline, admin parameter governance, Chat-first dynamic parameter card, Tauri desktop resource access, and activation/device license flow. Marketplace, full reseller panel, Browser/RPA, external Skill download, and user custom Skill lifecycle are P1/P2/V2.

</spec-entry>
