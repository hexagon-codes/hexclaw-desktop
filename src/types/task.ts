/** 编译后的可执行规约（hexclaw 后端 v2 架构产物） */
export interface JobSpec {
  /**
   * 'python3': compiled script executed in sandbox.
   * 'agent': AI reasoning per run — script is empty and compiled.at is the
   * zero time ("0001-01-01T00:00:00Z"), so the UI must not render script info.
   */
  runtime: 'python3' | 'agent'
  script: string
  deps: string[]
  inputs?: Record<string, unknown>
  timeout_s: number
  compiled: {
    model: string
    at: string
    tokens_in: number
    tokens_out: number
    hash: string
  }
}

/** 定时任务 */
export interface CronJob {
  id: string
  name: string
  type: 'cron' | 'once'
  schedule: string       // Cron expression: "0 9 * * *", "@daily", "@every 5m"
  user_id: string
  status: 'active' | 'paused' | 'done'
  last_run_at: string
  next_run_at: string
  run_count: number
  created_at: string

  /** v2: 用户原始需求（仅供 UI 展示） */
  source_prompt: string
  /** v2: 编译后的可执行规约；null 表示旧任务被清理（理论上不应出现） */
  spec: JobSpec | null
}

/** 创建任务请求 */
export interface CronJobInput {
  name: string
  schedule: string
  prompt: string
  type?: 'cron' | 'once'
}
