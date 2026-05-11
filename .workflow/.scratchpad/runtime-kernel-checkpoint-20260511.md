# Runtime Kernel Development Checkpoint

> 日期：2026-05-11
> 项目：HexClaw Desktop — Runtime Kernel v0.1
> 状态：稳定可暂停

---

## 1. 当前完成阶段

### Phase 1 — Task Runtime ✓

| 组件 | 状态 | 关键文件 |
|------|------|----------|
| Task 类型系统 | 完成 | `src/types/task.ts` |
| Task 生命周期（pending→running→completed/failed/cancelled） | 完成 | `src/types/task.ts` |
| Task 隔离（同 taskId 不覆盖） | 完成 | `src/services/contextManager.ts:60-62` |

### Phase 2 — Context Runtime ✓

| 组件 | 状态 | 关键文件 |
|------|------|----------|
| RuntimeContext 5 层聚合根 | 完成 | `src/types/context.ts:142-161` |
| ContextManager（Map 所有权，无 watch） | 完成 | `src/services/contextManager.ts` |
| ContextLoader（Task→TaskLayer 深拷贝投影） | 完成 | `src/services/contextLoader.ts` |
| Context 摘要（UI 消费） | 完成 | `src/types/context.ts:166-174` |
| RuntimeStore（Pinia, revision ref 响应式桥接） | 完成 | `src/stores/runtime.ts` |

### Phase 3 — Skill Runtime ✓

| 组件 | 状态 | 关键文件 |
|------|------|----------|
| SkillRegistry（Lazy init + Map 缓存） | 完成 | `src/services/skillRegistry.ts` |
| SkillLoader（skill.json + SKILL.md + references） | 完成 | `src/services/skillLoader.ts` |
| Skill Layer 注入 | 完成 | `src/services/contextLoader.ts:147-161` |
| Skill 加载 Timeline 事件 | 完成 | `src/stores/runtime.ts:168-218` |

### Phase 4 — Governance Runtime ✓

| 组件 | 状态 | 关键文件 |
|------|------|----------|
| RuntimeBudget（maxContextSize/maxLayers） | 完成 | `src/types/runtimeBudget.ts` |
| Capability 类型系统（CapabilityName=string） | 完成 | `src/types/capability.ts` |
| CapabilityRegistry（声明式注册表） | 完成 | `src/services/capabilityRegistry.ts` |
| CapabilityValidator（3 规则验证链） | 完成 | `src/services/capabilityValidator.ts` |
| RuntimeLogger（console 委托抽象） | 完成 | `src/services/runtime/runtimeLogger.ts` |
| RuntimeServices（服务定位器） | 完成 | `src/services/runtime/runtimeServices.ts` |
| sizeEstimator（统一 JSON.stringify 估算） | 完成 | `src/utils/sizeEstimator.ts` |
| DEFAULT_ALLOWED_CAPABILITIES 单一来源 | 完成 | `src/types/capability.ts:46-51` |

### Phase 5 — Timeline Runtime ✓

| 组件 | 状态 | 关键文件 |
|------|------|----------|
| RuntimeEvent / RuntimeEventType（14 种） | 完成 | `src/types/timeline.ts` |
| TimelineStore（append-only O(1)，返副本） | 完成 | `src/services/runtime/timelineStore.ts` |
| TimelineProjection（4 只读查询函数） | 完成 | `src/services/runtime/timelineProjection.ts` |
| writeTimelineEvent 集中方法 | 完成 | `src/stores/runtime.ts:395-397` |
| MAX_TIMELINE_EVENTS 硬上限（1000） | 完成 | `src/types/timeline.ts:16` |
| RuntimeEventPayload 轻量约束 | 完成 | `src/types/timeline.ts:61-66` |

### Phase 6 — Execution Runtime ✓

| 组件 | 状态 | 关键文件 |
|------|------|----------|
| ExecutionState 5 态（idle→preparing→running→completed/failed） | 完成 | `src/types/execution.ts:13` |
| EXECUTION_TRANSITIONS + canTransition | 完成 | `src/types/execution.ts:21-32` |
| ContextAwareExecutor + executeWithContext | 完成 | `src/services/taskExecutor.ts:32-35` |
| executeTask 完整闭环 | 完成 | `src/stores/runtime.ts:273-348` |
| 3 种 Executor Adapter Shell | 完成 | `src/services/taskExecutor.ts` |
| Execution Layer 状态机写入 | 完成 | `src/services/contextLoader.ts:72-81` |
| Memory Layer 写入（append-only） | 完成 | `src/services/contextLoader.ts:87-105` |

### Phase 7 — Runtime Stabilization ✓

| 组件 | 状态 | 关键文件 |
|------|------|----------|
| canTransition warn-only（3 处，不阻断控制流） | 完成 | `src/stores/runtime.ts:285-287,299-301,320-322` |
| complete/failContextForTask 同步 execution.state | 完成 | `src/stores/runtime.ts:109-111,129-131` |
| writeTimelineEvent 集中（替换 18+ 处 append） | 完成 | `src/stores/runtime.ts:395-397` |
| now() + stubExecuteWithContext 提取 | 完成 | `src/services/taskExecutor.ts:136-151` |
| DEFAULT_ALLOWED_CAPABILITIES 三源归一 | 完成 | `src/types/capability.ts:46-51` |

---

## 2. 当前 Runtime 主链

```
registerContextForTask(task)
  │
  ├─ ContextManager.createContext(taskId, taskType)
  │  └─ 初始化 System Layer（default policy）
  ├─ ContextLoader.loadSystemLayer()
  ├─ ContextLoader.loadTaskLayer(task)        ← 深拷贝投影
  └─ writeTimelineEvent('task.created')
      │
      ▼
loadSkillForTask(taskId, skillId)             ← 可选注入
  │
  ├─ SkillLoader.loadSkill(skillId)
  ├─ CapabilityValidator.validate()
  │  └─ warn-only，不阻断
  ├─ ContextLoader.loadSkillLayer(skillPkg)
  └─ writeTimelineEvent('skill.loaded')
      │
      ▼
executeTask(taskId)
  │
  ├─ resolveExecutor(taskType)                ← Chat | Agent | Skill
  ├─ prepareExecutionLayer(ctx)
  │  └─ state='preparing' / currentStage='preparing'
  ├─ canTransition('preparing','running')? → warn-only
  ├─ state='running' / currentStage='executing'
  ├─ executor.executeWithContext(task, ctx)
  │  └─ stepCount++ / intermediateState={progress,lastUpdate}
  │
  ├─ success:
  │  ├─ canTransition('running','completed')? → warn-only
  │  ├─ state='completed' / currentStage='finalizing'
  │  ├─ loader.writeExecutionMemory(ctx)      ← append-only
  │  ├─ writeTimelineEvent('execution.completed')
  │  ├─ writeTimelineEvent('task.completed')
  │  └─ writeTimelineEvent('memory.updated')
  │
  └─ failure:
     ├─ canTransition('running','failed')? → warn-only
     ├─ state='failed' / error={code,message}
     ├─ loader.writeExecutionMemory(ctx)
     ├─ writeTimelineEvent('execution.failed')
     └─ writeTimelineEvent('task.failed')
```

### 关键架构模式

```
所有权模型:
  ContextManager(Map) ─── 唯一所有者 ─── RuntimeContext 实例
       │
       │  Timeline callback
       ▼
  TimelineStore ─── append-only ─── RuntimeEvent[]
       │
       │  query/getAll → 返副本
       ▼
  TimelineProjection ─── 纯 read-model ─── 4 函数

响应式桥接:
  revision ref ──每次 mutation +1──→ computed 重新求值
  (无 watch / reactive transform / auto derivation)

服务定位:
  RuntimeServices ──lazy──→ CapabilityRegistry + CapabilityValidator
  (RuntimeStore 不直接 new 服务)
```

---

## 3. 当前红线约束

```
类别                红线                                           来源
───────────────────┼──────────────────────────────────────────────┼────────────────
Context            ❌ No watch 自动绑定 TaskStore/Timeline         Phase 2+
Execution          ❌ No nested executeTask                        Phase 6
Execution          ❌ No recursive execution                       Phase 6
Execution          ❌ No task spawning / subtask creation          Phase 6
Executor           ❌ 不能 append timeline event                   Phase 6 contract
Executor           ❌ 不能 mutate RuntimeStore                     Phase 6 contract
Executor           ❌ 不能 create/destroy context                  Phase 6 contract
Executor           ❌ 仅允许读取 Context、写入 execution state     Phase 6 contract
Execution Runtime  ❌ ≠ Tool Runtime                               Phase 6
Execution Runtime  ❌ ≠ Agent Framework                            Phase 6
Timeline           ❌ ≠ Event Bus / Telemetry / Tool Trace         Phase 5
Timeline           ❌ 事件不做 auto-derivation                      Phase 7 方向修正
Timeline           ❌ event payload.metadata 禁止嵌套对象           Phase 5
Capability         ❌ ≠ Tool Execution                             Phase 4
Capability         ❌ Validator 不阻断注入（warn-only）             Phase 4
State Machine      ❌ canTransition warn-only, 不改变控制流         Phase 7 STBL-01
stepCount          ❌ 有界整数，非 reasoning trace                  Phase 6
historicalResults  ❌ append-only                                  Phase 6
Revision           ❌ revision.value++ 显式递增                     Phase 2 起
```

---

## 4. 当前未解决技术债务

### P0

| 债务 | 位置 | 影响 |
|------|------|------|
| `execution.completedAt` 使用 `new Date().toISOString()` 而非 `now()` | `src/stores/runtime.ts:303` | 两个时间源，mock 测试需统一 |
| canTransition 仅 warn 不阻断 | `src/stores/runtime.ts:285-287,299-301,320-322` | 非法状态不会引发异常 |

### P1

| 债务 | 位置 | 影响 |
|------|------|------|
| `recalcSize` 每次 mutation 都调用 | `src/services/contextManager.ts:248-270` | 高频 mutation 时性能开销 |
| Timeline 无自动 prune | `src/services/runtime/timelineStore.ts` | 长时间运行内存膨胀 |
| `updateLayer()` 使用 4 处 `as unknown as` 类型断言 | `src/services/contextManager.ts:178-191` | 类型不安全 |
| ExecutionState 'idle' 从未达到 | `src/types/execution.ts:13` | idle 状态未验证 |

### P2

| 债务 | 描述 |
|------|------|
| RuntimeLogger 仍委托 console | 缺乏日志级别过滤/轮转/文件输出 |
| CapabilityRegistry 不支持动态注册 | 当前仅内置 18 项硬编码 |
| skillLoader.sanitizeSkillId 安全检测 | Phase 3.1 补丁，无测试覆盖 |
| Task 与 TaskLayer 字段冗余 | taskId/taskType 在两个层级重复 |

---

## 5. Persistence Runtime Analyze 结论

### 定位

```
Persistence Runtime = Runtime Snapshot Persistence
不是：ORM / Database / Event Sourcing / Reactive Sync / Auto-save Watch
```

### 架构

4 个新增文件，2 个文件最小修改：

```
新增:
  src/types/persistence.ts                    ← Context/Timeline/Memory Snapshot 类型
  src/services/runtime/contextSerializer.ts   ← RuntimeContext ↔ ContextSnapshot
  src/services/runtime/timelineSerializer.ts  ← RuntimeEvent[] ↔ TimelineSnapshot
  src/services/runtime/persistenceRuntime.ts  ← saveContext/saveAll/loadContexts/loadTimeline

修改（最小）:
  src/stores/runtime.ts                       ← +restoreRuntime() 公开方法
  src/App.vue 或 src/main.ts                  ← +shutdown save
```

### 存储

```
$APP_DATA/.hexclaw/runtime/
├── contexts/         ← ctx-{taskId}-{timestamp}.json
├── timelines/        ← timeline-{timestamp}.json
├── memories/         ← mem-{taskId}-{timestamp}.json
└── manifest.json     ← 快照清单
```

### 红线

不修改现有 Runtime Layer 结构、不修改 RuntimeContext/RuntimeEvent 类型、
不引入数据库/ORM/Event Sourcing、不引入 auto-save watch/reactive persistence。

### 实施任务

| ID | 任务 | Wave | 依赖 |
|----|------|------|------|
| PERS-01 | Snapshot 类型定义 | 1 | — |
| PERS-02 | ContextSerializer | 1 | — |
| PERS-03 | TimelineSerializer | 1 | — |
| PERS-04 | PersistenceRuntime | 2 | PERS-01/02/03 |
| PERS-05 | RuntimeStore Restore 集成 | 3 | PERS-04 |
| PERS-06 | App Shutdown Save | 3 | PERS-04 |

---

## 6. 下一步待执行

### Persistence Runtime Plan 修正版

Phase 8 实施前需明确的修正点：

1. **Snapshot 命名约定** — `ctx-{taskId}-{timestamp}.json` 中 taskId 含特殊字符（如 UUID 带横线）是否 safe？需 URL-safe base64 或 hash。
   - 建议：`ctx-{safeTaskId}.json`，safeTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, '_')

2. **写原子性** — 所有写入必须先写 `.{name}.tmp` 再 `rename`，防止写入中断导致快照损坏。
   - Tauri v2 `writeTextFile` 无原子 rename API，需在 `contextSerializer.ts` 中通过 `writeTextFile(tmp)` + `renameFile(tmp, target)` 实现。

3. **快照清理策略** — 不应无限积累快照文件。
   - 默认保留 5 个最近快照
   - 但 Phase 8 最小实现不做自动清理（留到 Persistence Phase 2）

4. **Timeline 快照切割** — 1000 事件上限时，多次保存形成多个 timeline-{ts}.json。
   - 恢复时加载最新 timeline-{ts}.json，不合并历史
   - Timeline = 状态历史快照，不是重放源

5. **restoreRuntime 不自动调用** — 不在 RuntimeStore 初始化时自动恢复。
   - 改为应用启动后 UI 层决定是否恢复（通过 `runtimeStore.restoreRuntime()` 显式调用）

### 执行顺序

```
Wave 1 ─── PERS-01 + PERS-02 + PERS-03（并行）
Wave 2 ─── PERS-04（依赖 Wave 1）
Wave 3 ─── PERS-05 + PERS-06（依赖 Wave 2）
```

---

## 7. 当前绝对禁止误入

以下能力不在 Runtime Kernel v0.1 范围内，任何后续开发均不应误入：

```
禁止项                   禁止理由                                   预期引入时机
─────────────────────┼──────────────────────────────────────────┼────────────────────
Workflow             多步骤编排，非单 Task 线性执行                 未来独立 Phase
DAG                  依赖图/拓扑排序，非线性执行                    未来独立 Phase
Tool Runtime         Tool 执行/编排，非 Runtime 状态转换           未来独立 Phase
Browser Agent        浏览器自动化，非 Runtime 核心                  未来独立 Phase
Multi-Agent          多 Agent 协作，非单 Task 闭环                 未来独立 Phase
Event Bus            Pub/Sub 消息总线，非状态历史                   不应引入
Reactive Runtime    隐式副作用/auto-derivation                     不应引入
Scheduler/Retry Queue 定时/重试编排                                 未来独立 Phase
MCP Runtime          MCP 协议执行层                                 未来独立 Phase
UnifiedExecutor      过度抽象，违背 adapter shell 模式              不应引入
Context Persistence  PersistenceRuntime Analyze 已定义边界          正在 Plan
Auto-save Watch      违背显式 mutation 设计                         不应引入
```

---

## 8. 当前项目状态是否稳定可暂停

### 结论：**是，稳定可暂停**

### 判定依据

| 维度 | 状态 | 说明 |
|------|------|------|
| Phase 1-7 全部完成 | ✓ | 无进行中的 Phase，无未合并的代码变更 |
| 所有任务已关闭 | ✓ | 无 open task，无待办事项 |
| TypeScript 编译 | ✓ 零错误 | `tsc --noEmit` 通过 |
| 核心闭环完整 | ✓ | Task→Context→Skill→Capability→Execution→Timeline→Memory |
| 红线约束可验证 | ✓ | 19 条红线清晰可审计 |
| 技术债务已分类 | ✓ | P0/P1/P2 三级，不影响主线功能 |
| 下一阶段已分析 | ✓ | Persistence Runtime Analyze 完成，有 Plan 可以接续 |
| 无 runtime 行为异常 | ✓ | canTransition warn-only, 不阻断; 无 watch 副作用 |

### 暂停后恢复路径

```
暂停 → 任意时长 → 恢复

恢复步骤：
  1. 阅读 .workflow/.scratchpad/runtime-kernel-checkpoint-20260511.md
  2. 阅读 .workflow/.scratchpad/runtime-kernel-v0.1-architecture-snapshot.md
  3. 阅读 .workflow/.scratchpad/persistence-runtime-skeleton-analyze.md
  4. 执行 Persistence Runtime Plan Wave 1
```

### 重新接续时的关注点

- P0 债务（两个时间源 / canTransition warn-only）可先解决也可搁置
- Persistence Runtime 后续可根据需要选择 Asset Runtime Skeleton 或 Capability Runtime Phase 2
- `new Date().toISOString()` 在 `runtime.ts:303` 不应被 `now()` 替代（now 在 taskExecutor.ts 中，职责不同）
