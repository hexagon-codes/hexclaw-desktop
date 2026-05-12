# Skill Runtime Semantics Hotfix Plan

> 生成日期：2026-05-12
> 状态：plan only，不修改代码
> 基线：runtime-kernel-v0.5
> 范围：3 P1 修复（结构化错误码 + unload/reload + loadedSections 状态机）

---

## 0. 变更范围

```
本轮执行（3 P1）：
  ✅ H1 — 结构化 Skill Error Codes
  ✅ H2 — unloadSkillForTask / reloadSkillForTask
  ✅ H3 — loadedSections 状态机修正

本轮不执行（4 P2）：
  ❌ skill.discover 接线
  ❌ checkSkillHealth
  ❌ version compare / drift detection
  ❌ SKILL.md / references 内容变更检测
```

---

## 1. H1 — 结构化 Skill Error Codes

### 1.1 目标

SkillLoader 抛出的所有 Error 携带 `code` 字段，使 Recovery `classifyFailure()` 能正确区分 permanent/transient skill 错误。

### 1.2 变更文件

| 文件 | 变更 | 行数 |
|------|------|:----:|
| `src/services/skillLoader.ts` | 新增 `skillError()` 私有工厂 + sanitizeSkillId / loadSkill 抛出带 code 错误 | +20 / -5 |
| `src/services/runtime/recoveryClassifier.ts` | PERMANENT_CODES +3, TRANSIENT_CODES +1 | +4 |

### 1.3 SkillLoader 变更细节

**新增私有工厂**（`skillLoader.ts` 文件顶部，import 之后）：

```typescript
/** 构造带 code 的结构化错误，供 Recovery classifyFailure 识别 */
function skillError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string }
  err.code = code
  return err
}
```

**Error Code 常量**（私有，不导出）：

| Code | 触发位置 | 分类 |
|------|----------|:----:|
| `SKILL_NOT_FOUND` | `readTextFile(skill.json)` 失败 | PERMANENT |
| `SKILL_PARSE_ERROR` | `JSON.parse(raw)` 失败 | PERMANENT |
| `SKILL_PATH_TRAVERSAL` | `sanitizeSkillId()` 校验失败 | PERMANENT |
| `SKILL_IO_ERROR` | 其他 IO 错误（如目录读取失败） | TRANSIENT |

**`sanitizeSkillId()` 错误改造**（5 处 throw）：

```typescript
// 修改前：
throw new Error(`[SkillLoader] 非法 skillId: 空字符串`)

// 修改后：
throw skillError('SKILL_PATH_TRAVERSAL', `非法 skillId: 空字符串`)
```

所有 5 个 throw 语句统一改为 `skillError('SKILL_PATH_TRAVERSAL', ...)`。

**`loadSkill()` skill.json 读取改造**：

```typescript
// 修改前：
const raw = await readTextFile(`skills/${safeId}/skill.json`, { baseDir: this.baseDir })

// 修改后：
let raw: string
try {
  raw = await readTextFile(`skills/${safeId}/skill.json`, { baseDir: this.baseDir })
} catch (e) {
  throw skillError('SKILL_NOT_FOUND', `skill.json 不存在: skills/${safeId}`)
}
```

**`loadSkill()` skill.json 解析改造**：

```typescript
// 修改前：
const parsed = JSON.parse(raw)

// 修改后：
let parsed: Record<string, unknown>
try {
  parsed = JSON.parse(raw)
} catch (e) {
  throw skillError('SKILL_PARSE_ERROR', `skill.json JSON 解析失败: skills/${safeId}`)
}
```

**注意**：SKILL.md 读取失败和 references/ 扫描失败保持静默处理（返回 undefined / []），不抛错误。这两个是可选项，失败不应阻止加载。

**不影响**：
- `loadSkill()` 的公共签名不变 — 仍然返回 `Promise<SkillPackage>`，仍然 throw Error
- 调用方 `loadSkillForTask` 的 catch 块不变 — `(e as Error).message` 继续工作
- Recovery 的 `applyFailureRecord` 不变 — 它通过 `error.code` 接收 code

### 1.4 recoveryClassifier 变更细节

```typescript
// PERMANENT_CODES 新增：
'INVALID_INPUT', 'AUTH_FAILED', 'CAPABILITY_DENIED', 'TASK_CANCELLED', 'BUDGET_EXCEEDED',
+ 'SKILL_NOT_FOUND', 'SKILL_PARSE_ERROR', 'SKILL_PATH_TRAVERSAL',  // ← 新增

// TRANSIENT_CODES 新增：
'NETWORK_TIMEOUT', 'RATE_LIMITED', 'RESOURCE_UNAVAILABLE', 'SIDECAR_UNREACHABLE', 'EXECUTION_TIMEOUT',
+ 'SKILL_IO_ERROR',  // ← 新增
```

### 1.5 验证点

- TypeScript 编译零错误
- `SKILL_NOT_FOUND` / `SKILL_PARSE_ERROR` / `SKILL_PATH_TRAVERSAL` → `classifyFailure()` 返回 `'permanent'`
- `SKILL_IO_ERROR` → `classifyFailure()` 返回 `'transient'`
- `loadSkillForTask` catch 块中的 `(e as Error).message` 继续正常工作
- `buildFailureRecord(code, message, ...)` 接收 `'SKILL_NOT_FOUND'` 作为 code，写入 FailureRecord

---

## 2. H2 — unloadSkillForTask / reloadSkillForTask

### 2.1 目标

提供显式的 skill 卸载和重载入口，不引入自动行为。

### 2.2 变更文件

| 文件 | 变更 | 行数 |
|------|------|:----:|
| `src/types/timeline.ts` | RuntimeEventType 新增 `skill.unloaded` | +1 |
| `src/stores/runtime.ts` | 新增 2 个 function + 修改 loadSkillForTask guard + export 新增 2 个 + import timeline type | +55 / -3 |

### 2.3 timeline.ts 变更

```typescript
// ── Skill ──
| 'skill.loaded'
| 'skill.loadFailed'
+ | 'skill.unloaded'     // ← 新增
| 'capability.validated'
```

### 2.4 RuntimeStore 变更细节

**H2a — unloadSkillForTask**

位置：`loadSkillForTask` 之后，`loadContextLayer` 之前（`runtime.ts:228` 之后）

```typescript
/**
 * 卸载当前 Task 的 Skill Layer。
 *
 * 仅清理该 task 的 ctx.skill 和 layerStates['skill']。
 * 不销毁 Context，不修改其他 Layer。
 * 不做 watch / 自动触发。
 */
function unloadSkillForTask(taskId: string): void {
  const ctx = manager.getContext(taskId)
  if (!ctx) return
  if (!ctx.skill && ctx.layerStates['skill'] !== 'loaded') return

  ctx.skill = undefined
  ctx.layerStates['skill'] = 'unloaded'
  manager.recalcSize(taskId)

  writeTimelineEvent({
    type: 'skill.unloaded',
    taskId,
    payload: { summary: 'Skill 已卸载' },
  })

  revision.value++
}
```

**H2b — reloadSkillForTask**

位置：`unloadSkillForTask` 之后

```typescript
/**
 * 重新加载 Skill。
 *
 * 静默清理 ctx.skill → 调用 loadSkillForTask。
 * reload 是 single semantic operation：
 * - 不 emit skill.unloaded（仅显式 unloadSkillForTask 记录）
 * - 不单独 revision++
 * - 成功后只产生 skill.loaded + 1 次 revision++
 * - 失败则 ctx.skill 保持 undefined，不产生任何 timeline event
 *
 * @throws 同 loadSkillForTask
 */
async function reloadSkillForTask(taskId: string, skillId: string): Promise<void> {
  const ctx = manager.getContext(taskId)
  if (!ctx) return

  // 静默清理（不 emit timeline / 不 revision++）
  if (ctx.skill || ctx.layerStates['skill'] === 'loaded') {
    ctx.skill = undefined
    ctx.layerStates['skill'] = 'unloaded'
    manager.recalcSize(taskId)
  }

  // guard 已失效（ctx.skill === undefined），正常调用
  await loadSkillForTask(taskId, skillId)
}
```

**关于 reloadSkillForTask 的实现方式**：存在两种选择：

| 方案 | 描述 | 优劣 |
|------|------|------|
| A | reload 先 unload，再调用 `loadSkillForTask(taskId, skillId)` | 简洁，但需要在 unload 后清除 guard 条件 |
| B | reload 内联 load 逻辑，绕过 guard | 无 guard 问题，但有少量代码重复 |

**推荐方案 A**：因为 `unloadSkillForTask` 清除 `ctx.skill` 并设置 `layerStates['skill'] = 'unloaded'`，而 guard 条件是 `ctx.skill && ctx.layerStates['skill'] === 'loaded'`。卸载后 guard 条件不满足，`loadSkillForTask` 可以正常执行。时序如下：

```
reloadSkillForTask(taskId, skillId)
  ├─ unloadSkillForTask(taskId)
  │    ├─ ctx.skill = undefined
  │    ├─ layerStates['skill'] = 'unloaded'
  │    ├─ writeTimelineEvent('skill.unloaded')
  │    └─ revision.value++
  │
  └─ loadSkillForTask(taskId, skillId)
       ├─ guard: ctx.skill === undefined → 放行 ✓
       ├─ skillLoader.loadSkill(skillId, ...)
       ├─ CapabilityValidator.validate(...)
       ├─ loader.loadSkillLayer(ctx, skillPkg)
       ├─ writeTimelineEvent('skill.loaded')
       └─ revision.value++
```

**一个问题**：reload 场景下 `revision.value++` 会被调用 2 次（unload + load），导致 Vue 响应式触发 2 次 computed 重算。这是可接受的行为 — unload 和 load 是两个不同的 semantic mutation，各自触发 revision 是正确的。

**可选优化**：如果用户希望 reload 只产生一次 revision 增量，可以在 reloadSkillForTask 中不调用 `unloadSkillForTask`，而是内联 unload 逻辑（不触发 revision），然后再调用 `loadSkillForTask`。对 UI 来说，中间状态（skill=undefined）不应该可见。

**最终选择**：方案 A（静默 unload + 调用 loadSkillForTask），reload 是 single semantic operation：

```
reloadSkillForTask(taskId, skillId)
  │
  ├─ 1. 静默清理（不 emit timeline / 不 revision++）
  │     ctx.skill = undefined
  │     layerStates['skill'] = 'unloaded'
  │     manager.recalcSize(taskId)
  │
  └─ 2. loadSkillForTask(taskId, skillId)
       ├─ guard: ctx.skill === undefined → 放行 ✓
       ├─ skillLoader.loadSkill(skillId, ...)
       ├─ CapabilityValidator.validate(...)
       ├─ loader.loadSkillLayer(ctx, skillPkg)
       ├─ writeTimelineEvent('skill.loaded')
       └─ revision.value++     ← 仅此一次
```

**关键行为**：
- `reloadSkillForTask` **不** emit `skill.unloaded` — reload 是 single semantic operation，只有显式 `unloadSkillForTask()` 才记录 `skill.unloaded`
- 仅 `skill.loaded` 成功时触发 1 次 `revision.value++`
- 如果 `loadSkillForTask` 失败（throw），不产生任何 timeline event，不 revision++，ctx.skill 保持 undefined

### 2.5 loadSkillForTask guard 修正

**不变**。当前 guard `if (ctx.skill && ctx.layerStates['skill'] === 'loaded') return` 保持原样。

理由：
- `loadSkillForTask` 的调用方（外部直接调用）仍需要 guard — 阻止重复加载
- `reloadSkillForTask` 通过先卸载来绕过 guard
- 不需要为 `loadSkillForTask` 添加 `force` 参数 — 语义由 `reloadSkillForTask` 承担

### 2.6 Export 变更

```typescript
return {
  // ... existing ...
  loadSkillForTask,
+ unloadSkillForTask,
+ reloadSkillForTask,
  loadContextLayer,
  // ... existing ...
}
```

总 public method 数从 26 → 28。

### 2.7 验证点

- `unloadSkillForTask(taskId)` 后 `ctx.skill === undefined` 且 `layerStates['skill'] === 'unloaded'`
- `unloadSkillForTask(taskId)` 产生 `skill.unloaded` timeline event + `revision++`
- `loadSkillForTask` 在 skill 已加载时仍然跳过
- `reloadSkillForTask` 成功卸载旧 skill 并加载新 skill
- `reloadSkillForTask` 成功后 timeline 仅包含 `skill.loaded`（不含 `skill.unloaded`）
- `reloadSkillForTask` 只产生 1 次 `revision.value++`（load 成功时）
- `reloadSkillForTask` 失败时 ctx.skill 保持 undefined，无 timeline event，无 revision++
- TypeScript 编译零错误

---

## 3. H3 — loadedSections 状态机修正

### 3.1 目标

`SkillLayer.loadedSections` 中的 `'loading'` 和 `'error'` 状态真实落地，不再只有 `'loaded'` 和 `'unloaded'`。

### 3.2 变更文件

| 文件 | 变更 | 行数 |
|------|------|:----:|
| `src/stores/runtime.ts` | loadSkillForTask 在 loader 调用前设置 loading；catch 中设置 error | +10 |
| `src/services/contextLoader.ts` | loadSkillLayer 根据 SkillPackage 设置 loaded/error | +8 / -4 |

### 3.3 RuntimeStore.loadSkillForTask 变更

**时序**：

```
loadSkillForTask(taskId, skillId)
  │
  ├─ 1. guard check（不变）
  │
  ├─ 2. 设置 loadedSections 为 loading（新增）
  │     ctx.skill = {
  │       loadedSections: { markdown: 'loading', references: 'unloaded' }
  │     }
  │     ctx.layerStates['skill'] = 'loading'
  │
  ├─ 3. skillLoader.loadSkill()（不变）
  │     │
  │     ├─ 成功 → loadSkillLayer 设置 markdown: 'loaded'
  │     └─ 失败 → throw
  │
  ├─ 4. catch block（修改）
  │     // 将正在 loading 的 section 翻转为 error
  │     if (ctx.skill) {
  │       ctx.skill.loadedSections.markdown = 'error'
  │       ctx.layerStates['skill'] = 'error'
  │     }
  │     writeTimelineEvent('skill.loadFailed')  // 不变
  │     throw e
  │
  ├─ 5. CapabilityValidator（不变）
  │
  ├─ 6. loadSkillLayer（不变 — loadedSections 已在 loadSkillLayer 中正确设置）
  │
  ├─ 7. recalcSize + timeline + revision（不变）
```

**具体代码变更**（loadSkillForTask 函数内）：

```typescript
async function loadSkillForTask(taskId: string, skillId: string): Promise<void> {
  const ctx = manager.getContext(taskId)
  if (!ctx) return
  if (ctx.skill && ctx.layerStates['skill'] === 'loaded') return

  // ── 新增：设置 loading 状态 ──
  if (!ctx.skill) {
    ctx.skill = {
      loadedSections: { markdown: 'unloaded', references: 'unloaded' },
    }
  }
  ctx.skill.loadedSections.markdown = 'loading'
  ctx.layerStates['skill'] = 'loading'
  // ── 新增结束 ──

  let skillPkg
  try {
    skillPkg = await skillLoader.loadSkill(skillId, {
      loadMarkdown: true,
      loadReferences: false,
    })
  } catch (e) {
    // ── 新增：Skill Package 加载失败 → error 状态 ──
    if (ctx.skill) {
      ctx.skill.loadedSections.markdown = 'error'
    }
    ctx.layerStates['skill'] = 'error'
    // ── 新增结束 ──

    writeTimelineEvent({
      type: 'skill.loadFailed',
      taskId,
      payload: { summary: `Skill "${skillId}" 加载失败: ${(e as Error).message}` },
    })
    throw e
  }

  // ... capability validation 不变 ...
  // ... loadSkillLayer 不变 ...
}
```

### 3.4 ContextLoader.loadSkillLayer 变更

**修改前**（`contextLoader.ts:145-159`）：

```typescript
loadSkillLayer(context: RuntimeContext, skillPkg: SkillPackage): void {
  context.skill = {
    skillId: skillPkg.meta.skillId,
    skillName: skillPkg.meta.displayName,
    skillVersion: skillPkg.meta.version,
    markdown: skillPkg.markdown,
    references: skillPkg.references.length > 0 ? skillPkg.references : undefined,
    capabilities: skillPkg.meta.capabilities,
    loadedSections: {
      markdown: skillPkg.markdown !== undefined ? 'loaded' : 'unloaded',
      references: skillPkg.references.length > 0 ? 'loaded' : 'unloaded',
    },
  }
  context.layerStates['skill'] = 'loaded'
}
```

**修改后**：

```typescript
loadSkillLayer(context: RuntimeContext, skillPkg: SkillPackage): void {
  context.skill = {
    skillId: skillPkg.meta.skillId,
    skillName: skillPkg.meta.displayName,
    skillVersion: skillPkg.meta.version,
    markdown: skillPkg.markdown,
    references: skillPkg.references.length > 0 ? skillPkg.references : undefined,
    capabilities: skillPkg.meta.capabilities,
    loadedSections: {
      // SKILL.md 可选 — 不存在/不可读 → unloaded（非 error）
      markdown: skillPkg.markdown !== undefined ? 'loaded' : 'unloaded',
      // references 可选 — 未请求 → unloaded
      references: skillPkg.references.length > 0 ? 'loaded' : 'unloaded',
    },
  }
  context.layerStates['skill'] = 'loaded'
}
```

**`markdown: 'unloaded'` 的语义**：SKILL.md 是 optional section。不存在或读取失败时标记 `'unloaded'`（表示"此 section 不可用"），而非 `'error'`。

**`'error'` 的触发条件（仅 1 种）**：Skill Package 加载失败 — skill.json 不存在 / parse 失败 / path traversal。此时 SkillLoader throw，catch block 将 `layerStates['skill']` 设置为 `'error'`，`loadedSections.markdown` 保持 `'error'`（因 loading 被中断）。

### 3.5 状态变迁图（修正后）

```
loadedSections.markdown:
────────────────────────────────────────────────
  初始              → 'unloaded'    (ctx.skill 不存在)
  loadSkillForTask  → 'loading'     (调用 SkillLoader 前)
  SKILL.md 可读     → 'loaded'      (loadSkillLayer 内)
  SKILL.md 不可读   → 'unloaded'    (loadSkillLayer 内 — optional)
  SkillLoader throw → 'error'       (catch block — package load failed)

loadedSections.references:
────────────────────────────────────────────────
  初始              → 'unloaded'    (ctx.skill 不存在)
  loadSkillForTask  → 'unloaded'    (loadReferences: false, 不请求)
  未来扩展          → 'loading'     (loadReferences: true 时)
  未来扩展          → 'loaded'      (references 扫描成功)
  未来扩展          → 'unloaded'    (references 扫描失败 — optional)

layerStates['skill']:
────────────────────────────────────────────────
  初始              → 'unloaded'    (ctx.skill 不存在)
  loadSkillForTask  → 'loading'     (调用 SkillLoader 前)
  加载成功          → 'loaded'      (loadSkillLayer 内)
  加载失败          → 'error'       (catch block — package load failed)
  unloadSkill       → 'unloaded'    (unloadSkillForTask 内)
```

**`error` 语义**：只表示 Skill Package 加载失败（fatal — skill.json 层面）。optional section 不可用永远不标记 `error`。

### 3.6 验证点

- `loadSkillForTask` 成功：`loadedSections.markdown === 'loaded'`，`layerStates['skill'] === 'loaded'`
- SKILL.md 不存在/不可读：`loadedSections.markdown === 'unloaded'`，`layerStates['skill'] === 'loaded'`（package load 成功，optional section 不可用）
- skill.json 不存在：`layerStates['skill'] === 'error'`，`loadedSections.markdown === 'error'`（SkillLoader throw → catch block 标记）
- skill.json parse 失败：同上
- skillId path traversal：同上
- `layerStates['skill']` 依次经过 `loading → loaded`（成功）或 `loading → error`（失败）

---

## 4. 变更文件总览

| 文件 | 操作 | 行数* | H# |
|------|------|:-----:|:--:|
| `src/services/skillLoader.ts` | 修改 | +20 / -5 | H1 |
| `src/services/runtime/recoveryClassifier.ts` | 修改 | +4 | H1 |
| `src/types/timeline.ts` | 修改 | +1 | H2 |
| `src/stores/runtime.ts` | 修改 | +65 / -3 | H2 + H3 |
| `src/services/contextLoader.ts` | 修改 | +2 / -2 | H3 |
| **合计** | — | **~92 行净增** | — |

\* 预估行数，含 JSDoc 注释。

---

## 5. 红线约束（本 Hotfix）

```
行为红线
═══════════════════════════════════════════════════════════
❌ 不做 SKILL.md 语义解析（保持原始文本注入）
❌ 不做 references 内容加载（保持路径索引）
❌ 不做 Skill Match / Intent Recognition
❌ 不做自动 reload — reloadSkillForTask 是显式调用
❌ 不做 watch / 版本监听
❌ 不做 skill.execute / skill.load capability 接线
❌ 不做 multi-skill 上下文
❌ 不引入新的 Recovery Layer 字段
❌ 不修改 SkillLayer 类型定义
❌ 不修改 SkillPackage 类型定义

API 红线
═══════════════════════════════════════════════════════════
✅ loadSkillForTask(taskId, skillId) — 签名不变
✅ unloadSkillForTask(taskId) — 新增，显式调用
✅ reloadSkillForTask(taskId, skillId) — 新增，显式调用
✅ SkillLoader.loadSkill() — 签名不变，throw 的 Error 新增 code 字段
✅ classifyFailure(code) — 新增 4 个 SKILL_* code 识别
```

---

## 6. 执行顺序

```
H1 → H2 → H3
```

H1 最先执行（SkillLoader 错误结构化为后续 H2 的 reload 场景提供更好的错误处理基础）。H2 和 H3 都修改 runtime.ts，但可以分别 Edit（不同函数块，不会冲突）。

每个 H 完成后运行 `npx vue-tsc --noEmit` 验证。
