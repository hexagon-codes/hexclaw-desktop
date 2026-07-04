/**
 * BUG-20260703 fromHttpStatus 丢弃 serverMessage：
 * map 表里 401/403/404/429 四个条目固定用泛化文案，不像 422/5xx/default 那样
 * 接 serverMessage —— 导致 uploadFormData / apiSSE（client.ts）明明已正确抽取
 * 后端 body.error ?? body.message，却在最后一环被吞成"请求过于频繁/资源不存在"。
 *
 * 影响面备注：当前后端 429 仅 cron 配额闸产生且其真实消费路径不经 fromHttpStatus，
 * 属防御一致性缺口而非现实事故；但契约必须与 422/5xx 对齐，防后端新增 429/404
 * 端点时错误详情静默丢失。
 *
 * 契约：有 serverMessage → 透出；无 serverMessage → 保留各状态码兜底文案。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fromHttpStatus } from '../errors'

const QUOTA_MSG = '活跃定时任务已达上限（30 个）—— 请删除旧任务后重试'

describe('BUG-20260703: fromHttpStatus 须透出 serverMessage（401/403/404/429 与 422/5xx 对齐）', () => {
  it.each([
    [401, 'UNAUTHORIZED', 'API Key 已过期，请重新配置'],
    [403, 'FORBIDDEN', '该 Agent 无权访问此知识库'],
    [404, 'NOT_FOUND', '任务不存在'],
    [429, 'RATE_LIMITED', QUOTA_MSG],
  ])('%d + serverMessage → message 为后端消息，code 不变', (status, code, msg) => {
    const err = fromHttpStatus(status, msg)
    expect(err.code).toBe(code)
    expect(err.message).toBe(msg)
    expect(err.status).toBe(status)
  })

  it.each([
    [401, '未授权，请检查认证配置'],
    [403, '无权执行此操作'],
    [404, '请求的资源不存在'],
    [429, '请求过于频繁，请稍后重试'],
  ])('%d 无 serverMessage → 保留兜底文案', (status, fallback) => {
    expect(fromHttpStatus(status).message).toBe(fallback)
    expect(fromHttpStatus(status, '').message).toBe(fallback)
  })

  it('既有契约回归：422/5xx/default 透出行为不变', () => {
    expect(fromHttpStatus(422, '参数 schedule 非法').message).toBe('参数 schedule 非法')
    expect(fromHttpStatus(500, '索引器崩溃').message).toBe('索引器崩溃')
    expect(fromHttpStatus(418, '茶壶').message).toBe('茶壶')
    expect(fromHttpStatus(422).message).toBe('请求参数校验失败')
    expect(fromHttpStatus(500).message).toBe('服务器内部错误')
  })
})

describe('BUG-20260703: 用户路径 uploadFormData（apiPost + FormData）429 透出后端消息', () => {
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => {
    vi.resetModules()
    originalFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('429 + writeAPIError 真实形状（error+message 双字段）→ 抛出的错误含后端消息', async () => {
    const build = (): Record<string, unknown> => ({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      json: async () => ({ code: 'CRON_QUOTA_EXCEEDED', message: QUOTA_MSG, error: QUOTA_MSG }),
      text: async () => JSON.stringify({ message: QUOTA_MSG, error: QUOTA_MSG }),
      clone: () => build(),
    })
    globalThis.fetch = vi.fn().mockResolvedValue(build()) as unknown as typeof fetch

    const { apiPost } = await import('@/api/client')
    const fd = new FormData()
    fd.append('file', new Blob(['x']))
    await expect(apiPost('/api/v1/knowledge/upload', fd)).rejects.toThrow(QUOTA_MSG)
  })
})
