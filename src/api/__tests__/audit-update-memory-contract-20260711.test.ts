/**
 * hex-test 审计 · 契约#10：updateMemoryEntry 返回类型与后端实际返回不符。
 * 后端 handler_extended.go 成功分支返回 {"message":"记忆已更新"}（确认信封），
 * 前端此前声明 apiPut<MemoryEntry> → 类型撒谎（.id/.content 运行时 undefined）。
 * 本测试锁定后端契约：返回结构是 { message } 而非 MemoryEntry，防止类型声明再次漂移。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

const apiPut = vi.fn()
vi.mock('@/api/client', () => ({
  apiPut: (...args: unknown[]) => apiPut(...args),
  apiPost: vi.fn(),
  api: vi.fn(),
  apiGet: vi.fn(),
  apiDelete: vi.fn(),
}))

describe('hex-test 契约#10 · updateMemoryEntry 返回结构对齐后端', () => {
  afterEach(() => apiPut.mockReset())

  it('后端返回 {message} 确认信封，前端类型/取值须与之一致（非 MemoryEntry 假字段）', async () => {
    apiPut.mockResolvedValue({ message: '记忆已更新' })
    const { updateMemoryEntry } = await import('@/api/memory')
    const res = await updateMemoryEntry('mem-1', '新内容')
    // 契约：拿到的是 message 确认信封；.id/.content 这类 MemoryEntry 字段后端并不返回
    expect(res.message).toBe('记忆已更新')
    expect((res as Record<string, unknown>).id).toBeUndefined()
    // 请求路径/体正确
    expect(apiPut).toHaveBeenCalledWith('/api/v1/memory/mem-1', { content: '新内容' })
  })
})
