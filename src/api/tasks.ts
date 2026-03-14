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
  return apiDelete(`/api/v1/cron/jobs/${id}`)
}

/** 暂停任务 */
export function pauseCronJob(id: string) {
  return apiPost(`/api/v1/cron/jobs/${id}/pause`)
}

/** 恢复任务 */
export function resumeCronJob(id: string) {
  return apiPost(`/api/v1/cron/jobs/${id}/resume`)
}
