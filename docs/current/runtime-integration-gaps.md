# Runtime Integration Gaps 文档

> 日期：2026-05-14 | 基于 Workspace Runtime Integration Analyze

---

## Gap 清单

### G1: Skill Registry 目录结构不匹配

**严重度**: Critical

**现象**: `SkillRegistry.discoverFromDir()` 扫描 `skills/`，但实际技能在 `skills/builtin/` 下。Registry 从未发现任何技能。

**影响**: `@summarize` / `@bulletize` 回退为普通 chat，Skill 执行路径完全失效。

**根因**: Registry 预期 `skills/{skillId}/skill.json`，实际为 `skills/builtin/{skillId}/skill.json`。

---

### G2: ChatView Message-centric

**严重度**: Critical

**现象**: ChatView 是用户主入口，但对 Runtime 完全不感知。无 task status、无 timeline、无 skill metadata。

**影响**: Skill 执行的 Runtime 丰富度被 Message Bubble 完全吞没。

**当前状态**: Wave 1 (chat-task-bridge-v0.1) 已修复 — TaskBadge 注入 metadata，但依赖 G1 修复才能真正生效。

---

### G3: Runtime/Workspace 分离

**严重度**: High

**现象**: WorkspaceView 是唯一 Runtime-native 页面（projection layer + 三面板），但与用户主路径（Chat）隔离。

**影响**: Runtime 丰富的 task context 被锁在 `/workspace` 页面，用户无法从 Chat 直达。

**已修复**: TaskBadge 点击跳转 `/workspace?taskId=xxx`（chat-task-bridge-v0.1）。

---

### G4: WS/RT 双路径漂移

**严重度**: Medium

**现象**: 同时存在 WebSocket (Go backend) 和 Runtime (Tauri frontend) 两条执行路径，通过 `execMode` toggle 控制。

**影响**:
- 代码复杂度高，两条路径维护成本翻倍
- execMode toggle 产品语义不清晰
- Streaming 仅 WS 路径支持

**待处理**: execMode convergence (P1)

---

### G5: Skill 输出 Surface 问题

**严重度**: Medium

**现象**: Skill 执行结果以普通 assistant message 渲染，无特殊 UI（无 skill name badge、无 SKILL.md 内容展示）。

**已修复**: TaskBadge 显示 skill name + status + elapsed（chat-task-bridge-v0.1），但依赖 G1。

---

### G6: Official/Custom 目录规范问题

**严重度**: Medium

**现象**:
- `SkillRegistry` 双目录扫描（Resource + AppData），Official 优先
- `SkillLoader` 支持嵌套路径（如 `builtin/summarize`）
- `SkillRegistry.sanitizeSkillId()` 不允许 `/`，`SkillLoader` 允许
- 两者的 skillId 规范不一致

**影响**: 目录结构混乱，Official/Custom 边界不清晰。

---

### G7: Tauri Resource 打包问题

**严重度**: Low

**现象**: `tauri.conf.json` 配置 `"skills/*": "skills/"`，映射项目根 `skills/` 到 bundle。但 `skills/builtin/` 多一层目录，导致 Registry 扫描失败。

**影响**: 即使修复 G1（扁平化目录），仍需确认 Tauri bundle 正确包含技能文件。

---

### G8: RuntimeContext 执行后卸载

**严重度**: Low

**现象**: `unloadStaleLayers()` 在任务完成后卸载 execution layer，导致 Workspace 中已完成任务的 context 不完整。

**影响**: Workspace 无法查看已完成任务的执行详情。

---

### G9: Asset 无 UI 渲染

**严重度**: Low

**现象**: `AssetCollection` 在 RuntimeContext 中已实现 register/invalidate/reconcile，但 ContextDetailPanel 仅 legacy outputs 回退，无正式 Asset 渲染。

**影响**: Task 生成的资产（文件、图片等）不可见。

---

### G10: DashboardView 无 Runtime 数据

**严重度**: Low

**现象**: DashboardView 未接入 Runtime 数据，无法展示任务概览、成功率、耗时统计。

**影响**: 用户无法从 Dashboard 了解 Runtime 运行状况。

---

## 优先级排序

| 优先级 | Gap | 说明 |
|--------|-----|------|
| **P0** | G1 | Skill Registry 目录结构不匹配 — Skill 执行完全失效 |
| **P1** | G4 | WS/RT 双路径漂移 — 代码复杂度 |
| **P2** | G6 | Official/Custom 目录规范 — 长期维护 |
| **P2** | G8 | RuntimeContext 执行后卸载 — Workspace 完整性 |
| **P3** | G7 | Tauri Resource 打包 — 确认性验证 |
| **P3** | G9 | Asset 无 UI 渲染 — 产品化 |
| **P3** | G10 | DashboardView 无 Runtime 数据 — 产品化 |
| **已修** | G2 | ChatView message-centric — Wave 1 已修复 |
| **已修** | G3 | Runtime/Workspace 分离 — Wave 1 已修复 |
| **已修** | G5 | Skill 输出 Surface — Wave 1 已修复 |
