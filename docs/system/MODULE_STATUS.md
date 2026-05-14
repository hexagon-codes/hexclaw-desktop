# MODULE_STATUS

> Runtime-native 二次开发模块状态  
> Version: v0.3  
> Date: 2026-05-15

---

## 1. Completed Milestones

| Module / Milestone | Tag | Status | Meaning |
|---|---|---|---|
| Runtime Constitution v0.9 | runtime-constitution-v0.9 | done | ADR baseline |
| Runtime Error Boundary | runtime-error-boundary-v0.1 | done | BridgeError formalized |
| Chat-first Skill Flow | chat-first-skill-flow-p0 | done | @mention invocation |
| Capability Gate | capability-gate-p0 | done | Skill pre-check |
| Official Skill Boundary | official-skill-boundary-p0 | done | Resource/AppData split |
| Skill Context Injection | skill-context-injection-p0 | done | SKILL.md enters context |
| Desktop Runtime Path | desktop-runtime-skill-path-p0 | done | systemPrompt / Tauri path |
| SPE Archetype v0.1 | spe-archetype-v0.1 | done | Single-pass extraction template |
| summarize alpha | summarize-skill-alpha | done | [要点N] output contract |
| bulletize alpha | bulletize-skill-alpha | done | bullet output contract |
| Runtime-native P0 | runtime-native-p0 | done | type='skill' routes to RuntimeLLMExecutor |
| Chat-Task Bridge | chat-task-bridge-v0.1 | done | TaskBadge + metadata |
| Module 004: Workspace Task Detail | workspace-task-detail-v0.1 | done | Skill SKILL.md 展开 + Execution output 折叠 + Result assets 渲染 |
| Module 005: Runtime LLM Contract | runtime-llm-contract-v0.1 | done | XML prompt 结构 + stop sequence + 输出验证重试 |
| Module 006: execMode Convergence | execMode-convergence-v0.1 | done | 移除 execMode toggle，统一 Runtime 路径 |

---

## 2. Current Active Module

| Module | Priority | Status | Goal |
|---|---|---|---|
| Module 001: Skill Directory Alignment | P0 | done (with limitation) | Move skills/builtin/* to skills/* so Registry can discover skills |
| Module 002: Chat-Task Bridge UAT | P0 | done | Verify TaskBadge end-to-end in Tauri Desktop |
| Module 003: Result Surface | P1 | **done** | SkillResultCard 组件，卡片化渲染 Skill 结果 |
| Module 007: Skill Package Format | P2 | **Phase 1+2 done** | skill.json schema + SkillLoader 多层加载 + 向后兼容 |

### Module 001 Exit Criteria (Adjusted)

- [x] `skills/summarize/skill.json` exists
- [x] `skills/bulletize/skill.json` exists
- [x] `skills/builtin/` removed or empty
- [x] `@summarize` resolves to skill
- [x] `@bulletize` resolves to skill
- [x] Chat TaskBadge appears
- [x] Workspace task jump works

> **Resolved**: `@summarize` 的 `[要点N]` 输出格式问题已在 Module 005 (Runtime LLM Contract) 中系统性解决：XML prompt 结构 + stop sequence + 输出验证重试。

### Module 002 Exit Criteria

- `@summarize` → 消息 + TaskBadge
- `@bulletize` → 消息 + TaskBadge
- 普通 chat → 无 badge
- 点击 TaskBadge → `/workspace?taskId=xxx`

---

## 3. Next Modules

| Module | Priority | Depends On | Status |
|---|---|---|---|

---

## 4. Deferred

| Item | Reason |
|---|---|
| Workflow runtime | Explicitly forbidden in current phase |
| Multi-agent | Too early; context/workspace surface first |
| Browser Runtime | Capability phase later |
| Asset Gallery | P3 productization |
| Dashboard Runtime data | P3 |
| MemoryLayer visualization | P3 |
| TaskResult hardening | Current shape sufficient |
| Validator/repair loop | Would pull system toward workflow/agent loop |

---

## 5. Recovery Instruction

When resuming:

1. Read `PROJECT_CONSTITUTION.md`
2. Read `SYSTEM_MAP.md`
3. Read `MODULE_STATUS.md`
4. Check `git status --short`
5. Continue only the active module
6. Module 001/002/003/004/005/006 done.
7. Module 006 (execMode Convergence) 已完成：移除 execMode toggle，所有 chat 统一 Runtime 路径
8. Module 007 (Skill Package Format) → in progress：Phase 1+2 已完成（skill.json schema + TypeScript 类型 + SkillRegistry 自动补全 + SkillLoader 多层加载）。规划文档：`docs/refactor/module-007-skill-package-format.md`
