/**
 * Video Generation API — 文本到视频生成
 *
 * 后端：/api/v1/videos/{status,generate,tasks/:id}
 * 异步两步协议：submit → poll，前端持有 task_id 自行控制轮询节奏。
 */

import { apiGet, apiPost } from './client'

export interface VideoGenStatus {
  enabled: boolean
  providers: string[]
  models: string[]
}

export interface VideoGenRequest {
  provider?: string
  model: string
  prompt: string
  image_url?: string
  size?: string
  with_audio?: boolean
  duration?: number
  fps?: number
  quality?: string
}

export interface VideoTaskStatus {
  task_id: string
  provider: string
  model: string
  status: string  // queueing / running / success / failed
  done: boolean
  /** Provider 临时 URL（CogVideoX 24h 过期） */
  video_url?: string
  /** 后端落盘后的相对路径，前端用 /api/v1/files/generated/{file_path} 访问 */
  video_file_path?: string
  cover_url?: string
  cover_file_path?: string
  error?: string
  progress?: number
  usage_ms?: number
}

import { env } from '@/config/env'

/** 优先用持久化路径；回退到 Provider URL */
export function videoToSrc(st: VideoTaskStatus): string {
  if (st.video_file_path) return `${env.apiBase}/api/v1/files/generated/${st.video_file_path}`
  return st.video_url || ''
}

export function getVideoGenStatus() {
  return apiGet<VideoGenStatus>('/api/v1/videos/status')
}

export function submitVideoGeneration(req: VideoGenRequest) {
  return apiPost<{ task_id: string }>('/api/v1/videos/generate', req)
}

export function pollVideoTask(taskID: string) {
  return apiGet<VideoTaskStatus>(`/api/v1/videos/tasks/${encodeURIComponent(taskID)}`)
}

/**
 * 自动轮询直至任务终结。返回最终状态。
 * 间隔逐步衰减：3s → 5s → 8s（视频生成普遍 30s-2min，节流到位避免打爆后端）。
 */
export async function pollUntilDone(
  taskID: string,
  options: { onTick?: (st: VideoTaskStatus) => void; signal?: AbortSignal; maxWaitMs?: number } = {},
): Promise<VideoTaskStatus> {
  const { onTick, signal, maxWaitMs = 5 * 60_000 } = options
  const start = Date.now()
  const intervals = [3000, 5000, 8000]
  let tick = 0
  // 第一轮立即查询
  while (true) {
    if (signal?.aborted) throw new DOMException('Polling aborted', 'AbortError')
    if (Date.now() - start > maxWaitMs) throw new Error('视频生成超时（>5min）')

    const st = await pollVideoTask(taskID)
    onTick?.(st)
    if (st.done) return st

    const wait = intervals[Math.min(tick, intervals.length - 1)]!
    tick++
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, wait)
      signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new DOMException('Polling aborted', 'AbortError'))
      }, { once: true })
    })
  }
}
