import { apiGet, apiPost, apiPut, apiDelete } from './client'
import type { CronJob, CronJobInput } from '@/types'

export type { CronJob, CronJobInput }

/** 获取任务列表 */
export function getCronJobs() {
  return apiGet<{ jobs: CronJob[] }>('/api/v1/cron/jobs')
}

/** 创建任务 */
export function createCronJob(job: CronJobInput) {
  return apiPost<CronJob>('/api/v1/cron/jobs', job)
}

/** 更新任务 */
export function updateCronJob(id: string, job: Partial<CronJobInput & { enabled: boolean }>) {
  return apiPut<CronJob>(`/api/v1/cron/jobs/${id}`, job)
}

/** 删除任务 */
export function deleteCronJob(id: string) {
  return apiDelete(`/api/v1/cron/jobs/${id}`)
}

/** 手动触发任务 */
export function triggerCronJob(id: string) {
  return apiPost(`/api/v1/cron/jobs/${id}/trigger`)
}
