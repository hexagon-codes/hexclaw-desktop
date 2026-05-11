/**
 * Task 状态
 * - pending: 等待执行
 * - running: 执行中
 * - completed: 已完成
 * - failed: 失败
 * - cancelled: 已取消
 */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

/** Task 类型 */
export type TaskType = 'chat' | 'agent' | 'skill' | 'tool' | 'workflow' | 'automation'

/** Task 元数据 */
export interface TaskMetadata {
  source: string
  createdAt: string
  startedAt?: string
  completedAt?: string
  tags?: string[]
}

/** Task 错误 */
export interface TaskError {
  code: string
  message: string
  stack?: string
}

/** Task 输入 */
export interface TaskInput {
  type: TaskType
  payload: Record<string, unknown>
  resources?: Record<string, unknown>
}

/** Task 输出 */
export interface TaskOutput {
  result: unknown
  artifacts?: unknown[]
  usage?: Record<string, unknown>
}

/** Task — 核心接口 */
export interface Task {
  id: string
  type: TaskType
  status: TaskStatus
  sessionId?: string
  input: TaskInput
  output?: TaskOutput
  progress?: number
  error?: TaskError
  metadata?: TaskMetadata
  parentId?: string
  dependencies?: string[]
}

export interface CronJob {
  id: string
  name: string
  type: 'cron' | 'once'
  schedule: string       // Cron expression: "0 9 * * *", "@daily", "@every 5m"
  prompt: string         // Agent instruction
  user_id: string
  status: 'active' | 'paused' | 'done'
  last_run_at: string
  next_run_at: string
  run_count: number
  created_at: string
}

/** 创建任务请求 */
export interface CronJobInput {
  name: string
  schedule: string
  prompt: string
  type?: 'cron' | 'once'
}
