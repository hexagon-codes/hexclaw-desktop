/**
 * Skills API Error Paths — 补全错误路径与边缘场景
 *
 * 覆盖：
 *  - 网络错误 / 4xx / 5xx 传播
 *  - setSkillEnabled 的 backend→local-fallback 降级
 *  - install/uninstall 生命周期（特殊字符编码、重复调用）
 *  - searchClawHub 边缘（error 字段、畸形响应、数组直返）
 *  - installFromHub 错误传播
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetch = vi.hoisted(() => vi.fn())
vi.mock('ofetch', () => ({
  ofetch: {
    create: () => mockFetch,
  },
}))

import {
  getSkills,
  installSkill,
  uninstallSkill,
  setSkillEnabled,
  searchClawHub,
  installFromHub,
} from '../skills'

describe('Skills API Error Paths', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockReset()
  })

  // ─── getSkills ──────────────────────────────────

  describe('getSkills', () => {
    it('propagates network error', async () => {
      mockFetch.mockRejectedValue(new Error('fetch failed'))
      await expect(getSkills()).rejects.toThrow('fetch failed')
    })

    it('propagates 500 error', async () => {
      mockFetch.mockRejectedValue(Object.assign(new Error('db down'), { status: 500 }))
      await expect(getSkills()).rejects.toThrow('db down')
    })
  })

  // ─── installSkill ───────────────────────────────

  describe('installSkill', () => {
    it('propagates 400 for invalid source', async () => {
      mockFetch.mockRejectedValue(Object.assign(new Error('invalid source'), { status: 400 }))
      await expect(installSkill('', 'file')).rejects.toThrow('invalid source')
    })

    it('sends type parameter when provided', async () => {
      mockFetch.mockResolvedValue({ name: 'my-skill', message: 'installed' })
      await installSkill('/path/to/skill.zip', 'file')
      const body = mockFetch.mock.calls[0]![1].body
      expect(body).toMatchObject({ source: '/path/to/skill.zip', type: 'file' })
    })

    it('propagates 409 when skill already installed', async () => {
      mockFetch.mockRejectedValue(Object.assign(new Error('skill already exists'), { status: 409 }))
      await expect(installSkill('clawhub://dup', 'clawhub')).rejects.toThrow('skill already exists')
    })
  })

  // ─── uninstallSkill ─────────────────────────────

  describe('uninstallSkill', () => {
    it('encodes special characters in skill name', async () => {
      mockFetch.mockResolvedValue({ message: 'uninstalled' })
      await uninstallSkill('my skill/中文')
      const [url] = mockFetch.mock.calls[0]!
      expect(url).toContain('my%20skill%2F%E4%B8%AD%E6%96%87')
    })

    it('propagates 404 when skill does not exist', async () => {
      mockFetch.mockRejectedValue(Object.assign(new Error('skill not found'), { status: 404 }))
      await expect(uninstallSkill('ghost')).rejects.toThrow('skill not found')
    })

    it('idempotent — repeated uninstall returns message each time', async () => {
      mockFetch.mockResolvedValue({ message: 'uninstalled' })
      await uninstallSkill('a')
      await uninstallSkill('a')
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })
  })

  // ─── setSkillEnabled — backend/local fallback ──

  describe('setSkillEnabled', () => {
    it('returns backend source on success', async () => {
      mockFetch.mockResolvedValue({ enabled: true, requires_restart: false })
      const r = await setSkillEnabled('skill-a', true)
      expect(r.source).toBe('backend')
      expect(r.success).toBe(true)
      expect(r.enabled).toBe(true)
    })

    it('falls back to local when backend rejects (network down)', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'))
      const r = await setSkillEnabled('skill-b', false)
      expect(r.source).toBe('local-fallback')
      expect(r.success).toBe(true)
      expect(r.enabled).toBe(false)
      expect(r.warning).toMatch(/Backend unreachable/i)
    })

    it('falls back to local on 500', async () => {
      mockFetch.mockRejectedValue(Object.assign(new Error('server error'), { status: 500 }))
      const r = await setSkillEnabled('skill-c', true)
      expect(r.source).toBe('local-fallback')
      expect(r.message).toBe('server error')
    })

    it('trusts requested enabled when backend returns non-boolean', async () => {
      mockFetch.mockResolvedValue({ enabled: 'yes' as unknown as boolean })
      const r = await setSkillEnabled('skill-d', false)
      expect(r.enabled).toBe(false)
      expect(r.source).toBe('backend')
    })

    it('encodes special chars in skill name in URL', async () => {
      mockFetch.mockResolvedValue({ enabled: true })
      await setSkillEnabled('a b/c', true)
      const [url] = mockFetch.mock.calls[0]!
      expect(url).toContain('a%20b%2Fc/status')
    })
  })

  // ─── searchClawHub ──────────────────────────────

  describe('searchClawHub', () => {
    it('throws when response contains error field', async () => {
      mockFetch.mockResolvedValue({ error: 'upstream hub offline' })
      await expect(searchClawHub()).rejects.toThrow('upstream hub offline')
    })

    it('ignores whitespace-only error field', async () => {
      mockFetch.mockResolvedValue({ error: '   ', skills: [] })
      const r = await searchClawHub()
      expect(r).toEqual([])
    })

    it('accepts raw array response shape', async () => {
      mockFetch.mockResolvedValue([
        { name: 'a', description: 'x', author: 'y', version: '1', tags: [], downloads: 0, category: 'coding' },
      ])
      const r = await searchClawHub()
      expect(r).toHaveLength(1)
      expect(r[0]!.name).toBe('a')
    })

    it('filters out non-skill entries when type field present', async () => {
      mockFetch.mockResolvedValue({
        skills: [
          { name: 'skill-a', description: 'd', author: 'o', version: '1', tags: [], downloads: 0, category: 'coding', type: 'skill' },
          { name: 'mcp-a', description: 'd', author: 'o', version: '1', tags: [], downloads: 0, category: 'coding', type: 'mcp' },
        ],
      })
      const r = await searchClawHub()
      expect(r).toHaveLength(1)
      expect(r[0]!.name).toBe('skill-a')
    })

    it('normalizes unknown category to coding', async () => {
      mockFetch.mockResolvedValue({
        skills: [
          { name: 'x', description: 'd', author: 'o', version: '1', tags: [], downloads: 0, category: 'weird-category' },
        ],
      })
      const r = await searchClawHub()
      expect(r[0]!.category).toBe('coding')
    })

    it('propagates network error', async () => {
      mockFetch.mockRejectedValue(new Error('offline'))
      await expect(searchClawHub('q')).rejects.toThrow('offline')
    })
  })

  // ─── installFromHub ─────────────────────────────

  describe('installFromHub', () => {
    it('prefixes source with clawhub://', async () => {
      mockFetch.mockResolvedValue({ name: 'x', message: 'ok' })
      await installFromHub('my-skill')
      const body = mockFetch.mock.calls[0]![1].body
      expect(body.source).toBe('clawhub://my-skill')
    })

    it('propagates 404 when hub skill does not exist', async () => {
      mockFetch.mockRejectedValue(Object.assign(new Error('hub skill not found'), { status: 404 }))
      await expect(installFromHub('ghost')).rejects.toThrow('hub skill not found')
    })
  })
})
