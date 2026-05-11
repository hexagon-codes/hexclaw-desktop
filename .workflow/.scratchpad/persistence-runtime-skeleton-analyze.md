# Persistence Runtime Skeleton — Analyze

> 生成日期：2026-05-11
> 基于 Runtime Kernel v0.1 (Phase 1-7)

---

## 1. Persistence Runtime 架构

### 定位

```
Persistence Runtime = Runtime Snapshot Persistence

不是：
- ORM / Database Layer / Event Sourcing
- Reactive Sync / Auto-save Watch
- 版本历史 / 增量同步
```

### 系统分层

```
┌──────────────────────────────────────────────┐
│              RuntimeStore (Pinia)              │  ▲ 显式调用
├──────────────────────────────────────────────┤  │
│         PersistenceRuntime (新增)               │  │ save/load
│  ┌──────────┬───────────┬──────────────┐      │  │
│  │ Context  │ Timeline  │   Memory     │      │  │
│  │ Snapshot │ Snapshot  │   Snapshot   │      │  │
│  └──────────┴───────────┴──────────────┘      │  │
├──────────────────────────────────────────────┤  │
│         Tauri plugin-fs (writeTextFile)       │  ▼ 异步 IO
├──────────────────────────────────────────────┤
│         .hexclaw/runtime/ (AppData)           │  磁盘
└──────────────────────────────────────────────┘

Runtime Kernel (Phase 1-7)   ← 不修改
PersistenceRuntime (Phase 8) ← 新增适配层
```

### 目录结构

```
$APP_DATA/.hexclaw/runtime/
├── contexts/
│   ├── ctx-{taskId}-{timestamp}.json    ← Context 快照
│   └── ctx-{taskId}-latest.json         ← symlink/最新副本
├── timelines/
│   ├── timeline-{timestamp}.json        ← Timeline 快照
│   └── timeline-latest.json             ← 最新副本
└── memories/
    ├── mem-{taskId}-{timestamp}.json    ← Memory 快照
    └── mem-{taskId}-latest.json         ← 最新副本
```

---

## 2. Snapshot 类型设计

### 2.1 Context Snapshot

```typescript
// src/types/persistence.ts (新增)

/** Context 快照 — RuntimeContext 的可持久化投影 */
export interface ContextSnapshot {
  formatVersion: '1.0'
  timestamp: string            // ISO，快照生成时间
  taskId: string
  taskType: TaskType
  system: SystemLayer | null
  skill: SkillLayer | null
  task: TaskLayer | null
  execution: ExecutionLayer | null
  memory: MemoryLayer | null
  layerStates: Record<string, ContextLayerStatus>
  createdAt: string            // ISO
  updatedAt: string            // ISO
  totalEstimatedSize: number

  // Metadata（不进 RuntimeContext）
  _meta: {
    snapshotReason: 'manual' | 'task.completed' | 'app.shutdown'
    previousSnapshot: string | null   // 前一个快照文件名
  }
}
```

**序列化边界：**

| 字段 | JSON 安全 | 说明 |
|------|-----------|------|
| `taskId: string` | ✓ | 直接序列化 |
| `taskType: TaskType` | ✓ | string union |
| `system: SystemLayer` | ✓ | 纯 interface，无函数/Map/Set |
| `skill: SkillLayer` | ✓ | 含 `SkillReference[]`, `Record<string, ContextLayerStatus>` |
| `task: TaskLayer` | ✓ | 含 `TaskInput/TaskOutput`, 全部 JSON-safe |
| `execution: ExecutionLayer` | ✓ | 含 `ExecutionIntermediateState`, 全部标量 |
| `memory: MemoryLayer` | ✓ | 含 `Array<{question,answer,timestamp}>`, JSON-safe |
| `layerStates` | ✓ | `Record<string, string>` |
| `createdAt/updatedAt` | ✓ | ISO string |

**不序列化：**
- `ContextSummary` (是计算视图，非存储)
- `estimateSize` (快照加载后由 `recalcSize` 重新计算)
- `revision` (Pinia ref，非 Context 属性)

### 2.2 Timeline Snapshot

```typescript
/** Timeline 快照 — RuntimeEvent 数组的可持久化形式 */
export interface TimelineSnapshot {
  formatVersion: '1.0'
  timestamp: string
  events: RuntimeEvent[]
  eventCount: number
}
```

**约束：**
- `RuntimeEvent` 已全部 JSON-safe（string/number/boolean 标量 payload）
- `RuntimeEventPayload.metadata` 已约束为 `Record<string, string | number | boolean>`
- 快照仅保存当前内存中的所有事件（按 append 顺序）
- TimelineSnapshot ≠ Event Sourcing Log（无 replay 语义）

### 2.3 Memory Snapshot

```typescript
/** Memory 快照 — MemoryLayer 的独立持久化 */
export interface MemorySnapshot {
  formatVersion: '1.0'
  timestamp: string
  taskId: string
  memory: MemoryLayer
}
```

**设计说明：**
- Memory 可独立于 Context 持久化（未来 Memory Runtime 需独立读写）
- Phase 8 最小实现中 Memory 随 Context 一起保存（简化）

### 2.4 Snapshot Manifest

```typescript
/** 快照清单 — 标记当前最新的快照集合 */
export interface RuntimeSnapshotManifest {
  formatVersion: '1.0'
  lastUpdated: string
  contextCount: number
  timelineEventCount: number
  snapshots: {
    contexts: string[]           // 文件名列表
    timeline: string | null
    memories: string[]
  }
}
```

---

## 3. Serialize / Deserialize 边界

### 3.1 Serialize

```
RuntimeContext
  │  JSON.stringify(snapshot)
  │  替换 undefined→null（JSON 安全）
  ▼
ContextSnapshot (JSON)
  │  writeTextFile('.hexclaw/runtime/contexts/ctx-{taskId}-{ts}.json')
  ▼
Disk

TimelineStore.events[]
  │  JSON.stringify({ formatVersion, timestamp, events })
  ▼
TimelineSnapshot (JSON)
  │  writeTextFile('.hexclaw/runtime/timelines/timeline-{ts}.json')
  ▼
Disk
```

**关键约束：**

| 操作 | 约束 |
|------|------|
| `JSON.stringify` | 所有 Runtime interface 均为 JSON-safe，无循环引用 |
| `undefined` 处理 | RuntimeContext 用 `?:` 表示可选，JSON 中自动省略 |
| `Date` 对象 | Runtime 无 Date 实例，全部使用 ISO string |
| `Map/Set` | Runtime 无 Map/Set 在 Context/Timeline 中 |
| `BigInt` | 无使用 |
| 文件编码 | UTF-8 |

### 3.2 Deserialize

```
Disk
  │  readTextFile('.hexclaw/runtime/contexts/ctx-{taskId}-{ts}.json')
  ▼
JSON.parse()
  │  type assertion: ContextSnapshot
  │  恢复 undefined（JSON 中 null → undefined）
  ▼
RuntimeContext (partial)
  │  ContextManager 重新 register
  │  recalcSize() 重新计算
  ▼
RuntimeStore (响应式)
```

**关键约束：**

| 操作 | 约束 |
|------|------|
| `JSON.parse` | 所有字段均为标量/数组/POJO |
| `null` → `undefined` | JSON 不支持 undefined，反序列化后遍历替换 |
| `layerStates` | `Record<string, string>` 直接映射 |
| `string[]` | 所有数组字段直接映射 |
| 类型安全 | 反序列化仅做 type assertion，不做 runtime validation |

### 3.3 不序列化的 Runtime 内部状态

| 状态 | 原因 | 恢复策略 |
|------|------|----------|
| `ContextManager.onEvent` callback | 函数引用不可序列化 | 恢复时重新注册 callback |
| `TimelineStore` 内部 `events[]` | 快照读入后在 store 中重建 | 反序列化后 `events.push(...)` |
| `estimateSize` 缓存 | 计算值，非存储数据 | 恢复后调 `recalcSize()` |
| Pinia `revision` ref | Vue 响应式状态 | 恢复后置 0，computed 自动触发 |
| `canTransition` 状态 | 运行时校验，非数据 | 不涉及 |
| `getRuntimeLogger()` 引用 | 全局单例，非序列化 | 不涉及 |
| `RuntimeServiceContainer` | 全局服务 | 不涉及 |

### 3.4 序列化 vs 反序列化不对称

| 方向 | 差异 |
|------|------|
| Serialize | `undefined` 字段在 JSON 中省略 |
| Deserialize | JSON 中缺失的字段 → `undefined`（TypeScript `?:` 匹配） |
| Serialize | `ContextManager` 中的 `onEvent` 不保存 |
| Deserialize | 恢复时通过构造函数重新注入 callback |
| Serialize | `_meta.snapshotReason` 仅在快照中存在 |
| Deserialize | `_meta` 字段被剥离，不进入 RuntimeContext |

---

## 4. Recovery Flow

### 4.1 冷启动恢复

```
App Launch
  │
  ├─ 1. RuntimeStore 初始化（创建 TimelineStore / ContextManager）
  │
  ├─ 2. 用户操作触发 Runtime Restore（显式调用）
  │     restoreRuntime()
  │
  ├─ 3. Scan .hexclaw/runtime/contexts/
  │     ↓
  │     读取所有 ctx-{taskId}-latest.json
  │     或读取 manifest.json 指定的最新快照
  │
  ├─ 4. 对每个 ContextSnapshot:
  │     ├─ newContext = manager.createContext(taskId, taskType)
  │     ├─ 覆盖 system/skill/task/execution/memory
  │     ├─ 覆盖 layerStates
  │     ├─ manager.recalcSize(taskId)
  │     └─ revision.value++
  │
  ├─ 5. Scan .hexclaw/runtime/timelines/timeline-latest.json
  │     ↓
  │     读取 RuntimeEvent[]
  │     timelineStore.append() 逐个导入
  │
  ├─ 6. updateContextFromTask() 同步 TaskStore 最新状态
  │
  └─ 7. Runtime 就绪
```

### 4.2 快照保存时机

```
显式调用点（非 auto-watch）：

1. task.completed 后
   completeContextForTask() → PersistenceRuntime.saveContext(taskId)

2. task.failed 后  
   failContextForTask() → PersistenceRuntime.saveContext(taskId)

3. app 关闭前（App.onClose）
   PersistenceRuntime.saveAll() → 批量保存所有上下文 + Timeline

4. 用户手动保存（UI 触发）
   PersistenceRuntime.saveContext(taskId)
```

### 4.3 恢复后状态验证

```
恢复验证清单：

[✓] Context 5 层数据结构完整
[✓] layerStates 与实际层一致
[✓] execution 状态机在合法状态
[✓] Timeline 事件顺序正确
[ ] ─ 不做 ─ task 与 sidecar 实际连接状态验证
[ ] ─ 不做 ─ execution 挂起任务恢复执行
```

---

## 5. Runtime 生命周期（含 Persistence）

```
┌─────────────────────────────────────────────────┐
│                  Runtime Lifecycle               │
├─────────────────────────────────────────────────┤
│                                                   │
│  INIT ──────────────────────────────────────────┐ │
│  │  RuntimeStore 创建                            │ │
│  │  ContextManager new                          │ │
│  │  TimelineStore new                           │ │
│  └───────────────────────────────────────────────│ │
│                                                   │
│  RESTORE (可选) ────────────────────────────────┐ │
│  │  scan .hexclaw/runtime/                      │ │
│  │  loadContexts() → manager.createContext()    │ │
│  │  loadTimeline() → timelineStore.append()     │ │
│  │  recalcSize()                               │ │
│  └───────────────────────────────────────────────│ │
│                                                   │
│  RUNNING ──────────────────────────────────────┐ │
│  │  Task → Context → Skill → Valid → Exec     │ │
│  │  writeTimelineEvent()                      │ │
│  │  ┌─── 暂停保存点 ───┐                       │ │
│  │  │ saveContext()    │  (task complete/fail) │ │
│  │  │ saveTimeline()   │  (app close)          │ │
│  │  └──────────────────┘                       │ │
│  └───────────────────────────────────────────────│ │
│                                                   │
│  SHUTDOWN ─────────────────────────────────────┐ │
│  │  saveAll()  → 全部快照                       │ │
│  │  updateManifest()                           │ │
│  │  Runtime 销毁                                │ │
│  └───────────────────────────────────────────────│ │
│                                                   │
└─────────────────────────────────────────────────┘
```

---

## 6. 风险矩阵

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 快照文件损坏（写入中断） | 低 | 中 | 先写临时文件，rename 原子化 |
| JSON 反序列化类型不匹配 | 低 | 高 | formatVersion 校验 + 字段存在性检查 |
| 大 Context 序列化性能 | 中 | 低 | 单 Context 上限 1MB (Budget)，JSON stringify < 10ms |
| Timeline 事件超上限（1000+） | 中 | 中 | 保留现有 prune 机制，快照仅保存当前内存事件 |
| 旧版快照兼容 | 低 | 低 | formatVersion 字段 + snapshot migration 预留 |
| 并发写竞争 | 低 | 中 | single-thread JS，无并发写问题 |
| 恢复后状态与 TaskStore 不一致 | 中 | 中 | 恢复后 updateContextFromTask 同步 |
| `.hexclaw` 目录权限 | 低 | 高 | 使用 Tauri AppData dir，平台保证可写 |

---

## 7. 实施任务

### PERS-01 — Snapshot 类型定义

```
文件：
  src/types/persistence.ts（新增）

内容：
  - ContextSnapshot
  - TimelineSnapshot
  - MemorySnapshot
  - RuntimeSnapshotManifest
  - SnapshotMeta (reason / previousSnapshot)

红线：
  - 不修改任何现有类型
  - 不修改 @/types/index.ts 统一导出（保持 Runtime 类型干净）
```

### PERS-02 — ContextSerializer

```
文件：
  src/services/runtime/contextSerializer.ts（新增）

内容：
  - serializeContext(RuntimeContext): ContextSnapshot
    - 深拷贝 5 层数据
    - 附加 _meta 元数据
  - deserializeContext(ContextSnapshot): RuntimeContext（部分字段）
    - JSON.parse → type assertion
    - null → undefined 转换
    - 不包含 layerStates 重建（交由 PersistenceRuntime）

红线：
  - 不修改 ContextManager
  - 不修改 RuntimeContext 类型
```

### PERS-03 — TimelineSerializer

```
文件：
  src/services/runtime/timelineSerializer.ts（新增）

内容：
  - serializeTimeline(RuntimeEvent[]): TimelineSnapshot
  - deserializeTimeline(TimelineSnapshot): RuntimeEvent[]

红线：
  - 不修改 TimelineStore
  - 不修改 Timeline append-only 语义
```

### PERS-04 — PersistenceRuntime

```
文件：
  src/services/runtime/persistenceRuntime.ts（新增）

内容：
  - saveContext(taskId): Promise<void>
    - serializer → writeTextFile
    - 写临时文件 → rename
  - saveAll(): Promise<void>
    - 遍历所有活跃 Context
    - 保存 Timeline
  - loadContexts(): Promise<Map<string, RuntimeContext>>
  - loadTimeline(): Promise<RuntimeEvent[]>

依赖：
  - contextSerializer
  - timelineSerializer
  - Tauri @tauri-apps/plugin-fs (writeTextFile, readTextFile, mkdir)

红线：
  - 不包含 watch/scheduler
  - 不包含 auto-save
  - 不修改 RuntimeStore
```

### PERS-05 — RuntimeStore Restore 集成

```
文件：
  src/stores/runtime.ts（最小修改）

修改：
  - restoreRuntime(): Promise<void> 公开方法
    - loadContexts() → 逐个 manager.createContext() + 覆盖层
    - loadTimeline() → timelineStore 导入
    - revision.value++

红线：
  - 不添加 watch/auto-save
  - restoreRuntime 为显式调用
  - 不修改 executeTask / registerContextForTask 等现有方法
```

### PERS-06 — App Shutdown Save

```
文件：
  src/App.vue 或 src/main.ts（最小修改）

内容：
  - App onUnmounted / beforeDestroy 时
    - 调 PersistenceRuntime.saveAll()
    - 调 updateManifest()

红线：
  - 不做 graceful shutdown timeout / retry
  - 不做 shutdown progress UI
```

---

## 8. 红线约束

```
红线                                                  │ 理由
──────────────────────────────────────────────────────┼────────────────
❌ 不修改现有 Runtime Layer 结构                       │ Phase 1-7 稳定契约
❌ 不修改 RuntimeContext / RuntimeEvent 类型            │ 稳定契约
❌ 不引入数据库 / ORM                                  │ JSON snapshot 足够
❌ 不引入 Event Sourcing / Event Replay                 │ Timeline = 状态历史，非重放源
❌ 不引入 auto-save watch system                       │ 违背显式 mutation 设计
❌ 不引入 reactive persistence                          │ 违背显式 mutation 设计
❌ 不修改 TimelineStore append-only 语义                │ Phase 5 红线
❌ 不修改 ContextManager / ContextLoader 现有方法       │ 稳定契约
❌ 不修改 TaskExecutor 接口                             │ Phase 6 红线
❌ 不修改 canTransition / ExecutionState               │ Phase 6 红线
❌ restoreRuntime 不做挂起任务恢复执行                   │ 超出 Skeleton 范围
❌ restoreRuntime 不做 sidecar 连接状态验证              │ 超出 Skeleton 范围
❌ 不做 Context 版本历史 / 增量同步                      │ 超出 Skeleton 范围
❌ 不做快照自动清理 / 轮转                              │ Phase 8 不做 GC
```

---

## 9. 与现有 Runtime Kernel 的关系

```
新增文件（4 个）：
  src/types/persistence.ts                    ← Snapshot 类型
  src/services/runtime/contextSerializer.ts   ← Context 序列化
  src/services/runtime/timelineSerializer.ts  ← Timeline 序列化
  src/services/runtime/persistenceRuntime.ts  ← 持久化运行时

修改文件（最小）：
  src/stores/runtime.ts                       ← 新增 restoreRuntime()
  src/App.vue (or main.ts)                    ← 新增 shutdown save

不修改文件（红线）：
  src/types/context.ts        src/types/execution.ts
  src/types/timeline.ts       src/types/capability.ts
  src/types/runtimeBudget.ts  src/types/task.ts
  src/services/contextManager.ts
  src/services/contextLoader.ts
  src/services/taskExecutor.ts
  src/services/runtime/timelineStore.ts
  src/services/runtime/timelineProjection.ts
  src/services/runtime/runtimeLogger.ts
  src/services/runtime/runtimeServices.ts
  src/utils/sizeEstimator.ts
```

---

## 10. 执行顺序建议

```
Wave 1（并行，无依赖）：
  PERS-01: Snapshot 类型定义
  PERS-02: ContextSerializer
  PERS-03: TimelineSerializer

Wave 2（依赖 Wave 1）：
  PERS-04: PersistenceRuntime（依赖 PERS-02, PERS-03）

Wave 3（依赖 Wave 2）：
  PERS-05: RuntimeStore Restore 集成（依赖 PERS-04）
  PERS-06: App Shutdown Save（依赖 PERS-04）
```
