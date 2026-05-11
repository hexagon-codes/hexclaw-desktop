# Runtime Kernel v0.1 Architecture Snapshot

> 生成日期：2026-05-11
> 对应 Phase 1-7 完成状态

---

## 1. Phase 1-7 已完成能力清单

### Phase 1 — Task Runtime

| 能力 | 文件 | 状态 |
|------|------|------|
| Task 类型系统（TaskType/TaskStatus/TaskInput/TaskOutput） | `src/types/task.ts` | ✓ |
| Task 生命周期：pending → running → completed/failed/cancelled | `src/types/task.ts` | ✓ |
| CronJob 定时任务类型 | `src/types/task.ts` | ✓ |
| TaskError 错误类型 | `src/types/task.ts` | ✓ |
| Task 隔离（同 taskId 不覆盖） | `src/services/contextManager.ts:60-62` | ✓ |

### Phase 2 — Context Runtime

| 能力 | 文件 | 状态 |
|------|------|------|
| RuntimeContext 5 层聚合根（System/Skill/Task/Execution/Memory） | `src/types/context.ts:142-161` | ✓ |
| ContextManager（Map 所有权，无 watch） | `src/services/contextManager.ts` | ✓ |
| ContextLoader（Task→TaskLayer 深拷贝投影） | `src/services/contextLoader.ts` | ✓ |
| ContextLayerStatus 4 态（unloaded/loading/loaded/error） | `src/types/context.ts:17` | ✓ |
| Context 摘要（UI 消费） | `src/types/context.ts:166-174` | ✓ |
| RuntimeStore（Pinia store，revision ref 桥接响应式） | `src/stores/runtime.ts` | ✓ |

### Phase 3 — Skill Runtime

| 能力 | 文件 | 状态 |
|------|------|------|
| SkillRegistry（Lazy init + Map 缓存） | `src/services/skillRegistry.ts` | ✓ |
| SkillLoader（skill.json + SKILL.md + references） | `src/services/skillLoader.ts` | ✓ |
| SkillPackage 类型 | `src/types/context.ts:39-44` | ✓ |
| SkillMeta 类型 | `src/types/context.ts:22-30` | ✓ |
| Skill Layer 注入 | `src/services/contextLoader.ts:147-161` | ✓ |
| Skill 加载 Timeline 事件 | `src/stores/runtime.ts` | ✓ |

### Phase 4 — Governance Runtime

| 能力 | 文件 | 状态 |
|------|------|------|
| RuntimeBudget（maxContextSize/maxLayers） | `src/types/runtimeBudget.ts` | ✓ |
| Capability 类型系统（CapabilityName=string） | `src/types/capability.ts` | ✓ |
| CapabilityDescriptor + BUILTIN_CAPABILITIES（18 项） | `src/types/capability.ts:21-40` | ✓ |
| CapabilityRegistry（声明式注册表） | `src/services/capabilityRegistry.ts` | ✓ |
| CapabilityValidator（3 规则链） | `src/services/capabilityValidator.ts` | ✓ |
| RuntimeLogger（console 委托抽象） | `src/services/runtime/runtimeLogger.ts` | ✓ |
| RuntimeServices（服务定位器，防 God Object） | `src/services/runtime/runtimeServices.ts` | ✓ |
| sizeEstimator（统一 JSON.stringify 估算） | `src/utils/sizeEstimator.ts` | ✓ |
| Budget 报警（warn-only，不阻断） | `src/services/contextManager.ts` | ✓ |
| DEFAULT_ALLOWED_CAPABILITIES 单一来源 | `src/types/capability.ts:46-51` | ✓ |

### Phase 5 — Timeline Runtime

| 能力 | 文件 | 状态 |
|------|------|------|
| RuntimeEvent 类型（id/type/taskId/timestamp/payload） | `src/types/timeline.ts:71-84` | ✓ |
| RuntimeEventType（14 种状态转换事件） | `src/types/timeline.ts:21-51` | ✓ |
| TimelineStore（append-only O(1)，返回副本） | `src/services/runtime/timelineStore.ts` | ✓ |
| TimelineProjection（4 只读查询函数） | `src/services/runtime/timelineProjection.ts` | ✓ |
| MAX_TIMELINE_EVENTS 硬上限（1000） | `src/types/timeline.ts:16` | ✓ |
| TimelineFilter 查询过滤 | `src/types/timeline.ts:89-96` | ✓ |
| RuntimeEventPayload 轻量约束（无嵌套对象） | `src/types/timeline.ts:61-66` | ✓ |
| writeTimelineEvent 集中方法 | `src/stores/runtime.ts:395-397` | ✓ |

### Phase 6 — Execution Runtime

| 能力 | 文件 | 状态 |
|------|------|------|
| ExecutionState 5 态（idle/preparing/running/completed/failed） | `src/types/execution.ts:13` | ✓ |
| ExecutionStage 有限枚举（preparing/executing/finalizing） | `src/types/execution.ts:16` | ✓ |
| EXECUTION_TRANSITIONS 转换表 | `src/types/execution.ts:21-27` | ✓ |
| canTransition 状态转换校验 | `src/types/execution.ts:30-32` | ✓ |
| ContextAwareExecutor + executeWithContext | `src/services/taskExecutor.ts:32-35` | ✓ |
| executeTask 完整闭环（resolve→prepare→run→complete/fail） | `src/stores/runtime.ts:273-348` | ✓ |
| 3 种 Executor Adapter Shell（Chat/Agent/Skill） | `src/services/taskExecutor.ts` | ✓ |
| Execution Layer 状态机写入 | `src/services/contextLoader.ts:72-81` | ✓ |
| Memory Layer 写入（append-only） | `src/services/contextLoader.ts:87-105` | ✓ |

### Phase 7 — Runtime Stabilization

| 能力 | 文件 | 状态 |
|------|------|------|
| canTransition warn-only 注入（不阻断控制流） | `src/stores/runtime.ts:285-287,299-301,320-322` | ✓ |
| completeContextForTask/failContextForTask 同步 execution.state | `src/stores/runtime.ts:109-111,129-131` | ✓ |
| DEFAULT_ALLOWED_CAPABILITIES 单一来源 | `src/types/capability.ts:46-51` | ✓ |
| writeTimelineEvent 集中方法替换 18+ 处 append | `src/stores/runtime.ts:395-397` | ✓ |
| now() + stubExecuteWithContext 提取 | `src/services/taskExecutor.ts:136-151` | ✓ |

---

## 2. 当前 Runtime 主链

```
Task
  │  TaskRuntime (Phase 1)
  │  registerContextForTask(task)
  ▼
Context (5-Layer)
  │  ContextRuntime (Phase 2)
  │  ContextManager.createContext()
  │  ContextLoader.loadSystemLayer() / loadTaskLayer()
  ▼
Skill
  │  SkillRuntime (Phase 3)
  │  SkillLoader.loadSkill()
  │  ContextLoader.loadSkillLayer()
  ▼
Capability Validation
  │  GovernanceRuntime (Phase 4)
  │  CapabilityValidator.validate()
  │  (warn-only, 不阻断注入)
  ▼
Execution (State Machine)
  │  ExecutionRuntime (Phase 6)
  │  prepareExecutionLayer → state=running
  │  executor.executeWithContext() → state=completed/failed
  │  canTransition() 校验 (warn-only)
  ▼
Timeline Events
  │  TimelineRuntime (Phase 5)
  │  writeTimelineEvent() → TimelineStore.append()
  │  14 种 RuntimeEventType
  ▼
Memory Write
  │  writeExecutionMemory() → MemoryLayer.historicalResults[]
  │  (append-only, concise)
  │
  ▼
Result
```

### 完整执行闭环 (`executeTask`)：

```
executeTask(taskId)
  │
  ├─ 1. resolveExecutor(taskType) → ChatTaskExecutor | AgentTaskExecutor | SkillTaskExecutor
  ├─ 2. prepareExecutionLayer(ctx) → state='preparing'
  │     writeTimelineEvent('execution.prepared')
  ├─ 3. canTransition('preparing','running')? → warn / continue
  │     ctx.execution.state = 'running'
  │     writeTimelineEvent('execution.started')
  ├─ 4. executor.executeWithContext(task, ctx)
  │     stepCount++ / currentStage='executing' / progress=1
  ├─ 5. success:
  │     canTransition('running','completed')? → warn / continue
  │     state='completed' / currentStage='finalizing'
  │     writeExecutionMemory() → memory.historicalResults.push()
  │     writeTimelineEvent('execution.completed'|'task.completed'|'memory.updated')
  └─ 6. failure:
        canTransition('running','failed')? → warn / continue
        state='failed' / currentStage='finalizing' / error={code,message}
        writeExecutionMemory()
        writeTimelineEvent('execution.failed'|'task.failed')
```

---

## 3. 关键文件索引

### 类型定义

| 文件 | 核心导出 | 职责 |
|------|----------|------|
| `src/types/task.ts` | Task, TaskType, TaskStatus, TaskInput, TaskOutput, TaskError, CronJob | Task 领域模型 |
| `src/types/context.ts` | RuntimeContext, SystemLayer, SkillLayer, TaskLayer, ExecutionLayer, MemoryLayer, ContextSummary, SkillPackage | 5 层 Context 聚合根 |
| `src/types/execution.ts` | ExecutionState, ExecutionStage, EXECUTION_TRANSITIONS, canTransition | Execution 状态机 |
| `src/types/timeline.ts` | RuntimeEvent, RuntimeEventType, RuntimeEventPayload, TimelineFilter, MAX_TIMELINE_EVENTS | Timeline 事件类型 |
| `src/types/capability.ts` | CapabilityName, CapabilityDescriptor, BUILTIN_CAPABILITIES, DEFAULT_ALLOWED_CAPABILITIES | Capability 声明系统 |
| `src/types/runtimeBudget.ts` | RuntimeBudget, DEFAULT_BUDGET | 资源预算约束 |

### 服务层

| 文件 | 核心类/导出 | 职责 |
|------|------------|------|
| `src/services/contextManager.ts` | ContextManager | Context 创建/销毁/层生命周期/所有权 |
| `src/services/contextLoader.ts` | ContextLoader | 层数据加载/投影/卸载/内存写入 |
| `src/services/skillRegistry.ts` | SkillRegistry | Skill 元数据发现与缓存 |
| `src/services/skillLoader.ts` | SkillLoader | Skill 文件加载（JSON+MD+refs） |
| `src/services/taskExecutor.ts` | ChatTaskExecutor, AgentTaskExecutor, SkillTaskExecutor, stubExecuteWithContext, now | 3 种 Executor Adapter Shell |
| `src/services/capabilityRegistry.ts` | CapabilityRegistry | Capability 注册表 Lazy init |
| `src/services/capabilityValidator.ts` | CapabilityValidator | 3 规则验证链 |
| `src/services/runtime/timelineStore.ts` | TimelineStore | Append-only 事件流 |
| `src/services/runtime/timelineProjection.ts` | taskTimeline, recentEvents, eventsByType, eventsInRange | 只读查询工具 |
| `src/services/runtime/runtimeLogger.ts` | getRuntimeLogger, RuntimeLogger | 日志抽象 |
| `src/services/runtime/runtimeServices.ts` | getRuntimeServices, RuntimeServiceContainer | 服务定位器 |

### Store 层

| 文件 | 核心导出 | 职责 |
|------|----------|------|
| `src/stores/runtime.ts` | useRuntimeStore | Runtime 总入口：Context/Execution/Timeline/Write 方法 |
| `src/stores/tasks.ts` | useTaskStore | Task 状态管理 |

### 工具

| 文件 | 核心导出 | 职责 |
|------|----------|------|
| `src/utils/sizeEstimator.ts` | estimateSize | JSON.stringify 大小估算 |

---

## 4. 各模块职责边界

### ContextManager (`src/services/contextManager.ts`)

```
职责范围              │ 不做
──────────────────────┼────────────────────────
- Context 创建/销毁    │ - 层数据加载（委托 ContextLoader）
- Map 所有权           │ - Timeline 事件（回调通知 RuntimeStore）
- recalcSize/预算检查  │ - Budget.warning 发出（回调 RuntimeStore）
- 层生命周期（load/unload/updateLayer） │ - 自动绑定/watch
                      │ - Context 持久化
```

### ContextLoader (`src/services/contextLoader.ts`)

```
职责范围              │ 不做
──────────────────────┼────────────────────────
- Task→TaskLayer 投影  │ - 异步 IO
- System Layer 初始化  │ - Context 销毁
- Skill Layer 注入     │ - 执行编排
- Execution Layer 准备 │ - Watch 自动绑定
- Memory Layer 写入    │ - Skill 文件读取（委托 SkillLoader）
- 层卸载               │
```

### TaskExecutor (`src/services/taskExecutor.ts`)

```
职责范围              │ 不做
──────────────────────┼────────────────────────
- execute(task) 返回  │ - 直接调用 chatService / API
  TaskOutput           │ - append timeline event
- executeWithContext   │ - mutate RuntimeStore
  (task, context)      │ - create/destroy context
- cancel(taskId)       │ - nested executeTask
- getStatus(taskId)    │ - recursive execution
                       │ - task spawning
```

### TimelineStore (`src/services/runtime/timelineStore.ts`)

```
职责范围              │ 不做
──────────────────────┼────────────────────────
- Append-only O(1)    │ - Event Bus
- query/getAll 返副本  │ - Telemetry Pipeline
- manual prune        │ - Auto-prune
- clear               │ - Tool Trace
                      │ - 动态 Projection 注册
```

### CapabilityValidator (`src/services/capabilityValidator.ts`)

```
职责范围              │ 不做
──────────────────────┼────────────────────────
- 3 规则验证链         │ - Capability 存在性（委托 Registry）
  (unknown→unauthorized→denied)│ - 阻断注入
                      │ - Auto-inference
                      │ - Dependency DAG
```

### RuntimeStore (`src/stores/runtime.ts`)

```
职责范围              │ 不做
──────────────────────┼────────────────────────
- Context 注册/更新    │ - 直接 new 服务（通过 runtimeServices）
- Skill 注入 + 验证    │ - Watch 自动绑定
- 执行闭环 executeTask │ - Timeline auto-derivation
- Timeline 查询       │ - Reactive event system
- writeTimelineEvent  │ - Event bus
- revision 递增触发   │ - 直接操作 ContextManager 内部
  computed 重新求值    │
```

---

## 5. 当前红线约束

```
红线                                                  │ 来源
──────────────────────────────────────────────────────┼────────────────
❌ No watch 自动绑定 TaskStore/Timeline               │ Phase 2 起全线
❌ No nested executeTask                              │ Phase 6 execute
❌ No recursive execution                             │ Phase 6 execute
❌ No task spawning / subtask creation                │ Phase 6 execute
❌ Executor 不能 append timeline event                │ Phase 6 contract
❌ Executor 不能 mutate RuntimeStore                  │ Phase 6 contract
❌ Executor 不能 create/destroy context               │ Phase 6 contract
❌ Execution Runtime ≠ Tool Runtime                   │ Phase 6
❌ Execution Runtime ≠ Agent Framework                │ Phase 6
❌ Timeline ≠ Event Bus                               │ Phase 5
❌ Timeline ≠ Telemetry Pipeline                      │ Phase 5
❌ Timeline ≠ Tool Trace                              │ Phase 5
❌ Timeline ≠ Browser Action Log                      │ Phase 5
❌ Capability ≠ Tool Execution                        │ Phase 4
❌ CapabilityValidator 不阻断注入                     │ Phase 4
❌ canTransition warn-only, 不改变控制流              │ Phase 7 STBL-01 修正
❌ Timeline 事件不做 auto-derivation                  │ Phase 7 方向修正
❌ Event payload.metadata 禁止嵌套对象                 │ Phase 5
❌ stepCount 有界整数，非 reasoning trace              │ Phase 6
❌ historicalResults append-only                      │ Phase 6
```

---

## 6. 明确禁止后续误入

以下能力在 Phase 1-7 范围外，**不是** Runtime Kernel v0.1 的一部分，后续不应误入：

| 能力 | 原因 | 期望时机 |
|------|------|----------|
| ❌ **Workflow** | 多步骤编排，不是单 Task 执行 | 未来独立 Phase |
| ❌ **DAG** | 依赖图/拓扑排序，不是线性执行 | 未来独立 Phase |
| ❌ **Tool Runtime** | Tool 执行/编排，不是状态转换 | 未来独立 Phase |
| ❌ **Browser Agent** | 浏览器自动化，不是 Runtime 核心 | 未来独立 Phase |
| ❌ **Multi-Agent** | 多 Agent 协作，不是单 Task 闭环 | 未来独立 Phase |
| ❌ **Event Bus** | Pub/Sub 消息总线，不是状态历史 | 不应有 |
| ❌ **Reactive Runtime Engine** | 隐式副作用/auto-derivation，违背显式 mutation 设计 | 不应有 |
| ❌ **Scheduler/Retry Queue** | 定时/重试编排 | 未来独立 Phase |
| ❌ **MCP Runtime** | MCP 协议执行 | 未来独立 Phase |
| ❌ **UnifiedExecutor** | 过度抽象，违背 adapter shell 模式 | 不应有 |
| ❌ **Context Persistence** | Context 序列化/磁盘持久化 | 未来独立 Phase |
| ❌ **Timeline Event hook/plugin** | 动态事件处理注册 | 不应有 |

---

## 7. 当前技术债务

### P0 — 需优先解决

| 债务 | 描述 | 涉及文件 | 影响 |
|------|------|----------|------|
| `execution.completedAt` 时间源不统一 | executeTask 成功路径使用 `new Date().toISOString()` 而非 `now()` | `src/stores/runtime.ts:303` | 两个时间源，如未来需 mock 测试则需统一 |
| canTransition 仅 warn 不阻断 | Phase 7 明确不阻断控制流，但 Phase 8 可能需可配置 strict mode | `src/stores/runtime.ts:285-287,299-301,320-322` | 非法状态不会引发异常 |

### P1 — 应规划解决

| 债务 | 描述 | 涉及文件 | 影响 |
|------|------|----------|------|
| ContextManager `recalcSize` 每次 mutation 都调用 | 频繁全量序列化计算 | `src/services/contextManager.ts:248-270` | 高频 mutation 时性能开销 |
| Timeline 无自动 prune | 记忆体只增不减 | `src/services/runtime/timelineStore.ts` | 长时间运行内存膨胀 |
| `contextManager.updateLayer()` 使用 `as` 类型断言 | 4 处 `as unknown as` | `src/services/contextManager.ts:178-191` | 类型不安全 |
| ExecutionState 'idle' 在 Context 中从未达到 | prepareExecutionLayer 直接从 preparing 开始 | `src/types/execution.ts:13` | 'idle' 状态未验证 |

### P2 — 可长期跟进

| 债务 | 描述 |
|------|------|
| RuntimeLogger 仍委托 console | 缺乏日志级别过滤/轮转/文件输出 |
| CapabilityRegistry 不支持动态注册 | 当前仅内置 18 项硬编码 |
| skillLoader.sanitizeSkillId 安全检测 | Phase 3.1 补丁，未做安全测试覆盖 |
| Task 与 TaskLayer 间存在字段冗余 | taskId/taskType 在两个层级重复 |

---

## 8. 下一阶段建议

### 方案 A：Persistence Runtime Skeleton（推荐）

将 RuntimeContext 持久化到本地磁盘，支持会话恢复。

```
核心问题：
  当前所有 Context 纯内存，应用关闭即丢失

范围：
  - Context 序列化 Protocol（JSON → .hexclaw/contexts/）
  - Context 反序列化恢复
  - 断线重连时 Context 重建
  - 非：Context 版本历史 / 增量同步

红线：
  - 不修改现有 Context 5 层结构
  - 不引入 ORM / 数据库
  - 序列化 ≠ Memory Runtime
```

### 方案 B：Asset Runtime Skeleton

管理 Task 产出的文件资产（图片/视频/文档），建立资产生命周期。

```
核心问题：
  当前 Task 产出 {result, artifacts[]} 无资产管理

范围：
  - Asset 类型定义（路径/MIME/大小/来源 Task）
  - Asset Layer 作为 Context 第 6 层
  - Asset 注册 + 生命周期（create/read/delete）
  - 非：Asset 预览 / 版本控制 / 云端同步

红线：
  - 不修改现有 5 层结构（新增第 6 层）
  - 不接入 Tauri asset API
  - Asset ≠ File Manager
```

### 方案 C：Capability Runtime Phase 2

将 Capability 从 warn-only 升级为可阻断的 Policy Engine。

```
核心问题：
  当前 CapabilityValidator 不阻断注入，warn 但不拦截

范围：
  - Capability Policy 可配置（strict/permissive 模式）
  - strict 模式下阻断未授权 Skill 注入
  - Policy 持久化加载（runtimeServices → system policy）
  - 非：Capability auto-inference / DAG / 动态注册

红线：
  - 不改变 Phase 4 validate 接口签名
  - Policy 变化通过 runtimeServices 传播
  - non-breaking: 默认 permissive 兼容 Phase 4 行为
```

### 优先级建议

```
1. Persistence Runtime Skeleton
   理由：纯内存 Runtime 无法支撑真实会话恢复

2. Capability Runtime Phase 2
   理由：warn-only 验证在安全场景不足

3. Asset Runtime Skeleton
   理由：依赖 Persistence 就绪后更有意义
```
