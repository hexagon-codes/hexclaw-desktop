# RuntimeStore Tightened Refactor Plan

> 生成日期：2026-05-12
> 状态：analyze/plan only，不修改代码
> 核心变更：消除 Dual Mutation Authority

---

## 0. 问题诊断

### 0.1 上一版 Refactor Analyze 的核心缺陷

```
❌ Dual Mutation Authority

   Composable                    RuntimeStore
   ─────────                     ────────────
   getContext(taskId)       →    getContext(taskId)
   ctx.resources.asset = X  →    ctx.resources.recovery = Y
   manager.createContext()  →    manager.updateLayer()
   
   两个位置都能 mutation ctx → authority 分裂
```

### 0.2 根本原因

Composable 同时拥有 **read authority**（getContext）和 **write authority**（mutation ctx）。即使 composable 不 append timeline / 不 increment revision，它仍然是 mutation source，与 RuntimeStore 形成双写路径。

### 0.3 修正原则

```
Composable = Pure Computer

  输入：plain data（ctx / collection / layer）
  输出：patch / result / snapshot
  副作用：仅 disk IO（Persistence composable 例外）

RuntimeStore = Sole Mutator

  输入：taskId / user action
  操作：getContext → composable.compute() → apply patch → append timeline → revision++
  权威：唯一 runtime mutation 入口
```

---

## 1. 修正后的 Refactor 架构

```
┌──────────────────────────────────────────────────────────────┐
│  RuntimeStore (Pinia)  唯一 mutation authority               │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Core (unchanged)                                    │   │
│  │  register / update / complete / fail / destroy       │   │
│  │  executeTask + loadSkill + layer lifecycle           │   │
│  │  timeline queries + computed properties              │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐            │
│  │Persistence │  │   Asset    │  │  Recovery  │            │
│  │wrappers    │  │  wrappers  │  │  wrappers  │            │
│  │            │  │            │  │            │            │
│  │getContext()│  │getContext()│  │getContext()│            │
│  │ ↓ data     │  │ ↓ data     │  │ ↓ data     │            │
│  │comp.save() │  │comp.build()│  │comp.build()│            │
│  │ ↓ patch    │  │ ↓ patch    │  │ ↓ patch    │            │
│  │apply → rev │  │apply → rev │  │apply → rev │            │
│  └────────────┘  └────────────┘  └────────────┘            │
│                                                              │
│  ── authority ─────────────────────────────────────────────  │
│  revision (ref)  writeTimelineEvent()  computed properties   │
│  manager (ContextManager)  loader (ContextLoader)            │
│  timelineStore (TimelineStore)                               │
└──────────────────────────────────────────────────────────────┘

Composables (stateless, no mutation authority)
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│usePersistence   │  │useAssetRuntime  │  │useRecoveryRuntime│
│                 │  │                 │  │                 │
│save(ctx)→bool   │  │buildRegistration│  │buildFailureAppl.│
│saveAll(c,e)→bool│  │ (coll, ...)→    │  │ (layer,err,ctx) │
│loadAll()→       │  │ {ref, updated}  │  │ →{patch,changed,│
│ {snapshots,evts}│  │                 │  │  assessment...} │
│                 │  │buildInvalidation│  │                 │
│• 仅 disk IO     │  │ (coll,id)→      │  │assess(ctx)→RA   │
│• 不接触 manager │  │ {updated,type}| │  │detect(ctx)→CR   │
│• 不接触 ctx     │  │ null            │  │getSummary(ctx)→ │
│                 │  │                 │  │getResolution()→ │
│                 │  │checkHealth(coll)│  │                 │
│                 │  │ →{updated,chg}  │  │• 仅读 ctx       │
│                 │  │                 │  │• 返回 patch     │
│                 │  │buildSummary(c)  │  │• 不 mutation    │
│                 │  │                 │  │                 │
│                 │  │• 仅接收数据     │  │                 │
│                 │  │• 返回 patch     │  │                 │
│                 │  │• 不接触 manager │  │                 │
│                 │  │• 不接触 ctx     │  │                 │
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

---

## 2. 详细的 Composable 契约

### 2.1 usePersistenceRuntime

```typescript
// src/composables/usePersistenceRuntime.ts

/**
 * Persistence Composable — 仅负责 disk IO + serialization。
 *
 * 不接触 ContextManager。
 * 不接触 RuntimeContext（直接操作）。
 * 不负责 runtime reconstruction（restoreRuntime 属于 RuntimeStore）。
 */

export function usePersistenceRuntime() {

  /**
   * 保存单个 Context 到磁盘。
   * 输入：已获取的 RuntimeContext（由 RuntimeStore 传入）
   * 返回：boolean（成功/失败）
   */
  async function saveContext(ctx: RuntimeContext): Promise<boolean>

  /**
   * 批量保存到磁盘。
   * 输入：contexts + events（由 RuntimeStore 传入）
   * 返回：boolean
   */
  async function saveAll(
    contexts: RuntimeContext[],
    events: RuntimeEvent[],
  ): Promise<boolean>

  /**
   * 从磁盘加载所有快照。
   * 不做 RuntimeContext 重建（仅反序列化到 ContextSnapshot）。
   * 返回原始快照数据，由 RuntimeStore 负责 reconstruction。
   */
  async function loadAll(): Promise<{
    snapshots: ContextSnapshot[]
    events: RuntimeEvent[]
  }>

  return { saveContext, saveAll, loadAll }
}
```

**关键变更**：
- `saveContext(ctx)` — 接收 ctx，不调用 `manager.getContext()`
- `saveAll(contexts, events)` — 接收数据，不调用 `manager.getAllContexts()`
- `loadAll()` → 返回 `ContextSnapshot[]`（非 `RuntimeContext[]`），reconstruction 留给 RuntimeStore
- 删除 `restore()` 方法 — restore 是 Runtime semantic reconstruction，不是 persistence logic

### 2.2 useAssetRuntime

```typescript
// src/composables/useAssetRuntime.ts

/**
 * Asset Composable — 纯计算，返回 patches。
 *
 * 不接触 ContextManager。
 * 不接触 RuntimeContext。
 * 只接收 plain data（AssetCollection / taskId / path / metadata）。
 */

export function useAssetRuntime() {

  /**
   * 构建注册操作 — 纯计算。
   *
   * 输入：existing AssetCollection | undefined（由 RuntimeStore 从 ctx.resources.asset 获取）
   * 输出：ref + updated collection（由 RuntimeStore 应用到 ctx.resources.asset）
   */
  function buildRegistration(
    existing: AssetCollection | undefined,
    taskId: string,
    path: string,
    metadata: AssetMetadata,
  ): {
    ref: AssetReference
    updated: AssetCollection
  }

  /**
   * 构建废弃操作 — 纯计算。
   *
   * 输入：AssetCollection
   * 输出：updated collection + assetType（供 timeline metadata）
   *       null = assetId 未找到
   */
  function buildInvalidation(
    collection: AssetCollection,
    assetId: string,
  ): {
    updated: AssetCollection
    assetType: string
  } | null

  /**
   * 执行健康检查 — observation only。
   *
   * 输入：AssetCollection
   * 输出：updated collection（status 已更新）+ changed flag
   */
  async function checkHealth(
    collection: AssetCollection,
  ): Promise<{
    updated: AssetCollection
    changed: boolean
  }>

  /**
   * 构建摘要 — 纯计算。
   *
   * 输入：AssetCollection | undefined（或 refs 数组）
   * 输出：summary
   */
  function buildSummary(
    collection: AssetCollection | undefined,
  ): ReturnType<typeof buildAssetSummary>

  return { buildRegistration, buildInvalidation, checkHealth, buildSummary }
}
```

**关键变更**：
- 所有方法接收 `AssetCollection`（plain data），不调用 `manager.getContext()`
- `buildRegistration` 返回 `{ ref, updated }` — 不写入 `ctx.resources.asset`
- `buildInvalidation` 返回 `{ updated, assetType }` — 不写入 `ctx.resources.asset`
- `checkHealth` 返回 `{ updated, changed }` — 不写入 `ctx.resources.asset`
- RuntimeStore 负责：获取 collection → 调用 composable → 应用 patch → revision++

### 2.3 useRecoveryRuntime

```typescript
// src/composables/useRecoveryRuntime.ts

/**
 * Recovery Composable — 纯计算 + 返回 patches。
 *
 * 不接触 ContextManager。
 * 部分方法接收 RuntimeContext 作为只读数据（因 assessRecoveryFn 需要全量 ctx）。
 * 不 mutation ctx 的任何字段。
 */

export function useRecoveryRuntime() {

  /**
   * 构建失败记录 + RecoveryLayer patch — 纯计算。
   *
   * 输入：
   *   existingLayer — ctx.resources.recovery（由 RuntimeStore 获取）
   *   error — { code, message }
   *   executionState / taskStatus — 从 ctx 提取的 snapshot 字段
   *   ctx — 用于计算 prevAssessment（只读）
   *
   * 输出：
   *   patch — 新的 RecoveryLayer（由 RuntimeStore 应用到 ctx.resources.recovery）
   *   assessmentChanged / assessmentState / failureCode — 供 RuntimeStore 决定是否 append timeline
   *
   * 不修改 ctx 的任何字段。
   */
  function buildFailureApplication(
    existingLayer: RecoveryLayer | undefined,
    error: { code: string; message: string },
    executionState: string,
    taskStatus: string,
    ctx: RuntimeContext,  // 只读 — 用于 assessRecoveryFn
  ): {
    patch: RecoveryLayer
    assessmentChanged: boolean
    assessmentState: string
    failureCode: string
  }

  /**
   * 评估恢复可行性 — 纯计算（传递）。
   * 输入：RuntimeContext（只读）
   */
  function assess(ctx: RuntimeContext): RecoveryAssessment | null

  /**
   * 检测状态损坏 — 纯计算（传递）。
   * 输入：RuntimeContext（只读）
   */
  function detect(ctx: RuntimeContext): CorruptionReport | null

  /**
   * 构建摘要 — 纯计算（传递）。
   * 输入：RuntimeContext（只读）
   */
  function getSummary(ctx: RuntimeContext): RecoverySummary | null

  /**
   * 推断解决状态 — 纯计算（传递）。
   * 输入：RuntimeContext（只读）
   */
  function getResolution(ctx: RuntimeContext): 'pending' | 'resolved' | 'failed'

  return {
    buildFailureApplication,
    assess,
    detect,
    getSummary,
    getResolution,
  }
}
```

**关键变更**：
- `buildFailureApplication` 接收 `existingLayer`（非从 ctx 内部获取）+ `ctx`（仅用于 assessRecoveryFn 只读）
- 返回 `{ patch, assessmentChanged, ... }` — 不写入 `ctx.resources.recovery`
- `assess / detect / getSummary / getResolution` 接收 `RuntimeContext` 作为只读数据
- 所有方法不 mutation ctx

---

## 3. RuntimeStore 编排（修正后）

### 3.1 Persistence wrappers

```typescript
const persistence = usePersistenceRuntime()

async function saveContextPersist(taskId: string): Promise<void> {
  const ctx = manager.getContext(taskId)
  if (!ctx) return
  const ok = await persistence.saveContext(ctx)
  if (!ok) {
    getRuntimeLogger().error(`saveContext(${taskId}) 失败`)
  }
  // 不 increment revision — persistence 是副作用，非 runtime mutation
}

async function saveAllPersist(): Promise<boolean> {
  const contexts = manager.getAllContexts()
  const events = timelineStore.getAll()
  return persistence.saveAll(contexts, events)
  // 不 increment revision
}

async function restoreRuntime(): Promise<void> {
  const { snapshots, events } = await persistence.loadAll()

  for (const snapshot of snapshots) {
    if (manager.hasContext(snapshot.taskId)) continue

    // ── Semantic reconstruction (RuntimeStore authority) ──
    manager.createContext(snapshot.taskId, snapshot.taskType)

    if (snapshot.system) {
      manager.updateLayer(snapshot.taskId, 'system', normalizeLayer(snapshot.system))
    }
    if (snapshot.skill) {
      manager.updateLayer(snapshot.taskId, 'skill', normalizeLayer(snapshot.skill))
    }
    if (snapshot.task) {
      manager.updateLayer(snapshot.taskId, 'task', normalizeLayer(snapshot.task))
    }
    if (snapshot.execution) {
      manager.updateLayer(snapshot.taskId, 'execution', normalizeLayer(snapshot.execution))
    }
    if (snapshot.memory) {
      manager.updateLayer(snapshot.taskId, 'memory', normalizeLayer(snapshot.memory))
    }

    manager.recalcSize(snapshot.taskId)

    // ── Resource Reference restore ──
    if (snapshot.asset || snapshot.recovery) {
      const ctx = manager.getContext(snapshot.taskId)
      if (ctx) {
        if (!ctx.resources) ctx.resources = {}
        if (snapshot.asset) ctx.resources.asset = snapshot.asset
        if (snapshot.recovery) ctx.resources.recovery = snapshot.recovery
      }
    }
  }

  if (events.length > 0) {
    timelineStore.importEvents(events)
  }

  revision.value++
}
```

### 3.2 Asset wrappers

```typescript
const asset = useAssetRuntime()

function registerAsset(
  taskId: string,
  path: string,
  metadata: AssetMetadata,
): AssetReference {
  const ctx = manager.getContext(taskId)
  if (!ctx) throw new Error(`Context ${taskId} 不存在`)

  // composable 纯计算 → 返回 patch
  const { ref, updated } = asset.buildRegistration(
    ctx.resources?.asset,
    taskId,
    path,
    metadata,
  )

  // RuntimeStore 应用 mutation
  if (!ctx.resources) ctx.resources = {}
  ctx.resources.asset = updated

  revision.value++
  return ref
}

function invalidateAsset(taskId: string, assetId: string): void {
  const ctx = manager.getContext(taskId)
  if (!ctx) return
  const collection = ctx.resources?.asset
  if (!collection) return

  // composable 纯计算 → 返回 patch
  const result = asset.buildInvalidation(collection, assetId)
  if (!result) return

  // RuntimeStore 应用 mutation
  ctx.resources.asset = result.updated

  writeTimelineEvent({
    type: 'asset.invalidated',
    taskId,
    payload: {
      summary: `Asset ${assetId} 已废弃`,
      metadata: { assetType: result.assetType },
    },
  })

  revision.value++
}

async function reconcileAssets(taskId: string): Promise<void> {
  const ctx = manager.getContext(taskId)
  if (!ctx) return
  const collection = ctx.resources?.asset
  if (!collection || collection.refs.length === 0) return

  // composable 纯计算 → 返回 patch + changed flag
  const { updated, changed } = await asset.checkHealth(collection)

  // RuntimeStore 应用 mutation（仅 changed 时）
  if (changed) {
    ctx.resources.asset = updated
    revision.value++
  }
  // reconcile 不 append timeline event（noisy observation）
}

function getAssetSummary(taskId: string) {
  const ctx = manager.getContext(taskId)
  if (!ctx) return null
  return asset.buildSummary(ctx.resources?.asset)
}
```

### 3.3 Recovery wrappers

```typescript
const recovery = useRecoveryRuntime()

function applyFailureRecord(
  taskId: string,
  error: { code: string; message: string },
): void {
  const ctx = manager.getContext(taskId)
  if (!ctx) return

  // composable 纯计算 → 返回 patch + assessment info
  const result = recovery.buildFailureApplication(
    ctx.resources?.recovery,
    error,
    ctx.execution?.state ?? 'unknown',
    ctx.task?.status ?? 'unknown',
    ctx,  // 只读 — 用于 assessRecoveryFn
  )

  // RuntimeStore 应用 mutation
  if (!ctx.resources) ctx.resources = {}
  ctx.resources.recovery = result.patch

  // RuntimeStore 条件性 append timeline（基于 composable 返回的 assessmentChanged）
  if (result.assessmentChanged) {
    writeTimelineEvent({
      type: 'recovery.assessed',
      taskId,
      payload: {
        summary: `Recovery assessment: ${result.assessmentState}`,
        metadata: {
          failureCode: result.failureCode,
          assessmentState: result.assessmentState,
        },
      },
    })
  }

  revision.value++
}

function detectCorruption(taskId: string): CorruptionReport | null {
  const ctx = manager.getContext(taskId)
  if (!ctx) return null

  const report = recovery.detect(ctx)
  if (!report) return null

  // 仅当 corrupted 时 append timeline + increment revision
  if (report.corrupted) {
    writeTimelineEvent({
      type: 'recovery.corruption_detected',
      taskId,
      payload: {
        summary: `Context corruption detected: ${report.details.join('; ')}`,
        metadata: {
          contextDataExists: report.checks.contextDataExists,
          executionStateConsistent: report.checks.executionStateConsistent,
          statusConsistent: report.checks.statusConsistent,
        },
      },
    })
    revision.value++
  }

  return report
}

// 以下为纯查询透传 — 不 increment revision
function assessRecovery(taskId: string): RecoveryAssessment | null {
  const ctx = manager.getContext(taskId)
  if (!ctx) return null
  return recovery.assess(ctx)
}

function getRecoverySummary(taskId: string): RecoverySummary | null {
  const ctx = manager.getContext(taskId)
  if (!ctx) return null
  return recovery.getSummary(ctx)
}

function getResolutionState(taskId: string): 'pending' | 'resolved' | 'failed' {
  const ctx = manager.getContext(taskId)
  if (!ctx) return 'pending'
  return recovery.getResolution(ctx)
}
```

---

## 4. Mutation Authority Matrix（修正后）

| 操作 | RuntimeStore | Composable | Service |
|------|:-----------:|:----------:|:-------:|
| `manager.getContext()` | ✅ 独占 | ❌ | ❌ |
| `manager.createContext()` | ✅ 独占 | ❌ | ❌ |
| `manager.updateLayer()` | ✅ 独占 | ❌ | ❌ |
| `manager.recalcSize()` | ✅ 独占 | ❌ | ❌ |
| `ctx.resources.asset = X` | ✅ 独占 | ❌ | ❌ |
| `ctx.resources.recovery = X` | ✅ 独占 | ❌ | ❌ |
| `ctx.*.property = X`（任何属性） | ✅ 独占 | ❌ | ❌ |
| `revision.value++` | ✅ 独占 | ❌ | ❌ |
| `writeTimelineEvent()` | ✅ 独占 | ❌ | ❌ |
| `timelineStore.importEvents()` | ✅ 独占 | ❌ | ❌ |
| `serializeContext(ctx)` | ❌ | ✅ | ❌ |
| `deserializeContext(snapshot)` | ❌ | ✅ | ❌ |
| `persistContext(ctx)` | ❌ | ✅ | ❌ |
| `createAssetReference()` | ❌ | ✅ | ❌ |
| `markInvalidated()` | ❌ | ✅ | ❌ |
| `checkAssetHealth()` | ❌ | ✅ | ❌ |
| `buildAssetSummary()` | ❌ | ✅ | ❌ |
| `buildFailureRecord()` | ❌ | ✅ | ❌ |
| `assessRecoveryFn(ctx)` | ❌ | ✅ | ✅（在 Service 层） |
| `detectCorruptionFn(ctx)` | ❌ | ✅ | ✅（在 Service 层） |

**核心原则**：一列只有一个 ✅。无双重 authority。

---

## 5. revision.value++ 触发策略（修正后）

```
revision.value++ 仅在 semantic mutation occurred 时执行

┌──────────────────────────────┬──────────┬──────────────────────┐
│ 方法                          │ revision │ 条件                  │
├──────────────────────────────┼──────────┼──────────────────────┤
│ registerContextForTask        │ ✅       │ always               │
│ updateContextFromTask         │ ✅       │ always               │
│ completeContextForTask        │ ✅       │ always               │
│ failContextForTask            │ ✅       │ always               │
│ destroyContext                │ ✅       │ always               │
│ loadSkillForTask              │ ✅       │ always               │
│ loadContextLayer              │ ✅       │ always               │
│ unloadContextLayer            │ ✅       │ always               │
│ executeTask                   │ ✅       │ always               │
│ saveContextPersist            │ ❌       │ 副作用，非 mutation   │
│ saveAllPersist                │ ❌       │ 副作用，非 mutation   │
│ restoreRuntime                │ ✅       │ always               │
│ registerAsset                 │ ✅       │ always               │
│ invalidateAsset               │ ✅       │ only if found         │
│ reconcileAssets               │ ✅       │ only if changed       │
│ getAssetSummary               │ ❌       │ read-only query       │
│ applyFailureRecord            │ ✅       │ always (writes layer) │
│ assessRecovery                │ ❌       │ read-only query       │
│ detectCorruption              │ ✅       │ only if corrupted     │
│ getRecoverySummary            │ ❌       │ read-only query       │
│ getResolutionState            │ ❌       │ read-only query       │
│ getTaskTimeline               │ ❌       │ read-only query       │
│ getRecentEvents               │ ❌       │ read-only query       │
│ getEventsByType               │ ❌       │ read-only query       │
│ getActiveContext              │ ❌       │ read-only query       │
│ getContextSummary             │ ❌       │ read-only query       │
└──────────────────────────────┴──────────┴──────────────────────┘
```

---

## 6. 数据流对比（Before vs After）

### 6.1 Asset 注册

```
Before (Dual Authority):
  RuntimeStore.registerAsset(taskId, ...)
    └─ composable.register(taskId, ...)
         ├─ manager.getContext(taskId)     ← composable 获取 ctx
         ├─ createAssetReference(...)       ← 纯计算
         └─ ctx.resources.asset = updated   ← composable mutation ctx ❌

After (Sole Authority):
  RuntimeStore.registerAsset(taskId, ...)
    ├─ manager.getContext(taskId)           ← RuntimeStore 获取 ctx
    ├─ composable.buildRegistration(        ← composable 纯计算
    │     ctx.resources?.asset, ...)
    │     └─ return { ref, updated }
    ├─ ctx.resources.asset = updated        ← RuntimeStore 应用 patch ✅
    └─ revision.value++                     ← RuntimeStore 触发响应式
```

### 6.2 Recovery 失败记录

```
Before (Dual Authority):
  RuntimeStore.applyFailureRecord(taskId, error)
    └─ composable.applyFailure(taskId, error)
         ├─ manager.getContext(taskId)       ← composable 获取 ctx
         ├─ buildFailureRecord(...)          ← 纯计算
         ├─ ctx.resources.recovery = {...}  ← composable mutation ctx ❌
         └─ return { assessmentChanged, ... }

After (Sole Authority):
  RuntimeStore.applyFailureRecord(taskId, error)
    ├─ manager.getContext(taskId)            ← RuntimeStore 获取 ctx
    ├─ composable.buildFailureApplication(   ← composable 纯计算
    │     ctx.resources?.recovery, ...)
    │     └─ return { patch, assessmentChanged, ... }
    ├─ ctx.resources.recovery = patch        ← RuntimeStore 应用 patch ✅
    ├─ if changed → writeTimelineEvent(...)  ← RuntimeStore append timeline
    └─ revision.value++                      ← RuntimeStore 触发响应式
```

### 6.3 Persistence 恢复

```
Before (Dual Authority):
  RuntimeStore.restoreRuntime()
    ├─ { contexts, events } = loadAll()
    └─ composable.restore(contexts)
         ├─ manager.createContext(...)        ← composable mutation ❌
         ├─ manager.updateLayer(...)          ← composable mutation ❌
         └─ ctx.resources.* = ...            ← composable mutation ❌

After (Sole Authority):
  RuntimeStore.restoreRuntime()
    ├─ { snapshots, events } = persistence.loadAll()
    ├─ for each snapshot:
    │    ├─ manager.createContext(...)        ← RuntimeStore reconstruction ✅
    │    ├─ manager.updateLayer(...)          ← RuntimeStore reconstruction ✅
    │    ├─ manager.recalcSize(...)           ← RuntimeStore reconstruction ✅
    │    └─ ctx.resources.* = snapshot.*      ← RuntimeStore resource restore ✅
    ├─ timelineStore.importEvents(events)     ← RuntimeStore timeline restore ✅
    └─ revision.value++                       ← RuntimeStore 触发响应式
```

---

## 7. 实施任务（6 项）

### Task 1: 创建 `usePersistenceRuntime` composable

**文件**：`src/composables/usePersistenceRuntime.ts`

**内容**：
- `saveContext(ctx: RuntimeContext): Promise<boolean>` — 纯 disk IO，不接触 manager
- `saveAll(contexts: RuntimeContext[], events: RuntimeEvent[]): Promise<boolean>` — 纯 disk IO
- `loadAll(): Promise<{ snapshots: ContextSnapshot[], events: RuntimeEvent[] }>` — 纯 disk IO + 反序列化
- 内部调用 `persistenceRuntime` 的函数 + `contextSerializer` + `timelineSerializer`
- 不 import ContextManager / TimelineStore
- 不 import RuntimeContext（仅作为类型参数）

### Task 2: 创建 `useAssetRuntime` composable

**文件**：`src/composables/useAssetRuntime.ts`

**内容**：
- `buildRegistration(existing, taskId, path, metadata)` → `{ ref, updated }` — 纯计算
- `buildInvalidation(collection, assetId)` → `{ updated, assetType } | null` — 纯计算
- `checkHealth(collection)` → `Promise<{ updated, changed }>` — observation
- `buildSummary(collection)` → summary — 纯计算
- 不 import ContextManager
- 不接触 RuntimeContext / ctx
- 所有输入为 plain data

### Task 3: 创建 `useRecoveryRuntime` composable

**文件**：`src/composables/useRecoveryRuntime.ts`

**内容**：
- `buildFailureApplication(existingLayer, error, executionState, taskStatus, ctx)` → `{ patch, assessmentChanged, assessmentState, failureCode }` — 纯计算
- `assess(ctx)` → `RecoveryAssessment | null` — 透传
- `detect(ctx)` → `CorruptionReport | null` — 透传
- `getSummary(ctx)` → `RecoverySummary | null` — 透传
- `getResolution(ctx)` → `'pending' | 'resolved' | 'failed'` — 透传
- ctx 参数仅用于只读访问，不 mutation
- 不 import ContextManager

### Task 4: Rewire RuntimeStore — Persistence section

**变更**：
- 删除 `saveContextPersist` 中的 `persistContext` 直接调用，替换为 `persistence.saveContext(ctx)`
- 删除 `saveAllPersist` 中的 `persistAll` 直接调用，替换为 `persistence.saveAll(contexts, events)`
- 重写 `restoreRuntime`：
  - `loadAll()` → `persistence.loadAll()`
  - reconstruction 逻辑全部保留在 RuntimeStore（createContext/updateLayer/recalcSize/importEvents）
  - 删除 composable 的 `restore()` 调用
- `normalizeLayer` 保留在 RuntimeStore（属于 reconstruction 工具）

### Task 5: Rewire RuntimeStore — Asset + Recovery sections

**变更**：
- `registerAsset`：getContext → `asset.buildRegistration(collection, ...)` → 应用 updated → revision++
- `invalidateAsset`：getContext → `asset.buildInvalidation(collection, ...)` → 应用 updated → timeline + revision++
- `reconcileAssets`：getContext → `asset.checkHealth(collection)` → 条件应用 → 条件 revision++
- `getAssetSummary`：getContext → `asset.buildSummary(collection)`
- `applyFailureRecord`：getContext → `recovery.buildFailureApplication(layer, ...)` → 应用 patch → 条件 timeline + revision++
- `detectCorruption`：getContext → `recovery.detect(ctx)` → 条件 timeline + 条件 revision++
- `assessRecovery`：getContext → `recovery.assess(ctx)`（透传）
- `getRecoverySummary`：getContext → `recovery.getSummary(ctx)`（透传）
- `getResolutionState`：getContext → `recovery.getResolution(ctx)`（透传）

### Task 6: TypeScript 编译 + 功能回归

**验证**：
- `npx vue-tsc --noEmit` 零错误
- RuntimeStore 26 个 public method 签名不变
- Composable 文件无 `ref()` / `computed()` / `reactive()`
- Composable 文件无 `manager.` 调用（Persistence 除外，仅 import service 函数）
- Composable 文件无 `writeTimelineEvent` 调用
- Composable 文件无 `revision` 访问
- Asset/Recovery composable 文件无 `getContext` / `RuntimeContext` import
- `restoreRuntime` 逻辑完整（5 Layers + 2 resources + timeline import）

---

## 8. 红线约束（最终）

```
实施红线
═══════════════════════════════════════════════════════════
❌ 不修改 RuntimeStore 的 26 个 public method 签名
❌ 不修改 RuntimeStore 的 3 个 computed 属性
❌ 不修改 Pinia store 定义（仍为单一 useRuntimeStore）
❌ 不将 runtime state（revision / timelineStore / manager）传入 composable

Composable 红线
═══════════════════════════════════════════════════════════
❌ composable 不创建 ref / computed / reactive / shallowRef
❌ composable 不调用 manager.getContext / createContext / updateLayer / recalcSize
❌ composable 不调用 writeTimelineEvent / timelineStore.append
❌ composable 不导入 TimelineStore / Pinia
❌ composable 不导入 RuntimeEvent / RuntimeEventType
❌ composable 不 mutation ctx 的任何属性（包括 resources）
❌ composable 不创建独立 Pinia store
✅ composable 只 compute / validate / buildPatch / serialize / deserialize

RuntimeStore 红线（不变）
═══════════════════════════════════════════════════════════
✅ RuntimeStore 是唯一 runtime owner
✅ RuntimeStore 是唯一 mutation owner
✅ RuntimeStore 是唯一 reconstruction owner
✅ RuntimeStore 是唯一 timeline owner
✅ RuntimeStore 是唯一 revision owner
✅ RuntimeStore 是唯一 orchestration root

Service 红线（不变）
═══════════════════════════════════════════════════════════
✅ Service 保持纯函数、无状态、不访问 ContextManager
```

---

## 9. 变更文件清单

| 文件 | 操作 | 行数 |
|------|------|:----:|
| `src/composables/usePersistenceRuntime.ts` | **新建** | ~60 |
| `src/composables/useAssetRuntime.ts` | **新建** | ~85 |
| `src/composables/useRecoveryRuntime.ts` | **新建** | ~80 |
| `src/stores/runtime.ts` | **修改** | ~420（从 760 减少） |

**净效果**：+3 文件（~225 行），RuntimeStore 减少 ~340 行（从 760 → ~420）。总计 ~645 行分布在 4 个文件中。

**Authority 分布**：
- RuntimeStore：16 mutation methods + 10 read-only queries = 26 public methods（不变）
- Composables：13 pure compute functions（零 mutation authority）
- Services：已有 pure functions（不变）
