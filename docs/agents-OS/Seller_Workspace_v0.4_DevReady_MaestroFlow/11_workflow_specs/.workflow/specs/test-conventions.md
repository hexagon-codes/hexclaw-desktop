---
title: Seller Workspace Test Conventions v0.4
roles: [test, implement]
tags: [test, uat]
---

<spec-entry roles="test,implement" keywords="activation,uat" date="2026-05-10">

### Activation UAT must pass

New device opens activation page, valid unused code activates and enters Chat, invalid/expired/already-bound codes show exact error messages, and activated device reopens directly into Chat.

</spec-entry>

<spec-entry roles="test,implement" keywords="skillruntime,image-pipeline,uat" date="2026-05-10">

### SkillRuntime UAT must pass

`POST /api/v1/tasks/execute` must create a task, pass through `SkillRuntime.ExecuteSkill`, use `ExecutorRegistry`, execute `ImagePipelineExecutor`, update progress, and return result manifest. Disabled or unauthorized Skill must not call Provider.

</spec-entry>
