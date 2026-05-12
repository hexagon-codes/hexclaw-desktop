# Runtime Kernel v0.4 Architecture Snapshot

> 生成日期：2026-05-12
> 对应 Phase 8-10 完成状态（Persistence + Asset + Recovery）

---

## 1. Phase 8-10 新增能力清单

### Phase 8 — Persistence Runtime

| 能力 | 文件 | 状态 |
|------|------|------|
| ContextSnapshot / TimelineSnapshot / RuntimeManifest 类型 | `src/types/persistence.ts` | ✓ |
| contextSerializer（serializeContext/deserializeContext） | `src/services/runtime/contextSerializer.ts` | ✓ |
| timelineSerializer（serializeTimeline/deserializeTimeline） | `src/services/runtime/timelineSerializer.ts` | ✓ |
| PersistenceRuntime（saveContext/saveAll/loadAll） | `src/services/runtime/persistenceRuntime.ts` | ✓ |
| 原子写入（tmp→rename，防写崩溃） | `src/services/runtime/persistenceRuntime.ts` | ✓ |
| importEvents（保留原始 id/timestamp，replace 非 append） | `src/services/runtime/timelineStore.ts` | ✓ |
| restoreRuntime（显式调用，不 auto restore） | `src/stores/runtime.ts` | ✓ |
| normalizeLayer（null→undefined 在 RuntimeStore 执行） | `src/stores/runtime.ts` | ✓ |

### Phase 9 — Asset Reference Runtime

| 能力 | 文件 | 状态 |
|------|------|------|
| AssetReference / AssetHandle / AssetCollection 类型 | `src/types/asset.ts` | ✓ |
| AssetStatus 4 态（registered/active/orphaned/invalidated） | `src/types/asset.ts` | ✓ |
| AssetService（createAssetReference/resolveAsset/checkAssetHealth/markInvalidated/ensureAssetCollection/buildAssetSummary） | `src/services/runtime/assetService.ts` | ✓ |
| AssetValidator（validatePath: normalize + traversal detection + absolute check） | `src/services/runtime/assetValidator.ts` | ✓ |
| registerAsset（status=registered 默认，非 active） | `src/stores/runtime.ts` | ✓ |
| reconcileAssets（显式调用，Promise.allSettled 并行） | `src/stores/runtime.ts` | ✓ |
| invalidateAsset（仅记录 asset.invalidated，不记录 noisy health event） | `src/stores/runtime.ts` | ✓ |
| `asset.invalidated` Timeline Event | `src/types/timeline.ts` | ✓ |

### Phase 10 — Recovery Runtime

| 能力 | 文件 | 状态 |
|------|------|------|
| FailureType / RecoveryAssessmentState / RecoveryLayer 类型 | `src/types/recovery.ts` | ✓ |
| FailureRecord（无 FailureType 字段，仅 code/message） | `src/types/recovery.ts` | ✓ |
| CorruptionReport / RecoveryAssessment / RecoverySummary 类型 | `src/types/recovery.ts` | ✓ |
| RecoveryClassifier（classifyFailure + buildFailureRecord） | `src/services/runtime/recoveryClassifier.ts` | ✓ |
| RecoveryService（detectCorruption/assessRecovery/getResolutionState/getRecoverySummary） | `src/services/runtime/recoveryService.ts` | ✓ |
| applyFailureRecord（写入 RecoveryLayer，条件性 append recovery.assessed） | `src/stores/runtime.ts` | ✓ |
| assessRecovery / detectCorruption / getRecoverySummary / getResolutionState | `src/stores/runtime.ts` | ✓ |
| `recovery.assessed` / `recovery.corruption_detected` Timeline Events | `src/types/timeline.ts` | ✓ |
| restoreRuntime RecoveryLayer 恢复（不 auto assess/detect） | `src/stores/runtime.ts` | ✓ |

---

## 2. Recovery Philosophy

```
Recovery Domain 的核心命题不是"如何从失败中恢复"，
而是"如何判断是否值得恢复"。
```

### 2.1 核心立场

Recovery Runtime 是一个 **assessment-only**（仅评估）的语义层。它回答 3 个问题：

| 问题 | 对应函数 | 回答方式 |
|------|----------|----------|
| 这个失败可恢复吗？ | `assessRecovery(ctx)` | 基于 failure.code 分类 + context 结构完整性 |
| Context 状态是否一致？ | `detectCorruption(ctx)` | 仅检查 ctx 自一致性，不访问外部服务 |
| 恢复是否已完成？ | `getResolutionState(ctx)` | 从 execution lifecycle outcome 推断 |

### 2.2 明确不是

| 不是 | 为什么 | 归属 |
|------|--------|------|
| Retry Queue | 重试策略属于执行层，不是 Recovery 域 | Execution Lifecycle |
| Auto-Recovery | 自动恢复需要 scheduler + heartbeat，违背显式调用原则 | 未来独立 Phase |
| Scheduler | 定时/延迟重试是编排问题 | Workflow Phase |
| Failure History | RecoveryLayer 只保留最近一次 failure，完整历史在 Timeline | Timeline |
| Zombie Detection | 需要 heartbeat model，不在 Runtime 范围内 | 系统运维 |

### 2.3 设计原则

1. **Computed, not persisted** — `FailureType`、`RecoveryAssessment`、`RecoverySummary` 全部动态计算，不持久化。classification policy 可独立更新而不产生 stale data。
2. **Read-only authority** — RecoveryService 不 mutation 任何 semantic state。只有 RuntimeStore（编排层）有权写入 `ctx.resources.recovery`。
3. **Resolution from execution** — Recovery 不写入 "recovered" 状态。恢复成功/失败的判断来自 execution lifecycle 的 `task.status + execution.state`。

---

## 3. Recovery Boundary

```
┌─────────────────────────────────────────────────────────┐
│  Execution Lifecycle (Phase 6)                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐ │
│  │ prepare     │→ │ running     │→ │ completed/failed│ │
│  └─────────────┘  └─────────────┘  └────────┬────────┘ │
│                                             │          │
│                           task.status=completed/failed  │
│                           execution.state=completed/…   │
└─────────────────────────────────────────────┼──────────┘
                                              │
                    getResolutionState(ctx)   │  ← Recovery 从 execution
                    推断 resolved/failed       │    lifecycle outcome 读取
                                              │
┌─────────────────────────────────────────────┼──────────┐
│  Recovery Domain (Phase 10)                 │          │
│                                             ▼          │
│  ┌──────────────────┐   ┌──────────────────────────┐  │
│  │ classifyFailure  │   │ assessRecovery(ctx)      │  │
│  │ (permanent/      │   │ recoverable/unrecoverable│  │
│  │  transient/      │   │ /unknown                 │  │
│  │  corruption/     │   └──────────────────────────┘  │
│  │  unknown)        │                                 │
│  └──────────────────┘                                 │
│                                                       │
│  ┌──────────────────┐   ┌──────────────────────────┐  │
│  │ detectCorruption │   │ getRecoverySummary(ctx)  │  │
│  │ (ctx 自一致性)   │   │ (UI 动态 rebuild)        │  │
│  └──────────────────┘   └──────────────────────────┘  │
│                                                       │
│  写入：ctx.resources.recovery（persistent）            │
│    - failure: FailureRecord | null                    │
│    - lastAssessment: string (ISO)                     │
│                                                       │
│  不写入：FailureType / RecoveryAssessmentState         │
│          resolution state / recoveryAttempts          │
└───────────────────────────────────────────────────────┘
```

### 3.1 关键边界

| 边界 | Recovery 侧 | 非 Recovery 侧 |
|------|------------|---------------|
| FailureType 持久化 | ❌ 不持久化，restore 后重新 classify | — |
| Resolution State | ❌ 不由 Recovery 写入 | ✅ 由 execution outcome 推断（getResolutionState） |
| markRecovered / markRecoveryFailed | ❌ 不存在于 Recovery 域 | ✅ 属于 Execution Lifecycle 的 completeContextForTask / failContextForTask |
| Recovery Attempts 计数 | ❌ 不在 RecoveryLayer 中 | — |
| Zombie timeout / heartbeat | ❌ 不检测 | — |
| Retry scheduling | ❌ 不触发 | — |

### 3.2 持久化边界

```
RecoveryLayer (persisted)          FailureType (NOT persisted)
┌──────────────────────┐           ┌──────────────────┐
│ failure: {           │           │ classifyFailure( │
│   code: "NETWORK_.." │───────→   │   "NETWORK_...") │
│   message: "..."     │  restore  │ → 'transient'    │
│   timestamp: "..."   │  时重新   └──────────────────┘
│   executionState...  │  classify
│   taskStatus...      │           RecoveryAssessment (NOT persisted)
│ }                    │           ┌──────────────────┐
│ lastAssessment: ".." │───────→   │ assessRecovery()  │
└──────────────────────┘  每次查询 → 'recoverable'    │
                          动态计算  └──────────────────┘
```

---

## 4. Assessment-only Semantics

### 4.1 纯函数架构

Recovery 的所有"判断"逻辑都是纯函数，不产生副作用：

```
classifyFailure(code) → FailureType
    │  基于 code 模式匹配，不访问外部服务
    │  PERMANENT: INVALID_INPUT / AUTH_FAILED / CAPABILITY_DENIED / TASK_CANCELLED / BUDGET_EXCEEDED
    │  TRANSIENT: NETWORK_TIMEOUT / RATE_LIMITED / RESOURCE_UNAVAILABLE / SIDECAR_UNREACHABLE / EXECUTION_TIMEOUT
    │  其他 → unknown
    │  corruption 由 detectCorruption 单独检测，不在此分类
    ▼
detectCorruption(ctx) → CorruptionReport
    │  4 checks（仅 ctx 自一致性）：
    │  1. contextDataExists — ctx 自身非 null/undefined
    │  2. executionStateConsistent — execution.state 不在 running/preparing（illegal combination）
    │  3. statusConsistent — task.status ↔ execution.state 一致性
    │  4. essentialLayersLoaded — system + task + execution 三层存在
    │  不访问 ContextManager / TimelineStore / RuntimeStore
    ▼
assessRecovery(ctx) → RecoveryAssessment | null
    │  综合分类 + 结构完整性 → assessmentState + suggestedAction
    │  corrupted        → unrecoverable → clean_restart
    │  permanent        → unrecoverable → ignore
    │  !contextIntact   → unrecoverable → manual_intervention
    │  transient        → recoverable   → retry
    │  else             → unknown       → manual_intervention
    ▼
getResolutionState(ctx) → 'pending' | 'resolved' | 'failed'
    │  从 execution lifecycle outcome 推断（不由 Recovery 写入）：
    │  failure 存在 + task=completed + execution=completed → resolved
    │  failure 存在 + task=failed + execution=failed → failed
    │  其他 → pending
    ▼
getRecoverySummary(ctx) → RecoverySummary | null
      动态 rebuild，供 UI 消费，不持久化
```

### 4.2 Timeline 事件纪律

| 事件 | 触发条件 | 防止 spam |
|------|----------|-----------|
| `recovery.assessed` | `applyFailureRecord` 时，仅当 `prevAssessmentState !== newAssessmentState` | 同类型连续失败不重复触发 |
| `recovery.corruption_detected` | `detectCorruption` 时，仅当 `corrupted === true` | 无损坏时不记录 |

### 4.3 RuntimeStore 编排层

```
applyFailureRecord(taskId, error)
  │  RuntimeStore 编排（唯一 mutation authority）
  ├─ 1. classifyFailure(code)  — 纯函数
  ├─ 2. buildFailureRecord()   — 纯函数
  ├─ 3. 计算 prevAssessment    — 纯函数（基于旧 RecoveryLayer）
  ├─ 4. 写入 ctx.resources.recovery  ← 唯一 mutation
  ├─ 5. 计算 newAssessment     — 纯函数（基于新 RecoveryLayer）
  └─ 6. if changed → append recovery.assessed

detectCorruption(taskId)
  │  RuntimeStore 编排
  ├─ 1. detectCorruptionFn(ctx)  — 纯函数
  └─ 2. if corrupted → append recovery.corruption_detected
```

---

## 5. Resource vs Semantic Layer

### 5.1 架构演进

Phase 1-7 建立了 5 Semantic Layers。Phase 9-10 引入了 `ctx.resources` 命名空间作为非语义扩展点：

```
RuntimeContext
├── system: SystemLayer          ◄── Semantic Layer（不可变核心）
├── skill: SkillLayer            ◄── Semantic Layer
├── task: TaskLayer              ◄── Semantic Layer
├── execution: ExecutionLayer    ◄── Semantic Layer
├── memory: MemoryLayer          ◄── Semantic Layer
├── layerStates: Record<...>     ◄── 层状态管理
└── resources: {                 ◄── Resource Reference（非 Semantic Layer）
      asset?: AssetCollection    ◄── Phase 9：资产引用指针
      recovery?: RecoveryLayer   ◄── Phase 10：恢复数据
    }
```

### 5.2 关键区别

| 维度 | Semantic Layer | Resource Reference |
|------|---------------|-------------------|
| **可扩展性** | 固定 5 层，不可新增 | 命名空间可追加（asset / recovery / ...） |
| **生命周期** | 由 ContextLoader 管理（load/unload） | 由 RuntimeStore 直接管理 |
| **持久化** | 作为 ContextSnapshot 顶级字段 | 作为 ContextSnapshot 内嵌字段 |
| **层计数** | 纳入 layerStates + recalcSize | 不参与层预算 |
| **读写权限** | 仅 ContextLoader / ContextManager | RuntimeStore 编排层 |
| **语义权重** | 核心 Runtime 语义 | 辅助数据，可独立演进 |

### 5.3 为什么 Asset 和 Recovery 不是 Semantic Layer

**Asset = Resource Reference，不是 File Manager**
- AssetCollection 存储的是"指向文件的指针"（path + metadata），不是文件内容
- AssetService 是无状态纯函数，不持有 Map，不直接 mutation collection
- reconcileAssets 是显式调用，不自动触发

**Recovery = Resource Reference，不是 Retry Engine**
- RecoveryLayer 存储的是"失败记录 + 评估时间"，不是恢复策略
- RecoveryService 是 assessment-only 纯函数，不 mutation semantic state
- Resolution 来自 execution lifecycle outcome，不由 Recovery 写入

### 5.4 红线

```
❌ resources 中的数据不得影响 Semantic Layer 的状态转换
❌ resources 中的数据不得参与 layerStates 管理
❌ 不得在 Semantic Layer 中引用 resources 数据
❌ resources 扩展点不得演化为 "第 6/7 层"
✅ resources 仅作为 Resource Reference 容器
✅ 每个 resource 类型有独立的 Service + Store 编排
```

---

## 6. Persistence vs Reconciliation

### 6.1 两个正交操作

Phase 8-10 引入了两个容易混淆的操作，其边界必须明确：

```
Persistence (save/restore)              Reconciliation (health check)
═══════════════════════════════         ═══════════════════════════════
目的：数据持久化与恢复                  目的：验证外部资源状态
操作：序列化 → 写磁盘                   操作：exists() → 更新 status
方向：内存 ↔ 磁盘                       方向：内存 → 文件系统（检查）
时机：显式调用 saveContext/saveAll      时机：显式调用 reconcileAssets
     显式调用 restoreRuntime                 显式调用 detectCorruption
```

### 6.2 关键约束

| 约束 | 说明 |
|------|------|
| **Persistence 不触发 Reconciliation** | saveContext 仅序列化当前状态，不检查 asset 文件是否存在 |
| **Restore 不触发 Reconciliation** | restoreRuntime 仅恢复数据，不 auto assess / detect / reconcile |
| **Reconciliation 不触发 Persistence** | reconcileAssets 仅更新内存 status，不自动保存 |
| **Snapshot 只保存 Reference，不保存内容** | ContextSnapshot 中的 asset 是 AssetCollection（指针列表），recovery 是 RecoveryLayer（最近一次失败记录） |

### 6.3 restoreRuntime 的行为边界

```
restoreRuntime()
  │
  ├─ 1. loadAll() → { contexts, events }
  │
  ├─ 2. 逐 Context 恢复：
  │     ├─ createContext + updateLayer × 5（Semantic Layers）
  │     │   通过 manager.updateLayer() 保证 layer invariant
  │     │
  │     ├─ Asset 恢复：
  │     │   仅恢复 AssetCollection 数据 → ctx.resources.asset
  │     │   ❌ 不做 checkAssetHealth
  │     │   ❌ 不做 reconcileAssets
  │     │   ❌ 不 append asset.invalidated
  │     │
  │     └─ Recovery 恢复：
  │         仅恢复 RecoveryLayer 数据 → ctx.resources.recovery
  │         ❌ 不做 auto assess
  │         ❌ 不做 detectCorruption
  │         ❌ 不 append recovery.assessed
  │         ❌ 不 append recovery.corruption_detected
  │
  └─ 3. importEvents（保留原始 id/timestamp）
```

### 6.4 为什么不 auto reconcile on restore

1. **文件系统状态不可靠** — 恢复时文件可能已被移动/删除/修改，auto reconcile 会产生大量 orphaned/invalidated 事件
2. **Restore ≠ Health Check** — 恢复的目标是重建内存状态，不是验证外部世界
3. **显式调用原则** — 所有有副作用的操作（reconcile/detect/assess）应由 UI 或 Task 生命周期显式触发

---

## 7. 更新后的文件索引

### 新增类型定义

| 文件 | 核心导出 | 职责 |
|------|----------|------|
| `src/types/persistence.ts` | ContextSnapshot, TimelineSnapshot, RuntimeManifest | 持久化快照类型 |
| `src/types/asset.ts` | AssetReference, AssetHandle, AssetCollection, AssetStatus, AssetType, AssetMetadata | 资产引用类型 |
| `src/types/recovery.ts` | FailureType, FailureRecord, RecoveryLayer, RecoveryAssessment, CorruptionReport, RecoverySummary | 恢复语义类型 |

### 新增服务

| 文件 | 核心导出 | 职责 |
|------|----------|------|
| `src/services/runtime/persistenceRuntime.ts` | saveContext, saveAll, loadAll | 快照持久化（原子写入） |
| `src/services/runtime/contextSerializer.ts` | serializeContext, deserializeContext | Context ↔ Snapshot 序列化 |
| `src/services/runtime/timelineSerializer.ts` | serializeTimeline, deserializeTimeline | Timeline ↔ Snapshot 序列化 |
| `src/services/runtime/assetService.ts` | createAssetReference, resolveAsset, checkAssetHealth, markInvalidated, ensureAssetCollection, buildAssetSummary | 资产引用服务（无状态） |
| `src/services/runtime/assetValidator.ts` | validatePath | 路径安全校验 |
| `src/services/runtime/recoveryClassifier.ts` | classifyFailure, buildFailureRecord | 失败分类（纯函数） |
| `src/services/runtime/recoveryService.ts` | detectCorruption, assessRecovery, getResolutionState, getRecoverySummary | 恢复评估（纯函数） |

### 类型定义修改

| 文件 | 变更 | Phase |
|------|------|-------|
| `src/types/context.ts:158-162` | RuntimeContext.resources 新增 `asset?` + `recovery?` | Phase 9 + 10 |
| `src/types/timeline.ts:53-57` | RuntimeEventType 新增 `asset.invalidated` / `recovery.assessed` / `recovery.corruption_detected` | Phase 9 + 10 |

### 服务修改

| 文件 | 变更 | Phase |
|------|------|-------|
| `src/services/runtime/timelineStore.ts` | 新增 `importEvents(events)` | Phase 8 |

### Store 修改

| 文件 | 新增方法 | Phase |
|------|----------|-------|
| `src/stores/runtime.ts` | saveContext, saveAll, restoreRuntime, normalizeLayer | Phase 8 |
| `src/stores/runtime.ts` | registerAsset, invalidateAsset, reconcileAssets, getAssetSummary | Phase 9 |
| `src/stores/runtime.ts` | applyFailureRecord, assessRecovery, detectCorruption, getRecoverySummary, getResolutionState | Phase 10 |

---

## 8. 当前红线约束（更新）

```
红线                                                      │ 来源
──────────────────────────────────────────────────────────┼────────────────
❌ No watch 自动绑定 TaskStore/Timeline                   │ Phase 2 起全线
❌ No nested executeTask                                  │ Phase 6 execute
❌ No recursive execution                                 │ Phase 6 execute
❌ No task spawning / subtask creation                    │ Phase 6 execute
❌ Executor 不能 append timeline event                    │ Phase 6 contract
❌ Executor 不能 mutate RuntimeStore                      │ Phase 6 contract
❌ Executor 不能 create/destroy context                   │ Phase 6 contract
❌ Execution Runtime ≠ Tool Runtime                       │ Phase 6
❌ Execution Runtime ≠ Agent Framework                    │ Phase 6
❌ Timeline ≠ Event Bus                                   │ Phase 5
❌ Timeline ≠ Telemetry Pipeline                          │ Phase 5
❌ Timeline ≠ Tool Trace                                  │ Phase 5
❌ Capability ≠ Tool Execution                            │ Phase 4
❌ CapabilityValidator 不阻断注入                         │ Phase 4
❌ canTransition warn-only, 不改变控制流                  │ Phase 7
❌ Timeline 事件不做 auto-derivation                      │ Phase 7
❌ Event payload.metadata 禁止嵌套对象                     │ Phase 5
❌ stepCount 有界整数，非 reasoning trace                  │ Phase 6
❌ historicalResults append-only                          │ Phase 6
──────────────────────────────────────────────────────────┼────────────────
❌ Persistence ≠ ORM / DB / Event Sourcing               │ Phase 8
❌ Persistence 不做 auto-save                             │ Phase 8
❌ Persistence 不做 history snapshots                     │ Phase 8
❌ Persistence 不做 App shutdown hook                     │ Phase 8
❌ restoreRuntime 不做 resource reconciliation            │ Phase 8
──────────────────────────────────────────────────────────┼────────────────
❌ Asset ≠ File Manager / Media Library / Object Storage  │ Phase 9
❌ AssetService 无状态、不持有 Map                        │ Phase 9
❌ AssetService 不直接 mutation collection                │ Phase 9
❌ registerAsset 默认 registered，不是 active              │ Phase 9
❌ reconcileAssets 显式调用，不自动触发                     │ Phase 9
❌ invalidateAsset 仅记录 asset.invalidated               │ Phase 9
❌ Persistence 只保存 AssetReference，不保存文件内容       │ Phase 9
──────────────────────────────────────────────────────────┼────────────────
❌ Recovery ≠ retry / scheduler / auto-recovery           │ Phase 10
❌ Recovery 没有 semantic mutation authority              │ Phase 10
❌ FailureRecord 不持久化 FailureType                     │ Phase 10
❌ Resolution 从 execution lifecycle 推断                  │ Phase 10
❌ recovery.assessed 仅在 assessmentState 变化时 append   │ Phase 10
❌ detectCorruption 仅检查 ctx 自一致性                    │ Phase 10
❌ restoreRuntime 不 auto assess/detect                   │ Phase 10
```

---

## 9. 当前技术债务

### P0 — 需优先解决

| 债务 | 描述 | 涉及文件 | 影响 |
|------|------|----------|------|
| — | v0.4 无新增 P0 债务 | — | — |

### P1 — 应规划解决

| 债务 | 描述 | 涉及文件 | 影响 |
|------|------|----------|------|
| RuntimeStore 行数增长至 ~760 行 | 26 个公开方法，monotonic 增长；可考虑按领域拆分为 composables | `src/stores/runtime.ts` | 长期可维护性 |
| `detectCorruption` 总是 `revision.value++` | 无损坏时仍触发 Vue 响应式，与 reconcileAssets 的 early return 模式不一致 | `src/stores/runtime.ts:599` | 无功能性 bug |
| PERMANENT_CODES / TRANSIENT_CODES 硬编码 | 新增 error code 需修改源码 | `src/services/runtime/recoveryClassifier.ts` | 扩展性受限 |

### P2 — 可长期跟进

| 债务 | 描述 |
|------|------|
| Persistence 文件路径硬编码 `.hexclaw/` | 未来可能需要可配置路径 |
| AssetSummary 不持久化 | 每次查询 rebuild，大量 asset 时可能性能开销 |
| Recovery 无 failure history | 仅保留最近一次 failure，历史需从 Timeline 回溯 |

---

## 10. 下一阶段建议

### v0.5 候选方向

```
方案 A：RuntimeStore Composables 拆分
  将 Persistence / Asset / Recovery 从 RuntimeStore 提取为独立 composables
  保持现有接口签名，仅做文件拆分

方案 B：Capability Policy Engine（Phase 4 Phase 2）
  将 Capability 从 warn-only 升级为可配置 strict mode
  需要 Policy 持久化 + runtimeServices 传播

方案 C：Execution Lifecycle v2
  将 executeTask 的单次执行升级为支持 step-by-step
  需要 Execution Layer 阶段性持久化 + resume
```
