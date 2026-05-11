# HexClaw Desktop — Context Runtime Phase 2 分析报告

> 生成日期: 2026-05-11
> 状态: Analyze / Plan (代码未修改)
> 目标: 建立 Context Runtime，使 Task 从"任务队列"进化为 Runtime Execution Unit

---

## 一、Phase 1 回顾

### 已交付

| 文件 | 职责 | 状态 |
|------|------|------|
| `src/types/task.ts` | Task 核心类型 (Task, TaskInput, TaskOutput, TaskStatus, TaskType) | ✅ 已交付 |
| `src/stores/tasks.ts` | Task Pinia store (入队/出队/生命周期/activeCount) | ✅ 已交付 |
| `src/services/taskExecutor.ts` | Executor 接口 + ChatTaskExecutor / AgentTaskExecutor / SkillTaskExecutor adapter shells | ✅ 已交付 |
| `src/stores/chat-send-controller.ts` | ChatTask 生命周期注入 (enqueue → complete/fail/cancel) | ✅ 已交付 |
| `src/components/runtime/TaskMonitorPanel.vue` | 运行时监控面板 (active/completed/type icon/status/elapsed/cancel) | ✅ 已交付 |
| `src/views/RuntimeView.vue` | /runtime 页面包装 | ✅ 已交付 |
| `src/config/navigation.ts` | /runtime 导航项 (Activity 图标) | ✅ 已交付 |
| `src/router/index.ts` | runtime → RuntimeView.vue 路由 | ✅ 已交付 |
| `src/i18n/locales/*.ts` | nav.runtime 翻译 (zh/en/ug) | ✅ 已交付 |
| `src/components/layout/Sidebar.vue` | 活性任务数 badge (activeCount) | ✅ 已交付 |

### Phase 1 缺陷

- **Task 接口缺失闭合括号** (`src/types/task.ts:57`): `dependencies?: string[]` 后直接 `export interface CronJob {`，缺少 `}`。需修复。

### Phase 1 未覆盖

| 维度 | Phase 1 | Phase 2 需补充 |
|------|---------|---------------|
| Context | 无 — Task 只是队列中的条目 | 每个 Task 拥有独立分层 Context |
| Task 隔离 | 无 — 所有 Task 共享 store | 每个 Task 拥有隔离的 Context 边界 |
| 分层 | 无 — 数据扁平 | 5 层: System / Skill / Task / Execution / Memory |
| Progressive Loading | 无 — 全量加载 | 按需加载，当前需要什么加载什么 |
| 内存控制 | 无 — 无限增长 | 层大小限制 + 卸载策略 |
| Skill 绑定 | 无 — Executor 是空壳 | Executor 接收 Context |

---

## 二、Phase 1 → Context Runtime 衔接点分析

### 衔接点 1: Task 类型 → System/Task Layer

```
Task 接口                    →  Task Layer 的核心负载
  .id                        →  TaskLayer.taskId
  .type                      →  TaskLayer.taskType  
  .status                    →  TaskLayer.status
  .input / .output           →  TaskLayer.input / .output
  .progress                  →  TaskLayer.progress
  .error                     →  TaskLayer.error
  .metadata                  →  TaskLayer.metadata
  .parentId / .dependencies  →  TaskLayer.parentId / .dependencies
```

**关系**: Task Layer 是 Task 在 Runtime Context 中的投影。不是替代关系——Task 存在 store 中用于调度，Task Layer 存在 Context 中用于执行。

### 衔接点 2: Task Store → Runtime Store

```
useTaskStore                  →  useRuntimeStore (新建)
  .activeTasks                →  .activeContexts (每个 active task 对应一个 context)
  .enqueue(task)              →  .registerContext(taskId, taskType)
  .startTask(id)              →  .loadLayer(id, 'task') + .loadLayer(id, 'system')
  .completeTask(id, output)   →  .unloadLayer(id, 'execution') + .persistLayer(id, 'memory')
  .failTask(id, error)        →  .setLayerError(id, 'task', error)
  .cancelTask(id)             →  .destroyContext(id)
  .activeCount                →  .activeContextCount
```

**关系**: Runtime Store 监控 Task Store 的生命周期事件来自动管理 Context。不是替代——Task Store 继续负责任务调度队列。

### 衔接点 3: TaskExecutor → Context-aware Executor

```
TaskExecutor               →  ContextAwareTaskExecutor
  execute(task)            →  execute(task, context)
  cancel(taskId)           →  cancel(taskId, context)
  getStatus(taskId)        →  getStatus(taskId, context)
```

**关系**: Phase 2 扩展 Executor 接口接收 Context 参数。ChatTaskExecutor 等实现类在 Phase 2 仍为 adapter shell，不接入真实执行。

### 衔接点 4: ChatTask 注入 → Context 自动绑定

```
chat-send-controller.ts
  $taskStore.enqueue($chatTask)      →  $runtimeStore.registerContext($taskId, 'chat')
  $taskStore.completeTask(...)       →  $runtimeStore.persistAndCleanup(...)
  $taskStore.failTask(...)           →  $runtimeStore.destroyContext(...)
```

**关系**: Phase 2 在 Runtime Store 中监听 Task Store 变化来自动绑定 Context，不修改 chat-send-controller.ts 中的注入代码。

### 衔接点 5: TaskMonitorPanel → Context 可观测性

```
TaskMonitorPanel                   →  可扩展为展示 Context Layer 状态
  展示 activeTasks / completed      →  新增 "活跃 Context" 视图
  类型图标 / 状态 / 耗时            →  新增 Layer 加载状态 / 大小
```

**关系**: Phase 2 不修改 UI。但 Context 数据结构应为未来 UI 展示预留接口 (layerStatus, loadedLayers 等)。

---

## 三、Context Runtime 模块映射

```
src/
├── types/
│   ├── task.ts                    ← 已有 (Phase 1)
│   └── context.ts                 ← 新增 (Phase 2)
│       ├── ContextLayerStatus     — 'loading' | 'loaded' | 'unloaded' | 'error'
│       ├── SystemLayer            — runtimePolicy, constraints, capabilities[]
│       ├── SkillLayer             — skillId, skillName, workflow, rules, references
│       ├── TaskLayer              — taskId, taskType, status, input, output, progress, error, metadata
│       ├── ExecutionLayer         — toolResults[], intermediateState[], currentAction
│       ├── MemoryLayer            — userConfirmations[], historicalResults[], generatedAssets[]
│       ├── RuntimeContext         — 聚合: taskId + 5 layers + layerStates + metadata
│       └── ContextSummary         — UI 消费用的轻量摘要 (loadedLayers[], taskIcon, status)
│
├── services/
│   ├── taskExecutor.ts            ← 已有 (Phase 1, Phase 2 扩展接口)
│   ├── contextManager.ts          ← 新增 (Phase 2)
│   │   ├── createContext()        — 创建新 Context + 初始化 System Layer
│   │   ├── destroyContext()       — 销毁 Context + 清理
│   │   ├── getContext()           — 按 taskId 获取
│   │   ├── loadLayer()            — 按需加载指定层
│   │   ├── unloadLayer()          — 卸载指定层
│   │   ├── updateLayer()          — 更新层数据
│   │   ├── getLayer()             — 获取层内容
│   │   └── isLayerLoaded()        — 检查层状态
│   │
│   └── contextLoader.ts           ← 新增 (Phase 2)
│       ├── loadTaskLayer()        — 从 Task 投影到 Task Layer
│       ├── loadSystemLayer()      — 初始化 System Layer
│       ├── loadExecutionLayer()   — 准备 Execution Layer (惰性)
│       ├── loadMemoryLayer()      — 加载 Task Memory (惰性)
│       ├── loadSkillLayer()       — 加载 Skill 元数据 (惰性, 为 Phase 3 预留)
│       └── unloadStaleLayers()    — 卸载不再需要的层
│
├── stores/
│   ├── tasks.ts                   ← 已有 (Phase 1, 不修改)
│   └── runtime.ts                 ← 新增 (Phase 2)
│       ├── activeContexts         — Ref<Map<string, RuntimeContext>>
│       ├── contextSummary         — 活性 Context 摘要列表 (Computed)
│       ├── registerContext()      — 监听 TaskStore.enqueue 自动创建 Context
│       ├── unregisterContext()    — 监听 TaskStore.complete/fail/cancel 自动销毁
│       ├── getContextSummary()    — UI 消费接口
│       └── loadLayer()            — 委托给 contextManager
│
├── composables/
│   └── useContextRuntime.ts       ← 新增 (Phase 2)
│       ├── useActiveContext()     — 获取指定 Task 的 Context
│       ├── useContextLayers()     — 获取指定 Context 的加载状态
│       └── useContextSummary()    — 活性 Context 摘要
│
└── components/
    └── runtime/
        └── TaskMonitorPanel.vue   ← 已有 (不修改)
        └── (ContextLayerIndicator 等 UI 组件暂不创建)
```

---

## 四、Context Layer 数据结构设计

### 4.1 层状态枚举

```typescript
export type ContextLayerStatus = 'unloaded' | 'loading' | 'loaded' | 'error'
```

### 4.2 System Layer

```typescript
export interface SystemLayer {
  policy: {
    maxExecutionSteps?: number
    maxToolCalls?: number
    timeout?: number           // ms
    allowedCapabilities: string[]  // P0: ['llm', 'image_generation', 'filesystem.read']
    deniedCapabilities: string[]
  }
  constraints: string[]        // 系统级约束描述
  runtimeVersion: string
}
```

### 4.3 Skill Layer

```typescript
export interface SkillLayer {
  skillId?: string
  skillName?: string
  skillVersion?: string
  workflow?: string            // SKILL.md workflow section
  rules?: string[]             // SKILL.md rules section
  references?: string[]        // Skill references paths
  capabilities?: string[]      // Skill 声明的能力
}
```

### 4.4 Task Layer

Task Layer 是 Task 在 Context 中的投影，字段与 Task 结构对应但聚焦于执行态：

```typescript
export interface TaskLayer {
  taskId: string
  taskType: TaskType
  status: TaskStatus
  goal: string                 // 从 input 提炼的任务目标
  input: TaskInput
  output?: TaskOutput
  progress?: number
  error?: TaskError
  metadata?: TaskMetadata
  parentId?: string
  dependencies?: string[]
}
```

### 4.5 Execution Layer

```typescript
export interface ExecutionLayer {
  currentAction?: string       // 当前执行动作描述
  toolResults: Array<{
    toolName: string
    input: unknown
    output: unknown
    duration: number
    timestamp: string
  }>
  intermediateState: Record<string, unknown>  // Task 执行产生的中间状态
  stepCount: number
  startedAt?: string
}
```

### 4.6 Memory Layer

```typescript
export interface MemoryLayer {
  userConfirmations: Array<{
    question: string
    answer: string
    timestamp: string
  }>
  historicalResults: Array<{
    step: string
    result: unknown
    timestamp: string
  }>
  generatedAssets: Array<{
    path: string
    type: string
    description: string
  }>
  custom: Record<string, unknown>  // Task 自定义记忆
}
```

### 4.7 RuntimeContext — 聚合根

```typescript
export interface RuntimeContext {
  taskId: string
  taskType: TaskType

  // 5 层 (可能未完全加载)
  system?: SystemLayer
  skill?: SkillLayer
  task?: TaskLayer
  execution?: ExecutionLayer
  memory?: MemoryLayer

  // 层状态管理
  layerStates: Record<string, ContextLayerStatus>  // 'system' | 'skill' | 'task' | 'execution' | 'memory'
  
  // 元数据
  createdAt: string
  updatedAt: string
  totalEstimatedSize: number  // bytes (近似)
}

export interface ContextSummary {
  taskId: string
  taskType: TaskType
  status: TaskStatus
  loadedLayers: string[]
  layerCount: number
  totalSize: number
  createdAt: string
}
```

---

## 五、风险矩阵

| 编号 | 风险 | 等级 | 可能性 | 影响 | 缓解措施 |
|------|------|------|--------|------|---------|
| R1 | **过度抽象** — Context Runtime 成为"第二个 Task Store"，与 useTaskStore 职责重叠 | H | M | 代码冗余、混乱 | Context 不是 store 替代品。Store 管理集合 (tasks[], completed[])，Context 管理单 Task 的分层状态。职责明确分离 |
| R2 | **ChatTask 注入破坏** — 修改 chat-send-controller.ts 导致回归 | H | L | Chat 发送功能瘫痪 | Phase 2 不修改 chat-send-controller.ts。通过 RuntimeStore 监听 TaskStore 事件自动绑定 Context |
| R3 | **Scope 膨胀** — 不自觉接入 Skill/MCP/RAG 执行链路 | H | M | 偏离 Phase 2 目标 | 严格执行边界：Phase 2 = types + services + store。不触碰 sidecar、不接管执行 |
| R4 | **Task 接口未闭合 Bug 被忽略** | M | H | 编译错误 | 在 Phase 2 开始时先修复此 Bug |
| R5 | **Context 无限增长** — 活跃 Task 越来越多，Context 不释放 | M | M | 内存泄漏 | ContextManager 提供 destroyContext() + size limit。UI 侧限定最大活跃 Task 数 |
| R6 | **Progressive Loading 增加复杂度** — 层加载/卸载逻辑超出需要的复杂度 | M | M | 过度设计 | 保持简单：Phase 2 的 Loader 只做基本加载标记。卸载策略可在 Phase 3 再做 |
| R7 | **与未来 Skill Runtime 冲突** — Phase 2 的 Context 结构不适应 Phase 3 的 Skill Context | L | M | 重构 | Skill Layer 设计为纯数据容器 (无执行逻辑)。Phases 3 添加新层即可，不破坏现有结构 |
| R8 | **类型系统膨胀** — context.ts 成为类型大文件 | L | M | 可读性下降 | 每层独立 interface，按需 import。聚合接口 RuntimeContext 只做组合不做继承 |

### 风险响应计划

| 触发条件 | 响应 |
|---------|------|
| R1/R6 发生 (设计膨胀) | 立即缩减 Scope，移除 Progressive Loader，ContextManager 只做 create/destroy/get |
| R3 发生 (偏离路线) | 代码审查拦截。任何修改 sidecar/chat store/MCP/Skill/RAG/Memory 执行链路的 change 都应被标记为违规 |
| R4 未修复 | 修复 Task 接口 Bug 是 Phase 2 Task 0 (前置条件) |
| R5/R7 积累 | 每完成一个 Task 后 grep check，确保无文件超出范围 |

---

## 六、Phase 2 实施计划 — 4 个任务 + 1 个前置修复

### 前置修复: Task 接口缺失闭合括号

| 字段 | 值 |
|------|-----|
| 文件 | `src/types/task.ts` |
| 行号 | 56-57 |
| 修复 | `dependencies?: string[]` 后加 `}` |
| 影响 | 编译修复，无功能变化 |

---

### TASK-CR1: Context 类型系统

| 字段 | 值 |
|------|-----|
| 文件 | `src/types/context.ts` (新建) |
| 依赖 | 前置修复 (Task 接口) |
| Wave | 1 |

**read_first**:
- `src/types/task.ts` — Task 接口 (Task Layer 的投影源)
- `docs/agents-OS/Context-Contract.md` — Context 5 层定义
- `docs/agents-OS/Agent-OS-Runtime-Blueprint-P0.md` — Context Layer 图

**action**: 在 `src/types/context.ts` 中定义 5 层接口 + RuntimeContext 聚合 + ContextSummary 轻量接口。

**implementation**:
1. `ContextLayerStatus = 'unloaded' | 'loading' | 'loaded' | 'error'`
2. `SystemLayer` — policy (allowedCapabilities, maxExecutionSteps, timeout), constraints, runtimeVersion
3. `SkillLayer` — skillId, skillName, workflow, rules[], references[], capabilities[]
4. `TaskLayer` — taskId, taskType, status, goal, input, output, progress, error, metadata, parentId, dependencies
5. `ExecutionLayer` — currentAction, toolResults[], intermediateState, stepCount, startedAt
6. `MemoryLayer` — userConfirmations[], historicalResults[], generatedAssets[], custom
7. `RuntimeContext` — taskId, taskType, 5 层 (可选), layerStates, createdAt, updatedAt, totalEstimatedSize
8. `ContextSummary` — taskId, taskType, status, loadedLayers[], layerCount, totalSize, createdAt
9. 更新 `src/types/index.ts` 导出新类型

**convergence.criteria**:
- `src/types/context.ts` 存在且包含 `RuntimeContext` 接口
- `RuntimeContext` 包含 5 层: `system?`, `skill?`, `task?`, `execution?`, `memory?`
- `RuntimeContext` 包含 `layerStates: Record<string, ContextLayerStatus>`
- `ContextLayerStatus` 定义正确 (4 个值)
- `ContextSummary` 包含 `loadedLayers: string[]`
- `src/types/index.ts` 导出所有 Context 类型

---

### TASK-CR2: Context Manager 服务

| 字段 | 值 |
|------|-----|
| 文件 | `src/services/contextManager.ts` (新建) |
| 依赖 | TASK-CR1 |
| Wave | 1 |

**read_first**:
- `src/types/context.ts` — Context 类型
- `src/services/taskExecutor.ts` — 现有 executor 模式 (adapter shell 风格)
- `docs/agents-OS/Context-Contract.md` — Context 生命周期、隔离规则

**action**: 创建 ContextManager 类，管理 Context 创建/销毁/层生命周期，强制执行 Task 隔离。

**implementation**:
1. `ContextManager` 类 (非 Pinia，纯服务)
2. 内部 `Map<string, RuntimeContext>` 存储
3. `createContext(taskId, taskType): RuntimeContext` — 创建空 Context + 初始化 System Layer
4. `destroyContext(taskId): void` — 销毁 + 清理
5. `getContext(taskId): RuntimeContext | undefined` — 查询
6. `loadLayer(taskId, layerName): void` — 标记层加载状态
7. `unloadLayer(taskId, layerName): void` — 标记层卸载 + 清数据
8. `updateLayer(taskId, layerName, data): void` — 更新层内容
9. `getLayer(taskId, layerName): unknown` — 获取层
10. `isLayerLoaded(taskId, layerName): boolean` — 检查
11. 隔离规则: `createContext` 检查 taskId 是否已存在 (禁止覆盖)
12. 内存保护: `totalEstimatedSize` 粗略计算

**convergence.criteria**:
- `ContextManager` 类存在且可实例化
- `createContext` 返回 `RuntimeContext` 且 System Layer 不为空
- `destroyContext` 后 `getContext` 返回 `undefined`
- `loadLayer` / `unloadLayer` 改变 `layerStates`
- `updateLayer` 正确更新指定层数据
- 重复 `createContext` (同 taskId) 静默返回已有 Context
- 导出具名 export

---

### TASK-CR3: Progressive Context Loader

| 字段 | 值 |
|------|-----|
| 文件 | `src/services/contextLoader.ts` (新建) |
| 依赖 | TASK-CR2 |
| Wave | 2 |

**read_first**:
- `src/services/contextManager.ts` — ContextManager 接口
- `src/types/context.ts` — Context 类型
- `src/stores/tasks.ts` — Task Store (了解 task 数据结构用于投影)

**action**: 创建 ContextLoader，实现 Context 层的惰性加载和卸载策略。

**implementation**:
1. `ContextLoader` 类，接收 `ContextManager` 实例
2. `loadTaskLayer(context, task): void` — 从 Task 投影数据到 Task Layer
3. `loadSystemLayer(context): void` — 初始化 System Layer (policy + constraints)
4. `prepareExecutionLayer(context): void` — 初始化空 Execution Layer (惰性)
5. `prepareMemoryLayer(context): void` — 初始化空 Memory Layer (惰性)
6. `prepareSkillLayer(context): void` — 初始化空 Skill Layer (为 Phase 3 预留)
7. `unloadStaleLayers(context): string[]` — 卸载不再活跃的层，返回卸载列表
8. `estimateLayerSize(layer): number` — 近似字节计算
9. 策略:
   - 自动加载: task 创建时 → System + Task
   - 按需加载: execution/memory/skill → 显式调用
   - 卸载: 完成任务时 → 保留 System + Task + Memory，卸载 Execution
10. 可通过 `ContextManager.loadLayer()` 触发 Loader

**convergence.criteria**:
- `ContextLoader` 类存在且可实例化
- `loadTaskLayer` 正确将 Task 数据投影到 `context.task`
- `loadSystemLayer` 后 `context.system.policy` 包含 `allowedCapabilities`
- `unloadStaleLayers` 返回被卸载的层名列表
- `estimateLayerSize` 返回 `number`
- 导出具名 export

---

### TASK-CR4: Runtime Store + Composable

| 字段 | 值 |
|------|-----|
| 文件 | `src/stores/runtime.ts` (新建), `src/composables/useContextRuntime.ts` (新建) |
| 依赖 | TASK-CR2, TASK-CR3 |
| Wave | 2 |

**read_first**:
- `src/stores/tasks.ts` — Task Store (生命周期事件源)
- `src/services/contextManager.ts` — ContextManager
- `src/services/contextLoader.ts` — ContextLoader
- `src/stores/index.ts` — 现有 store 导出模式

**action**: 创建 Runtime Pinia Store + Vue Composable，包装 ContextManager + ContextLoader，自动绑定 Task 生命周期。

**implementation**:

**`src/stores/runtime.ts`**:
1. `useRuntimeStore` — Pinia setup store
2. 内部创建 `ContextManager` + `ContextLoader` 单例
3. `activeContexts` — `Ref<Map<string, RuntimeContext>>` (响应式)
4. `contextSummaries` — `ComputedRef<ContextSummary[]>` (UI 消费)
5. `activeContextCount` — `ComputedRef<number>`
6. `registerContext(taskId, taskType): void` — 创建 Context + 加载 System + Task Layer
7. `unregisterContext(taskId): void` — 持久化 Memory + 销毁
8. `getContextSummary(taskId): ContextSummary | undefined`
9. `loadContextLayer(taskId, layerName): void` — 委托给 Manager + Loader
10. `unloadContextLayer(taskId, layerName): void` — 委托给 Manager
11. **自动绑定**: 创建 `watch` 监听 `useTaskStore().activeTasks` — 新 task 自动 `registerContext`, task 完成自动 `unregisterContext`
12. 更新 `src/stores/index.ts` 导出

**`src/composables/useContextRuntime.ts`**:
1. `useActiveContext(taskId): ComputedRef<RuntimeContext | undefined>` — 响应式监听指定 Context
2. `useContextLayers(taskId): ComputedRef<Record<string, ContextLayerStatus>>` — 层加载状态
3. `useContextSummaries(): ComputedRef<ContextSummary[]>` — 所有活跃 Context 摘要
4. 使用 `useRuntimeStore()` 获取数据

**convergence.criteria**:
- `useRuntimeStore` 存在且为 Pinia store
- `registerContext` 后 `activeContexts` 包含新 Context
- `unregisterContext` 后 Context 从 `activeContexts` 移除
- `contextSummaries` 每个包含 `loadedLayers`
- `watch` 绑定后: TaskStore.enqueue → RuntimeStore.registerContext 自动触发
- `src/stores/index.ts` 导出 `useRuntimeStore`
- `useContextRuntime.ts` composable 导出具名 export
- `useActiveContext(taskId)` 返回内容随 `activeContexts` 变化
- `useContextSummaries()` 返回所有活跃 Context 摘要

---

### TASK-CR5: Context-aware TaskExecutor 增强

| 字段 | 值 |
|------|-----|
| 文件 | `src/services/taskExecutor.ts` (修改), `src/types/task.ts` (修改 — 移除冗余) |
| 依赖 | TASK-CR1 |
| Wave | 3 |

**read_first**:
- `src/services/taskExecutor.ts` — 现有 Executor 接口 (保持 adapter shell 模式)
- `src/types/context.ts` — RuntimeContext 类型
- `src/stores/tasks.ts` — TaskStore (了解调度流程)
- `src/stores/runtime.ts` — RuntimeStore (Context 交互入口)

**action**: 扩展 TaskExecutor 接口支持 Context 参数，新增 `ContextAwareExecutor` 类型 + `createContextAwareExecutor()` 工厂函数。

**implementation**:
1. 在 `taskExecutor.ts` 新增 `ContextAwareExecutor` 接口:
   ```typescript
   export interface ContextAwareExecutor extends TaskExecutor {
     executeWithContext(task: Task, context: RuntimeContext): Promise<TaskOutput>
   }
   ```
2. 新增 `createContextAwareExecutor(type, runtimeStore?)` 工厂函数
3. 更新 `ChatTaskExecutor` 实现 `ContextAwareExecutor`:
   - `executeWithContext`: 使用 Context 获取额外信息
   - `getStatus`: 可从 Context 读取 Task Layer 状态
4. 新增 `UnifiedExecutor` 类:
   - 包装 `ContextManager` + 具体 executor
   - 自动在 execute 时加载/卸载 Context 层
5. 注意: 仍为 adapter shell！不接入 real executor，只是接口层面做了 context-aware

**convergence.criteria**:
- `ContextAwareExecutor` 接口存在且继承 `TaskExecutor`
- `ChatTaskExecutor` 实现 `executeWithContext`
- `createContextAwareExecutor` 返回 `ContextAwareExecutor`
- `UnifiedExecutor` 执行时自动调用 RuntimeStore.loadContextLayer
- 现有 `createExecutor` 工厂函数未被破坏 (向后兼容)
- 所有 ChatTaskExecutor / AgentTaskExecutor / SkillTaskExecutor 保持 adapter shell 模式

---

## 七、Phase 2 执行策略

### Wave 划分

```
Wave 1 (Foundation)
  ├── 前置修复: Task 接口 `}` 缺失
  └── TASK-CR1: Context 类型系统

Wave 2 (Runtime Core)
  ├── TASK-CR2: Context Manager 服务
  ├── TASK-CR3: Progressive Context Loader
  └── TASK-CR4: Runtime Store + Composable

Wave 3 (Integration)
  └── TASK-CR5: Context-aware TaskExecutor 增强
```

### Wave 内并行

- **Wave 1**: 串行 (修复 → 类型)
- **Wave 2**: CR2 与 CR3 可并行 (Manager 依赖 Loader? 不—Loader 接收 Manager 实例, 解耦)
  - CR2 → CR3 (Loader 依赖 Manager 接口) → CR4 依赖 CR2+CR3
  - 实际上: CR2 先做, CR3 依赖 CR2 接口, CR4 依赖 CR2+CR3
  - Wave 2 串行: CR2 → CR3 → CR4
- **Wave 3**: 串行 (依赖 CR1 类型)

### 估算工时

| 任务 | 估算 |
|------|------|
| 前置修复 | 0.1h |
| TASK-CR1 | 1.5h |
| TASK-CR2 | 2h |
| TASK-CR3 | 1.5h |
| TASK-CR4 | 2.5h |
| TASK-CR5 | 1.5h |
| **总计** | **~9h** |

---

## 八、Phase 2 明确不做事项

| 不做 | 原因 |
|------|------|
| 修改 `chat-send-controller.ts` | Phase 1 ChatTask 注入已完成，Phase 2 通过 RuntimeStore watch 自动绑定 |
| 修改 `ChatView.vue` | 绝对边界 |
| 修改 Chat Store (`stores/chat.ts` 及其 20+ 子控制器) | 绝对边界 |
| 修改 `Sidebar.vue` (除已有 badge) | Phase 1 已完成 |
| 修改 `TaskMonitorPanel.vue` | "不是继续做 UI" |
| 修改 `RuntimeView.vue` | "不是继续做 UI" |
| 修改 sidecar (Rust/Go) | Phase 2 纯前端 |
| 接管 MCP 执行链路 | Phase 3+ |
| 接管 Skill 执行链路 | Phase 3+ |
| 接管 RAG 执行链路 | Phase 3+ |
| 接管 Memory 执行链路 | Phase 3+ |
| 重写 Task 调度引擎 | Phase 1 TaskStore 足够 |
| DAG / Workflow 执行引擎 | Phase 3+ |
| Browser / Multi-Agent | 不在当前路线 |
| Context 持久化 (localStorage/IndexedDB) | Phase 3+ |
| Context 冲突解决 (并发 Task) | Phase 3+ |
| Context Debug 面板 | UI 层工作，Phase 3+ |

---

## 九、后缀文件一览 (Phase 2 新增修改)

### 新增文件 (7 个)

| 文件 | 任务 |
|------|------|
| `src/types/context.ts` | CR1 |
| `src/services/contextManager.ts` | CR2 |
| `src/services/contextLoader.ts` | CR3 |
| `src/stores/runtime.ts` | CR4 |
| `src/composables/useContextRuntime.ts` | CR4 |

### 修改文件 (3 个)

| 文件 | 修改内容 | 任务 |
|------|---------|------|
| `src/types/task.ts` | Task 接口加 `}` | 前置修复 |
| `src/types/index.ts` | 添加 Context 类型导出 | CR1 |
| `src/services/taskExecutor.ts` | 新增 ContextAwareExecutor | CR5 |
| `src/stores/index.ts` | 添加 useRuntimeStore 导出 | CR4 |

### 不改文件 (明确排除)

`src/stores/chat-send-controller.ts` · `src/views/ChatView.vue` · `src/stores/chat.ts` 及子控制器 ·
`src/views/RuntimeView.vue` · `src/components/runtime/TaskMonitorPanel.vue` ·
`src/components/layout/Sidebar.vue` · `src/config/navigation.ts` · `src/router/index.ts` ·
`src/i18n/locales/*.ts` · `src-tauri/` · `src/api/` · `src/views/` (除 RuntimeView)
