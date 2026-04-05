import { describe, expect, it } from 'vitest'

describe('team.ts fallback copy placement', () => {
  it('team.ts keeps fallback copy outside the API file', async () => {
    const sourceCode = await import('../team?raw')
    const raw = typeof sourceCode === 'string' ? sourceCode : sourceCode.default

    expect(raw).toContain("from '@/config/team-fallback'")
    expect(raw).not.toContain("name: '当前用户'")
    expect(raw).not.toContain("last_active: '在线'")
    expect(raw).not.toContain("last_active: '待加入'")
    expect(raw).not.toContain("logger.warn('Team API 不可用，降级到 localStorage'")
  })
})
