# Skill Runtime Semantics — Architecture Review & Correction Plan

> 生成日期：2026-05-12
> 状态：analyze/plan only，不修改代码
> 基线：runtime-kernel-v0.5（Phase 1-10 Runtime Kernel 完整 + RuntimeStore sole authority）

---

## 0. 定位声明

```
Skill = Experience Package（经验包）

不是：
  ❌ Workflow Engine
  ❌ Node Graph / DAG
  ❌ Plugin Marketplace
  ❌ DSL Runtime
  ❌ Low-code System
  ❌ Tool Runtime
  ❌ Browser Agent

是：
  ✅ 知识 + 规则 + 示例 + 模板（声明式经验注入）
  ✅ AI-native Experience Package — 教 AI "怎么做事"，不给 AI 执行引擎
```

---

## 1. 当前 Skill Runtime 架构（Phase 3 基线）

### 1.1 现状总览

```
Skill Package (disk)               Discovery               Load                      Inject
═══════════════════               ═══════════            ═══════════               ═══════════
skills/                            SkillRegistry          SkillLoader               ContextLoader
  builtin/                           │                      │                         │
    summarize/                       │ scan skills/         │ readTextFile()           │ loadSkillLayer()
      skill.json ─────────────────────────► SkillMeta       │   skill.json ──► meta    │   ctx.skill = {
      SKILL.md  ──────────────────────────────              │   SKILL.md ──► markdown  │     skillId, skillName,
      references/                                         │   references/─► refs[]    │     markdown, refs,
        example-input.md                                  │   → SkillPackage          │     capabilities,
        example-output.md                                 │                         │     loadedSections
        style-guide.md                                    │                         │   }
                                                          │                         │
                                                     RuntimeStore.loadSkillForTask()
                                                       │
                                                       ├─ skillLoader.loadSkill(id, {loadMarkdown:true})
                                                       ├─ CapabilityValidator.validate(caps, policy, registry)
                                                       ├─ loader.loadSkillLayer(ctx, skillPkg)
                                                       ├─ manager.recalcSize(taskId)
                                                       ├─ writeTimelineEvent('skill.loaded')
                                                       └─ revision.value++
```

### 1.2 现有资产

| 层 | 文件 | 职责 | 状态 |
|----|------|------|:----:|
| 类型 | `src/types/context.ts:23-45, 65-76` | SkillMeta, SkillReference, SkillPackage, SkillLayer | ✓ |
| 类型 | `src/types/skill.ts` | Skill, ClawHubSkill（Backend/UI 层，非 Runtime） | ✓ |
| 类型 | `src/types/capability.ts` | CapabilityName, BUILTIN_CAPABILITIES（18 个） | ✓ |
| 类型 | `src/types/timeline.ts:36-37` | `skill.loaded`, `skill.loadFailed` events | ✓ |
| 发现 | `src/services/skillRegistry.ts` | 扫描 skills/ 目录，缓存 SkillMeta | ✓ |
| 加载 | `src/services/skillLoader.ts` | 读取 skill.json + SKILL.md + references/，构建 SkillPackage | ✓ |
| 注入 | `src/services/contextLoader.ts:145-159` | loadSkillLayer() — SkillPackage → RuntimeContext.skill | ✓ |
| 编排 | `src/stores/runtime.ts:177-228` | loadSkillForTask() — load → validate → inject → timeline | ✓ |
| 校验 | `src/services/capabilityValidator.ts` | Capability 验证（warn-only，Phase 4） | ✓ |
| 持久化 | `src/services/runtime/contextSerializer.ts` | SkillLayer ↔ ContextSnapshot | ✓ |
| 安装 | `src/api/skills.ts` | Skill 安装/卸载/状态切换（Backend API，非 Runtime） | ✓ |

### 1.3 现有 Skill Package

```
skills/builtin/summarize/
  skill.json          → { name: "summarize", capabilities: ["llm"], entry: "SKILL.md" }
  SKILL.md            → Purpose + Working Principles + Constraints + Common Patterns + Quality Bar
  references/
    example-input.md   → 会议记录示例
    example-output.md  → 结构化摘要示例
    style-guide.md     → 语调/结构/格式化规则/反模式
```

---

## 2. Phase 3 Skill Runtime 差距分析

### 2.1 Skill Lifecycle — 不完整

当前生命周期只有一条单向路径：

```
idle → loadSkillForTask() → [loaded]
                               ↓
                         (死胡同 — 无 unload / reload / update 路径)
```

**缺失**：

| 生命周期操作 | 当前状态 | 说明 |
|------------|:--------:|------|
| load | ✓ | loadSkillForTask() |
| unload | ✗ | manager.unloadLayer(taskId, 'skill') 存在但无公开方法 |
| reload | ✗ | loadSkillForTask 在 skill 已加载时静默跳过（line 180），无法强制重载 |
| update | ✗ | 无版本比较、无旧版本卸载+新版本加载的原子操作 |

**loadSkillForTask 的 guard 问题**（`runtime.ts:180`）：

```typescript
if (ctx.skill && ctx.layerStates['skill'] === 'loaded') return
```

这个 guard 阻止了合法的 reload 场景：
- Skill 版本更新后需要重新加载
- SKILL.md 文件被外部修改
- references/ 文件变更

### 2.2 loadedSections 状态机 — 残缺

`SkillLayer.loadedSections` 定义了状态类型 `ContextLayerStatus = 'unloaded' | 'loading' | 'loaded' | 'error'`，但实际使用中：

| 状态 | markdown | references | 说明 |
|------|:--------:|:----------:|------|
| `'unloaded'` | ✓ | ✓ | 初始状态 / 未请求加载 |
| `'loading'` | ✗ | ✗ | **从未被设置** |
| `'loaded'` | ✓ | ✓ | 加载成功时设置 |
| `'error'` | ✗ | ✗ | **从未被设置** |

`'loading'` 和 `'error'` 两个状态虽然定义了，但没有任何代码路径会设置它们。SkillLoader 在 SKILL.md 读取失败时静默返回 `undefined`，references/ 扫描失败时静默返回 `[]`，都不会触发 `'error'` 状态。

### 2.3 Skill 错误分类 — 缺失结构

SkillLoader 抛出的错误：

```typescript
throw new Error(`[SkillLoader] 非法 skillId: ...`)     // sanitizeSkillId
throw new Error(`[SkillLoader] skillId 格式非法: ...`)  // 同上
```

以及 readTextFile 的原生错误（文件不存在、权限不足等）。

**问题**：所有错误都是非结构化的 `Error`。Recovery Runtime 的 `classifyFailure(code)` 依赖结构化 `error.code` 来区分 PERMANENT / TRANSIENT。当前技能加载失败无法被 Recovery 正确分类。

### 2.4 Skill 与 Persistence 的 Restore 鸿沟

`restoreRuntime()` 恢复 SkillLayer 时：

```typescript
// 逐层恢复 — manager.updateLayer 恢复 SkillLayer 数据
if (snapshot.skill) {
  manager.updateLayer(snapshot.taskId, 'skill', normalizeLayer(snapshot.skill))
}
```

恢复后 `ctx.skill.markdown` 包含的是快照时的 SKILL.md 文本。但磁盘上的 SKILL.md 可能已变更（更新、删除、修改）。

**与 Asset 的类比**：Asset 有 `reconcileAssets()` 做显式健康检查。Skill 没有对应的 `reconcileSkill()`。

**结论**：遵循 "Restore ≠ Reconciliation" 原则，Skill 也不需要 auto reconcile。但需要一个显式的 `checkSkillHealth()` 入口。

### 2.5 Capability 系统中的 Skill 元能力

BUILTIN_CAPABILITIES 中定义了 3 个 Skill 元能力：

| Capability | 定义 | 应实现？ | 理由 |
|-----------|------|:--------:|------|
| `skill.discover` | 发现可用 Skill | ✅ 是 | 只读查询，对应 SkillRegistry.getAllSkills() |
| `skill.execute` | 在上下文内执行另一个 Skill | ❌ 否 | Skill 组合/编排 = Workflow，不是 Skill Runtime |
| `skill.load` | 加载 Skill 到 Context | ❌ 否 | 动态加载 = 编排逻辑，属于 RuntimeStore，不暴露为 Capability |

**当前问题**：3 个能力都定义了但都未接线（CapabilityValidator 不知道如何处理它们）。

### 2.6 Skill Package 边界 — templates/ vs scripts/

Skill Package 规范中提到了 `templates/` 和 `scripts/` 目录，但从未定义其内容边界：

| 目录 | 应该是什么 | 为什么 |
|------|----------|--------|
| `references/` | 参考文档（SOP、平台规则、风格指南、示例）| ✓ 已实现，路径索引 |
| `templates/` | 输出模板（Prompt 模板、JSON Schema、格式模板）| ✗ 未实现，应使用与 references/ 相同的路径索引模式 |
| `scripts/` | ❌ **不应属于 Skill Package** | 脚本执行需要 `system.shell` capability，属于 Execution Layer。Skill 是声明式经验包，不含可执行代码 |

---

## 3. 架构修正方案

### 3.1 Skill Lifecycle（完整状态机）

```
                    ┌──────────┐
                    │  idle    │  ctx.skill === undefined
                    └────┬─────┘
                         │ loadSkillForTask(taskId, skillId)
                         ▼
                    ┌──────────┐
                    │ loading  │  loadedSections.{markdown,references} = 'loading'
                    └────┬─────┘
                         │
              ┌──────────┼──────────┐
              ▼          ▼          ▼
         ┌────────┐ ┌────────┐ ┌────────┐
         │ loaded │ │ error  │ │timeout │   loadedSections 反映实际状态
         └───┬────┘ └───┬────┘ └───┬────┘
             │          │          │
             │          │          │  reloadSkill(taskId, skillId)
             │          ▼          │  或 unloadSkill(taskId)
             │     ┌────────┐     │
             │     │ error  │     │
             │     └───┬────┘     │
             │          │          │
             ├──────────┴──────────┤
             │  unloadSkill(taskId)│
             ▼                     ▼
        ┌──────────┐         ┌──────────┐
        │ unloaded │         │  idle    │
        └──────────┘         └──────────┘
             │
             │ reloadSkill(taskId, newSkillId)
             ▼
        [loading → ...]
```

关键操作：
- **loadSkillForTask** — idle → loading → loaded/error
- **unloadSkillForTask** — loaded/error → unloaded/idle (清除 ctx.skill)
- **reloadSkillForTask** — loaded → unload → load (原子操作，避免中间状态泄漏)

### 3.2 loadedSections 状态机修正

```typescript
// 修正前（ContextLoader.loadSkillLayer）：
loadedSections: {
  markdown: skillPkg.markdown !== undefined ? 'loaded' : 'unloaded',
  references: skillPkg.references.length > 0 ? 'loaded' : 'unloaded',
}

// 修正后：
// 1. loadSkillForTask 在调用 SkillLoader 前设置 'loading'：
ctx.skill = { loadedSections: { markdown: 'loading', references: 'loading' } }
// 2. SkillLoader 完成后，loadSkillLayer 根据结果设置 'loaded' / 'error'：
markdown: skillPkg.markdown !== undefined ? 'loaded' : 'error',
references: skillPkg.references.length > 0 ? 'loaded' : 'unloaded',  // 未请求 → unloaded
```

状态变迁规则：

| loadedSections 字段 | 初始 | load 前 | 加载成功 | 加载失败 | 未请求 |
|-------------------|:----:|:------:|:-------:|:-------:|:-----:|
| markdown | unloaded | loading | loaded | error | unloaded |
| references | unloaded | loading | loaded | error | unloaded |

### 3.3 结构化 Skill Error Codes

新增 `SKILL_ERROR_CODES` 供 Recovery 分类：

```typescript
// 常量定义位置：src/services/skillLoader.ts 或新文件 src/types/skillErrors.ts
const SKILL_ERROR_CODES = {
  SKILL_NOT_FOUND: 'SKILL_NOT_FOUND',           // skill.json 不存在 → PERMANENT
  SKILL_PARSE_ERROR: 'SKILL_PARSE_ERROR',       // skill.json JSON 解析失败 → PERMANENT
  SKILL_PATH_TRAVERSAL: 'SKILL_PATH_TRAVERSAL', // skillId 包含非法字符 → PERMANENT
  SKILL_MARKDOWN_MISSING: 'SKILL_MARKDOWN_MISSING', // SKILL.md 读取失败 → TRANSIENT
  SKILL_REFERENCES_MISSING: 'SKILL_REFERENCES_MISSING', // references/ 读取失败 → TRANSIENT
  SKILL_IO_ERROR: 'SKILL_IO_ERROR',             // 其他 IO 错误 → TRANSIENT
}
```

这些 code 输入到 Recovery 的 `classifyFailure()`：
- PERMANENT_CODES 新增：`SKILL_NOT_FOUND`, `SKILL_PARSE_ERROR`, `SKILL_PATH_TRAVERSAL`
- TRANSIENT_CODES 新增：`SKILL_MARKDOWN_MISSING`, `SKILL_REFERENCES_MISSING`, `SKILL_IO_ERROR`

### 3.4 skill.discover Capability 接线

`skill.discover` 是只读查询能力，应通过 Capability 系统暴露：

```
SkillRegistry.getAllSkills()
    ↑
CapabilityRegistry 注册 skill.discover handler
    ↑
CapabilityValidator 验证 skill.discover 权限
    ↑
Skill 通过 Capability API 调用 skill.discover
```

实际接线位置：
1. `CapabilityRegistry` 注册 `skill.discover` descriptor（已存在）
2. Runtime 在执行时提供 `skill.discover` 的实现（调用 `SkillRegistry.getAllSkills()`）
3. CapabilityValidator 在验证时识别 `skill.discover` 为已知能力

### 3.5 Skill Health Check

遵循 Asset 的 `reconcileAssets` 模式，Skill 应具备显式的健康检查：

```
checkSkillHealth(ctx) → { healthy: boolean, details: string[] }
  ├─ skill.json 是否存在？
  ├─ SKILL.md 是否存在（如果 loadedSections.markdown === 'loaded'）？
  └─ references/ 路径是否存在变更？
```

**不自动触发** — 与 Asset reconcile 一样，由 UI 或 Task 生命周期显式调用。

### 3.6 Skill Version Semantics（最小实现）

完整版本管理属于 Cloud Control Plane。本地 Runtime 只需：

1. **存储版本号** — 已有（`SkillMeta.version`, `SkillLayer.skillVersion`）
2. **版本比较** — 工具函数 `compareVersions(a, b)` 用于 reload 判断
3. **版本差异检测** — reloadSkillForTask 时比较当前 skillVersion 与磁盘 skill.json version

**不做**：
- 多版本共存
- 版本迁移/兼容性矩阵
- 自动更新/热重载
- 版本锁定

---

## 4. 风险矩阵

| # | 风险 | 严重度 | 可能性 | 影响 | 缓解 |
|---|------|:------:|:-----:|------|------|
| R1 | 已恢复 Context 中 Skill 文件已删除（dangling skill reference） | Medium | Low | `checkSkillHealth()` 检测到后标记 error | 显式健康检查入口 |
| R2 | Skill 更新后 markdown 内容变化但版本号未更新 | Low | Low | 执行时引用过期经验 | consumer-side 判断，非 Runtime 职责 |
| R3 | 恶意 skill.json 注入未授权 capability | High | Low | Capability 验证是 warn-only，无法阻止利用 | 升级为 configurable strict mode（Phase 4 Phase 2） |
| R4 | 大型 SKILL.md（>1MB）撑爆 Context budget | Medium | Medium | Context budget 超限后 warn-only | `estimateSize` 在 load 后触发 budget check |
| R5 | loadSkillForTask 中 skill 已加载时静默跳过，无法 reload | Medium | High | 版本更新无效，需手动 destroy + register | 新增 `reloadSkillForTask()` |
| R6 | SkillLoader 错误无结构化 code，Recovery 无法分类 | Low | High | 持续性错误被误判为 transient | 新增结构化 SKILL_ERROR_CODES |

---

## 5. 实施任务（5 项）

### Task 1: 结构化 Skill Error Codes

**范围**：`src/services/skillLoader.ts` + `src/services/runtime/recoveryClassifier.ts`

- 定义 `SKILL_ERROR_CODES` 常量对象
- SkillLoader 抛出带 `code` 字段的结构化错误（`{ code: string, message: string }`）
- `recoveryClassifier.PERMANENT_CODES` 新增 `SKILL_NOT_FOUND`, `SKILL_PARSE_ERROR`, `SKILL_PATH_TRAVERSAL`
- `recoveryClassifier.TRANSIENT_CODES` 新增 `SKILL_MARKDOWN_MISSING`, `SKILL_REFERENCES_MISSING`, `SKILL_IO_ERROR`

### Task 2: 新增 unloadSkillForTask + reloadSkillForTask

**范围**：`src/stores/runtime.ts`

- `unloadSkillForTask(taskId)` — 清除 ctx.skill，设置 layerStates['skill'] = 'unloaded'，追加 `skill.unloaded` timeline event，revision++
- `reloadSkillForTask(taskId, skillId)` — unload + load 原子操作。比较版本号决定是否需要实际重载。追加 `skill.reloaded` timeline event
- `loadSkillForTask` guard 修改 — 当 skill 已加载但 skillId 不同时，自动 unload 旧 skill 再 load 新 skill（skill swap）

### Task 3: 修正 loadedSections 状态机

**范围**：`src/stores/runtime.ts` (loadSkillForTask) + `src/services/contextLoader.ts` (loadSkillLayer)

- `loadSkillForTask`：在调用 SkillLoader 前设置 `loadedSections.markdown = 'loading'`（如果 loadMarkdown）和 `loadedSections.references = 'loading'`（如果 loadReferences）
- `loadSkillLayer`：根据 SkillPackage 结果设置 `'loaded'` / `'error'` / `'unloaded'`
- `loadSkillForTask` catch block：将 loadedSections 中 loading 状态翻转为 error

### Task 4: 接线 skill.discover Capability + checkSkillHealth

**范围**：`src/services/capabilityRegistry.ts` + `src/stores/runtime.ts`

- CapabilityRegistry 注册 `skill.discover` handler（调用 SkillRegistry.getAllSkills()）
- RuntimeStore 新增 `checkSkillHealth(taskId)` — 显式检查已加载 Skill 的文件是否仍然存在
- 返回 `{ healthy, details }` — 不自动触发，不 append noisy timeline event

### Task 5: Skill Version 最小语义

**范围**：新建 `src/utils/versionUtils.ts` + `src/stores/runtime.ts`

- `compareVersions(a: string, b: string): number` — semver 比较
- `reloadSkillForTask` 中比较当前 skillVersion 与磁盘 skill.json version，决定是否需要实际重载
- `SkillLayer` 新增 `diskVersion?: string` — 记录加载时磁盘上的版本号，供版本漂移检测

---

## 6. 变更文件清单

| 文件 | 操作 | 行数 | Task |
|------|------|:----:|:----:|
| `src/services/skillLoader.ts` | 修改 | +30 | Task 1 — 结构化错误 |
| `src/services/runtime/recoveryClassifier.ts` | 修改 | +6 | Task 1 — 新增 SKILL error codes |
| `src/types/timeline.ts` | 修改 | +3 | Task 2 — skill.unloaded, skill.reloaded events |
| `src/stores/runtime.ts` | 修改 | +80 | Task 2+3 — unloadSkillForTask, reloadSkillForTask, 状态机修正 |
| `src/services/contextLoader.ts` | 修改 | +20 | Task 3 — loadedSections error state |
| `src/services/capabilityRegistry.ts` | 修改 | +10 | Task 4 — skill.discover handler |
| `src/utils/versionUtils.ts` | **新建** | +25 | Task 5 — semver 比较 |

**净效果**：~175 行新增，无破坏性变更。所有现有 public method 签名不变。

---

## 7. 红线约束（Skill Runtime）

```
Skill 身份红线
═══════════════════════════════════════════════════════════
❌ Skill ≠ Workflow Engine — 不做 Skill 组合/串联/DAG
❌ Skill ≠ Plugin System — 不做动态安装/卸载/市场
❌ Skill ≠ DSL Runtime — 不做 Skill 自定义语法解析
❌ Skill ≠ Tool Runtime — 不做 Tool Chain/Agent loop
❌ Skill ≠ Browser Agent — 不做页面自动化
❌ Skill 不控制 Capability — 只声明需求，不强制执行
❌ Skill 不修改 System Layer — 策略层不可被 Skill 覆盖
❌ Skill 不创建/销毁 Context — Context 生命周期属于 RuntimeStore
❌ Skill 不直接操作系统 — 所有系统访问通过 Capability

Skill Package 红线
═══════════════════════════════════════════════════════════
❌ scripts/ 不属于 Skill Package — 可执行代码 = Execution Layer
❌ SKILL.md 不做语义解析 — 原始文本，consumer-side 解析
❌ references/ 不加载文件内容 — 路径索引 only
❌ templates/ 不做预编译/模板引擎 — 声明式格式模板，路径索引
❌ skill.json capabilities 不做运行时 enforce — warn-only（Phase 4）

Skill Runtime 红线
═══════════════════════════════════════════════════════════
❌ 不做 Skill Match / Intent Recognition — 独立 Phase
❌ 不做 Skill 自动更新 — Cloud Control Plane 职责
❌ 不做多 Skill 并存 — 一个 Context 一个 Skill
❌ 不做 Skill 版本锁定/迁移 — 仅版本比较
❌ 不做 auto reconcile — 显式 checkSkillHealth()
✅ Skill lifecycle: load → unload → reload（显式调用）
✅ Skill errors: 结构化 code，支持 Recovery 分类
✅ Skill persistence: 作为 ContextSnapshot 字段，不 auto restore-check
✅ Skill health check: 显式调用，不自动触发

Capability 红线（Phase 4 + Skill）
═══════════════════════════════════════════════════════════
❌ skill.execute — 不实现（Skill 组合 = Workflow）
❌ skill.load — 不实现（动态加载 = 编排逻辑）
✅ skill.discover — 接线（只读查询 = SkillRegistry）
```

---

## 8. 总结

### 当前 Phase 3 Skill Runtime 评分

| 维度 | 评分 | 说明 |
|------|:----:|------|
| Skill Load | 8/10 | 完整但缺少 error 结构化 |
| Skill Lifecycle | 4/10 | 只有 load，无 unload/reload |
| loadedSections 状态机 | 4/10 | 类型完整但 loading/error 未接线 |
| 错误处理 | 3/10 | 无结构化 error code，Recovery 无法分类 |
| Capability 集成 | 7/10 | 验证完整，skill.discover 未接线 |
| Persistence 集成 | 8/10 | 序列化完整，缺少 health check |
| Skill Package 边界 | 6/10 | references/ 清晰，templates/scripts/ 未定义 |

### 修正后目标

| 维度 | 目标评分 |
|------|:--------:|
| Skill Load | 9/10 |
| Skill Lifecycle | 8/10 |
| loadedSections 状态机 | 9/10 |
| 错误处理 | 8/10 |
| Capability 集成 | 9/10 |
| Persistence 集成 | 9/10 |
| Skill Package 边界 | 9/10 |
