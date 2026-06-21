/**
 * Video Generation API — 全场景覆盖
 *
 * 覆盖所有导出：
 *  - videoToSrc（纯函数，全分支：file_path / video_url / 缺失兜底）
 *  - getVideoGenStatus / submitVideoGeneration / pollVideoTask
 *    （endpoint + 方法 + body + taskID encode + 错误传播）
 *  - pollUntilDone（核心轮询：终态 success / failed、间隔衰减、
 *    AbortSignal 取消（轮询前 + 等待中）、maxWaitMs 超时、onTick 回调）
 *
 * 约定：mock `../client`（apiGet/apiPost）+ mock `@/config/env`（确定 apiBase）。
 * 轮询用 vi.useFakeTimers() + advanceTimersByTimeAsync 驱动，绝不真实 sleep。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// mock 后端 HTTP 层 —— videogen 只依赖 apiGet / apiPost
const apiGet = vi.hoisted(() => vi.fn())
const apiPost = vi.hoisted(() => vi.fn())
vi.mock('../client', () => ({ apiGet, apiPost }))

// 确定的 apiBase，便于 videoToSrc 精确断言
vi.mock('@/config/env', () => ({
  env: { apiBase: 'http://localhost:16060' },
}))

import {
  videoToSrc,
  getVideoGenStatus,
  submitVideoGeneration,
  pollVideoTask,
  pollUntilDone,
  type VideoTaskStatus,
  type VideoGenRequest,
} from '../videogen'

/** 构造 VideoTaskStatus，覆盖默认值 */
function makeStatus(overrides: Partial<VideoTaskStatus> = {}): VideoTaskStatus {
  return {
    task_id: 't-1',
    provider: 'cogvideox',
    model: 'cogvideox-flash',
    status: 'running',
    done: false,
    ...overrides,
  }
}

describe('videogen API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiGet.mockReset()
    apiPost.mockReset()
  })

  // ─── videoToSrc（纯函数，全分支）─────────────────────

  describe('videoToSrc', () => {
    it('优先用持久化路径 video_file_path，拼到 /files/generated/', () => {
      const st = makeStatus({ video_file_path: 'videos/abc.mp4', video_url: 'https://provider/x.mp4' })
      expect(videoToSrc(st)).toBe('http://localhost:16060/api/v1/files/generated/videos/abc.mp4')
    })

    it('无 file_path 时回退到 Provider 的 http url', () => {
      const st = makeStatus({ video_file_path: undefined, video_url: 'https://provider.example/clip.mp4' })
      expect(videoToSrc(st)).toBe('https://provider.example/clip.mp4')
    })

    it('两者都缺失时兜底返回空字符串', () => {
      const st = makeStatus({ video_file_path: undefined, video_url: undefined })
      expect(videoToSrc(st)).toBe('')
    })

    it('video_file_path 为空字符串时按缺失处理，回退 video_url', () => {
      const st = makeStatus({ video_file_path: '', video_url: 'https://provider/y.mp4' })
      expect(videoToSrc(st)).toBe('https://provider/y.mp4')
    })

    it('两者都为空字符串时兜底空串（不返回 undefined）', () => {
      const st = makeStatus({ video_file_path: '', video_url: '' })
      expect(videoToSrc(st)).toBe('')
    })

    it('file_path 含子目录原样拼接（不做 encode，与后端 /files/generated 路由对齐）', () => {
      const st = makeStatus({ video_file_path: 'a/b c/d.mp4' })
      expect(videoToSrc(st)).toBe('http://localhost:16060/api/v1/files/generated/a/b c/d.mp4')
    })
  })

  // ─── getVideoGenStatus ──────────────────────────────

  describe('getVideoGenStatus', () => {
    it('GET /api/v1/videos/status', async () => {
      apiGet.mockResolvedValue({ enabled: true, providers: ['cogvideox'], models: ['cogvideox-flash'] })
      const result = await getVideoGenStatus()
      expect(apiGet).toHaveBeenCalledTimes(1)
      expect(apiGet).toHaveBeenCalledWith('/api/v1/videos/status')
      expect(result.enabled).toBe(true)
      expect(result.providers).toEqual(['cogvideox'])
    })

    it('错误向上传播', async () => {
      apiGet.mockRejectedValue(new Error('502 Bad Gateway'))
      await expect(getVideoGenStatus()).rejects.toThrow('502 Bad Gateway')
    })
  })

  // ─── submitVideoGeneration ──────────────────────────

  describe('submitVideoGeneration', () => {
    it('POST /api/v1/videos/generate 透传完整 body', async () => {
      apiPost.mockResolvedValue({ task_id: 'task-42' })
      const req: VideoGenRequest = {
        provider: 'cogvideox',
        model: 'cogvideox-flash',
        prompt: 'a cat surfing',
        image_url: 'https://x/img.png',
        size: '1920x1080',
        with_audio: true,
        duration: 5,
        fps: 30,
        quality: 'high',
      }
      const result = await submitVideoGeneration(req)
      expect(apiPost).toHaveBeenCalledTimes(1)
      expect(apiPost).toHaveBeenCalledWith('/api/v1/videos/generate', req)
      expect(result.task_id).toBe('task-42')
    })

    it('最小 body（仅 model + prompt）原样透传', async () => {
      apiPost.mockResolvedValue({ task_id: 'task-min' })
      const req: VideoGenRequest = { model: 'm', prompt: 'p' }
      await submitVideoGeneration(req)
      expect(apiPost).toHaveBeenCalledWith('/api/v1/videos/generate', req)
    })

    it('错误向上传播（如 400 模型不可用）', async () => {
      apiPost.mockRejectedValue(new Error('400 model disabled'))
      await expect(submitVideoGeneration({ model: 'm', prompt: 'p' })).rejects.toThrow('400 model disabled')
    })
  })

  // ─── pollVideoTask ──────────────────────────────────

  describe('pollVideoTask', () => {
    it('GET /api/v1/videos/tasks/:id', async () => {
      apiGet.mockResolvedValue(makeStatus({ task_id: 'abc' }))
      const result = await pollVideoTask('abc')
      expect(apiGet).toHaveBeenCalledWith('/api/v1/videos/tasks/abc')
      expect(result.task_id).toBe('abc')
    })

    it('taskID 经 encodeURIComponent 转义（含 / 和空格）', async () => {
      apiGet.mockResolvedValue(makeStatus())
      await pollVideoTask('grp/task id')
      expect(apiGet).toHaveBeenCalledWith(`/api/v1/videos/tasks/${encodeURIComponent('grp/task id')}`)
      // 显式断言转义结果，避免 encode 被悄悄移除
      expect(apiGet).toHaveBeenCalledWith('/api/v1/videos/tasks/grp%2Ftask%20id')
    })

    it('错误向上传播（如 404 task 不存在）', async () => {
      apiGet.mockRejectedValue(new Error('404 not found'))
      await expect(pollVideoTask('missing')).rejects.toThrow('404 not found')
    })
  })

  // ─── pollUntilDone（核心：轮询循环）──────────────────

  describe('pollUntilDone', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('① 第 1 次 pending、第 3 次 success → 返回 success（不真实 sleep）', async () => {
      apiGet
        .mockResolvedValueOnce(makeStatus({ status: 'queueing', done: false }))
        .mockResolvedValueOnce(makeStatus({ status: 'running', done: false }))
        .mockResolvedValueOnce(makeStatus({ status: 'success', done: true, video_file_path: 'v/done.mp4' }))

      const onTick = vi.fn()
      const promise = pollUntilDone('t-1', { onTick })

      // 第 1 轮立即查询，无需等待
      await vi.advanceTimersByTimeAsync(0)
      expect(apiGet).toHaveBeenCalledTimes(1)

      // 间隔衰减：第 1 次间隔 3000ms
      await vi.advanceTimersByTimeAsync(3000)
      expect(apiGet).toHaveBeenCalledTimes(2)

      // 第 2 次间隔 5000ms
      await vi.advanceTimersByTimeAsync(5000)
      expect(apiGet).toHaveBeenCalledTimes(3)

      const result = await promise
      expect(result.status).toBe('success')
      expect(result.done).toBe(true)
      expect(onTick).toHaveBeenCalledTimes(3)
      // 终态后不再继续轮询
      expect(apiGet).toHaveBeenCalledTimes(3)
    })

    it('间隔衰减序列 3s → 5s → 8s → 8s（封顶不再增长）', async () => {
      apiGet.mockResolvedValue(makeStatus({ done: false }))
      const promise = pollUntilDone('t-1', { maxWaitMs: 10 * 60_000 })

      await vi.advanceTimersByTimeAsync(0)
      expect(apiGet).toHaveBeenCalledTimes(1)

      // 不到 3s 不触发第 2 次
      await vi.advanceTimersByTimeAsync(2999)
      expect(apiGet).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(apiGet).toHaveBeenCalledTimes(2)

      // 第 2 间隔 5s
      await vi.advanceTimersByTimeAsync(4999)
      expect(apiGet).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(apiGet).toHaveBeenCalledTimes(3)

      // 第 3 间隔 8s
      await vi.advanceTimersByTimeAsync(7999)
      expect(apiGet).toHaveBeenCalledTimes(3)
      await vi.advanceTimersByTimeAsync(1)
      expect(apiGet).toHaveBeenCalledTimes(4)

      // 第 4 间隔仍是 8s（封顶）
      await vi.advanceTimersByTimeAsync(7999)
      expect(apiGet).toHaveBeenCalledTimes(4)
      await vi.advanceTimersByTimeAsync(1)
      expect(apiGet).toHaveBeenCalledTimes(5)

      // 收尾，避免悬挂的 promise
      apiGet.mockResolvedValue(makeStatus({ status: 'success', done: true }))
      await vi.advanceTimersByTimeAsync(8000)
      await expect(promise).resolves.toMatchObject({ done: true })
    })

    it('② 终态 failed → 返回 failed，不无限轮询', async () => {
      apiGet
        .mockResolvedValueOnce(makeStatus({ status: 'running', done: false }))
        .mockResolvedValueOnce(makeStatus({ status: 'failed', done: true, error: '上游拒绝' }))

      const promise = pollUntilDone('t-1')
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(3000)

      const result = await promise
      expect(result.status).toBe('failed')
      expect(result.done).toBe(true)
      expect(result.error).toBe('上游拒绝')
      expect(apiGet).toHaveBeenCalledTimes(2)
    })

    it('③ 传入已 abort 的 signal → 立即抛 AbortError，且不发起任何请求', async () => {
      const controller = new AbortController()
      controller.abort()

      const promise = pollUntilDone('t-1', { signal: controller.signal })
      // 捕获 rejection（断言其为 AbortError）
      await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
      expect(apiGet).not.toHaveBeenCalled()
    })

    it('③b 等待间隔期间 abort → 抛 AbortError 并清掉定时器（不再轮询）', async () => {
      apiGet.mockResolvedValue(makeStatus({ done: false }))
      const controller = new AbortController()
      const promise = pollUntilDone('t-1', { signal: controller.signal })
      // eslint-disable-next-line vitest/valid-expect -- 假时钟拒绝测试：先持有断言 promise，推进时钟后于下方 await rejection
      const rejection = expect(promise).rejects.toMatchObject({ name: 'AbortError' })

      // 完成第 1 轮查询，进入 3s 等待
      await vi.advanceTimersByTimeAsync(0)
      expect(apiGet).toHaveBeenCalledTimes(1)

      // 等待中途 abort
      await vi.advanceTimersByTimeAsync(1000)
      controller.abort()
      await rejection

      // abort 后即便时间继续推进，也不再发起新请求
      await vi.advanceTimersByTimeAsync(10_000)
      expect(apiGet).toHaveBeenCalledTimes(1)
    })

    it('④ 时间未真实流逝：未推进定时器时不应自行解析（验证非真实 sleep）', async () => {
      apiGet.mockResolvedValue(makeStatus({ done: false }))
      let settled = false
      const promise = pollUntilDone('t-1')
        .then(() => { settled = true })
        .catch(() => { settled = true })

      // 仅刷新微任务队列，不推进虚拟时钟
      await Promise.resolve()
      await Promise.resolve()
      expect(settled).toBe(false)

      // 收尾
      apiGet.mockResolvedValue(makeStatus({ status: 'success', done: true }))
      await vi.advanceTimersByTimeAsync(3000)
      await promise
      expect(settled).toBe(true)
    })

    it('⑤ 超过 maxWaitMs → 抛超时错误并停止轮询', async () => {
      apiGet.mockResolvedValue(makeStatus({ done: false }))
      const promise = pollUntilDone('t-1', { maxWaitMs: 4000 })
      // eslint-disable-next-line vitest/valid-expect -- 假时钟拒绝测试：先持有断言 promise，推进时钟后于下方 await rejection
      const rejection = expect(promise).rejects.toThrow('视频生成超时')

      // 第 1 轮立即查询
      await vi.advanceTimersByTimeAsync(0)
      expect(apiGet).toHaveBeenCalledTimes(1)

      // 等 3s 进入第 2 轮（此时 elapsed=3000 < 4000，仍查询一次）
      await vi.advanceTimersByTimeAsync(3000)
      expect(apiGet).toHaveBeenCalledTimes(2)

      // 再等 5s 进入第 3 轮：elapsed=8000 > 4000 → 超时退出，不再查询
      await vi.advanceTimersByTimeAsync(5000)
      await rejection
      expect(apiGet).toHaveBeenCalledTimes(2)
    })

    it('首轮即终态 success → 立即返回，仅查询 1 次', async () => {
      apiGet.mockResolvedValue(makeStatus({ status: 'success', done: true }))
      const promise = pollUntilDone('t-1')
      await vi.advanceTimersByTimeAsync(0)
      const result = await promise
      expect(result.done).toBe(true)
      expect(apiGet).toHaveBeenCalledTimes(1)
    })

    it('轮询中 pollVideoTask 抛错 → 错误向上传播（不吞）', async () => {
      apiGet
        .mockResolvedValueOnce(makeStatus({ done: false }))
        .mockRejectedValueOnce(new Error('500 internal'))

      const promise = pollUntilDone('t-1')
      // eslint-disable-next-line vitest/valid-expect -- 假时钟拒绝测试：先持有断言 promise，推进时钟后于下方 await rejection
      const rejection = expect(promise).rejects.toThrow('500 internal')
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(3000)
      await rejection
    })

    it('onTick 携带每轮最新状态（含 progress）', async () => {
      apiGet
        .mockResolvedValueOnce(makeStatus({ progress: 10, done: false }))
        .mockResolvedValueOnce(makeStatus({ progress: 100, status: 'success', done: true }))

      const ticks: number[] = []
      const promise = pollUntilDone('t-1', { onTick: (st) => ticks.push(st.progress ?? -1) })
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(3000)
      await promise
      expect(ticks).toEqual([10, 100])
    })
  })
})
