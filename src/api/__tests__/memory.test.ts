/**
 * memory.ts API 安全测试
 *
 * 验证 URL 构造的安全性
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('./client', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}))

describe('memory API URL 安全', () => {
  it('deleteMemory 应使用 encodeURIComponent 防止路径遍历', async () => {
    const sourceCode = await import('../memory?raw')
    const raw = typeof sourceCode === 'string' ? sourceCode : sourceCode.default

    // 验证：deleteMemory 使用了 encodeURIComponent（修复后）
    expect(raw).toContain('encodeURIComponent(id)')
  })
})
