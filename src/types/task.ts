/** 定时任务 */
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
