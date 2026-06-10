/**
 * D4.1 Persistent Task Widget — 在 chat 流里维护 cron task 的实时状态。
 *
 * 行为契约：
 *   - 任务创建成功后，chat assistant message 卡片不消失
 *   - 卡片显示 status (active/paused) + 上次执行时间 + 下次执行时间
 *   - 提供 立即执行 / 暂停 / 恢复 / 编辑 / 删除 / 查看历史 按钮
 *   - 与 TasksView 状态同步：刷新时拉 unified list，更新所有卡片
 *
 * 设计要点：
 *   - 数据源单一：cronjobAction({action:'list'}) 拉全量再 by jobId 查找
 *   - 失败降级：网络断时显示「同步失败，点击重试」，不阻塞 UI
 *   - 防 spam：每个 jobId 的轮询节流 ≥ 10s
 */

import { ref, computed } from 'vue'
import {
  cronjobAction,
  genIdempotencyKey,
  type CronJob,
} from '@/api/tasks'

export interface PersistentJobState {
  job: CronJob | null
  lastSyncAt: number
  syncError: string | null
}

const jobCache = new Map<string, PersistentJobState>()
const lastListAt = ref(0)
const LIST_THROTTLE_MS = 10_000

/**
 * 复用同进程内的 job 状态查询；自动节流避免 spam。
 */
export async function syncJobsOnce(): Promise<{ ok: boolean; quota?: { used: number; limit: number } }> {
  const now = Date.now()
  if (now - lastListAt.value < LIST_THROTTLE_MS) {
    return { ok: true }
  }
  try {
    const resp = await cronjobAction({ action: 'list', include_paused: true })
    lastListAt.value = now
    for (const j of resp.jobs ?? []) {
      jobCache.set(j.id, { job: j, lastSyncAt: now, syncError: null })
    }
    return { ok: true, quota: resp.quota }
  } catch {
    return { ok: false }
  }
}

export function getCachedJobState(jobId: string): PersistentJobState {
  return (
    jobCache.get(jobId) ?? {
      job: null,
      lastSyncAt: 0,
      syncError: null,
    }
  )
}

export function clearJobCache() {
  jobCache.clear()
  lastListAt.value = 0
}

/**
 * 在 chat assistant message 卡片里使用此 composable 维护单个 job 的 live state。
 *
 * 调用方在 onMounted 注册 jobId（创建成功后由父组件触发），
 * 之后所有 action 按钮（pause / resume / run / remove）走本 composable 调用 unified endpoint。
 */
export function useCronPersistentWidget(jobId: () => string | null) {
  const state = ref<PersistentJobState>({
    job: null,
    lastSyncAt: 0,
    syncError: null,
  })
  const loading = ref(false)

  const job = computed(() => state.value.job)
  const isPaused = computed(() => state.value.job?.status === 'paused')
  const isActive = computed(() => state.value.job?.status === 'active')

  async function refresh() {
    const id = jobId()
    if (!id) return
    loading.value = true
    const r = await syncJobsOnce()
    state.value = getCachedJobState(id)
    state.value.syncError = r.ok ? null : '同步失败'
    loading.value = false
  }

  async function pause() {
    const id = jobId()
    if (!id) return
    await cronjobAction({
      action: 'pause',
      job_id: id,
      idempotency_key: genIdempotencyKey(),
    })
    await refresh()
  }

  async function resume() {
    const id = jobId()
    if (!id) return
    await cronjobAction({
      action: 'resume',
      job_id: id,
      idempotency_key: genIdempotencyKey(),
    })
    await refresh()
  }

  async function runNow() {
    const id = jobId()
    if (!id) return
    await cronjobAction({
      action: 'run',
      job_id: id,
      idempotency_key: genIdempotencyKey(),
    })
    await refresh()
  }

  async function remove() {
    const id = jobId()
    if (!id) return
    await cronjobAction({
      action: 'remove',
      job_id: id,
      idempotency_key: genIdempotencyKey(),
    })
    jobCache.delete(id)
    state.value = {
      job: null,
      lastSyncAt: Date.now(),
      syncError: null,
    }
  }

  return {
    state,
    loading,
    job,
    isPaused,
    isActive,
    refresh,
    pause,
    resume,
    runNow,
    remove,
  }
}
