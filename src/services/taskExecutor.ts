import type { Task, TaskOutput, TaskStatus, TaskType, RuntimeContext } from '@/types'
import { RuntimeLLMExecutor } from './agentAdapter'
import { createChatProvider } from './providerAdapter'

/**
 * Task 执行器接口
 *
 * 所有 TaskExecutor 实现类通过构造函数接收业务回调，
 * 而非直接调用 chatService / API，保持 adapter shell 的独立性。
 *
 * executeWithContext 约束：
 * - 不允许 append timeline event
 * - 不允许 mutate RuntimeStore
 * - 不允许 create/destroy context
 * - 仅允许读取 Context、写入 context.execution lightweight state、返回 TaskOutput
 */
export interface TaskExecutor {
  /** 执行 Task，返回输出结果 */
  execute(task: Task): Promise<TaskOutput>
  /** 取消正在执行的 Task */
  cancel(taskId: string): Promise<void>
  /** 查询 Task 当前状态 */
  getStatus(taskId: string): TaskStatus
}

/**
 * ContextAwareExecutor — 支持 Context 感知的 Executor 接口
 *
 * 在 TaskExecutor 基础上增加 executeWithContext 方法，
 * 使 Task 在执行时可访问其 RuntimeContext。
 * Phase 2 保持 adapter shell 模式，不接入真实执行链路。
 */
export interface ContextAwareExecutor extends TaskExecutor {
  /** 携带 Context 执行 Task */
  executeWithContext(task: Task, context: RuntimeContext): Promise<TaskOutput>
}

// ─── Adapter Shell 实现 ──────────────────────────────

export type ExecuteChatCallback = (task: Task) => Promise<TaskOutput>

/** Chat Task 执行器 — adapter shell */
export class ChatTaskExecutor implements ContextAwareExecutor {
  private executeChat?: ExecuteChatCallback

  constructor(executeChat?: ExecuteChatCallback) {
    this.executeChat = executeChat
  }

  async execute(task: Task): Promise<TaskOutput> {
    if (this.executeChat) {
      return this.executeChat(task)
    }
    // 桩实现：未注入回调时返回占位输出
    return { result: null, artifacts: [] }
  }

  /** Context-aware 执行 — 读取并写入 RuntimeContext */
  async executeWithContext(task: Task, context: RuntimeContext): Promise<TaskOutput> {
    return stubExecuteWithContext(task, context)
  }

  async cancel(_taskId: string): Promise<void> {
    // stub — Phase 1 不接入真实取消链路
  }

  getStatus(_taskId: string): TaskStatus {
    return 'pending'
  }
}

export type ExecuteAgentCallback = (task: Task) => Promise<TaskOutput>

/** Agent Task 执行器 — adapter shell */
export class AgentTaskExecutor implements ContextAwareExecutor {
  private executeAgent?: ExecuteAgentCallback

  constructor(executeAgent?: ExecuteAgentCallback) {
    this.executeAgent = executeAgent
  }

  async execute(task: Task): Promise<TaskOutput> {
    if (this.executeAgent) {
      return this.executeAgent(task)
    }
    return { result: null, artifacts: [] }
  }

  /** Context-aware 执行 — 读取并写入 RuntimeContext */
  async executeWithContext(task: Task, context: RuntimeContext): Promise<TaskOutput> {
    return stubExecuteWithContext(task, context)
  }

  async cancel(_taskId: string): Promise<void> {
    // stub
  }

  getStatus(_taskId: string): TaskStatus {
    return 'pending'
  }
}

export type ExecuteSkillCallback = (task: Task) => Promise<TaskOutput>

/** Skill Task 执行器 — adapter shell */
export class SkillTaskExecutor implements ContextAwareExecutor {
  private executeSkill?: ExecuteSkillCallback

  constructor(executeSkill?: ExecuteSkillCallback) {
    this.executeSkill = executeSkill
  }

  async execute(task: Task): Promise<TaskOutput> {
    if (this.executeSkill) {
      return this.executeSkill(task)
    }
    return { result: null, artifacts: [] }
  }

  /** Context-aware 执行 — 读取并写入 RuntimeContext */
  async executeWithContext(task: Task, context: RuntimeContext): Promise<TaskOutput> {
    return stubExecuteWithContext(task, context)
  }

  async cancel(_taskId: string): Promise<void> {
    // stub
  }

  getStatus(_taskId: string): TaskStatus {
    return 'pending'
  }
}

// ─── Shared Stub ───────────────────────────────────────

/** ISO 时间戳快捷 */
function now(): string {
  return new Date().toISOString()
}

/** 共享 stub executeWithContext 实现 */
function stubExecuteWithContext(_task: Task, context: RuntimeContext): TaskOutput {
  if (context.execution) {
    context.execution.stepCount++
    context.execution.currentStage = 'executing'
    context.execution.intermediateState = {
      progress: 1,
      lastUpdate: now(),
    }
  }
  return { result: null, artifacts: [] }
}

// ─── 工厂函数 ─────────────────────────────────────────

/** 根据 TaskType 创建对应的 Executor 实例 */
export function createExecutor(type: TaskType): TaskExecutor {
  switch (type) {
    case 'chat':
      return new ChatTaskExecutor()
    case 'agent':
      return new AgentTaskExecutor()
    case 'skill':
      return new SkillTaskExecutor()
    default:
      return new ChatTaskExecutor()
  }
}

/** 根据 TaskType 创建对应的 Context-aware Executor 实例 */
export function createContextAwareExecutor(type: TaskType): ContextAwareExecutor {
  switch (type) {
    case 'chat':
    case 'skill':
      return new RuntimeLLMExecutor(createChatProvider())
    case 'agent':
      return new AgentTaskExecutor()
    default:
      return new RuntimeLLMExecutor(createChatProvider())
  }
}
