/**
 * BUG-20260703 SSE 建任务错误契约：createCronJobSSE 只读 error 字段，忽略 message。
 *
 * 与 FS-5 收敛后的通用 client 契约（client.ts normalizeApiError：`body?.error ?? body?.message`）
 * 不一致。当前 hexclaw 后端 writeAPIError 恒双写 error===message（errors.go LegacyEr 兼容字段），
 * 所以今天没有用户可见影响；但 legacy error 字段带 omitempty、官方契约以 code/message 为准，
 * 一旦后端去掉 legacy 字段，桌面端建任务失败会退化成 statusText / "后端返回错误" 泛化提示。
 * 本测试把 SSE 路径（非 2xx JSON + event:error 两个读取点）锁到与通用 client 相同的双字段兜底。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createCronJobSSE } from '../tasks'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

function stubFetchNon2xx(body: Record<string, unknown>, status: number, statusText: string) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: false,
    status,
    statusText,
    text: async () => JSON.stringify(body),
  } as unknown as Response)
}

/** 构造 ok=200 的 SSE 流式响应，逐帧吐出 frames 后 done。 */
function stubFetchSSEStream(frames: string[]) {
  const encoder = new TextEncoder()
  let i = 0
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    body: {
      getReader: () => ({
        read: async () =>
          i < frames.length
            ? { done: false, value: encoder.encode(frames[i++]) }
            : { done: true, value: undefined },
        cancel: async () => {},
      }),
    },
  } as unknown as Response)
}

const input = { name: 't', schedule: '0 8 * * *', prompt: 'p' }

describe('BUG-20260703: createCronJobSSE 错误契约须与通用 client 对齐（error ?? message）', () => {
  it('非 2xx·真实后端形状（writeAPIError error+message 双字段）→ 透出完整后端消息', async () => {
    const backendMsg = '活跃定时任务已达上限（30 个）—— 请删除旧任务后重试'
    stubFetchNon2xx(
      { code: 'CRON_QUOTA_EXCEEDED', message: backendMsg, error: backendMsg },
      429,
      'Too Many Requests',
    )
    await expect(createCronJobSSE(input, { timeoutMs: 5000 })).rejects.toThrow(backendMsg)
  })

  it('非 2xx·仅 message 字段（去 legacy 后的标准 APIError 形状）→ 仍须透出 message 而非 statusText', async () => {
    const backendMsg = '请求格式错误: name、schedule 和 prompt 不能为空'
    stubFetchNon2xx({ code: 'BAD_REQUEST', message: backendMsg }, 400, 'Bad Request')
    await expect(createCronJobSSE(input, { timeoutMs: 5000 })).rejects.toThrow(backendMsg)
  })

  it('event:error·仅 message 字段 → 仍须透出 message 而非"后端返回错误"泛化文案', async () => {
    const backendMsg = '添加任务失败: LLM 编译超时'
    stubFetchSSEStream([`event: error\ndata: ${JSON.stringify({ message: backendMsg })}\n\n`])
    await expect(createCronJobSSE(input, { timeoutMs: 5000 })).rejects.toThrow(backendMsg)
  })

  it('event:error·现行 wire 形状（error 字段）契约回归 → 继续透出 error', async () => {
    const backendMsg = '添加任务失败: schedule 非法'
    stubFetchSSEStream([
      `event: error\ndata: ${JSON.stringify({ error: backendMsg, stage: 'validating' })}\n\n`,
    ])
    await expect(createCronJobSSE(input, { timeoutMs: 5000 })).rejects.toThrow(backendMsg)
  })
})
