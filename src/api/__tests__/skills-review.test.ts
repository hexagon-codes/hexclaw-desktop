/**
 * Skills API Code Review — ClawHub 功能验证（修复后）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { apiGet, apiPost, apiPut, apiDelete } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}))

vi.mock('../client', () => ({
  apiGet,
  apiPost,
  apiPut,
  apiDelete,
}))

beforeEach(() => {
  apiGet.mockRejectedValue(new Error('API not available in test'))
  apiPost.mockRejectedValue(new Error('API not available in test'))
  apiPut.mockRejectedValue(new Error('API not available in test'))
  apiDelete.mockRejectedValue(new Error('API not available in test'))
})

describe('ClawHub 技能市场 — 功能修复验证', () => {
  it('CLAWHUB_FORCE_MOCK 不再硬编码为 true', async () => {
    const sourceCode = await import('../skills?raw')
    const raw = typeof sourceCode === 'string' ? sourceCode : sourceCode.default

    expect(raw).toContain('const CLAWHUB_FORCE_MOCK = false')
    expect(raw).not.toContain('const CLAWHUB_FORCE_MOCK = true')
  })

  it('searchClawHub 降级返回 mock 数据（API 不可用时）', async () => {
    const { searchClawHub } = await import('../skills')
    const results = await searchClawHub()

    expect(results.length).toBeGreaterThan(0)
    expect(results.some(s => s.name === 'code-review-pro')).toBe(true)
  })

  it('searchClawHub 在真实 API 返回空列表时也会降级到 mock 数据', async () => {
    apiGet.mockResolvedValueOnce({ skills: [] })
    const { searchClawHub } = await import('../skills')
    const results = await searchClawHub()

    expect(results.length).toBeGreaterThan(0)
    expect(results.some(s => s.name === 'code-review-pro')).toBe(true)
  })

  it('searchClawHub 支持分类过滤', async () => {
    const { searchClawHub } = await import('../skills')

    const codingSkills = await searchClawHub(undefined, 'coding')
    expect(codingSkills.every(s => s.category === 'coding')).toBe(true)

    const researchSkills = await searchClawHub(undefined, 'research')
    expect(researchSkills.every(s => s.category === 'research')).toBe(true)
  })

  it('installFromHub 优先尝试真实 API（无 FORCE_MOCK 前置判断）', async () => {
    const sourceCode = await import('../skills?raw')
    const raw = typeof sourceCode === 'string' ? sourceCode : sourceCode.default

    expect(raw).toContain("await apiPost('/api/v1/skills/install'")
    const installFnBody = raw.slice(raw.indexOf('async function installFromHub'))
    expect(installFnBody).not.toMatch(/if\s*\(CLAWHUB_FORCE_MOCK\)/)
  })
})
