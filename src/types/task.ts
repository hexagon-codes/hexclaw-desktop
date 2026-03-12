/** 定时任务 */
export interface CronJob {
  id: string
  name: string
  description: string
  cron_expr: string
  agent_id: string
  agent_name: string
  prompt: string
  enabled: boolean
  last_run?: string
  next_run?: string
  run_count: number
  status: 'idle' | 'running' | 'error'
}

/** 创建任务请求 */
export interface CronJobInput {
  name: string
  description?: string
  cron_expr: string
  agent_id: string
  prompt: string
}
