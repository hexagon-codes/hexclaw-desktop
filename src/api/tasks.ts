import { apiGet, apiPost, apiDelete } from './client'
import { DESKTOP_USER_ID } from '@/constants'
import type { CronJob, CronJobInput } from '@/types'

export type { CronJob, CronJobInput }

/** 获取任务列表 */
export function getCronJobs() {
  return apiGet<{ jobs: CronJob[]; total: number }>('/api/v1/cron/jobs', {
    user_id: DESKTOP_USER_ID,
  })
}

/** 创建任务 */
export function createCronJob(input: CronJobInput) {
  return apiPost<{ id: string; name: string; next_run_at: string }>('/api/v1/cron/jobs', {
    name: input.name,
    schedule: input.schedule,
    prompt: input.prompt,
    type: input.type ?? 'cron',
    user_id: DESKTOP_USER_ID,
  })
}

/** 删除任务 */
export function deleteCronJob(id: string) {
  return apiDelete<{ message: string }>(`/api/v1/cron/jobs/${id}`)
}

/** 暂停任务 */
export function pauseCronJob(id: string) {
  return apiPost<{ message: string }>(`/api/v1/cron/jobs/${id}/pause`)
}

/** 恢复任务 */
export function resumeCronJob(id: string) {
  return apiPost<{ message: string }>(`/api/v1/cron/jobs/${id}/resume`)
}

/** 立即触发任务 */
export function triggerCronJob(id: string) {
  return apiPost<{ message: string; run_id?: string }>(`/api/v1/cron/jobs/${id}/trigger`)
}

/** 获取任务执行历史 */
export async function getCronJobHistory(id: string, limit = 5): Promise<CronJobRun[]> {
  const res = await apiGet<{ history?: CronJobRunWire[]; runs?: CronJobRunWire[] }>(
    `/api/v1/cron/jobs/${id}/history`,
    { limit },
  )
  const raw = res.history ?? res.runs ?? []
  return raw.map((r) => ({
    ...r,
    started_at: r.started_at || r.run_at || '',
  }))
}

/** 任务执行记录 */
export interface CronJobRun {
  id: string
  job_id: string
  status: 'success' | 'failed' | 'running'
  result?: string
  started_at: string
  finished_at?: string
  duration_ms?: number
  error?: string
}

interface CronJobRunWire extends CronJobRun {
  run_at?: string
}
