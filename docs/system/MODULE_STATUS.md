# Module Status

> 日期：2026-05-14

---

## 已完成

| Module | Tag | 日期 | 说明 |
|--------|-----|------|------|
| Runtime Constitution v0.9 | `runtime-constitution-v0.9` | 05-13 | 9 条 ADR |
| SPE Archetype v0.1 | `spe-archetype-v0.1` | 05-14 | Skill 模板冻结 |
| summarize alpha | `summarize-skill-alpha` | 05-14 | v10 SPE SKILL.md |
| bulletize alpha | `bulletize-skill-alpha` | 05-14 | [•] 格式变体 |
| Desktop Runtime Path | `desktop-runtime-skill-path-p0` | 05-13 | systemPrompt + request_id |
| Runtime-native P0 | `runtime-native-p0` | 05-14 | type='skill' 路由 |
| Runtime Error Boundary | `runtime-error-boundary-v0.1` | 05-13 | BridgeError |
| Capability Gate | `capability-gate-p0` | 05-13 | skillBridge 预检 |
| Official Skill Boundary | `official-skill-boundary-p0` | 05-13 | 双 BaseDirectory |
| Chat-first Skill Flow | `chat-first-skill-flow-p0` | 05-13 | @mention + tryExecuteSkill |
| ADR Wave 2 | `runtime-constitution-v0.9` | 05-13 | ADR-005~008 |
| Skill Execution Mode Fix | `skill-context-injection-p0` | 05-13 | commands.rs + MODE:DIRECT |
| Chat-Task Bridge | `chat-task-bridge-v0.1` | 05-14 | TaskBadge + metadata |

## 进行中

| Module | 状态 | 说明 |
|--------|------|------|
| Skill Directory Alignment | **执行中** | 扁平化目录，解锁真实 skill 路径 |

## 待执行

| Module | 优先级 | 依赖 |
|--------|--------|------|
| Module 002: Chat-Task Bridge UAT | P0 | Module 001 |
| Module 003: Result Surface | P1 | Module 001 |
| Module 004: Workspace Task Detail | P1 | — |
| Module 005: Runtime LLM Contract | P1 | — |
| Module 006: execMode Convergence | P1 | — |

## Deferred

| 项 | 原因 |
|----|------|
| TaskResult type hardening | 当前够用 |
| WS/RT D2 reasoning bridge | 等 executor 产出 |
| Asset Gallery | P3 |
| Dashboard Runtime 数据 | P3 |
