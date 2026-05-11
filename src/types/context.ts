/**
 * Context Runtime 类型定义
 *
 * 5 层 Context（System/Skill/Task/Execution/Memory）+ 聚合根 RuntimeContext。
 * Task Layer 是 Task 在 Context 中的投影，非替代关系。
 *
 * @see docs/agents-OS/Context-Contract.md
 */

import type { CapabilityName } from './capability'
import type { ExecutionState, ExecutionStage, ExecutionIntermediateState } from './execution'
import type { TaskType, TaskStatus, TaskInput, TaskOutput, TaskError, TaskMetadata } from './task'
import type { AssetCollection } from './asset'

// ─── 层状态 ─────────────────────────────────────────────

/** Context 层加载状态 */
export type ContextLayerStatus = 'unloaded' | 'loading' | 'loaded' | 'error'

// ─── Skill 类型 ─────────────────────────────────────────

/** Skill 元数据（对应 skill.json） */
export interface SkillMeta {
  skillId: string
  displayName: string
  version: string
  description: string
  capabilities: CapabilityName[]
  entry: string
  path: string
}

/** Skill 引用文件 */
export interface SkillReference {
  relativePath: string
  absolutePath: string
}

/** Skill 完整数据包（SkillLoader 产出） */
export interface SkillPackage {
  meta: SkillMeta
  markdown?: string
  references: SkillReference[]
  estimatedSize: number
}

// ─── System Layer ───────────────────────────────────────

/** System Layer — Runtime 基础规则和系统约束 */
export interface SystemLayer {
  policy: {
    maxExecutionSteps?: number
    maxToolCalls?: number
    timeout?: number                // ms
    allowedCapabilities: CapabilityName[]   // P0: ['llm', 'image_generation', 'filesystem.read']
    deniedCapabilities: CapabilityName[]
  }
  constraints: string[]             // 系统级约束描述
  runtimeVersion: string
}

// ─── Skill Layer ────────────────────────────────────────

/** Skill Layer — 当前 Skill 元数据和工作流定义 */
export interface SkillLayer {
  skillId?: string
  skillName?: string
  skillVersion?: string
  markdown?: string                 // 原始 SKILL.md 文本（不做语义解析）
  references?: SkillReference[]     // 引用文件列表
  capabilities?: CapabilityName[]           // Skill 声明的 capability 列表
  loadedSections: {
    markdown: ContextLayerStatus
    references: ContextLayerStatus
  }
}

// ─── Task Layer ─────────────────────────────────────────

/** Task Layer — Task 在 Context 中的执行态投影 */
export interface TaskLayer {
  taskId: string
  taskType: TaskType
  status: TaskStatus
  goal?: string                     // 从 input 提炼的任务目标
  input: TaskInput
  output?: TaskOutput
  progress?: number
  error?: TaskError
  metadata?: TaskMetadata
  parentId?: string
  dependencies?: string[]
}

// ─── Execution Layer ────────────────────────────────────

/** Execution Layer — Runtime State Machine 执行态 */
export interface ExecutionLayer {
  /** 执行生命周期状态 */
  state: ExecutionState
  /** 当前阶段（有限枚举） */
  currentStage: ExecutionStage
  /** 轻量执行步数（bounded integer，非 reasoning trace） */
  stepCount: number
  /** 开始时间（ISO） */
  startedAt?: string
  /** 完成时间（ISO） */
  completedAt?: string
  /** 轻量中间状态（仅 progress + lastUpdate） */
  intermediateState: ExecutionIntermediateState
  /** 执行错误（仅 failed 时） */
  error?: {
    code: string
    message: string
  }
}

// ─── Memory Layer ───────────────────────────────────────

/** Memory Layer — Task 级记忆 */
export interface MemoryLayer {
  userConfirmations: Array<{
    question: string
    answer: string
    timestamp: string               // ISO
  }>
  historicalResults: Array<{
    step: string          // concise identifier, e.g. 'execution.completed'
    summary: string       // human-readable
    timestamp: string     // ISO
  }>
  generatedAssets: Array<{
    path: string
    type: string                    // e.g. 'image', 'video', 'document'
    description: string
  }>
  custom: Record<string, unknown>   // Task 自定义记忆
}

// ─── RuntimeContext 聚合根 ──────────────────────────────

/** RuntimeContext — 5 层聚合根，每个 Task 拥有独立实例 */
export interface RuntimeContext {
  taskId: string
  taskType: TaskType

  // 5 Semantic Layers（可能未完全加载）
  system?: SystemLayer
  skill?: SkillLayer
  task?: TaskLayer
  execution?: ExecutionLayer
  memory?: MemoryLayer

  // 层状态管理
  layerStates: Record<string, ContextLayerStatus>
  // key: 'system' | 'skill' | 'task' | 'execution' | 'memory'

  // Resource References（非 Semantic Layer）
  resources?: {
    asset?: AssetCollection
  }

  // 元数据
  createdAt: string
  updatedAt: string
  totalEstimatedSize: number        // bytes（近似）
}

// ─── Context 摘要（UI 消费） ────────────────────────────

/** ContextSummary — UI 消费用的轻量摘要 */
export interface ContextSummary {
  taskId: string
  taskType: TaskType
  status: TaskStatus
  loadedLayers: string[]
  layerCount: number
  totalSize: number                 // bytes
  createdAt: string
}
